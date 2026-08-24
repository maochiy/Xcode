import type { SDKMessage } from '@proma/shared'
import type { MessageGroup } from '@proma/session-core'

/**
 * 找到“立即发送”用户消息在统一消息列表中的位置。
 *
 * 立即发送时，用户消息会先作为 live user message 进入消息列表。调用方
 * 可以根据 fallback 属于旧回合还是新回合，分别插在这个位置之前或之后。
 */
export function findStreamingFallbackInsertionIndex(
  groups: readonly MessageGroup[],
  liveMessages: readonly SDKMessage[],
): number | undefined {
  if (liveMessages.length === 0) return undefined

  const liveMessageSet = new Set(liveMessages)
  const liveUserIndex = groups.findIndex((group) => {
    if (group.type !== 'user' || !liveMessageSet.has(group.message)) return false
    return (group.message as unknown as Record<string, unknown>)._promaQueuedDuringStreaming === true
  })

  return liveUserIndex >= 0 ? liveUserIndex : undefined
}
