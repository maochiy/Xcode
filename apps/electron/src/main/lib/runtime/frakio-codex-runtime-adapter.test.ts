import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexCompactionSettings,
  codexItemToolName,
  codexItemToolInput,
  codexItemToolResultText,
  codexItemIsError,
  codexMcpLaunchConfiguration,
  codexQueuedMessageRequest,
  prepareCodexRuntimeHome,
} from './frakio-codex-runtime-adapter'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Proma Codex 子 Agent 与工具事件映射', () => {
  test('Given 新会话的 CODEX_HOME 尚不存在 When 启动 Codex App Server Then 先递归创建目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-codex-home-'))
    temporaryDirectories.push(root)
    const runtimeHome = join(root, 'codex', 'session-1')

    prepareCodexRuntimeHome(runtimeHome)

    expect(existsSync(runtimeHome)).toBe(true)
  })

  test('Given Codex Turn 正在运行 When 用户点击立即发送 Then 使用 turn/steer 注入当前 Turn', () => {
    expect(codexQueuedMessageRequest(
      'thread-1',
      'turn-1',
      {
        type: 'user',
        message: { role: 'user', content: '请改为先修复测试' },
        parent_tool_use_id: null,
        uuid: 'message-1',
        session_id: 'session-1',
      },
    )).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'message-1',
      input: [{
        type: 'text',
        text: '请改为先修复测试',
        text_elements: [],
      }],
    })
  })

  test('Given 命令执行项 When 映射工具名 Then 对齐 Bash', () => {
    expect(codexItemToolName({ type: 'commandExecution' })).toBe('Bash')
    expect(codexItemToolInput({ type: 'commandExecution', command: 'ls -la', cwd: '/tmp' }).command).toBe('ls -la')
  })

  test('Given 文件改动项 When 映射工具名 Then 对齐 Edit', () => {
    expect(codexItemToolName({ type: 'fileChange' })).toBe('Edit')
  })

  test('Given MCP 工具项 When 映射工具名 Then 沿用 mcp__server__tool 约定', () => {
    expect(codexItemToolName({ type: 'mcpToolCall', server: 'collaboration', tool: 'delegate_agent' }))
      .toBe('mcp__collaboration__delegate_agent')
  })

  test('Given 协作子 Agent 项 When 映射工具名 Then 对齐 Agent（渲染层识别为子代理）', () => {
    expect(codexItemToolName({ type: 'collabAgentToolCall' })).toBe('Agent')
    const input = codexItemToolInput({ type: 'collabAgentToolCall', prompt: '实现登录页', model: 'gpt-5' })
    expect(input.prompt).toBe('实现登录页')
    expect(input.model).toBe('gpt-5')
  })

  test('Given 命令执行完成且退出码非零 When 判定错误 Then 标记为错误结果', () => {
    expect(codexItemIsError({ type: 'commandExecution', exitCode: 1 })).toBe(true)
    expect(codexItemIsError({ type: 'commandExecution', exitCode: 0 })).toBe(false)
  })

  test('Given 命令执行完成 When 提取结果文本 Then 返回聚合输出', () => {
    expect(codexItemToolResultText({ type: 'commandExecution', aggregatedOutput: 'total 5' })).toBe('total 5')
  })

  test('Given 文件改动完成 When 提取结果文本 Then 汇总改动文件路径', () => {
    const text = codexItemToolResultText({ type: 'fileChange', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] })
    expect(text).toContain('a.ts')
    expect(text).toContain('b.ts')
  })

  test('Given 子 Agent 调用完成 When 提取结果文本 Then 返回状态描述', () => {
    expect(codexItemToolResultText({ type: 'collabAgentToolCall', status: 'completed' })).toContain('子 Agent')
  })

  test('Given 失败状态项 When 判定错误 Then 识别 failed/error/cancelled', () => {
    expect(codexItemIsError({ type: 'mcpToolCall', status: 'failed' })).toBe(true)
    expect(codexItemIsError({ type: 'mcpToolCall', status: { status: 'error' } })).toBe(true)
    expect(codexItemIsError({ type: 'mcpToolCall', status: 'completed' })).toBe(false)
  })

  test('Given 内置浏览器 HTTP MCP When 构建 Codex 启动参数 Then 模型可发现工具且认证信息不出现在参数中', () => {
    const launch = codexMcpLaunchConfiguration({
      browser: {
        type: 'http',
        url: 'http://127.0.0.1:43123/mcp/browser',
        headers: { Authorization: 'Bearer browser-secret' },
        required: false,
      },
    })

    expect(launch.args).toContain('mcp_servers.browser.url="http://127.0.0.1:43123/mcp/browser"')
    expect(launch.args).toContain(
      'mcp_servers.browser.env_http_headers={Authorization="PROMA_CODEX_MCP_0_0"}',
    )
    expect(launch.args.join(' ')).not.toContain('browser-secret')
    expect(launch.env.PROMA_CODEX_MCP_0_0).toBe('Bearer browser-secret')
  })

  test('Given 模型配置了压缩阈值 When 构建 Codex 参数 Then 注入自动压缩阈值与窗口', () => {
    const args = codexCompactionSettings({
      enabled: true,
      threshold: 160_000,
      contextWindow: 200_000,
    })
    expect(args).toEqual([
      '-c', 'model_auto_compact_token_limit="160000"',
      '-c', 'model_context_window="200000"',
    ])
  })

  test('Given 模型未配置压缩 When 构建 Codex 参数 Then 不注入任何压缩配置', () => {
    expect(codexCompactionSettings(undefined)).toEqual([])
    expect(codexCompactionSettings({ enabled: true })).toEqual([])
  })

  test('Given 仅配置窗口无阈值 When 构建 Codex 参数 Then 只注入窗口', () => {
    const args = codexCompactionSettings({ enabled: true, contextWindow: 200_000 })
    expect(args).toEqual(['-c', 'model_context_window="200000"'])
  })

  test('Given 工作区 stdio MCP When 构建 Codex 启动参数 Then 保留命令参数和环境变量', () => {
    const launch = codexMcpLaunchConfiguration({
      workspace_tools: {
        type: 'stdio',
        command: 'bun',
        args: ['run', 'server.ts'],
        env: { WORKSPACE_MODE: '1' },
        startup_timeout_sec: 45,
      },
    })

    expect(launch.args).toContain('mcp_servers.workspace_tools.command="bun"')
    expect(launch.args).toContain('mcp_servers.workspace_tools.args=["run","server.ts"]')
    expect(launch.args).toContain('mcp_servers.workspace_tools.env={WORKSPACE_MODE="1"}')
    expect(launch.args).toContain('mcp_servers.workspace_tools.startup_timeout_sec=45')
  })
})
