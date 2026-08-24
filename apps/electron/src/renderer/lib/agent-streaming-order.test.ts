import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@proma/shared'
import type { MessageGroup } from '@proma/session-core'
import { findStreamingFallbackInsertionIndex } from './agent-streaming-order'

function userMessage(uuid: string, text: string, createdAt: number): SDKUserMessage {
  return {
    type: 'user',
    uuid,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    _createdAt: createdAt,
  } as SDKUserMessage
}

function assistantMessage(uuid: string, text: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { id: uuid, content: [{ type: 'text', text }] },
  } as SDKAssistantMessage
}

describe('Agent 流式 fallback 消息顺序', () => {
  test('Given 当前 assistant 仍在由 fallback 输出 When 立即发送新消息 Then fallback 应插在新用户消息之前', () => {
    const previousUser = userMessage('user-1', '先处理这个', 100)
    const queuedUser = userMessage('user-2', '立即处理这个', 250)
    ;(queuedUser as unknown as Record<string, unknown>)._promaQueuedDuringStreaming = true
    const groups: MessageGroup[] = [
      { type: 'user', message: previousUser },
      { type: 'user', message: queuedUser },
    ]

    expect(findStreamingFallbackInsertionIndex(groups, [queuedUser])).toBe(1)
  })

  test('Given live 消息中没有本轮立即发送的用户消息 When 计算 fallback 位置 Then 保持默认追加行为', () => {
    const previousUser = userMessage('user-1', '先处理这个', 100)
    const assistant = assistantMessage('assistant-1', '输出中')
    const groups: MessageGroup[] = [
      { type: 'user', message: previousUser },
      {
        type: 'assistant-turn',
        assistantMessages: [assistant],
        turnMessages: [assistant],
        model: 'test-model',
      },
    ]

    expect(findStreamingFallbackInsertionIndex(groups, [assistant as SDKMessage])).toBeUndefined()
  })
})
