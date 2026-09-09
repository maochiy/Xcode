import type { SDKMessage } from '@proma/shared'
import type { MessageGroup } from '@proma/session-core'

/**
 * 找到当前回合用户消息在统一消息列表中的位置，不重排 transcript。
 *
 * 新 run 的初始 user 与 startedAt 共享同一时间戳（乐观/持久化均如此）；
 * 原生 steering 的 user 与 turnStartedAt 共享消费时间戳。
 * 不能只识别 steering 标记，否则停止后新建 run 的执行占位会被旧 live 遮住。
 */
export function findStreamingFallbackInsertionIndex(
  groups: readonly MessageGroup[],
  liveMessages: readonly SDKMessage[],
  currentTurnStartedAt?: number,
): number | undefined {
  if (currentTurnStartedAt != null) {
    const currentUserIndex = groups.findLastIndex((group) =>
      group.type === 'user'
      && (group.message as unknown as Record<string, unknown>)._createdAt === currentTurnStartedAt,
    )
    return currentUserIndex >= 0 ? currentUserIndex : undefined
  }

  if (liveMessages.length === 0) return undefined

  const liveNativeQueuedUserIds = new Set(
    liveMessages.flatMap((message) => {
      const record = message as unknown as Record<string, unknown>
      return message.type === 'user'
        && record._promaNativeMessage === true
        && record._promaQueuedDuringStreaming === true
        && typeof record.uuid === 'string'
        && record.uuid.length > 0
        ? [record.uuid]
        : []
    }),
  )
  if (liveNativeQueuedUserIds.size === 0) return undefined

  // 同一会话里可能先后存在多个已被 Pi 消费的 steering user。
  // 只能以最新一个作为当前 steering 回合的边界；取第一个会把上一轮
  // assistant 误判成当前流式内容，切换会话或首帧刷新时就会出现两个
  // 「已处理/正在思考」状态同时显示。
  const queuedUserIndex = groups.findLastIndex((group) => {
    if (group.type !== 'user') return false

    const record = group.message as unknown as Record<string, unknown>
    if (
      record._promaNativeMessage !== true
      || record._promaQueuedDuringStreaming !== true
      || typeof record.uuid !== 'string'
    ) return false

    // 原生 user 可能已从 live 刷新到 persisted，不能依赖对象引用判断；
    // 但仍须用稳定 UUID 限定在当前 live 投影，避免历史 steering user
    // 干扰后续普通回合的 fallback 位置。
    return liveNativeQueuedUserIds.has(record.uuid)
  })

  return queuedUserIndex >= 0 ? queuedUserIndex : undefined
}
