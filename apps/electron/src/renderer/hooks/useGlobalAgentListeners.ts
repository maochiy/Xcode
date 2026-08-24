/**
 * useGlobalAgentListeners — 全局 Agent IPC 监听器
 *
 * 在应用顶层挂载，永不销毁。将所有 Agent 流式事件、
 * 权限请求、AskUser 请求写入对应 Jotai atoms。
 *
 * 使用 useStore() 直接操作 atoms，避免 React 订阅。
 */

import { useEffect } from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import { useStore } from 'jotai'
import {
  agentStreamingStatesAtom,
  agentStreamErrorsAtom,
  agentSessionsAtom,
  agentMessageRefreshAtom,
  allPendingPermissionRequestsAtom,
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  agentPromptSuggestionsAtom,
  backgroundTasksAtomFamily,
  recentlyModifiedPathsAtom,
  markAgentFileModifiedAtom,
  RECENTLY_MODIFIED_TTL_MS,
  applyAgentEvent,
  liveMessagesMapAtom,
  agentSessionModelMapAtom,
  agentSessionChannelMapAtom,
  agentModelIdAtom,
  agentChannelIdAtom,
  agentPermissionModeMapAtom,
  stoppedByUserSessionsAtom,
  agentPlanModeSessionsAtom,
  finalizeStreamingActivities,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  unviewedCompletedSessionIdsAtom,
  agentSessionPathMapAtom,
  agentDiffRefreshVersionAtom,
  askUserDraftsAtom,
  agentRuntimeExecutionGraphsAtom,
  agentRuntimePlanLifecycleAtom,
  activateAgentRuntimePlanTodoAtom,
  beginAgentFloatingPanelTurnAtom,
  interruptAgentRuntimePlanAtom,
  mergeAgentRuntimeExecutionGraphAtom,
} from '@/atoms/agent-atoms'
import {
  notificationsEnabledAtom,
  notificationSoundEnabledAtom,
  notificationSoundsAtom,
  sendDesktopNotification,
} from '@/atoms/notifications'
import { appModeAtom } from '@/atoms/app-mode'
import { tabsAtom, activeTabIdAtom, openTab, updateTabTitle } from '@/atoms/tab-atoms'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import { agentDiffUnseenChangesAtom, agentDiffUnseenFilesAtom } from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/chat-atoms'
import { previewFileMapAtom } from '@/atoms/preview-atoms'
import type { NotificationSoundType } from '@/types/settings'
import { toast } from 'sonner'
import type { AgentStreamEvent, AgentStreamCompletePayload, AgentEvent, AgentStreamPayload, SDKAssistantMessage, SDKUserMessage, SDKSystemMessage, SDKContentBlock, SDKUserContentBlock, SDKMessage, PromaEvent, AgentSessionMeta, AgentRuntimeExecutionGraph, ProviderType } from '@proma/shared'
import { pickRuntimeReportedContextWindow } from '@proma/shared'
import { buildExternalAgentRunActivation } from '@/lib/external-agent-run'
import {
  applyAgentDelegationStatusChange,
  upsertAgentSession,
  mergeFetchedAgentSessions,
} from '@/lib/agent-session-list'
import {
  reconcileAgentRunActivity,
  shouldSuppressAgentStreamError,
} from '@/lib/agent-running-state'
import {
  getAgentCompletionMarkers,
  notifyAgentCompletion,
} from '@/lib/agent-completion-presence'
import {
  getPlanModeChangeFromToolName,
  updatePlanModeSessionSet,
  updatePlanSuggestionForMode,
} from '@/lib/agent-plan-mode'
import { mergeAgentLiveMessages } from '@/lib/agent-live-message'
import {
  getExplicitRuntimePlanActivationTodoId,
  runtimePlanStatesFromPersistedStore,
  runtimePlanStatesToPersistedStore,
} from '@/lib/runtime-plan-lifecycle'

/** 用于记录成功写入文件的工具集合。 */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Update',
  'apply_patch',
  'ApplyPatch',
  'Patch',
])

/** Shell 类工具可能通过 sed、脚本等间接修改文件，完成后统一刷新改动统计。 */
const SHELL_TOOLS = new Set(['Bash', 'Shell'])

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

function getParentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return ''
  return normalized.slice(0, idx)
}

/** cyrb53: 快速字符串 hash，遍历完整内容避免边缘碰撞 */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

function uniqueTruthyPaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((p): p is string => typeof p === 'string' && p.length > 0)))
}

// ============================================================================
// Phase 1 临时兼容层：将 AgentStreamPayload 转换为旧 AgentEvent
// Phase 2 将移除此转换，直接使用 SDKMessage 渲染
// ============================================================================

function payloadToLegacyEvents(payload: AgentStreamPayload): AgentEvent[] {
  if (payload.kind === 'proma_event') {
    const evt = payload.event
    switch (evt.type) {
      case 'permission_request':
        return [{ type: 'permission_request', request: evt.request }]
      case 'permission_resolved':
        return [{ type: 'permission_resolved', requestId: evt.requestId, behavior: evt.behavior }]
      case 'ask_user_request':
        return [{ type: 'ask_user_request', request: evt.request }]
      case 'ask_user_resolved':
        return [{ type: 'ask_user_resolved', requestId: evt.requestId }]
      case 'exit_plan_mode_request':
        return [{ type: 'exit_plan_mode_request', request: evt.request }]
      case 'exit_plan_mode_resolved':
        return [{ type: 'exit_plan_mode_resolved', requestId: evt.requestId }]
      case 'enter_plan_mode':
        return [{ type: 'enter_plan_mode', sessionId: evt.sessionId }]
      case 'plan_mode_changed':
        return [{ type: 'plan_mode_changed', active: evt.active, source: evt.source }]
      case 'model_resolved':
        return [{ type: 'model_resolved', model: evt.model }]
      case 'context_window':
        // main 进程从 SDK result 拿到的真实 contextWindow，转成 usage_update 让 atom 合并到 streamState
        return [{ type: 'usage_update', usage: { contextWindow: evt.contextWindow } }]
      case 'permission_mode_changed':
        return [{ type: 'permission_mode_changed', mode: evt.mode }]
      case 'run_resumed':
        return [{ type: 'run_resumed' }]
      case 'retry': {
        const events: AgentEvent[] = []
        if (evt.status === 'starting' && evt.attempt != null && evt.maxAttempts != null) {
          events.push({ type: 'retrying', attempt: evt.attempt, maxAttempts: evt.maxAttempts, delaySeconds: evt.delaySeconds ?? 0, reason: evt.reason ?? '' })
        }
        if (evt.status === 'attempt' && evt.attemptData) {
          events.push({ type: 'retry_attempt', attemptData: evt.attemptData })
        }
        if (evt.status === 'cleared') {
          events.push({ type: 'retry_cleared' })
        }
        if (evt.status === 'failed' && evt.attemptData) {
          events.push({ type: 'retry_failed', finalAttempt: evt.attemptData })
        }
        return events
      }
      default:
        return []
    }
  }

  // sdk_message → 转换为对应的 AgentEvent
  const msg = payload.message

  switch (msg.type) {
    case 'assistant': {
      const aMsg = msg as SDKAssistantMessage
      if (aMsg.isReplay) return []
      if (aMsg.error) {
        // 错误已在主进程处理，这里仅作为 typed_error 透传
        return [{ type: 'error', message: aMsg.error.message }]
      }
      const events: AgentEvent[] = []
      for (const block of aMsg.message.content) {
        if (block.type === 'text' && 'text' in block) {
          events.push({ type: 'text_complete', text: (block as { text: string }).text, isIntermediate: false, parentToolUseId: aMsg.parent_tool_use_id ?? undefined })
        } else if (block.type === 'tool_use') {
          const tb = block as SDKContentBlock & { id: string; name: string; input: Record<string, unknown> }
          const intent = (tb.input._intent as string | undefined)
            ?? (tb.name === 'Bash' ? (tb.input.description as string | undefined) : undefined)
          const planModeChange = getPlanModeChangeFromToolName(tb.name)
          if (planModeChange) {
            events.push({
              type: 'plan_mode_changed',
              active: planModeChange.active,
              source: planModeChange.source,
            })
          }
          events.push({
            type: 'tool_start',
            toolName: tb.name,
            toolUseId: tb.id,
            input: tb.input,
            intent,
            displayName: tb.input._displayName as string | undefined,
            parentToolUseId: aMsg.parent_tool_use_id ?? undefined,
          })
        }
      }
      // Usage（保留完整字段用于详细展示）
      if (!aMsg.parent_tool_use_id && aMsg.message.usage) {
        const u = aMsg.message.usage
        const inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        events.push({
          type: 'usage_update',
          usage: {
            inputTokens,
            outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_input_tokens,
            cacheCreationTokens: u.cache_creation_input_tokens,
            ...(u.context_window != null ? { contextWindow: u.context_window } : {}),
          },
        })
      }
      return events
    }

    case 'user': {
      const uMsg = msg as SDKUserMessage
      if (uMsg.isReplay) return []
      const events: AgentEvent[] = []
      const contentBlocks = uMsg.message?.content ?? []
      for (const block of contentBlocks) {
        if (block.type === 'tool_result') {
          const tb = block as SDKUserContentBlock & { tool_use_id: string; content?: unknown; is_error?: boolean }
          const resultStr = typeof tb.content === 'string' ? tb.content : (tb.content != null ? JSON.stringify(tb.content) : '')
          events.push({
            type: 'tool_result',
            toolUseId: tb.tool_use_id,
            result: resultStr,
            isError: tb.is_error ?? false,
            parentToolUseId: uMsg.parent_tool_use_id ?? undefined,
          })
        }
      }
      return events
    }

    case 'result': {
      const rMsg = msg as {
        subtype: string
        total_cost_usd?: number
        modelUsage?: Record<string, { contextWindow?: number }>
        usage?: {
          input_tokens: number
          output_tokens: number
          cache_read_input_tokens: number
          cache_creation_input_tokens: number
          context_window?: number
        }
        isSyntheticCompactionResult?: boolean
      }
      if (rMsg.isSyntheticCompactionResult) {
        return [{
          type: 'complete',
          stopReason: rMsg.subtype === 'success' ? 'end_turn' : 'error',
        }]
      }
      // 多 entry 场景（Task 子 Agent 等）：取最大 contextWindow，
      // 避免子 Agent 的小窗口覆盖主模型的大窗口、导致指示器飘忽。
      const contextWindow = pickRuntimeReportedContextWindow(rMsg.modelUsage)
      // result.usage 是整个 query 内所有模型调用的累计求和，不能当成当前上下文占用，
      // 否则进度环会虚高、冲破 100%（PR #821 修的正是这个问题）。
      //
      // 但 GLM-5.2 等走 Anthropic 兼容端点的渠道，流式 assistant 消息不携带 usage 字段，
      // 真实值只在 result 中返回。若完全不透传，这些渠道的 ContextUsageBadge 永远不显示。
      //
      // 折中：完整透传 result.usage 字段，由 agent-atoms 的 complete 分支按
      // 「流式 usage_update 从未写入过」条件兜底（needFallback），避免覆盖流式真实值。
      const u = rMsg.usage
      const inputTokens = u ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined
      return [{
        type: 'complete',
        stopReason: rMsg.subtype === 'success' ? 'end_turn' : 'error',
        usage: (rMsg.total_cost_usd != null || contextWindow != null || u != null) ? {
          costUsd: rMsg.total_cost_usd,
          contextWindow,
          ...(inputTokens != null && { inputTokens }),
          ...(u && { outputTokens: u.output_tokens }),
          ...(u && { cacheReadTokens: u.cache_read_input_tokens }),
          ...(u && { cacheCreationTokens: u.cache_creation_input_tokens }),
          ...(u?.context_window != null ? { contextWindow: u.context_window } : {}),
        } : undefined,
      }]
    }

    case 'system': {
      const sMsg = msg as SDKSystemMessage
      if (sMsg.subtype === 'context_compaction_config') {
        if (
          typeof sMsg.autoCompactEnabled === 'boolean'
          && typeof sMsg.autoCompactThreshold === 'number'
          && typeof sMsg.effectiveContextWindow === 'number'
        ) {
          return [{
            type: 'context_compaction_config',
            autoCompactEnabled: sMsg.autoCompactEnabled,
            autoCompactThreshold: sMsg.autoCompactThreshold,
            effectiveContextWindow: sMsg.effectiveContextWindow,
          }]
        }
        return []
      }
      if (sMsg.subtype === 'compact_boundary') {
        const estimatedTokensAfter = sMsg.compactionEstimatedTokensAfter
        return [{
          type: 'compact_complete',
          status: 'success',
          trigger: sMsg.compactTrigger,
          summary: sMsg.summary,
          preTokens: sMsg.compactPreTokens,
          ...(typeof estimatedTokensAfter === 'number' && estimatedTokensAfter > 0 && { estimatedTokensAfter }),
        }]
      }
      if (sMsg.subtype === 'compacting') return [{ type: 'compacting', trigger: sMsg.compactTrigger }]
      if (sMsg.subtype === 'status') {
        if (sMsg.status === 'compacting') return [{ type: 'compacting', trigger: sMsg.compactTrigger }]
        if (sMsg.compact_result === 'success' || sMsg.compact_result === 'failed' || sMsg.compact_result === 'noop') {
          return [{
            type: 'compact_complete',
            status: sMsg.compact_result,
            summary: sMsg.summary,
            message: sMsg.compact_error ?? sMsg.message,
          }]
        }
        if (typeof sMsg.compact_error === 'string') {
          return [{ type: 'compact_complete', status: 'failed', message: sMsg.compact_error }]
        }
      }
      if (sMsg.subtype === 'task_started' && sMsg.task_id) {
        return [{ type: 'task_started', taskId: sMsg.task_id, description: sMsg.description ?? '', taskType: sMsg.task_type, toolUseId: sMsg.tool_use_id }]
      }
      if (sMsg.subtype === 'task_notification' && sMsg.task_id) {
        return [{
          type: 'task_notification',
          taskId: sMsg.task_id,
          status: (sMsg.status as 'completed' | 'failed' | 'stopped') ?? 'completed',
          summary: sMsg.summary ?? '',
          outputFile: sMsg.output_file,
          toolUseId: sMsg.tool_use_id,
          usage: sMsg.usage ? {
            totalTokens: sMsg.usage.total_tokens ?? 0,
            toolUses: sMsg.usage.tool_uses ?? 0,
            durationMs: sMsg.usage.duration_ms ?? 0,
          } : undefined,
        }]
      }
      if (sMsg.subtype === 'task_progress' && sMsg.task_id) {
        return [{
          type: 'task_progress',
          taskId: sMsg.task_id,
          toolUseId: sMsg.tool_use_id ?? sMsg.task_id,
          description: sMsg.description,
          lastToolName: sMsg.last_tool_name,
          usage: sMsg.usage ? {
            totalTokens: sMsg.usage.total_tokens ?? 0,
            toolUses: sMsg.usage.tool_uses ?? 0,
            durationMs: sMsg.usage.duration_ms ?? 0,
          } : undefined,
        }]
      }
      if (sMsg.subtype === 'thinking_tokens' && typeof sMsg.estimated_tokens === 'number') {
        return [{
          type: 'thinking_tokens',
          estimatedTokens: sMsg.estimated_tokens,
          estimatedTokensDelta: typeof sMsg.estimated_tokens_delta === 'number' ? sMsg.estimated_tokens_delta : 0,
        }]
      }
      return []
    }

    case 'tool_progress': {
      const tpMsg = msg as { tool_use_id: string; elapsed_time_seconds?: number; task_id?: string }
      return [{
        type: 'task_progress',
        toolUseId: tpMsg.tool_use_id,
        elapsedSeconds: tpMsg.elapsed_time_seconds,
        taskId: tpMsg.task_id,
      }]
    }

    case 'prompt_suggestion': {
      const psMsg = msg as { suggestion?: string }
      if (psMsg.suggestion) return [{ type: 'prompt_suggestion', suggestion: psMsg.suggestion }]
      return []
    }

    case 'tool_use_summary': {
      const tusMsg = msg as { summary?: string; preceding_tool_use_ids?: string[] }
      if (tusMsg.summary) return [{ type: 'tool_use_summary', summary: tusMsg.summary, precedingToolUseIds: tusMsg.preceding_tool_use_ids ?? [] }]
      return []
    }

    default:
      return []
  }
}


/** 判断 STREAM_COMPLETE 是否应弹出 Toast 提示（避免与 SDKMessageRenderer 已展示的错误重复）。 */
export function shouldShowStreamCompleteToast(payload: {
  resultSubtype?: string
  stoppedByUser?: boolean
  resultErrors?: unknown[]
}): boolean {
  if (!payload.resultSubtype) return false
  if (payload.resultSubtype === 'success') return false
  if (payload.stoppedByUser) return false
  // error_during_execution 的真实原因已经由主进程持久化为结构化错误消息，
  // SDKMessageRenderer 会展示这条消息；这里不再额外弹一条泛化 Toast，避免重复提示。
  if (payload.resultSubtype === 'error_during_execution' && payload.resultErrors?.some((error) => typeof error === 'string' && error.trim().length > 0)) {
    return false
  }
  return true
}

/** 生成 STREAM_COMPLETE Toast 文案；detail 优先展示 SDK 携带的真实原因。 */
export function streamCompleteToastMessage(payload: {
  resultSubtype?: string
  resultErrors?: Array<string | undefined>
}): string {
  const messages: Record<string, string> = {
    error_max_turns: '任务被中断：已达到轮次上限。继续对话可让 Agent 接着完成。',
    error_max_budget_usd: '任务被中断：已达到预算上限。',
    error_during_execution: '任务执行过程中发生错误。',
    empty_response: 'Agent 本轮结束了，但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。',
  }
  const detail = payload.resultErrors?.find((e) => typeof e === 'string' && e.trim().length > 0)?.trim()
  const fallback = payload.resultSubtype ? (messages[payload.resultSubtype] ?? `任务异常结束（${payload.resultSubtype}）`) : '任务异常结束'
  return detail ? `任务执行出错：${detail}` : fallback
}

export function useGlobalAgentListeners(): void {
  const store = useStore()

  useEffect(() => {
    // 任务看板：草稿会话发送时绑定 threadId 到任务
    // 从 TaskboardView 的 taskPendingBindRef 无法直接访问，改为监听 stream event 并检查 meta
    const bindTaskboardThread = async (sessionId: string): Promise<void> => {
      try {
        const sessions = await window.electronAPI.listAgentSessions()
        const session = sessions.find((item) => item.id === sessionId)
        if (!session || !session.taskboardTaskId) return
        // 会话已关联任务，检查任务是否需要绑定 threadId
        const task = await window.electronAPI.getTaskboardTask(session.taskboardTaskId)
        if (task && !task.threadId) {
          await window.electronAPI.updateTaskboardTask({
            id: task.id,
            version: task.version,
            threadId: sessionId,
          })
        }
      } catch (error) {
        console.error('[任务看板] 绑定 threadId 失败:', error)
      }
    }

    /** 正在执行的写工具：toolUseId → { path, sessionId } */
    const pendingWriteTools = new Map<string, { path: string; sessionId: string }>()
    /** 正在执行的 Shell 工具：toolUseId → sessionId（完成后刷新改动统计和 Diff）。 */
    const pendingShellTools = new Map<string, string>()
    interface PendingLiveMessage {
      message: SDKMessage
      runStartedAt?: number
    }
    /** 待合帧的实时 SDK 消息，按 session 隔离，确保后台会话不会阻塞当前会话。 */
    const pendingLiveMessages = new Map<string, PendingLiveMessage[]>()
    const liveMessageFlushFrames = new Map<string, number>()

    /**
     * 将一个 session 的实时消息一次性写入 atom。
     * 合帧只延迟渲染，不改变消息到达顺序；完成/错误/卸载前会主动 flush。
     */
    const flushLiveMessages = (sessionId: string): void => {
      const frame = liveMessageFlushFrames.get(sessionId)
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame)
        liveMessageFlushFrames.delete(sessionId)
      }

      const pending = pendingLiveMessages.get(sessionId)
      if (!pending || pending.length === 0) return
      pendingLiveMessages.delete(sessionId)

      // 合帧期间可能跨过“立即发送”切换点：旧 Runtime 的消息进入
      // pending 后，新回合已经建立。此时不能再把旧快照写回 live。
      const currentStartedAt = store.get(agentStreamingStatesAtom).get(sessionId)?.startedAt
      const currentPending = pending.filter((entry) =>
        entry.runStartedAt == null
        || currentStartedAt == null
        || entry.runStartedAt >= currentStartedAt,
      )
      if (currentPending.length === 0) return

      store.set(liveMessagesMapAtom, (prev) => {
        const current = prev.get(sessionId) ?? []
        const next = mergeAgentLiveMessages(
          current,
          currentPending.map((entry) => entry.message),
        )
        if (next === current) return prev
        const map = new Map(prev)
        map.set(sessionId, next)
        return map
      })
    }

    const scheduleLiveMessageFlush = (sessionId: string): void => {
      if (liveMessageFlushFrames.has(sessionId)) return
      const frame = window.requestAnimationFrame(() => {
        liveMessageFlushFrames.delete(sessionId)
        unstable_batchedUpdates(() => {
          flushLiveMessages(sessionId)
        })
      })
      liveMessageFlushFrames.set(sessionId, frame)
    }

    const flushAllLiveMessages = (): void => {
      for (const sessionId of pendingLiveMessages.keys()) {
        flushLiveMessages(sessionId)
      }
    }
    let runtimePlanStoreLoaded = false
    let runtimePlanSaveTimer: ReturnType<typeof setTimeout> | undefined
    const persistRuntimePlanStore = (): void => {
      runtimePlanSaveTimer = undefined
      const persisted = runtimePlanStatesToPersistedStore(
        store.get(agentRuntimePlanLifecycleAtom),
        Date.now(),
      )
      void window.electronAPI.saveAgentRuntimePlanStore(persisted)
        .catch((error) => {
          console.error('[Agent计划] 保存生命周期历史失败:', error)
        })
    }

    void window.electronAPI.getAgentRuntimePlanStore()
      .then((persisted) => {
        const loaded = runtimePlanStatesFromPersistedStore(
          persisted,
          Date.now(),
        )
        // 先开放保存，让本次合并顺便持久化清理后的过期状态和加载期间的新状态。
        runtimePlanStoreLoaded = true
        store.set(agentRuntimePlanLifecycleAtom, (current) => {
          const merged = new Map(loaded)
          for (const [sessionId, state] of current) {
            merged.set(sessionId, state)
          }
          return merged
        })
      })
      .catch((error) => {
        runtimePlanStoreLoaded = true
        console.error('[Agent计划] 加载生命周期历史失败:', error)
      })

    const unsubscribeRuntimePlanStore = store.sub(
      agentRuntimePlanLifecycleAtom,
      () => {
        if (!runtimePlanStoreLoaded) return
        if (runtimePlanSaveTimer) clearTimeout(runtimePlanSaveTimer)
        runtimePlanSaveTimer = setTimeout(persistRuntimePlanStore, 250)
      },
    )

    const bumpDiffRefresh = (sessionId: string): void => {
      store.set(agentDiffRefreshVersionAtom, (prev) => {
        const map = new Map(prev)
        map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
        return map
      })
    }

    /** 构建导航到指定会话的回调 */
    const makeNavigateToSession = (sessionId: string, sessionTitle: string) => () => {
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, { type: 'agent', sessionId, title: sessionTitle })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      store.set(appModeAtom, 'agent')
      store.set(currentAgentSessionIdAtom, sessionId)
      const sessions = store.get(agentSessionsAtom)
      const session = sessions.find((s) => s.id === sessionId)
      if (session?.workspaceId) {
        store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
      }
    }

    /** 获取会话标题 */
    const getSessionTitle = (sessionId: string): string => {
      const sessions = store.get(agentSessionsAtom)
      return sessions.find((s) => s.id === sessionId)?.title ?? '未命名会话'
    }

    const activateExternalAgentRun = (event: Extract<PromaEvent, { type: 'external_run_started' }>): void => {
      store.set(beginAgentFloatingPanelTurnAtom, {
        sessionId: event.sessionId,
        epoch: event.startedAt,
      })

      const applyActivation = (sessions: AgentSessionMeta[]): void => {
        const activation = buildExternalAgentRunActivation({
          tabs: store.get(tabsAtom),
          sessions,
          sessionId: event.sessionId,
          title: event.title,
          workspaceId: event.workspaceId,
          modelId: event.modelId,
          startedAt: event.startedAt,
          currentStreamState: store.get(agentStreamingStatesAtom).get(event.sessionId),
        })

        // 外部来源（飞书/钉钉/微信/bridge）唤起的 run 不抢占前台：
        // 不打开新 Tab、不切换激活 Tab、不切换 appMode/当前会话/当前工作区。
        // 只更新驱动左侧边栏列表与状态指示条所需的状态，让用户自行决定是否切过去。
        // 若该会话恰好是用户当前正在查看的会话，这里不动 Tab/激活，流式内容会通过
        // agentStreamingStatesAtom 自然刷新，用户视角无任何跳动。
        // 只 upsert 本次 event 对应的会话，绝不用这份快照整体覆盖列表。
        //
        // 一次派发多个子会话时，多个 external_run_started 回调会各自带着
        // 「事件触发那一刻」或「异步 fetch 那一刻」的快照进来。若整体覆盖
        // agentSessionsAtom，后 resolve 的回调会用自己那份可能缺失了刚结束
        // turn 的父会话的快照，把父会话冲掉——父会话从列表消失后，其子会话
        // 因找不到父而从树形子节点变成根节点直接显示（用户观察到的现象）。
        // 改为单条 upsert 后，每个回调只负责自己那一个会话，互不干扰。
        const sessionMeta = sessions.find((item) => item.id === event.sessionId)
        const upserted: AgentSessionMeta = sessionMeta ?? {
          id: event.sessionId,
          title: activation.title,
          workspaceId: activation.workspaceId,
          modelId: activation.modelId,
          createdAt: event.startedAt,
          updatedAt: event.startedAt,
        }
        store.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, upserted))
        const activationModelId = activation.modelId
        if (activationModelId) {
          store.set(agentSessionModelMapAtom, (prev) => {
            const map = new Map(prev)
            map.set(event.sessionId, activationModelId)
            return map
          })
        }
        store.set(unviewedCompletedSessionIdsAtom, (prev) => {
          if (!prev.has(event.sessionId)) return prev
          const next = new Set(prev)
          next.delete(event.sessionId)
          return next
        })
        store.set(agentStreamingStatesAtom, (prev) => {
          const map = new Map(prev)
          map.set(event.sessionId, activation.streamState)
          return map
        })
      }

      const knownSessions = store.get(agentSessionsAtom)
      if (knownSessions.some((session) => session.id === event.sessionId)) {
        applyActivation(knownSessions)
        return
      }

      window.electronAPI.listAgentSessions()
        .then((sessions) => {
          unstable_batchedUpdates(() => applyActivation(sessions))
        })
        .catch(console.error)
    }

    /** 发送阻塞通知（带提示音 + 会话导航） */
    const sendBlockingNotification = (sessionId: string, title: string, body: string, soundType: NotificationSoundType) => {
      const enabled = store.get(notificationsEnabledAtom)
      const soundEnabled = store.get(notificationSoundEnabledAtom)
      const sounds = store.get(notificationSoundsAtom)
      const sessionTitle = getSessionTitle(sessionId)
      sendDesktopNotification(
        title,
        `[${sessionTitle}] ${body}`,
        enabled,
        {
          force: true,
          playSound: enabled && soundEnabled,
          soundType,
          sounds,
          onNavigate: makeNavigateToSession(sessionId, sessionTitle),
        }
      )
    }

    const workspaceFilesPathCache = new Map<string, string>()

    const getWorkspaceIdForSession = (sid: string): string | null => {
      const session = store.get(agentSessionsAtom).find((s) => s.id === sid)
      return session?.workspaceId ?? store.get(currentAgentWorkspaceIdAtom)
    }

    const getWorkspaceSlugForSession = (sid: string): string | null => {
      const workspaceId = getWorkspaceIdForSession(sid)
      if (!workspaceId) return null
      return store.get(agentWorkspacesAtom).find((w) => w.id === workspaceId)?.slug ?? null
    }

    const getWorkspaceFilesPathForSession = async (sid: string): Promise<string | null> => {
      const slug = getWorkspaceSlugForSession(sid)
      if (!slug) return null
      const cached = workspaceFilesPathCache.get(slug)
      if (cached) return cached
      try {
        const path = await window.electronAPI.getWorkspaceFilesPath(slug)
        workspaceFilesPathCache.set(slug, path)
        return path
      } catch {
        return null
      }
    }

    const buildWrittenFilePreviewInfo = async (sid: string, targetPath: string) => {
      const sessionPath = store.get(agentSessionPathMapAtom).get(sid) ?? ''
      const parentDir = getParentDir(targetPath)
      const dirPath = isAbsolutePath(targetPath) ? parentDir : (sessionPath || parentDir)
      const workspaceId = getWorkspaceIdForSession(sid)
      const workspaceFilesPath = await getWorkspaceFilesPathForSession(sid)
      const sessionAttachedDirs = store.get(agentAttachedDirectoriesMapAtom).get(sid) ?? []
      const sessionAttachedFiles = store.get(agentAttachedFilesMapAtom).get(sid) ?? []
      const workspaceAttachedDirs = workspaceId
        ? (store.get(workspaceAttachedDirectoriesMapAtom).get(workspaceId) ?? [])
        : []
      const workspaceAttachedFiles = workspaceId
        ? (store.get(workspaceAttachedFilesMapAtom).get(workspaceId) ?? [])
        : []
      const basePaths = uniqueTruthyPaths([
        sessionPath,
        workspaceFilesPath,
        dirPath,
        ...sessionAttachedDirs,
        ...sessionAttachedFiles,
        ...workspaceAttachedDirs,
        ...workspaceAttachedFiles,
      ])

      let previewOnly = true
      if (dirPath) {
        try {
          const status = await window.electronAPI.getGitRepoStatus(dirPath)
          previewOnly = status?.isRepo !== true
        } catch {
          previewOnly = true
        }
      }

      // 检查文件是否落在当前会话的 diff scope 内（与 getUnstagedChanges 的 candidates 对齐）
      // 注：未纳入 dirPath，因为 DiffChangesList 调用时 dirPath 始终等于 sessionPath
      // 路径分隔符统一为正斜杠，避免 Windows 下 client 与服务端（path.sep='\\'）方向不一致导致反向错配
      const toForwardSlash = (p: string) => p.replace(/\\/g, '/')
      const sessionScopePaths = uniqueTruthyPaths([
        sessionPath,
        workspaceFilesPath,
        ...sessionAttachedDirs,
        ...workspaceAttachedDirs,
      ]).map(toForwardSlash)
      const absTarget = toForwardSlash(
        isAbsolutePath(targetPath)
          ? targetPath
          : (sessionPath ? `${sessionPath.replace(/[/\\]+$/, '')}/${targetPath}` : targetPath)
      )
      const inDiffScope = sessionScopePaths.some((root) => {
        const r = root.replace(/\/+$/, '') + '/'
        return absTarget === root || absTarget.startsWith(r)
      })

      return {
        filePath: targetPath,
        dirPath: dirPath || undefined,
        previewOnly,
        inDiffScope,
        basePaths: basePaths.length > 0 ? basePaths : undefined,
      }
    }

    // ===== 0. 初始化：从持久化 meta 恢复 stoppedByUser 状态 =====
    window.electronAPI.listAgentSessions().then((sessions) => {
      const stoppedIds = new Set<string>(
        sessions.filter((s) => s.stoppedByUser).map((s) => s.id)
      )
      if (stoppedIds.size > 0) {
        store.set(stoppedByUserSessionsAtom, stoppedIds)
      }
    }).catch(console.error)

    const cleanupCatalogSynced = window.electronAPI.onAgentSessionCatalogSynced(
      ({ sessions }) => {
        store.set(agentSessionsAtom, (prev) =>
          mergeFetchedAgentSessions(prev, sessions),
        )
      },
    )

    // ===== 1. 流式事件 =====
    // [FLASH-DEBUG] 事件频率计数器
    let eventCount = 0
    let lastLogTime = Date.now()
    const cleanupEvent = window.electronAPI.onAgentStreamEvent(
      (streamEvent: AgentStreamEvent) => {
        // [FLASH-DEBUG] 每 2 秒输出一次事件频率
        eventCount++
        const now = Date.now()
        if (now - lastLogTime >= 2000) {
          console.log(`[FLASH-DEBUG] GlobalListener: ${eventCount} events in ${((now - lastLogTime) / 1000).toFixed(1)}s (${(eventCount / ((now - lastLogTime) / 1000)).toFixed(1)} evt/s)`)
          eventCount = 0
          lastLogTime = now
        }

        unstable_batchedUpdates(() => {
        const { sessionId, payload } = streamEvent
        const currentStartedAt = store.get(agentStreamingStatesAtom).get(sessionId)?.startedAt
        // “立即发送”会先在 Renderer 展示新回合，再等待旧 Runtime 收尾。
        // 旧 Runtime 的尾部事件仍可能晚到；按 runStartedAt 丢弃它们，
        // 防止旧正文/工具状态写进新回合。
        if (
          payload.runStartedAt != null
          && currentStartedAt != null
          && payload.runStartedAt < currentStartedAt
        ) {
          return
        }

        if (payload.kind === 'proma_event' && payload.event.type === 'external_run_started') {
          activateExternalAgentRun(payload.event)
        }

        if (
          payload.kind === 'proma_event'
          && payload.event.type === 'delegation_status_changed'
        ) {
          const event = payload.event
          const currentSessions = store.get(agentSessionsAtom)
          const childKnown = currentSessions.some(
            (session) => session.id === event.childSessionId,
          )
          store.set(agentSessionsAtom, (previous) =>
            applyAgentDelegationStatusChange(previous, {
              childSessionId: event.childSessionId,
              status: event.status,
              updatedAt: event.updatedAt,
            }),
          )
          if (!childKnown) {
            window.electronAPI.listAgentSessions()
              .then((sessions) => {
                store.set(agentSessionsAtom, (previous) =>
                  mergeFetchedAgentSessions(previous, sessions),
                )
              })
              .catch(console.error)
          }
        }

        // 自动任务会话被用户接管（毕业）：向用户提示，后续定时运行将新建独立会话
        if (payload.kind === 'proma_event' && payload.event.type === 'automation_graduated') {
          toast('已接管自动任务会话，后续定时运行将创建新会话。', { duration: 3000 })
          window.electronAPI.listAgentSessions()
            .then((sessions) => store.set(agentSessionsAtom, (prev) => mergeFetchedAgentSessions(prev, sessions)))
            .catch(console.error)
        }

        // 如果收到未知会话的事件（跨工作区场景），立即刷新会话列表
        const knownSessions = store.get(agentSessionsAtom)
        if (!knownSessions.some((s) => s.id === sessionId)) {
          window.electronAPI.listAgentSessions()
            .then((sessions) => store.set(agentSessionsAtom, (prev) => mergeFetchedAgentSessions(prev, sessions)))
            .catch(console.error)
        }

        // Phase 2: 直接累积 SDKMessage 到 liveMessagesMapAtom（跳过 replay 消息，避免与持久化消息重复）
        if (payload.kind === 'sdk_message') {
          const msgRecord = payload.message as Record<string, unknown>
          // prompt_suggestion 不是对话转录消息，不能进入 liveMessages（会被错误渲染到最后一条助手消息中）
          // 它通过下方 legacyEvents 分支写入 agentPromptSuggestionsAtom，显示在输入框上方
          if (msgRecord.type === 'prompt_suggestion') {
            // 跳过写入 liveMessages
          } else if (msgRecord.type === 'runtime_execution_graph') {
            const graph = msgRecord.graph as AgentRuntimeExecutionGraph | undefined
            if (graph) {
              store.set(mergeAgentRuntimeExecutionGraphAtom, {
                sessionId,
                graph,
              })
            }
          } else if (msgRecord.type === 'system' && msgRecord.subtype === 'thinking_tokens') {
            // thinking_tokens 是高频进度估算，只更新流式状态，不进入消息转录。
          } else if (!msgRecord.isReplay) {
            // 为实时消息补充 _createdAt 时间戳（与持久化时的逻辑一致），
            // 避免 AssistantTurnRenderer 因缺少时间戳导致 header 时间消失
            if (typeof msgRecord._createdAt !== 'number') {
              msgRecord._createdAt = Date.now()
            }

            // 为 assistant 消息注入渠道信息，确保流式期间就绑定正确模型与 Agent SDK 窗口
            if (msgRecord.type === 'assistant' && !msgRecord._channelModelId) {
              const sessionModelMap = store.get(agentSessionModelMapAtom)
              const defaultModelId = store.get(agentModelIdAtom)
              msgRecord._channelModelId = sessionModelMap.get(sessionId) ?? defaultModelId ?? undefined
            }
            if (msgRecord.type === 'assistant' && !msgRecord._channelProvider) {
              const sessionChannelMap = store.get(agentSessionChannelMapAtom)
              const defaultChannelId = store.get(agentChannelIdAtom)
              const channelId = sessionChannelMap.get(sessionId) ?? defaultChannelId ?? undefined
              const channels = store.get(channelsAtom)
              const provider = channels.find((c) => c.id === channelId)?.provider
              if (provider) {
                msgRecord._channelProvider = provider as ProviderType
              }
            }

            const pending = pendingLiveMessages.get(sessionId) ?? []
            pending.push({
              message: payload.message,
              runStartedAt: payload.runStartedAt,
            })
            pendingLiveMessages.set(sessionId, pending)
            scheduleLiveMessageFlush(sessionId)
          }
        }

        // Phase 1 兼容：将新 AgentStreamPayload 转换为旧 AgentEvent[]
        const legacyEvents = payloadToLegacyEvents(payload)

        for (const event of legacyEvents) {
          // 会话首次进入 running 时，清除旧的完成提醒状态
          if (event.type !== 'prompt_suggestion') {
            const prevState = store.get(agentStreamingStatesAtom).get(sessionId)
            if (!prevState || !prevState.running) {
              store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {
                if (!prev.has(sessionId)) return prev
                const next = new Set(prev)
                next.delete(sessionId)
                return next
              })
            }
          }

          // 更新流式状态（prompt_suggestion 不影响流式状态，跳过以避免在 session 结束后用默认值 running:true 重新激活）
          if (event.type !== 'prompt_suggestion') {
            store.set(agentStreamingStatesAtom, (prev) => {
              const current: AgentStreamState = prev.get(sessionId) ?? {
                running: true,
                content: '',
                toolActivities: [],
                model: undefined,
                // startedAt 留空：让 STREAM_COMPLETE 竞态保护跳过时间戳比较，
                // 正常流程中 handleSend 已设置了正确的 startedAt，此 fallback 仅在极端情况下触发
                startedAt: undefined,
              }
              const next = applyAgentEvent(
                reconcileAgentRunActivity(current, event),
                event,
              )
              const map = new Map(prev)
              map.set(sessionId, next)
              return map
            })
          }

          // RightSidePanel 由用户完全控制，Agent 行为不影响其开关、Tab、滚动或目录展开状态。
          // 此处只记录待完成的写工具；文件刷新和最近修改标记在工具完成后处理。
          if (event.type === 'tool_start' && WRITE_TOOLS.has(event.toolName)) {
            const input = event.input as Record<string, unknown> | undefined
            const targetPath =
              (input?.file_path as string | undefined)
              ?? (input?.path as string | undefined)
              ?? (input?.notebook_path as string | undefined)
            pendingWriteTools.set(event.toolUseId, { path: targetPath || '', sessionId })
          }

          // Shell 工具可能通过 sed、脚本等间接修改文件，完成后统一刷新。
          if (event.type === 'tool_start' && SHELL_TOOLS.has(event.toolName)) {
            pendingShellTools.set(event.toolUseId, sessionId)
          }

          if (event.type === 'tool_start' && event.toolName === 'TaskUpdate') {
            const input = event.input as Record<string, unknown> | undefined
            const todoId = getExplicitRuntimePlanActivationTodoId(input)
            if (todoId) {
              store.set(activateAgentRuntimePlanTodoAtom, {
                sessionId,
                todoId,
              })
            }
          }

          // 处理后台任务事件
          if (event.type === 'task_backgrounded') {
            store.set(backgroundTasksAtomFamily(sessionId), (prev) => {
              if (prev.some((t) => t.toolUseId === event.toolUseId)) return prev
              return [...prev, {
                id: event.taskId,
                type: 'agent' as const,
                toolUseId: event.toolUseId,
                startTime: Date.now(),
                elapsedSeconds: 0,
                intent: event.intent,
              }]
            })
          } else if (event.type === 'task_progress') {
            store.set(backgroundTasksAtomFamily(sessionId), (prev) =>
              prev.map((t) =>
                t.toolUseId === event.toolUseId
                  ? { ...t, elapsedSeconds: event.elapsedSeconds ?? t.elapsedSeconds }
                  : t
              )
            )
          } else if (event.type === 'shell_backgrounded') {
            store.set(backgroundTasksAtomFamily(sessionId), (prev) => {
              if (prev.some((t) => t.toolUseId === event.toolUseId)) return prev
              return [...prev, {
                id: event.shellId,
                type: 'shell' as const,
                toolUseId: event.toolUseId,
                startTime: Date.now(),
                elapsedSeconds: 0,
                intent: event.command || event.intent,
              }]
            })
          } else if (event.type === 'tool_result') {
            // 工具完成时，移除对应的后台任务
            store.set(backgroundTasksAtomFamily(sessionId), (prev) =>
              prev.filter((t) => t.toolUseId !== event.toolUseId)
            )
            // Agent 写类工具完成时，递增 diff 刷新版本号并标记未查看改动
            if (pendingWriteTools.has(event.toolUseId)) {
              const entry = pendingWriteTools.get(event.toolUseId)!
              const writtenPath = entry.path
              pendingWriteTools.delete(event.toolUseId)
              bumpDiffRefresh(sessionId)
              if (writtenPath && !event.isError) {
                // 只标记成功写入的文件，不发送自动定位信号。
                store.set(markAgentFileModifiedAtom, {
                  sessionId,
                  path: writtenPath,
                  modifiedAt: Date.now(),
                })
                buildWrittenFilePreviewInfo(sessionId, writtenPath).then((previewFile) => {
                  if (!previewFile || previewFile.previewOnly || !previewFile.inDiffScope) return

                  store.set(agentDiffUnseenChangesAtom, (prev) => {
                    const m = new Map(prev); m.set(sessionId, true); return m
                  })
                  store.set(agentDiffUnseenFilesAtom, (prev) => {
                    const m = new Map(prev)
                    const s = new Set(m.get(sessionId) ?? [])
                    s.add(writtenPath)
                    m.set(sessionId, s)
                    return m
                  })

                }).catch(() => { /* 改动提示不应影响流式输出 */ })
              }
            }
            // Shell 工具完成时仅刷新统计和 Diff，不标记 unseen，避免普通命令触发红点。
            if (pendingShellTools.has(event.toolUseId)) {
              pendingShellTools.delete(event.toolUseId)
              bumpDiffRefresh(sessionId)
            }
          } else if (event.type === 'shell_killed') {
            store.set(backgroundTasksAtomFamily(sessionId), (prev) => {
              const task = prev.find((t) => t.id === event.shellId)
              if (!task) return prev
              return prev.filter((t) => t.toolUseId !== task.toolUseId)
            })
          } else if (event.type === 'prompt_suggestion') {
            // 存储提示建议到 atom
            console.log(`[GlobalAgentListeners] 收到建议: sessionId=${sessionId}, suggestion="${event.suggestion.slice(0, 50)}..."`)
            store.set(agentPromptSuggestionsAtom, (prev) => {
              const map = new Map(prev)
              map.set(sessionId, event.suggestion)
              return map
            })
          } else if (event.type === 'permission_request') {
            // 权限请求入队（统一通道，不区分当前/后台会话）
            store.set(allPendingPermissionRequestsAtom, (prev) => {
              const map = new Map(prev)
              const current = map.get(sessionId) ?? []
              map.set(sessionId, [...current, event.request])
              return map
            })
            // 桌面通知（带提示音 + 会话导航）
            sendBlockingNotification(
              sessionId,
              '需要权限确认',
              event.request.toolName
                ? `Agent 请求使用工具: ${event.request.toolName}`
                : 'Agent 需要你的权限确认',
              'permissionRequest'
            )
          } else if (event.type === 'ask_user_request') {
            // AskUser 请求入队（统一通道，不区分当前/后台会话）
            store.set(allPendingAskUserRequestsAtom, (prev) => {
              const map = new Map(prev)
              const current = map.get(sessionId) ?? []
              map.set(sessionId, [...current, event.request])
              return map
            })
            // 桌面通知（带提示音 + 会话导航）
            sendBlockingNotification(
              sessionId,
              'Agent 需要你的输入',
              event.request.questions[0]?.question ?? 'Agent 有问题需要你回答',
              'permissionRequest'
            )
          } else if (event.type === 'ask_user_resolved') {
            // AskUser 可能由协作父会话代答，收到 resolved 后清理所有会话中的残留请求和草稿
            store.set(allPendingAskUserRequestsAtom, (prev) => {
              let changed = false
              const map = new Map(prev)
              prev.forEach((requests, pendingSessionId) => {
                const nextRequests = requests.filter((request) => request.requestId !== event.requestId)
                if (nextRequests.length !== requests.length) changed = true
                if (nextRequests.length === 0) map.delete(pendingSessionId)
                else map.set(pendingSessionId, nextRequests)
              })
              return changed ? map : prev
            })
            store.set(askUserDraftsAtom, (prev) => {
              if (!prev.has(event.requestId)) return prev
              const map = new Map(prev)
              map.delete(event.requestId)
              return map
            })
          } else if (event.type === 'exit_plan_mode_request') {
            // ExitPlanMode 请求入队
            store.set(allPendingExitPlanRequestsAtom, (prev) => {
              const map = new Map(prev)
              const current = map.get(sessionId) ?? []
              map.set(sessionId, [...current, event.request])
              return map
            })
            // 桌面通知（带提示音 + 会话导航）
            sendBlockingNotification(
              sessionId,
              'Agent 计划待审批',
              'Agent 已完成计划，等待你的审批',
              'exitPlanMode'
            )
          } else if (event.type === 'enter_plan_mode') {
            // 进入 Plan 模式
            store.set(agentPlanModeSessionsAtom, (prev: Set<string>) =>
              updatePlanModeSessionSet(prev, sessionId, true)
            )
            store.set(agentSessionsAtom, (prev) => prev.map((session) =>
              session.id === sessionId ? { ...session, planModeEnabled: true } : session
            ))
          } else if (event.type === 'plan_mode_changed') {
            // 计划阶段变化只影响输入框/横幅状态，不改用户选择的权限模式
            store.set(agentPlanModeSessionsAtom, (prev: Set<string>) =>
              updatePlanModeSessionSet(prev, sessionId, event.active)
            )
            store.set(agentPromptSuggestionsAtom, (prev) =>
              updatePlanSuggestionForMode(prev, sessionId, event.active)
            )
            store.set(agentSessionsAtom, (prev) => prev.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    planModeEnabled: event.active,
                  }
                : session
            ))
          } else if (event.type === 'permission_mode_changed') {
            // 权限模式变更（如 Plan 模式退出后切换到完全自动）
            console.log(`[GlobalAgentListeners] 权限模式变更: ${event.mode}`)
            store.set(agentPermissionModeMapAtom, (prev: Map<string, import('@proma/shared').PromaPermissionMode>) => {
              const next = new Map(prev)
              next.set(sessionId, event.mode)
              return next
            })
            store.set(agentPlanModeSessionsAtom, (prev: Set<string>) =>
              updatePlanModeSessionSet(prev, sessionId, event.mode === 'plan')
            )
            store.set(agentPromptSuggestionsAtom, (prev) =>
              updatePlanSuggestionForMode(prev, sessionId, event.mode === 'plan')
            )
            store.set(agentSessionsAtom, (prev) => prev.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    permissionMode: event.mode === 'plan' ? session.permissionMode : event.mode,
                    planModeEnabled: event.mode === 'plan',
                  }
                : session
            ))
          } else if (event.type === 'run_resumed') {
            // 后台任务完成自动唤醒：从"空闲可输入"恢复到"运行中"。
            store.set(agentStreamingStatesAtom, (prev) => {
              const current = prev.get(sessionId)
              if (!current || current.running || current.stopping) return prev
              const map = new Map(prev)
              map.set(sessionId, { ...current, running: true })
              return map
            })
          }
        }
        }) // unstable_batchedUpdates
      }
    )

    // ===== 2. 流式完成 =====
    const cleanupComplete = window.electronAPI.onAgentStreamComplete(
      (data: AgentStreamCompletePayload) => {
        console.log(`[FLASH-DEBUG] STREAM_COMPLETE for session=${data.sessionId.slice(0, 8)}, stoppedByUser=${data.stoppedByUser}, resultSubtype=${data.resultSubtype}`)
        unstable_batchedUpdates(() => {
        // 完成事件可能早于最后一个逐帧刷新回调，先收尾实时消息再刷新持久化投影。
        flushLiveMessages(data.sessionId)
        // 后台任务等待态：turn 主体结束但仍有后台任务在飞行，UI 进入"空闲可输入"。
        // 不发"任务已完成"通知（任务并未真正完成）、不清后台任务列表、不重载消息——
        // 等后台任务完成时 Agent 会自动唤醒续轮。
        const backgroundTasksPending = data.backgroundTasksPending === true
        const hasStreamError = store.get(agentStreamErrorsAtom).has(data.sessionId)

        // 本轮真正结束时再刷新一次，捕获工具结果落盘与完成事件之间的最后改动。
        const streamBeforeCompletion = store.get(agentStreamingStatesAtom).get(data.sessionId)
        const isCurrentCompletion = Boolean(
          streamBeforeCompletion
          && (
            streamBeforeCompletion.running
            || streamBeforeCompletion.backgroundWaiting
            || streamBeforeCompletion.stopping
          )
          && !(
            streamBeforeCompletion.startedAt != null
            && (
              data.startedAt == null
              || streamBeforeCompletion.startedAt > data.startedAt
            )
          )
        )
        if (isCurrentCompletion) bumpDiffRefresh(data.sessionId)

        // 发送桌面通知（仅真正成功完成时播放提示音，错误/中断/异常完成不伪装成完成）
        const completionSession = store.get(agentSessionsAtom)
          .find((session) => session.id === data.sessionId)
        const enabled = store.get(notificationsEnabledAtom)
        const soundEnabled = store.get(notificationSoundEnabledAtom)
        const sounds = store.get(notificationSoundsAtom)
        const sessionTitle = getSessionTitle(data.sessionId)
        notifyAgentCompletion({
          completion: data,
          session: completionSession,
          hasStreamError,
          notify: () => {
            sendDesktopNotification(
              'Agent 任务完成',
              `[${sessionTitle}] 任务已完成`,
              enabled,
              {
                playSound: enabled && soundEnabled,
                soundType: 'taskComplete',
                sounds,
                onNavigate: makeNavigateToSession(data.sessionId, sessionTitle),
              }
            )
          },
        })

        // 任务看板：会话完成时绑定 threadId（草稿会话发送后）
        void bindTaskboardThread(data.sessionId)

        // STREAM_COMPLETE 表示后端已完全结束 — 立即标记 running: false
        // 同时将所有未完成的工具活动标记为已完成，防止 subagent spinner 继续转动
        // （complete 事件只清除 retrying，保持 running: true 以防竞态）
        // 竞态保护：通过 startedAt 区分新旧流，防止旧流的 complete 事件重置新流的 running 状态
        store.set(agentStreamingStatesAtom, (prev) => {
          const current = prev.get(data.sessionId)
          // 既非运行中、也非软空闲态、也非等待 Runtime 收尾 → 已彻底结束，忽略重复/陈旧的完成事件。
          // 软空闲态（running=false 但 backgroundWaiting=true）也要处理：空闲超时/用户停止
          // 触发的真正完成会带 backgroundTasksPending=false，需借此清除 backgroundWaiting。
          if (!current || (!current.running && !current.backgroundWaiting && !current.stopping)) {
            return prev
          }
          if (current.startedAt != null && (data.startedAt == null || current.startedAt > data.startedAt)) {
            return prev
          }
          const map = new Map(prev)
          map.set(data.sessionId, {
            ...current,
            running: false,
            stopping: false,
            // 压缩未收到终态事件（如用户在压缩中暂停）时，在流结束时收尾：
            // 收不到失败信息则按成功收敛，确保对话流显示「上下文已压缩 / 上下文已自动压缩」。
            ...(current.isCompacting && {
              isCompacting: false,
              contextCompaction: {
                status: 'success' as const,
                trigger: current.contextCompaction?.trigger,
              },
            }),
            // backgroundTasksPending=true → 进入/保持软空闲态（通道仍开着，handleSend 走注入路径）；
            // false → 真正结束，清除软空闲态，新消息回到新建 run 路径。
            backgroundWaiting: backgroundTasksPending,
            ...finalizeStreamingActivities(current.toolActivities),
          })
          return map
        })

        // 只有未激活会话才进入"未查看完成"，避免当前页面完成时出现额外未读提醒。
        const currentSessionId = store.get(currentAgentSessionIdAtom)
        const completionMarkers = getAgentCompletionMarkers({
          tabs: store.get(tabsAtom),
          activeTabId: store.get(activeTabIdAtom),
          currentAgentSessionId: currentSessionId,
          sessionId: data.sessionId,
          documentHasFocus: document.hasFocus(),
        })
        if (completionMarkers.markUnviewedCompleted && !backgroundTasksPending) {
          store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {
            const next = new Set(prev)
            next.add(data.sessionId)
            return next
          })
        }

        // 标记用户主动打断状态，并立刻写入耗时，避免等 listAgentSessions 才显示「你在 N 秒后停止了」
        // 旧回合在新回合已经启动后才到达 complete 时，不能把新回合
        // 再标记成 stoppedByUser；否则新消息虽然在运行，旧暂停状态仍会
        // 把旧内容/停止文案覆盖到新回合上。
        if (data.stoppedByUser && isCurrentCompletion) {
          store.set(stoppedByUserSessionsAtom, (prev: Set<string>) => {
            const next = new Set(prev)
            next.add(data.sessionId)
            return next
          })
          if (data.lastStopDurationMs != null && data.lastStopDurationMs > 0) {
            store.set(agentSessionsAtom, (prev) => prev.map((session) => (
              session.id === data.sessionId
                ? {
                    ...session,
                    stoppedByUser: true,
                    lastStopDurationMs: data.lastStopDurationMs,
                  }
                : session
            )))
          }
        }

        const runtimePlanTurnEpoch = store.get(agentRuntimePlanLifecycleAtom)
          .get(data.sessionId)?.turnEpoch
        const isCurrentPlanCompletion = runtimePlanTurnEpoch == null
          ? isCurrentCompletion
          : data.startedAt === runtimePlanTurnEpoch
        if (!backgroundTasksPending && isCurrentPlanCompletion) {
          store.set(interruptAgentRuntimePlanAtom, data.sessionId)
        }

        // 非正常结束时显示截断提示；error_during_execution 已持久化真实原因时
        // 由 SDKMessageRenderer 展示，不重复弹 Toast。
        if (shouldShowStreamCompleteToast(data)) {
          toast.warning(streamCompleteToastMessage(data), { duration: 8000 })
        }

        // 清除 Plan 模式状态（防止异常退出时残留）
        store.set(agentPlanModeSessionsAtom, (prev: Set<string>) => {
          if (!prev.has(data.sessionId)) return prev
          const next = new Set(prev)
          next.delete(data.sessionId)
          return next
        })

        /** 竞态保护：检查该会话是否已有新的流式请求正在运行 */
        const isNewStreamRunning = (): boolean => {
          const state = store.get(agentStreamingStatesAtom).get(data.sessionId)
          return state?.running === true
        }

        /** 递增消息刷新版本号，通知 AgentView 重新加载消息 */
        const bumpRefresh = (): void => {
          store.set(agentMessageRefreshAtom, (prev) => {
            const map = new Map(prev)
            map.set(data.sessionId, (prev.get(data.sessionId) ?? 0) + 1)
            return map
          })
        }

        const finalize = (): void => {
          // 竞态保护：新流已启动时不要清理状态
          if (isNewStreamRunning()) return

          // 后台任务等待态：保留后台任务列表（面板继续显示在跑任务），不做收尾清理，
          // 等任务完成 Agent 自动唤醒续轮后再走真正的完成路径。
          if (backgroundTasksPending) return

          // 清理后台任务
          store.set(backgroundTasksAtomFamily(data.sessionId), [])

          // 清理该 session 关联的未完成写工具记录，防止内存泄漏
          for (const [toolId, entry] of pendingWriteTools) {
            if (entry.sessionId === data.sessionId) {
              pendingWriteTools.delete(toolId)
            }
          }
          for (const [toolId, sid] of pendingShellTools) {
            if (sid === data.sessionId) {
              pendingShellTools.delete(toolId)
            }
          }

          // 注意：liveMessages 的清理已移至 AgentView 消息加载完成后执行，
          // 与 streamingState 清理同步，避免「实时消息已清 → 持久化消息未到」的空档闪烁

          // 刷新会话列表并同步 stoppedByUser 状态
          window.electronAPI
            .listAgentSessions()
            .then((sessions) => {
              // 合并而非整体覆盖：避免与并发的 external_run_started 回调互相用
              // 陈旧快照冲掉对方刚写入的会话（如刚结束 turn 的父会话）。
              store.set(agentSessionsAtom, (prev) => mergeFetchedAgentSessions(prev, sessions))
              // 从持久化 meta 对齐 stoppedByUser 状态
              store.set(stoppedByUserSessionsAtom, new Set<string>(
                sessions.filter((s) => s.stoppedByUser).map((s) => s.id)
              ))
            })
            .catch(console.error)

          // 注意：流式状态的完全清除由 AgentView 在消息加载完成后执行，
          // 确保不会出现「气泡消失 → 持久化消息尚未加载」的空档闪烁
        }

        // 通知 AgentView 重新加载消息（无论是否为当前会话）
        if (!isNewStreamRunning()) {
          bumpRefresh()
        }
        finalize()
        }) // unstable_batchedUpdates
      }
    )

    // ===== 3. 流式错误 =====
    const cleanupError = window.electronAPI.onAgentStreamError(
      (data: { sessionId: string; error: string }) => {
        unstable_batchedUpdates(() => {
        // 错误路径同样不能遗失定时器中的最后一批思考/正文。
        flushLiveMessages(data.sessionId)

        const streamState = store.get(agentStreamingStatesAtom).get(data.sessionId)
        const stoppedByUser = store.get(stoppedByUserSessionsAtom).has(data.sessionId)
        if (shouldSuppressAgentStreamError(streamState, stoppedByUser)) {
          console.info(`[GlobalAgentListeners] 已忽略用户暂停期间的 Runtime 收尾错误: session=${data.sessionId}`)
          return
        }
        console.error('[GlobalAgentListeners] 流式错误:', data.error)

        // 存储错误消息
        store.set(agentStreamErrorsAtom, (prev) => {
          const map = new Map(prev)
          map.set(data.sessionId, data.error)
          return map
        })

        // 递增消息刷新版本号，通知 AgentView 重新加载消息
        if (!streamState?.running) {
          store.set(agentMessageRefreshAtom, (prev) => {
            const map = new Map(prev)
            map.set(data.sessionId, (prev.get(data.sessionId) ?? 0) + 1)
            return map
          })
        }
        }) // unstable_batchedUpdates
      }
    )

    // ===== 4. 标题更新 =====
    const cleanupTitleUpdated = window.electronAPI.onAgentTitleUpdated(({ sessionId, title }) => {
      // 先使用事件 payload 立即同步标签页，避免依赖会话列表旧快照比较。
      store.set(tabsAtom, (tabs) => updateTabTitle(tabs, sessionId, title))
      store.set(agentSessionsAtom, (prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s))
      )
      // 保留全量刷新语义：外部桥接会复用该事件通知新会话/绑定变化。
      window.electronAPI
        .listAgentSessions()
        .then((sessions) => {
          store.set(agentSessionsAtom, (prev) => mergeFetchedAgentSessions(prev, sessions))
        })
        .catch(console.error)
    })

    // 定期清理 60s 前的「最近修改」标记，避免 atom 无限增长
    const pruneTimer = setInterval(() => {
      const cutoff = Date.now() - RECENTLY_MODIFIED_TTL_MS
      store.set(recentlyModifiedPathsAtom, (prev) => {
        let changed = false
        const next = new Map<string, Map<string, number>>()
        for (const [sid, inner] of prev) {
          const filtered = new Map<string, number>()
          for (const [p, t] of inner) {
            if (t > cutoff) filtered.set(p, t)
            else changed = true
          }
          if (filtered.size > 0) next.set(sid, filtered)
          else changed = true
        }
        return changed ? next : prev
      })
    }, 15_000)

    // 窗口重新聚焦时检测当前预览文件是否有外部修改，有变化才刷新
    /** sessionId:filePath → 内容 hash（用于检测外部编辑器修改） */
    const fileContentHashMap = new Map<string, string>()
    const HASH_MAX = 100
    let focusCheckSeq = 0
    const onWindowFocus = async () => {
      const activeSessionId = store.get(currentAgentSessionIdAtom)
      if (!activeSessionId) return

      const previewFile = store.get(previewFileMapAtom).get(activeSessionId)
      if (!previewFile || previewFile.previewOnly !== true) {
        bumpDiffRefresh(activeSessionId)
        return
      }

      const candidateBasePaths = uniqueTruthyPaths([
        ...(previewFile.basePaths ?? []),
        previewFile.dirPath,
        previewFile.gitRoot,
        getParentDir(previewFile.filePath),
        store.get(agentSessionPathMapAtom).get(activeSessionId),
      ])
      const hashKey = `${activeSessionId}:${previewFile.filePath}:${candidateBasePaths.join('\u001f')}`
      const seq = ++focusCheckSeq

      try {
        const result = await window.electronAPI.resolveAndReadFile(previewFile.filePath, {
          sessionId: activeSessionId,
          candidateBasePaths: candidateBasePaths.length > 0 ? candidateBasePaths : undefined,
        })

        // 丢弃过期结果（快速切换窗口时）
        if (seq !== focusCheckSeq) return

        const content = result?.content ?? ''
        // cyrb53 hash：遍历完整内容，避免边缘碰撞
        const hash = cyrb53(content)
        const prevHash = fileContentHashMap.get(hashKey)

        if (prevHash === undefined || prevHash !== hash) {
          // 首次建立 hash 基准时也刷新一次，避免用户离开窗口后首次外部修改被吞掉。
          bumpDiffRefresh(activeSessionId)
        }
        fileContentHashMap.set(hashKey, hash)

        // LRU 淘汰：限制 Map 大小
        if (fileContentHashMap.size > HASH_MAX) {
          const oldestKey = fileContentHashMap.keys().next().value
          if (oldestKey !== undefined) fileContentHashMap.delete(oldestKey)
        }
      } catch {
        // 读取失败时删除旧 hash，并触发一次刷新让预览进入真实失败/空状态。
        fileContentHashMap.delete(hashKey)
        bumpDiffRefresh(activeSessionId)
      }
    }
    window.addEventListener('focus', onWindowFocus)

    return () => {
      flushAllLiveMessages()
      for (const frame of liveMessageFlushFrames.values()) {
        window.cancelAnimationFrame(frame)
      }
      liveMessageFlushFrames.clear()
      cleanupEvent()
      cleanupComplete()
      cleanupError()
      cleanupTitleUpdated()
      cleanupCatalogSynced()
      unsubscribeRuntimePlanStore()
      if (runtimePlanSaveTimer) {
        clearTimeout(runtimePlanSaveTimer)
        persistRuntimePlanStore()
      }
      clearInterval(pruneTimer)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [store]) // store 引用稳定，effect 只执行一次
}
