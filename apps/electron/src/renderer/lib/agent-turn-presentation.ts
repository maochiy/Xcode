import type {
  AgentEventUsage,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKResultMessage,
  SDKThinkingBlock,
  SDKTextBlock,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@proma/shared'
import { pickRuntimeReportedContextWindow } from '@proma/shared'
import type { AssistantTurn } from '@proma/session-core'
import {
  resolveAgentTurnCollapsePolicy,
  type AgentAutoCollapseBlockReason,
} from './agent-turn-collapse'
import {
  resolveRunningTurnStatus,
  type AgentTurnStatus,
} from './agent-turn-status'

export interface AgentActivityItem {
  block: SDKContentBlock
  index: number
  /** item/completed 之前仅当前 item 为 true，用于原位更新运行态。 */
  running: boolean
  /**
   * 是否进入整轮活动折叠区。
   * - thinking / tool_use：可折叠；运行中默认只显示最新一行
   * - 过程正文（中间穿插的摘要/说明 text）：不进折叠，始终可见
   */
  foldable: boolean
}

/**
 * 合并同一 Turn 内连续的 thinking block，避免「已完成思考」重复显示多次。
 *
 * 规则要求一个 Turn 只有一个思考项，后续 thinking delta 追加到同一思考项中，
 * 不为每个 thinking block 创建独立的活动行。
 */
function coalesceAdjacentThinkingBlocks(
  blocks: SDKContentBlock[],
): SDKContentBlock[] {
  const result: SDKContentBlock[] = []
  let accumulated: string[] | null = null

  for (const block of blocks) {
    if (block.type === 'thinking') {
      const thinkingBlock = block as SDKThinkingBlock
      if (typeof thinkingBlock.thinking === 'string' && thinkingBlock.thinking.trim()) {
        if (accumulated === null) accumulated = []
        accumulated.push(thinkingBlock.thinking)
      }
      // 不立即 push；等待遇到非 thinking block 时再合并输出
      continue
    }

    // 先 flush 已累积的 thinking
    if (accumulated !== null) {
      result.push({
        type: 'thinking',
        thinking: accumulated.join('\n\n'),
      } as SDKThinkingBlock)
      accumulated = null
    }
    result.push(block)
  }

  // 尾部残留的 thinking
  if (accumulated !== null) {
    result.push({
      type: 'thinking',
      thinking: accumulated.join('\n\n'),
    } as SDKThinkingBlock)
  }

  return result
}

export interface AgentPersistentItem {
  block: SDKContentBlock
  index: number
  kind: 'answer' | 'plan' | 'persistent'
}

export interface AgentTurnPresentation {
  id: string
  model?: string
  durationMs?: number
  usage?: AgentEventUsage
  status: AgentTurnStatus
  /** 本轮模型实际返回的全部 thinking 原文，跨工具调用按时间顺序聚合。 */
  thinkingContent: string
  activities: AgentActivityItem[]
  /**
   * 当前界面默认直接展示的活动（折叠收起时）。
   *
   * 流式收起态：只显示最新一行可折叠活动（替换），并保留不进折叠的过程正文。
   * 展开整轮折叠后由渲染层改用完整 activities。
   */
  visibleActivities: AgentActivityItem[]
  finalItems: AgentPersistentItem[]
  finalAnswerStarted: boolean
  hasRenderableActivity: boolean
  cancellation: 'none' | 'user' | 'error'
  collapsePolicy: {
    collapsible: boolean
    defaultExpanded: boolean
    blockedReason?: AgentAutoCollapseBlockReason
  }
}

export function collectThinkingContent(
  blocks: SDKContentBlock[],
): string {
  return blocks
    .filter((block): block is SDKThinkingBlock => block.type === 'thinking')
    .map((block) => block.thinking ?? '')
    .filter((content) => content.trim().length > 0)
    .join('\n')
}

interface BuildAgentTurnPresentationInput {
  id: string
  turn: AssistantTurn
  blocks: SDKContentBlock[]
  isStreaming?: boolean
  runningDurationMs?: number
  stoppedByUser?: boolean
  fullTranscript?: boolean
  hasRunningSubagent?: boolean
  /** 已经返回工具结果、但对应后台子智能体仍在执行的工具调用。 */
  runningActivityToolIds?: ReadonlySet<string>
  /**
   * Runtime 明确标记为过程输出的 block 索引。
   *
   * 典型场景是 assistant message 的 stop_reason=tool_use，但消息内容只有一段
   * 顶层 text。它是下一次工具调用前的过程说明，不能在短暂等待工具事件时被误判为
   * 最终回答，否则流式界面会把整轮历史活动一次性铺开。
   */
  forcedActivityIndexes?: ReadonlySet<number>
  hasErrorOrBlockingItem?: boolean
}

function getCompletedToolResultIds(messages: SDKMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    const blocks = (message as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type === 'tool_result') ids.add((block as SDKToolResultBlock).tool_use_id)
    }
  }
  return ids
}

function areToolsBeforeCompleted(
  blocks: SDKContentBlock[],
  endIndex: number,
  completedIds: Set<string>,
): boolean {
  for (let index = 0; index < endIndex; index += 1) {
    const block = blocks[index]
    if (block?.type !== 'tool_use') continue
    if (!completedIds.has((block as SDKToolUseBlock).id)) return false
  }
  return true
}

function isVisibleText(block: SDKContentBlock | undefined): block is SDKTextBlock {
  return block?.type === 'text'
    && typeof (block as SDKTextBlock).text === 'string'
    && (block as SDKTextBlock).text.trim().length > 0
}

function normalizeAnswerText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function extractResultAnswer(turnMessages: SDKMessage[]): string | undefined {
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index]
    if (message?.type !== 'result') continue
    const result = (message as Record<string, unknown>).result
    if (typeof result === 'string' && result.trim()) return normalizeAnswerText(result)
  }
  return undefined
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function inferProjectedToolUse(
  toolUseId: string,
  structuredResult: Record<string, unknown> | undefined,
): SDKToolUseBlock {
  const file = readRecord(structuredResult?.file)
  if (typeof file?.filePath === 'string') {
    const startLine = typeof file.startLine === 'number'
      ? file.startLine + 1
      : undefined
    const input: Record<string, unknown> = {
      file_path: file.filePath,
    }
    if (startLine !== undefined) input.offset = startLine
    if (typeof file.numLines === 'number') input.limit = file.numLines
    return { type: 'tool_use', id: toolUseId, name: 'Read', input }
  }

  if (
    typeof structuredResult?.filePath === 'string'
    && (
      'structuredPatch' in (structuredResult ?? {})
      || 'oldString' in (structuredResult ?? {})
      || 'newString' in (structuredResult ?? {})
      || 'originalFile' in (structuredResult ?? {})
    )
  ) {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'Edit',
      input: {
        file_path: structuredResult.filePath,
        ...(typeof structuredResult.oldString === 'string'
          ? { old_string: structuredResult.oldString }
          : {}),
        ...(typeof structuredResult.newString === 'string'
          ? { new_string: structuredResult.newString }
          : {}),
      },
    }
  }

  if (
    typeof structuredResult?.stdout === 'string'
    || typeof structuredResult?.stderr === 'string'
  ) {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'Bash',
      input: {},
    }
  }

  if (
    typeof structuredResult?.query === 'string'
    && Array.isArray(structuredResult.results)
  ) {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'WebSearch',
      input: { query: structuredResult.query },
    }
  }

  if (typeof structuredResult?.url === 'string') {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'WebFetch',
      input: { url: structuredResult.url },
    }
  }

  if (Array.isArray(structuredResult?.filenames)) {
    const mode = structuredResult.mode
    return {
      type: 'tool_use',
      id: toolUseId,
      name: mode === 'content' || typeof structuredResult.content === 'string'
        ? 'Grep'
        : 'Glob',
      input: {},
    }
  }

  if (
    typeof structuredResult?.agentId === 'string'
    || typeof structuredResult?.prompt === 'string'
  ) {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'Agent',
      input: {
        ...(typeof structuredResult.description === 'string'
          ? { description: structuredResult.description }
          : {}),
        ...(typeof structuredResult.prompt === 'string'
          ? { prompt: structuredResult.prompt }
          : {}),
      },
    }
  }

  if (readRecord(structuredResult?.task)) {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'TaskGet',
      input: {},
    }
  }

  if (typeof structuredResult?.commandName === 'string') {
    return {
      type: 'tool_use',
      id: toolUseId,
      name: 'Skill',
      input: { skill: structuredResult.commandName },
    }
  }

  return {
    type: 'tool_use',
    id: toolUseId,
    name: 'Tool',
    input: {},
  }
}

function inferProjectedToolUseFromContent(
  toolUseId: string,
  contentText: string,
): SDKToolUseBlock | undefined {
  if (!contentText.trim()) return undefined
  if (/^Found\s+\d+\s+files?\b/i.test(contentText)) {
    return { type: 'tool_use', id: toolUseId, name: 'Glob', input: {} }
  }
  if (/^total\s+\d+\b/m.test(contentText) || /^[d\-][rwx\-]{9}\b/m.test(contentText)) {
    return { type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }
  }
  if (/^\d+\t/.test(contentText)) {
    return { type: 'tool_use', id: toolUseId, name: 'Read', input: {} }
  }
  const nonEmpty = contentText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    nonEmpty.length > 0
    && nonEmpty.every((line) => line.includes('/') || line.includes('\\'))
  ) {
    return { type: 'tool_use', id: toolUseId, name: 'Glob', input: {} }
  }
  return undefined
}

function readToolResultContentText(block: SDKToolResultBlock): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return block.content
    .map((item) => {
      const record = readRecord(item)
      return typeof record?.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 部分 CCB Provider 只在 user(tool_result) 中返回工具结果，没有同步对应的
 * assistant(tool_use)。展示层按结构化结果补一个只读活动投影，保证主会话和
 * 子智能体完整记录在结束后仍能查看真实执行过程；不修改 JSONL wire shape。
 */
export function projectMissingToolUseActivities(
  turn: AssistantTurn,
  blocks: SDKContentBlock[],
  forcedActivityIndexes: ReadonlySet<number> = new Set(),
): {
  blocks: SDKContentBlock[]
  forcedActivityIndexes: Set<number>
} {
  const knownToolUseIds = new Set(
    blocks
      .filter((block): block is SDKToolUseBlock => block.type === 'tool_use')
      .map((block) => block.id),
  )
  const projected: SDKToolUseBlock[] = []

  for (const message of turn.turnMessages) {
    if (message.type !== 'user') continue
    const userMessage = message as SDKUserMessage
    if (userMessage.parent_tool_use_id) continue
    const content = userMessage.message?.content
    if (!Array.isArray(content)) continue
    const raw = userMessage as unknown as Record<string, unknown>
    const structuredResult = readRecord(
      raw.toolUseResult ?? raw.tool_use_result,
    )

    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const resultBlock = block as SDKToolResultBlock
      const toolUseId = resultBlock.tool_use_id
      if (!toolUseId || knownToolUseIds.has(toolUseId)) continue
      knownToolUseIds.add(toolUseId)
      const contentText = readToolResultContentText(resultBlock)
      const fromContent = !structuredResult
        ? inferProjectedToolUseFromContent(toolUseId, contentText)
        : undefined
      projected.push(
        fromContent ?? inferProjectedToolUse(toolUseId, structuredResult),
      )
    }
  }

  if (projected.length === 0) {
    return {
      blocks,
      forcedActivityIndexes: new Set(forcedActivityIndexes),
    }
  }

  const resultAnswer = extractResultAnswer(turn.turnMessages)
  const finalAnswerIndex = resultAnswer
    ? blocks.findIndex(
        (block) =>
          isVisibleText(block)
          && normalizeAnswerText(block.text) === resultAnswer,
      )
    : -1
  const insertionIndex = finalAnswerIndex >= 0
    ? finalAnswerIndex
    : blocks.length
  const nextForcedIndexes = new Set<number>()
  for (const index of forcedActivityIndexes) {
    nextForcedIndexes.add(
      index >= insertionIndex ? index + projected.length : index,
    )
  }

  return {
    blocks: [
      ...blocks.slice(0, insertionIndex),
      ...projected,
      ...blocks.slice(insertionIndex),
    ],
    forcedActivityIndexes: nextForcedIndexes,
  }
}

function getAssistantMessageId(message: SDKAssistantMessage): string | undefined {
  const innerMessage = message.message as unknown as Record<string, unknown> | undefined
  return typeof innerMessage?.id === 'string' ? innerMessage.id : undefined
}

function getAssistantSnapshotBlocks(message: SDKAssistantMessage): SDKContentBlock[] {
  const blocks = message.message?.content
  return Array.isArray(blocks) ? blocks : []
}

function getAssistantSnapshotText(message: SDKAssistantMessage): string {
  return getAssistantSnapshotBlocks(message)
    .filter((block): block is SDKTextBlock =>
      block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('')
}

function getAssistantSnapshotBlockIndexes(message: SDKAssistantMessage): number[] {
  const record = message as unknown as Record<string, unknown>
  const indexes: number[] = []
  if (typeof record._partialBlockIndex === 'number') {
    indexes.push(record._partialBlockIndex)
  }
  if (Array.isArray(record._partialBlockIndexes)) {
    for (const value of record._partialBlockIndexes) {
      if (typeof value === 'number' && Number.isInteger(value)) indexes.push(value)
    }
  }
  return [...new Set(indexes)]
}

function isPausedAssistantSnapshot(message: SDKAssistantMessage): boolean {
  return (message as unknown as Record<string, unknown>)._promaPausedByUser === true
}

function isPartialAssistantSnapshot(message: SDKAssistantMessage): boolean {
  return (message as unknown as Record<string, unknown>)._partial === true
}

function snapshotHasSameLogicalBlock(
  left: SDKAssistantMessage,
  right: SDKAssistantMessage,
): boolean {
  const leftIndexes = getAssistantSnapshotBlockIndexes(left)
  const rightIndexes = getAssistantSnapshotBlockIndexes(right)
  if (leftIndexes.length > 0 && rightIndexes.length > 0) {
    return leftIndexes.some((index) => rightIndexes.includes(index))
  }

  const leftBlocks = getAssistantSnapshotBlocks(left)
  const rightBlocks = getAssistantSnapshotBlocks(right)
  if (leftBlocks.length === 0 || rightBlocks.length === 0) return false
  if (leftBlocks.some((leftBlock) =>
    rightBlocks.some((rightBlock) =>
      leftBlock.type === rightBlock.type
      && (
        leftBlock.type === 'text'
          ? leftBlock.text === (rightBlock as SDKTextBlock).text
          : leftBlock.type === 'thinking'
            ? leftBlock.thinking === (rightBlock as SDKThinkingBlock).thinking
            : leftBlock.type === 'tool_use'
              && leftBlock.id === (rightBlock as SDKToolUseBlock).id
      ),
    ),
  )) {
    return true
  }

  const leftText = getAssistantSnapshotText(left)
  const rightText = getAssistantSnapshotText(right)
  return leftText.trim().length > 0
    && rightText.trim().length > 0
    && (leftText.includes(rightText) || rightText.includes(leftText))
}

function isMoreCompleteAssistantSnapshot(
  candidate: SDKAssistantMessage,
  existing: SDKAssistantMessage,
): boolean {
  const candidatePartial = isPartialAssistantSnapshot(candidate)
  const existingPartial = isPartialAssistantSnapshot(existing)
  if (candidatePartial !== existingPartial) return !candidatePartial

  const candidateTextLength = getAssistantSnapshotText(candidate).length
  const existingTextLength = getAssistantSnapshotText(existing).length
  if (candidateTextLength !== existingTextLength) {
    return candidateTextLength > existingTextLength
  }

  const candidateBlockCount = getAssistantSnapshotBlocks(candidate).length
  const existingBlockCount = getAssistantSnapshotBlocks(existing).length
  return candidateBlockCount > existingBlockCount
}

/**
 * 流式期间同一轮可能同时存在：
 * - CCB 按 block index 发送的 partial 快照；
 * - Runtime 最终快照；
 * - 立即发送时冻结下来的旧回合快照。
 *
 * 这些消息在 JSONL 最终刷新前会一起进入同一个 assistant turn。这里是最终
 * 的渲染层防线：同一逻辑 block 只保留最完整的一份，避免旧正文在“运行中”
 * 被拼接两次，而结束后刷新历史时又看起来正常。
 */
export function dedupeAssistantSnapshotsForPresentation(
  messages: SDKAssistantMessage[],
  options?: {
    /** 用户立即发送后，旧 turn 已进入 interrupted 状态，允许跨身份去掉快照重复。 */
    allowCrossIdentityTextSnapshots?: boolean
  },
): SDKAssistantMessage[] {
  const result: SDKAssistantMessage[] = []

  for (const message of messages) {
    const messageId = getAssistantMessageId(message)
    let duplicateIndex = -1

    for (let index = 0; index < result.length; index += 1) {
      const existing = result[index]!
      const existingMessageId = getAssistantMessageId(existing)
      const sameMessageId = messageId != null
        && existingMessageId != null
        && messageId === existingMessageId
      const bothPaused = isPausedAssistantSnapshot(message)
        && isPausedAssistantSnapshot(existing)
      const comparableSnapshot = sameMessageId || bothPaused
      if (!comparableSnapshot || !snapshotHasSameLogicalBlock(existing, message)) {
        continue
      }

      duplicateIndex = index
      break
    }

    if (duplicateIndex < 0) {
      // 兼容没有 message.id 的旧 Runtime：只有明确带 partial/暂停标记，
      // 且正文完全相同或互相包含时才去重，避免误删模型正常重复的句子。
      const messageText = getAssistantSnapshotText(message)
      if (
        messageText.trim().length > 0
        && (isPartialAssistantSnapshot(message) || isPausedAssistantSnapshot(message))
      ) {
        duplicateIndex = result.findIndex((existing) => {
          const existingText = getAssistantSnapshotText(existing)
          if (existingText.trim().length === 0) return false
          if (
            !isPartialAssistantSnapshot(existing)
            && !isPausedAssistantSnapshot(existing)
          ) {
            return false
          }
          return existingText.includes(messageText) || messageText.includes(existingText)
        })
      }
    }

    if (
      duplicateIndex < 0
      && options?.allowCrossIdentityTextSnapshots
    ) {
      const messageText = getAssistantSnapshotText(message)
      if (messageText.trim().length > 0) {
        duplicateIndex = result.findIndex((existing) => {
          const existingText = getAssistantSnapshotText(existing)
          return existingText.trim().length > 0
            && (
              existingText.includes(messageText)
              || messageText.includes(existingText)
            )
        })
      }
    }

    if (duplicateIndex < 0) {
      result.push(message)
    } else if (isMoreCompleteAssistantSnapshot(message, result[duplicateIndex]!)) {
      result[duplicateIndex] = message
    }
  }

  return result
}

function assistantMessageContainsAnswer(
  message: SDKAssistantMessage,
  answer: string,
): boolean {
  const blocks = message.message?.content
  if (!Array.isArray(blocks)) return false
  return blocks.some((block) =>
    isVisibleText(block) && normalizeAnswerText(block.text) === answer,
  )
}

/**
 * CCB Transcript 同步可能在相同 `_createdAt` 下先写入最终 assistant 快照，
 * 再写入本轮工具活动。Renderer 不能直接照文件顺序展示，否则最终正文会被误判为
 * 过程说明。通过 result.result 找到最终 assistant message，并稳定移动到活动尾部。
 */
export function orderAssistantMessagesForPresentation(
  turn: AssistantTurn,
): SDKAssistantMessage[] {
  const resultAnswer = extractResultAnswer(turn.turnMessages)
  const assistantMessages = dedupeAssistantSnapshotsForPresentation(
    turn.assistantMessages,
    {
      allowCrossIdentityTextSnapshots: isTurnStoppedByUser(turn.turnMessages),
    },
  )
  if (!resultAnswer) return assistantMessages

  const finalMessageIds = new Set(
    assistantMessages
      .filter((message) => assistantMessageContainsAnswer(message, resultAnswer))
      .map(getAssistantMessageId)
      .filter((id): id is string => Boolean(id)),
  )
  if (finalMessageIds.size === 0) return assistantMessages

  const activities: SDKAssistantMessage[] = []
  const finalMessages: SDKAssistantMessage[] = []
  for (const message of assistantMessages) {
    const messageId = getAssistantMessageId(message)
    if (messageId && finalMessageIds.has(messageId)) {
      finalMessages.push(message)
    } else {
      activities.push(message)
    }
  }
  return [...activities, ...finalMessages]
}

function isPersistentBlock(block: SDKContentBlock): boolean {
  return (
    block.type === 'tool_use'
    && (block as SDKToolUseBlock).name === 'ExitPlanMode'
  ) || block.type === 'proposed-plan'
    || block.type === 'proposed_plan'
    || block.type === 'plan'
    || block.type === 'image'
    || block.type === 'resource'
    || block.type === 'file'
}

function isTodoTool(block: SDKContentBlock): boolean {
  if (block.type !== 'tool_use') return false
  return /^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|update_plan)$/i
    .test((block as SDKToolUseBlock).name)
}

function isWaitOnlyTool(block: SDKContentBlock): boolean {
  if (block.type !== 'tool_use') return false
  return /(^|__)(wait|wait_for_delegations)$/i.test((block as SDKToolUseBlock).name)
}

function isInterruptedResultMessage(message: SDKMessage): boolean {
  const raw = message as Record<string, unknown>
  if (raw._promaPausedByUser === true) return true
  if (message.type !== 'result') return false
  if (raw._stoppedByUser === true) return true
  return (message as { subtype?: string }).subtype === 'interrupted'
}

/** 从 turn 消息本身判断是否用户中断，避免续聊清除 session 级 stoppedByUser 后历史轮次变成「已完成」。 */
export function isTurnStoppedByUser(turnMessages: SDKMessage[]): boolean {
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index]
    if (message && isInterruptedResultMessage(message)) return true
  }
  return false
}

function estimateTurnDurationFromTimestamps(turnMessages: SDKMessage[]): number | undefined {
  let firstTs: number | undefined
  let lastTs: number | undefined
  for (const message of turnMessages) {
    const raw = message as Record<string, unknown>
    const ts = typeof raw._createdAt === 'number' ? raw._createdAt : undefined
    if (ts == null) continue
    if (firstTs == null || ts < firstTs) firstTs = ts
    if (lastTs == null || ts > lastTs) lastTs = ts
  }
  if (firstTs != null && lastTs != null && lastTs >= firstTs) {
    return lastTs - firstTs
  }
  return undefined
}

function extractTurnUsage(turnMessages: SDKMessage[]): {
  durationMs?: number
  usage?: AgentEventUsage
} {
  // 首选 result 消息中的 _durationMs（正常完成 / 用户中断落盘时回传）
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index]
    if (message?.type !== 'result') continue
    const result = message as SDKResultMessage
    const raw = message as Record<string, unknown>
    const usage = result.usage
    const durationFromResult = typeof raw._durationMs === 'number' ? raw._durationMs : undefined
    return {
      durationMs: durationFromResult ?? estimateTurnDurationFromTimestamps(turnMessages),
      usage: usage
        ? {
            inputTokens: usage.input_tokens
              + (usage.cache_read_input_tokens ?? 0)
              + (usage.cache_creation_input_tokens ?? 0),
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheCreationTokens: usage.cache_creation_input_tokens,
            costUsd: result.total_cost_usd,
            contextWindow: pickRuntimeReportedContextWindow(result.modelUsage),
          }
        : undefined,
    }
  }

  // 没有 result 消息（用户中断时 SDK 被 abort）：用 turn 内消息的 _createdAt 时间戳
  // 计算实际执行耗时，确保"你在 N 秒后停止了"能正确显示（规则文档第 8 节、英文文案 You stopped after {time}）。
  const estimated = estimateTurnDurationFromTimestamps(turnMessages)
  return estimated == null ? {} : { durationMs: estimated }
}

function isRenderableActivity(item: AgentActivityItem): boolean {
  return item.block.type === 'thinking'
    || item.block.type === 'tool_use'
    || isVisibleText(item.block)
}

function isFoldableActivityBlock(block: SDKContentBlock): boolean {
  // 思考与工具进入整轮折叠；过程正文固定外露，不进折叠
  return block.type === 'thinking' || block.type === 'tool_use'
}

function isProcessTextActivity(
  item: Pick<AgentActivityItem, 'block' | 'foldable'>,
): boolean {
  return item.block.type === 'text'
    && !item.foldable
    && isVisibleText(item.block)
}

/**
 * 当前工具波次中、排在 current 之前的工具（用于「最新工具 + 折叠看历史」）。
 * 波次从最近一次 thinking 之后开始；过程正文不切断工具波次。
 */
export function collectPriorToolActivities(
  activities: AgentActivityItem[],
  current: AgentActivityItem,
): AgentActivityItem[] {
  const currentPos = activities.findIndex((item) => (
    item.index === current.index && item.block.type === 'tool_use'
  ))
  if (currentPos <= 0) return []

  let waveStart = 0
  for (let index = currentPos - 1; index >= 0; index -= 1) {
    if (activities[index]?.block.type === 'thinking') {
      waveStart = index + 1
      break
    }
  }

  return activities
    .slice(waveStart, currentPos)
    .filter((item) => item.block.type === 'tool_use')
}

/**
 * 思考折叠内的历史：仅 foldable（思考+工具），不含过程正文。
 */
export function collectPriorFoldableActivities(
  activities: AgentActivityItem[],
  current: AgentActivityItem,
): AgentActivityItem[] {
  // 合成「正在思考」占位：回看整轮可折叠历史（思考+工具）
  if (current.index < 0) {
    return activities.filter((item) => item.foldable)
  }

  const currentPos = activities.findIndex((item) => (
    item.index === current.index && item.block.type === current.block.type
  ))
  if (currentPos < 0) {
    return activities.filter((item) => (
      item.foldable && item.index !== current.index
    ))
  }

  return activities
    .slice(0, currentPos)
    .filter((item) => item.foldable)
}

function markRunningActivity(
  activities: Array<Omit<AgentActivityItem, 'running'>>,
  isStreaming: boolean | undefined,
  finalAnswerStarted: boolean,
  completedToolIds: ReadonlySet<string>,
  runningActivityToolIds: ReadonlySet<string> = new Set(),
): AgentActivityItem[] {
  if (!isStreaming) {
    return activities.map((item) => ({ ...item, running: false }))
  }

  let runningIndex = -1
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const item = activities[index]
    if (item?.block.type !== 'tool_use') continue
    const toolUseId = (item.block as SDKToolUseBlock).id
    if (
      !completedToolIds.has(toolUseId)
      || runningActivityToolIds.has(toolUseId)
    ) {
      runningIndex = index
      break
    }
  }
  if (runningIndex < 0 && !finalAnswerStarted) {
    const latest = activities.at(-1)
    // 最新是过程正文：running 落在过程正文，不要回标更早 thinking，
    // 否则表面已用过程正文替换「正在思考」后，thinking 仍带 running 态。
    if (latest && isProcessTextActivity(latest)) {
      runningIndex = activities.length - 1
    } else {
      // 无未完成工具时：优先落在思考上（进入新的「正在思考」阶段）
      // 不要把已完成工具标成 running，否则收起态会停在「已读取」而回不到思考
      runningIndex = activities.findLastIndex((item) => item.block.type === 'thinking')
      if (runningIndex < 0) {
        runningIndex = activities.findLastIndex((item) =>
          item.block.type === 'text' && isVisibleText(item.block),
        )
      }
    }
  }

  return activities.map((item, index) => ({
    ...item,
    running: index === runningIndex,
  }))
}

/** 流式尚无 thinking 块时的占位活动：保证开局也能看到「正在思考」 */
export function createSyntheticThinkingActivity(): AgentActivityItem {
  return {
    block: { type: 'thinking', thinking: '' } as SDKThinkingBlock,
    index: -1,
    foldable: true,
    running: true,
  }
}

/**
 * 收起态（运行中 / 用户停止）展示策略：
 * 1) 过程正文：始终固定露出、按出现顺序换行追加，绝不 latest-only 顶替旧正文
 * 2) 有过程正文时：先替换掉「正在思考」并固定显示正文，再在下方新增一行「正在思考」
 *    表面顺序永远是：全部过程正文（按序）→ 当前阶段行（工具或正在思考）
 * 3) 阶段行只保留当前一条：运行中工具优先；否则最新思考；过程正文为最新时合成新的正在思考
 * 4) 最终回答已开始：流式/暂停仍固定保留全部过程正文；阶段行让位给最终正文
 * 5) 用户停止且无任何真实活动 → 不伪造「正在思考」
 */
function resolveCollapsedPhaseActivity(
  activities: AgentActivityItem[],
  live: boolean,
): AgentActivityItem | null {
  if (activities.length === 0) {
    return live ? createSyntheticThinkingActivity() : null
  }

  if (live) {
    const runningTool = activities.findLast(
      (item) => item.running && item.block.type === 'tool_use',
    )
    if (runningTool) return runningTool

    const latest = activities.at(-1)
    // 最新是过程正文：正文已替换旧思考并固定；运行中在下方新增一行空的「正在思考」
    if (latest && isProcessTextActivity(latest)) {
      return createSyntheticThinkingActivity()
    }

    // 最新就是思考：用这一条作为表面阶段行（在全部过程正文之后）
    if (latest?.block.type === 'thinking') {
      return { ...latest, running: true }
    }

    const latestThinking = activities.findLast((item) => item.block.type === 'thinking')
    if (latestThinking) return { ...latestThinking, running: true }

    // 工具已结束、尚未有新 thinking：合成「正在思考」
    if (activities.some((item) => item.block.type === 'tool_use')) {
      return createSyntheticThinkingActivity()
    }
    return createSyntheticThinkingActivity()
  }

  // 停止收起：最新 foldable 一行；最新是过程正文则只留过程正文（不再伪造思考）
  const latest = activities.at(-1)
  if (!latest || isProcessTextActivity(latest)) return null
  if (latest.foldable) return { ...latest, running: false }
  return null
}

/**
 * 过程正文全部在前（固定追加）+ 阶段行永远在最后。
 * 这样保证：内容先替换思考并固定显示，再新增一行「正在思考/工具」。
 * 不要把历史 thinking 插回正文前面，否则会出现「思考在上、正文在下」的错序。
 */
function mergeProcessTextsWithPhase(
  activities: AgentActivityItem[],
  phase: AgentActivityItem | null,
): AgentActivityItem[] {
  const processTexts = activities.filter(isProcessTextActivity)
  if (!phase) return processTexts
  return [...processTexts, phase]
}

export function resolveVisibleTurnActivities(
  activities: AgentActivityItem[],
  input: {
    isStreaming?: boolean
    fullTranscript?: boolean
    finalAnswerStarted?: boolean
    /** 用户停止后收起态也走同一套「当前阶段一行」逻辑 */
    collapsedSurface?: boolean
  },
): AgentActivityItem[] {
  if (input.fullTranscript) {
    return activities
  }

  // 非收起表面且非流式：返回完整轨迹（历史展开用）
  if (!input.isStreaming && !input.collapsedSurface) {
    return activities
  }

  const live = Boolean(input.isStreaming)
  const processTexts = activities.filter(isProcessTextActivity)

  // 最终回答已开始：
  // - 正常完成（非本函数收起路径）不走这里
  // - 流式中 / 用户暂停：过程正文仍固定全部露出（追加不隐藏、暂停不消失）
  // - 阶段行（思考/工具）让位给最终正文区，避免和最终回答抢表面
  if (input.finalAnswerStarted) {
    return processTexts
  }

  if (activities.length === 0) {
    // 仅流式开局需要占位；停止且无内容时不要伪造「正在思考」行
    return live ? [createSyntheticThinkingActivity()] : []
  }

  const phase = resolveCollapsedPhaseActivity(activities, live)
  const merged = mergeProcessTextsWithPhase(activities, phase)
  if (merged.length === 0 && live) {
    return [createSyntheticThinkingActivity()]
  }
  return merged
}

/**
 * 合并同一 Turn 内连续的 thinking block，避免「已完成思考」重复显示多次。
 *
 * 规则要求一个 Turn 只有一个思考项，后续 thinking delta 应追加到同一思考项中。
 * 合并会压缩 block 下标，必须同步重映射 forcedActivityIndexes，否则过程正文会丢标记，
 * 暂停时被误提升为最终回答而从活动表面消失。
 */
function mergeAdjacentThinkingBlocks(
  blocks: SDKContentBlock[],
  forcedActivityIndexes: ReadonlySet<number> = new Set(),
): {
  blocks: SDKContentBlock[]
  forcedActivityIndexes: Set<number>
} {
  const merged: SDKContentBlock[] = []
  const nextForcedIndexes = new Set<number>()
  let currentThinkingIndex = -1

  blocks.forEach((block, originalIndex) => {
    const wasForced = forcedActivityIndexes.has(originalIndex)
    if (block.type === 'thinking') {
      const thinking = block as SDKThinkingBlock
      // 空思考不占位；跳过时不要把 forced 挂到错误下标
      if (!thinking.thinking?.trim()) return
      if (currentThinkingIndex >= 0) {
        // 追加到已有思考项
        const existing = merged[currentThinkingIndex] as SDKThinkingBlock
        merged[currentThinkingIndex] = {
          ...existing,
          thinking: existing.thinking + '\n' + thinking.thinking,
        }
        if (wasForced) nextForcedIndexes.add(currentThinkingIndex)
      } else {
        // 新建思考项
        currentThinkingIndex = merged.length
        merged.push({ ...thinking })
        if (wasForced) nextForcedIndexes.add(currentThinkingIndex)
      }
      return
    }

    currentThinkingIndex = -1
    if (wasForced) nextForcedIndexes.add(merged.length)
    merged.push(block)
  })

  return {
    blocks: merged,
    forcedActivityIndexes: nextForcedIndexes,
  }
}

export function buildAgentTurnPresentation(
  input: BuildAgentTurnPresentationInput,
): AgentTurnPresentation {
  const projected = projectMissingToolUseActivities(
    input.turn,
    input.blocks,
    input.forcedActivityIndexes,
  )
  const mergedBlocks = mergeAdjacentThinkingBlocks(
    projected.blocks,
    projected.forcedActivityIndexes,
  )
  const blocks = mergedBlocks.blocks
  const thinkingContent = collectThinkingContent(blocks)
  const completedToolIds = getCompletedToolResultIds(input.turn.turnMessages)
  const forcedActivityIndexes = mergedBlocks.forcedActivityIndexes
  // 提前判定用户停止：后续分类不能把过程正文因 !isStreaming 提升为最终回答
  const stoppedByUserEarly = Boolean(input.stoppedByUser)
    || isTurnStoppedByUser(input.turn.turnMessages)
  const resultAnswer = extractResultAnswer(input.turn.turnMessages)
  const resultAnswerIndexes = new Set<number>()
  if (resultAnswer) {
    blocks.forEach((block, index) => {
      if (
        isVisibleText(block)
        && normalizeAnswerText(block.text) === resultAnswer
      ) {
        resultAnswerIndexes.add(index)
      }
    })
  }
  const lastActivityIndex = blocks.findLastIndex((block, index) =>
    block.type === 'tool_use'
    || block.type === 'thinking'
    || forcedActivityIndexes.has(index),
  )
  let finalTextStart = -1
  if (resultAnswerIndexes.size > 0) {
    finalTextStart = Math.min(...resultAnswerIndexes)
  } else if (lastActivityIndex < 0) {
    // 整轮只有正文：用户停止也按最终/半成品正文处理（没有活动可穿插）
    finalTextStart = blocks.findIndex(
      (block, index) => !forcedActivityIndexes.has(index) && isVisibleText(block),
    )
  } else {
    const candidate = blocks.findIndex(
      (block, index) =>
        index > lastActivityIndex
        && !forcedActivityIndexes.has(index)
        && isVisibleText(block),
    )
    if (
      candidate >= 0
      // 用户暂停：绝不能因 isStreaming 变 false 把活动区内过程/半成品正文提升为 final，
      // 否则 visibleActivities 丢掉多条过程正文，暂停后只剩状态行。
      && !stoppedByUserEarly
      && (
        !input.isStreaming
        || areToolsBeforeCompleted(blocks, candidate, completedToolIds)
      )
    ) {
      finalTextStart = candidate
    }
  }

  const rawActivities: Array<Omit<AgentActivityItem, 'running'>> = []
  const finalItems: AgentPersistentItem[] = []
  const exitPlanIndex = blocks.findIndex((block) =>
    block.type === 'tool_use'
    && (block as SDKToolUseBlock).name === 'ExitPlanMode',
  )
  let fallbackPlanStart = -1
  if (exitPlanIndex > 0) {
    for (let index = exitPlanIndex - 1; index >= 0; index -= 1) {
      if (!isVisibleText(blocks[index])) break
      fallbackPlanStart = index
    }
  }
  blocks.forEach((block, index) => {
    if (isTodoTool(block) || isWaitOnlyTool(block)) return
    if (isPersistentBlock(block)) {
      finalItems.push({
        block,
        index,
        kind: block.type.includes('plan') ? 'plan' : 'persistent',
      })
      return
    }
    if (fallbackPlanStart >= 0 && index >= fallbackPlanStart && index < exitPlanIndex && block.type === 'text') {
      finalItems.push({ block, index, kind: 'plan' })
      return
    }
    if (
      (resultAnswerIndexes.size > 0 && resultAnswerIndexes.has(index))
      || (
        resultAnswerIndexes.size === 0
        && !forcedActivityIndexes.has(index)
        && finalTextStart >= 0
        && index >= finalTextStart
        && block.type === 'text'
      )
    ) {
      finalItems.push({ block, index, kind: 'answer' })
      return
    }
    rawActivities.push({
      block,
      index,
      foldable: isFoldableActivityBlock(block),
    })
  })

  // 当 result.result 存在但没有任何 assistant text block 与之匹配时
  //（例如 CCB 持久化只保存了带 tool_use 的 assistant 消息，最终回答只出现在 result 消息中），
  // 需要把 result.result 合成为一个虚拟 text block 注入 finalItems，否则正文会丢失。
  if (
    resultAnswer
    && resultAnswerIndexes.size === 0
    && finalTextStart < 0
    && !finalItems.some((item) => item.kind === 'answer')
  ) {
    finalItems.push({
      block: { type: 'text', text: resultAnswer } as SDKTextBlock,
      index: -1,
      kind: 'answer',
    })
  }

  const finalAnswerStarted = finalItems.some((item) =>
    item.kind !== 'answer' || isVisibleText(item.block),
  )
  const activities = markRunningActivity(
    rawActivities,
    input.isStreaming,
    finalAnswerStarted,
    completedToolIds,
    input.runningActivityToolIds,
  )
  const hasRenderableActivity = activities.some((item) =>
    item.block.type === 'thinking'
    || item.block.type === 'tool_use'
    || isVisibleText(item.block),
  )
  const hasError = input.turn.assistantMessages.some((message) => !!message.error)
  // prop 与 result(interrupted/_stoppedByUser) 双通道：续聊后 session 级 stopped 会被清掉，
  // 但历史轮次仍应保留「你在 N 秒后停止了」，不能退化成「已完成」。
  const stoppedByUser = stoppedByUserEarly
  const cancellation = stoppedByUser
    ? 'user'
    : hasError
      ? 'error'
      : 'none'
  const collapsePolicy = resolveAgentTurnCollapsePolicy({
    finalAnswerStarted,
    cancellation,
    hasRenderableActivity,
    hasRunningSubagent: input.hasRunningSubagent,
    hasErrorOrBlockingItem: input.hasErrorOrBlockingItem || hasError,
    fullTranscript: input.fullTranscript,
  })
  const { durationMs: resultDurationMs, usage } = extractTurnUsage(input.turn.turnMessages)
  const durationMs = input.isStreaming
    ? input.runningDurationMs ?? resultDurationMs
    : resultDurationMs ?? input.runningDurationMs
  const visibleActivities = resolveVisibleTurnActivities(activities, {
    isStreaming: input.isStreaming,
    fullTranscript: input.fullTranscript,
    finalAnswerStarted,
    // 停止轮收起态与运行中一致：只显示最新一行
    collapsedSurface: stoppedByUser,
  })

  return {
    id: input.id,
    model: input.turn.model,
    durationMs,
    usage,
    status: stoppedByUser
      ? 'stopped'
      : hasError
        ? 'failed'
        : finalAnswerStarted
          ? 'completed'
          : input.isStreaming
            ? resolveRunningTurnStatus(
                activities.map((item) => item.block),
                completedToolIds,
              )
            : 'activity-completed',
    thinkingContent,
    activities,
    visibleActivities,
    finalItems,
    finalAnswerStarted,
    hasRenderableActivity,
    cancellation,
    collapsePolicy,
  }
}
