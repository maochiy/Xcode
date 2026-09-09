import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKUserMessage } from '@proma/shared'
import { isUserInputMessage } from '@proma/session-core'

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

export function isNativeAgentMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._promaNativeMessage === true
}

export interface NativeAgentSteeringTurn {
  uuid: string
  createdAt: number
}

/**
 * Pi 只有在 steering user 实际进入上下文后才推送这条原生消息。
 * Renderer 以此作为新可见 Turn 的唯一开始信号，不使用点击时间乐观切换。
 */
export function getNativeAgentSteeringTurn(
  message: SDKMessage,
): NativeAgentSteeringTurn | undefined {
  if (message.type !== 'user' || !isNativeAgentMessage(message)) return undefined
  const record = message as Record<string, unknown>
  if (record._promaQueuedDuringStreaming !== true) return undefined
  if (typeof record.uuid !== 'string' || record.uuid.length === 0) return undefined
  if (typeof record._createdAt !== 'number') return undefined
  return {
    uuid: record.uuid,
    createdAt: record._createdAt,
  }
}

export function getAssistantModelMessageId(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant') return undefined
  const innerMessage = readRecord((message as Record<string, unknown>).message)
  return typeof innerMessage?.id === 'string' ? innerMessage.id : undefined
}

function getAssistantBlocks(message: SDKMessage): SDKContentBlock[] {
  if (message.type !== 'assistant') return []
  const innerMessage = readRecord((message as Record<string, unknown>).message)
  return Array.isArray(innerMessage?.content)
    ? innerMessage.content as SDKContentBlock[]
    : []
}

function getAssistantText(message: SDKMessage): string {
  return getAssistantBlocks(message)
    .filter((block): block is Extract<SDKContentBlock, { type: 'text' }> =>
      block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('')
}

function getUserMessageText(message: SDKMessage): string {
  if (message.type !== 'user') return ''
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object'
      && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

function isPausedAssistantMessage(message: SDKMessage): boolean {
  return message.type === 'assistant'
    && (message as Record<string, unknown>)._promaPausedByUser === true
}

/**
 * 暂停瞬间可能同时存在多份 Runtime partial 快照：
 * 「当前累计正文」和「最后一个增量正文」会因为 UUID 不同都留在 live。
 * 两者在持久化完成前会一起渲染，只有旧回合结束后才被 JSONL 覆盖，
 * 所以需要在 live 层先保留内容更完整的一份。
 */
function dedupePausedAssistantMessages(messages: SDKMessage[]): SDKMessage[] {
  const result: SDKMessage[] = []
  for (const message of messages) {
    if (
      isNativeAgentMessage(message)
      || !isPausedAssistantMessage(message)
      || getAssistantText(message).trim().length === 0
    ) {
      result.push(message)
      continue
    }

    const text = getAssistantText(message)
    const duplicateIndex = result.findIndex((candidate) => {
      if (!isPausedAssistantMessage(candidate)) return false
      const candidateText = getAssistantText(candidate)
      return candidateText.includes(text) || text.includes(candidateText)
    })
    if (duplicateIndex < 0) {
      result.push(message)
      continue
    }

    const existing = result[duplicateIndex]!
    const existingText = getAssistantText(existing)
    const existingBlocks = getAssistantBlocks(existing).length
    const currentBlocks = getAssistantBlocks(message).length
    const currentIsMoreComplete = text.length > existingText.length
      || (text.length === existingText.length && currentBlocks > existingBlocks)
    if (currentIsMoreComplete) {
      result[duplicateIndex] = message
    }
  }
  return result
}

function blocksMatch(
  partialBlock: SDKContentBlock,
  finalBlock: SDKContentBlock,
): boolean {
  if (partialBlock.type !== finalBlock.type) return false

  if (partialBlock.type === 'thinking' && finalBlock.type === 'thinking') {
    return partialBlock.thinking === finalBlock.thinking
  }

  if (partialBlock.type === 'text' && finalBlock.type === 'text') {
    return partialBlock.text === finalBlock.text
  }

  return partialBlock.type === 'tool_use'
    && finalBlock.type === 'tool_use'
    && partialBlock.id === finalBlock.id
}

function blocksHaveCompatibleKind(
  partialBlock: SDKContentBlock,
  finalBlock: SDKContentBlock,
): boolean {
  if (partialBlock.type !== finalBlock.type) return false
  if (partialBlock.type !== 'tool_use' || finalBlock.type !== 'tool_use') {
    return partialBlock.type === 'thinking' || partialBlock.type === 'text'
  }
  return partialBlock.id === finalBlock.id
}

function removeSupersededPartialMessages(
  current: SDKMessage[],
  incoming: SDKMessage,
): SDKMessage[] {
  const incomingRecord = incoming as Record<string, unknown>
  if (incoming.type !== 'assistant' || incomingRecord._partial === true) {
    return current
  }

  const incomingMessageId = getAssistantModelMessageId(incoming)
  const incomingBlocks = getAssistantBlocks(incoming)
  if (!incomingMessageId || incomingBlocks.length === 0) return current

  const candidates = current.filter((candidate) => {
    const candidateRecord = candidate as Record<string, unknown>
    return candidateRecord._partial === true
      && getAssistantModelMessageId(candidate) === incomingMessageId
  })
  if (candidates.length === 0) return current

  const indexedBlocks = Array.isArray(incomingRecord._partialBlockIndexes)
    ? incomingRecord._partialBlockIndexes.filter(
      (index): index is number => typeof index === 'number' && Number.isInteger(index),
    )
    : typeof incomingRecord._partialBlockIndex === 'number'
      && Number.isInteger(incomingRecord._partialBlockIndex)
      ? [incomingRecord._partialBlockIndex]
      : []

  if (indexedBlocks.length > 0) {
    const indexedBlockSet = new Set(indexedBlocks)
    const filtered = current.filter((candidate) => {
      const candidateRecord = candidate as Record<string, unknown>
      return !(
        candidateRecord._partial === true
        && getAssistantModelMessageId(candidate) === incomingMessageId
        && typeof candidateRecord._partialBlockIndex === 'number'
        && indexedBlockSet.has(candidateRecord._partialBlockIndex)
      )
    })
    if (filtered.length !== current.length) return filtered
  }

  const superseded = new Set<SDKMessage>()
  for (const incomingBlock of incomingBlocks) {
    const compatible = candidates.filter((candidate) =>
      getAssistantBlocks(candidate).some((partialBlock) =>
        blocksHaveCompatibleKind(partialBlock, incomingBlock)
      )
    )
    const exact = compatible.filter((candidate) =>
      getAssistantBlocks(candidate).some((partialBlock) =>
        blocksMatch(partialBlock, incomingBlock)
      )
    )

    if (exact.length > 0) {
      for (const candidate of exact) superseded.add(candidate)
    } else if (compatible.length === 1) {
      superseded.add(compatible[0]!)
    }
  }

  return superseded.size > 0
    ? current.filter((candidate) => !superseded.has(candidate))
    : current
}

/**
 * 将带有 `_createdAt` 的消息按创建时间恢复顺序。
 *
 * 立即发送时，新的 user 可能先落盘，而旧 assistant 的最终快照稍后才
 * 追加到 JSONL。只按数组追加顺序渲染会得到「旧 user → 新 user → 旧
 * assistant」。未带时间戳的历史消息保留原槽位，避免破坏旧数据。
 */
function orderMessagesByCreatedAt(messages: SDKMessage[]): SDKMessage[] {
  // Pi 原生 transcript 已按真实上下文顺序推送并持久化，时间戳只用于展示。
  // 一旦列表中出现原生消息，就禁止 Renderer 再按时间重排整个序列。
  if (messages.some(isNativeAgentMessage)) return messages

  const timestamped = messages.filter((message) =>
    typeof (message as Record<string, unknown>)._createdAt === 'number',
  )
  if (timestamped.length < 2) return messages

  const isChronological = timestamped.every((message, index) => {
    if (index === 0) return true
    const previous = timestamped[index - 1] as Record<string, unknown>
    const current = message as Record<string, unknown>
    return Number(previous._createdAt) <= Number(current._createdAt)
  })
  if (isChronological) return messages

  const ordered = [...timestamped].sort((left, right) => {
    const leftAt = Number((left as Record<string, unknown>)._createdAt)
    const rightAt = Number((right as Record<string, unknown>)._createdAt)
    return leftAt - rightAt
  })
  let orderedIndex = 0
  return messages.map((message) => {
    if (typeof (message as Record<string, unknown>)._createdAt !== 'number') {
      return message
    }
    return ordered[orderedIndex++]!
  })
}

/**
 * 合并实时 SDK 消息：
 * - 同 UUID 的 partial 使用最新累计快照覆盖；
 * - CCB 最终 assistant 到达时，移除同一模型消息/内容块的临时快照；
 * - 已存在的非 partial 消息保持去重。
 */
export function upsertAgentLiveMessage(
  current: SDKMessage[],
  incoming: SDKMessage,
): SDKMessage[] {
  const incomingRecord = incoming as Record<string, unknown>
  if (isNativeAgentMessage(incoming)) {
    const incomingUuid = incomingRecord.uuid
    if (typeof incomingUuid !== 'string' || incomingUuid.length === 0) {
      return [...current, incoming]
    }

    const existingIndex = current.findIndex((message) =>
      (message as Record<string, unknown>).uuid === incomingUuid
    )
    if (existingIndex < 0) return [...current, incoming]

    const existing = current[existingIndex] as Record<string, unknown>
    if (
      incomingRecord._partial === true
      || existing._partial === true
      || existing._promaPausedByUser === true
      || !isNativeAgentMessage(current[existingIndex]!)
    ) {
      const next = [...current]
      next[existingIndex] = incoming
      return next
    }
    return current
  }

  const incomingMessageId = getAssistantModelMessageId(incoming)
  const originalAssistant = incoming.type === 'assistant' && incomingMessageId
    ? current.find((candidate) => (
      candidate.type === 'assistant'
      && getAssistantModelMessageId(candidate) === incomingMessageId
      && typeof (candidate as Record<string, unknown>)._createdAt === 'number'
    ))
    : undefined
  const incomingWithStableCreatedAt = originalAssistant
    && typeof incomingRecord._createdAt !== 'number'
    ? {
        ...incoming,
        _createdAt: (originalAssistant as Record<string, unknown>)._createdAt,
      }
    : incoming
  const base = removeSupersededPartialMessages(current, incoming)
  const stableIncomingRecord = incomingWithStableCreatedAt as Record<string, unknown>
  const incomingUuid = stableIncomingRecord.uuid

  if (typeof incomingUuid === 'string' && incomingUuid.length > 0) {
    // 暂停快照属于旧回合，即使 Runtime 恰好复用了 UUID，也不能挡住
    // 新回合的第一条 assistant 消息。
    const existingIndex = base.findLastIndex((message) => {
      const record = message as Record<string, unknown>
      return record.uuid === incomingUuid && record._promaPausedByUser !== true
    })
    if (existingIndex >= 0) {
      const existing = base[existingIndex] as Record<string, unknown>
      if (stableIncomingRecord._partial === true || existing._partial === true) {
        const next = [...base]
        // final 快照通常由主进程在到达时才补 _createdAt。保留同一
        // assistant 身份第一次出现的时间，避免旧回复的 final 快照被
        // 排到用户刚发送的新消息后面。
        if (
          typeof stableIncomingRecord._createdAt !== 'number'
          && typeof existing._createdAt === 'number'
        ) {
          next[existingIndex] = {
            ...incomingWithStableCreatedAt,
            _createdAt: existing._createdAt,
          }
        } else {
          next[existingIndex] = incomingWithStableCreatedAt
        }
        return next
      }
      return base
    }
  }

  return [...base, incomingWithStableCreatedAt]
}

/**
 * 按 IPC 到达顺序合并一批实时消息。
 *
 * 渲染层会在短时间窗口内合帧，批量更新不能直接使用最后一条消息覆盖，
 * 必须逐条应用 upsert 规则，才能同时保留不同消息并正确处理 partial/final。
 */
export function mergeAgentLiveMessages(
  current: SDKMessage[],
  incoming: SDKMessage[],
): SDKMessage[] {
  return incoming.reduce(
    (messages, message) => upsertAgentLiveMessage(messages, message),
    current,
  )
}

/**
 * 消费 queued user 前，先合并同一 session 已经到达的消息前缀。
 * 该边界顺序必须保持为「旧 assistant/tool → 新 user」。
 */
export function mergeAgentLiveMessagesAtQueuedUserBoundary(
  current: SDKMessage[],
  pendingPrefix: SDKMessage[],
  queuedUser: SDKMessage,
): SDKMessage[] {
  return mergeAgentLiveMessages(current, [...pendingPrefix, queuedUser])
}

/**
 * 将旧回合尚未进入 SDK transcript 的流式正文固化到 live projection。
 *
 * 部分 Runtime 只通过 legacy text_delta 推送正文，暂停时正文仍在
 * AgentStreamState.content 中；如果直接启动新回合并把 content 清空，
 * 用户已经看到的旧正文就会消失。这里优先补全同一条 assistant 快照，
 * 只有找不到可复用的 assistant 时才新增一条暂停快照。
 */
export function preservePausedAgentContent(
  current: SDKMessage[],
  content: string,
  sessionId: string,
  startedAt: number | undefined,
  model: string | undefined,
): SDKMessage[] {
  if (!content) return current

  const lastUserIndex = current.findLastIndex((message) =>
    message.type === 'user' && isUserInputMessage(message as SDKUserMessage),
  )
  const assistantIndex = current.findLastIndex(
    (message, index) => message.type === 'assistant' && index > lastUserIndex,
  )
  if (assistantIndex >= 0) {
    const existing = current[assistantIndex] as SDKAssistantMessage
    const blocks = existing.message?.content
    if (Array.isArray(blocks)) {
      const textIndexes = blocks.reduce<number[]>((indexes, block, index) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          indexes.push(index)
        }
        return indexes
      }, [])
      const existingText = textIndexes
        .map((index) => {
          const block = blocks[index]
          return block?.type === 'text' ? block.text : ''
        })
        .join('')

      if (existingText === content || existingText.includes(content)) {
        const next = [...current]
        next[assistantIndex] = {
          ...existing,
          _partial: false,
          _promaPausedByUser: true,
        } as SDKAssistantMessage
        return next
      }

      const lastTextIndex = textIndexes.at(-1)
      if (lastTextIndex != null && content.startsWith(existingText)) {
        const next = [...current]
        next[assistantIndex] = {
          ...existing,
          _partial: false,
          _promaPausedByUser: true,
          message: {
            ...existing.message,
            content: blocks.map((block, index) =>
              index === lastTextIndex && block.type === 'text'
                ? { ...block, text: content }
                : block
            ),
          },
        }
        return next
      }
    }
  }

  // live 中通常已经有旧 user/assistant 的时间戳。快照必须排在这些消息
  // 之后，否则会被恢复到旧 user 之前，表现为旧内容顺序错乱。
  const currentTimestamps = current
    .map((message) => (message as Record<string, unknown>)._createdAt)
    .filter((value): value is number => typeof value === 'number')
  const latestCurrentTimestamp = currentTimestamps.length > 0
    ? Math.max(...currentTimestamps)
    : undefined
  const snapshotAt = latestCurrentTimestamp != null
    ? Math.max(latestCurrentTimestamp + 1, startedAt ?? 0)
    : (startedAt ?? Date.now())
  const snapshot: SDKAssistantMessage = {
    type: 'assistant',
    uuid: `${sessionId}:paused-stream:${snapshotAt}`,
    parent_tool_use_id: null,
    message: {
      id: `${sessionId}:paused-stream:${snapshotAt}`,
      content: [{ type: 'text', text: content }],
      ...(model ? { model } : {}),
    },
    _createdAt: snapshotAt,
    _channelModelId: model,
    _promaPausedStreamSnapshot: true,
    _promaPausedByUser: true,
  } as unknown as SDKAssistantMessage
  return [...current, snapshot]
}

/**
 * 将暂停瞬间已经进入 live projection 的旧 assistant 快照冻结。
 *
 * 这类内容不一定同时存在于 streamState.content（Pi/部分 Runtime 只发
 * sdk_message），因此立即发送时不能只保存 legacy content。
 */
export function markPausedAgentMessages(current: SDKMessage[]): SDKMessage[] {
  const lastUserIndex = current.findLastIndex((message) =>
    message.type === 'user' && isUserInputMessage(message as SDKUserMessage),
  )
  let changed = false
  const next = current.map((message, index) => {
    if (index <= lastUserIndex || message.type !== 'assistant') return message
    const record = message as Record<string, unknown>
    if (record._promaPausedByUser === true && record._partial === false) {
      return message
    }
    changed = true
    return {
      ...message,
      _partial: false,
      _promaPausedByUser: true,
    } as SDKMessage
  })
  return changed ? next : current
}


/**
 * 合并持久化消息与 liveMessages。
 * 关键约束：暂停后残留的上一轮 live 内容，不能被拼到新用户消息之后。
 */
export function mergePersistedAndLiveMessages(
  persisted: SDKMessage[],
  live: SDKMessage[],
  options?: {
    identityOf?: (message: SDKMessage) => string
  },
): SDKMessage[] {
  if (persisted.length === 0 && live.length === 0) return []

  const hasNativeMessages = persisted.some(isNativeAgentMessage)
    || live.some(isNativeAgentMessage)
  const identityOf = options?.identityOf ?? ((message: SDKMessage) => {
    const record = message as Record<string, unknown>
    if (typeof record.uuid === 'string' && record.uuid.length > 0) {
      return `${message.type}:uuid:${record.uuid}`
    }
    if (message.type === 'user') {
      const createdAt = typeof record._createdAt === 'number'
        ? record._createdAt
        : undefined
      const text = getUserMessageText(message)
      if (createdAt != null && text.length > 0) {
        // 普通发送会先生成 renderer 乐观 user，再由主进程写入同一轮
        // user。两者没有共享 uuid，但共享本轮 startedAt。
        return `user:created-at:${createdAt}:${text}`
      }
    }
    if (message.type === 'assistant') {
      const inner = record.message as { id?: unknown } | undefined
      if (inner && typeof inner.id === 'string' && inner.id.length > 0) {
        return `assistant:model:${inner.id}`
      }
    }
    const createdAt = typeof record._createdAt === 'number' ? record._createdAt : 'na'
    return `${message.type}:${createdAt}:${JSON.stringify(record.message ?? record.subtype ?? '')}`
  })
  const mergeIdentityOf = (message: SDKMessage): string => {
    const uuid = (message as Record<string, unknown>).uuid
    if (typeof uuid === 'string' && uuid.length > 0) {
      return `uuid:${uuid}`
    }
    return identityOf(message)
  }
  const createdAtOf = (message: SDKMessage): number | undefined => {
    const value = (message as Record<string, unknown>)._createdAt
    return typeof value === 'number' ? value : undefined
  }

  const seen = new Set<string>()
  const uniquePersistedIndex = new Map<string, number>()
  const uniquePersisted: SDKMessage[] = []
  for (const message of persisted) {
    const identity = mergeIdentityOf(message)
    if (seen.has(identity)) continue
    seen.add(identity)
    uniquePersistedIndex.set(identity, uniquePersisted.length)
    uniquePersisted.push(message)
  }

  const liveOnly: SDKMessage[] = []
  for (const message of dedupePausedAssistantMessages(live)) {
    const identity = mergeIdentityOf(message)
    if (seen.has(identity)) {
      const persistedIndex = uniquePersistedIndex.get(identity)
      if (
        persistedIndex != null
        && isNativeAgentMessage(message)
        && !isNativeAgentMessage(uniquePersisted[persistedIndex]!)
      ) {
        // 普通发送会先插入带 UUID 的乐观 user。原生 user 到达后应在
        // 相同槽位替换它，保留 Runtime 元数据，但不能改变流顺序。
        uniquePersisted[persistedIndex] = message
      }
      continue
    }
    // 暂停快照是为了在 JSONL 尚未刷新时保住画面。JSONL 一旦已经
    // 包含相同或更完整的旧回复，就不能再把 live 快照追加一次，否则
    // 同一段旧内容会在界面中重复显示。
    if (
      message.type === 'assistant'
      && !isNativeAgentMessage(message)
      && (message as Record<string, unknown>)._promaPausedByUser === true
    ) {
      const pausedText = getAssistantText(message)
      if (
        pausedText.trim().length > 0
        && uniquePersisted.some((persistedMessage) =>
          persistedMessage.type === 'assistant'
          && getAssistantText(persistedMessage).includes(pausedText)
        )
      ) {
        continue
      }
    }
    if (
      message.type === 'result'
      && !isNativeAgentMessage(message)
      && (message as { subtype?: string }).subtype === 'interrupted'
      && uniquePersisted.some((item) =>
        item.type === 'result'
        && (item as { subtype?: string }).subtype === 'interrupted',
      )
    ) {
      continue
    }
    seen.add(identity)
    liveOnly.push(message)
  }

  if (liveOnly.length === 0) return orderMessagesByCreatedAt(uniquePersisted)
  if (hasNativeMessages) {
    // 持久化 transcript 是稳定前缀，live 是尚未刷新到磁盘的 IPC 后缀。
    // 原生消息只按这两个来源的流顺序拼接，不按内容或 _createdAt 干预。
    return [...uniquePersisted, ...liveOnly]
  }

  const merged: SDKMessage[] = []
  let persistedIndex = 0
  let liveIndex = 0
  while (persistedIndex < uniquePersisted.length && liveIndex < liveOnly.length) {
    const persistedMessage = uniquePersisted[persistedIndex]!
    const liveMessage = liveOnly[liveIndex]!
    const persistedAt = createdAtOf(persistedMessage)
    const liveAt = createdAtOf(liveMessage)
    if (liveAt != null && (persistedAt == null || liveAt < persistedAt)) {
      merged.push(liveMessage)
      liveIndex += 1
    } else {
      merged.push(persistedMessage)
      persistedIndex += 1
    }
  }
  if (persistedIndex < uniquePersisted.length) {
    merged.push(...uniquePersisted.slice(persistedIndex))
  }
  if (liveIndex < liveOnly.length) {
    merged.push(...liveOnly.slice(liveIndex))
  }
  return orderMessagesByCreatedAt(merged)
}


function extractAssistantNarrativeFingerprints(message: SDKMessage): string[] {
  if (message.type !== 'assistant') return []
  const messageId = getAssistantModelMessageId(message) ?? ''
  const fingerprints: string[] = []
  for (const block of getAssistantBlocks(message)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      fingerprints.push(`${messageId}::text:${block.text}`)
    }
    if (
      block.type === 'thinking'
      && typeof (block as { thinking?: unknown }).thinking === 'string'
      && (block as { thinking: string }).thinking.trim()
    ) {
      fingerprints.push(`${messageId}::thinking:${(block as { thinking: string }).thinking}`)
    }
  }
  return fingerprints
}

/**
 * 用户暂停后：live 是否仍有 JSONL 未覆盖的过程正文/思考。
 * 有则应保留 live，避免「有任意 assistant 就清 live」导致正文蒸发。
 */
export function hasUnpersistedLiveAssistantNarrative(
  liveMessages: SDKMessage[],
  persistedMessages: SDKMessage[],
): boolean {
  const persisted = new Set<string>()
  for (const message of persistedMessages) {
    for (const fp of extractAssistantNarrativeFingerprints(message)) {
      persisted.add(fp)
    }
  }
  for (const message of liveMessages) {
    for (const fp of extractAssistantNarrativeFingerprints(message)) {
      if (!persisted.has(fp)) return true
    }
  }
  return false
}

/**
 * 立即发送时固化的旧回合内容不能因为新回合完成就被清掉。
 *
 * 暂停快照可能还没来得及进入 JSONL，且它的 synthetic message id 与
 * Runtime 最终 assistant id 不同，因此不能只按消息 identity 判断是否已落盘。
 * 只要持久化 assistant 尚未包含快照中的正文，就继续保留 live projection。
 */
export function hasUnpersistedPausedAgentContent(
  liveMessages: SDKMessage[],
  persistedMessages: SDKMessage[],
): boolean {
  const persistedTexts = persistedMessages
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => getAssistantBlocks(message))
    .filter((block): block is Extract<SDKContentBlock, { type: 'text' }> =>
      block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .filter((text) => text.trim().length > 0)

  return liveMessages.some((message) => {
    const record = message as Record<string, unknown>
    if (message.type !== 'assistant' || record._promaPausedByUser !== true) {
      return false
    }
    const text = getAssistantBlocks(message)
      .filter((block): block is Extract<SDKContentBlock, { type: 'text' }> =>
        block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('')
    return text.trim().length > 0
      && !persistedTexts.some((persistedText) => persistedText.includes(text))
  })
}
