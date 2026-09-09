import { describe, expect, test } from 'bun:test'
import { buildDelegationPrompt, hasSubAgentIntent } from './agent-collaboration-utils'

describe('子 Agent 硬开关意图识别', () => {
  test('Given 用户明确说用多个智能体 When 判断意图 Then 放行', () => {
    expect(hasSubAgentIntent('用多个智能体并行处理这个任务')).toBe(true)
    expect(hasSubAgentIntent('开启多个子 Agent 分别读后端和前端')).toBe(true)
    expect(hasSubAgentIntent('spawn 几个子 agent 一起协作')).toBe(true)
    expect(hasSubAgentIntent('并行派两个子会话，一个查测试一个查文档')).toBe(true)
  })

  test('Given 用户描述并行/分工场景 When 判断意图 Then 放行', () => {
    expect(hasSubAgentIntent('让它们并行跑')).toBe(true)
    expect(hasSubAgentIntent('分工处理，各自负责一块')).toBe(true)
    expect(hasSubAgentIntent('delegate this to sub-agents')).toBe(true)
  })

  test('Given 普通实现需求但未提及子智能体 When 判断意图 Then 拦截', () => {
    expect(hasSubAgentIntent('帮我实现一个登录页面')).toBe(false)
    expect(hasSubAgentIntent('审查一下这段代码')).toBe(false)
    expect(hasSubAgentIntent('修复这个 bug')).toBe(false)
    expect(hasSubAgentIntent('')).toBe(false)
  })

  test('Given 仅提到单个 Agent 而非多个/并行 When 判断意图 Then 拦截', () => {
    expect(hasSubAgentIntent('用 Claude 帮我写代码')).toBe(false)
    expect(hasSubAgentIntent('这个 agent 怎么配置')).toBe(false)
  })

  test('Given 任意协作角色 When 构建子 Agent 指令 Then 明确统一由 Pi 执行', () => {
    const prompt = buildDelegationPrompt({
      parentSessionId: 'parent',
      delegationId: 'delegation',
      role: 'implement',
      task: '实现登录页',
    })
    expect(prompt).toContain('实际执行内核始终是 Pi')
    expect(prompt).toContain('不依赖 Codex 或 Claude Code')
  })
})
