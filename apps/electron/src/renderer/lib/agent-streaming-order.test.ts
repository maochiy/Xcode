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
  test('Given 立即发送已停止旧 run When 新 user 只有乐观标记 Then 用当前回合精确边界识别，不等待原生 steering', () => {
    const current = userMessage('new-user', '新问题', 300)
    const groups: MessageGroup[] = [
      { type: 'user', message: userMessage('old-user', '旧问题', 100) },
      { type: 'user', message: current },
    ]
    expect(findStreamingFallbackInsertionIndex(groups, [current], 300)).toBe(1)
    // 切换页面后 live 可以为空，持久化 user 仍能确定当前回合。
    expect(findStreamingFallbackInsertionIndex(groups, [], 300)).toBe(1)
    // 不根据时间范围猜测当前 user，未加载时不能把历史输入当成新边界。
    expect(findStreamingFallbackInsertionIndex(groups, [current], 400)).toBeUndefined()
  })
  test('Given 当前 assistant 仍在由 fallback 输出 When 立即发送新消息 Then fallback 应插在新用户消息之前', () => {
    const previousUser = userMessage('user-1', '先处理这个', 100)
    const queuedUser = userMessage('user-2', '立即处理这个', 250)
    ;(queuedUser as unknown as Record<string, unknown>)._promaQueuedDuringStreaming = true
    ;(queuedUser as unknown as Record<string, unknown>)._promaNativeMessage = true
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

  test('Given 同一会话有多个队列用户消息 When 计算当前回合边界 Then 使用最新一条用户消息', () => {
    const firstQueuedUser = userMessage('user-2', '第一条立即处理', 200)
    const latestQueuedUser = userMessage('user-3', '第二条立即处理', 300)
    ;(firstQueuedUser as unknown as Record<string, unknown>)._promaQueuedDuringStreaming = true
    ;(latestQueuedUser as unknown as Record<string, unknown>)._promaQueuedDuringStreaming = true
    ;(firstQueuedUser as unknown as Record<string, unknown>)._promaNativeMessage = true
    ;(latestQueuedUser as unknown as Record<string, unknown>)._promaNativeMessage = true
    const groups: MessageGroup[] = [
      { type: 'user', message: userMessage('user-1', '原始问题', 100) },
      {
        type: 'assistant-turn',
        assistantMessages: [assistantMessage('assistant-1', '旧回复')],
        turnMessages: [assistantMessage('assistant-1', '旧回复')],
        model: 'test-model',
      },
      { type: 'user', message: firstQueuedUser },
      {
        type: 'assistant-turn',
        assistantMessages: [assistantMessage('assistant-2', '第一条回复')],
        turnMessages: [assistantMessage('assistant-2', '第一条回复')],
        model: 'test-model',
      },
      { type: 'user', message: latestQueuedUser },
    ]

    expect(findStreamingFallbackInsertionIndex(
      groups,
      [firstQueuedUser, latestQueuedUser],
    )).toBe(4)
  })

  test('Given 原生 user 已从 live 刷新到 persisted When 计算当前回合边界 Then 仍识别实际消费的消息', () => {
    const nativeUser = userMessage('user-2', '立即处理这个', 250)
    ;(nativeUser as unknown as Record<string, unknown>)._promaQueuedDuringStreaming = true
    ;(nativeUser as unknown as Record<string, unknown>)._promaNativeMessage = true
    const mergedUser = {
      ...nativeUser,
      message: {
        ...nativeUser.message,
        content: [{ type: 'text', text: '立即处理这个' }],
      },
    } as SDKUserMessage

    const groups: MessageGroup[] = [
      { type: 'user', message: userMessage('user-1', '原始问题', 100) },
      {
        type: 'assistant-turn',
        assistantMessages: [assistantMessage('assistant-1', '旧回复')],
        turnMessages: [assistantMessage('assistant-1', '旧回复')],
        model: 'test-model',
      },
      { type: 'user', message: mergedUser },
    ]

    expect(findStreamingFallbackInsertionIndex(groups, [nativeUser])).toBe(2)
  })

  test('Given 历史中存在原生 steering user When 当前 live 属于普通回合 Then 不用历史消息移动 fallback', () => {
    const historicalNativeUser = userMessage('user-steered', '上一轮立即处理', 200)
    ;(historicalNativeUser as unknown as Record<string, unknown>)._promaQueuedDuringStreaming = true
    ;(historicalNativeUser as unknown as Record<string, unknown>)._promaNativeMessage = true
    const currentUser = userMessage('user-current', '新的普通问题', 400)
    const currentAssistant = assistantMessage('assistant-current', '正在处理')
    const groups: MessageGroup[] = [
      { type: 'user', message: historicalNativeUser },
      {
        type: 'assistant-turn',
        assistantMessages: [assistantMessage('assistant-old', '上一轮回复')],
        turnMessages: [assistantMessage('assistant-old', '上一轮回复')],
        model: 'test-model',
      },
      { type: 'user', message: currentUser },
    ]

    expect(findStreamingFallbackInsertionIndex(
      groups,
      [currentAssistant as SDKMessage],
    )).toBeUndefined()
  })
})
