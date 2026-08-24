/**
 * AgentMessages — Agent 消息列表
 *
 * 复用 Chat 的 Conversation/Message 原语组件，
 * 流式输出通过 SDK 渲染路径（MessageGroupRenderer）展示工具活动。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { RotateCw, AlertTriangle, ChevronDown, ChevronRight, Loader2, CheckCircle2, CircleAlert } from 'lucide-react'
import { WelcomeEmptyState } from '@/components/welcome/WelcomeEmptyState'
import {
  Message,
  MessageContent,
  BasePathsProvider,
} from '@/components/ai-elements/message'
import {
  Conversation,
  ConversationContent,
} from '@/components/ai-elements/conversation'
import { ScrollMinimap } from '@/components/ai-elements/scroll-minimap'
import type { MinimapItem } from '@/components/ai-elements/scroll-minimap'
import { StickyUserMessage } from '@/components/ai-elements/sticky-user-message'
import { userProfileAtom } from '@/atoms/user-profile'
import { tabMinimapCacheAtom } from '@/atoms/tab-atoms'
import { ScrollPositionManager } from '@/hooks/useScrollPositionMemory'
import { cn } from '@/lib/utils'
import { AssistantTurnRenderer, groupIntoTurns, MessageGroupRenderer, getGroupId, getGroupPreview, extractUserText, parseAttachedFiles as sdkParseAttachedFiles, isImageFile as sdkIsImageFile, type MessageGroup } from './SDKMessageRenderer'
import { buildLiveGroupSet } from './live-group-set'
import { mergePersistedAndLiveMessages } from '@/lib/agent-live-message'
import { findStreamingFallbackInsertionIndex } from '@/lib/agent-streaming-order'
import { shouldSuppressAgentRunningIndicator } from '@/lib/agent-running-state'
import { isTurnStoppedByUser } from '@/lib/agent-turn-presentation'
import { AgentRunningIndicator } from './AgentRunningIndicator'
import { AgentTurnStatusLine } from './AgentTurnStatusLine'
import { parseThinkTagsFromText } from './thinking-tag-parser'
import { AgentHistorySelectionLayer } from './AgentHistorySelectionLayer'
import { AgentConversationScrollController } from './AgentConversationScrollController'
import type {
  RetryAttempt,
  SDKAssistantMessage,
  SDKMessage,
  SDKSystemMessage,
} from '@proma/shared'
import { getSDKCompactStatus } from '@proma/shared'
import { agentSessionsAtom, type AgentStreamState } from '@/atoms/agent-atoms'

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** 消息对象引用 → 稳定 key 缓存，避免内容相同的消息产生重复 key */
const stableKeyCache = new WeakMap<object, string>()
let stableKeyFallbackCounter = 0

function getSDKMessageStableKey(message: SDKMessage): string {
  const record = message as Record<string, unknown>
  if (typeof record.uuid === 'string' && record.uuid.length > 0) {
    return `${message.type}:uuid:${record.uuid}`
  }

  // 已缓存的消息对象直接返回，保证跨渲染稳定
  if (stableKeyCache.has(message)) {
    return stableKeyCache.get(message)!
  }

  const parentToolUseId = typeof record.parent_tool_use_id === 'string'
    ? record.parent_tool_use_id
    : ''
  const sessionId = typeof record.session_id === 'string' ? record.session_id : ''

  let key: string

  if (message.type === 'result') {
    const result = record as { subtype?: unknown; terminal_reason?: unknown; result?: unknown }
    key = `result:${sessionId}:${String(result.subtype ?? '')}:${String(result.terminal_reason ?? '')}:${String(result.result ?? '')}:${++stableKeyFallbackCounter}`
  } else if (message.type === 'system') {
    const sys = record as { subtype?: unknown; task_id?: unknown; tool_use_id?: unknown }
    key = `system:${sessionId}:${String(sys.subtype ?? '')}:${String(sys.task_id ?? '')}:${String(sys.tool_use_id ?? '')}:${stableStringify(record)}:${++stableKeyFallbackCounter}`
  } else if ('message' in record) {
    const inner = record.message as { content?: unknown } | undefined
    key = `${message.type}:${sessionId}:${parentToolUseId}:${stableStringify(inner?.content)}:${++stableKeyFallbackCounter}`
  } else {
    key = `${message.type}:${sessionId}:${parentToolUseId}:${stableStringify(record)}:${++stableKeyFallbackCounter}`
  }

  stableKeyCache.set(message, key)
  return key
}

export function isCompactionControlHistoryGroup(group: MessageGroup): boolean {
  if (group.type === 'system') {
    return getSDKCompactStatus(group.message) === 'compacting'
      || group.message.subtype === 'context_compaction_config'
  }
  return group.type === 'user' && (extractUserText(group.message) ?? '').trim() === '/compact'
}

function formatCompactionTokens(tokens: number | undefined): string | undefined {
  if (!tokens || tokens <= 0) return undefined
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function getCompactionTokenDetail(
  preTokens: number | undefined,
  postTokens: number | undefined,
): string | undefined {
  const pre = formatCompactionTokens(preTokens)
  const post = formatCompactionTokens(postTokens)
  return pre && post ? `上下文约 ${pre} → ${post} tokens。` : undefined
}

/** 上下文压缩进度状态（Codex 风格：在消息流末尾内联展示一行） */
export interface ContextCompactionProgress {
  status: 'running' | 'success' | 'noop' | 'failed'
  label: string
  detail?: string
  /** 触发来源：区分「已压缩 / 已自动压缩」文案 */
  trigger?: 'manual' | 'auto'
}

export function getContextCompactionProgress(
  messages: SDKMessage[],
  isCompacting: boolean | undefined,
  streamCompaction: AgentStreamState['contextCompaction'] | undefined,
): ContextCompactionProgress | undefined {
  if (streamCompaction?.status === 'running') {
    return {
      status: 'running',
      label: streamCompaction.trigger === 'auto' ? '正在自动压缩上下文' : '正在压缩上下文',
      trigger: streamCompaction.trigger,
    }
  }
  if (streamCompaction?.status === 'success') {
    return {
      status: 'success',
      label: streamCompaction.trigger === 'auto' ? '上下文已自动压缩' : '上下文已压缩',
      detail: getCompactionTokenDetail(streamCompaction.preTokens, streamCompaction.postTokens),
      trigger: streamCompaction.trigger,
    }
  }
  if (streamCompaction?.status === 'noop') {
    return {
      status: 'noop',
      label: '当前上下文无需压缩',
    }
  }
  if (streamCompaction?.status === 'failed') {
    return {
      status: 'failed',
      label: '上下文压缩失败',
      detail: streamCompaction.message ?? '请检查模型连接后重试。',
    }
  }

  const latestStatus = [...messages].reverse().find((message) =>
    message.type === 'system' && getSDKCompactStatus(message as SDKSystemMessage) != null,
  ) as SDKSystemMessage | undefined
  const status = latestStatus ? getSDKCompactStatus(latestStatus) : undefined

  if (status === 'success' && latestStatus) {
    return {
      status: 'success',
      label: latestStatus.compactTrigger === 'auto' ? '上下文已自动压缩' : '上下文已压缩',
      trigger: latestStatus.compactTrigger,
    }
  }
  if (status === 'noop' && latestStatus) {
    return {
      status: 'noop',
      label: '当前上下文无需压缩',
    }
  }
  if (status === 'failed' && latestStatus) {
    return {
      status: 'failed',
      label: '上下文压缩失败',
      detail: latestStatus.compact_error ?? latestStatus.message ?? '请检查模型连接后重试。',
    }
  }
  if (status === 'compacting' || isCompacting) {
    return {
      status: 'running',
      label: '正在压缩上下文',
    }
  }
  return undefined
}

/**
 * 上下文压缩内联状态行（Codex 风格）。
 * 压缩进行中：spinner +「正在压缩上下文 / 正在自动压缩上下文」；
 * 压缩完成：对勾 +「上下文已压缩 / 上下文已自动压缩」（附 token 变化明细）；
 * 失败/无需压缩：对应图标与说明。
 */
export function CompactionInlineLine({ progress }: { progress: ContextCompactionProgress }): React.ReactElement {
  const isRunning = progress.status === 'running'
  const isSuccess = progress.status === 'success'
  const isFailed = progress.status === 'failed'
  return (
    <div className="flex items-center gap-2 py-1.5 pl-7 text-[13px] text-muted-foreground">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {isRunning && <Loader2 className="size-3.5 animate-spin text-blue-500" />}
        {isSuccess && <CheckCircle2 className="size-3.5 text-green-500" />}
        {progress.status === 'noop' && <CheckCircle2 className="size-3.5 text-muted-foreground" />}
        {isFailed && <CircleAlert className="size-3.5 text-destructive" />}
      </span>
      <span className={cn(isFailed && 'text-destructive')}>{progress.label}</span>
      {progress.detail && <span className="text-xs text-muted-foreground/70">{progress.detail}</span>}
    </div>
  )
}

/** AgentMessages 属性接口 */
interface AgentMessagesProps {
  sessionId: string
  /** 会话悬浮面板占位后，正文整体水平偏移量。 */
  contentOffsetX?: number
  /** 用户在前端选择的模型 ID（用于显示渠道配置的 Model Name） */
  sessionModelId?: string
  /** 消息是否已完成首次加载 */
  messagesLoaded?: boolean
  /** Phase 4: 持久化的 SDKMessage（新格式） */
  persistedSDKMessages?: SDKMessage[]
  streaming: boolean
  /** 用户已发送下一条消息，正在等待上一轮 Runtime 完成停止与消息同步。 */
  waitingForQueuedRun?: boolean
  /** 等待中的队首消息创建时间，用作“正在思考”计时起点。 */
  queuedRunStartedAt?: number
  streamState?: AgentStreamState
  /** Phase 2: 实时 SDKMessage 列表（流式期间累积） */
  liveMessages?: SDKMessage[]
  /** 当前会话工作目录，用于解析相对文件路径 */
  sessionPath?: string | null
  /** 附加目录列表（与 sessionPath 一并用作相对路径解析候选） */
  attachedDirs?: string[]
  /** 最后一轮是否被用户中断 */
  stoppedByUser?: boolean
  onRetry?: () => void
  onRetryInNewSession?: () => void
  onFork?: (upToMessageUuid: string) => void
  onRewind?: (assistantMessageUuid: string) => void
  onCompact?: () => void
}

/** 空状态引导 — 使用 WelcomeEmptyState */
function EmptyState(): React.ReactElement {
  return <WelcomeEmptyState />
}

/** 重试提示组件 - 折叠式 */
function RetryingNotice({ retrying }: { retrying: NonNullable<AgentStreamState['retrying']> }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [countdown, setCountdown] = React.useState(0)

  // 倒计时逻辑
  React.useEffect(() => {
    if (retrying.failed || retrying.history.length === 0) {
      setCountdown(0)
      return
    }

    const lastAttempt = retrying.history[retrying.history.length - 1]
    if (!lastAttempt) return

    // 计算倒计时
    const updateCountdown = (): void => {
      const elapsed = (Date.now() - lastAttempt.timestamp) / 1000 // 已过去的秒数
      const remaining = Math.max(0, lastAttempt.delaySeconds - elapsed)
      setCountdown(Math.ceil(remaining))

      if (remaining <= 0) {
        setCountdown(0)
      }
    }

    // 立即更新一次
    updateCountdown()

    // 每 100ms 更新一次倒计时
    const timer = setInterval(updateCountdown, 100)
    return () => clearInterval(timer)
  }, [retrying.failed, retrying.history])

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20 p-3 mb-3">
      {/* 头部：简洁状态 */}
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
        onClick={() => setExpanded(!expanded)}
      >
        {retrying.failed ? (
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
        ) : (
          <RotateCw className="size-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" />
        )}
        <span className="text-sm text-amber-900 dark:text-amber-100 flex-1">
          {retrying.failed
            ? `重试失败 (${retrying.currentAttempt}/${retrying.maxAttempts})`
            : countdown > 0
              ? `重试倒计时 ${countdown}秒 (${retrying.currentAttempt}/${retrying.maxAttempts})`
              : `重试中 (${retrying.currentAttempt}/${retrying.maxAttempts})`}
          {retrying.history.length > 0 && ` · ${retrying.history[retrying.history.length - 1]?.reason}`}
        </span>
        {expanded ? (
          <ChevronDown className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
        ) : (
          <ChevronRight className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
        )}
      </button>

      {/* 展开内容：重试历史 */}
      {expanded && retrying.history.length > 0 && (
        <div className="mt-3 space-y-3 border-t border-amber-200 dark:border-amber-800 pt-3">
          <div className="text-xs font-medium text-amber-900 dark:text-amber-100">
            尝试历史：
          </div>
          {retrying.history.map((attempt, index) => (
            <RetryAttemptItem
              key={attempt.timestamp}
              attempt={attempt}
              isLatest={index === retrying.history.length - 1}
              isFailed={retrying.failed && index === retrying.history.length - 1}
            />
          ))}
          {!retrying.failed && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 pl-6">
              {countdown > 0 ? (
                <>
                  <RotateCw className="size-3 animate-spin" />
                  <span>等待 {countdown} 秒后开始第 {retrying.currentAttempt} 次尝试</span>
                </>
              ) : (
                <>
                  <RotateCw className="size-3 animate-spin" />
                  <span>正在进行第 {retrying.currentAttempt} 次尝试...</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 单条重试尝试记录 */
function RetryAttemptItem({
  attempt,
  isLatest,
  isFailed,
}: {
  attempt: RetryAttempt
  isLatest: boolean
  isFailed: boolean
}): React.ReactElement {
  const [showStderr, setShowStderr] = React.useState(false)
  const [showStack, setShowStack] = React.useState(false)

  const time = new Date(attempt.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <div className={cn('pl-6 space-y-2', isLatest && 'font-medium')}>
      {/* 尝试头部 */}
      <div className="flex items-start gap-2">
        <span className="text-destructive shrink-0">❌</span>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-xs text-amber-900 dark:text-amber-100">
            第 {attempt.attempt} 次 ({time}) - {attempt.reason}
          </div>
          <div className="text-xs text-amber-700 dark:text-amber-300 font-mono break-words">
            {attempt.errorMessage}
          </div>

          {/* 环境信息 */}
          {attempt.environment && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400 space-y-0.5">
              <div>运行时: {attempt.environment.runtime}</div>
              <div>平台: {attempt.environment.platform}</div>
              <div>模型: {attempt.environment.model}</div>
              {attempt.environment.workspace && <div>工作区: {attempt.environment.workspace}</div>}
            </div>
          )}

          {/* 可展开的 stderr */}
          {attempt.stderr && (
            <div className="mt-2">
              <button
                type="button"
                className="text-[11px] text-amber-700 dark:text-amber-300 hover:underline flex items-center gap-1"
                onClick={() => setShowStderr(!showStderr)}
              >
                {showStderr ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                显示 stderr 输出
              </button>
              {showStderr && (
                <pre className="mt-1 text-[10px] text-amber-800 dark:text-amber-200 bg-amber-100 dark:bg-amber-900/30 p-2 rounded overflow-x-auto max-h-[200px] overflow-y-auto">
                  {attempt.stderr}
                </pre>
              )}
            </div>
          )}

          {/* 可展开的堆栈跟踪 */}
          {attempt.stack && (
            <div className="mt-2">
              <button
                type="button"
                className="text-[11px] text-amber-700 dark:text-amber-300 hover:underline flex items-center gap-1"
                onClick={() => setShowStack(!showStack)}
              >
                {showStack ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                显示堆栈跟踪
              </button>
              {showStack && (
                <pre className="mt-1 text-[10px] text-amber-800 dark:text-amber-200 bg-amber-100 dark:bg-amber-900/30 p-2 rounded overflow-x-auto max-h-[200px] overflow-y-auto">
                  {attempt.stack}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 工具活动内部使用的紧凑耗时格式。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`
}

export function AgentMessages({ sessionId, contentOffsetX = 0, sessionModelId, messagesLoaded, persistedSDKMessages, streaming, waitingForQueuedRun = false, queuedRunStartedAt, streamState, liveMessages, sessionPath, attachedDirs, stoppedByUser, onRetry, onRetryInNewSession, onFork, onRewind, onCompact }: AgentMessagesProps): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const setMinimapCache = useSetAtom(tabMinimapCacheAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const currentSessionMeta = sessions.find((session) => session.id === sessionId)
  const lastStopDurationMs = currentSessionMeta?.lastStopDurationMs
  const historySelectionRootRef = React.useRef<HTMLDivElement>(null)
  /** 淡入控制：切换会话时先隐藏，等布局完成后再显示。 */
  const [ready, setReady] = React.useState(false)
  // 空会话无需淡入过渡（无消息则无滚动位置问题）
  const [skipFadeIn, setSkipFadeIn] = React.useState(false)
  const prevSessionIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId
      setReady(false)
      setSkipFadeIn(false)
    }
  }, [sessionId])

  React.useEffect(() => {
    if (ready) return

    // 必须等消息加载完成，否则空 SDK 消息会被误判为空对话
    if (messagesLoaded === false) return

    // 流式进行中且有实时内容 → 跳过 fade 直接显示
    if (streaming && liveMessages && liveMessages.length > 0) {
      setReady(true)
      return
    }

    if ((!persistedSDKMessages || persistedSDKMessages.length === 0) && !streaming) {
      setSkipFadeIn(true)
      setReady(true)
      return
    }
    let cancelled = false
    requestAnimationFrame(() => {
      if (!cancelled) setReady(true)
    })
    return () => { cancelled = true }
  }, [streaming, liveMessages, persistedSDKMessages, messagesLoaded])

  // 从 streamState 属性中计算派生值
  const streamingContent = streamState?.content ?? ''
  const streamingModelId = streamState?.model || sessionModelId
  const retrying = streamState?.retrying
  const startedAt = streamState?.turnStartedAt ?? streamState?.startedAt

  // fallback 只保留一层平滑队列：具体 text/thinking block 统一由
  // ContentBlock / ThinkingStreamPanel 逐字渲染。这里若再次平滑，
  // 同一段内容会经过两层队列，造成正文滞后和忽快忽慢。
  const smoothContent = streamingContent
  const smoothContentBlocks = React.useMemo(() => {
    if (!smoothContent) return []
    return parseThinkTagsFromText(smoothContent)
  }, [smoothContent])
  const smoothFallbackTurn = React.useMemo(() => {
    if (smoothContentBlocks.length === 0) return undefined
    const assistantMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: `${sessionId}:streaming-fallback-message`,
      parent_tool_use_id: null,
      message: {
        content: smoothContentBlocks,
        model: streamingModelId,
      },
      _channelModelId: streamingModelId,
    }
    return {
      type: 'assistant-turn' as const,
      assistantMessages: [assistantMessage],
      turnMessages: [assistantMessage],
      model: streamingModelId,
    }
  }, [sessionId, smoothContentBlocks, streamingModelId])

  /**
   * 流式完成过渡：streaming 结束到持久化消息加载完成之间，
   * 强制 resize="instant" 避免中间高度变化触发平滑滚动动画。
   *
   * 使用 render-phase 计算避免 useEffect 延迟一帧的问题：
   * - streaming 变 false 的第一帧就能立即切到 instant，防止闪动
   * - 后续通过 ref+timeout 延迟 150ms 才允许切回 smooth
   */
  const [transitioningCooldown, setTransitioningCooldown] = React.useState(false)
  const wasStreamingRef = React.useRef(streaming)

  // render-phase 判断：是否处于需要 instant resize 的过渡期
  // liveMessages 非空说明持久化消息还没加载完（加载完后会清空 liveMessages）
  const needsInstant = !streaming && (!!streamingContent || !!smoothContent || (liveMessages != null && liveMessages.length > 0))

  React.useEffect(() => {
    // 刚从 streaming → not-streaming：启动 cooldown
    if (wasStreamingRef.current && !streaming) {
      setTransitioningCooldown(true)
    }
    wasStreamingRef.current = streaming
  }, [streaming])

  React.useEffect(() => {
    if (needsInstant) return
    // 过渡完成后延迟 150ms 才关闭 cooldown，给 StickToBottom 时间稳定
    const timer = setTimeout(() => setTransitioningCooldown(false), 150)
    return () => clearTimeout(timer)
  }, [needsInstant])

  const transitioning = needsInstant || transitioningCooldown

  // 合并持久化 + 实时 SDKMessage（供 ContentBlock 内查找工具结果）
  const allSDKMessages = React.useMemo(() => {
    const persisted = persistedSDKMessages ?? []
    const live = liveMessages ?? []
    const stampStableKey = (message: SDKMessage): SDKMessage => {
      const key = getSDKMessageStableKey(message)
      ;(message as Record<string, unknown>)._promaStableKey = key
      return message
    }
    const identityOf = (message: SDKMessage): string => {
      const record = message as Record<string, unknown>
      if (typeof record.uuid === 'string' && record.uuid.length > 0) {
        return `${message.type}:uuid:${record.uuid}`
      }
      if (message.type === 'user') {
        const createdAt = typeof record._createdAt === 'number'
          ? record._createdAt
          : undefined
        const content = (record.message as { content?: unknown } | undefined)?.content
        const text = Array.isArray(content)
          ? content
            .filter((block): block is { type: 'text'; text: string } =>
              typeof block === 'object'
              && block !== null
              && (block as { type?: unknown }).type === 'text'
              && typeof (block as { text?: unknown }).text === 'string',
            )
            .map((block) => block.text)
            .join('\n')
          : ''
        if (createdAt != null && text.length > 0) {
          return `user:created-at:${createdAt}:${text}`
        }
      }
      if (message.type === 'assistant') {
        const inner = record.message as { id?: unknown } | undefined
        if (inner && typeof inner.id === 'string' && inner.id.length > 0) {
          return `assistant:model:${inner.id}`
        }
      }
      return getSDKMessageStableKey(message)
    }
    return mergePersistedAndLiveMessages(
      persisted.map(stampStableKey),
      live.map(stampStableKey),
      { identityOf },
    )
  }, [persistedSDKMessages, liveMessages])

  const hasContent = allSDKMessages.length > 0

  // 压缩状态在消息流末尾内联展示（Codex 风格）；
  // 压缩期间抑制普通运行指示器，避免两行状态并存。
  const suppressAgentRunning = shouldSuppressAgentRunningIndicator(streamState)
  const contextCompaction = React.useMemo(
    () => getContextCompactionProgress(liveMessages ?? [], streamState?.isCompacting, streamState?.contextCompaction),
    [liveMessages, streamState?.isCompacting, streamState?.contextCompaction],
  )

  // 统一分组：将持久化 + 实时消息合并后再分组，确保 system 消息（如压缩分割线）出现在正确位置
  const allGroups = React.useMemo(() => {
    return groupIntoTurns(allSDKMessages, sessionModelId)
  }, [allSDKMessages, sessionModelId])
  // 压缩过程由底部 Progress Overlay 独立承载，不占用对话历史、迷你地图或用户锚点。
  const visibleGroups = React.useMemo(
    () => allGroups.filter((group) => !isCompactionControlHistoryGroup(group)),
    [allGroups],
  )

  // 标记哪些 group 属于实时流式消息（用于 isStreaming / onFork 差异化渲染）
  const liveGroupSet = React.useMemo(() => {
    return buildLiveGroupSet({
      allGroups,
      liveMessages,
      streaming,
    })
  }, [allGroups, liveMessages, streaming])

  // 迷你地图数据 — 直接使用统一的 allGroups（无需去重）
  const minimapItems: MinimapItem[] = React.useMemo(
    () => visibleGroups.map((group) => ({
      id: getGroupId(group),
      role: group.type === 'user' ? 'user' as const
        : group.type === 'system' ? 'status' as const
        : 'assistant' as const,
      preview: getGroupPreview(group),
      avatar: group.type === 'user' ? userProfile.avatar : undefined,
      model: group.type === 'assistant-turn' ? group.model : undefined,
    })),
    [visibleGroups, userProfile.avatar]
  )

  // 同步 minimap 缓存到 Tab 级别（供 Tab hover 预览使用）
  React.useEffect(() => {
    if (minimapItems.length > 0) {
      setMinimapCache((prev) => {
        const next = new Map(prev)
        next.set(sessionId, minimapItems)
        return next
      })
    }
  }, [sessionId, minimapItems, setMinimapCache])

  // 所有用户消息的数据 — 供 StickyUserMessage 使用
  const allUserMessagesData = React.useMemo(() => {
    return visibleGroups
      .filter((g): g is MessageGroup & { type: 'user' } => g.type === 'user')
      .map((g) => {
        const rawText = extractUserText(g.message) ?? ''
        const { files, text } = sdkParseAttachedFiles(rawText)
        return {
          id: getGroupId(g),
          text,
          attachments: files.map((f) => ({ filename: f.filename, isImage: sdkIsImageFile(f.filename) })),
        }
      })
  }, [visibleGroups])

  // 实时消息中是否已有可渲染的助手内容
  // 流式中：通过 liveGroupSet 精确判断（只有 streaming 时 liveGroupSet 才非空）
  // 流式结束后：直接检查 liveMessages 中是否有助手消息，
  // 防止 streaming→false 到 liveMessages 被清除之间的过渡帧中 fallback 气泡重复渲染
  const queuedUserGroupIndex = findStreamingFallbackInsertionIndex(visibleGroups, liveMessages ?? [])
  const hasLiveAssistantContent = streaming
    ? visibleGroups.some((group, index) =>
      group.type === 'assistant-turn'
      && liveGroupSet.has(group)
      // 立即发送后，队列用户之前的 assistant 属于上一回合；
      // 只有新用户之后的 assistant 才能收起新回合占位。
      && (queuedUserGroupIndex == null || index > queuedUserGroupIndex)
    )
    : (liveMessages != null && liveMessages.some((m) => (m as { type: string }).type === 'assistant'))
  const shouldRenderStreamingFallback = !hasLiveAssistantContent
    && !suppressAgentRunning
    && (streaming || smoothContent || retrying)
  const streamingFallbackInsertionIndex = shouldRenderStreamingFallback
    ? (queuedUserGroupIndex != null ? queuedUserGroupIndex + 1 : visibleGroups.length)
    : undefined
  const streamingFallbackNode = shouldRenderStreamingFallback ? (
    <React.Fragment key={`${sessionId}:streaming-fallback`}>
      {retrying && (
        <div className="pl-7">
          <RetryingNotice retrying={retrying} />
        </div>
      )}
      {smoothFallbackTurn ? (
        <AssistantTurnRenderer
          turn={smoothFallbackTurn}
          allMessages={allSDKMessages}
          basePath={sessionPath || undefined}
          isStreaming
          sessionModelId={streamingModelId}
          sessionId={sessionId}
          turnId={`${sessionId}:streaming-fallback`}
          isLatestAssistantTurn
          runningStartedAt={startedAt}
        />
      ) : (
        <Message from="assistant">
          <MessageContent className="pl-0">
            {streaming && (
              <AgentRunningIndicator
                startedAt={startedAt}
                model={streamingModelId}
              />
            )}
          </MessageContent>
        </Message>
      )}
    </React.Fragment>
  ) : null

  // 用户在模型尚未返回任何内容时暂停：没有 assistant-turn，需要在用户消息后单独补一行停止状态
  // prop 与会话 meta 双通道，避免 atom 尚未同步时历史中断会话漏显示
  const isStoppedByUser = !!stoppedByUser || !!currentSessionMeta?.stoppedByUser
  const lastUserGroupIndex = visibleGroups.findLastIndex((group) => group.type === 'user')
  const lastAssistantGroupIndex = visibleGroups.findLastIndex((group) => group.type === 'assistant-turn')
  const showStoppedWithoutAssistant = !streaming
    && isStoppedByUser
    && lastUserGroupIndex >= 0
    && lastAssistantGroupIndex < lastUserGroupIndex
  const stoppedDurationMs = React.useMemo(() => {
    // 用户点击停止时已经冻结的耗时优先级最高。后续 result/meta 可能使用
    // 不同计时起点返回 duration，不能覆盖停止瞬间已经展示的数值。
    if (streamState?.stopDurationMs != null && streamState.stopDurationMs >= 0) {
      return streamState.stopDurationMs
    }
    if (lastStopDurationMs != null && lastStopDurationMs > 0) return lastStopDurationMs
    // 仅在本轮仍保留流式 startedAt 且尚未完全收尾时用它估算；
    // 不直接 Date.now()-startedAt 作为最终值反复增长，避免停止后耗时跳动。
    // 历史中断会话：从消息时间戳或会话 updatedAt 估算耗时
    const timestamps: number[] = []
    for (const message of allSDKMessages) {
      const createdAt = (message as Record<string, unknown>)._createdAt
      if (typeof createdAt === 'number') timestamps.push(createdAt)
      const duration = (message as Record<string, unknown>)._durationMs
      if (
        message.type === 'result'
        && typeof duration === 'number'
        && duration > 0
      ) {
        return duration
      }
    }
    if (timestamps.length >= 2) {
      const estimated = Math.max(...timestamps) - Math.min(...timestamps)
      if (estimated > 0) return estimated
    }
    if (
      isStoppedByUser
      && typeof currentSessionMeta?.updatedAt === 'number'
      && timestamps.length >= 1
    ) {
      const estimated = currentSessionMeta.updatedAt - Math.min(...timestamps)
      if (estimated > 0) return estimated
    }
    if (
      isStoppedByUser
      && typeof currentSessionMeta?.createdAt === 'number'
      && typeof currentSessionMeta?.updatedAt === 'number'
    ) {
      const estimated = currentSessionMeta.updatedAt - currentSessionMeta.createdAt
      if (estimated > 0) return estimated
    }
    if (streaming && startedAt != null) {
      return Math.max(0, Date.now() - startedAt)
    }
    if (!streaming && startedAt != null && isStoppedByUser) {
      // 流刚结束、meta 尚未带回 lastStopDurationMs 时的瞬时兜底
      return Math.max(0, Date.now() - startedAt)
    }
    return undefined
  }, [allSDKMessages, currentSessionMeta, isStoppedByUser, lastStopDurationMs, startedAt, streaming])

  return (
    <BasePathsProvider basePaths={attachedDirs}>
    <div ref={historySelectionRootRef} className="relative flex min-h-0 flex-1 flex-col">
      <Conversation resize={ready && !transitioning ? 'smooth' : 'instant'} className={ready ? (skipFadeIn ? 'opacity-100' : 'opacity-100 transition-opacity duration-200') : 'opacity-0'}>
        <AgentConversationScrollController />
        <ScrollPositionManager id={sessionId} ready={ready} />
        {/* contentOffsetX 无 CSS transition：只跟随真实容器宽度，与 Chat/侧栏 CSS 同帧 */}
        <ConversationContent
          style={{ transform: contentOffsetX ? `translateX(${contentOffsetX}px)` : undefined }}
        >
          {!hasContent && !streaming && !waitingForQueuedRun ? (
            <EmptyState />
          ) : (
            <>
              {/* 统一消息渲染（持久化 + 实时合并为一个列表，确保 system 消息位置正确） */}
              {streamingFallbackInsertionIndex === 0 && streamingFallbackNode}
              {visibleGroups.map((group, idx) => {
                const isLive = liveGroupSet.has(group)
                  && (queuedUserGroupIndex == null || group.type !== 'assistant-turn' || idx > queuedUserGroupIndex)
                const isLatestAssistantTurn = group.type === 'assistant-turn'
                  && idx === visibleGroups.findLastIndex(
                    (candidate) => candidate.type === 'assistant-turn',
                  )
                const isErrorGroup = group.type === 'assistant-turn'
                  && group.assistantMessages.some((m) => !!m.error)
                const shouldDisableActions = isLive && !isErrorGroup
                // 会话级中断：最后一轮；轮次级 interrupted result：历史轮在续聊后仍保留停止文案
                const isLastAssistantTurn = !streaming && isStoppedByUser
                  && group.type === 'assistant-turn'
                  && idx === visibleGroups.findLastIndex((g) => g.type === 'assistant-turn')
                const turnStoppedByUser = group.type === 'assistant-turn'
                  && (
                    isLastAssistantTurn
                    || isTurnStoppedByUser(group.turnMessages)
                  )
                let turnStopDurationMs: number | undefined
                if (turnStoppedByUser && group.type === 'assistant-turn') {
                  for (let i = group.turnMessages.length - 1; i >= 0; i -= 1) {
                    const message = group.turnMessages[i]
                    if (message?.type !== 'result') continue
                    const duration = (message as Record<string, unknown>)._durationMs
                    if (typeof duration === 'number' && duration >= 0) {
                      turnStopDurationMs = duration
                      break
                    }
                  }
                  if (turnStopDurationMs == null && isLastAssistantTurn) {
                    turnStopDurationMs = stoppedDurationMs
                  }
                }
                return (
                  <React.Fragment key={getGroupId(group)}>
                    {streamingFallbackInsertionIndex === idx && streamingFallbackNode}
                    <MessageGroupRenderer
                      group={group}
                      allMessages={allSDKMessages}
                      basePath={sessionPath || undefined}
                      onFork={shouldDisableActions ? undefined : onFork}
                      onRewind={shouldDisableActions ? undefined : onRewind}
                      onRetry={shouldDisableActions ? undefined : onRetry}
                      onRetryInNewSession={shouldDisableActions ? undefined : onRetryInNewSession}
                      onCompact={shouldDisableActions ? undefined : onCompact}
                      isStreaming={isLive || undefined}
                      stoppedByUser={turnStoppedByUser || undefined}
                      sessionModelId={sessionModelId}
                      sessionId={sessionId}
                      isLatestAssistantTurn={isLatestAssistantTurn}
                      // 中断后 isLive=false，但仍需 startedAt / duration 才能显示「你在 N 秒后停止了」
                      runningStartedAt={
                        isLive || turnStoppedByUser
                          ? (startedAt ?? (
                            turnStoppedByUser && turnStopDurationMs != null && turnStopDurationMs >= 0
                              ? Date.now() - Math.max(turnStopDurationMs, 1)
                              : undefined
                          ))
                          : undefined
                      }
                      fallbackDurationMs={turnStoppedByUser ? turnStopDurationMs : undefined}
                    />
                  </React.Fragment>
                )
              })}
              {streamingFallbackInsertionIndex === visibleGroups.length && streamingFallbackNode}

              {/* 模型尚未返回内容就被暂停：显示「你在 N 秒后停止了」 */}
              {showStoppedWithoutAssistant && (
                <Message from="assistant">
                  <MessageContent className="pl-0">
                    <AgentTurnStatusLine
                      model={sessionModelId}
                      status="stopped"
                      durationMs={stoppedDurationMs}
                    />
                  </MessageContent>
                </Message>
              )}

              {/* 压缩进行中：钉在列表末尾显示 spinner。
                  完成态必须走消息流中的 compact_boundary 位置渲染，
                  否则会出现「模型正文 → 已自动压缩」的倒置顺序。 */}
              {contextCompaction?.status === 'running' && (
                <CompactionInlineLine progress={contextCompaction} />
              )}

              {/* 有实时助手内容时：显示运行指示器或占位（防止 streaming 结束到 Actions Bar 出现之间的高度跳动） */}
              {/* 不使用 mt：ConversationContent 的 gap-1(4px) 已提供间距，
                  匹配内部 MessageActions 的 gap-0.5(2px)+mt-0.5(2px)=4px 间距 */}
              {hasLiveAssistantContent && retrying && (
                <div className="min-h-[28px] pl-7">
                  <RetryingNotice retrying={retrying} />
                </div>
              )}

              {/* 暂停后的下一条消息已进入队列：旧 Runtime 收尾期间持续显示处理中，
                  但不把旧流重新标记为 running，避免误走 Runtime 注入通道。 */}
              {waitingForQueuedRun && !streaming && (
                <Message from="assistant">
                  <MessageContent className="pl-0">
                    <AgentRunningIndicator
                      startedAt={queuedRunStartedAt}
                      model={sessionModelId}
                    />
                  </MessageContent>
                </Message>
              )}

            </>
          )}
        </ConversationContent>
        <ScrollMinimap items={minimapItems} />
        {allUserMessagesData.length > 0 && (
          <StickyUserMessage
            userMessages={allUserMessagesData}
            contentOffsetX={contentOffsetX}
          />
        )}
      </Conversation>
      <AgentHistorySelectionLayer sessionId={sessionId} rootRef={historySelectionRootRef} />
    </div>
    </BasePathsProvider>
  )
}
