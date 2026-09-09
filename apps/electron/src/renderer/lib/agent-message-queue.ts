import type { QuotedSelection } from '@/atoms/preview-atoms'

export type QueueDropPlacement = 'before' | 'after'

export interface AgentQueuedAttachment {
  filename: string
  mediaType: string
  size: number
  targetPath: string
}

export interface AgentQueuedMessage {
  id: string
  text: string
  createdAt: number
  /** 已交给 Runtime，等待原生 user 消息确认实际进入上下文。 */
  deliveryState?: 'sending'
  /** 原生未消费的失败/取消指令，必须由用户重试，避免停止后自动重启。 */
  requiresManualSend?: boolean
  quotedSelection?: QuotedSelection
  fileReferenceBlock?: string
  attachments?: AgentQueuedAttachment[]
  additionalDirectories?: string[]
}

export interface AgentMessageRuntimeState {
  streaming: boolean
  stopping: boolean
  messagesRefreshing: boolean
  /** 会话级立即发送尚未消费，跨 Tab 重建也必须继续等待。 */
  immediateSending?: boolean
}

/**
 * 判断用户消息是否应先由 Proma 托管，等待当前 Runtime 进入可启动状态。
 *
 * 用户点击暂停后，Runtime 停止确认与消息投影刷新都可能晚于 UI。此时不能直接
 * 启动新一轮，也不能阻止用户发送；消息先进入内存队列，待旧回合完全收尾后续跑。
 */
export function shouldDeferAgentMessage(
  state: AgentMessageRuntimeState,
): boolean {
  // 活跃 run 直接接收 steering；同步历史或已有指令待消费不能阻塞下一条指令。
  // 停止收尾例外：必须等 Runtime 退出，不能在取消过程中把它重新唤醒。
  return state.stopping || (!state.streaming && (
    state.messagesRefreshing || state.immediateSending === true
  ))
}

export interface AgentQueuedAutoSendState {
  headRequiresManualSend?: boolean
  queueLength: number
  canSendNow: boolean
  streaming: boolean
  stopping: boolean
  messagesRefreshing: boolean
  immediateSending?: boolean
}

/** 只有旧 Runtime 已完成收尾且消息投影稳定后，才自动启动队首消息。 */
export function canAutoSendQueuedAgentMessage(
  state: AgentQueuedAutoSendState,
): boolean {
  return state.queueLength > 0
    && !state.headRequiresManualSend
    && state.canSendNow
    && !state.streaming
    && !state.stopping
    && !state.messagesRefreshing
    && !state.immediateSending
}

export type AgentQueuedDeliveryPlan =
  | { kind: 'runtime-queue'; interrupt: boolean }
  | { kind: 'new-run'; interrupt: false }

/**
 * 决定普通追加/自动队列消息如何交付。
 *
 * 普通追加可由 Runtime 原生 steering 消费，不停止或重启 run。
 * 后台等待态复用现有 Runtime 但不打断，完全空闲时才新建 run。
 * 用户显式“立即发送”始终优先使用 Pi steering，不中断当前工具。
 */
export function resolveAgentQueuedDeliveryPlan(input: {
  streaming: boolean
  backgroundWaiting: boolean
}): AgentQueuedDeliveryPlan {
  if (input.streaming) {
    return { kind: 'runtime-queue', interrupt: true }
  }
  if (input.backgroundWaiting) {
    return { kind: 'runtime-queue', interrupt: false }
  }
  return { kind: 'new-run', interrupt: false }
}

export function createAgentQueuedMessage(
  text: string,
  id: string,
  createdAt: number,
  quotedSelection?: QuotedSelection | null,
  options?: {
    fileReferenceBlock?: string
    attachments?: AgentQueuedAttachment[]
    additionalDirectories?: string[]
  },
): AgentQueuedMessage {
  const message: AgentQueuedMessage = {
    id,
    text: text.trim(),
    createdAt,
  }
  if (quotedSelection) message.quotedSelection = quotedSelection
  if (options?.fileReferenceBlock) message.fileReferenceBlock = options.fileReferenceBlock
  if (options?.attachments && options.attachments.length > 0) message.attachments = options.attachments
  if (options?.additionalDirectories && options.additionalDirectories.length > 0) message.additionalDirectories = options.additionalDirectories
  return message
}

export function removeQueuedMessage(
  queue: AgentQueuedMessage[],
  messageId: string,
): AgentQueuedMessage[] {
  return queue.filter((item) => item.id !== messageId)
}

export function markQueuedMessageSending(
  queue: AgentQueuedMessage[],
  messageId: string,
): AgentQueuedMessage[] {
  let changed = false
  const next = queue.map((item) => {
    if (item.id !== messageId || item.deliveryState === 'sending') return item
    changed = true
    return { ...item, deliveryState: 'sending' as const }
  })
  return changed ? next : queue
}

export function restoreQueuedMessagePending(
  queue: AgentQueuedMessage[],
  messageId: string,
): AgentQueuedMessage[] {
  let changed = false
  const next = queue.map((item) => {
    if (item.id !== messageId || item.deliveryState !== 'sending') return item
    changed = true
    const { deliveryState: _deliveryState, ...pending } = item
    return pending
  })
  return changed ? next : queue
}

export function restoreQueuedMessageToFront(
  queue: AgentQueuedMessage[],
  message: AgentQueuedMessage,
): AgentQueuedMessage[] {
  if (queue.some((item) => item.id === message.id)) return queue
  return [message, ...queue]
}

export function moveQueuedMessage(
  queue: AgentQueuedMessage[],
  sourceId: string,
  targetId: string,
  placement: QueueDropPlacement,
): AgentQueuedMessage[] {
  if (sourceId === targetId) return queue

  const source = queue.find((item) => item.id === sourceId)
  if (!source) return queue

  const withoutSource = queue.filter((item) => item.id !== sourceId)
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return queue

  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
  return [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ]
}

export interface ParsedQueuedMessageMentions {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
}

export interface QueuedMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: ParsedQueuedMessageMentions
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把纯文本队列消息转成与 RichTextInput 段落渲染一致的 HTML：
 * 双换行分段落，单换行转 <br>，并转义 HTML 特殊字符避免破坏结构。
 * 用于撤回时保留已有草稿的富文本节点（mention 等），同时让队列文本按正常段落显示。
 */
export function queuedTextToParagraphHtml(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ''
  return normalized
    .split(/\n\n+/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('')
}


const REF_PATTERN = /\/skill:(?<skill>\S+)|#mcp:(?<mcp>\S+)|&session:(?<session>[A-Za-z0-9_-]+)/g

function containsStandaloneSessionId(text: string, sessionId: string): boolean {
  let searchFrom = 0
  while (searchFrom < text.length) {
    const index = text.indexOf(sessionId, searchFrom)
    if (index === -1) return false

    const before = index > 0 ? text[index - 1] : undefined
    const afterIndex = index + sessionId.length
    const after = afterIndex < text.length ? text[afterIndex] : undefined
    const isSessionIdChar = (char: string | undefined): boolean =>
      char !== undefined && /[A-Za-z0-9_-]/.test(char)

    if (!isSessionIdChar(before) && !isSessionIdChar(after)) return true
    searchFrom = index + sessionId.length
  }

  return false
}

/**
 * 解析输入中的 Skill、MCP 与会话引用。
 *
 * `knownSessionIds` 用于识别用户从会话列表复制后直接粘贴的裸会话 ID；
 * Main 仍会校验会话是否真实存在，避免任意文本被当成历史引用。
 */
export function parseQueuedMessageMentions(
  text: string,
  knownSessionIds: readonly string[] = [],
): ParsedQueuedMessageMentions {
  const mentionedSkills: string[] = []
  const mentionedMcpServers: string[] = []
  const mentionedSessionIds: string[] = []

  for (const match of text.matchAll(REF_PATTERN)) {
    const { skill, mcp, session } = match.groups ?? {}
    if (skill) mentionedSkills.push(skill)
    else if (mcp) mentionedMcpServers.push(mcp)
    else if (session) mentionedSessionIds.push(session)
  }

  for (const sessionId of knownSessionIds) {
    if (containsStandaloneSessionId(text, sessionId)) {
      mentionedSessionIds.push(sessionId)
    }
  }

  return {
    cleanedText: text.replace(REF_PATTERN, '').trim(),
    mentionedSkills,
    mentionedMcpServers,
    mentionedSessionIds: [...new Set(mentionedSessionIds)],
  }
}

export function buildQueuedMessageSendPayload(
  message: AgentQueuedMessage,
  quotedSelectionBlock = '',
  knownSessionIds: readonly string[] = [],
): QueuedMessageSendPayload {
  const text = message.text.trim()
  const mentions = parseQueuedMessageMentions(text, knownSessionIds)
  const contextBlocks = [
    message.fileReferenceBlock?.trim(),
    quotedSelectionBlock.trim(),
  ].filter((block): block is string => Boolean(block))
  const prefix = contextBlocks.length > 0
    ? `${contextBlocks.join('\n\n')}\n\n`
    : ''

  return {
    rawText: `${prefix}${text}`.trim(),
    sdkText: `${prefix}${mentions.cleanedText}`.trim(),
    mentions,
  }
}
