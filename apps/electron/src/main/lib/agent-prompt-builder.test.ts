import { describe, expect, test } from 'bun:test'
import { buildPiUserClockLine, buildRuntimeTaskSystemPrompt, buildSystemPrompt } from './agent-prompt-builder'

describe('Agent 系统提示词', () => {
  test('Given CCB 并行工具批次为 fail-fast When 构建系统提示词 Then 提醒模型处理探测退出码与 zsh 通配符', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-id',
      permissionMode: 'default',
    })

    expect(prompt).toContain('并行工具批次采用 fail-fast')
    expect(prompt).toContain('grep ... || true')
    expect(prompt).toContain('在 zsh 中引用')
  })

  test('Given 构建系统提示词 When 注入联网搜索指引 Then 指向 Proma 内置 web_search MCP 并禁用 Runtime 原生工具', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-id',
      permissionMode: 'default',
    })

    expect(prompt).toContain('mcp__web_search__WebSearch')
    expect(prompt).toContain('mcp__web_search__WebFetch')
    expect(prompt).toContain('禁止使用 Runtime 原生的 WebSearch/WebFetch')
  })

  test('Given computer-use 可能操作网页 When 构建系统提示词 Then 强制网页任务使用 Proma 内置 browser MCP', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-id',
      permissionMode: 'default',
    })

    expect(prompt).toContain('mcp__browser__browser_get_state')
    expect(prompt).toContain('elements.ref')
    expect(prompt).toContain('禁止使用 Runtime 原生 `mcp__computer-use__*`')
    expect(prompt).toContain('非网页桌面应用')
  })

  test('Given Hermes 调度到其它 Runtime When 构建任务提示词 Then 同样继承内置浏览器路由约束', () => {
    const prompt = buildRuntimeTaskSystemPrompt('codex', 'complex_reasoning')

    expect(prompt).toContain('mcp__browser__browser_navigate')
    expect(prompt).toContain('browser_list_tasks')
    expect(prompt).toContain('禁止通过更换 `taskId`')
    expect(prompt).toContain('禁止使用 Runtime 原生 `mcp__computer-use__*`')
  })

  test('Given Pi 用户消息需要时刻 When 生成时钟行 Then 带时分且不进入 system 附录格式', () => {
    const line = buildPiUserClockLine(new Date('2026-08-24T03:11:00+08:00'))
    expect(line).toContain('当前时间:')
    expect(line).toMatch(/\d{2}:\d{2}/)
  })
})
