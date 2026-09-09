import type { SDKMessage } from '@proma/shared'
import { collectKnownToolUseIds } from './tool-use-backfill'

export function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

export function getAssistantPartialKey(message: SDKMessage): string {
  const record = message as Record<string, unknown>
  if (typeof record.uuid === 'string' && record.uuid.length > 0) {
    return `uuid:${record.uuid}`
  }
  const inner = record.message as { id?: unknown } | undefined
  if (inner && typeof inner.id === 'string' && inner.id.length > 0) {
    return `model:${inner.id}`
  }
  const parent = typeof record.parent_tool_use_id === 'string' ? record.parent_tool_use_id : ''
  return `anon:${parent}:${message.type}`
}

export function getAssistantMessageId(message: SDKMessage): string | undefined {
  const inner = (message as { message?: { id?: unknown } }).message
  return inner && typeof inner.id === 'string' && inner.id.length > 0 ? inner.id : undefined
}

function getAssistantContentBlocks(message: SDKMessage): unknown[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? content : []
}

function assistantBlockVisibleText(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined
  const record = block as { type?: unknown; text?: unknown; thinking?: unknown }
  if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
    return `text:${record.text}`
  }
  if (record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim()) {
    return `thinking:${record.thinking}`
  }
  return undefined
}

/** 是否还有可落盘的过程正文/思考（不含仅 tool_use） */
export function hasPersistableAssistantNarrative(message: SDKMessage): boolean {
  return getAssistantContentBlocks(message).some((block) => assistantBlockVisibleText(block) !== undefined)
}

export function finalizePartialAssistantMessage(message: SDKMessage): SDKMessage {
  const record = { ...(message as Record<string, unknown>) }
  delete record._partial
  delete record._partialBlockIndex
  delete record._partialBlockIndexes
  return record as unknown as SDKMessage
}

function isTrailingFinalAnswerMessage(message: SDKMessage): boolean {
  if (message.type !== 'assistant') return false
  const content = getAssistantContentBlocks(message)
  if (content.length === 0) return false

  let hasText = false
  for (const block of content) {
    if (!block || typeof block !== 'object') return false
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'tool_use') return false
    if (
      record.type === 'text'
      && typeof record.text === 'string'
      && record.text.trim()
    ) {
      hasText = true
    }
  }
  return hasText
}

/**
 * result 到达后才冲刷的 partial 属于最终正文之前的过程内容。
 *
 * Runtime 可能先发送最终正文和 result，再由编排层固化仍未终态化的 thinking。
 * 若直接追加到数组尾部，历史投影会把 thinking 识别成 result 后的新活动。
 */
function getPartialFlushInsertionIndex(accumulatedMessages: SDKMessage[]): number {
  const terminalResultIndex = accumulatedMessages.findLastIndex((message) => message.type === 'result')
  if (terminalResultIndex < 0) return accumulatedMessages.length

  let insertionIndex = terminalResultIndex
  while (insertionIndex > 0) {
    const previousMessage = accumulatedMessages[insertionIndex - 1]
    if (!previousMessage || !isTrailingFinalAnswerMessage(previousMessage)) break
    insertionIndex -= 1
  }
  return insertionIndex
}

/**
 * 从 partial 中剥离已落盘的 tool_use，保留过程正文/思考。
 * 整条 skip 会把同一条消息里的过程正文一起丢掉。
 */
export function stripKnownToolUseBlocks(
  message: SDKMessage,
  knownToolUseIds: Set<string>,
): SDKMessage | undefined {
  if (message.type !== 'assistant') return message
  const content = getAssistantContentBlocks(message)
  if (content.length === 0) return undefined

  const kept = content.filter((block) => {
    if (!block || typeof block !== 'object') return true
    const record = block as { type?: unknown; id?: unknown }
    if (record.type !== 'tool_use') return true
    return !(typeof record.id === 'string' && knownToolUseIds.has(record.id))
  })
  if (kept.length === 0) return undefined
  if (kept.length === content.length) return message

  const record = { ...(message as Record<string, unknown>) }
  const inner = {
    ...((record.message as Record<string, unknown> | undefined) ?? {}),
    content: kept,
  }
  record.message = inner
  return record as unknown as SDKMessage
}

/** 终态 assistant 到达时，移除已被覆盖的流式 partial 快照 */
export function clearMatchedPartialAssistants(
  latestPartialAssistants: Map<string, SDKMessage>,
  finalMessage: SDKMessage,
): void {
  if (latestPartialAssistants.size === 0) return
  const messageId = getAssistantMessageId(finalMessage)
  if (!messageId) return
  const record = finalMessage as Record<string, unknown>
  const indexes: number[] = []
  if (typeof record._partialBlockIndex === 'number' && Number.isInteger(record._partialBlockIndex)) {
    indexes.push(record._partialBlockIndex)
  }
  if (Array.isArray(record._partialBlockIndexes)) {
    for (const value of record._partialBlockIndexes) {
      if (typeof value === 'number' && Number.isInteger(value)) indexes.push(value)
    }
  }
  if (indexes.length > 0) {
    for (const index of indexes) {
      latestPartialAssistants.delete(`uuid:ccb-partial:${messageId}:${index}`)
    }
    return
  }

  // 无 block 索引的终态（含 ccb-finalized）：清掉同 messageId 的全部 partial
  for (const [key, message] of [...latestPartialAssistants.entries()]) {
    if (getAssistantMessageId(message) !== messageId) continue
    if (!isPartialSDKMessage(message) && !key.includes('ccb-partial:')) continue
    latestPartialAssistants.delete(key)
  }
}

/**
 * 将仍停留在 partial 的 assistant 冲刷进累积列表。
 * 关键：已回填的 tool_use 只剥离，不整段丢弃，否则过程正文会在暂停后从 JSONL 蒸发。
 */
export function flushPartialAssistantsToAccumulated(
  latestPartialAssistants: Map<string, SDKMessage>,
  accumulatedMessages: SDKMessage[],
  knownToolUseIds?: Set<string>,
): void {
  if (latestPartialAssistants.size === 0) return
  const existingKeys = new Set(
    accumulatedMessages
      .filter((message) => message.type === 'assistant')
      .map((message) => getAssistantPartialKey(message)),
  )
  const existingNarrative = new Set<string>()
  for (const message of accumulatedMessages) {
    if (message.type !== 'assistant') continue
    const messageId = getAssistantMessageId(message) ?? ''
    for (const block of getAssistantContentBlocks(message)) {
      const text = assistantBlockVisibleText(block)
      if (text) existingNarrative.add(`${messageId}::${text}`)
    }
  }

  const seenToolUseIds = knownToolUseIds ?? collectKnownToolUseIds(accumulatedMessages)
  const finalizedPartials: SDKMessage[] = []
  for (const [key, message] of latestPartialAssistants) {
    if (existingKeys.has(key)) continue

    let candidate = stripKnownToolUseBlocks(message, seenToolUseIds)
    if (!candidate) continue

    if (!hasPersistableAssistantNarrative(candidate)) {
      const remainingTools = collectKnownToolUseIds([candidate])
      if (remainingTools.size === 0) continue
      if ([...remainingTools].every((id) => seenToolUseIds.has(id))) continue
    } else {
      const messageId = getAssistantMessageId(candidate) ?? ''
      const content = getAssistantContentBlocks(candidate)
      const filtered = content.filter((block) => {
        const text = assistantBlockVisibleText(block)
        if (!text) return true
        return !existingNarrative.has(`${messageId}::${text}`)
      })
      if (filtered.length === 0) continue
      if (filtered.length !== content.length) {
        const record = { ...(candidate as Record<string, unknown>) }
        record.message = {
          ...((record.message as Record<string, unknown> | undefined) ?? {}),
          content: filtered,
        }
        candidate = record as unknown as SDKMessage
      }
      if (
        !hasPersistableAssistantNarrative(candidate)
        && collectKnownToolUseIds([candidate]).size === 0
      ) {
        continue
      }
    }

    const finalized = finalizePartialAssistantMessage(candidate)
    finalizedPartials.push(finalized)
    existingKeys.add(key)
    const messageId = getAssistantMessageId(finalized) ?? ''
    for (const block of getAssistantContentBlocks(finalized)) {
      const text = assistantBlockVisibleText(block)
      if (text) existingNarrative.add(`${messageId}::${text}`)
    }
    for (const id of collectKnownToolUseIds([finalized])) seenToolUseIds.add(id)
  }
  if (finalizedPartials.length > 0) {
    const insertionIndex = getPartialFlushInsertionIndex(accumulatedMessages)
    accumulatedMessages.splice(insertionIndex, 0, ...finalizedPartials)
  }
  latestPartialAssistants.clear()
}
