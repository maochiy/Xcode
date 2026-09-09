import { describe, expect, test } from 'bun:test'
import {
  applyRegisteredAgentRuntimeSnapshot,
  buildDelegationPrompt,
  snapshotRegisteredAgent,
} from './agent-collaboration-utils'

describe('协作子 Agent 运行参数', () => {
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

  test('Given 注册 Agent 定义 When 固化快照 Then 数组与原定义隔离且不包含凭据', () => {
    const tools = ['Read', 'mcp__search__find']
    const snapshot = snapshotRegisteredAgent({
      id: 'reviewer',
      name: '审查员',
      description: '只读审查',
      prompt: '只做代码审查。',
      tools,
      disallowedTools: ['Write'],
      maxTurns: 4,
    })
    tools.push('Write')

    expect(snapshot.tools).toEqual(['Read', 'mcp__search__find'])
    expect(snapshot).not.toHaveProperty('apiKey')
  })

  test('Given 子会话持久化了注册快照 When 首次运行或续跑 Then 真正恢复模型权限思考工具提示词和轮次', () => {
    const result = applyRegisteredAgentRuntimeSnapshot({
      sessionId: 'child',
      userMessage: '继续审查',
      channelId: 'channel',
      modelId: 'parent-model',
      permissionModeOverride: 'bypassPermissions',
      runtimeThinking: { effortLevel: 'low' },
    }, {
      id: 'reviewer',
      name: '审查员',
      description: '只读审查',
      prompt: '只做代码审查。',
      modelId: 'review-model',
      permissionMode: 'plan',
      effortLevel: 'high',
      tools: ['Read'],
      disallowedTools: ['Write'],
      maxTurns: 3,
    })

    expect(result).toMatchObject({
      modelId: 'review-model',
      permissionModeOverride: 'plan',
      runtimeThinking: { effortLevel: 'high' },
      registeredAgentSystemPrompt: '只做代码审查。',
      runtimeToolPolicy: {
        allowedTools: ['Read'],
        disallowedTools: ['Write'],
      },
      maxTurnsOverride: 3,
    })
  })

  test('Given 注册快照原为高权限但父会话已降为计划模式 When 子会话续跑 Then 不得恢复旧高权限', () => {
    const result = applyRegisteredAgentRuntimeSnapshot({
      sessionId: 'child',
      userMessage: '继续',
      channelId: 'channel',
      permissionModeOverride: 'bypassPermissions',
    }, {
      id: 'implementer',
      name: '实施者',
      description: '实施',
      prompt: '完成实施。',
      permissionMode: 'bypassPermissions',
    }, 'plan')

    expect(result.permissionModeOverride).toBe('plan')
  })
})
