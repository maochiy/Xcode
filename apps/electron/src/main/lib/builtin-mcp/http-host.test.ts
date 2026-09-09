import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { promaBuiltinMcpHttpHost } from './http-host'
import { createLazyBuiltinMcpServerDefinition } from './lazy-definition'
import { builtinMcpToolFactory } from './tool-definition'

interface MaterializedHttpConfig {
  type: 'http'
  url: string
  headers: { Authorization: string }
  required: false
}

function createEchoServer(label: string) {
  return builtinMcpToolFactory.createSdkMcpServer({
    name: `test-${label}`,
    version: '1.0.0',
    tools: [
      builtinMcpToolFactory.tool(
        'echo',
        '返回输入文本和当前测试标签',
        { text: z.string() },
        async ({ text }) => ({
          content: [{ type: 'text', text: `${label}:${text}` }],
        }),
      ),
    ],
  })
}

async function materialize(
  sessionId: string,
  label = sessionId,
): Promise<MaterializedHttpConfig> {
  const result = await promaBuiltinMcpHttpHost.materialize(sessionId, {
    test: createEchoServer(label),
  })
  return result.test as unknown as MaterializedHttpConfig
}

function authorizedHeaders(config: MaterializedHttpConfig): Record<string, string> {
  return {
    Authorization: config.headers.Authorization,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  }
}

afterEach(async () => {
  await promaBuiltinMcpHttpHost.shutdown()
})

describe('内置 MCP HTTP Host', () => {
  test('Given 没有已初始化的内置定义 When materialize Then 不启动 HTTP Host', async () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...values: unknown[]) => {
      logs.push(values.map(String).join(' '))
    }
    try {
      let loadCount = 0
      const externalConfig = {
        type: 'http',
        url: 'http://127.0.0.1:65535/mcp',
      }
      const lazyConfig = createLazyBuiltinMcpServerDefinition({
        name: 'lazy_test',
        description: '惰性测试服务',
        load: async () => {
          loadCount += 1
          return createEchoServer('lazy')
        },
      })
      const result = await promaBuiltinMcpHttpHost.materialize('empty-session', {
        external: externalConfig,
        lazy_test: lazyConfig,
      })

      expect(result).toEqual({
        external: externalConfig,
        lazy_test: lazyConfig,
      })
      expect(loadCount).toBe(0)
      expect(logs.join('\n')).not.toContain('HTTP Host 已启动')
    } finally {
      console.log = originalLog
    }
  })

  test('Given endpoint When 缺少或使用错误 Token Then 返回 401', async () => {
    const config = await materialize('auth-session')
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

    const missing = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const wrong = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body,
    })

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
  })

  test('Given 超过 2 MB 的请求 When 调用 endpoint Then 返回 413', async () => {
    const config = await materialize('large-request')
    const response = await fetch(config.url, {
      method: 'POST',
      headers: authorizedHeaders(config),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'x'.repeat(2 * 1024 * 1024) } },
      }),
    })

    expect(response.status).toBe(413)
  })

  test('Given 合法客户端 When initialize、列出并调用工具 Then 返回结构化结果', async () => {
    const config = await materialize('happy-path', 'alpha')
    const client = new Client({ name: 'proma-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    })

    await client.connect(transport)
    const tools = await client.listTools()
    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'hello' },
    })
    await client.close()

    expect(tools.tools.map((tool) => tool.name)).toContain('echo')
    expect(result.content).toEqual([{ type: 'text', text: 'alpha:hello' }])
  })

  test('Given 两个 Session When 调用各自 endpoint Then Token 与 handler 不串线', async () => {
    const first = await materialize('session-a', 'A')
    const second = await materialize('session-b', 'B')
    expect(first.url).not.toBe(second.url)
    expect(first.headers.Authorization).not.toBe(second.headers.Authorization)

    const firstClient = new Client({ name: 'first', version: '1.0.0' })
    const secondClient = new Client({ name: 'second', version: '1.0.0' })
    await firstClient.connect(new StreamableHTTPClientTransport(new URL(first.url), {
      requestInit: { headers: first.headers },
    }))
    await secondClient.connect(new StreamableHTTPClientTransport(new URL(second.url), {
      requestInit: { headers: second.headers },
    }))

    const [firstResult, secondResult] = await Promise.all([
      firstClient.callTool({ name: 'echo', arguments: { text: 'x' } }),
      secondClient.callTool({ name: 'echo', arguments: { text: 'x' } }),
    ])
    await Promise.all([firstClient.close(), secondClient.close()])

    expect(firstResult.content).toEqual([{ type: 'text', text: 'A:x' }])
    expect(secondResult.content).toEqual([{ type: 'text', text: 'B:x' }])
  })

  test('Given 已释放 Session When 再请求旧 endpoint Then 返回 404', async () => {
    const config = await materialize('released-session')
    await promaBuiltinMcpHttpHost.releaseSession('released-session')

    const response = await fetch(config.url, {
      method: 'POST',
      headers: authorizedHeaders(config),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })

    expect(response.status).toBe(404)
  })

  test('Given Host 启动日志 When materialize Then 不输出 Bearer Token', async () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...values: unknown[]) => {
      logs.push(values.map(String).join(' '))
    }
    try {
      const config = await materialize('log-session')
      expect(logs.join('\n')).not.toContain(config.headers.Authorization)
      expect(logs.join('\n')).not.toContain(config.headers.Authorization.slice(7))
    } finally {
      console.log = originalLog
    }
  })
})
