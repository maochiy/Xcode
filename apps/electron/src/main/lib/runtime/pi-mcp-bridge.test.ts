import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promaBuiltinMcpHttpHost } from '../builtin-mcp/http-host'
import { builtinMcpToolFactory, type LazyBuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'
import { normalizePiMcpToolResult, PiMcpBridge } from './pi-mcp-bridge'

/** 模拟 collaboration 子 Agent 工具（delegate_* 命名约定） */
function createCollabServer() {
  return builtinMcpToolFactory.createSdkMcpServer({
    name: 'collaboration',
    version: '1.0.0',
    tools: [
      builtinMcpToolFactory.tool(
        'delegate_agent',
        '创建一个真实可见的 Proma 协作子 Agent 会话',
        { task: z.string() },
        async ({ task }) => ({ content: [{ type: 'text', text: `子会话已启动: ${task}` }] }),
      ),
    ],
  })
}

/** 普通（非 collaboration）MCP server，验证加前缀 */
function createSearchServer() {
  return builtinMcpToolFactory.createSdkMcpServer({
    name: 'websearch',
    version: '1.0.0',
    tools: [
      builtinMcpToolFactory.tool(
        'search',
        '搜索',
        { query: z.string() },
        async ({ query }) => ({ content: [{ type: 'text', text: `结果:${query}` }] }),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })
}

afterEach(async () => {
  await promaBuiltinMcpHttpHost.shutdown()
})

describe('Pi MCP 桥接', () => {
  test('Given collaboration 端点 When 收集工具 Then delegate_* 保持原名且可调用', async () => {
    const mcpServers = await promaBuiltinMcpHttpHost.materialize('sess-collab', { collaboration: createCollabServer() })
    const bridge = new PiMcpBridge()
    bridge.configure(mcpServers)
    const tools = await bridge.discover('collaboration')

    expect(tools.map((t) => 'name' in t ? t.name : '')).toContain('delegate_agent')
    const result = await bridge.call({ server: 'collaboration', tool: 'delegate_agent', arguments: { task: '读后端' } })
    expect(String(result)).toContain('子会话已启动')
    await bridge.dispose()
  })

  test('Given 普通 MCP server When 收集工具 Then 加 mcp__server__ 前缀并正确还原调用', async () => {
    const mcpServers = await promaBuiltinMcpHttpHost.materialize('sess-search', { websearch: createSearchServer() })
    const bridge = new PiMcpBridge()
    bridge.configure(mcpServers)
    const tools = await bridge.discover('websearch')

    expect(tools.map((t) => 'name' in t ? t.name : '')).toContain('mcp__websearch__search')
    const result = await bridge.call({ server: 'websearch', tool: 'mcp__websearch__search', arguments: { query: 'pi' } })
    expect(String(result)).toContain('结果:pi')
    await bridge.dispose()
  })

  test('Given 未知工具名 When 调用 Then 抛出明确错误', async () => {
    const bridge = new PiMcpBridge()
    await expect(bridge.call({ server: 'unknown', tool: 'nonexistent_tool', arguments: {} })).rejects.toThrow('工具未发现或已失效')
    await bridge.dispose()
  })

  test('Given 注册 Agent 只允许只读 MCP 工具 When 发现或绕过发现直接调用 Then 写工具始终不可见且不可执行', async () => {
    const mcpServers = await promaBuiltinMcpHttpHost.materialize('sess-policy', {
      files: builtinMcpToolFactory.createSdkMcpServer({
        name: 'files',
        version: '1',
        tools: [
          builtinMcpToolFactory.tool('read', '读取', {}, () => ({ content: [{ type: 'text', text: 'read' }] })),
          builtinMcpToolFactory.tool('write', '写入', {}, () => ({ content: [{ type: 'text', text: 'write' }] })),
        ],
      }),
    })
    const bridge = new PiMcpBridge()
    bridge.configure(mcpServers, { allowedTools: ['mcp__files__read'] })
    expect(await bridge.discover('files')).toMatchObject([{ name: 'mcp__files__read' }])
    await expect(bridge.call({
      server: 'files',
      tool: 'mcp__files__write',
      arguments: {},
    })).rejects.toThrow('注册 Agent 不允许使用工具')
    expect(await bridge.call({
      server: 'files',
      tool: 'mcp__files__read',
      arguments: {},
    })).toBe('read')
    await bridge.dispose()
  })

  test('Given MCP 返回图片 When 投影给 Pi Then 保留标准图片内容块', () => {
    const result = normalizePiMcpToolResult({
      content: [
        { type: 'text', text: '已截图' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })

    expect(result).toMatchObject({
      content: [
        { type: 'text', text: '已截图' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })
  })

  test('Given 空 mcpServers When 收集工具 Then 返回空数组', async () => {
    const bridge = new PiMcpBridge()
    bridge.configure(undefined)
    expect(await bridge.discover()).toEqual([])
    bridge.configure({})
    expect(await bridge.discover()).toEqual([])
    await bridge.dispose()
  })
})

function lazyServer(load: LazyBuiltinMcpServerDefinition['load'], revision = '1'): LazyBuiltinMcpServerDefinition {
  return { kind: 'proma-lazy-builtin-mcp', name: 'search', description: '搜索能力', revision, load }
}

const searchCall = { server: 'web_search', tool: 'mcp__web_search__search', arguments: { query: 'pi' } }

describe('Pi MCP 按需初始化', () => {
  test('Given 多个 MCP 含慢服务 When 普通对话只配置或查看目录 Then 不执行任何初始化且目录不泄露配置', async () => {
    let loads = 0
    const bridge = new PiMcpBridge()
    bridge.configure({
      web_search: lazyServer(async () => { loads++; return createSearchServer() }),
      offline: { type: 'http', url: 'http://127.0.0.1:1/private', headers: { Authorization: 'private-token' } },
    })
    const catalog = await bridge.discover()
    expect(catalog).toHaveLength(2)
    expect(bridge.discoveredTools()).toEqual([])
    expect(loads).toBe(0)
    expect(JSON.stringify(catalog)).not.toContain('private')
    await bridge.dispose()
  })

  test('Given 未发现工具 When 直接调用 Then 拒绝而非偷偷初始化或执行', async () => {
    let loads = 0
    const bridge = new PiMcpBridge()
    bridge.configure({ web_search: lazyServer(async () => { loads++; return createSearchServer() }) })
    await expect(bridge.call(searchCall)).rejects.toThrow('请先发现')
    expect(loads).toBe(0)
    await bridge.dispose()
  })

  test('Given 只需要搜索 When 并发发现并跨轮复用 Then 仅初始化搜索一次并正确处理带下划线的服务名', async () => {
    let loads = 0
    let unrelatedLoads = 0
    const config = {
      web_search: lazyServer(async () => { loads++; return createSearchServer() }),
      browser: lazyServer(async () => { unrelatedLoads++; return createSearchServer() }),
    }
    const bridge = new PiMcpBridge()
    bridge.configure(config)
    const [first, second] = await Promise.all([bridge.discover('web_search'), bridge.discover('web_search')])
    expect(first).toEqual(second)
    expect(first).toMatchObject([{ name: 'mcp__web_search__search', parameters: { required: ['query'] } }])
    const snapshot = bridge.discoveredTools()
    expect(snapshot).toEqual([{ server: 'web_search', tools: first }])
    snapshot[0]!.tools[0]!.name = '已修改的快照'
    snapshot[0]!.tools[0]!.parameters!.required = []
    expect(bridge.discoveredTools()).toMatchObject([{
      server: 'web_search',
      tools: [{ name: 'mcp__web_search__search', parameters: { required: ['query'] } }],
    }])
    bridge.configure({ ...config, web_search: lazyServer(async () => { loads++; return createSearchServer() }) })
    await bridge.discover('web_search')
    expect(loads).toBe(1)
    expect(unrelatedLoads).toBe(0)
    expect(bridge.resolveToolCall(searchCall)).toEqual({ name: 'mcp__web_search__search', input: { query: 'pi' }, mcpReadOnly: true })
    expect(await bridge.call(searchCall)).toBe('结果:pi')
    await expect(bridge.call({ ...searchCall, arguments: { query: 123 } })).rejects.toThrow()
    await bridge.dispose()
  })

  test('Given 初始化失败 When 再次发现 Then 可以重试且不能调用失败的工具', async () => {
    let attempts = 0
    const bridge = new PiMcpBridge()
    bridge.configure({ web_search: lazyServer(async () => {
      attempts++
      if (attempts === 1) throw new Error('本地模拟初始化失败')
      return createSearchServer()
    }) })
    await expect(bridge.discover('web_search')).rejects.toThrow()
    await expect(bridge.call(searchCall)).rejects.toThrow('请先发现')
    await bridge.discover('web_search')
    expect(await bridge.call(searchCall)).toBe('结果:pi')
    expect(attempts).toBe(2)
    await bridge.dispose()
  })

  test('Given 已发现服务 When 修改配置或禁用 Then 旧工具立即失效且重新发现使用新配置', async () => {
    const bridge = new PiMcpBridge()
    bridge.configure({ web_search: lazyServer(async () => createSearchServer()) })
    await bridge.discover('web_search')
    let newLoads = 0
    bridge.configure({ web_search: lazyServer(async () => { newLoads++; return createSearchServer() }, '2') })
    expect(bridge.discoveredTools()).toEqual([])
    await expect(bridge.call(searchCall)).rejects.toThrow('请先发现')
    await bridge.discover('web_search')
    expect(newLoads).toBe(1)
    expect(bridge.discoveredTools()).toHaveLength(1)
    bridge.configure({})
    expect(bridge.discoveredTools()).toEqual([])
    await expect(bridge.call(searchCall)).rejects.toThrow('请先发现')
    await expect(bridge.discover('web_search')).rejects.toThrow('未启用')
    await bridge.dispose()
  })

  test('Given 两个会话 When 第一会话发现工具 Then 第二会话不能直接调用且关闭期间不复活连接', async () => {
    const one = new PiMcpBridge()
    const two = new PiMcpBridge()
    const config = { web_search: lazyServer(async () => createSearchServer()) }
    one.configure(config)
    two.configure(config)
    await one.discover('web_search')
    expect(one.discoveredTools()).toHaveLength(1)
    expect(two.discoveredTools()).toEqual([])
    await expect(two.call(searchCall)).rejects.toThrow('请先发现')
    const loading = two.discover('web_search')
    const closing = two.dispose()
    await expect(loading).rejects.toThrow('会话已关闭')
    await closing
    expect(two.catalog()).toEqual([])
    await one.dispose()
  })

  test('Given MCP 返回错误 When 回传 Pi Then 保留 isError 不误报为成功', () => {
    expect(normalizePiMcpToolResult({ isError: true, content: [{ type: 'text', text: '未完成' }] }))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: '未完成' }] })
  })

  test('Given stdio MCP 有分页目录 When 按需发现 Then 此前不启动进程且发现完整工具后可调用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-lazy-stdio-'))
    const marker = join(root, 'started')
    const script = join(root, 'server.mjs')
    writeFileSync(script, `
      import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
      import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'started');
      const server = new Server({ name: 'local-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
        tools: [{ name: request.params?.cursor ? 'second' : 'first', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
        ...(request.params?.cursor ? {} : { nextCursor: 'page-2' }),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [{ type: 'text', text: request.params.name }],
      }));
      await server.connect(new StdioServerTransport());
    `)
    const bridge = new PiMcpBridge()
    try {
      bridge.configure({ local: { type: 'stdio', command: process.execPath, args: [script], env: { HOME: root } } })
      expect((await bridge.discover())).toHaveLength(1)
      expect(existsSync(marker)).toBe(false)
      const tools = await bridge.discover('local')
      expect(existsSync(marker)).toBe(true)
      expect(tools).toMatchObject([{ name: 'mcp__local__first' }, { name: 'mcp__local__second' }])
      expect(bridge.resolveToolCall({ server: 'local', tool: 'mcp__local__first', arguments: { mcpReadOnly: true } }).mcpReadOnly).toBe(false)
      expect(await bridge.call({ server: 'local', tool: 'mcp__local__second', arguments: {} })).toBe('second')
    } finally {
      await bridge.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 外部认证URL无效 When 初始化失败 Then 不把认证内容带入模型错误', async () => {
    const bridge = new PiMcpBridge()
    bridge.configure({ invalid: { type: 'http', url: 'http://private-user:private-password@[invalid' } })
    try {
      await expect(bridge.discover('invalid')).rejects.toThrow('MCP 服务初始化失败：invalid')
      try {
        await bridge.discover('invalid')
      } catch (error) {
        expect(String(error)).not.toContain('private-')
      }
    } finally {
      await bridge.dispose()
    }
  })
})
