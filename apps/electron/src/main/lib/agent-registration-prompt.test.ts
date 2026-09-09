import { describe, expect, test } from 'bun:test'
import {
  buildAgentDelegationInstructions,
  buildGlobalAgentInstructionsSection,
} from './agent-registration-prompt'

describe('注册 Agent 和全局协作规则投影', () => {
  test('Given 没有全局规则 When 构建提示词 Then 不生成空规则或默认授权', () => {
    expect(buildGlobalAgentInstructionsSection(' \n')).toBe('')
  })

  test('Given 全局规则包含多段分工说明 When 构建提示词 Then 完整保留且明确本轮要求和权限优先', () => {
    const rules = '# 协作\n\n普通修复先交给 explorer 查证。\n\n只读审查交给 reviewer，禁止修改文件。'
    const section = buildGlobalAgentInstructionsSection(rules)
    expect(section).toContain(rules)
    expect(section).toContain('当前用户的明确要求优先')
    expect(section).toContain('不是额外权限')
    expect(section).toContain('禁止递归派生')
  })

  test('Given 合格父会话 When 提供协作指引 Then 注册角色可按规则调用且不能路由回旧内核', () => {
    const instructions = buildAgentDelegationInstructions(true)
    expect(instructions).toContain('list_registered_agents')
    expect(instructions).toContain('agentId')
    expect(instructions).toContain('无需用户每轮重复')
    expect(instructions).toContain('本轮明确要求“不使用子 Agent”')
    expect(instructions).toContain('包括短期并行子任务')
    expect(instructions).toContain('由 Pi 执行')
    expect(instructions).toContain('依据真实结果复核')
  })

  test('Given 子会话或协作开关已关闭 When 全局规则要求协作 Then 提示能力不可用而非鼓励绕过', () => {
    const instructions = buildAgentDelegationInstructions(false)
    expect(instructions).toContain('未提供 collaboration')
    expect(instructions).toContain('不能虚构已经创建')
    expect(instructions).not.toContain('delegate_agent')
  })
})
