/**
 * AgentMessages — Agent 消息列表
 *
 * 复用 Chat 的 Conversation/Message 原语组件，
 * 流式输出通过 SDK 渲染路径（MessageGroupRenderer）展示工具活动。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { RotateCw, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { AgentWelcomeScreen } from '@/components/welcome/AgentWelcomeScreen'
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
import { appendImmediateUserMessages } from '@/lib/agent-immediate-send'
import { findStreamingFallbackInsertionIndex } from '@/lib/agent-streaming-order'
import { shouldSuppressAgentRunningIndicator } from '@/lib/agent-running-state'
import { isTurnStoppedByUser } from '@/lib/agent-turn-presentation'
import { AgentRunningIndicator } from './AgentRunningIndicator'
import { AgentTurnStatusLine } from './AgentTurnStatusLine'
import {
  CompactionStatusLine,
  type CompactionStatusLineStatus,
} from './CompactionStatusLine'
import { parseThinkTagsFromText } from './thinking-tag-parser'
import { AgentHistorySelectionLayer } from './AgentHistorySelectionLayer'
import { AgentConversationScrollController, AgentConversationScrollButton } from './AgentConversationScrollController'
import type {
  RetryAttempt,
  SDKAssistantMessage,
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@proma/shared'
import { getSDKCompactStatus } from '@proma/shared'
import {
  agentImmediateUserMessagesAtom,
  agentSessionsAtom,
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  allPendingPermissionRequestsAtom,
  type AgentStreamState,
} from '@/atoms/agent-atoms'

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
  if (group.type !== 'user') return false
  const command = (extractUserText(group.message) ?? '').trim()
  return command === '/compact'
}

/** 上下文压缩进度状态；history 终态由 system group 原位渲染，tail 仅作为实时或缺失消息时的兜底。 */
export interface ContextCompactionProgress {
  status: CompactionStatusLineStatus
  placement: 'history' | 'tail'
  detail?: string
  trigger?: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
}

export function getContextCompactionProgress(
  messages: SDKMessage[],
  isCompacting: boolean | undefined,
  streamCompaction: AgentStreamState['contextCompaction'] | undefined,
): ContextCompactionProgress | undefined {
  let latestControlIndex = -1
  let latestCompactMessageIndex = -1
  let latestCompactMessage: SDKSystemMessage | undefined

  messages.forEach((message, index) => {
    if (
      message.type === 'user'
      && (extractUserText(message as SDKUserMessage) ?? '').trim() === '/compact'
    ) {
      latestControlIndex = index
      return
    }

    if (message.type !== 'system') return
    const compactStatus = getSDKCompactStatus(message as SDKSystemMessage)
    if (!compactStatus) return
    latestCompactMessageIndex = index
    latestCompactMessage = message as SDKSystemMessage
    if (compactStatus === 'compacting') latestControlIndex = index
  })

  const messageStatus = latestCompactMessage
    ? getSDKCompactStatus(latestCompactMessage)
    : undefined
  const messageIsTerminal = messageStatus != null && messageStatus !== 'compacting'
  const hasNewerControl = latestControlIndex > latestCompactMessageIndex

  // streamCompaction 表示当前控制请求，优先级高于历史最后一条 system 状态。
  // 否则新一轮乐观 running 会被旧历史终态压住；同理，停止/发送失败后若
  // 原生终态尚未落盘，也不能被最后一条 compacting 重新解释为 running。
  if (streamCompaction?.status === 'running') {
    return {
      status: 'running',
      placement: 'tail',
      trigger: streamCompaction.trigger,
    }
  }

  if (streamCompaction) {
    const canReuseHistoryPosition = messageIsTerminal
      && !hasNewerControl
      && latestCompactMessage != null
      && (
        messageStatus === streamCompaction.status
        || (
          streamCompaction.status === 'stopped'
          && (messageStatus === 'failed' || messageStatus === 'stopped')
        )
      )

    if (!canReuseHistoryPosition) {
      return {
        status: streamCompaction.status,
        placement: 'tail',
        detail: streamCompaction.message,
        trigger: streamCompaction.trigger,
        preTokens: streamCompaction.preTokens,
        postTokens: streamCompaction.postTokens,
      }
    }
  }

  if (messageIsTerminal && !hasNewerControl && latestCompactMessage) {
    const metadata = latestCompactMessage.compact_metadata
    // 用户停止时 Runtime 可能仍持久化一条 abort failed；界面以已冻结的 stopped
    // 状态原位替换该行，避免同时出现“停止”兜底和“失败”历史两条状态。
    const displayStatus = streamCompaction?.status === 'stopped'
      ? 'stopped'
      : messageStatus
    return {
      status: displayStatus,
      placement: 'history',
      trigger: latestCompactMessage.compactTrigger ?? metadata?.trigger,
      detail: displayStatus === 'failed'
        ? latestCompactMessage.compact_error ?? latestCompactMessage.message
        : undefined,
      preTokens: latestCompactMessage.compactPreTokens ?? metadata?.pre_tokens,
      postTokens: latestCompactMessage.compactionEstimatedTokensAfter ?? metadata?.post_tokens,
    }
  }

  if (messageStatus === 'compacting' || isCompacting || hasNewerControl) {
    return {
      status: 'running',
      placement: 'tail',
      trigger: latestCompactMessage?.compactTrigger,
    }
  }
  return undefined
}

/** 保留导出名供既有调用方使用，实际视觉统一由 CompactionStatusLine 承载。 */
export function CompactionInlineLine({ progress }: { progress: ContextCompactionProgress }): React.ReactElement {
  return (
    <CompactionStatusLine
      status={progress.status}
      trigger={progress.trigger}
      detail={progress.detail}
      preTokens={progress.preTokens}
      postTokens={progress.postTokens}
    />
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
  /** 首次任务页使用会话所属项目，不使用全局当前项目。 */
  projectName?: string | null
  onSelectWelcomePrompt?: (prompt: string) => void
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

export function AgentMessages({ sessionId, contentOffsetX = 0, sessionModelId, messagesLoaded, projectName, onSelectWelcomePrompt, persistedSDKMessages, streaming, waitingForQueuedRun = false, queuedRunStartedAt, streamState, liveMessages, sessionPath, attachedDirs, stoppedByUser, onRetry, onRetryInNewSession, onFork, onRewind, onCompact }: AgentMessagesProps): React.ReactElement {
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
  // ContentBlock / ThinkingActivity 逐字渲染。这里若再次平滑，
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

  const immediateUserMessages = useAtomValue(agentImmediateUserMessagesAtom).get(sessionId)
  const pendingPermissionRequests = useAtomValue(allPendingPermissionRequestsAtom).get(sessionId)
  const pendingAskUserRequests = useAtomValue(allPendingAskUserRequestsAtom).get(sessionId)
  const pendingExitPlanRequests = useAtomValue(allPendingExitPlanRequestsAtom).get(sessionId)
  const hasPendingInteraction = Boolean(
    pendingPermissionRequests?.length
    || pendingAskUserRequests?.length
    || pendingExitPlanRequests?.length,
  )
  // 合并持久化 + 实时 SDKMessage（供 ContentBlock 内查找工具结果）
  const sourceSDKMessages = React.useMemo(() => {
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
  const pendingImmediateUserIds = React.useMemo(() => {
    if (!immediateUserMessages?.length) return new Set<string>()
    const sourceUserIds = new Set(
      sourceSDKMessages.flatMap((message) =>
        message.type === 'user' && message.uuid ? [message.uuid] : [],
      ),
    )
    return new Set(
      immediateUserMessages.flatMap((message) =>
        message.uuid && !sourceUserIds.has(message.uuid) ? [message.uuid] : [],
      ),
    )
  }, [immediateUserMessages, sourceSDKMessages])
  const allSDKMessages = React.useMemo(
    () => appendImmediateUserMessages(sourceSDKMessages, immediateUserMessages),
    [immediateUserMessages, sourceSDKMessages],
  )

  const hasContent = allSDKMessages.length > 0

  // 压缩期间用专用状态行替代普通运行指示器，避免同时出现 thinking spinner。
  const suppressAgentRunning = shouldSuppressAgentRunningIndicator(streamState)
  const suppressWaitingFeedback = suppressAgentRunning
    || hasPendingInteraction
    || retrying != null
  const contextCompaction = React.useMemo(
    () => getContextCompactionProgress(allSDKMessages, streamState?.isCompacting, streamState?.contextCompaction),
    [allSDKMessages, streamState?.isCompacting, streamState?.contextCompaction],
  )

  // 统一分组：将持久化 + 实时消息合并后再分组，确保压缩终态留在原生位置。
  const allGroups = React.useMemo(() => {
    return groupIntoTurns(allSDKMessages, sessionModelId)
  }, [allSDKMessages, sessionModelId])
  // 控制消息不进入历史；压缩终态 system group 保留。
  const visibleGroups = React.useMemo(
    () => allGroups.filter((group) => !isCompactionControlHistoryGroup(group)),
    [allGroups],
  )
  const latestCompactionGroupIndex = visibleGroups.findLastIndex(
    (group) => group.type === 'system' && getSDKCompactStatus(group.message) != null,
  )
  const hasTailCompactionStatus = contextCompaction?.placement === 'tail'

  // 标记哪些 group 属于实时流式消息（用于 isStreaming / onFork 差异化渲染）
  const liveGroupSet = React.useMemo(() => {
    return buildLiveGroupSet({
      allGroups,
      liveMessages,
      streaming,
      currentTurnStartedAt: startedAt,
    })
  }, [allGroups, liveMessages, streaming, startedAt])

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
  const queuedUserGroupIndex = findStreamingFallbackInsertionIndex(visibleGroups, liveMessages ?? [], startedAt)
  const hasLiveAssistantContent = streaming
    ? visibleGroups.some((group, index) =>
      group.type === 'assistant-turn'
      && liveGroupSet.has(group)
      // Pi 实际消费新指令后，其 user 之前的 assistant 才属于上一回合；
      // 只有新用户之后的 assistant 才能收起新回合占位。
      && (queuedUserGroupIndex == null || index > queuedUserGroupIndex)
    )
    : (liveMessages != null && liveMessages.some((m) => (m as { type: string }).type === 'assistant'))
  const shouldRenderStreamingFallback = !hasLiveAssistantContent
    && !suppressAgentRunning
    && (
      smoothFallbackTurn != null
      || retrying != null
      || (!hasPendingInteraction && streaming)
    )
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
            {streaming && !suppressWaitingFeedback && (
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
    && !immediateUserMessages?.length
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
        <AgentConversationScrollController submittedMessageId={lastUserGroupIndex >= 0 ? getGroupId(visibleGroups[lastUserGroupIndex]!) : undefined} />
        <ScrollPositionManager id={sessionId} ready={ready} />
        {/* contentOffsetX 无 CSS transition：只跟随真实容器宽度，与 Chat/侧栏 CSS 同帧 */}
        <ConversationContent
          style={{ transform: contentOffsetX ? `translateX(${contentOffsetX}px)` : undefined }}
        >
          {!hasContent && !streaming && !waitingForQueuedRun && !hasTailCompactionStatus ? (
            messagesLoaded !== false && (
              <AgentWelcomeScreen
                projectName={projectName}
                onSelectPrompt={onSelectWelcomePrompt}
              />
            )
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
                      backgroundWaiting={streamState?.backgroundWaiting}
                      pendingUserMessage={
                        group.type === 'user'
                        && group.message.uuid != null
                        && pendingImmediateUserIds.has(group.message.uuid)
                      }
                      suppressWaitingFeedback={suppressWaitingFeedback}
                      compactionStatusOverride={
                        contextCompaction?.status === 'stopped'
                        && contextCompaction.placement === 'history'
                        && idx === latestCompactionGroupIndex
                          ? 'stopped'
                          : undefined
                      }
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
                      compact
                      model={sessionModelId}
                      status="stopped"
                      durationMs={stoppedDurationMs}
                    />
                  </MessageContent>
                </Message>
              )}

              {/* 进行中或缺少可持久化 system 消息的终态：在正文起点显示同款简洁状态行。
                  已有 system 终态必须原位渲染，避免列表末尾再出现重复状态。 */}
              {contextCompaction?.placement === 'tail' && (
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
              {waitingForQueuedRun
                && !streaming
                && !immediateUserMessages
                && !suppressWaitingFeedback && (
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
        <AgentConversationScrollButton />
        {allUserMessagesData.length > 0 && (
          <StickyUserMessage
            variant="agent"
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
