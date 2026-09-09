import * as React from 'react'
import { Check, Circle, CircleAlert, Loader2 } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { AgentRuntimeTodoItem, AgentTurnChangeStats, AgentTurnChangedFile } from '@proma/shared'
import {
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  allPendingPermissionRequestsAtom,
  agentDiffRefreshVersionAtom,
  agentRuntimeExecutionGraphAtomFamily,
  agentRuntimePlanLifecycleAtom,
  mergeAgentRuntimeExecutionGraphAtom,
  agentSessionStreamingStateAtomFamily,
  agentTurnChangeStatsAtom,
} from '@/atoms/agent-atoms'
import { shouldSuppressAgentRunningIndicator } from '@/lib/agent-running-state'
import { cn } from '@/lib/utils'
import { getVisibleRuntimePlanTodos } from '@/lib/runtime-plan-lifecycle'
import {
  getRuntimePlanVisibleWindowStartIndex,
  shouldAutoScrollRuntimePlanWindow,
} from './runtime-plan-visible-window'
import type { RuntimePlanScrollWindowState } from './runtime-plan-visible-window'

interface RuntimeTodoHoverProgressProps {
  sessionId: string
}

/**
 * 悬浮卡片样式对齐 Codex 截图：
 * - 较大圆角 + 轻边框 + 柔和阴影
 * - 计划面板与文件改动面板共用
 */
const FLOATING_PANEL_CARD_CLASS =
  'rounded-[16px] border border-black/[0.06] bg-card text-card-foreground shadow-[0_10px_30px_-12px_rgba(0,0,0,0.18)] dark:border-white/[0.10] dark:shadow-[0_14px_36px_-16px_rgba(0,0,0,0.75)]'

/** 底部计划入口胶囊：高度固定时接近全圆角 */
const FLOATING_ENTRY_PILL_CLASS =
  'rounded-full border border-black/[0.06] bg-card text-card-foreground shadow-sm dark:border-white/[0.10]'

/** 计划面板最多完整展示的条目数；超出后固定高度并支持无滚动条滚动。 */
export const PLAN_PANEL_MAX_VISIBLE_ITEMS = 5

/**
 * 约等于 5 条单行步骤的高度：
 * 每行 leading-5(20px)+py-0.5(4px)≈24px，space-y-0.5 间隔 2px * 4。
 */
export const PLAN_PANEL_SCROLL_MAX_HEIGHT_CLASS = 'max-h-[128px]'

/** 文件改动悬浮面板最多完整展示的条目数。 */
export const FILE_CHANGE_PANEL_MAX_VISIBLE_ITEMS = 5

/** 约等于 5 条单行文件改动高度。 */
export const FILE_CHANGE_PANEL_SCROLL_MAX_HEIGHT_CLASS = 'max-h-[128px]'

/** 悬浮列表展示用文件名：优先 basename，与 Codex 风格一致。 */
export function formatChangedFileDisplayName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1) || path
}

export function sortChangedFiles(files: AgentTurnChangedFile[]): AgentTurnChangedFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path))
}

export function isCompleted(todo: AgentRuntimeTodoItem): boolean {
  return todo.status === 'completed'
}

export function completedTodoCount(todos: AgentRuntimeTodoItem[]): number {
  return todos.filter(isCompleted).length
}

export function inProgressTodoCount(todos: AgentRuntimeTodoItem[]): number {
  return todos.filter((todo) => todo.status === 'in_progress').length
}

/**
 * 当前步 = 已完成 + 执行中（与 Codex 一致）。
 * 只统计已经真正推进过的步骤，不把下一个 pending 提前算成当前步。
 */
export function currentStepNumber(todos: AgentRuntimeTodoItem[], completedCount: number): number {
  if (todos.length === 0) return 0
  if (completedCount >= todos.length) return todos.length

  const advancedCount = completedCount + inProgressTodoCount(todos)
  return Math.min(Math.max(advancedCount, 0), todos.length)
}

export function completionPercentage(todos: AgentRuntimeTodoItem[], completedCount: number): number {
  if (todos.length === 0) return 0
  return Math.round((completedCount / todos.length) * 100)
}

/** 稳定排序：数字 ID 按数值，其它按字符串。 */
export function sortRuntimeTodos(todos: AgentRuntimeTodoItem[]): AgentRuntimeTodoItem[] {
  return [...todos].sort((left, right) => {
    const leftNum = Number(left.id)
    const rightNum = Number(right.id)
    const leftIsNum = Number.isFinite(leftNum) && String(leftNum) === left.id
    const rightIsNum = Number.isFinite(rightNum) && String(rightNum) === right.id
    if (leftIsNum && rightIsNum) return leftNum - rightNum
    if (leftIsNum) return -1
    if (rightIsNum) return 1
    return left.id.localeCompare(right.id)
  })
}

export function formatPlanProgressLabel(
  todos: AgentRuntimeTodoItem[],
  _completedCount: number,
  stepNumber: number,
): string {
  if (todos.length === 0) return ''
  return `第 ${stepNumber} / ${todos.length} 步`
}

/** 是否还有未完成步骤（pending / in_progress / blocked）。全部完成后不再展示旧计划。 */
export function hasActiveRuntimeTodos(todos: AgentRuntimeTodoItem[]): boolean {
  return todos.some((todo) => (
    todo.status === 'pending'
    || todo.status === 'in_progress'
    || todo.status === 'blocked'
  ))
}

/**
 * 计划入口可见性：
 * 1. 有未完成 Todo 才显示（上一轮已全部完成的旧计划，新消息不再挂着）
 * 2. 会话结束后仅保留生命周期明确标记为“待继续”的计划
 * 3. 上下文压缩进行中时也隐藏（底部只展示压缩进度）
 *
 * 任务文件里残留 in_progress 在「执行中」时展示是正常的；
 * 会话已停时只有中断计划可继续展示，且不再转圈。
 */
export function shouldShowRuntimeTodoProgress(
  todos: AgentRuntimeTodoItem[],
  streamState?: {
    running?: boolean
    isCompacting?: boolean
    contextCompaction?: {
      status: 'running' | 'success' | 'noop' | 'failed' | 'stopped'
    }
  },
  hasBlockingRequest: boolean = false,
): boolean {
  if (!hasActiveRuntimeTodos(todos)) return false
  if (streamState?.running !== true) return false
  if (shouldSuppressAgentRunningIndicator(streamState)) return false
  if (hasBlockingRequest) return false
  return true
}

function isUsableExecutionGraph(
  graph: { nodes: unknown[]; todos: unknown[]; updatedAt: number } | null | undefined,
): boolean {
  if (!graph) return false
  return graph.updatedAt > 0 || graph.todos.length > 0 || graph.nodes.length > 0
}

export function shouldShowTurnChangeStats(
  stats: AgentTurnChangeStats | undefined,
  currentRunStartedAt: number | undefined,
): stats is AgentTurnChangeStats {
  if (!stats || stats.filesChanged <= 0) return false
  return currentRunStartedAt == null || stats.startedAt === currentRunStartedAt
}

function TodoStatusIcon({
  todo,
  activelyRunning,
}: {
  todo: AgentRuntimeTodoItem
  activelyRunning: boolean
}): React.ReactElement {
  if (todo.status === 'completed') {
    return (
      <span
        aria-label="已完成"
        data-plan-status-icon="completed"
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
      >
        <Check className="size-2.5" strokeWidth={2.5} />
      </span>
    )
  }
  if (todo.status === 'in_progress') {
    if (!activelyRunning) {
      return (
        <Circle
          aria-label="待继续"
          data-plan-status-icon="interrupted"
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
      )
    }
    return (
      <Loader2
        aria-label="执行中"
        data-plan-status-icon="in_progress"
        className="size-4 shrink-0 animate-spin text-sky-500"
        strokeWidth={2}
      />
    )
  }
  if (todo.status === 'blocked') {
    return (
      <CircleAlert
        aria-label="已阻塞"
        data-plan-status-icon="blocked"
        className="size-4 shrink-0 text-amber-500"
      />
    )
  }
  return (
    <Circle
      aria-label="等待中"
      data-plan-status-icon="pending"
      className="size-4 shrink-0 text-foreground/85"
      strokeWidth={1.75}
    />
  )
}

function PlanCompletionRing({
  percentage,
}: {
  percentage: number
}): React.ReactElement {
  return (
    <svg
      aria-label={`计划完成度 ${percentage}%`}
      data-plan-progress={percentage}
      className="size-3.5 shrink-0 -rotate-90"
      viewBox="0 0 16 16"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2"
        className="stroke-sky-100 dark:stroke-sky-900/70"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        pathLength="100"
        strokeDasharray={`${percentage} 100`}
        strokeLinecap="round"
        strokeWidth="2"
        className="stroke-sky-400 transition-[stroke-dasharray] duration-300"
      />
    </svg>
  )
}

/** 输入框正上方的 CCB Todo 进度；默认收起，鼠标移入显示完整步骤。 */
export function RuntimeTodoHoverProgress({
  sessionId,
}: RuntimeTodoHoverProgressProps): React.ReactElement | null {
  const graph = useAtomValue(agentRuntimeExecutionGraphAtomFamily(sessionId))
  const mergeGraph = useSetAtom(mergeAgentRuntimeExecutionGraphAtom)
  const planLifecycle = useAtomValue(agentRuntimePlanLifecycleAtom).get(sessionId)
  const sourceTodos = getVisibleRuntimePlanTodos(
    planLifecycle,
    graph?.todos ?? [],
  )
  const todos = React.useMemo(
    () => sortRuntimeTodos(sourceTodos),
    [sourceTodos],
  )
  const planPanelScrollRef = React.useRef<HTMLDivElement>(null)
  const planWindowStartIndex = getRuntimePlanVisibleWindowStartIndex(
    todos,
    PLAN_PANEL_MAX_VISIBLE_ITEMS,
  )
  const planPanelWindowed = todos.length > PLAN_PANEL_MAX_VISIBLE_ITEMS
  const previousPlanScrollWindowRef = React.useRef<RuntimePlanScrollWindowState | null>(null)
  const streamingState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const pendingPermissionRequests = useAtomValue(allPendingPermissionRequestsAtom)
  const pendingAskUserRequests = useAtomValue(allPendingAskUserRequestsAtom)
  const pendingExitPlanRequests = useAtomValue(allPendingExitPlanRequestsAtom)
  const hasBlockingRequest = (
    (pendingPermissionRequests.get(sessionId)?.length ?? 0) > 0
    || (pendingAskUserRequests.get(sessionId)?.length ?? 0) > 0
    || (pendingExitPlanRequests.get(sessionId)?.length ?? 0) > 0
  )
  const currentRunStartedAt = streamingState?.startedAt
  const isStreaming = streamingState?.running === true
  const planActivelyRunning = (
    isStreaming
    && (planLifecycle == null || planLifecycle.current?.status === 'active')
  )
  const diffRefreshVersions = useAtomValue(agentDiffRefreshVersionAtom)
  const diffRefreshVersion = diffRefreshVersions.get(sessionId) ?? 0
  const changeStatsMap = useAtomValue(agentTurnChangeStatsAtom)
  const setChangeStatsMap = useSetAtom(agentTurnChangeStatsAtom)
  const changeStats = changeStatsMap.get(sessionId)
  const requestSequenceRef = React.useRef(0)

  // 会话打开或流式结束后主动拉一次执行图，避免只依赖实时事件导致进度停在旧快照。
  React.useEffect(() => {
    let cancelled = false
    const baseRuntimeSessionId = graph?.runtimeSessionId ?? null

    void (async () => {
      try {
        const next = await window.electronAPI.getAgentRuntimeExecutionGraph(sessionId)
        if (cancelled || !isUsableExecutionGraph(next)) return
        mergeGraph({
          sessionId,
          graph: next,
          baseRuntimeSessionId,
        })
      } catch {
        // Session 未打开时保留事件推送的最后快照。
      }
    })()

    return () => {
      cancelled = true
    }
  }, [graph?.runtimeSessionId, isStreaming, mergeGraph, sessionId])

  const refreshChangeStats = React.useCallback(async (): Promise<void> => {
    const requestSequence = ++requestSequenceRef.current
    try {
      const result = await window.electronAPI.getAgentTurnChangeStats(sessionId)
      if (requestSequence !== requestSequenceRef.current) return
      // 新一轮刚启动而 Main 仍在创建基线时，旧一轮结果不允许覆盖当前显示。
      if (
        result
        && currentRunStartedAt != null
        && result.startedAt !== currentRunStartedAt
      ) {
        return
      }

      setChangeStatsMap((previous) => {
        const next = new Map(previous)
        if (result) next.set(sessionId, result)
        else next.delete(sessionId)
        return next
      })
    } catch {
      // 统计是辅助信息，Git 不可用或会话正在切换时静默降级。
    }
  }, [currentRunStartedAt, sessionId, setChangeStatsMap])

  React.useEffect(() => {
    if (currentRunStartedAt == null) return
    setChangeStatsMap((previous) => {
      const existing = previous.get(sessionId)
      if (!existing || existing.startedAt === currentRunStartedAt) return previous
      const next = new Map(previous)
      next.delete(sessionId)
      return next
    })
  }, [currentRunStartedAt, sessionId, setChangeStatsMap])

  React.useEffect(() => {
    if (todos.length === 0) return

    void refreshChangeStats()
    // Agent IPC 先进入 Main，再创建 Git 基线；启动后补一次轻量重试消除这段竞态。
    const retryTimer = currentRunStartedAt != null
      ? window.setTimeout(() => void refreshChangeStats(), 750)
      : null

    return () => {
      requestSequenceRef.current += 1
      if (retryTimer != null) window.clearTimeout(retryTimer)
    }
  }, [
    currentRunStartedAt,
    refreshChangeStats,
    todos.length,
  ])

  const previousDiffRefreshVersionRef = React.useRef(diffRefreshVersion)
  React.useEffect(() => {
    if (previousDiffRefreshVersionRef.current === diffRefreshVersion) return
    previousDiffRefreshVersionRef.current = diffRefreshVersion
    if (todos.length === 0) return
    void refreshChangeStats()
  }, [diffRefreshVersion, refreshChangeStats, todos.length])

  const showRuntimeTodoProgress = shouldShowRuntimeTodoProgress(
    todos,
    streamingState,
    hasBlockingRequest,
  )

  React.useEffect(() => {
    const nextWindowState: RuntimePlanScrollWindowState = {
      visible: showRuntimeTodoProgress,
      windowed: planPanelWindowed,
      startIndex: planWindowStartIndex,
    }
    const shouldAutoScroll = shouldAutoScrollRuntimePlanWindow(
      previousPlanScrollWindowRef.current,
      nextWindowState,
    )
    previousPlanScrollWindowRef.current = nextWindowState
    if (!shouldAutoScroll) return

    const container = planPanelScrollRef.current
    if (!container) return

    const firstVisibleItem = container.children.item(planWindowStartIndex)
    if (!(firstVisibleItem instanceof HTMLElement)) return

    const containerTop = container.getBoundingClientRect().top
    const itemTop = firstVisibleItem.getBoundingClientRect().top
    container.scrollTop += itemTop - containerTop
  }, [
    planPanelWindowed,
    planWindowStartIndex,
    showRuntimeTodoProgress,
  ])

  if (!showRuntimeTodoProgress) return null

  const completedCount = completedTodoCount(todos)
  const stepNumber = currentStepNumber(todos, completedCount)
  const progressPercentage = completionPercentage(todos, completedCount)
  const progressLabel = formatPlanProgressLabel(todos, completedCount, stepNumber)
  const visibleChangeStats = shouldShowTurnChangeStats(
    changeStats,
    currentRunStartedAt,
  )

  return (
    <div className="relative z-30 w-fit">
      <div
        className={cn(
          FLOATING_ENTRY_PILL_CLASS,
          'inline-flex h-9 cursor-default items-center gap-2 px-3.5 text-[13px] text-muted-foreground',
        )}
      >
        {/* 步骤区悬停展示计划面板，与文件改动区分离，避免两个面板同时弹出 */}
        <span className="group/plan relative inline-flex items-center gap-2">
          <div
            className={cn(
              'pointer-events-none invisible absolute bottom-full left-1/2 w-max max-w-[min(420px,calc(100vw-3rem))]',
              '-translate-x-1/2 translate-y-1 pb-2 opacity-0 transition-[opacity,transform,visibility] duration-150',
              'group-hover/plan:pointer-events-auto group-hover/plan:visible group-hover/plan:translate-y-0 group-hover/plan:opacity-100',
            )}
            data-plan-panel
          >
            <div className={cn(FLOATING_PANEL_CARD_CLASS, 'min-w-[220px] p-2.5')}>
              <div
                ref={planPanelScrollRef}
                className={cn(
                  'space-y-0.5',
                  // 超过可见数量后保留完整列表与滚动能力，并自动跟随当前执行窗口。
                  planPanelWindowed && cn(
                    PLAN_PANEL_SCROLL_MAX_HEIGHT_CLASS,
                    'overflow-y-auto overscroll-contain scrollbar-none',
                  ),
                )}
                data-plan-panel-scroll={planPanelWindowed ? 'true' : 'false'}
              >
                {todos.map((todo) => (
                  <div
                    key={todo.id}
                    className="flex max-w-full items-start gap-2 px-1.5 py-0.5 text-[13px] leading-5"
                  >
                    <span className="mt-0.5">
                      <TodoStatusIcon
                        todo={todo}
                        activelyRunning={planActivelyRunning}
                      />
                    </span>
                    <div className="min-w-0">
                      <p className={cn(
                        'break-words',
                        isCompleted(todo) && 'text-muted-foreground line-through decoration-muted-foreground/45',
                      )}>
                        {todo.content}
                      </p>
                      {todo.status === 'in_progress' && (
                        <p className={cn(
                          'mt-0.5 text-[10px]',
                          planActivelyRunning
                            ? 'text-sky-600 dark:text-sky-400'
                            : 'text-muted-foreground',
                        )}>
                          {planActivelyRunning ? '执行中' : '待继续'}
                          {todo.activeForm ? ` · ${todo.activeForm}` : ''}
                        </p>
                      )}
                      {(todo.owner || (todo.blockedBy?.length ?? 0) > 0) && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {todo.owner ? `负责人：${todo.owner}` : ''}
                          {todo.owner && (todo.blockedBy?.length ?? 0) > 0 ? ' · ' : ''}
                          {(todo.blockedBy?.length ?? 0) > 0
                            ? `等待：${todo.blockedBy?.join('、')}`
                            : ''}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <PlanCompletionRing percentage={progressPercentage} />
          <span className="tabular-nums">{progressLabel}</span>
        </span>
        {visibleChangeStats && (
          <span className="group/files relative inline-flex items-center gap-2">
            <span className="text-muted-foreground/45">·</span>
            {/* 文件改动明细：悬停统计区展示，超过 5 条固定高度无滚动条滚动 */}
            <div
              className={cn(
                'pointer-events-none invisible absolute bottom-full left-1/2 w-max max-w-[min(360px,calc(100vw-3rem))]',
                '-translate-x-1/2 translate-y-1 pb-2 opacity-0 transition-[opacity,transform,visibility] duration-150',
                'group-hover/files:pointer-events-auto group-hover/files:visible group-hover/files:translate-y-0 group-hover/files:opacity-100',
              )}
              data-file-change-panel
            >
              <div className={cn(FLOATING_PANEL_CARD_CLASS, 'min-w-[220px] p-2.5')}>
                <div
                  className={cn(
                    'space-y-0.5',
                    (changeStats.files?.length ?? 0) > FILE_CHANGE_PANEL_MAX_VISIBLE_ITEMS && cn(
                      FILE_CHANGE_PANEL_SCROLL_MAX_HEIGHT_CLASS,
                      'overflow-y-auto overscroll-contain scrollbar-none',
                    ),
                  )}
                  data-file-change-panel-scroll={
                    (changeStats.files?.length ?? 0) > FILE_CHANGE_PANEL_MAX_VISIBLE_ITEMS
                      ? 'true'
                      : 'false'
                  }
                >
                  {sortChangedFiles(changeStats.files ?? []).map((file) => (
                    <div
                      key={file.path}
                      className="flex max-w-full items-center gap-4 px-2 py-1 text-[13px] leading-5"
                      title={file.path}
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground/90">
                        {formatChangedFileDisplayName(file.path)}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
                        {file.additions > 0 && (
                          <span className="text-emerald-500">+{file.additions}</span>
                        )}
                        {file.deletions > 0 && (
                          <span className="text-red-500">-{file.deletions}</span>
                        )}
                        {file.additions <= 0 && file.deletions <= 0 && (
                          <span className="text-muted-foreground/70">·</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <span className="tabular-nums">{changeStats.filesChanged} 个文件已更改</span>
            {changeStats.additions > 0 && (
              <span className="tabular-nums text-emerald-500">
                +{changeStats.additions}
              </span>
            )}
            {changeStats.deletions > 0 && (
              <span className="tabular-nums text-red-500">
                -{changeStats.deletions}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
