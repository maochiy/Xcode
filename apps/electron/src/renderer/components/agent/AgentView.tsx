/**
 * AgentView — Agent 模式主视图容器
 *
 * 职责：
 * - 加载当前 Agent 会话消息
 * - 发送/停止/压缩 Agent 消息
 * - 附件上传处理
 * - AgentHeader 支持标题编辑 + 文件浏览器切换
 *
 * 注意：IPC 流式事件监听已提升到全局 useGlobalAgentListeners，
 * 本组件为纯展示 + 交互组件。
 *
 * 布局：AgentHeader | AgentMessages | AgentInput + 可选 FileBrowser 侧面板
 */

import * as React from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import { ArrowUp, Square, Settings, X, Copy, Check, Sparkles } from 'lucide-react'
import { AgentMessages } from './AgentMessages'
import { AgentHeader } from './AgentHeader'
import { AgentMessageQueue } from './AgentMessageQueue'
import { AgentProjectPicker } from './AgentProjectPicker'
import { AgentThinkingEffortControl } from './AgentThinkingEffortControl'
import { AgentInputAddMenu } from './AgentInputAddMenu'
import { AgentInputContextBar } from './AgentInputContextBar'
import { SessionFloatingPanel } from './SessionFloatingPanel'
import { RuntimeTodoHoverProgress } from './RuntimeTodoHoverProgress'
import { ContextUsageBadge } from './ContextUsageBadge'
import { PermissionBanner } from './PermissionBanner'
import { PermissionModeSelector } from './PermissionModeSelector'
import { PlanModeChip } from './PlanModeChip'
import { AskUserBanner } from './AskUserBanner'
import { ExitPlanModeBanner } from './ExitPlanModeBanner'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { AttachmentPreviewItem } from '@/components/chat/AttachmentPreviewItem'
import { QuotedSelectionChip } from '@/components/diff/QuotedSelectionChip'
import { RichTextInput } from '@/components/ai-elements/rich-text-input'
import { SpeechButton } from '@/components/ai-elements/speech-button'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import {
  inputAreaContainerClass,
  inputAreaFadeClass,
  inputCardClass,
  inputToolbarButtonClass,
  inputToolbarDangerButtonClass,
  inputToolbarDisabledButtonClass,
  inputToolbarSendButtonClass,
} from '@/components/ai-elements/input-toolbar-styles'
import {
  getActiveAgentInteractionPanel,
  shouldReplaceAgentComposer,
} from '@/lib/agent-interaction-panel'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import {
  hasUnpersistedLiveAssistantNarrative,
  hasUnpersistedPausedAgentContent,
  markPausedAgentMessages,
  preservePausedAgentContent,
} from '@/lib/agent-live-message'
import {
  buildAgentAppModelOptions,
  resolveAppAgentChannelId,
} from '@/lib/agent-runtime-model-options'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import { registerShortcut } from '@/lib/shortcut-registry'
import { supportsChannelPlanQuota } from '@/lib/channel-plan-quota'
import { previewPanelOpenMapAtom, quotedSelectionMapAtom, currentQuotedSelectionAtom } from '@/atoms/preview-atoms'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import {
  agentStreamingStatesAtom,
  agentSessionStreamingStateAtomFamily,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentChannelIdsAtom,
  agentRuntimeModelCatalogsAtom,
  agentRuntimeModelCatalogRevisionAtom,
  getAgentRuntimeModelCatalogKey,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  currentAgentWorkspaceIdAtom,
  agentPendingPromptAtom,
  agentPendingFilesAtomFamily,
  agentMessageQueueAtomFamily,
  agentWorkspacesAtom,
  agentStreamErrorsAtom,
  agentSessionDraftsAtom,
  agentSessionDraftAtomFamily,
  agentSessionDraftHtmlAtom,
  agentSessionDraftHtmlAtomFamily,
  agentPromptSuggestionsAtom,
  agentMessageRefreshAtom,
  agentSDKMessagesCacheAtom,
  setSessionMessagesCache,
  agentDiffRefreshVersionAtom,
  agentSessionsAtom,
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  liveMessagesMapAtom,
  agentSessionLiveMessagesAtomFamily,
  agentThinkingAtom,
  agentThinkingEffortLevelAtom,
  agentSessionThinkingEffortMapAtom,
  stoppedByUserSessionsAtom,
  agentPlanModeSessionsAtom,
  agentPermissionModeMapAtom,
  agentDefaultPermissionModeAtom,
  sessionPersistedPermissionModeAtom,
  sessionPersistedPlanModeEnabledAtom,
  agentSessionPathMapAtom,
  allPendingAskUserRequestsAtom,
  allPendingPermissionRequestsAtom,
  allPendingExitPlanRequestsAtom,
  agentFloatingPanelEnabledAtom,
  agentFloatingPanelForcedSessionsAtom,
  agentFloatingPanelVisibleSessionsAtom,
  beginAgentFloatingPanelTurnAtom,
  beginAgentSteeredTurn,
  markAgentStreamStopped,
} from '@/atoms/agent-atoms'
import type { AgentContextStatus, AgentStreamState } from '@/atoms/agent-atoms'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import {
  browserAnnotationKey,
  browserAnnotationsAtomFamily,
  browserSelectedAnnotationIdsAtomFamily,
} from '@/atoms/browser-atoms'
import { longTextPasteAsAttachmentEnabledAtom } from '@/atoms/ui-preferences'
import { channelsAtom } from '@/atoms/chat-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { useCreateSession } from '@/hooks/useCreateSession'
import { AgentSessionProvider } from '@/contexts/session-context'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import type { AgentRuntimeModelInfo, AgentSendInput, AgentPendingFile, FileDialogLargeFile, ModelOption, SDKMessage, SDKUserMessage } from '@proma/shared'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'
import { fileToBase64, formatFileNames, getFileParentPath } from '@/lib/file-utils'
import { buildQuotedSelectionBlock } from '@/lib/quoted-selection'
import { createClipboardPendingFile, createClipboardTextDraft, makeUniqueAttachmentName } from '@/lib/clipboard-text-attachment'
import { canSwitchAgentProject } from '@/lib/agent-project-switch'
import { getEffectivePermissionMode } from '@/lib/agent-plan-mode'
import {
  derivePersistedAgentContextUsage,
  resolveAgentContextPolicy,
} from '@/lib/agent-context-usage'
import {
  findAgentRuntimeModel,
  normalizeAgentThinkingEffortLevel,
  resolveAgentRuntimeThinkingSelection,
  resolveAgentThinkingEffortCapability,
} from '@/lib/agent-thinking-effort'
import {
  buildQueuedMessageSendPayload,
  canAutoSendQueuedAgentMessage,
  createAgentQueuedMessage,
  moveQueuedMessage,
  parseQueuedMessageMentions,
  queuedTextToParagraphHtml,
  removeQueuedMessage,
  restoreQueuedMessageToFront,
  shouldDeferAgentMessage,
} from '@/lib/agent-message-queue'
import type { AgentQueuedAttachment, AgentQueuedMessage, QueueDropPlacement } from '@/lib/agent-message-queue'
import { useSessionFloatingLayout } from '@/hooks/useSessionFloatingLayout'
import { useSessionFloatingRuntimeLifecycle } from '@/hooks/useSessionFloatingRuntimeLifecycle'

/** 稳定的空 SDKMessage 数组引用，避免 ?? [] 每次创建新引用 */
const EMPTY_SDK_MESSAGES: SDKMessage[] = []
const LONG_TEXT_ATTACHMENT_THRESHOLD = 2000

interface OptimisticSDKUserMessage extends SDKUserMessage {
  _createdAt: number
}

interface PreparedAgentAttachment {
  referenceBlock: string
  attachments: AgentQueuedAttachment[]
  additionalDirectories: string[]
}

function createUserSDKMessage(text: string, uuid?: string, createdAt = Date.now()): SDKMessage {
  const message: OptimisticSDKUserMessage = {
    type: 'user',
    uuid,
    message: {
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    _createdAt: createdAt,
  }
  return message
}

function resolveRunContextWindow(
  modelInfo: AgentRuntimeModelInfo | undefined,
  previous: number | undefined,
): number | undefined {
  return modelInfo?.contextWindow ?? previous
}

/** 新 Turn 只重置流式展示字段，保留当前会话的上下文用量和 Runtime 压缩配置。 */
function preserveAgentContextState(
  previous: AgentStreamState | undefined,
  contextWindow = previous?.contextWindow,
): Partial<AgentStreamState> {
  return {
    inputTokens: previous?.inputTokens,
    outputTokens: previous?.outputTokens,
    cacheReadTokens: previous?.cacheReadTokens,
    cacheCreationTokens: previous?.cacheCreationTokens,
    cumulativeInputTokens: previous?.cumulativeInputTokens,
    cumulativeCacheReadTokens: previous?.cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens: previous?.cumulativeCacheCreationTokens,
    costUsd: previous?.costUsd,
    contextWindow,
    contextUsageIsEstimated: previous?.contextUsageIsEstimated,
    autoCompactEnabled: previous?.autoCompactEnabled,
    autoCompactThreshold: previous?.autoCompactThreshold,
    effectiveContextWindow: previous?.effectiveContextWindow,
  }
}

interface SDKMessageRecord {
  type?: string
  uuid?: string
  parent_tool_use_id?: string | null
  isSynthetic?: boolean
  error?: unknown
  message?: {
    content?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getUserTextFromSDKMessage(message: SDKMessage): string | null {
  const sdkMessage = message as unknown as SDKMessageRecord
  if (sdkMessage.type !== 'user' || sdkMessage.parent_tool_use_id || sdkMessage.isSynthetic) {
    return null
  }

  const content = sdkMessage.message?.content
  if (!Array.isArray(content)) return null
  if (content.some((block) => isRecord(block) && block.type === 'tool_result')) return null

  const texts = content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)

  return texts.length > 0 ? texts.join('\n') : null
}

function removeRetriedErrorSDKMessage(messages: SDKMessage[], errorUuid: string | undefined): SDKMessage[] {
  if (!errorUuid) return messages
  const next = messages.filter((message) => {
    const record = message as unknown as SDKMessageRecord
    return !(record.type === 'assistant' && record.uuid === errorUuid && record.error !== undefined && record.error !== null)
  })
  return next.length === messages.length ? messages : next
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTransientAgentRuntimeStateError(error: unknown): boolean {
  const message = getErrorMessage(error)
  return message.includes('会话未运行，无法追加消息') ||
    message.includes('无活跃消息通道可注入队列消息') ||
    message.includes('当前没有可介入的活跃 Turn') ||
    message.includes('暂不支持在当前 Turn 内追加普通等待消息') ||
    message.includes('暂不支持同一 Query 内的队列消息') ||
    message.includes('当前 Runtime 不支持队列消息') ||
    message.includes('上一条消息仍在处理中') ||
    message.includes('会话正在运行中')
}

export function AgentView({ sessionId }: { sessionId: string }): React.ReactElement {
  const sessionViewportRef = React.useRef<HTMLDivElement>(null)
  const floatingPanelEnabled = useAtomValue(agentFloatingPanelEnabledAtom)
  const floatingPanelForcedSessions = useAtomValue(agentFloatingPanelForcedSessionsAtom)
  const setFloatingPanelForcedSessions = useSetAtom(agentFloatingPanelForcedSessionsAtom)
  const setFloatingPanelVisibleSessions = useSetAtom(agentFloatingPanelVisibleSessionsAtom)
  const floatingPanelForced = floatingPanelForcedSessions.has(sessionId)
  const clearFloatingPanelForce = React.useCallback(() => {
    setFloatingPanelForcedSessions((previous) => {
      if (!previous.has(sessionId)) return previous
      const next = new Set(previous)
      next.delete(sessionId)
      return next
    })
  }, [sessionId, setFloatingPanelForcedSessions])
  const floatingLayout = useSessionFloatingLayout(
    sessionViewportRef,
    floatingPanelEnabled,
    floatingPanelForced,
    clearFloatingPanelForce,
  )
  React.useEffect(() => {
    setFloatingPanelVisibleSessions((previous) => {
      const isVisible = previous.has(sessionId)
      if (isVisible === floatingLayout.visible) return previous

      const next = new Set(previous)
      if (floatingLayout.visible) {
        next.add(sessionId)
      } else {
        next.delete(sessionId)
      }
      return next
    })

    return () => {
      setFloatingPanelVisibleSessions((previous) => {
        if (!previous.has(sessionId)) return previous
        const next = new Set(previous)
        next.delete(sessionId)
        return next
      })
    }
  }, [floatingLayout.visible, sessionId, setFloatingPanelVisibleSessions])
  const [persistedSDKMessages, setPersistedSDKMessages] = React.useState<SDKMessage[]>([])
  const persistedSDKMessagesRef = React.useRef<SDKMessage[]>([])
  persistedSDKMessagesRef.current = persistedSDKMessages
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  // 按 sessionId 切片订阅：仅本 session 的 streaming state 变化才让 AgentView 重渲染。
  // 流式期间其他 session 的高频更新（每 token 一次）通过 base map atom 传播但派生
  // atom 输出引用未变，订阅者跳过通知。
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const streaming = streamState?.running ?? false
  const stopping = streamState?.stopping ?? false
  useSessionFloatingRuntimeLifecycle(sessionId)
  // 软空闲态：本轮主体已结束、UI 可输入，但 SDK 通道仍开着等后台任务唤醒。
  // 此时服务端 activeSessions 仍保留，新消息须走注入通道而非新建 run。
  const backgroundWaiting = streamState?.backgroundWaiting ?? false
  const stoppedByUserSessions = useAtomValue(stoppedByUserSessionsAtom)
  const sendWithCmdEnter = useAtomValue(sendWithCmdEnterAtom)
  const longTextPasteAsAttachmentEnabled = useAtomValue(longTextPasteAsAttachmentEnabledAtom)
  const stoppedByUser = stoppedByUserSessions.has(sessionId)
  const setLiveMessagesMap = useSetAtom(liveMessagesMapAtom)
  // 稳定化空数组引用，避免 ?? [] 每次创建新引用导致下游 useMemo 链不必要重算
  const liveMessages = useAtomValue(agentSessionLiveMessagesAtomFamily(sessionId))
    ?? EMPTY_SDK_MESSAGES
  // Per-session 渠道/模型配置（优先读 session map，回退到全局默认值）
  const sessionChannelMap = useAtomValue(agentSessionChannelMapAtom)
  const sessionModelMap = useAtomValue(agentSessionModelMapAtom)
  const setSessionChannelMap = useSetAtom(agentSessionChannelMapAtom)
  const setSessionModelMap = useSetAtom(agentSessionModelMapAtom)
  const [defaultChannelId, setDefaultChannelId] = useAtom(agentChannelIdAtom)
  const [defaultModelId, setDefaultModelId] = useAtom(agentModelIdAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const sessionMeta = React.useMemo(
    () => sessions.find((s) => s.id === sessionId),
    [sessions, sessionId],
  )
  const sessionMetaChannelId = sessionMeta?.channelId
  const sessionMetaModelId = sessionMeta?.modelId
  const hasSessionMeta = Boolean(sessionMeta)
  const globalChannels = useAtomValue(channelsAtom)
  // App 会话只认已启用的 App 渠道；CLI 共用配置与未启用渠道不进入下拉/发送。
  const agentChannelId = React.useMemo(() => {
    const candidate = resolveAppAgentChannelId(
      sessionMetaChannelId
      ?? sessionChannelMap.get(sessionId)
      ?? defaultChannelId,
    )
    if (!candidate) return null
    const channel = globalChannels.find(item => item.id === candidate)
    return channel?.enabled ? candidate : null
  }, [
    defaultChannelId,
    globalChannels,
    sessionChannelMap,
    sessionId,
    sessionMetaChannelId,
  ])
  const agentModelId = sessionMetaModelId ?? sessionModelMap.get(sessionId) ?? defaultModelId
  const agentChannelIds = useAtomValue(agentChannelIdsAtom)
  const [agentThinking, setAgentThinking] = useAtom(agentThinkingAtom)
  const [agentThinkingEffortLevel, setAgentThinkingEffortLevel] = useAtom(agentThinkingEffortLevelAtom)
  const [sessionThinkingEffortMap, setSessionThinkingEffortMap] = useAtom(agentSessionThinkingEffortMapAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)
  const globalWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setGlobalWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  // 从会话元数据派生 workspaceId：会话数据已加载时以自身为准，未加载时回退全局 atom
  const currentWorkspaceId = React.useMemo(() => {
    if (!sessionMeta) return globalWorkspaceId // 数据未加载，回退全局
    return sessionMeta.workspaceId ?? null     // 数据已加载，以会话自身为准
  }, [sessionMeta, globalWorkspaceId])
  const referenceableSessionIds = React.useMemo(
    () => sessions
      .filter((candidate) => candidate.id !== sessionId)
      .map((candidate) => candidate.id),
    [sessions, sessionId],
  )
  const [pendingPrompt, setPendingPrompt] = useAtom(agentPendingPromptAtom)
  const [pendingFiles, setPendingFiles] = useAtom(agentPendingFilesAtomFamily(sessionId))
  const browserAnnotations = useAtomValue(browserAnnotationsAtomFamily(sessionId))
  const selectedBrowserAnnotationIds = useAtomValue(browserSelectedAnnotationIdsAtomFamily(sessionId))
  const selectedBrowserAnnotations = React.useMemo(
    () => browserAnnotations.filter((annotation) => selectedBrowserAnnotationIds.has(browserAnnotationKey(annotation))),
    [browserAnnotations, selectedBrowserAnnotationIds],
  )
  const [queuedMessages, setQueuedMessages] = useAtom(agentMessageQueueAtomFamily(sessionId))
  const [workspaces, setAgentWorkspaces] = useAtom(agentWorkspacesAtom)
  // 保持 channelId 稳定：初始化前使用上次有效值，避免工具栏抖动
  const stableChannelIdRef = React.useRef(agentChannelId)
  if (agentChannelId) stableChannelIdRef.current = agentChannelId
  const stableChannelId = agentChannelId ?? stableChannelIdRef.current

  // 已有会话首次打开时，从会话元数据初始化 per-session map。
  // setter 内的 `prev.has(sessionId)` 守卫保证幂等，外层不再订阅 Map atom，
  // 避免 setter 写入 → atom 引用变化 → effect 重跑的自循环（React #185）。
  // 只有会话元数据尚未加载时，才允许使用全局默认值初始化新会话。
  React.useEffect(() => {
    if (!sessionId) return
    const initialChannelId = sessionMetaChannelId ?? (!hasSessionMeta ? defaultChannelId : undefined)
    const initialModelId = sessionMetaModelId ?? (!hasSessionMeta ? defaultModelId : undefined)
    if (initialChannelId) {
      setSessionChannelMap((prev) => {
        if (prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.set(sessionId, initialChannelId)
        return map
      })
    }
    if (initialModelId) {
      setSessionModelMap((prev) => {
        if (prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.set(sessionId, initialModelId)
        return map
      })
    }
  }, [sessionId, sessionMetaChannelId, sessionMetaModelId, hasSessionMeta, defaultChannelId, defaultModelId, setSessionChannelMap, setSessionModelMap])

  const sessionContextStatus: AgentContextStatus = {
    isCompacting: streamState?.isCompacting ?? false,
    inputTokens: streamState?.inputTokens,
    outputTokens: streamState?.outputTokens,
    cacheReadTokens: streamState?.cacheReadTokens,
    cacheCreationTokens: streamState?.cacheCreationTokens,
    cumulativeInputTokens: streamState?.cumulativeInputTokens,
    cumulativeCacheReadTokens: streamState?.cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens: streamState?.cumulativeCacheCreationTokens,
    costUsd: streamState?.costUsd,
    contextWindow: streamState?.contextWindow,
    contextUsageIsEstimated: streamState?.contextUsageIsEstimated,
    autoCompactEnabled: streamState?.autoCompactEnabled,
    autoCompactThreshold: streamState?.autoCompactThreshold,
    effectiveContextWindow: streamState?.effectiveContextWindow,
  }

  const restorePersistedContextUsage = React.useCallback((messages: SDKMessage[]): void => {
    const restored = derivePersistedAgentContextUsage(messages)
    if (!restored) return
    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (current?.running) return prev
      const map = new Map(prev)
      map.set(sessionId, {
        running: false,
        backgroundWaiting: current?.backgroundWaiting,
        content: '',
        toolActivities: [],
        model: current?.model,
        ...preserveAgentContextState(current),
        ...restored,
        contextCompaction: current?.contextCompaction,
      })
      return map
    })
  }, [sessionId, setStreamingStates])
  const setAgentStreamErrors = useSetAtom(agentStreamErrorsAtom)
  const streamErrors = useAtomValue(agentStreamErrorsAtom)
  const agentError = streamErrors.get(sessionId) ?? null
  const planModeSessions = useAtomValue(agentPlanModeSessionsAtom)
  const setPlanModeSessions = useSetAtom(agentPlanModeSessionsAtom)
  const persistedPlanModeEnabled = useAtomValue(sessionPersistedPlanModeEnabledAtom(sessionId))
  const isPlanMode = planModeSessions.has(sessionId) || persistedPlanModeEnabled
  const permissionModeMap = useAtomValue(agentPermissionModeMapAtom)
  const defaultPermissionMode = useAtomValue(agentDefaultPermissionModeAtom)
  const persistedPermissionMode = useAtomValue(sessionPersistedPermissionModeAtom(sessionId))
  const permissionMode = permissionModeMap.get(sessionId) ?? persistedPermissionMode ?? defaultPermissionMode
  const effectivePermissionMode = getEffectivePermissionMode(permissionMode, isPlanMode)
  const store = useStore()
  const currentQuotedSelection = useAtomValue(currentQuotedSelectionAtom)
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)
  const openPreview = useOpenPreview()

  /** 移除当前引用选中文本 */
  const handleRemoveQuotedSelection = React.useCallback(() => {
    setQuotedSelectionMap((prev) => {
      const m = new Map(prev)
      m.delete(sessionId)
      return m
    })
  }, [sessionId, setQuotedSelectionMap])

  /** 消费当前引用选区，用于把引用快照固定到本次发送/队列消息中 */
  const consumeQuotedSelection = React.useCallback((): QuotedSelection | null => {
    const quotedSelection = store.get(quotedSelectionMapAtom).get(sessionId) ?? null
    if (!quotedSelection) return null

    const capturedAt = quotedSelection.capturedAt
    store.set(quotedSelectionMapAtom, (prev) => {
      const m = new Map(prev)
      const current = m.get(sessionId)
      if (current && current.capturedAt === capturedAt) m.delete(sessionId)
      return m
    })
    return quotedSelection
  }, [sessionId, store])

  const suggestionsMap = useAtomValue(agentPromptSuggestionsAtom)
  const suggestion = suggestionsMap.get(sessionId) ?? null
  const setPromptSuggestions = useSetAtom(agentPromptSuggestionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const openSession = useOpenSession()
  const { createAgent } = useCreateSession()
  const setAttachedDirsMap = useSetAtom(agentAttachedDirectoriesMapAtom)
  const attachedDirsMap = useAtomValue(agentAttachedDirectoriesMapAtom)
  const attachedDirs = attachedDirsMap.get(sessionId) ?? []
  const setAttachedFilesMap = useSetAtom(agentAttachedFilesMapAtom)
  const attachedFilesMap = useAtomValue(agentAttachedFilesMapAtom)
  const attachedFiles = attachedFilesMap.get(sessionId) ?? []
  const wsAttachedDirsMap = useAtomValue(workspaceAttachedDirectoriesMapAtom)
  const wsAttachedDirs = currentWorkspaceId ? (wsAttachedDirsMap.get(currentWorkspaceId) ?? []) : []
  const setWsAttachedFilesMap = useSetAtom(workspaceAttachedFilesMapAtom)
  const wsAttachedFilesMap = useAtomValue(workspaceAttachedFilesMapAtom)
  const wsAttachedFiles = currentWorkspaceId ? (wsAttachedFilesMap.get(currentWorkspaceId) ?? []) : []

  /** 独立切换计划模式；审批模式保持原值，运行中由 Main 热同步到当前 Runtime。 */
  const handlePlanModeChange = React.useCallback(async (enabled: boolean): Promise<void> => {
    const previous = isPlanMode
    setPlanModeSessions((prev) => {
      const next = new Set(prev)
      if (enabled) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
    setAgentSessions((prev) => prev.map((session) =>
      session.id === sessionId ? { ...session, planModeEnabled: enabled } : session
    ))

    try {
      await window.electronAPI.updateSessionPlanMode(sessionId, enabled)
    } catch (error) {
      console.error('[AgentView] 切换计划模式失败，回滚 UI:', error)
      setPlanModeSessions((prev) => {
        const next = new Set(prev)
        if (previous) next.add(sessionId)
        else next.delete(sessionId)
        return next
      })
      setAgentSessions((prev) => prev.map((session) =>
        session.id === sessionId ? { ...session, planModeEnabled: previous } : session
      ))
      toast.error('切换计划模式失败')
    }
  }, [isPlanMode, sessionId, setAgentSessions, setPlanModeSessions])

  // 按 sessionId 切片订阅 drafts/draftHtml：仅本 session 草稿变化才让 AgentView 重渲染。
  // 输入框每次按键都会写整 Map atom，若直接订阅整 Map，AgentView 跟着每键重渲染。
  const inputContent = useAtomValue(agentSessionDraftAtomFamily(sessionId))
  const setDraftsMap = useSetAtom(agentSessionDraftsAtom)
  const setInputContent = React.useCallback((value: string) => {
    setDraftsMap((prev) => {
      const map = new Map(prev)
      if (value.trim() === '') {
        map.delete(sessionId)
      } else {
        map.set(sessionId, value)
      }
      return map
    })
  }, [sessionId, setDraftsMap])
  const inputHtmlContent = useAtomValue(agentSessionDraftHtmlAtomFamily(sessionId))
  const setDraftHtmlMap = useSetAtom(agentSessionDraftHtmlAtom)
  const setInputHtmlContent = React.useCallback((html: string) => {
    setDraftHtmlMap((prev) => {
      const map = new Map(prev)
      if (!html || html === '<p></p>') {
        map.delete(sessionId)
      } else {
        map.set(sessionId, html)
      }
      return map
    })
  }, [sessionId, setDraftHtmlMap])
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const setSessionPathMap = useSetAtom(agentSessionPathMapAtom)
  const sessionPath = sessionPathMap.get(sessionId) ?? null
  const [workspaceFilesPath, setWorkspaceFilesPath] = React.useState<string | null>(null)
  const [isDragOver, setIsDragOver] = React.useState(false)
  const [errorCopied, setErrorCopied] = React.useState(false)
  const [projectChanging, setProjectChanging] = React.useState(false)

  // pendingFiles ref（供 addFilesAsAttachments 读取最新列表，避免闭包旧值）
  const pendingFilesRef = React.useRef(pendingFiles)
  React.useEffect(() => {
    pendingFilesRef.current = pendingFiles
  }, [pendingFiles])

  // 渠道已选但模型未选时，自动选择第一个可用模型
  const [runtimeModelCatalogs, setRuntimeModelCatalogs] = useAtom(
    agentRuntimeModelCatalogsAtom,
  )
  const runtimeModelCatalogRevision = useAtomValue(
    agentRuntimeModelCatalogRevisionAtom,
  )
  const [runtimeModelsLoading, setRuntimeModelsLoading] = React.useState(false)
  const activeAgentChannel = React.useMemo(
    () => globalChannels.find((channel) => channel.id === agentChannelId),
    [agentChannelId, globalChannels],
  )
  const runtimeCatalogRequestSignature = React.useMemo(
    () => `${agentChannelId}:${activeAgentChannel?.updatedAt ?? 0}:${runtimeModelCatalogRevision}`,
    [
      activeAgentChannel?.updatedAt,
      agentChannelId,
      runtimeModelCatalogRevision,
    ],
  )
  React.useEffect(() => {
    let cancelled = false
    let requestInFlight = false

    const loadCatalogs = async (showLoading: boolean): Promise<void> => {
      if (!agentChannelId) {
        if (showLoading) setRuntimeModelsLoading(false)
        return
      }
      if (requestInFlight) return
      requestInFlight = true
      if (showLoading) setRuntimeModelsLoading(true)
      try {
        const catalog =
          await window.electronAPI.getAgentRuntimeModelCatalog(
            agentChannelId,
            undefined,
            currentWorkspaceId ?? undefined,
          )
        if (cancelled) return
        setRuntimeModelCatalogs((previous) => {
          const catalogKey = getAgentRuntimeModelCatalogKey(
            currentWorkspaceId,
            agentChannelId,
          )
          const existing = previous.get(catalogKey)
          if (
            existing
            && existing.runtimeArtifactCommit === catalog.runtimeArtifactCommit
            && existing?.runtimeVersion === catalog.runtimeVersion
            && existing?.defaultModel === catalog.defaultModel
            && JSON.stringify(existing.models) === JSON.stringify(catalog.models)
          ) {
            return previous
          }
          const next = new Map(previous)
          next.set(catalogKey, catalog)
          next.set(
            getAgentRuntimeModelCatalogKey(currentWorkspaceId, catalog.channelId),
            catalog,
          )
          return next
        })
      } catch (error) {
        if (cancelled) return
        console.error(
          `[AgentView] Runtime 模型目录加载失败: channel=${agentChannelId}`,
          error,
        )
        setRuntimeModelCatalogs((previous) => {
          const catalogKey = getAgentRuntimeModelCatalogKey(
            currentWorkspaceId,
            agentChannelId,
          )
          if (!previous.has(catalogKey)) return previous
          const next = new Map(previous)
          next.delete(catalogKey)
          return next
        })
      } finally {
        requestInFlight = false
        if (!cancelled && showLoading) setRuntimeModelsLoading(false)
      }
    }

    void loadCatalogs(true)
    // Runtime CLI 可能在桌面端运行期间更新用户级或项目级配置。
    // Main 会按配置内容指纹命中缓存，因此轮询只产生轻量 IPC，不会重复解析 Runtime。
    const refreshTimer = window.setInterval(() => {
      void loadCatalogs(false)
    }, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(refreshTimer)
    }
  }, [
    runtimeCatalogRequestSignature,
    currentWorkspaceId,
    setRuntimeModelCatalogs,
  ])

  const runtimeModelOptions = React.useMemo<ModelOption[]>(
    () => {
      const catalog = agentChannelId
        ? runtimeModelCatalogs.get(
            getAgentRuntimeModelCatalogKey(currentWorkspaceId, agentChannelId),
          )
        : undefined
      // App 下拉只展示当前启用渠道内已启用的模型；CLI 共用配置不参与。
      return buildAgentAppModelOptions({
        channelId: agentChannelId,
        catalog,
        channels: globalChannels,
      })
    },
    [agentChannelId, currentWorkspaceId, globalChannels, runtimeModelCatalogs],
  )
  const selectedRuntimeModel = React.useMemo(
    () => {
      if (!agentChannelId || !agentModelId) return undefined
      return findAgentRuntimeModel(
        runtimeModelCatalogs.get(
          getAgentRuntimeModelCatalogKey(currentWorkspaceId, agentChannelId),
        )?.models ?? [],
        agentModelId,
      )
    },
    [agentChannelId, agentModelId, currentWorkspaceId, runtimeModelCatalogs],
  )
  const selectedRuntimeCatalog = React.useMemo(
    () =>
      agentChannelId
        ? runtimeModelCatalogs.get(
            getAgentRuntimeModelCatalogKey(currentWorkspaceId, agentChannelId),
          )
        : undefined,
    [agentChannelId, currentWorkspaceId, runtimeModelCatalogs],
  )
  const selectedContextPolicy = React.useMemo(
    () => resolveAgentContextPolicy(selectedRuntimeCatalog, agentModelId),
    [agentModelId, selectedRuntimeCatalog],
  )
  const contextStatus: AgentContextStatus = {
    ...sessionContextStatus,
    contextWindow:
      selectedContextPolicy?.contextWindow
      ?? sessionContextStatus.contextWindow
      ?? selectedRuntimeModel?.contextWindow,
    autoCompactEnabled:
      selectedRuntimeCatalog?.contextPolicy.autoCompactEnabled
      ?? sessionContextStatus.autoCompactEnabled,
    autoCompactThreshold:
      selectedContextPolicy?.autoCompactThreshold
      ?? sessionContextStatus.autoCompactThreshold,
    effectiveContextWindow:
      selectedContextPolicy?.effectiveContextWindow
      ?? sessionContextStatus.effectiveContextWindow,
  }
  const thinkingEffortCapability = React.useMemo(
    () => resolveAgentThinkingEffortCapability(selectedRuntimeModel),
    [selectedRuntimeModel],
  )
  const sessionThinkingEffortLevel = sessionThinkingEffortMap.get(sessionId)
  const effectiveThinkingEffortLevel = normalizeAgentThinkingEffortLevel(
    thinkingEffortCapability,
    sessionThinkingEffortLevel ?? agentThinkingEffortLevel,
  )
  const runtimeThinking = React.useMemo<NonNullable<AgentSendInput['runtimeThinking']>>(
    () => resolveAgentRuntimeThinkingSelection(
      selectedRuntimeModel,
      agentThinking,
      effectiveThinkingEffortLevel,
    ),
    [agentThinking, effectiveThinkingEffortLevel, selectedRuntimeModel],
  )

  const stableChannel = React.useMemo(
    () => stableChannelId ? globalChannels.find((channel) => channel.id === stableChannelId) : undefined,
    [globalChannels, stableChannelId],
  )
  const planQuotaChannelId = stableChannel && supportsChannelPlanQuota(stableChannel)
    ? stableChannel.id
    : null
  const planQuotaChannelUpdatedAt = planQuotaChannelId ? stableChannel?.updatedAt : undefined
  const hasAvailableModel = runtimeModelOptions.length > 0
  React.useEffect(() => {
    if (!agentChannelId) return

    const catalog = runtimeModelCatalogs.get(
      getAgentRuntimeModelCatalogKey(currentWorkspaceId, agentChannelId),
    )
    if (!catalog) return

    const resolvedChannelId = catalog.channelId
    const normalizedCurrentModel = agentModelId?.replace(/\[1m\]$/i, '')
    const currentCatalogModel = catalog.models.find(model =>
      model.value === agentModelId || model.value === normalizedCurrentModel,
    )
    const resolvedModelId =
      currentCatalogModel?.value
      ?? catalog.defaultModel
      ?? catalog.models[0]?.value
    if (!resolvedModelId) return

    if (resolvedChannelId !== agentChannelId) {
      setSessionChannelMap((prev) => {
        if (prev.get(sessionId) === resolvedChannelId) return prev
        const map = new Map(prev)
        map.set(sessionId, resolvedChannelId)
        return map
      })
    }
    if (resolvedModelId !== agentModelId) {
      setSessionModelMap((prev) => {
        if (prev.get(sessionId) === resolvedModelId) return prev
        const map = new Map(prev)
        map.set(sessionId, resolvedModelId)
        return map
      })
    }

    if (
      defaultChannelId !== resolvedChannelId
      || defaultModelId !== resolvedModelId
    ) {
      setDefaultChannelId(resolvedChannelId)
      setDefaultModelId(resolvedModelId)
      window.electronAPI.updateSettings({
        agentChannelId: resolvedChannelId,
        agentModelId: resolvedModelId,
      }).catch(console.error)
    }

    if (
      sessionMeta
      && (
        sessionMeta.channelId !== resolvedChannelId
        || sessionMeta.modelId !== resolvedModelId
      )
    ) {
      setAgentSessions((previous) => previous.map((session) => (
        session.id === sessionId
          ? {
              ...session,
              channelId: resolvedChannelId,
              modelId: resolvedModelId,
            }
          : session
      )))
      window.electronAPI
        .updateAgentSessionModel(
          sessionId,
          resolvedChannelId,
          resolvedModelId,
        )
        .then((updated) => {
          setAgentSessions((previous) => previous.map((session) => (
            session.id === updated.id ? updated : session
          )))
        })
        .catch(console.error)
    }
  }, [
    agentChannelId,
    agentModelId,
    defaultChannelId,
    defaultModelId,
    currentWorkspaceId,
    runtimeModelCatalogs,
    sessionId,
    sessionMeta,
    setAgentSessions,
    setDefaultModelId,
    setDefaultChannelId,
    setSessionChannelMap,
    setSessionModelMap,
  ])

  // 获取当前 session 的工作路径（文件浏览器需要）
  React.useEffect(() => {
    if (!currentWorkspaceId) {
      setSessionPathMap((prev) => {
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })
      return
    }

    window.electronAPI
      .getAgentSessionPath(currentWorkspaceId, sessionId)
      .then((path) => {
        if (path) {
          setSessionPathMap((prev) => {
            const map = new Map(prev)
            map.set(sessionId, path)
            return map
          })
        } else {
          setSessionPathMap((prev) => {
            const map = new Map(prev)
            map.delete(sessionId)
            return map
          })
        }
      })
      .catch(() => {
        setSessionPathMap((prev) => {
          const map = new Map(prev)
          map.delete(sessionId)
          return map
        })
      })
  }, [sessionId, currentWorkspaceId, setSessionPathMap])

  // 获取工作区共享文件目录路径（@ 引用时需要搜索）
  const workspaceSlug = workspaces.find((w) => w.id === currentWorkspaceId)?.slug ?? null
  React.useEffect(() => {
    if (!workspaceSlug) {
      setWorkspaceFilesPath(null)
      return
    }
    window.electronAPI
      .getWorkspaceFilesPath(workspaceSlug)
      .then(setWorkspaceFilesPath)
      .catch(() => setWorkspaceFilesPath(null))
  }, [workspaceSlug])

  // 获取工作区级附加文件（@ 引用和路径解析都需要）
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI
      .getWorkspaceAttachedFiles(workspaceSlug)
      .then((files) => {
        setWsAttachedFilesMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, files)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  // 工作区级目录（workspace shared files + 工作区级附加目录），@ 引用标记为工作区文件
  const workspaceDirs = React.useMemo(() => {
    const dirs: string[] = []
    if (workspaceFilesPath) dirs.push(workspaceFilesPath)
    for (const d of wsAttachedDirs) {
      if (!dirs.includes(d)) dirs.push(d)
    }
    return dirs
  }, [workspaceFilesPath, wsAttachedDirs])

  const attachedFileDirectories = React.useMemo(() => {
    const dirs: string[] = []
    for (const filePath of [...attachedFiles, ...wsAttachedFiles]) {
      const parent = getFileParentPath(filePath)
      if (parent && !dirs.includes(parent)) dirs.push(parent)
    }
    return dirs
  }, [attachedFiles, wsAttachedFiles])

  const workspaceMentionPaths = React.useMemo(() => {
    const paths = [...workspaceDirs]
    for (const filePath of wsAttachedFiles) {
      if (!paths.includes(filePath)) paths.push(filePath)
    }
    return paths
  }, [workspaceDirs, wsAttachedFiles])

  const sessionMentionPaths = React.useMemo(() => {
    const paths = [...attachedDirs]
    for (const filePath of attachedFiles) {
      if (!paths.includes(filePath)) paths.push(filePath)
    }
    return paths
  }, [attachedDirs, attachedFiles])

  // 合并会话级 + 工作区级附加目录，供消息区文件路径解析使用
  const allAttachedDirs = React.useMemo(() => {
    const dirs = [...attachedDirs]
    for (const d of workspaceDirs) {
      if (d && !dirs.includes(d)) dirs.push(d)
    }
    for (const filePath of [...attachedFiles, ...wsAttachedFiles]) {
      if (filePath && !dirs.includes(filePath)) dirs.push(filePath)
      const parent = getFileParentPath(filePath)
      if (parent && !dirs.includes(parent)) dirs.push(parent)
    }
    return dirs
  }, [attachedDirs, workspaceDirs, attachedFiles, wsAttachedFiles])

  const createBaseAdditionalDirectories = React.useCallback((): Set<string> => {
    const dirs = new Set(attachedDirs)
    for (const dir of attachedFileDirectories) {
      dirs.add(dir)
    }
    return dirs
  }, [attachedDirs, attachedFileDirectories])

  // 监听消息刷新版本号
  const refreshMap = useAtomValue(agentMessageRefreshAtom)
  const refreshVersion = refreshMap.get(sessionId) ?? 0

  // 持久化消息缓存 setter — 仅写入，读取时用 store.get 同步取值避免订阅触发重渲染
  const setMessagesCache = useSetAtom(agentSDKMessagesCacheAtom)
  const appendOptimisticPersistedMessage = React.useCallback((message: SDKMessage) => {
    // 切会话时优先命中内存缓存，因此乐观插入的用户消息也要同步写入缓存，
    // 否则“发送后立刻切走再切回”会短暂回退到旧消息数组。
    const next = [...persistedSDKMessagesRef.current, message]
    persistedSDKMessagesRef.current = next
    setPersistedSDKMessages(next)
    setMessagesCache((prev) => setSessionMessagesCache(prev, sessionId, next))
  }, [sessionId, setMessagesCache])

  const appendLiveUserMessage = React.useCallback((message: SDKMessage) => {
    store.set(liveMessagesMapAtom, (prev) => {
      const map = new Map(prev)
      const current = map.get(sessionId) ?? []
      map.set(sessionId, [...current, message])
      return map
    })
  }, [sessionId, store])

  const removeLiveUserMessage = React.useCallback((messageId: string) => {
    store.set(liveMessagesMapAtom, (prev) => {
      const map = new Map(prev)
      const current = (map.get(sessionId) ?? []).filter(
        (item) => (item as Record<string, unknown>).uuid !== messageId,
      )
      map.set(sessionId, current)
      return map
    })
  }, [sessionId, store])

  /**
   * 停止前先把已经显示的 assistant 内容冻结到 live projection。
   *
   * 部分 Runtime 的最新正文只存在 streamState.content，另一部分会同时
   * 推送 partial assistant 快照。若只把 streamState 标记为 stopped，停止
   * 后会同时渲染 fallback 和 SDK 消息，最终出现重复内容。
   */
  const freezeActiveAgentProjection = React.useCallback((
    state: AgentStreamState | undefined,
  ): void => {
    if (!state) return

    store.set(liveMessagesMapAtom, (prev) => {
      const map = new Map(prev)
      const current = map.get(sessionId) ?? []
      let next = markPausedAgentMessages(current)
      if (state.content) {
        next = preservePausedAgentContent(
          next,
          state.content,
          sessionId,
          state.startedAt,
          state.model,
        )
      }
      if (next !== current) {
        map.set(sessionId, next)
        return map
      }
      return prev
    })
  }, [sessionId, store])

  const clearStoppedByUser = React.useCallback(() => {
    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
    // 不清除暂停前的 liveMessages。暂停只表示上一轮不再继续生成，
    // 不是撤回上一轮已经展示的内容；下一条消息应该在旧 user/assistant
    // 之后继续生成。消息合并层会按 `_createdAt` 去重和恢复顺序。
  }, [sessionId, store])

  const queueMessageIntoActiveAgent = React.useCallback(async (
    message: AgentQueuedMessage,
    rawText: string,
    sdkText: string,
    mentions: ReturnType<typeof parseQueuedMessageMentions>,
    interruptCurrentTurn: boolean,
  ): Promise<void> => {
    // 气泡显示用原文 text（保留 /skill: #mcp: &session: 语法），
    // 让 message.tsx 的 remarkMentions 立即渲染出引用芯片；
    // 剥离后的 sdkText 仅用于传给 SDK，不作为展示文本。
    // 使用消息进入队列时的时间，而不是点击“立即发送”时的时间。
    // 这样旧 assistant 的晚到快照仍能按真实回合位置排在新 user 之前。
    const liveUserMessage = createUserSDKMessage(rawText, message.id, message.createdAt)
    ;(liveUserMessage as Record<string, unknown>)._promaQueuedDuringStreaming = true

    // steering 复用同一个 Runtime run，但 UI 需要立即进入新回合的
    // “处理中 / 已处理 N 秒 / 正在思考”状态，不能等模型首个事件到达后
    // 才刷新。startedAt 保留 Runtime 原始 run 纪元，避免旧 run 的
    // STREAM_COMPLETE 被竞态保护误拦截；turnStartedAt 只负责当前回合展示。
    const turnStartedAt = Date.now()
    const previousStreamState = store.get(agentStreamingStatesAtom).get(sessionId)
    setStreamingStates((prev) => {
      const current = prev.get(sessionId) ?? previousStreamState
      if (!current) return prev
      const map = new Map(prev)
      map.set(sessionId, beginAgentSteeredTurn(current, turnStartedAt))
      return map
    })
    appendLiveUserMessage(liveUserMessage)

    try {
      await window.electronAPI.queueAgentMessage({
        sessionId,
        userMessage: sdkText,
        rawUserMessage: rawText,
        uuid: message.id,
        interrupt: interruptCurrentTurn,
        ...(mentions.mentionedSkills.length > 0 && { mentionedSkills: mentions.mentionedSkills }),
        ...(mentions.mentionedMcpServers.length > 0 && { mentionedMcpServers: mentions.mentionedMcpServers }),
        ...(mentions.mentionedSessionIds.length > 0 && { mentionedSessionIds: mentions.mentionedSessionIds }),
      })
      store.set(beginAgentFloatingPanelTurnAtom, {
        sessionId,
        epoch: message.createdAt,
      })
    } catch (error) {
      removeLiveUserMessage(message.id)
      // 只回滚本次 steering 创建的展示状态，避免覆盖期间已经到达的
      // 新事件或由其他路径启动的下一轮。
      setStreamingStates((prev) => {
        const current = prev.get(sessionId)
        if (!current || current.turnStartedAt !== turnStartedAt) return prev
        const map = new Map(prev)
        if (previousStreamState) {
          map.set(sessionId, previousStreamState)
        } else {
          map.delete(sessionId)
        }
        return map
      })
      throw error
    }
  }, [appendLiveUserMessage, removeLiveUserMessage, sessionId, setStreamingStates, store])

  /**
   * “立即发送”不是把新问题拼接到旧回答里，而是先暂停旧回合，
   * 再以新用户消息启动一个独立回合。主进程会等待旧 Runtime 完成收尾，
   * 因此这里可以先把新回合的 UI 和用户消息展示出来。
   */
  const pauseActiveRunForImmediateMessage = React.useCallback(async (): Promise<void> => {
    const previous = store.get(agentStreamingStatesAtom).get(sessionId)
    if (!previous?.running) return

    // 先冻结 live projection 中已经到达的旧 assistant；部分 Runtime 的正文
    // 还只存在 legacy streamState.content，再补成暂停快照，避免旧内容消失。
    freezeActiveAgentProjection(previous)

    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (!current?.running) return prev
      const map = new Map(prev)
      // 旧正文已经固化到 live projection。立即发送等待 stopAgent
      // 返回期间不能继续保留 streamState.content，否则旧 live assistant
      // 与停止态 fallback 会同时渲染，出现一段时间的重复内容。
      map.set(sessionId, {
        ...markAgentStreamStopped(current),
        content: '',
      })
      return map
    })

    try {
      await window.electronAPI.stopAgent(sessionId)
      // stopAgent 返回前旧 Runtime 可能又 flush 了一批累计/增量快照；
      // 再冻结一次，确保这段收尾窗口里到达的消息不会和新回合混在一起。
      store.set(liveMessagesMapAtom, (prev) => {
        const current = prev.get(sessionId) ?? []
        const next = markPausedAgentMessages(current)
        if (next === current) return prev
        const map = new Map(prev)
        map.set(sessionId, next)
        return map
      })
    } catch (error) {
      // 停止失败时恢复旧回合，避免用户看到旧回合已停但 Runtime 仍继续输出。
      store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
      setStreamingStates((prev) => {
        const current = prev.get(sessionId)
        if (!current?.stopping) return prev
        const map = new Map(prev)
        map.set(sessionId, { ...current, running: true, stopping: false })
        return map
      })
      throw error
    }
  }, [freezeActiveAgentProjection, sessionId, setStreamingStates, store])

  const startQueuedMessageRun = React.useCallback(async (
    text: string,
    mentions: ReturnType<typeof parseQueuedMessageMentions>,
    channelId: string,
    queuedAdditionalDirectories: string[] = [],
  ): Promise<void> => {
    const streamStartedAt = Date.now()
    store.set(beginAgentFloatingPanelTurnAtom, {
      sessionId,
      epoch: streamStartedAt,
    })
    const additionalDirectoriesForRun = createBaseAdditionalDirectories()
    for (const dir of queuedAdditionalDirectories) {
      additionalDirectoriesForRun.add(dir)
    }
    setStreamingStates((prev) => {
      const map = new Map(prev)
      const existing = prev.get(sessionId)
      map.set(sessionId, {
        running: true,
        content: '',
        toolActivities: [],
        model: agentModelId || undefined,
        startedAt: streamStartedAt,
        turnStartedAt: streamStartedAt,
        ...preserveAgentContextState(existing),
      })
      return map
    })
    // 新回合已经建立后，清除旧回合的 session 级暂停标记。
    // 旧回合的暂停状态由它自己的 transcript / paused snapshot 保留，
    // 不能让该标记继续覆盖新回合的处理中状态。
    clearStoppedByUser()

    const optimisticUserMessage = createUserSDKMessage(text, undefined, streamStartedAt)
    ;(optimisticUserMessage as Record<string, unknown>)._promaQueuedDuringStreaming = true
    // 同时写入持久化投影和 live 投影：有上一轮暂停内容时，fallback
    // 能准确插在这条新 user 后面，而不是被旧 assistant 的 live 内容挡住。
    appendOptimisticPersistedMessage(optimisticUserMessage)
    appendLiveUserMessage(optimisticUserMessage)

    try {
      await window.electronAPI.sendAgentMessage({
        sessionId,
        userMessage: text,
        channelId,
        modelId: agentModelId || undefined,
        workspaceId: currentWorkspaceId || undefined,
        runtimeThinking,
        startedAt: streamStartedAt,
        permissionModeOverride: effectivePermissionMode,
        ...(additionalDirectoriesForRun.size > 0 && {
          additionalDirectories: Array.from(additionalDirectoriesForRun),
        }),
        ...(mentions.mentionedSkills.length > 0 && { mentionedSkills: mentions.mentionedSkills }),
        ...(mentions.mentionedMcpServers.length > 0 && { mentionedMcpServers: mentions.mentionedMcpServers }),
        ...(mentions.mentionedSessionIds.length > 0 && { mentionedSessionIds: mentions.mentionedSessionIds }),
        ...(selectedBrowserAnnotations.length > 0 && { browserAnnotations: selectedBrowserAnnotations }),
      })
    } catch (error) {
      setStreamingStates((prev) => {
        const current = prev.get(sessionId)
        if (!current) return prev
        const map = new Map(prev)
        map.set(sessionId, { ...current, running: false })
        return map
      })
      throw error
    }
  }, [
    agentModelId,
    appendOptimisticPersistedMessage,
    appendLiveUserMessage,
    createBaseAdditionalDirectories,
    currentWorkspaceId,
    clearStoppedByUser,
    effectivePermissionMode,
    runtimeThinking,
    sessionId,
    selectedBrowserAnnotations,
    setStreamingStates,
    store,
  ])

  const sendPlainTextAgentMessage = React.useCallback(async (
    message: AgentQueuedMessage,
  ): Promise<void> => {
    const quotedSelectionBlock = message.quotedSelection
      ? buildQuotedSelectionBlock(message.quotedSelection)
      : ''
    const payload = buildQueuedMessageSendPayload(
      message,
      quotedSelectionBlock,
      referenceableSessionIds,
    )
    if (!payload.rawText || !agentChannelId || !hasAvailableModel) return

    clearStoppedByUser()

    // 发起新一轮（含队列消息自动发送、后台续轮注入等非用户显式路径）时，
    // 清除上一轮遗留的流式错误，避免正常输出后底部仍残留旧报错。
    setAgentStreamErrors((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 运行中的立即发送：先暂停旧回合，再启动独立的新回合；
    // 后台等待态没有正在生成的正文，才走 Runtime 注入通道。
    if (streaming) {
      await pauseActiveRunForImmediateMessage()
      await startQueuedMessageRun(payload.rawText, payload.mentions, agentChannelId, message.additionalDirectories)
      return
    }

    if (backgroundWaiting) {
      try {
        await queueMessageIntoActiveAgent(message, payload.rawText, payload.sdkText, payload.mentions, false)
      } catch (error) {
        if (isTransientAgentRuntimeStateError(error)) {
          console.warn('[AgentView] 检测到陈旧的 Agent 追加通道，改为启动新一轮运行:', error)
          await startQueuedMessageRun(payload.rawText, payload.mentions, agentChannelId, message.additionalDirectories)
          return
        }
        throw error
      }
      return
    }

    await startQueuedMessageRun(payload.rawText, payload.mentions, agentChannelId, message.additionalDirectories)
  }, [
    agentChannelId,
    backgroundWaiting,
    clearStoppedByUser,
    hasAvailableModel,
    queueMessageIntoActiveAgent,
    pauseActiveRunForImmediateMessage,
    referenceableSessionIds,
    sessionId,
    setAgentStreamErrors,
    startQueuedMessageRun,
    streaming,
  ])

  // 消息是否已完成首次加载（用于 auto-send 等待）
  const [messagesLoaded, setMessagesLoaded] = React.useState(false)
  const [messagesRefreshing, setMessagesRefreshing] = React.useState(false)
  const messagesRefreshingRef = React.useRef(false)
  const loadingSessionIdRef = React.useRef<string | null>(null)

  // 历史兼容会话可能在主进程后台同步 Transcript。
  // 只有当前会话空闲时才静默替换投影；运行中继续保留 liveMessages，避免重复气泡。
  React.useEffect(() => {
    return window.electronAPI.onAgentSessionTranscriptSynced((payload) => {
      if (payload.sessionId !== sessionId) return
      if (store.get(agentStreamingStatesAtom).get(sessionId)?.running) return
      persistedSDKMessagesRef.current = payload.messages
      setPersistedSDKMessages(payload.messages)
      setMessagesLoaded(true)
      restorePersistedContextUsage(payload.messages)
      setMessagesCache((prev) =>
        setSessionMessagesCache(prev, sessionId, payload.messages),
      )
    })
  }, [restorePersistedContextUsage, sessionId, setMessagesCache, store])

  // 加载当前会话消息
  React.useEffect(() => {
    // 只有切换会话时才进入 loading 态；同一会话在流式完成后的刷新要保留当前
    // persisted/live 消息，避免“助手气泡先消失、持久化消息再恢复”的空窗跳动。
    const isSessionSwitch = loadingSessionIdRef.current !== sessionId
    if (isSessionSwitch) {
      loadingSessionIdRef.current = sessionId
      // 命中缓存则立即填充，消除「先清空 → 等 IPC 全量读盘」的可见空窗；
      // IPC 返回后仍会以最新数据覆盖。未命中才回退到清空 + loading 态。
      // 注意：refreshVersion bump（流结束/出错/rewind）不是会话切换，
      // 走 else 分支保留当前消息，并在下方 IPC 覆盖时获得最新数据。
      const cached = store.get(agentSDKMessagesCacheAtom).get(sessionId)
      if (cached) {
        setPersistedSDKMessages(cached)
        setMessagesLoaded(true)
        restorePersistedContextUsage(cached)
      } else {
        setPersistedSDKMessages([])
        setMessagesLoaded(false)
      }
    }
    messagesRefreshingRef.current = true
    setMessagesRefreshing(true)
    let cancelled = false
    window.electronAPI.getAgentSessionSDKMessages(sessionId)
      .then((sdkMsgs) => {
        if (cancelled) return
        // 写入缓存（含 LRU 淘汰，防止会话数增长导致内存无限膨胀）
        setMessagesCache((prev) => setSessionMessagesCache(prev, sessionId, sdkMsgs))
        unstable_batchedUpdates(() => {
          persistedSDKMessagesRef.current = sdkMsgs
          setPersistedSDKMessages(sdkMsgs)
          setMessagesLoaded(true)
          restorePersistedContextUsage(sdkMsgs)
          messagesRefreshingRef.current = false
          setMessagesRefreshing(false)

          // 消息加载完成后，同步清除流式展示状态和实时消息，
          // 确保 React 在一次渲染中同时显示持久化消息并移除流式气泡/实时消息，
          // 避免「实时消息已清 → 持久化消息未到」的空档闪烁
          // 注意：保留 inputTokens/contextWindow 以维持上下文用量圆环显示
          setStreamingStates((prev) => {
            const state = prev.get(sessionId)
            // 仍在运行中：不清除
            if (!state || state.running) return prev
            const map = new Map(prev)
            // 软空闲态（后台任务等待）：必须保留 backgroundWaiting 标志（否则 handleSend 误走新建 run），
            // 但展示字段 content/toolActivities 仍要清空——否则上一轮流式文本残留会被兜底气泡渲染成重复消息。
            if (state.inputTokens !== undefined) {
              // 保留 usage 数据，仅清除流式展示字段
              map.set(sessionId, {
                running: false,
                backgroundWaiting: state.backgroundWaiting,
                content: '',
                toolActivities: [],
                inputTokens: state.inputTokens,
                outputTokens: state.outputTokens,
                cacheReadTokens: state.cacheReadTokens,
                cacheCreationTokens: state.cacheCreationTokens,
                contextWindow: state.contextWindow,
                contextUsageIsEstimated: state.contextUsageIsEstimated,
                autoCompactEnabled: state.autoCompactEnabled,
                autoCompactThreshold: state.autoCompactThreshold,
                effectiveContextWindow: state.effectiveContextWindow,
                model: state.model,
                contextCompaction: state.contextCompaction,
                // 用户中断后保留 startedAt，供「你在 N 秒后停止了」计算耗时
                startedAt: store.get(stoppedByUserSessionsAtom).has(sessionId)
                  ? state.startedAt
                  : undefined,
              })
            } else if (state.backgroundWaiting || state.contextCompaction) {
              // 无 usage 数据但处于软空闲或有待展示的压缩终态时，保留必要状态。
              map.set(sessionId, {
                running: false,
                backgroundWaiting: state.backgroundWaiting,
                content: '',
                toolActivities: [],
                contextCompaction: state.contextCompaction,
                autoCompactEnabled: state.autoCompactEnabled,
                autoCompactThreshold: state.autoCompactThreshold,
                effectiveContextWindow: state.effectiveContextWindow,
                startedAt: store.get(stoppedByUserSessionsAtom).has(sessionId)
                  ? state.startedAt
                  : undefined,
              })
            } else if (store.get(stoppedByUserSessionsAtom).has(sessionId) && state.startedAt != null) {
              // 用户中断且无 usage：至少保留 startedAt 供停止文案使用
              map.set(sessionId, {
                running: false,
                content: '',
                toolActivities: [],
                model: state.model,
                startedAt: state.startedAt,
              })
            } else {
              map.delete(sessionId)
            }
            return map
          })
          setLiveMessagesMap((prev) => {
            if (!prev.has(sessionId)) return prev
            // 仍在运行中，不清除实时消息（与 streamingStates 保护逻辑一致）
            const streamingState = store.get(agentStreamingStatesAtom).get(sessionId)
            if (streamingState?.running) return prev
            // 用户中断后：不能仅因 JSONL 里「有任意 assistant」就清 live。
            // deepseek 场景下过程正文经常只存在于 live partial，而 JSONL 只有 thinking/tool。
            // 若 live 仍有未落入 JSONL 的正文/思考，保留 live，避免暂停后内容蒸发。
            const live = prev.get(sessionId) ?? []
            const isStoppedByUser = store.get(stoppedByUserSessionsAtom).has(sessionId)
            // 立即发送后新回合会清除 session 级 stoppedByUser 标记，但旧回合
            // 的暂停快照仍必须保留，直到它真正进入 JSONL。
            if (hasUnpersistedPausedAgentContent(live, sdkMsgs)) return prev
            if (isStoppedByUser && hasUnpersistedLiveAssistantNarrative(live, sdkMsgs)) return prev
            const map = new Map(prev)
            map.delete(sessionId)
            return map
          })
        })
      })
      .catch((error) => {
        if (cancelled) return
        console.error(error)
        setMessagesLoaded(true)
        messagesRefreshingRef.current = false
        setMessagesRefreshing(false)
      })
    return () => { cancelled = true }
  }, [sessionId, refreshVersion, restorePersistedContextUsage, setStreamingStates, setLiveMessagesMap, setMessagesCache, store])

  // 从会话元数据初始化可访问目录（仅冷启动水合，后续由右侧文件面板实时写入）
  React.useEffect(() => {
    const meta = sessions.find((s) => s.id === sessionId)
    const dirs = meta?.attachedDirectories ?? []
    setAttachedDirsMap((prev) => {
      const existing = prev.get(sessionId)
      if (existing != null) return prev
      const map = new Map(prev)
      if (dirs.length > 0) {
        map.set(sessionId, dirs)
      }
      return map
    })
  }, [sessionId, sessions, setAttachedDirsMap])

  // 从会话元数据初始化附加文件（仅冷启动水合，后续由 attachFile/detachFile 实时写入）
  React.useEffect(() => {
    const meta = sessions.find((s) => s.id === sessionId)
    const files = meta?.attachedFiles ?? []
    setAttachedFilesMap((prev) => {
      const existing = prev.get(sessionId)
      if (existing != null) return prev
      const map = new Map(prev)
      if (files.length > 0) {
        map.set(sessionId, files)
      }
      return map
    })
  }, [sessionId, sessions, setAttachedFilesMap])

  // 自动发送 pending prompt（从快速任务窗口或设置页触发）
  // 等待 messagesLoaded 确保消息加载完成后再插入乐观消息，避免被加载结果覆盖。
  // 使用 queueMicrotask 延迟发送：避免 setState → 重渲染 → cleanup 取消 timer 的竞态。
  React.useEffect(() => {
    if (!messagesLoaded) return
    if (!pendingPrompt) return
    if (pendingPrompt.sessionId !== sessionId) return
    if (!agentChannelId || streaming) return

    // 快照当前上下文
    const snapshot = {
      message: pendingPrompt.message,
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      additionalDirectories: Array.from(new Set([...attachedDirs, ...attachedFileDirectories, ...(pendingPrompt.additionalDirectories ?? [])])),
    }
    setPendingPrompt(null)

    queueMicrotask(() => {
      // 初始化流式状态（startedAt 由渲染进程生成，传递给主进程原样回传，确保竞态保护使用同一个值）
      const streamStartedAt = Date.now()
      setStreamingStates((prev) => {
        const map = new Map(prev)
        const existing = prev.get(sessionId)
        map.set(sessionId, {
          running: true,
          content: '',
          toolActivities: [],
          model: snapshot.modelId,
          startedAt: streamStartedAt,
          ...preserveAgentContextState(
            existing,
            resolveRunContextWindow(selectedRuntimeModel, existing?.contextWindow),
          ),
        })
        return map
      })

      // 乐观更新：SDKMessage 格式（Phase 4）
      const tempUserSDKMsg: SDKMessage = {
        type: 'user',
        message: {
          content: [{ type: 'text', text: snapshot.message }],
        },
        parent_tool_use_id: null,
        _createdAt: Date.now(),
      } as unknown as SDKMessage
      appendOptimisticPersistedMessage(tempUserSDKMsg)

      // 发送消息
      const input: AgentSendInput = {
        sessionId,
        userMessage: snapshot.message,
        channelId: snapshot.channelId,
        modelId: snapshot.modelId,
        workspaceId: snapshot.workspaceId,
        runtimeThinking,
        startedAt: streamStartedAt,
        permissionModeOverride: effectivePermissionMode,
        ...(snapshot.additionalDirectories && snapshot.additionalDirectories.length > 0 && {
          additionalDirectories: snapshot.additionalDirectories,
        }),
      }
      window.electronAPI.sendAgentMessage(input).catch((error) => {
        console.error('[AgentView] 自动发送配置消息失败:', error)
        setStreamingStates((prev) => {
          const current = prev.get(sessionId)
          if (!current) return prev
          const map = new Map(prev)
          map.set(sessionId, { ...current, running: false })
          return map
        })
      })
    })
  }, [messagesLoaded, pendingPrompt, sessionId, agentChannelId, agentModelId, selectedRuntimeModel, currentWorkspaceId, streaming, setPendingPrompt, setStreamingStates, effectivePermissionMode, runtimeThinking, attachedDirs, attachedFileDirectories])
  // ===== 附件处理 =====

  /** 为文件生成唯一文件名（避免粘贴多张图片时文件名重复导致覆盖） */
  const makeUniqueFilename = React.useCallback((originalName: string, existingNames: string[]): string => {
    return makeUniqueAttachmentName(originalName, existingNames)
  }, [])

  const attachSessionFile = React.useCallback(async (filePath: string): Promise<void> => {
    const updated = await window.electronAPI.attachFile({ sessionId, filePath })
    setAttachedFilesMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedFilesMap])

  const preparePendingFilesForSend = React.useCallback(async (
    files: AgentPendingFile[],
    additionalDirectoriesForRun: Set<string>,
  ): Promise<PreparedAgentAttachment | null> => {
    if (files.length === 0) {
      return { referenceBlock: '', attachments: [], additionalDirectories: [] }
    }

    const workspace = workspaces.find((w) => w.id === currentWorkspaceId)
    if (!workspace) {
      toast.warning('暂时无法发送附件', {
        description: '当前 Agent 会话没有绑定有效工作区。请在顶部选择工作区，或新建 Agent 会话后重新上传。',
      })
      return null
    }

    // 区分三类：
    // - 剪贴板临时草稿（isClipboardDraft）：sourcePath 指向 os.tmpdir，可能被系统清理，
    //   需读取最新内容（含预览面板 autosave 的编辑）拷贝进 session 目录持久化
    // - 侧面板真实文件（仅 sourcePath）：原地引用，不复制
    // - 新上传文件（无 sourcePath）：从内存数据保存到 session 目录
    const existingFiles = files.filter((f) => f.sourcePath && !f.isClipboardDraft)
    const clipboardDrafts = files.filter((f) => f.sourcePath && f.isClipboardDraft)
    const newFiles = files.filter((f) => !f.sourcePath)

    const allRefs: Array<{ filename: string; targetPath: string; sourceFile: AgentPendingFile }> = []
    const queuedAdditionalDirectories = new Set<string>()

    // 已有路径的文件直接引用
    for (const f of existingFiles) {
      const sourcePath = f.sourcePath!
      allRefs.push({ filename: f.filename, targetPath: sourcePath, sourceFile: f })
      const parentPath = getFileParentPath(sourcePath)
      if (parentPath) {
        additionalDirectoriesForRun.add(parentPath)
        queuedAdditionalDirectories.add(parentPath)
      }
    }

    // 剪贴板草稿：读取临时文件最新内容，转为待保存数据
    const draftFilesToSave: Array<{ sourceFile: AgentPendingFile; filename: string; data: string }> = []
    const staleDraftFiles: string[] = []
    for (const f of clipboardDrafts) {
      const sourcePath = f.sourcePath!
      const parentPath = getFileParentPath(sourcePath)
      try {
        const read = await window.electronAPI.resolveAndReadFile(sourcePath, {
          sessionId,
          candidateBasePaths: parentPath ? [parentPath] : undefined,
        })
        if (!read) {
          staleDraftFiles.push(f.filename)
          continue
        }
        const data = await fileToBase64(new File([read.content], f.filename, { type: f.mediaType }))
        draftFilesToSave.push({ sourceFile: f, filename: f.filename, data })
      } catch (error) {
        console.error('[AgentView] 读取剪贴板草稿失败:', error)
        staleDraftFiles.push(f.filename)
      }
    }
    if (staleDraftFiles.length > 0) {
      toast.error('附件数据已失效', {
        description: `请移除后重新粘贴：${staleDraftFiles.join('、')}`,
      })
      return null
    }

    // 新上传的文件 + 剪贴板草稿一并保存到 session 目录
    const inMemoryFilesToSave = newFiles.map((f) => ({
      sourceFile: f,
      filename: f.filename,
      data: window.__pendingAgentFileData?.get(f.id) || '',
    }))
    const missingDataFiles = inMemoryFilesToSave.filter((f) => !f.data).map((f) => f.filename)
    if (missingDataFiles.length > 0) {
      toast.error('附件数据已失效', {
        description: `请移除后重新添加文件：${missingDataFiles.join('、')}`,
      })
      return null
    }

    const filesToSave = [...inMemoryFilesToSave, ...draftFilesToSave]
    if (filesToSave.length > 0) {
      try {
        const saved = await window.electronAPI.saveFilesToAgentSession({
          workspaceSlug: workspace.slug,
          sessionId,
          files: filesToSave.map(({ filename, data }) => ({ filename, data })),
        })
        saved.forEach((savedFile, index) => {
          const sourceFile = filesToSave[index]?.sourceFile
          if (!sourceFile) return
          allRefs.push({ ...savedFile, sourceFile })
        })
      } catch (error) {
        console.error('[AgentView] 保存附件到 session 失败:', error)
        toast.error('附件保存失败', {
          description: '请确认当前工作区可用，或新建 Agent 会话后重新上传。',
        })
        return null
      }
    }

    if (allRefs.length === 0) {
      toast.error('附件没有成功加入消息', {
        description: '请重新上传文件，或切换到有效工作区后再试。',
      })
      return null
    }

    const refs = allRefs.map((f) => `- ${f.filename}: ${f.targetPath}`).join('\n')

    for (const f of files) {
      if (f.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(f.previewUrl)
      window.__pendingAgentFileData?.delete(f.id)
    }
    setPendingFiles([])

    return {
      referenceBlock: `<attached_files>\n${refs}\n</attached_files>\n\n`,
      attachments: allRefs.map((ref) => ({
        filename: ref.filename,
        mediaType: ref.sourceFile.mediaType,
        size: ref.sourceFile.size,
        targetPath: ref.targetPath,
      })),
      additionalDirectories: Array.from(queuedAdditionalDirectories),
    }
  }, [currentWorkspaceId, sessionId, setPendingFiles, workspaces])

  const restoreQueuedAttachmentsToPending = React.useCallback((attachments?: AgentQueuedAttachment[]): void => {
    if (!attachments || attachments.length === 0) return
    setPendingFiles((prev) => [
      ...prev,
      ...attachments.map((attachment) => ({
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        size: attachment.size,
        sourcePath: attachment.targetPath,
      })),
    ])
  }, [setPendingFiles])

  /** 将 File 对象列表添加为待发送附件 */
  const addFilesAsAttachments = React.useCallback(async (files: File[], sourcePaths?: Map<File, string>): Promise<void> => {
    // 收集已有的 pending 文件名，用于去重
    const usedNames: string[] = pendingFilesRef.current.map((f) => f.filename)

    const pathBackedFiles: string[] = []
    const rejectedLargeFiles: string[] = []

    for (const file of files) {
      try {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          const sourcePath = sourcePaths?.get(file)
          if (!sourcePath) {
            rejectedLargeFiles.push(file.name)
            continue
          }
          await attachSessionFile(sourcePath)

          const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
          const uniqueFilename = makeUniqueFilename(file.name, usedNames)
          usedNames.push(uniqueFilename)

          const pending: AgentPendingFile = {
            id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            filename: uniqueFilename,
            mediaType: file.type || 'application/octet-stream',
            size: file.size,
            previewUrl,
            sourcePath,
          }

          setPendingFiles((prev) => [...prev, pending])
          pathBackedFiles.push(uniqueFilename)
          continue
        }

        const base64 = await fileToBase64(file)
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
        const uniqueFilename = makeUniqueFilename(file.name, usedNames)
        usedNames.push(uniqueFilename)

        const pending: AgentPendingFile = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: uniqueFilename,
          mediaType: file.type || 'application/octet-stream',
          size: file.size,
          previewUrl,
        }

        if (!window.__pendingAgentFileData) {
          window.__pendingAgentFileData = new Map<string, string>()
        }
        window.__pendingAgentFileData.set(pending.id, base64)

        setPendingFiles((prev) => [...prev, pending])
      } catch (error) {
        console.error('[AgentView] 添加附件失败:', error)
      }
    }

    if (pathBackedFiles.length > 0) {
      toast.success(`已将大文件作为附加文件引用：${formatFileNames(pathBackedFiles)}`)
    }
    if (rejectedLargeFiles.length > 0) {
      toast.error(`以下文件超过 100MB 且无法取得本地路径，已跳过：${formatFileNames(rejectedLargeFiles)}`)
    }
  }, [attachSessionFile, makeUniqueFilename, setPendingFiles])

  const addLargeDialogFilesAsReferences = React.useCallback(async (files: FileDialogLargeFile[]): Promise<void> => {
    if (files.length === 0) return
    const usedNames: string[] = pendingFilesRef.current.map((f) => f.filename)
    const added: string[] = []
    const rejected: string[] = []

    for (const file of files) {
      try {
        await attachSessionFile(file.path)
        const uniqueFilename = makeUniqueFilename(file.filename, usedNames)
        usedNames.push(uniqueFilename)

        const pending: AgentPendingFile = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: uniqueFilename,
          mediaType: file.mediaType,
          size: file.size,
          sourcePath: file.path,
        }

        setPendingFiles((prev) => [...prev, pending])
        added.push(uniqueFilename)
      } catch (error) {
        console.error('[AgentView] 附加大文件失败:', error)
        rejected.push(file.filename)
      }
    }

    if (added.length > 0) {
      toast.success(`已将大文件作为附加文件引用：${formatFileNames(added)}`)
    }
    if (rejected.length > 0) {
      toast.error(`以下文件附加失败，已跳过：${formatFileNames(rejected)}`)
    }
  }, [attachSessionFile, makeUniqueFilename, setPendingFiles])

  /** 打开文件选择对话框 */
  const handleOpenFileDialog = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openFileDialog()
      const largeFiles = result.largeFiles ?? []
      const skippedFiles = result.skippedFiles ?? []
      if (result.files.length === 0 && largeFiles.length === 0 && skippedFiles.length === 0) return

      const oversized: string[] = []

      for (const fileInfo of result.files) {
        if (fileInfo.size > MAX_ATTACHMENT_SIZE) {
          oversized.push(fileInfo.filename)
          continue
        }
        const previewUrl = fileInfo.mediaType.startsWith('image/')
          ? `data:${fileInfo.mediaType};base64,${fileInfo.data}`
          : undefined

        const pending: AgentPendingFile = {
          id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          filename: fileInfo.filename,
          mediaType: fileInfo.mediaType,
          size: fileInfo.size,
          previewUrl,
        }

        if (!window.__pendingAgentFileData) {
          window.__pendingAgentFileData = new Map<string, string>()
        }
        window.__pendingAgentFileData.set(pending.id, fileInfo.data)

        setPendingFiles((prev) => [...prev, pending])
      }

      if (oversized.length > 0) {
        toast.error(`以下文件超过 100MB 且无法取得本地路径，已跳过：${formatFileNames(oversized)}`)
      }
      await addLargeDialogFilesAsReferences(largeFiles)
      if (skippedFiles.length > 0) {
        toast.warning(`以下文件无法读取，已跳过：${formatFileNames(skippedFiles.map((f) => f.filename))}`)
      }
    } catch (error) {
      console.error('[AgentView] 文件选择对话框失败:', error)
    }
  }, [addLargeDialogFilesAsReferences, setPendingFiles])

  /** 移除待发送文件 */
  const handleRemoveFile = React.useCallback((id: string): void => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id)
      if (file?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(file.previewUrl)
      }
      window.__pendingAgentFileData?.delete(id)
      return prev.filter((f) => f.id !== id)
    })
  }, [setPendingFiles])

  /** 图片附件编辑完成：用编辑后的图替换该附件（统一转为内存图片走 __pendingAgentFileData） */
  const handleAttachmentEditComplete = React.useCallback((fileId: string, editedDataUrl: string): void => {
    const base64 = editedDataUrl.split(',')[1]
    if (!base64) return
    if (!window.__pendingAgentFileData) {
      window.__pendingAgentFileData = new Map<string, string>()
    }
    window.__pendingAgentFileData.set(fileId, base64)
    setPendingFiles((prev) => prev.map((f) => {
      if (f.id !== fileId) return f
      if (f.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(f.previewUrl)
      }
      return {
        ...f,
        previewUrl: editedDataUrl,
        filename: f.filename.replace(/(\.[^.]+)?$/, '') + '_edited.png',
        mediaType: 'image/png',
        size: Math.round(base64.length * 0.75),
        // 编辑后统一当作内存图片：清除文件引用，发送时从 __pendingAgentFileData 读取最新数据
        sourcePath: undefined,
        isClipboardDraft: undefined,
      }
    }))
  }, [setPendingFiles])

  const openClipboardPreviewFile = React.useCallback((filePath: string): void => {
    const parentPath = getFileParentPath(filePath)
    openPreview(sessionId, {
      filePath,
      previewOnly: true,
      readOnly: false,
      basePaths: parentPath ? [parentPath] : undefined,
    })
  }, [sessionId, openPreview])

  /** 点击 clipboard 附件时，在当前会话的临时预览标签页中显示内容 */
  const handleClipboardPreview = React.useCallback(async (file: AgentPendingFile) => {
    if (file.sourcePath) {
      openClipboardPreviewFile(file.sourcePath)
      return
    }

    const base64 = window.__pendingAgentFileData?.get(file.id)
    if (!base64) return

    try {
      // atob 解码得到二进制字符串，需用 TextDecoder 正确还原 UTF-8 文本
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const text = new TextDecoder('utf-8').decode(bytes)
      const tmpPath = await window.electronAPI.writeClipboardPreview(file.filename, text)
      setPendingFiles((prev) => prev.map((item) => (
        item.id === file.id ? { ...item, sourcePath: tmpPath, isClipboardDraft: true } : item
      )))
      window.__pendingAgentFileData?.delete(file.id)
      openClipboardPreviewFile(tmpPath)
    } catch (error) {
      console.error('[AgentView] clipboard 预览写入失败:', error)
    }
  }, [openClipboardPreviewFile, setPendingFiles])

  const addClipboardTextDraft = React.useCallback(async (text: string): Promise<AgentPendingFile> => {
    const draft = createClipboardTextDraft(text, pendingFilesRef.current.map((f) => f.filename))
    const tmpPath = await window.electronAPI.writeClipboardPreview(draft.filename, text)
    const pending = createClipboardPendingFile(
      draft,
      tmpPath,
      `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    setPendingFiles((prev) => {
      const next = [...prev, pending]
      pendingFilesRef.current = next
      return next
    })
    return pending
  }, [setPendingFiles])

  /** 粘贴文件处理 */
  const handlePasteFiles = React.useCallback((files: File[]): void => {
    addFilesAsAttachments(files)
  }, [addFilesAsAttachments])

  /** 粘贴超长文本时转为待发送附件，避免把大段内容直接塞进输入框 */
  const handlePasteLongText = React.useCallback((text: string): void => {
    addClipboardTextDraft(text)
      .then((file) => {
        toast.success('已将超长文本转为附件', {
          description: `${file.filename}，点击附件可预览编辑。`,
        })
      })
      .catch((error) => {
        console.error('[AgentView] 超长文本转附件失败:', error)
        toast.error('超长文本转附件失败')
      })
  }, [addClipboardTextDraft])

  /** 拖放处理 */
  const handleDragOver = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = React.useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = React.useCallback(async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length === 0) return

    // 通过 preload 的 webUtils.getPathForFile 获取真实路径
    const pathMap = new Map<string, File>()
    const paths: string[] = []
    for (const f of droppedFiles) {
      try {
        const p = window.electronAPI.getPathForFile(f)
        if (p) {
          paths.push(p)
          pathMap.set(p, f)
        }
      } catch { /* 无法获取路径时忽略 */ }
    }

    if (paths.length > 0) {
      try {
        // 通过主进程检测目录 vs 文件
        const { directories, files: filePaths } = await window.electronAPI.checkPathsType(paths)

        // 拖拽的文件夹直接附加
        for (const dirPath of directories) {
          try {
            const updated = await window.electronAPI.attachDirectory({
              sessionId,
              directoryPath: dirPath,
            })
            setAttachedDirsMap((prev) => {
              const map = new Map(prev)
              map.set(sessionId, updated)
              return map
            })
            const dirName = dirPath.split('/').pop() || dirPath
            toast.success(`已添加访问目录：${dirName}`)
          } catch (error) {
            console.error('[AgentView] 拖拽添加访问目录失败:', error)
          }
        }

        // 普通文件作为附件
        const regularFiles = filePaths.map((p) => pathMap.get(p)!).filter(Boolean)
        if (regularFiles.length > 0) {
          const fileSourcePaths = new Map<File, string>()
          for (const path of filePaths) {
            const file = pathMap.get(path)
            if (file) fileSourcePaths.set(file, path)
          }
          addFilesAsAttachments(regularFiles, fileSourcePaths)
        }
      } catch (error) {
        console.error('[AgentView] 路径检测失败，回退处理:', error)
        addFilesAsAttachments(droppedFiles)
      }
    } else {
      // 无路径信息：回退，所有项按普通文件处理
      addFilesAsAttachments(droppedFiles)
    }
  }, [sessionId, addFilesAsAttachments, setAttachedDirsMap])

  /** ModelSelector 选择回调 */
  const handleModelSelect = React.useCallback((option: ModelOption): void => {
    if (streaming || backgroundWaiting) {
      toast.info('Agent 运行中，完成后再切换模型')
      return
    }

    // 更新当前会话的 per-session 配置
    setSessionChannelMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, option.channelId)
      return map
    })
    setSessionModelMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, option.modelId)
      return map
    })
    setAgentSessions((prev) => prev.map((session) => (
      session.id === sessionId
        ? { ...session, channelId: option.channelId, modelId: option.modelId }
        : session
    )))

    // 模型切换时：清除旧的 contextWindow，让 result 重新提供真实值
    setStreamingStates((prev) => {
      const state = prev.get(sessionId)
      if (!state) return prev
      const map = new Map(prev)
      map.set(sessionId, { ...state, contextWindow: undefined })
      return map
    })

    // 同时更新全局默认值（新会话继承）
    setDefaultChannelId(option.channelId)
    setDefaultModelId(option.modelId)

    // 持久化到设置
    window.electronAPI.updateSettings({
      agentChannelId: option.channelId,
      agentModelId: option.modelId,
    }).catch(console.error)

    window.electronAPI.updateAgentSessionModel(sessionId, option.channelId, option.modelId)
      .then((updated) => {
        setAgentSessions((prev) => prev.map((session) => (
          session.id === updated.id ? updated : session
        )))
      })
      .catch(console.error)

    void window.electronAPI.updateAgentRuntimeConfig(sessionId, {
      model: option.modelId,
    }).catch((error) => {
      console.error('[AgentView] 实时更新 Runtime 模型失败:', error)
    })
  }, [
    backgroundWaiting,
    sessionId,
    setAgentSessions,
    setDefaultChannelId,
    setDefaultModelId,
    setSessionChannelMap,
    setSessionModelMap,
    streaming,
  ])

  /**
   * 输入区项目选择：
   * - 空白任务直接迁移，避免额外创建无意义会话。
   * - 已有内容或正在运行的任务在目标项目中新建任务，保留当前上下文。
   */
  const canSwitchProject = canSwitchAgentProject({
    messagesLoaded,
    persistedMessageCount: persistedSDKMessages.length,
    liveMessageCount: liveMessages.length,
    runtimeSessionId: sessionMeta?.runtimeSessionId,
    streaming,
    backgroundWaiting,
  })

  const handleProjectSelect = React.useCallback(async (targetWorkspaceId: string): Promise<void> => {
    if (targetWorkspaceId === currentWorkspaceId || projectChanging) return

    const targetWorkspace = workspaces.find((workspace) => workspace.id === targetWorkspaceId)
    if (!targetWorkspace) {
      toast.error('项目不存在或已被删除')
      return
    }

    setProjectChanging(true)
    try {
      if (!canSwitchProject) {
        const createdSessionId = await createAgent({
          draft: true,
          workspaceId: targetWorkspaceId,
          channelId: agentChannelId ?? undefined,
          modelId: agentModelId ?? undefined,
        })
        if (!createdSessionId) {
          throw new Error('新任务创建失败')
        }
        setGlobalWorkspaceId(targetWorkspaceId)
        window.electronAPI.updateSettings({ agentWorkspaceId: targetWorkspaceId }).catch(console.error)
        toast.success('已在项目中新建任务', {
          description: targetWorkspace.name,
        })
        return
      }

      const updated = await window.electronAPI.moveAgentSessionToWorkspace({
        sessionId,
        targetWorkspaceId,
      })
      setAgentSessions((prev) => prev.map((session) => (
        session.id === updated.id ? updated : session
      )))
      window.electronAPI.listAgentSessions()
        .then(setAgentSessions)
        .catch((error) => {
          console.error('[AgentView] 切换项目后刷新会话列表失败:', error)
        })
      setGlobalWorkspaceId(targetWorkspaceId)
      window.electronAPI.updateSettings({ agentWorkspaceId: targetWorkspaceId }).catch(console.error)

      setSessionPathMap((prev) => {
        if (!prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })

      toast.success('已切换项目', {
        description: targetWorkspace?.name ?? '项目上下文已更新',
      })
    } catch (error) {
      console.error('[AgentView] 切换项目失败:', error)
      toast.error('切换项目失败', {
        description: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setProjectChanging(false)
    }
  }, [
    agentChannelId,
    agentModelId,
    canSwitchProject,
    createAgent,
    currentWorkspaceId,
    projectChanging,
    sessionId,
    setAgentSessions,
    setGlobalWorkspaceId,
    setSessionPathMap,
    workspaces,
  ])

  const handleProjectAdd = React.useCallback(async (): Promise<boolean> => {
    if (projectChanging) return false

    try {
      const workspace = await window.electronAPI.createAgentWorkspace()
      if (!workspace) return false
      setAgentWorkspaces((prev) => [
        workspace,
        ...prev.filter((item) => item.id !== workspace.id),
      ])

      if (!canSwitchProject) {
        const createdSessionId = await createAgent({
          draft: true,
          workspaceId: workspace.id,
          channelId: agentChannelId ?? undefined,
          modelId: agentModelId ?? undefined,
        })
        if (!createdSessionId) {
          throw new Error('新任务创建失败')
        }
        setGlobalWorkspaceId(workspace.id)
        window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
        toast.success('项目已添加并新建任务', {
          description: workspace.name,
        })
        return true
      }

      setProjectChanging(true)
      const updated = await window.electronAPI.moveAgentSessionToWorkspace({
        sessionId,
        targetWorkspaceId: workspace.id,
      })
      setAgentSessions((prev) => prev.map((session) => (
        session.id === updated.id ? updated : session
      )))
      setGlobalWorkspaceId(workspace.id)
      window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
      setSessionPathMap((prev) => {
        if (!prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })
      toast.success('项目已添加', {
        description: workspace.name,
      })
      return true
    } catch (error) {
      console.error('[AgentView] 添加项目失败:', error)
      toast.error('添加项目失败', {
        description: error instanceof Error ? error.message : '未知错误',
      })
      return false
    } finally {
      setProjectChanging(false)
    }
  }, [
    agentChannelId,
    agentModelId,
    canSwitchProject,
    createAgent,
    projectChanging,
    sessionId,
    setAgentSessions,
    setAgentWorkspaces,
    setGlobalWorkspaceId,
    setSessionPathMap,
  ])

  /** 构建 externalSelectedModel 给 ModelSelector */
  const computedSelectedModel = React.useMemo(() => {
    if (!agentChannelId || !agentModelId) return null
    return { channelId: agentChannelId, modelId: agentModelId }
  }, [agentChannelId, agentModelId])

  // 防止瞬态 null 传递给 ModelSelector（防御 overflow remount 时 stableModelInfoRef 丢失）
  const stableSelectedModelRef = React.useRef(computedSelectedModel)
  if (computedSelectedModel) stableSelectedModelRef.current = computedSelectedModel
  const externalSelectedModel = computedSelectedModel ?? stableSelectedModelRef.current

  /** 发送消息 */
  const handleSend = React.useCallback(async (overrideText?: string): Promise<void> => {
    const text = (overrideText ?? inputContent).trim()
    // 如果输入为空但有建议，使用建议内容
    const effectiveText = text || suggestion || ''
    const pendingFilesSnapshot = pendingFilesRef.current
    if (!messagesLoaded || (!effectiveText && pendingFilesSnapshot.length === 0) || !agentChannelId || !hasAvailableModel) return
    const shouldDeferMessage = shouldDeferAgentMessage({
      streaming,
      stopping,
      messagesRefreshing: messagesRefreshingRef.current,
    })
    const additionalDirectoriesForRun = createBaseAdditionalDirectories()

    if (shouldDeferMessage) {
      // Agent 正在输出，或用户已点击暂停但 Runtime 尚未完全收尾时，
      // 消息立即进入 Proma 托管队列。输入框保持可用，旧回合完成后自动续跑。
      const attachmentContext = pendingFilesSnapshot.length > 0
        ? await preparePendingFilesForSend(pendingFilesSnapshot, additionalDirectoriesForRun)
        : null
      if (pendingFilesSnapshot.length > 0 && !attachmentContext) return

      const quotedSelection = consumeQuotedSelection()
      setQueuedMessages((prev) => [
        ...prev,
        createAgentQueuedMessage(effectiveText, crypto.randomUUID(), Date.now(), quotedSelection, attachmentContext
          ? {
              fileReferenceBlock: attachmentContext.referenceBlock,
              attachments: attachmentContext.attachments,
              additionalDirectories: attachmentContext.additionalDirectories,
            }
          : undefined),
      ])
      if (overrideText === undefined) {
        setInputContent('')
        setInputHtmlContent('')
      }
      setPromptSuggestions((prev) => {
        if (!prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })

      return
    }

    if (backgroundWaiting) {
      // 软空闲态没有活跃输出，直接注入，无需中断。
      const attachmentContext = pendingFilesSnapshot.length > 0
        ? await preparePendingFilesForSend(pendingFilesSnapshot, additionalDirectoriesForRun)
        : null
      if (pendingFilesSnapshot.length > 0 && !attachmentContext) return

      const quotedSelection = consumeQuotedSelection()
      const message = createAgentQueuedMessage(effectiveText, crypto.randomUUID(), Date.now(), quotedSelection, attachmentContext
        ? {
            fileReferenceBlock: attachmentContext.referenceBlock,
            attachments: attachmentContext.attachments,
            additionalDirectories: attachmentContext.additionalDirectories,
          }
        : undefined)
      if (overrideText === undefined) {
        setInputContent('')
        setInputHtmlContent('')
      }
      setPromptSuggestions((prev) => {
        if (!prev.has(sessionId)) return prev
        const map = new Map(prev)
        map.delete(sessionId)
        return map
      })
      sendPlainTextAgentMessage(message).catch((error) => {
        console.error('[AgentView] 追加消息失败:', error)
        toast.error('追加消息失败', { description: String(error) })
        // 回滚：恢复输入框内容和建议，避免用户输入丢失
        setInputContent(effectiveText)
        setInputHtmlContent('')
        setPromptSuggestions((prev) => {
          const map = new Map(prev)
          if (suggestion) {
            map.set(sessionId, suggestion)
          } else {
            map.delete(sessionId)
          }
          return map
        })
        const failedQuotedSelection = message.quotedSelection
        if (failedQuotedSelection) {
          setQuotedSelectionMap((prev) => {
            const map = new Map(prev)
            map.set(sessionId, failedQuotedSelection)
            return map
          })
        }
        restoreQueuedAttachmentsToPending(message.attachments)
      })
      return
    }

    // 清除当前会话的错误消息
    setAgentStreamErrors((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 清除当前会话的提示建议
    setPromptSuggestions((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 1. 如果有 pending 文件，先保存到 session 目录
    const attachmentContext = pendingFilesSnapshot.length > 0
      ? await preparePendingFilesForSend(pendingFilesSnapshot, additionalDirectoriesForRun)
      : null
    if (pendingFilesSnapshot.length > 0 && !attachmentContext) return
    let fileReferences = attachmentContext?.referenceBlock ?? ''

    // 构建引用选中文本：内联 XML 拼入 prompt，对话框不展示（parseAttachedFiles 剥离）
    const quotedSelection = consumeQuotedSelection()
    if (quotedSelection) {
      fileReferences = fileReferences + buildQuotedSelectionBlock(quotedSelection)
    }

    // 2. 构建最终消息
    const finalMessage = fileReferences + effectiveText
    const mentions = parseQueuedMessageMentions(effectiveText, referenceableSessionIds)

    // 清除打断状态（上一轮的打断标记不再显示）
    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })

    // 开始新一轮前清空上一轮 liveMessages，防止暂停残留内容被拼到新用户消息之后
    store.set(liveMessagesMapAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 取消 draft 标记，让会话出现在侧边栏
    setDraftSessionIds((prev: Set<string>) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
    setAgentSessions((prev) => prev.map((session) =>
      session.id === sessionId && session.draft
        ? { ...session, draft: false }
        : session
    ))

    // 初始化流式状态（startedAt 由渲染进程生成，传递给主进程原样回传，确保竞态保护使用同一个值）
    const streamStartedAt = Date.now()
    setStreamingStates((prev) => {
      const map = new Map(prev)
      const existing = prev.get(sessionId)
      map.set(sessionId, {
        running: true,
        content: '',
        toolActivities: [],
        model: agentModelId || undefined,
        startedAt: streamStartedAt,
        ...preserveAgentContextState(
          existing,
          resolveRunContextWindow(selectedRuntimeModel, existing?.contextWindow),
        ),
      })
      return map
    })

    // 乐观更新：SDKMessage 格式的用户消息（Phase 4）
    const tempUserSDKMsg: SDKMessage = {
      type: 'user',
      message: {
        content: [{ type: 'text', text: finalMessage }],
      },
      parent_tool_use_id: null,
      _createdAt: Date.now(),
    } as unknown as SDKMessage
    appendOptimisticPersistedMessage(tempUserSDKMsg)

    const input: AgentSendInput = {
      sessionId,
      userMessage: finalMessage,
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      runtimeThinking,
      startedAt: streamStartedAt,
      permissionModeOverride: effectivePermissionMode,
      ...(additionalDirectoriesForRun.size > 0 && { additionalDirectories: Array.from(additionalDirectoriesForRun) }),
      ...(mentions.mentionedSkills.length > 0 && { mentionedSkills: mentions.mentionedSkills }),
      ...(mentions.mentionedMcpServers.length > 0 && { mentionedMcpServers: mentions.mentionedMcpServers }),
      ...(mentions.mentionedSessionIds.length > 0 && { mentionedSessionIds: mentions.mentionedSessionIds }),
      ...(selectedBrowserAnnotations.length > 0 && { browserAnnotations: selectedBrowserAnnotations }),
    }

    // 清空输入框（仅当发送的是用户自己输入的内容，而非推荐建议时）
    // 用 === undefined 与上方 `overrideText ?? inputContent` 的取值语义保持一致，
    // 避免未来出现 handleSend('') 时两条路径行为割裂
    if (overrideText === undefined) {
      setInputContent('')
      setInputHtmlContent('')
    }

    window.electronAPI.sendAgentMessage(input).catch((error) => {
      console.error('[AgentView] 发送消息失败:', error)
      setStreamingStates((prev) => {
        const current = prev.get(sessionId)
        if (!current) return prev
        const map = new Map(prev)
        map.set(sessionId, { ...current, running: false })
        return map
      })
    })
  }, [inputContent, createBaseAdditionalDirectories, preparePendingFilesForSend, restoreQueuedAttachmentsToPending, sessionId, agentChannelId, agentModelId, selectedRuntimeModel, currentWorkspaceId, runtimeThinking, streaming, backgroundWaiting, stopping, suggestion, hasAvailableModel, store, consumeQuotedSelection, setStreamingStates, setAgentStreamErrors, setPromptSuggestions, setInputContent, setLiveMessagesMap, effectivePermissionMode, messagesLoaded, referenceableSessionIds, setQueuedMessages, setQuotedSelectionMap, sendPlainTextAgentMessage, setAgentSessions, selectedBrowserAnnotations])

  /** 停止生成 */
  const handleStop = React.useCallback((): void => {
    if (stopping) return

    const currentState = store.get(agentStreamingStatesAtom).get(sessionId)
    // 与“立即发送”使用同一套冻结逻辑，停止后只保留 SDK 消息这一份内容，
    // 不让 streamState.content 的 fallback 和 assistant 快照同时显示。
    freezeActiveAgentProjection(currentState)

    store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })

    // 先让 UI 立即进入停止态；主进程仍会等待 Runtime 真正退出后发送完成事件。
    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (!current || !current.running) return prev
      const map = new Map(prev)
      map.set(sessionId, {
        ...markAgentStreamStopped(current),
        content: '',
      })
      return map
    })

    window.electronAPI.stopAgent(sessionId).then(() => {
      // stopAgent 返回前旧 Runtime 仍可能 flush 最后一帧累计快照；
      // 再标记一次，避免收尾快照与冻结内容重复渲染。
      store.set(liveMessagesMapAtom, (prev) => {
        const current = prev.get(sessionId) ?? []
        const next = markPausedAgentMessages(current)
        if (next === current) return prev
        const map = new Map(prev)
        map.set(sessionId, next)
        return map
      })
    }).catch((error: unknown) => {
      console.error('[AgentView] 停止 Runtime 失败:', error)
      store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
      setStreamingStates((prev) => {
        const current = prev.get(sessionId)
        if (!current?.stopping) return prev
        const map = new Map(prev)
        map.set(sessionId, { ...current, running: true, stopping: false })
        return map
      })
    })
  }, [freezeActiveAgentProjection, sessionId, setStreamingStates, stopping, store])

  /** 手动发送 /compact 命令 */
  const handleCompact = React.useCallback((): void => {
    if (!agentChannelId || streaming) return

    const streamStartedAt = Date.now()
    const localUuid = crypto.randomUUID()

    // 1. 立即注入合成用户消息（/compact 气泡立刻可见，与普通发送路径一致）
    const syntheticMsg: import('@proma/shared').SDKMessage = {
      type: 'user',
      uuid: localUuid,
      message: {
        content: [{ type: 'text', text: '/compact' }],
      },
      parent_tool_use_id: null,
      _createdAt: streamStartedAt,
    } as unknown as import('@proma/shared').SDKMessage

    store.set(liveMessagesMapAtom, (prev) => {
      const map = new Map(prev)
      const current = map.get(sessionId) ?? []
      map.set(sessionId, [...current, syntheticMsg])
      return map
    })

    // 2. 初始化流式状态 + 乐观设 isCompacting=true（SDK compacting 事件之前就显示"正在压缩..."分隔符）
    setStreamingStates((prev) => {
      const map = new Map(prev)
      const current = prev.get(sessionId) ?? {
        running: true,
        content: '',
        toolActivities: [],
        model: agentModelId || undefined,
        startedAt: streamStartedAt,
      }
      map.set(sessionId, {
        ...current,
        running: true,
        startedAt: streamStartedAt,
        isCompacting: true,
        contextCompaction: { status: 'running' },
      })
      return map
    })

    window.electronAPI.sendAgentMessage({
      sessionId,
      userMessage: '/compact',
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      runtimeThinking,
      startedAt: streamStartedAt,
      permissionModeOverride: effectivePermissionMode,
    }).catch((error) => {
      console.error('[AgentView] /compact 发送失败:', error)
      // 回滚：移除合成用户消息 + 清除 isCompacting flag
      store.set(liveMessagesMapAtom, (prev) => {
        const map = new Map(prev)
        const current = (map.get(sessionId) ?? []).filter(
          (m) => (m as unknown as { uuid?: string }).uuid !== localUuid,
        )
        map.set(sessionId, current)
        return map
      })
      setStreamingStates((prev) => {
        const map = new Map(prev)
        const current = prev.get(sessionId)
        if (!current) return prev
        map.set(sessionId, {
          ...current,
          isCompacting: false,
          // 发送失败时同步清掉乐观压缩态，避免计划入口被长期隐藏
          contextCompaction: undefined,
        })
        return map
      })
    })
  }, [sessionId, agentChannelId, agentModelId, currentWorkspaceId, runtimeThinking, streaming, setStreamingStates, store, effectivePermissionMode])

  /** 复制错误信息到剪贴板 */
  const handleCopyError = React.useCallback(async (): Promise<void> => {
    if (!agentError) return

    try {
      await navigator.clipboard.writeText(agentError)
      setErrorCopied(true)
      setTimeout(() => setErrorCopied(false), 2000)
    } catch (error) {
      console.error('[AgentView] 复制错误信息失败:', error)
    }
  }, [agentError])

  /** 重试：在当前会话中重新发送最后一条用户消息 */
  const handleRetry = React.useCallback((retryOfErrorUuid?: string): void => {
    if (!agentChannelId || streaming) return

    // 找到最后一条用户消息
    const lastUserMessage = [...persistedSDKMessages]
      .reverse()
      .map(getUserTextFromSDKMessage)
      .find((text): text is string => text !== null)
    if (!lastUserMessage) return

    // 与主进程按 UUID 的原子删除同步更新当前 React 状态和 LRU cache，避免旧错误
    // 在下一轮回复开始前仍被页面渲染。旧会话没有 UUID 时保留历史，由主进程幂等处理。
    const messagesAfterCleanup = removeRetriedErrorSDKMessage(persistedSDKMessages, retryOfErrorUuid)
    if (messagesAfterCleanup !== persistedSDKMessages) {
      persistedSDKMessagesRef.current = messagesAfterCleanup
      setPersistedSDKMessages(messagesAfterCleanup)
      setMessagesCache((prev) => setSessionMessagesCache(prev, sessionId, messagesAfterCleanup))
    }

    // 清除错误状态
    setAgentStreamErrors((prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })

    // 初始化流式状态（startedAt 由渲染进程生成，传递给主进程原样回传）
    const streamStartedAt = Date.now()
    setStreamingStates((prev) => {
      const map = new Map(prev)
      const existing = prev.get(sessionId)
      map.set(sessionId, {
        running: true,
        content: '',
        toolActivities: [],
        model: agentModelId || undefined,
        startedAt: streamStartedAt,
        ...preserveAgentContextState(
          existing,
          resolveRunContextWindow(selectedRuntimeModel, existing?.contextWindow),
        ),
      })
      return map
    })

    window.electronAPI.sendAgentMessage({
      sessionId,
      userMessage: lastUserMessage,
      channelId: agentChannelId,
      modelId: agentModelId || undefined,
      workspaceId: currentWorkspaceId || undefined,
      runtimeThinking,
      startedAt: streamStartedAt,
      permissionModeOverride: effectivePermissionMode,
      ...(retryOfErrorUuid && { retryOfErrorUuid }),
    }).catch(console.error)
  }, [persistedSDKMessages, sessionId, agentChannelId, agentModelId, selectedRuntimeModel, currentWorkspaceId, runtimeThinking, streaming, setAgentStreamErrors, setStreamingStates, setMessagesCache, effectivePermissionMode])

  /** 在新对话继续：创建新会话 + 切换 tab + 使用 &session 引用旧会话 */
  const handleRetryInNewSession = React.useCallback(async (): Promise<void> => {
    if (!agentChannelId) return

    try {
      const meta = await window.electronAPI.createAgentSession(
        undefined, agentChannelId, currentWorkspaceId || undefined, agentModelId || undefined,
      )
      setAgentSessions((prev) => [meta, ...prev])

      // 切换到新会话 tab
      openSession('agent', meta.id, meta.title)

      // 发送引用旧会话的默认提示词，并通过 mentionedSessionIds 触发结构化会话引用注入
      const prompt = `请读取 &session:${sessionId} 的历史，然后从上个会话停止的位置继续。`
      const streamStartedAt = Date.now()

      // 初始化新会话流式状态
      setStreamingStates((prev) => {
        const map = new Map(prev)
        map.set(meta.id, {
          running: true,
          content: '',
          toolActivities: [],
          model: agentModelId || undefined,
          startedAt: streamStartedAt,
        })
        return map
      })

      window.electronAPI.sendAgentMessage({
        sessionId: meta.id,
        userMessage: prompt,
        channelId: agentChannelId,
        modelId: agentModelId || undefined,
        workspaceId: currentWorkspaceId || undefined,
        runtimeThinking,
        mentionedSessionIds: [sessionId],
        startedAt: streamStartedAt,
        permissionModeOverride: effectivePermissionMode,
      }).catch(console.error)
    } catch (error) {
      console.error('[AgentView] 在新会话中重试失败:', error)
    }
  }, [sessionId, agentChannelId, agentModelId, currentWorkspaceId, runtimeThinking, openSession, setAgentSessions, setStreamingStates, effectivePermissionMode])

  /** 分叉会话：从指定消息处创建新会话并自动切换 */
  const handleFork = React.useCallback(async (upToMessageUuid: string): Promise<void> => {
    if (agentModelId && agentChannelId && sessionMetaChannelId && agentChannelId !== sessionMetaChannelId) {
      toast.error('分叉会话失败', {
        description: '分叉只能使用源会话同一渠道下的模型，请切回当前会话渠道后再试。',
      })
      return
    }
    const forkModelId = agentChannelId === sessionMetaChannelId ? agentModelId || undefined : undefined

    try {
      const meta = await window.electronAPI.forkAgentSession({
        sessionId,
        upToMessageUuid,
        modelId: forkModelId,
      })
      setAgentSessions((prev) => [meta, ...prev])

      // 切换到新会话 tab
      openSession('agent', meta.id, meta.title)

      toast.success('已创建分叉会话', {
        description: meta.title,
      })
    } catch (error) {
      console.error('[AgentView] 分叉会话失败:', error)
      const rawMsg = error instanceof Error ? error.message : '未知错误'
      // SDK 偶尔会因为 sidechain/消息归属问题抛 "not found in session"，
      // 这里给出更可操作的中文提示，而不是把 SDK 内部英文报错直接透传给用户
      const friendlyDesc = /not found in session/i.test(rawMsg)
        ? '该消息无法作为分叉起点（可能属于子代理执行过程或已被清理）。请选择主对话中的其他消息再试。'
        : rawMsg
      toast.error('分叉会话失败', {
        description: friendlyDesc,
      })
    }
  }, [sessionId, agentChannelId, agentModelId, sessionMetaChannelId, openSession, setAgentSessions])

  /** 快照回退：同一会话内回退到指定消息点，恢复文件 + 截断对话 */
  const [rewindTargetUuid, setRewindTargetUuid] = React.useState<string | null>(null)

  const handleRewindRequest = React.useCallback((assistantMessageUuid: string): void => {
    setRewindTargetUuid(assistantMessageUuid)
  }, [])

  const handleRewindConfirm = React.useCallback(async (): Promise<void> => {
    if (!rewindTargetUuid) return
    const targetUuid = rewindTargetUuid
    setRewindTargetUuid(null)

    try {
      const result = await window.electronAPI.rewindSession({
        sessionId,
        assistantMessageUuid: targetUuid,
      })

      // 刷新消息列表
      store.set(agentMessageRefreshAtom, (prev) => {
        const map = new Map(prev)
        map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
        return map
      })

      // 刷新预览面板的 diff（文件已被回退，当前显示的内容已过期）
      store.set(agentDiffRefreshVersionAtom, (prev) => {
        const m = new Map(prev); m.set(sessionId, (prev.get(sessionId) ?? 0) + 1); return m
      })

      if (result.fileRewind?.canRewind) {
        const fileCount = result.fileRewind.filesChanged?.length ?? 0
        toast.success('已回退到此处', {
          description: fileCount > 0 ? `${fileCount} 个文件已恢复` : '文件无变化',
        })
      } else if (result.fileRewind?.error) {
        toast.warning('已回退对话', {
          description: `文件恢复不可用：${result.fileRewind.error}`,
        })
      } else {
        toast.success('已回退到此处')
      }
    } catch (error) {
      console.error('[AgentView] 回退失败:', error)
      toast.error('回退失败', {
        description: error instanceof Error ? error.message : '未知错误',
      })
    }
  }, [rewindTargetUuid, sessionId, store])

  // 监听快捷键系统分发的 stop-generation 事件
  React.useEffect(() => {
    const handler = (): void => {
      if (streaming) handleStop()
    }
    window.addEventListener('proma:stop-generation', handler)
    return () => window.removeEventListener('proma:stop-generation', handler)
  }, [streaming, handleStop])

  // 监听快捷键系统分发的 focus-input 事件（Cmd+L）
  React.useEffect(() => {
    const handler = (): void => {
      const proseMirror = document.querySelector('[data-input-mode="agent"] .ProseMirror') as HTMLElement | null
      proseMirror?.focus()
    }
    window.addEventListener('proma:focus-input', handler)
    return () => window.removeEventListener('proma:focus-input', handler)
  }, [])

  const allAskUserRequests = useAtomValue(allPendingAskUserRequestsAtom)
  const allPermissionRequests = useAtomValue(allPendingPermissionRequestsAtom)
  const allExitPlanRequests = useAtomValue(allPendingExitPlanRequestsAtom)
  const permissionRequestCount = allPermissionRequests.get(sessionId)?.length ?? 0
  const askUserRequestCount = allAskUserRequests.get(sessionId)?.length ?? 0
  const exitPlanRequestCount = allExitPlanRequests.get(sessionId)?.length ?? 0
  const interactionRequestCounts = {
    permission: permissionRequestCount,
    askUser: askUserRequestCount,
    exitPlan: exitPlanRequestCount,
  }
  const activeInteractionPanel = getActiveAgentInteractionPanel(interactionRequestCounts)
  const hasInteractionPanel = shouldReplaceAgentComposer(interactionRequestCounts)
  const hasBlockingRequests = hasInteractionPanel
  const canSendQueuedNow = messagesLoaded && !stopping && (streaming || !messagesRefreshing) && !!agentChannelId && hasAvailableModel && !hasBlockingRequests
  const autoSendingQueuedRef = React.useRef(false)
  const queuedSendInFlightRef = React.useRef(false)
  const sendingQueuedMessageIdsRef = React.useRef<Set<string>>(new Set())

  const handleSendQueuedNow = React.useCallback((messageId: string): void => {
    if (!canSendQueuedNow) return
    if (!streaming && messagesRefreshingRef.current) return
    if (queuedSendInFlightRef.current || sendingQueuedMessageIdsRef.current.has(messageId)) return
    const message = queuedMessages.find((item) => item.id === messageId)
    if (!message) return

    queuedSendInFlightRef.current = true
    sendingQueuedMessageIdsRef.current.add(messageId)
    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId))
    sendPlainTextAgentMessage(message)
      .catch((error) => {
        console.error('[AgentView] 队列消息发送失败:', error)
        toast.error('队列消息发送失败', { description: String(error) })
        setQueuedMessages((prev) => restoreQueuedMessageToFront(prev, message))
      })
      .finally(() => {
        sendingQueuedMessageIdsRef.current.delete(messageId)
        queuedSendInFlightRef.current = false
      })
  }, [canSendQueuedNow, queuedMessages, sendPlainTextAgentMessage, setQueuedMessages, streaming])

  const handleRecallQueuedMessage = React.useCallback((messageId: string): void => {
    const message = queuedMessages.find((item) => item.id === messageId)
    if (!message) return

    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId))
    const recalledQuotedSelection = message.quotedSelection
    if (recalledQuotedSelection) {
      setQuotedSelectionMap((prev) => {
        const map = new Map(prev)
        map.set(sessionId, recalledQuotedSelection)
        return map
      })
    }
    restoreQueuedAttachmentsToPending(message.attachments)

    const hasDraft = inputContent.trim().length > 0
    const nextDraft = hasDraft
      ? `${inputContent.trimEnd()}\n\n${message.text}`
      : message.text
    setInputContent(nextDraft)

    // 已有草稿时，用「原草稿 HTML + 队列文本段落 HTML」合并，保留原草稿的 mention 等富文本节点；
    // 空草稿时留空 HTML，交给编辑器按纯文本重建（与正常输入渲染一致）。
    if (hasDraft) {
      const draftHtml = inputHtmlContent.trim().length > 0
        ? inputHtmlContent
        : queuedTextToParagraphHtml(inputContent)
      setInputHtmlContent(`${draftHtml}${queuedTextToParagraphHtml(message.text)}`)
    } else {
      setInputHtmlContent('')
    }
  }, [inputContent, inputHtmlContent, queuedMessages, restoreQueuedAttachmentsToPending, sessionId, setInputContent, setInputHtmlContent, setQueuedMessages, setQuotedSelectionMap])

  const handleRemoveQueuedMessage = React.useCallback((messageId: string): void => {
    setQueuedMessages((prev) => removeQueuedMessage(prev, messageId))
  }, [setQueuedMessages])

  const handleMoveQueuedMessage = React.useCallback((
    sourceId: string,
    targetId: string,
    placement: QueueDropPlacement,
  ): void => {
    setQueuedMessages((prev) => moveQueuedMessage(prev, sourceId, targetId, placement))
  }, [setQueuedMessages])

  React.useEffect(() => {
    if (autoSendingQueuedRef.current) return
    if (queuedSendInFlightRef.current) return
    if (!canAutoSendQueuedAgentMessage({
      queueLength: queuedMessages.length,
      canSendNow: canSendQueuedNow,
      streaming,
      stopping,
      messagesRefreshing: messagesRefreshingRef.current,
    })) return

    const message = queuedMessages[0]
    if (!message) return
    if (sendingQueuedMessageIdsRef.current.has(message.id)) return

    autoSendingQueuedRef.current = true
    queuedSendInFlightRef.current = true
    sendingQueuedMessageIdsRef.current.add(message.id)
    setQueuedMessages((prev) => removeQueuedMessage(prev, message.id))
    sendPlainTextAgentMessage(message)
      .catch((error) => {
        console.error('[AgentView] 自动发送队列消息失败:', error)
        if (isTransientAgentRuntimeStateError(error)) {
          console.info('[AgentView] Runtime 仍在收尾，队列消息将在状态就绪后自动重试')
          // 等 finally 释放 in-flight 标记后再恢复队首，确保状态更新能重新触发 effect。
          window.setTimeout(() => {
            setQueuedMessages((prev) => restoreQueuedMessageToFront(prev, message))
          }, 100)
          return
        }
        setQueuedMessages((prev) => restoreQueuedMessageToFront(prev, message))
        toast.error('自动发送队列消息失败', { description: String(error) })
      })
      .finally(() => {
        sendingQueuedMessageIdsRef.current.delete(message.id)
        queuedSendInFlightRef.current = false
        autoSendingQueuedRef.current = false
      })
  }, [canSendQueuedNow, queuedMessages, sendPlainTextAgentMessage, setQueuedMessages, stopping, streaming])

  // ===== 预览面板状态（toggle 快捷键，分屏布局在 MainArea） =====
  const setPreviewOpenMap = useSetAtom(previewPanelOpenMapAtom)

  const togglePreviewPanel = React.useCallback(() => {
    setPreviewOpenMap((prev) => {
      const m = new Map(prev)
      const current = m.get(sessionId) ?? false
      m.set(sessionId, !current)
      return m
    })
  }, [sessionId, setPreviewOpenMap])

  React.useEffect(() => {
    return registerShortcut('toggle-preview-panel', togglePreviewPanel)
  }, [togglePreviewPanel])

  const hasTextInput = inputContent.trim().length > 0
  const canSend = messagesLoaded
    && (hasTextInput || pendingFiles.length > 0 || !!suggestion)
    && agentChannelId !== null
    && hasAvailableModel
    && (!streaming || hasTextInput)
  const waitingForQueuedRun = !streaming && queuedMessages.length > 0

  const handleThinkingEffortChange = React.useCallback((
    level: import('@proma/shared').ThinkingEffortLevel,
  ): void => {
    const nextThinking = selectedRuntimeModel?.supportsAdaptiveThinking
      ? { type: 'adaptive' as const }
      : undefined
    setSessionThinkingEffortMap((prev) => {
      const next = new Map(prev)
      next.set(sessionId, level)
      return next
    })
    if (nextThinking) setAgentThinking(nextThinking)
    void window.electronAPI.updateAgentRuntimeConfig(sessionId, {
      thinkingConfig: nextThinking,
      effortLevel: level,
    }).catch((error) => {
      console.error('[AgentView] 实时更新 Runtime 思考等级失败:', error)
    })
    setAgentThinkingEffortLevel(level)
    window.electronAPI.updateSettings({
      ...(nextThinking ? { agentThinking: nextThinking } : {}),
      agentThinkingEffortLevel: level,
    }).catch(console.error)
  }, [
    selectedRuntimeModel,
    sessionId,
    setAgentThinking,
    setAgentThinkingEffortLevel,
    setSessionThinkingEffortMap,
  ])

  const inputToolbarItems = React.useMemo<ToolbarItem[]>(() => [
    {
      key: 'add',
      node: (
        <AgentInputAddMenu
          onAttachFile={handleOpenFileDialog}
          planModeEnabled={isPlanMode}
          onPlanModeChange={(enabled) => { void handlePlanModeChange(enabled) }}
        />
      ),
    },
    { key: 'permission-mode', node: <PermissionModeSelector sessionId={sessionId} /> },
    ...(isPlanMode
      ? [{
          key: 'plan-mode',
          node: <PlanModeChip onClose={() => { void handlePlanModeChange(false) }} />,
        }]
      : []),
    {
      key: 'context-usage',
      node: (
        <ContextUsageBadge
          inputTokens={contextStatus.inputTokens}
          outputTokens={contextStatus.outputTokens}
          cacheReadTokens={contextStatus.cacheReadTokens}
          cacheCreationTokens={contextStatus.cacheCreationTokens}
          cumulativeInputTokens={contextStatus.cumulativeInputTokens}
          cumulativeCacheReadTokens={contextStatus.cumulativeCacheReadTokens}
          cumulativeCacheCreationTokens={contextStatus.cumulativeCacheCreationTokens}
          contextWindow={contextStatus.contextWindow}
          isEstimated={contextStatus.contextUsageIsEstimated === true}
          autoCompactEnabled={contextStatus.autoCompactEnabled}
          autoCompactThreshold={contextStatus.autoCompactThreshold}
          effectiveContextWindow={contextStatus.effectiveContextWindow}
          isCompacting={contextStatus.isCompacting}
          isProcessing={streaming || waitingForQueuedRun}
          sessionId={sessionId}
          channelId={planQuotaChannelId}
          channelUpdatedAt={planQuotaChannelUpdatedAt}
          onCompact={handleCompact}
        />
      ),
    },
  ], [
    agentChannelId,
    planQuotaChannelId,
    planQuotaChannelUpdatedAt,
    agentModelId,
    sessionId,
    handleOpenFileDialog,
    handlePlanModeChange,
    isPlanMode,
    contextStatus.inputTokens,
    contextStatus.outputTokens,
    contextStatus.cacheReadTokens,
    contextStatus.cacheCreationTokens,
    contextStatus.contextWindow,
    contextStatus.autoCompactEnabled,
    contextStatus.autoCompactThreshold,
    contextStatus.effectiveContextWindow,
    contextStatus.isCompacting,
    streaming,
    waitingForQueuedRun,
    handleCompact,
  ])

  const inputActionNode = streaming && !hasTextInput ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={inputToolbarDangerButtonClass}
          onClick={handleStop}
        >
          <Square className="size-[16px]" fill="currentColor" strokeWidth={0} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>停止 Agent ({getAcceleratorDisplay(getActiveAccelerator('stop-generation'))})</p>
      </TooltipContent>
    </Tooltip>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        canSend ? inputToolbarSendButtonClass : inputToolbarDisabledButtonClass
      )}
      onClick={() => handleSend()}
      disabled={!canSend}
      aria-label="发送消息"
    >
      <ArrowUp className="size-[17px]" strokeWidth={2.6} />
    </Button>
  )
  const inputTrailingNode = (
    <>
      <ModelSelector
        filterChannelIds={agentChannelIds}
        externalSelectedModel={externalSelectedModel}
        onModelSelect={handleModelSelect}
        runtimeModelOptions={runtimeModelOptions}
        runtimeModelsLoading={runtimeModelsLoading}
        useSharedOpenState
        textOnlyTrigger
        showTriggerLogo
      />
      {thinkingEffortCapability && effectiveThinkingEffortLevel && (
        <AgentThinkingEffortControl
          capability={thinkingEffortCapability}
          value={effectiveThinkingEffortLevel}
          onValueChange={handleThinkingEffortChange}
        />
      )}
      <SpeechButton className={inputToolbarButtonClass} />
      {inputActionNode}
    </>
  )

  // 同批图片附件 — 用于大图预览时左右翻页（提取到 useMemo 避免每次渲染重建）
  const pendingImageFiles = React.useMemo(
    () => pendingFiles.filter((f) => f.mediaType.startsWith('image/') && !!f.previewUrl),
    [pendingFiles]
  )
  const imageSiblingsForPending = React.useMemo(
    () => pendingImageFiles.map((f) => ({
      previewUrl: f.previewUrl as string,
      filename: f.filename,
      onEditComplete: (editedDataUrl: string) => handleAttachmentEditComplete(f.id, editedDataUrl),
    })),
    [pendingImageFiles, handleAttachmentEditComplete]
  )

  return (
    <>
    <AgentSessionProvider sessionId={sessionId}>
      <div
        ref={sessionViewportRef}
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {/* Agent Header */}
        <AgentHeader sessionId={sessionId} />

        {/* 消息区域 */}
        <AgentMessages
          sessionId={sessionId}
          contentOffsetX={floatingLayout.contentOffsetX}
          sessionModelId={agentModelId || undefined}
          messagesLoaded={messagesLoaded}
          persistedSDKMessages={persistedSDKMessages}
          streaming={streaming}
          waitingForQueuedRun={waitingForQueuedRun}
          queuedRunStartedAt={queuedMessages[0]?.createdAt}
          streamState={streamState}
          liveMessages={liveMessages}
          sessionPath={sessionPath}
          attachedDirs={allAttachedDirs}
          stoppedByUser={stoppedByUser}
          onRetry={handleRetry}
          onRetryInNewSession={handleRetryInNewSession}
          onFork={handleFork}
          onRewind={handleRewindRequest}
          onCompact={handleCompact}
        />

        {/* 交互面板与输入框共用同一宽度；出现时完整替换输入区域，高度随内容自适应。 */}
        {hasInteractionPanel && (
          <div
            className={cn(
              inputAreaContainerClass,
              'relative z-10 flex flex-col gap-2',
              inputAreaFadeClass,
            )}
            style={{
              transform: floatingLayout.contentOffsetX
                ? `translateX(${floatingLayout.contentOffsetX}px)`
                : undefined,
            }}
            data-agent-interaction-panel
          >
            {activeInteractionPanel === 'permission' && <PermissionBanner sessionId={sessionId} />}
            {activeInteractionPanel === 'askUser' && <AskUserBanner sessionId={sessionId} />}
            {activeInteractionPanel === 'exitPlan' && <ExitPlanModeBanner sessionId={sessionId} />}
          </div>
        )}

        {!hasInteractionPanel && (
          <div
            className={cn(
              inputAreaContainerClass,
              inputAreaFadeClass,
              'relative z-10',
            )}
            style={{
              transform: floatingLayout.contentOffsetX
                ? `translateX(${floatingLayout.contentOffsetX}px)`
                : undefined,
            }}
            data-input-mode="agent"
          >
          <AgentInputContextBar
            projectPicker={(
              <AgentProjectPicker
                workspaces={workspaces}
                workspaceId={currentWorkspaceId}
                changing={projectChanging}
                onSelect={handleProjectSelect}
                onAdd={handleProjectAdd}
              />
            )}
            planProgress={<RuntimeTodoHoverProgress sessionId={sessionId} />}
          />
          <div
            className={cn(
              inputCardClass,
              isDragOver && 'border-[2px] border-dashed border-[#2ecc71] bg-[#2ecc71]/[0.03]'
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* 无 Agent 渠道或无可用模型提示 */}
            {(!agentChannelId || !hasAvailableModel) && (
              <div className="flex items-center gap-2 px-4 py-2 text-sm text-amber-600 dark:text-amber-400">
                <Settings size={14} />
                <span>{!agentChannelId ? '请在设置中选择 Agent 供应商' : '暂无可用模型，请在设置中启用 Agent 渠道并配置模型'}</span>
                <button
                  type="button"
                  className="text-xs underline underline-offset-2 hover:text-foreground transition-colors"
                  onClick={() => setSettingsOpen(true)}
                >
                  前往设置
                </button>
              </div>
            )}

            {/* 附件 + 引用选中文本 Chip（同排并排） */}
            {(pendingFiles.length > 0 || currentQuotedSelection) && (
              <div className="flex flex-wrap gap-2 px-3 pt-2.5 pb-1.5">
                {pendingFiles.map((file) => (
                    <AttachmentPreviewItem
                      key={file.id}
                      filename={file.filename}
                      mediaType={file.mediaType}
                      previewUrl={file.previewUrl}
                      onRemove={() => handleRemoveFile(file.id)}
                      onClick={file.filename.startsWith('clipboard-') ? () => handleClipboardPreview(file) : undefined}
                      onEditComplete={(editedDataUrl) => handleAttachmentEditComplete(file.id, editedDataUrl)}
                      imageSiblings={imageSiblingsForPending}
                      siblingIndex={pendingImageFiles.findIndex((f) => f.id === file.id)}
                    />
                  ))}
                {currentQuotedSelection && (
                  <QuotedSelectionChip
                    text={currentQuotedSelection.text}
                    filePath={currentQuotedSelection.filePath}
                    sourceLabel={currentQuotedSelection.sourceLabel}
                    onRemove={handleRemoveQuotedSelection}
                  />
                )}
              </div>
            )}

            <AgentMessageQueue
              items={queuedMessages}
              canSendNow={canSendQueuedNow}
              onSendNow={handleSendQueuedNow}
              onRecall={handleRecallQueuedMessage}
              onRemove={handleRemoveQueuedMessage}
              onMove={handleMoveQueuedMessage}
            />

            {/* Agent 建议提示 */}
            {suggestion && !streaming && (
              <div className="px-3 pt-2.5 pb-1.5">
                <button
                  type="button"
                  className="group flex items-start gap-2 w-full rounded-lg border border-dashed border-primary/30 bg-primary/[0.03] px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/50 hover:bg-primary/[0.06]"
                  onClick={() => handleSend(suggestion)}
                >
                  <Sparkles className="size-4 shrink-0 mt-0.5 text-primary/60 group-hover:text-primary/80" />
                  <span className="flex-1 min-w-0 text-foreground/80 group-hover:text-foreground line-clamp-3">{suggestion}</span>
                  <X
                    className="size-3.5 shrink-0 mt-0.5 text-muted-foreground/40 hover:text-foreground transition-colors"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPromptSuggestions((prev) => {
                        if (!prev.has(sessionId)) return prev
                        const map = new Map(prev)
                        map.delete(sessionId)
                        return map
                      })
                    }}
                  />
                </button>
              </div>
            )}

            <RichTextInput
              value={inputContent}
              onChange={setInputContent}
              onSubmit={handleSend}
              onPasteFiles={handlePasteFiles}
              onPasteLongText={handlePasteLongText}
              longTextPasteThreshold={longTextPasteAsAttachmentEnabled ? LONG_TEXT_ATTACHMENT_THRESHOLD : undefined}
              placeholder={
                agentChannelId && hasAvailableModel
                  ? sendWithCmdEnter
                    ? '描述任务或提出问题（⌘/Ctrl+Enter 发送）'
                    : '描述任务或提出问题'
                  : !agentChannelId
                    ? '请先在设置中选择 Agent 供应商'
                    : '暂无可用模型，请先在设置中启用渠道'
              }
              disabled={!agentChannelId || !hasAvailableModel}
              autoFocusTrigger={sessionId}
              collapsible
              enableMentions
              workspacePath={sessionPath}
              workspaceId={currentWorkspaceId}
              workspaceSlug={workspaceSlug}
              sessionId={sessionId}
              attachedDirs={workspaceMentionPaths}
              sessionAttachedDirs={sessionMentionPaths}
              htmlValue={inputHtmlContent}
              onHtmlChange={setInputHtmlContent}
              sendWithCmdEnter={sendWithCmdEnter}
            />

            {/* Footer 工具栏 — 容器变窄时尾部按钮自动折叠进「更多」Popover */}
            <InputToolbarOverflow items={inputToolbarItems} trailing={inputTrailingNode} />
          </div>
          </div>
        )}
        {floatingLayout.visible && (
          <SessionFloatingPanel
            sessionId={sessionId}
            sessionPath={sessionPath}
          />
        )}
      </div>
    </AgentSessionProvider>

    {/* 回退确认弹窗 */}
    <AlertDialog
      open={rewindTargetUuid !== null}
      onOpenChange={(v) => { if (!v) setRewindTargetUuid(null) }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认回退</AlertDialogTitle>
          <AlertDialogDescription>
            回退将截断该消息之后的所有对话，并恢复文件到该时刻的状态。此操作不可撤销，确定要回退吗？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRewindConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            回退
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
