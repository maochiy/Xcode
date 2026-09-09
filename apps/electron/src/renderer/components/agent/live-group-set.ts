import type { SDKMessage } from '@proma/shared'
import { getAssistantModelMessageId } from '@/lib/agent-live-message'
import { findStreamingFallbackInsertionIndex } from '@/lib/agent-streaming-order'
import type { MessageGroup } from './SDKMessageRenderer'

interface BuildLiveGroupSetOptions {
  allGroups: MessageGroup[]
  liveMessages?: readonly SDKMessage[] | null
  streaming: boolean
  currentTurnStartedAt?: number
}

const EMPTY_LIVE_GROUPS: ReadonlySet<MessageGroup> = new Set<MessageGroup>()

/**
 * 只有会话仍在流式输出时，liveMessages 才代表“运行中的消息”。
 * 流式结束后它只是防闪烁桥接数据，不应继续触发展开态、隐藏操作栏等 live UI。
 */
export function buildLiveGroupSet({
  allGroups,
  liveMessages,
  streaming,
  currentTurnStartedAt,
}: BuildLiveGroupSetOptions): ReadonlySet<MessageGroup> {
  if (!streaming || !liveMessages || liveMessages.length === 0) return EMPTY_LIVE_GROUPS

  const liveSet = new Set<SDKMessage>(liveMessages)
  const liveAssistantMessageIds = new Set(
    liveMessages
      .map((message) => getAssistantModelMessageId(message))
      .filter((id): id is string => id != null && id.length > 0),
  )
  const result = new Set<MessageGroup>()
  const currentUserIndex = findStreamingFallbackInsertionIndex(allGroups, liveMessages, currentTurnStartedAt)

  for (const [index, group] of allGroups.entries()) {
    // 保留的旧工具/暂停快照只用于历史展示，不能抑制新回合占位或恢复旧轮 spinner。
    if (currentUserIndex != null && index < currentUserIndex) continue
    if (group.type === 'user' || group.type === 'system') {
      if (liveSet.has(group.message as SDKMessage)) {
        result.add(group)
      }
      continue
    }

    // assistant-turn 可能被 mergeAdjacentSameModelTurns 合并，
    // 需检查任意一条 assistantMessage 是否来自实时流。
    if (group.assistantMessages.some((message) => {
      if (liveSet.has(message as SDKMessage)) return true
      const modelMessageId = getAssistantModelMessageId(message as SDKMessage)
      return modelMessageId != null && liveAssistantMessageIds.has(modelMessageId)
    })) {
      result.add(group)
    }
  }

  return result
}
