import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKUserMessage } from '@proma/shared'
import type { MessageGroup } from './SDKMessageRenderer'
import { buildLiveGroupSet } from './live-group-set'

function createAssistant(
  uuid: string,
  modelMessageId: string,
  text: string,
): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: {
      id: modelMessageId,
      content: [{ type: 'text', text }],
    },
  } as SDKAssistantMessage
}

describe('buildLiveGroupSet', () => {
  test('Given 两轮 assistant 同时保留在 live When 新 run 已开始 Then 只有新 user 后的执行过程属于运行中', () => {
    const oldAssistant = createAssistant('old', 'old', '旧回复')
    const newAssistant = createAssistant('new', 'new', '新回复')
    const currentUser = {
      type: 'user', uuid: 'new-user', parent_tool_use_id: null, _createdAt: 200,
      message: { content: [{ type: 'text', text: '新问题' }] },
    } as SDKUserMessage
    const oldGroup: MessageGroup = {
      type: 'assistant-turn', assistantMessages: [oldAssistant], turnMessages: [oldAssistant],
    }
    const newGroup: MessageGroup = {
      type: 'assistant-turn', assistantMessages: [newAssistant], turnMessages: [newAssistant],
    }
    const groups: MessageGroup[] = [oldGroup, { type: 'user', message: currentUser }, newGroup]
    const liveGroups = buildLiveGroupSet({
      allGroups: groups, liveMessages: [oldAssistant, currentUser, newAssistant],
      streaming: true, currentTurnStartedAt: 200,
    })
    expect(liveGroups.has(oldGroup)).toBe(false)
    expect(liveGroups.has(newGroup)).toBe(true)
  })
  test('消息合并生成新对象时，仍按模型 message.id 识别实时 assistant turn', () => {
    const liveMessage = createAssistant('live-uuid', 'model-message-1', '流式正文')
    const mergedMessage = {
      ...liveMessage,
      uuid: 'persisted-uuid',
      message: {
        ...liveMessage.message,
        content: [{ type: 'text', text: '流式正文（合并后）' }],
      },
    } as SDKAssistantMessage
    const group: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [mergedMessage],
      turnMessages: [mergedMessage],
      model: 'grok-4.5',
    }

    const liveGroups = buildLiveGroupSet({
      allGroups: [group],
      liveMessages: [liveMessage],
      streaming: true,
    })

    expect(liveGroups.has(group)).toBe(true)
  })

  test('非流式状态不把桥接消息标记为实时 group', () => {
    const liveMessage = createAssistant('live-uuid', 'model-message-2', '已完成正文')
    const group: MessageGroup = {
      type: 'assistant-turn',
      assistantMessages: [liveMessage],
      turnMessages: [liveMessage],
      model: 'grok-4.5',
    }

    const liveGroups = buildLiveGroupSet({
      allGroups: [group],
      liveMessages: [liveMessage],
      streaming: false,
    })

    expect(liveGroups.size).toBe(0)
  })
})
