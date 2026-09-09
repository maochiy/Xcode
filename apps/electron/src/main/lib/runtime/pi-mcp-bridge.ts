/**
 * Pi MCP 按需桥接：配置目录不启动服务，发现目标服务时才加载工具定义。
 * 内置服务复用宿主定义与 execute；外部服务使用 MCP Client。连接按 Session 隔离。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { isBuiltinMcpServerDefinition, isLazyBuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'
import type { BuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'
import { parsePiMcpCall, type PiExternalTool } from './pi-mcp-tools'
export type { PiExternalTool } from './pi-mcp-tools'

interface McpServerConnection {
  client?: Client
  builtin?: BuiltinMcpServerDefinition
  tools: PiExternalTool[]
  originalNames: Map<string, string>
}

interface McpServerEntry {
  config: Record<string, unknown>
  revision: string
  connection?: McpServerConnection
  pending?: Promise<McpServerConnection>
  abortController: AbortController
  connectingClient?: Client
}

export interface PiMcpCatalogEntry {
  server: string
  description: string
}

interface PiToolTextContent {
  type: 'text'
  text: string
}

interface PiToolImageContent {
  type: 'image'
  data: string
  mimeType: string
}

interface PiRichToolResult {
  content: Array<PiToolTextContent | PiToolImageContent>
  details: unknown
  isError?: boolean
}

export function normalizePiMcpToolResult(result: {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: string }
  >
  [key: string]: unknown
}): string | PiRichToolResult | typeof result {
  const content = result.content
  if (!Array.isArray(content)) return result
  const normalized = content.flatMap((block): Array<PiToolTextContent | PiToolImageContent> => {
    if (block.type === 'text' && 'text' in block) return [{ type: 'text', text: block.text }]
    if (block.type === 'image' && 'data' in block && 'mimeType' in block) {
      return [{ type: 'image', data: block.data, mimeType: block.mimeType }]
    }
    return []
  })
  if (result.isError || normalized.some((block) => block.type === 'image')) {
    return { content: normalized, details: result, ...(result.isError === true ? { isError: true } : {}) }
  }
  const text = normalized
    .filter((block): block is PiToolTextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return text || result
}

/** 配置摘要只用于本地比较，绝不进入模型上下文或日志。 */
function configRevision(config: Record<string, unknown>): string {
  if (isLazyBuiltinMcpServerDefinition(config)) {
    return JSON.stringify([config.kind, config.name, config.revision || ''])
  }
  if (isBuiltinMcpServerDefinition(config)) return JSON.stringify([config.kind, config.name, config.version])
  return JSON.stringify(config)
}

function canonicalToolName(server: string, name: string): string {
  return server === 'collaboration' ? name : `mcp__${server}__${name}`
}

export class PiMcpBridge {
  private readonly servers = new Map<string, McpServerEntry>()
  private readonly closing = new Set<Promise<void>>()
  private disposed = false

  /** 只更新轻量目录；删除/变更配置立即使旧工具失效，不等待连接。 */
  configure(mcpServers: Record<string, unknown> | undefined): void {
    if (this.disposed) throw new Error('Pi MCP 会话已关闭。')
    const next = new Set<string>()
    for (const [name, raw] of Object.entries(mcpServers || {})) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const config = raw as Record<string, unknown>
      if (config.enabled === false) continue
      if (!isLazyBuiltinMcpServerDefinition(config) && !isBuiltinMcpServerDefinition(config)
        && !['http', 'sse', 'stdio'].includes(String(config.type))) continue
      next.add(name)
      const revision = configRevision(config)
      const old = this.servers.get(name)
      if (old?.revision === revision) {
        old.config = config
        continue
      }
      if (old) this.closeEntry(old)
      this.servers.set(name, { config, revision, abortController: new AbortController() })
    }
    for (const [name, entry] of this.servers) {
      if (next.has(name)) continue
      this.servers.delete(name)
      this.closeEntry(entry)
    }
  }

  catalog(): PiMcpCatalogEntry[] {
    return [...this.servers].map(([server, { config }]) => ({
      server,
      description: typeof config.description === 'string' ? config.description : `工作区 MCP 服务：${server}`,
    }))
  }

  /** 返回当前会话已连接且配置仍有效的工具缓存快照，不触发服务加载。 */
  discoveredTools(): Array<{ server: string; tools: PiExternalTool[] }> {
    return [...this.servers].flatMap(([server, entry]) => entry.connection
      ? [{
          server,
          tools: entry.connection.tools.map((tool) => ({
            ...tool,
            ...(tool.parameters ? { parameters: structuredClone(tool.parameters) } : {}),
          })),
        }]
      : [])
  }

  /** 不传服务时只看目录；并发发现同一服务只进行一次初始化。 */
  async discover(): Promise<PiMcpCatalogEntry[]>
  async discover(server: string): Promise<PiExternalTool[]>
  async discover(server?: string): Promise<PiMcpCatalogEntry[] | PiExternalTool[]> {
    if (!server) return this.catalog()
    const entry = this.servers.get(server)
    if (!entry || this.disposed) throw new Error(`MCP 服务未启用或不属于当前会话：${server}`)
    if (!entry.connection) {
      entry.pending ??= this.connect(server, entry).then(async (connection) => {
        if (this.disposed || this.servers.get(server) !== entry) {
          await connection.client?.close().catch(() => undefined)
          throw new Error('MCP 配置已变更或会话已关闭，请重新发现服务。')
        }
        entry.connection = connection
        return connection
      }).finally(() => { entry.pending = undefined })
      await entry.pending
    }
    return entry.connection!.tools
  }

  /** 仅接受本会话已经发现的工具，返回真正参与审批的工具名和参数。 */
  resolveToolCall(input: Record<string, unknown>): { name: string; input: Record<string, unknown>; mcpReadOnly: boolean } {
    const call = parsePiMcpCall(input)
    const connection = this.servers.get(call.server)?.connection
    if (this.disposed || !connection?.originalNames.has(call.tool)) {
      throw new Error(`工具未发现或已失效，请先发现 MCP 服务：${call.server}`)
    }
    const originalName = connection.originalNames.get(call.tool)
    const builtinTool = connection.builtin?.tools.find((tool) => tool.name === originalName)
    return {
      name: call.tool,
      input: call.arguments,
      // 外部服务的 annotations 只是提示，不是宿主的只读授权。
      mcpReadOnly: builtinTool?.annotations?.readOnlyHint === true,
    }
  }

  async call(input: Record<string, unknown>): Promise<unknown> {
    this.resolveToolCall(input)
    const call = parsePiMcpCall(input)
    const connection = this.servers.get(call.server)!.connection!
    const name = connection.originalNames.get(call.tool)!
    if (connection.builtin) {
      const tool = connection.builtin.tools.find((candidate) => candidate.name === name)
      if (!tool) throw new Error('MCP 工具定义已变更，请重新发现。')
      return normalizePiMcpToolResult(await tool.execute(call.arguments))
    }
    return normalizePiMcpToolResult(await connection.client!.callTool({ name, arguments: call.arguments }))
  }

  private async connect(server: string, entry: McpServerEntry): Promise<McpServerConnection> {
    let config = entry.config
    if (isLazyBuiltinMcpServerDefinition(config)) config = await config.load()
    const originalNames = new Map<string, string>()
    const mapTool = (name: string, description: string | undefined, parameters: Record<string, unknown>): PiExternalTool => {
      const canonical = canonicalToolName(server, name)
      originalNames.set(canonical, name)
      return { name: canonical, description: description || name, parameters }
    }
    if (isBuiltinMcpServerDefinition(config)) {
      return {
        builtin: config,
        originalNames,
        tools: config.tools.map((tool) => mapTool(tool.name, tool.description, z.toJSONSchema(tool.inputSchema, { io: 'input' }))),
      }
    }
    const client = new Client({ name: `proma-pi-${server}`, version: '1.0.0' })
    const headers = config.headers as Record<string, string> | undefined
    try {
      const transport = config.type === 'stdio'
        ? new StdioClientTransport({
          command: String(config.command || ''),
          args: Array.isArray(config.args) ? config.args.map(String) : [],
          env: config.env as Record<string, string> | undefined,
          stderr: 'ignore',
        })
        : config.type === 'sse'
          ? new SSEClientTransport(new URL(String(config.url)), { requestInit: { headers } })
          : new StreamableHTTPClientTransport(new URL(String(config.url)), { requestInit: { headers } })
      const configuredTimeout = Number(config.startup_timeout_sec || 30) * 1_000
      const timeout = Number.isFinite(configuredTimeout) ? Math.max(1_000, configuredTimeout) : 30_000
      const signal = entry.abortController.signal
      if (signal.aborted) throw new Error('MCP 配置已失效。')
      entry.connectingClient = client
      await client.connect(transport, { timeout, signal })
      const tools: PiExternalTool[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout, signal })
        tools.push(...page.tools.map((tool) => mapTool(tool.name, tool.description, tool.inputSchema)))
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('MCP 工具目录返回了重复分页。')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      return { client, tools, originalNames }
    } catch {
      await client.close().catch(() => undefined)
      // 第三方异常可能带认证 URL/headers，不直接回传给模型。
      throw new Error(`MCP 服务初始化失败：${server}。请检查配置或连接后重试。`)
    } finally {
      entry.connectingClient = undefined
    }
  }

  private closeEntry(entry: McpServerEntry): void {
    entry.abortController.abort()
    const task = (async () => {
      await entry.connectingClient?.close().catch(() => undefined)
      await entry.pending?.catch(() => undefined)
      await entry.connection?.client?.close().catch(() => undefined)
    })()
    this.closing.add(task)
    void task.finally(() => this.closing.delete(task))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const entry of this.servers.values()) this.closeEntry(entry)
    this.servers.clear()
    await Promise.all(this.closing)
  }
}
