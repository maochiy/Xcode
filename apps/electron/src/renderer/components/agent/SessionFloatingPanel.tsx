import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useAgentRuntimeExecutionGraphRefresh } from '@/hooks/useAgentRuntimeExecutionGraphRefresh'
import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  GitBranch,
  Globe,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  agentChannelIdAtom,
  agentDiffRefreshVersionAtom,
  agentFloatingPanelExecutionNodeStatesAtom,
  agentFloatingSubagentsExpandedAtom,
  agentModelIdAtom,
  agentRuntimeExecutionGraphAtomFamily,
  agentSessionsAtom,
  agentSessionGitSummaryAtom,
  agentSessionStreamingStateAtomFamily,
  agentStreamingStatesAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  createAgentExecutionNodeTab,
  createBrowserTaskTab,
  openAgentSidePanelTabAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  workspaceFilesVersionAtom,
} from '@/atoms/agent-atoms'
import { useBrowserAgentTasks } from '@/hooks/useBrowserAgentTasks'
import { cn } from '@/lib/utils'
import {
  buildSessionExecutionNodes,
  isSubagentExecutionNode,
  isSessionExecutionNodeActivelyRunning,
} from '@/lib/session-execution-nodes'
import { isFloatingExecutionNodeTerminal } from '@/lib/session-floating-runtime-lifecycle'
import { RuntimeExecutionNodeList } from './RuntimeExecutionNodeList'
import { canStopSubagentNode } from '@/lib/subagent-presentation'
import { SessionGitBranchMenu } from './SessionGitBranchMenu'
import { GitCommitPushDialog } from './GitCommitPushDialog'

interface SessionFloatingPanelProps {
  sessionId: string
  sessionPath: string | null
}

const EMPTY_PATHS: string[] = []
export const FLOATING_PLAN_MAX_VISIBLE_ITEMS = 5
export const FLOATING_SUBAGENT_MAX_VISIBLE_ITEMS = 4

export interface FloatingRuntimeListAllocation {
  visiblePlanItems: number
  visibleSubagentItems: number
}

/**
 * 计划与子智能体分别使用自己的可见上限，面板高度由实际渲染数量决定。
 * 不再用共享行预算压缩其中一类，否则少量子智能体可能被计划区域裁掉。
 */
export function allocateFloatingRuntimeListRows(
  planCount: number,
  subagentCount: number,
): FloatingRuntimeListAllocation {
  return {
    visiblePlanItems: Math.min(planCount, FLOATING_PLAN_MAX_VISIBLE_ITEMS),
    visibleSubagentItems: Math.min(
      subagentCount,
      FLOATING_SUBAGENT_MAX_VISIBLE_ITEMS,
    ),
  }
}

export function SessionFloatingPanel({
  sessionId,
  sessionPath,
}: SessionFloatingPanelProps): React.ReactElement {
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  const subagentsExpandedMap = useAtomValue(agentFloatingSubagentsExpandedAtom)
  const setSubagentsExpandedMap = useSetAtom(agentFloatingSubagentsExpandedAtom)
  const graph = useAtomValue(agentRuntimeExecutionGraphAtomFamily(sessionId))
  const sessions = useAtomValue(agentSessionsAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  // 活跃节点只信任实时执行图 + Collaboration 投影。
  // 历史上仍 running、却已从 Runtime tasks 消失的节点，会由 merge 收敛为 stopped；
  // 不再把历史孤儿节点标成 liveRuntimeNode，避免永久“执行中”且点开无 Transcript。
  const allNodes = React.useMemo(
    () => buildSessionExecutionNodes({
      sessionId,
      runtimeGraph: graph,
      sessions,
    }).filter(isSubagentExecutionNode),
    [graph, sessionId, sessions],
  )
  const streamState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const running = streamState?.running === true
  const executionNodeStates = useAtomValue(agentFloatingPanelExecutionNodeStatesAtom)
    .get(sessionId)
  const now = Date.now()
  const nodes = React.useMemo(() => {
    const visible = new Map<string, (typeof allNodes)[number]>()
    for (const node of allNodes) {
      if (
        !isFloatingExecutionNodeTerminal(node)
        && (node.status === 'queued' || node.status === 'running')
      ) {
        visible.set(node.id, node)
      }
    }
    for (const lifecycle of executionNodeStates?.values() ?? []) {
      if (
        lifecycle.expiresAt > now
        && isSubagentExecutionNode(lifecycle.node)
        && (
          !visible.has(lifecycle.node.id)
          || isFloatingExecutionNodeTerminal(lifecycle.node)
        )
      ) {
        visible.set(lifecycle.node.id, lifecycle.node)
      }
    }
    return Array.from(visible.values())
  }, [allNodes, executionNodeStates, now])
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug = workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.slug
  const attachedDirsMap = useAtomValue(agentAttachedDirectoriesMapAtom)
  const attachedFilesMap = useAtomValue(agentAttachedFilesMapAtom)
  const workspaceAttachedDirsMap = useAtomValue(workspaceAttachedDirectoriesMapAtom)
  const workspaceAttachedFilesMap = useAtomValue(workspaceAttachedFilesMapAtom)
  const attachedDirs = attachedDirsMap.get(sessionId) ?? EMPTY_PATHS
  const attachedFiles = attachedFilesMap.get(sessionId) ?? EMPTY_PATHS
  const workspaceAttachedDirs = workspaceAttachedDirsMap.get(currentWorkspaceId ?? '') ?? EMPTY_PATHS
  const workspaceAttachedFiles = workspaceAttachedFilesMap.get(currentWorkspaceId ?? '') ?? EMPTY_PATHS
  const diffRefreshVersion = useAtomValue(agentDiffRefreshVersionAtom).get(sessionId) ?? 0
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const gitSummaryMap = useAtomValue(agentSessionGitSummaryAtom)
  const setGitSummaryMap = useSetAtom(agentSessionGitSummaryAtom)
  const setDiffRefreshVersion = useSetAtom(agentDiffRefreshVersionAtom)
  const gitSummary = gitSummaryMap.get(sessionId)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const [commitDialogOpen, setCommitDialogOpen] = React.useState(false)
  const browserAgentTasks = useBrowserAgentTasks(sessionId)
  const [browserExpanded, setBrowserExpanded] = React.useState(true)

  const sessionMeta = React.useMemo(
    () => sessions.find((session) => session.id === sessionId) ?? null,
    [sessionId, sessions],
  )
  const channelId = sessionMeta?.channelId || agentChannelId
  const modelId = sessionMeta?.modelId || agentModelId

  const refreshGitSummary = React.useCallback(() => {
    setDiffRefreshVersion((previous) => {
      const next = new Map(previous)
      next.set(sessionId, (previous.get(sessionId) ?? 0) + 1)
      return next
    })
  }, [sessionId, setDiffRefreshVersion])

  const handleBranchChanged = React.useCallback((branch: string) => {
    setGitSummaryMap((previous) => {
      const current = previous.get(sessionId)
      if (!current) return previous
      const next = new Map(previous)
      next.set(sessionId, {
        ...current,
        repoStatus: current.repoStatus
          ? { ...current.repoStatus, branch }
          : {
              isRepo: true,
              branch,
              hasChanges: current.filesChanged > 0,
              remoteUrl: null,
            },
        updatedAt: Date.now(),
      })
      return next
    })
    refreshGitSummary()
  }, [refreshGitSummary, sessionId, setGitSummaryMap])

  const activeRuntimeNodeExists = React.useMemo(() => (
    (graph?.nodes ?? []).some((node) => (
      node.status === 'queued' || node.status === 'running'
    ))
  ), [graph?.nodes])

  // 有活跃节点时才轮询；页面隐藏自动暂停。merge 短路保证内容不变不重渲染。
  useAgentRuntimeExecutionGraphRefresh(sessionId, {
    enabled: activeRuntimeNodeExists,
    baseRuntimeSessionId: graph?.runtimeSessionId ?? null,
  })

  React.useEffect(() => {
    let cancelled = false
    let refreshSequence = 0
    if (!sessionPath) {
      setGitSummaryMap((previous) => {
        if (!previous.has(sessionId)) return previous
        const next = new Map(previous)
        next.delete(sessionId)
        return next
      })
      return
    }

    const refresh = async (): Promise<void> => {
      const sequence = ++refreshSequence
      try {
        const workspaceFilesPath = workspaceSlug
          ? await window.electronAPI.getWorkspaceFilesPath(workspaceSlug)
          : null
        const extraPaths = [
          ...attachedDirs,
          ...workspaceAttachedDirs,
          ...attachedFiles,
          ...workspaceAttachedFiles,
        ]
        const [nextRepoStatus, changes] = await Promise.all([
          window.electronAPI.getGitRepoStatus(sessionPath),
          window.electronAPI.getUnstagedChanges(
            sessionPath,
            sessionPath,
            workspaceFilesPath ?? undefined,
            extraPaths,
            sessionId,
          ),
        ])
        if (cancelled || sequence !== refreshSequence) return
        setGitSummaryMap((previous) => {
          const next = new Map(previous)
          next.set(sessionId, {
            repoStatus: nextRepoStatus,
            filesChanged: changes.files.length + changes.untrackedFiles.length,
            additions: changes.files.reduce((sum, file) => sum + file.additions, 0),
            deletions: changes.files.reduce((sum, file) => sum + file.deletions, 0),
            updatedAt: Date.now(),
          })
          return next
        })
      } catch {
        if (cancelled || sequence !== refreshSequence) return
        setGitSummaryMap((previous) => {
          const next = new Map(previous)
          next.set(sessionId, {
            repoStatus: null,
            filesChanged: 0,
            additions: 0,
            deletions: 0,
            updatedAt: Date.now(),
          })
          return next
        })
      }
    }

    void refresh()
    const handleWindowFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', handleWindowFocus)

    return () => {
      cancelled = true
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [
    attachedDirs,
    attachedFiles,
    diffRefreshVersion,
    filesVersion,
    sessionId,
    sessionPath,
    setGitSummaryMap,
    workspaceAttachedDirs,
    workspaceAttachedFiles,
    workspaceSlug,
  ])

  const allocation = allocateFloatingRuntimeListRows(0, nodes.length)
  const visibleNodes = nodes.slice(0, allocation.visibleSubagentItems)
  const hasMoreNodes = visibleNodes.length < nodes.length
  const subagentsExpanded = subagentsExpandedMap.get(sessionId) ?? true
  const activeNodes = nodes.filter((node) => (
    node.status === 'queued' || node.status === 'running'
  ))
  const canStopAll = activeNodes.length > 0 && activeNodes.every(canStopSubagentNode)

  const openChanges = React.useCallback(() => {
    openSidePanelTab({ sessionId, tab: 'changes' })
  }, [openSidePanelTab, sessionId])

  const openAllSubagents = React.useCallback(() => {
    openSidePanelTab({ sessionId, tab: 'execution' })
  }, [openSidePanelTab, sessionId])

  const openExecutionNode = React.useCallback((node: (typeof nodes)[number]) => {
    const runtimeIdentity = node.source === 'delegation'
      ? node.transcriptSessionId
      : graph?.runtimeSessionId
    const tab = createAgentExecutionNodeTab(node.id, runtimeIdentity)
    openSidePanelTab({
      sessionId,
      tab,
      executionNodeSnapshot: {
        node,
        runtimeSessionId: runtimeIdentity,
      },
    })
  }, [graph?.runtimeSessionId, nodes, openSidePanelTab, sessionId])

  const openBrowserTask = React.useCallback((taskId: string) => {
    openSidePanelTab({ sessionId, tab: createBrowserTaskTab(taskId) })
  }, [openSidePanelTab, sessionId])

  const visibleBrowserTasks = React.useMemo(
    () => browserAgentTasks
      .filter((task) => task.status === 'running' || task.status === 'waiting_user')
      .slice(0, 4),
    [browserAgentTasks],
  )
  const visibleBrowserTaskCount = visibleBrowserTasks.length

  const toggleSubagents = React.useCallback(() => {
    setSubagentsExpandedMap((previous) => {
      const next = new Map(previous)
      next.set(sessionId, !(previous.get(sessionId) ?? true))
      return next
    })
  }, [sessionId, setSubagentsExpandedMap])

  const stopAllSubagents = React.useCallback(async (): Promise<void> => {
    const results = await Promise.allSettled(
      activeNodes.flatMap((node) =>
        node.transcriptSessionId
          ? [window.electronAPI.stopAgent(node.transcriptSessionId)]
          : [],
      ),
    )
    const failedCount = results.filter((result) => result.status === 'rejected').length
    if (failedCount > 0) {
      toast.error(`${failedCount} 个子智能体停止失败，请重试`)
    }
  }, [activeNodes])

  return (
    <aside
      aria-label="会话环境信息"
      className={cn(
        'absolute right-4 top-[56px] z-40 flex w-[300px] max-h-[calc(100%-72px)] flex-col overflow-hidden p-3',
        '!rounded-[24px] border border-black/[0.07] bg-card text-card-foreground shadow-lg',
        'dark:border-white/[0.10] dark:shadow-[0_12px_36px_-18px_rgba(0,0,0,0.85)]',
      )}
    >
      <div className="shrink-0">
        <h2 className="px-1 pb-2 text-[11px] font-medium text-muted-foreground">环境信息</h2>

        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/55"
          onClick={openChanges}
        >
          <FileDiff className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-xs">变更</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {(gitSummary?.filesChanged ?? 0) > 0 ? `${gitSummary?.filesChanged} 个文件` : '无变更'}
          </span>
          {(gitSummary?.additions ?? 0) > 0 && (
            <span className="text-[11px] tabular-nums text-emerald-500">+{gitSummary?.additions}</span>
          )}
          {(gitSummary?.deletions ?? 0) > 0 && (
            <span className="text-[11px] tabular-nums text-red-500">-{gitSummary?.deletions}</span>
          )}
        </button>

        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-xs">分支</span>
          {gitSummary?.repoStatus?.isRepo && sessionPath ? (
            <SessionGitBranchMenu
              dirPath={sessionPath}
              sessionId={sessionId}
              currentBranch={gitSummary.repoStatus.branch}
              onBranchChanged={handleBranchChanged}
              triggerClassName="-mr-1"
            />
          ) : (
            <span className="max-w-[160px] truncate text-[11px] text-muted-foreground">
              {gitSummary?.repoStatus?.isRepo
                ? (gitSummary.repoStatus.branch ?? 'HEAD')
                : '非 Git 仓库'}
            </span>
          )}
        </div>

        {gitSummary?.repoStatus?.isRepo && sessionPath && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/55"
            onClick={() => setCommitDialogOpen(true)}
          >
            <Upload className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs">提交或推送</span>
            {(gitSummary.filesChanged > 0 || gitSummary.additions > 0 || gitSummary.deletions > 0) && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {(gitSummary.additions > 0 || gitSummary.deletions > 0) ? (
                  <>
                    {gitSummary.additions > 0 && (
                      <span className="text-emerald-500">+{gitSummary.additions.toLocaleString()}</span>
                    )}
                    {gitSummary.additions > 0 && gitSummary.deletions > 0 && ' '}
                    {gitSummary.deletions > 0 && (
                      <span className="text-red-500">-{gitSummary.deletions.toLocaleString()}</span>
                    )}
                  </>
                ) : (
                  `${gitSummary.filesChanged} 个文件`
                )}
              </span>
            )}
          </button>
        )}

      </div>

      {gitSummary?.repoStatus?.isRepo && sessionPath && (
        <GitCommitPushDialog
          open={commitDialogOpen}
          onOpenChange={setCommitDialogOpen}
          dirPath={sessionPath}
          sessionId={sessionId}
          currentBranch={gitSummary.repoStatus.branch}
          additions={gitSummary.additions}
          deletions={gitSummary.deletions}
          filesChanged={gitSummary.filesChanged}
          channelId={channelId}
          modelId={modelId}
          onCompleted={refreshGitSummary}
          onBranchChanged={handleBranchChanged}
        />
      )}

      {nodes.length > 0 && (
        <div
          className="min-h-0 overflow-y-auto overscroll-contain scrollbar-none"
          data-session-floating-runtime-region
        >
          {nodes.length > 0 && (
            <section className="mt-2 border-t border-border/55 pt-2">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent/55"
                onClick={toggleSubagents}
                aria-expanded={subagentsExpanded}
              >
                {subagentsExpanded
                  ? <ChevronDown className="size-3.5 text-muted-foreground" />
                  : <ChevronRight className="size-3.5 text-muted-foreground" />}
                <h3 className="flex-1 text-[11px] font-medium text-muted-foreground">
                  {nodes.length} 个后台智能体
                </h3>
              </button>
              {subagentsExpanded && (
                <>
                  <RuntimeExecutionNodeList
                    nodes={visibleNodes}
                    isNodeRunning={(node) => (
                      isSessionExecutionNodeActivelyRunning(
                        node,
                        running,
                        node.transcriptSessionId
                          ? streamingStates.get(node.transcriptSessionId)?.running
                          : undefined,
                      )
                    )}
                    onOpenNode={openExecutionNode}
                  />
                  {hasMoreNodes && (
                    <button
                      type="button"
                      className="flex w-full items-center justify-center rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/55 hover:text-foreground"
                      onClick={openAllSubagents}
                      data-session-subagent-view-all
                    >
                      查看全部
                    </button>
                  )}
                  {canStopAll && (
                    <button
                      type="button"
                      className="mt-1 flex w-full items-center justify-center rounded-lg px-2 py-1.5 text-[11px] text-destructive hover:bg-destructive/10"
                      onClick={() => void stopAllSubagents()}
                      title="停止此聊天中的所有子智能体"
                    >
                      全部停止
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
      {visibleBrowserTaskCount > 0 && (
        <section
          className="mt-2 border-t border-border/55 pt-2"
          data-session-floating-browser-region
        >
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent/55"
            onClick={() => setBrowserExpanded((value) => !value)}
            aria-expanded={browserExpanded}
          >
            {browserExpanded
              ? <ChevronDown className="size-3.5 text-muted-foreground" />
              : <ChevronRight className="size-3.5 text-muted-foreground" />}
            <h3 className="flex-1 text-[11px] font-medium text-muted-foreground">
              {visibleBrowserTaskCount} 个浏览器任务
            </h3>
            <Globe className="size-3.5 text-muted-foreground" />
          </button>
          {browserExpanded && (
            <div className="mt-1 space-y-1">
              {visibleBrowserTasks.map((task) => (
                <button
                  key={task.taskId}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/55"
                  onClick={() => openBrowserTask(task.taskId)}
                  title="点击在右侧打开该浏览器页面"
                  data-browser-task-entry={task.taskId}
                >
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className={cn(
                    'min-w-0 flex-1 truncate text-xs',
                    task.status === 'running'
                      ? 'agent-status-shimmer'
                      : 'text-foreground',
                  )}>
                    {task.title}
                  </span>
                  {task.status === 'waiting_user' && (
                    <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                      等待操作
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </aside>
  )
}
