import { afterEach, describe, expect, test } from 'bun:test'
import { builtinMcpToolFactory, isBuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'
import {
  listBrowserAgentTasks,
  resetBrowserAgentTasksForTest,
  upsertBrowserAgentTask,
} from './browser-agent-controller'
import {
  browserErrorResult,
  createBrowserScreenshotResult,
  injectBrowserAgentMcpServer,
} from './browser-agent-tools'

afterEach(() => {
  resetBrowserAgentTasksForTest()
})

describe('Browser Agent 工具结果', () => {
  test('Given 浏览器动作失败 When 返回 MCP 结果 Then 标记为工具错误', () => {
    const result = browserErrorResult('打开失败')

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: '打开失败' }])
  })

  test('Given 无效截图数据 When 构建结果 Then 标记为工具错误', () => {
    const result = createBrowserScreenshotResult('invalid')

    expect(result.isError).toBe(true)
  })
})

describe('Browser Agent 会话隔离', () => {
  test('Given 其它会话已有浏览器任务 When 当前会话调用任意带 taskId 的工具 Then 全部拒绝且不接管任务', async () => {
    upsertBrowserAgentTask({
      taskId: 'shared-task',
      sessionId: 'other-session',
      title: '其它会话页面',
      url: 'https://example.com',
    })
    const mcpServers: Record<string, Record<string, unknown>> = {}
    await injectBrowserAgentMcpServer(builtinMcpToolFactory, mcpServers, {
      sessionId: 'current-session',
    })
    const server = mcpServers.browser
    if (!isBuiltinMcpServerDefinition(server)) throw new Error('browser MCP 未正确注入')

    const calls: Array<{ name: string; input: Record<string, unknown> }> = [
      {
        name: 'browser_navigate',
        input: { taskId: 'shared-task', title: '尝试接管', url: 'https://example.org' },
      },
      {
        name: 'browser_click',
        input: { taskId: 'shared-task', ref: 'f0e1' },
      },
      {
        name: 'browser_type',
        input: { taskId: 'shared-task', ref: 'f0e1', text: 'secret' },
      },
      {
        name: 'browser_scroll',
        input: { taskId: 'shared-task', direction: 'down' },
      },
      {
        name: 'browser_screenshot',
        input: { taskId: 'shared-task' },
      },
      {
        name: 'browser_get_state',
        input: { taskId: 'shared-task' },
      },
    ]

    for (const call of calls) {
      const tool = server.tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`缺少测试工具: ${call.name}`)
      const result = await tool.execute(call.input)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('不属于当前会话')
    }

    expect(listBrowserAgentTasks('current-session').map((task) => task.taskId)).toEqual([])
    expect(listBrowserAgentTasks('other-session').map((task) => task.taskId)).toEqual(['shared-task'])
  })

  test('Given 内置浏览器定义 When 查看只读标记 Then 仅 screenshot/get_state/list_tasks 标记为只读', async () => {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    await injectBrowserAgentMcpServer(builtinMcpToolFactory, mcpServers, {
      sessionId: 'current-session',
    })
    const server = mcpServers.browser
    if (!isBuiltinMcpServerDefinition(server)) throw new Error('browser MCP 未正确注入')

    const readOnlyNames = server.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)

    expect(readOnlyNames).toEqual([
      'browser_screenshot',
      'browser_get_state',
      'browser_list_tasks',
    ])
  })
})
