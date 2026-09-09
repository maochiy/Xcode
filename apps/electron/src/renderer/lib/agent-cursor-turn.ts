import {
  pickRuntimeReportedContextWindow,
  type AgentEventUsage,
  type SDKContentBlock,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKToolResultBlock,
  type SDKToolUseBlock,
  type SDKUserMessage,
} from '@proma/shared'
import type { AssistantTurn } from '@proma/session-core'
import type {
  AgentActivityItem,
  AgentPersistentItem,
} from './agent-turn-presentation'

export interface BuildCursorTurnPresentationInput {
  id: string
  turn: AssistantTurn
  allMessages?: readonly SDKMessage[]
  blocks: SDKContentBlock[]
  isStreaming?: boolean
  runningDurationMs?: number
  stoppedByUser?: boolean
  hasRunningSubagent?: boolean
  runningActivityToolIds?: ReadonlySet<string>
  forcedActivityIndexes?: ReadonlySet<number>
  hasErrorOrBlockingItem?: boolean
  /** 权限、AskUser、ExitPlan、压缩等专用状态正在展示时，不叠加通用等待反馈。 */
  suppressWaitingFeedback?: boolean
}

export interface CursorTurnPresentation {
  id: string
  model?: string
  durationMs?: number
  usage?: AgentEventUsage
  status: 'running' | 'completed' | 'stopped' | 'failed'
  activities: AgentActivityItem[]
  finalItems: AgentPersistentItem[]
  showThinkingPlaceholder: boolean
  showWaitingPlaceholder: boolean
}

interface IndexedBlock {
  block: SDKContentBlock
  index: number
}

const TASK_PROGRESS_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

function isTaskProgressTool(block: SDKContentBlock): boolean {
  return block.type === 'tool_use'
    && TASK_PROGRESS_TOOLS.has((block as SDKToolUseBlock).name)
}

function isPlanBlock(block: SDKContentBlock): boolean {
  const normalizedType = block.type.toLowerCase().replaceAll('-', '_')
  return normalizedType === 'plan'
    || normalizedType === 'proposed_plan'
    || normalizedType === 'plan_proposal'
}

function isInterruptedResultMessage(message: SDKMessage): boolean {
  const raw = message as Record<string, unknown>
  if (raw._promaPausedByUser === true || raw._stoppedByUser === true) {
    return true
  }
  return message.type === 'result'
    && (message as { subtype?: string }).subtype === 'interrupted'
}

function isTurnStoppedByUser(turnMessages: SDKMessage[]): boolean {
  return turnMessages.some(isInterruptedResultMessage)
}

function isErrorResult(message: SDKMessage): boolean {
  if (message.type !== 'result') return false
  const subtype = (message as { subtype?: string }).subtype
  return typeof subtype === 'string' && /^error(?:_|$)/i.test(subtype)
}

function hasTurnError(
  turn: AssistantTurn,
): boolean {
  return turn.assistantMessages.some((message) => Boolean(message.error))
    || turn.turnMessages.some(isErrorResult)
}

function hasResultMessage(turnMessages: SDKMessage[]): boolean {
  return turnMessages.some((message) => message.type === 'result')
}

function getCompletedToolResultIds(turnMessages: SDKMessage[]): Set<string> {
  const completedIds = new Set<string>()

  for (const message of turnMessages) {
    if (message.type !== 'user') continue
    const content = (message as SDKUserMessage).message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (block.type === 'tool_result') {
        completedIds.add((block as SDKToolResultBlock).tool_use_id)
      }
    }
  }

  return completedIds
}

function estimateTurnDurationFromTimestamps(
  turnMessages: SDKMessage[],
): number | undefined {
  let firstTimestamp: number | undefined
  let lastTimestamp: number | undefined

  for (const message of turnMessages) {
    const timestamp = (message as Record<string, unknown>)._createdAt
    if (typeof timestamp !== 'number') continue
    if (firstTimestamp === undefined || timestamp < firstTimestamp) {
      firstTimestamp = timestamp
    }
    if (lastTimestamp === undefined || timestamp > lastTimestamp) {
      lastTimestamp = timestamp
    }
  }

  if (
    firstTimestamp !== undefined
    && lastTimestamp !== undefined
    && lastTimestamp >= firstTimestamp
  ) {
    return lastTimestamp - firstTimestamp
  }
  return undefined
}

function extractTurnUsage(turnMessages: SDKMessage[]): {
  durationMs?: number
  usage?: AgentEventUsage
} {
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index]
    if (message?.type !== 'result') continue

    const result = message as SDKResultMessage
    const raw = message as Record<string, unknown>
    const durationFromResult = typeof raw._durationMs === 'number'
      ? raw._durationMs
      : typeof raw.duration_ms === 'number'
        ? raw.duration_ms
        : undefined
    const usage = result.usage

    return {
      durationMs: durationFromResult
        ?? estimateTurnDurationFromTimestamps(turnMessages),
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

  const durationMs = estimateTurnDurationFromTimestamps(turnMessages)
  return durationMs === undefined ? {} : { durationMs }
}

/** Pi 的 result 耗时属于整个 run，steering 后的显示段必须从原生 user 消费时刻计时。 */
function getSteeredTurnDuration(input: BuildCursorTurnPresentationInput): number | undefined {
  const firstAssistant = input.turn.assistantMessages[0]
  if (!input.allMessages || !firstAssistant) return undefined
  const firstIndex = input.allMessages.findIndex((message) =>
    message === firstAssistant || (firstAssistant.uuid != null && (message as Record<string, unknown>).uuid === firstAssistant.uuid),
  )
  for (let index = firstIndex - 1; index >= 0; index -= 1) {
    const message = input.allMessages[index]
    if (message?.type !== 'user') continue
    const content = (message as SDKUserMessage).message?.content
    if (Array.isArray(content) && content.every((block) => block.type === 'tool_result')) continue
    const raw = message as Record<string, unknown>
    if (raw._promaNativeMessage !== true || raw._promaQueuedDuringStreaming !== true
      || typeof raw._createdAt !== 'number') return undefined
    const timestamps = input.turn.turnMessages.flatMap((item) =>
      typeof (item as Record<string, unknown>)._createdAt === 'number'
        ? [(item as Record<string, unknown>)._createdAt as number] : [],
    )
    return timestamps.length ? Math.max(0, Math.max(...timestamps) - raw._createdAt) : undefined
  }
  return undefined
}

function findFinalTextIndexes(
  blocks: IndexedBlock[],
  forcedActivityIndexes: ReadonlySet<number>,
): Set<number> {
  const lastPhasePosition = blocks.findLastIndex(({ block, index }) =>
    block.type === 'tool_use'
    || block.type === 'thinking'
    || forcedActivityIndexes.has(index),
  )
  let position = blocks.length - 1

  while (
    position > lastPhasePosition
    && blocks[position]?.block.type === 'text'
  ) {
    position -= 1
  }

  const finalTextIndexes = new Set<number>()
  for (
    let finalPosition = position + 1;
    finalPosition < blocks.length;
    finalPosition += 1
  ) {
    const entry = blocks[finalPosition]
    if (entry?.block.type === 'text') finalTextIndexes.add(entry.index)
  }
  return finalTextIndexes
}

function buildActivityItems(
  blocks: IndexedBlock[],
  running: boolean,
  completedToolIds: ReadonlySet<string>,
  runningActivityToolIds: ReadonlySet<string>,
  phase: SDKAssistantMessage['_promaActivityPhase'],
): AgentActivityItem[] {
  const lastBlock = blocks.at(-1)

  return blocks.map(({ block, index }) => {
    let itemRunning = false

    if (running && block.type === 'tool_use') {
      const toolId = (block as SDKToolUseBlock).id
      itemRunning = !completedToolIds.has(toolId)
        || runningActivityToolIds.has(toolId)
    } else if (
      running
      && (phase === undefined || phase === block.type)
      && lastBlock?.index === index
      && (block.type === 'thinking' || block.type === 'text')
    ) {
      itemRunning = true
    }

    return {
      block,
      index,
      running: itemRunning,
      foldable: block.type === 'thinking' || block.type === 'tool_use',
    }
  })
}

function shouldShowThinkingPlaceholder(
  activities: AgentActivityItem[],
  running: boolean,
  phase: SDKAssistantMessage['_promaActivityPhase'],
): boolean {
  if (!running) return false
  if (activities.some((item) =>
    item.running && item.block.type === 'tool_use',
  )) {
    return false
  }
  if (phase !== undefined) {
    return phase === 'thinking'
      && !activities.some((item) => item.running && item.block.type === 'thinking')
  }
  return false
}

function hasVisibleRunningActivity(activities: AgentActivityItem[]): boolean {
  return activities.some((item) => {
    if (!item.running) return false
    if (item.block.type === 'tool_use') return true
    if (item.block.type === 'thinking') {
      // ThinkingActivity 即使尚无正文也有可见标题，不能再叠加通用等待行。
      return true
    }
    if (item.block.type === 'text') {
      return Boolean(String(item.block.text ?? '').trim())
    }
    return true
  })
}

function shouldShowWaitingPlaceholder(
  activities: AgentActivityItem[],
  running: boolean,
  phase: SDKAssistantMessage['_promaActivityPhase'],
  suppressed: boolean,
): boolean {
  if (!running || suppressed || hasVisibleRunningActivity(activities)) {
    return false
  }
  // text_start/toolcall_start 可能先于首个可见内容；这个空档也必须有反馈。
  return phase !== 'thinking'
}

/**
 * 按 Cursor 的原生活动顺序投影单轮展示，不调用旧展示器的排序、去重或 latest-only 规则。
 */
export function buildCursorTurnPresentation(
  input: BuildCursorTurnPresentationInput,
): CursorTurnPresentation {
  const stopped = Boolean(input.stoppedByUser)
    || isTurnStoppedByUser(input.turn.turnMessages)
  const failed = Boolean(input.hasErrorOrBlockingItem)
    || hasTurnError(input.turn)
  const resultReached = hasResultMessage(input.turn.turnMessages)
  const running = !stopped
    && !failed
    && (
      Boolean(input.hasRunningSubagent)
      || (input.isStreaming === true && !resultReached)
    )
  const status: CursorTurnPresentation['status'] = stopped
    ? 'stopped'
    : failed
      ? 'failed'
      : running
        ? 'running'
        : 'completed'
  const forcedActivityIndexes = input.forcedActivityIndexes ?? new Set<number>()
  const displayBlocks = input.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !isTaskProgressTool(block))
  const finalTextIndexes = status === 'completed'
    ? findFinalTextIndexes(displayBlocks, forcedActivityIndexes)
    : new Set<number>()
  const activityBlocks: IndexedBlock[] = []
  const finalItems: AgentPersistentItem[] = []

  for (const entry of displayBlocks) {
    if (status === 'completed' && isPlanBlock(entry.block)) {
      finalItems.push({
        block: entry.block,
        index: entry.index,
        kind: 'plan',
      })
    } else if (finalTextIndexes.has(entry.index)) {
      finalItems.push({
        block: entry.block,
        index: entry.index,
        kind: 'answer',
      })
    } else {
      activityBlocks.push(entry)
    }
  }

  const completedToolIds = getCompletedToolResultIds(input.turn.turnMessages)
  // usage-only 消息不是模型输出，不能覆盖原生阶段；正文结束后按原生 idle 兜底。
  const latestAssistant = input.turn.assistantMessages.findLast(
    (message) => !message.parent_tool_use_id
      && (message.message.content.length > 0
        || ('_promaNativeMessage' in message && message._promaNativeMessage === true)),
  )
  const isNativeAssistant = latestAssistant != null
    && '_promaNativeMessage' in latestAssistant && latestAssistant._promaNativeMessage === true
  const isPartialAssistant = latestAssistant != null
    && '_partial' in latestAssistant && latestAssistant._partial === true
  const phase = latestAssistant?._promaActivityPhase
    ?? (isNativeAssistant && !isPartialAssistant ? 'idle' : undefined)
  const activities = buildActivityItems(
    activityBlocks,
    running,
    completedToolIds,
    input.runningActivityToolIds ?? new Set<string>(),
    phase,
  )
  const { durationMs: resultDurationMs, usage } = extractTurnUsage(
    input.turn.turnMessages,
  )
  const durationMs = input.isStreaming
    ? input.runningDurationMs ?? resultDurationMs
    : getSteeredTurnDuration(input) ?? resultDurationMs ?? input.runningDurationMs

  return {
    id: input.id,
    model: input.turn.model,
    durationMs,
    usage,
    status,
    activities,
    finalItems,
    showThinkingPlaceholder: shouldShowThinkingPlaceholder(
      activities,
      running,
      phase,
    ),
    showWaitingPlaceholder: shouldShowWaitingPlaceholder(
      activities,
      running,
      phase,
      input.suppressWaitingFeedback === true,
    ),
  }
}
