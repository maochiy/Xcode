import { describe, expect, test } from 'bun:test'
import type {
  AgentRuntimeModelCatalog,
  Channel,
  SDKMessage,
  Task,
} from '@proma/shared'
import {
  buildTaskboardModelOptions,
  buildTaskRunInput,
  buildTaskRunPrompt,
  extractTaskBlockedReason,
  extractTaskSessionSummary,
} from './taskboard-agent'

function assistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: 's1',
    uuid: 'u1',
  }
}

function userMessage(text: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: 's1',
    uuid: 'u2',
  }
}

const sampleTask: Task = {
  id: 't1',
  identifier: 'PROJ-1',
  projectId: 'proj',
  title: '修复登录 bug',
  description: '用户无法登录，需要排查',
  status: 'in_progress',
  priority: 'high',
  labels: ['缺陷'],
  sortOrder: 1000,
  threadId: null,
  agentModelId: null,
  agentChannelId: null,
  conversationRefs: [],
  participants: [],
  previewImage: null,
  activityKey: '',
  activityUpdatedAt: '2026-01-01T00:00:00.000Z',
  creatorType: 'user',
  creatorId: 'local-user',
  creatorName: '本地用户',
  creatorAvatarUrl: null,
  assignee: { type: 'user', id: 'local-user', name: '本地用户', avatarUrl: null },
  workflowId: null,
  developmentContext: null,
  startDate: null,
  dueDate: null,
  recurrence: null,
  archivedAt: null,
  relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const runtimeCatalog: AgentRuntimeModelCatalog = {
  channelId: 'anthropic-channel',
  models: [{
    value: 'claude-sonnet',
    displayName: 'Claude Sonnet',
    description: '',
    contextWindow: 200_000,
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
    supportsFastMode: false,
    supportsAutoMode: false,
  }],
  contextPolicy: {
    autoCompactEnabled: true,
    models: [],
  },
}

const anthropicChannel: Channel = {
  id: 'anthropic-channel',
  name: 'Anthropic',
  provider: 'anthropic',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  models: [{ id: 'claude-sonnet', name: 'Claude Sonnet', enabled: true }],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
}

describe('taskboard-agent 联动工具', () => {
  test('Given 任务看板选择 Anthropic 模型 When 构建 Pi 模型选项 Then 保留 Provider 协议', () => {
    const options = buildTaskboardModelOptions({
      channelId: anthropicChannel.id,
      catalog: runtimeCatalog,
      channels: [anthropicChannel],
    })

    expect(options).toHaveLength(1)
    expect(options[0]?.provider).toBe('anthropic')
    expect(options[0]?.runtimeModelInfo?.value).toBe('claude-sonnet')
  })

  test('Given 任务 When 构建运行提示词 Then 包含标题与描述', () => {
    const prompt = buildTaskRunPrompt(sampleTask)
    expect(prompt).toContain('修复登录 bug')
    expect(prompt).toContain('用户无法登录，需要排查')
  })

  test('Given 任务与默认模型 When 构建运行输入 Then 触发来源为 automation', () => {
    const input = buildTaskRunInput({
      sessionId: 's1',
      task: sampleTask,
      channelId: 'ch1',
      modelId: 'claude-sonnet',
      workspaceId: 'proj',
    })
    expect(input.sessionId).toBe('s1')
    expect(input.channelId).toBe('ch1')
    expect(input.modelId).toBe('claude-sonnet')
    expect(input.workspaceId).toBe('proj')
    expect(input.triggeredBy).toBe('automation')
  })

  test('Given 多轮消息 When 提取进度摘要 Then 取最后一条 assistant 文本', () => {
    const messages = [
      userMessage('任务描述'),
      assistantMessage('第一轮：开始排查…'),
      assistantMessage('第二轮：已定位问题，正在修复。'),
    ]
    expect(extractTaskSessionSummary(messages)).toBe('第二轮：已定位问题，正在修复。')
  })

  test('Given 无 assistant 文本 When 提取进度摘要 Then 返回 null', () => {
    expect(extractTaskSessionSummary([userMessage('任务描述')])).toBeNull()
  })

  test('Given 长文本 When 提取摘要 Then 截断并带省略号', () => {
    const long = '长'.repeat(300)
    const summary = extractTaskSessionSummary([assistantMessage(long)])
    expect(summary).not.toBeNull()
    expect(summary!.length).toBeLessThan(180)
    expect(summary).toContain('…')
  })

  test('Given 受阻任务无 assistant When 提取阻塞原因 Then 回退到最后 user 文本', () => {
    const messages = [userMessage('等待第三方 API 密钥，暂时无法继续')]
    expect(extractTaskBlockedReason(messages)).toContain('等待第三方 API 密钥')
  })
})
