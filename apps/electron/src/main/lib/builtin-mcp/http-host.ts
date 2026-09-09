import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { BuiltinMcpServerDefinition, BuiltinMcpToolDefinition } from './tool-definition'
import { isBuiltinMcpServerDefinition } from './tool-definition'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024

interface HostedEndpoint {
  sessionId: string
  serverName: string
  path: string
  token: string
  definition: BuiltinMcpServerDefinition
  tools: Map<string, BuiltinMcpToolDefinition>
  server: McpServer
  transport: StreamableHTTPServerTransport
}

function secureTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentLength = Number(req.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new Error('MCP 请求体超过 2 MB 限制')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('MCP 请求体超过 2 MB 限制')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
}

class PromaBuiltinMcpHttpHost {
  private httpServer: Server | undefined
  private port: number | undefined
  private startPromise: Promise<void> | undefined
  private readonly endpoints = new Map<string, HostedEndpoint>()
  private readonly endpointKeys = new Map<string, string>()

  async materialize(
    sessionId: string,
    configs: Record<string, Record<string, unknown>>,
  ): Promise<Record<string, Record<string, unknown>>> {
    const entries = Object.entries(configs)
    if (!entries.some(([, config]) => isBuiltinMcpServerDefinition(config))) {
      return Object.fromEntries(entries)
    }

    await this.ensureStarted()
    const result: Record<string, Record<string, unknown>> = {}

    for (const [name, config] of entries) {
      if (!isBuiltinMcpServerDefinition(config)) {
        result[name] = config
        continue
      }
      const endpoint = await this.upsertEndpoint(sessionId, name, config)
      result[name] = {
        type: 'http',
        url: `http://127.0.0.1:${this.port}${endpoint.path}`,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
        },
        required: false,
      }
    }

    return result
  }

  async releaseSession(sessionId: string): Promise<void> {
    const endpoints = Array.from(this.endpoints.values())
      .filter((endpoint) => endpoint.sessionId === sessionId)
    for (const endpoint of endpoints) {
      this.endpoints.delete(endpoint.path)
      this.endpointKeys.delete(this.endpointKey(endpoint.sessionId, endpoint.serverName))
      await endpoint.server.close().catch(() => undefined)
    }
  }

  async shutdown(): Promise<void> {
    for (const endpoint of this.endpoints.values()) {
      await endpoint.server.close().catch(() => undefined)
    }
    this.endpoints.clear()
    this.endpointKeys.clear()
    const server = this.httpServer
    this.httpServer = undefined
    this.port = undefined
    this.startPromise = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private endpointKey(sessionId: string, serverName: string): string {
    return `${sessionId}\0${serverName}`
  }

  private async ensureStarted(): Promise<void> {
    if (this.httpServer && this.port) return
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('无法获取内置 MCP HTTP Host 监听地址'))
          return
        }
        server.removeListener('error', reject)
        server.on('error', (error) => {
          console.error('[内置 MCP] HTTP Host 错误:', error)
        })
        this.httpServer = server
        this.port = address.port
        console.log(`[内置 MCP] HTTP Host 已启动: 127.0.0.1:${address.port}`)
        resolve()
      })
    })

    try {
      await this.startPromise
    } catch (error) {
      this.startPromise = undefined
      throw error
    }
  }

  private async upsertEndpoint(
    sessionId: string,
    serverName: string,
    definition: BuiltinMcpServerDefinition,
  ): Promise<HostedEndpoint> {
    const key = this.endpointKey(sessionId, serverName)
    const existingPath = this.endpointKeys.get(key)
    const existing = existingPath ? this.endpoints.get(existingPath) : undefined
    if (existing) {
      existing.definition = definition
      existing.tools.clear()
      for (const tool of definition.tools) existing.tools.set(tool.name, tool)
      return existing
    }

    const path = `/mcp/${randomUUID()}`
    const tools = new Map(definition.tools.map((tool) => [tool.name, tool]))
    const mcpServer = new McpServer({
      name: definition.name,
      version: definition.version,
    })
    for (const tool of definition.tools) {
      mcpServer.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
        async (args) => {
          const current = tools.get(tool.name)
          if (!current) {
            return {
              isError: true,
              content: [{ type: 'text', text: `工具已不可用: ${tool.name}` }],
            }
          }
          return current.execute(args)
        },
      )
    }
    const transport = new StreamableHTTPServerTransport({
      // 每个 Proma Session/Server endpoint 只由一个 CCB MCP Client 使用。
      // 必须启用 SDK Session：stateless transport 按协议不能跨多个 HTTP 请求复用。
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    })
    await mcpServer.connect(transport)
    const endpoint: HostedEndpoint = {
      sessionId,
      serverName,
      path,
      token: randomBytes(32).toString('hex'),
      definition,
      tools,
      server: mcpServer,
      transport,
    }
    this.endpoints.set(path, endpoint)
    this.endpointKeys.set(key, path)
    return endpoint
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const endpoint = this.endpoints.get(url.pathname)
      if (!endpoint) {
        res.writeHead(404).end('Not Found')
        return
      }
      const authorization = req.headers.authorization ?? ''
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!token || !secureTokenEquals(token, endpoint.token)) {
        res.writeHead(401).end('Unauthorized')
        return
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      await endpoint.transport.handleRequest(req, res, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) {
        res.writeHead(message.includes('2 MB') ? 413 : 400, { 'content-type': 'application/json' })
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: message }))
      }
    }
  }
}

export const promaBuiltinMcpHttpHost = new PromaBuiltinMcpHttpHost()
