/**
 * SidePanel — Agent 侧面板容器
 *
 * 直接展示文件浏览器，默认打开状态。
 * 切换按钮在面板关闭时显示活动指示点。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { X, FolderOpen, ExternalLink, ChevronRight, MoreHorizontal, FolderSearch, Pencil, FolderInput, Info, FolderHeart, MessageSquarePlus, FileDiff, Terminal, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { FileBrowser, FileTypeIcon, FileSearchBar, computeRevealAncestors, isPathUnderRoot, computeTreeRowLayout, AncestorGuides, STICKY_ROW_BASE_CLASS, canBeSticky } from '@/components/file-browser'
import { DiffPanelTabBar } from '@/components/diff/DiffPanelTabBar'
import { DiffChangesList } from '@/components/diff/DiffChangesList'
import { ChatView } from '@/components/chat/ChatView'
import { RuntimeExecutionPanel } from './RuntimeExecutionPanel'
import { RuntimePlanPanel } from './RuntimePlanPanel'
import { FilePanelAddButton } from './FilePanelAddButton'
import { FilePanelDropTarget } from './FilePanelDropTarget'
import { referenceFilePaths } from './file-panel-actions'
import type { FilePanelReferenceResult, FilePanelUploadEntry } from './file-panel-actions'
import {
  agentSidePanelOpenAtom,
  agentSidePanelTabsAtom,
  workspaceFilesVersionAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  agentAttachedDirectoriesMapAtom,
  agentAttachedFilesMapAtom,
  workspaceAttachedDirectoriesMapAtom,
  workspaceAttachedFilesMapAtom,
  agentPendingFilesAtomFamily,
  agentDiffRefreshVersionAtom,
  fileBrowserAutoRevealAtom,
  agentSelectedWorktreeAtom,
  agentRuntimeExecutionGraphAtomFamily,
  agentRuntimePlanLifecycleAtom,
  agentExecutionNodeTabSnapshotsAtom,
  agentTerminalTabSnapshotsAtom,
  agentSidePanelRuntimeHistoryAtom,
  agentSessionsAtom,
  createAgentTerminalTab,
  agentStreamingStatesAtom,
  createAgentExecutionNodeTab,
  createBrowserInstanceTab,
  getAgentExecutionNodeId,
  getBrowserTaskId,
  getBrowserInstanceId,
  getAgentTerminalSessionId,
  isAgentExecutionNodeTab,
  isBrowserTaskTab,
  isBrowserInstanceTab,
  isAgentTerminalTab,
  openAgentSidePanelTabAtom,
  agentBrowserInstanceCounterAtom,
} from '@/atoms/agent-atoms'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { BrowserPanel } from './BrowserPanel'
import { useBrowserAgentTasks } from '@/hooks/useBrowserAgentTasks'
import { browserAgentTasksAtom } from '@/atoms/browser-atoms'
import { agentSideChatMapAtom } from '@/atoms/chat-atoms'
import { interfaceVariantAtom } from '@/atoms/theme'
import { previewFileMapAtom } from '@/atoms/preview-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { detectIsWindows } from '@/lib/platform'
import { getAvailableAgentSidePanelTabs } from '@/lib/agent-side-panel-tabs'
import { getVisibleRuntimePlanTodos } from '@/lib/runtime-plan-lifecycle'
import {
  buildSessionExecutionNodes,
  isSubagentExecutionNode,
  isSessionExecutionNodeDetailRunning,
} from '@/lib/session-execution-nodes'
import type {
  AgentPendingFile,
  AgentRuntimeExecutionNode,
  FileEntry,
} from '@proma/shared'
import { RuntimeExecutionNodePanel } from './RuntimeExecutionNodePanel'
import { IntegratedTerminalPanel } from './IntegratedTerminalPanel'
import type { AgentSidePanelAddTab } from '@/lib/agent-side-panel-tabs'

function getPathBasename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

function getMediaTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
  if (!imageExts.has(ext)) return 'application/octet-stream'
  const mimeExt = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
  return `image/${mimeExt}`
}

interface SidePanelProps {
  sessionId: string
  sessionPath: string | null
  activeTab: AgentSidePanelTab
  onTabChange: (tab: AgentSidePanelTab) => void
  openTabs: AgentSidePanelTab[]
  launcherVisible: boolean
  onOpenTab: (tab: AgentSidePanelAddTab) => void
  onCreateTerminal: () => void
  onCloseTab: (tab: AgentSidePanelTab) => void
  onReorderTabs: (source: AgentSidePanelTab, target: AgentSidePanelTab) => void
  width?: number
}

const filePanelActionButtonClass = 'h-6 w-6 flex-shrink-0 rounded-md text-muted-foreground/75 hover:bg-accent/70 hover:text-foreground [&_svg]:size-3.5'

export function SidePanel({
  sessionId,
  sessionPath,
  activeTab,
  onTabChange,
  openTabs,
  launcherVisible,
  onOpenTab,
  onCreateTerminal,
  onCloseTab,
  onReorderTabs,
  width = 280,
}: SidePanelProps): React.ReactElement {
  // per-session 侧面板状态（默认打开）
  const isOpen = useAtomValue(agentSidePanelOpenAtom)
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  const setBrowserInstanceCounter = useSetAtom(agentBrowserInstanceCounterAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const browserAgentTasks = useBrowserAgentTasks(sessionId)
  const allBrowserAgentTasks = useAtomValue(browserAgentTasksAtom)

  // Tab 系统
  const previewFileMap = useAtomValue(previewFileMapAtom)
  const selectedFilePath = previewFileMap.get(sessionId)?.filePath

  const openPreview = useOpenPreview()

  // 用 ref 存 basePaths 相关值，避免声明顺序问题
  const basePathsRef = React.useRef<string[]>([])

  const handleFilePreview = React.useCallback((filePath: string) => {
    const bp = basePathsRef.current
    openPreview(sessionId, {
      filePath,
      previewOnly: true,
      basePaths: bp.length > 0 ? bp : undefined,
    })
  }, [sessionId, openPreview])

  // Worktree 选择状态（仅用于 diff 文件点击时传递 baseRef，选取逻辑已下沉至 DiffChangesList）
  const selectedWorktreeMap = useAtomValue(agentSelectedWorktreeAtom)
  const selectedWorktreePath = selectedWorktreeMap.get(sessionId) ?? null

  const handleDiffFileClick = React.useCallback((filePath: string, _isUntracked: boolean, gitRoot?: string) => {
    openPreview(sessionId, {
      filePath,
      dirPath: sessionPath || undefined,
      gitRoot,
      baseRef: selectedWorktreePath ? 'origin/main' : undefined,
    })
  }, [openPreview, sessionId, sessionPath, selectedWorktreePath])

  // 动画标志：isOpen 变化时启用过渡动画，切换会话时即时显示
  const prevIsOpenRef = React.useRef(isOpen)
  const prevSessionIdRef = React.useRef(sessionId)
  const shouldAnimate = prevSessionIdRef.current === sessionId && prevIsOpenRef.current !== isOpen
  React.useEffect(() => {
    prevIsOpenRef.current = isOpen
    prevSessionIdRef.current = sessionId
  })

  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const setFilesVersion = useSetAtom(workspaceFilesVersionAtom)
  const diffRefreshVersionMap = useAtomValue(agentDiffRefreshVersionAtom)
  const diffRefreshVersion = diffRefreshVersionMap.get(sessionId) ?? 0
  const hasFileChanges = filesVersion > 0

  // 派生当前工作区 slug（用于会话与工作区文件写入）
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug = workspaces.find((w) => w.id === currentWorkspaceId)?.slug ?? null

  // 附加目录列表（会话级）
  const attachedDirsMap = useAtomValue(agentAttachedDirectoriesMapAtom)
  const setAttachedDirsMap = useSetAtom(agentAttachedDirectoriesMapAtom)
  const attachedDirs = attachedDirsMap.get(sessionId) ?? []
  const attachedFilesMap = useAtomValue(agentAttachedFilesMapAtom)
  const setAttachedFilesMap = useSetAtom(agentAttachedFilesMapAtom)
  const attachedFiles = attachedFilesMap.get(sessionId) ?? []

  // 附加目录列表（工作区级）
  const wsAttachedDirsMap = useAtomValue(workspaceAttachedDirectoriesMapAtom)
  const setWsAttachedDirsMap = useSetAtom(workspaceAttachedDirectoriesMapAtom)
  const wsAttachedDirs = currentWorkspaceId ? (wsAttachedDirsMap.get(currentWorkspaceId) ?? []) : []
  const wsAttachedFilesMap = useAtomValue(workspaceAttachedFilesMapAtom)
  const setWsAttachedFilesMap = useSetAtom(workspaceAttachedFilesMapAtom)
  const wsAttachedFiles = currentWorkspaceId ? (wsAttachedFilesMap.get(currentWorkspaceId) ?? []) : []

  const extraPathsMemo = React.useMemo(
    () => [...attachedDirs, ...wsAttachedDirs],
    [attachedDirs, wsAttachedDirs]
  )

  const fileAccessPathsMemo = React.useMemo(
    () => [...extraPathsMemo, ...attachedFiles, ...wsAttachedFiles],
    [extraPathsMemo, attachedFiles, wsAttachedFiles]
  )

  // 加载工作区级附加目录
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI.getWorkspaceDirectories(workspaceSlug)
      .then((dirs) => {
        setWsAttachedDirsMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, dirs)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedDirsMap])

  // 加载工作区级附加文件
  React.useEffect(() => {
    if (!workspaceSlug || !currentWorkspaceId) return
    window.electronAPI.getWorkspaceAttachedFiles(workspaceSlug)
      .then((files) => {
        setWsAttachedFilesMap((prev) => {
          const map = new Map(prev)
          map.set(currentWorkspaceId, files)
          return map
        })
      })
      .catch(console.error)
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  // === 会话级：附加/移除目录 ===

  const attachSessionDir = React.useCallback(async (dirPath: string) => {
    const updated = await window.electronAPI.attachDirectory({ sessionId, directoryPath: dirPath })
    setAttachedDirsMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedDirsMap])

  const handleAttachFolder = React.useCallback(async (): Promise<string | null> => {
    const result = await window.electronAPI.openFolderDialog()
    if (!result) return null
    await attachSessionDir(result.path)
    return result.name
  }, [attachSessionDir])

  const handleDetachDirectory = React.useCallback(async (dirPath: string) => {
    try {
      const updated = await window.electronAPI.detachDirectory({ sessionId, directoryPath: dirPath })
      setAttachedDirsMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(sessionId, updated) } else { map.delete(sessionId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除附加目录失败:', error)
    }
  }, [sessionId, setAttachedDirsMap])

  const attachSessionFile = React.useCallback(async (filePath: string) => {
    const updated = await window.electronAPI.attachFile({ sessionId, filePath })
    setAttachedFilesMap((prev) => {
      const map = new Map(prev)
      map.set(sessionId, updated)
      return map
    })
  }, [sessionId, setAttachedFilesMap])

  const handleSessionFilesAttached = React.useCallback(
    async (filePaths: string[]): Promise<FilePanelReferenceResult> => (
      referenceFilePaths(filePaths, attachSessionFile)
    ),
    [attachSessionFile],
  )

  const handleDetachFile = React.useCallback(async (filePath: string) => {
    try {
      const updated = await window.electronAPI.detachFile({ sessionId, filePath })
      setAttachedFilesMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(sessionId, updated) } else { map.delete(sessionId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除附加文件失败:', error)
    }
  }, [sessionId, setAttachedFilesMap])

  // === 工作区级：附加/移除目录 ===

  const attachWorkspaceDir = React.useCallback(async (dirPath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) {
      throw new Error('当前工作区尚未初始化')
    }
    const updated = await window.electronAPI.attachWorkspaceDirectory({ workspaceSlug, directoryPath: dirPath })
    setWsAttachedDirsMap((prev) => {
      const map = new Map(prev)
      map.set(currentWorkspaceId, updated)
      return map
    })
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedDirsMap])

  const handleAttachWorkspaceFolder = React.useCallback(async (): Promise<string | null> => {
    const result = await window.electronAPI.openFolderDialog()
    if (!result) return null
    await attachWorkspaceDir(result.path)
    return result.name
  }, [attachWorkspaceDir])

  const handleSessionDirectoriesDropped = React.useCallback(
    async (directoryPaths: string[]): Promise<FilePanelReferenceResult> => (
      referenceFilePaths(directoryPaths, attachSessionDir)
    ),
    [attachSessionDir],
  )

  const handleWorkspaceDirectoriesDropped = React.useCallback(
    async (directoryPaths: string[]): Promise<FilePanelReferenceResult> => (
      referenceFilePaths(directoryPaths, attachWorkspaceDir)
    ),
    [attachWorkspaceDir],
  )

  const handleDetachWorkspaceDirectory = React.useCallback(async (dirPath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) return
    try {
      const updated = await window.electronAPI.detachWorkspaceDirectory({ workspaceSlug, directoryPath: dirPath })
      setWsAttachedDirsMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(currentWorkspaceId, updated) } else { map.delete(currentWorkspaceId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除工作区附加目录失败:', error)
    }
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedDirsMap])

  const attachWorkspaceFile = React.useCallback(async (filePath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) {
      throw new Error('当前工作区尚未初始化')
    }
    const updated = await window.electronAPI.attachWorkspaceFile({ workspaceSlug, filePath })
    setWsAttachedFilesMap((prev) => {
      const map = new Map(prev)
      map.set(currentWorkspaceId, updated)
      return map
    })
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  const handleWorkspaceFilesAttached = React.useCallback(
    async (filePaths: string[]): Promise<FilePanelReferenceResult> => (
      referenceFilePaths(filePaths, attachWorkspaceFile)
    ),
    [attachWorkspaceFile],
  )

  const handleDetachWorkspaceFile = React.useCallback(async (filePath: string) => {
    if (!workspaceSlug || !currentWorkspaceId) return
    try {
      const updated = await window.electronAPI.detachWorkspaceFile({ workspaceSlug, filePath })
      setWsAttachedFilesMap((prev) => {
        const map = new Map(prev)
        if (updated.length > 0) { map.set(currentWorkspaceId, updated) } else { map.delete(currentWorkspaceId) }
        return map
      })
    } catch (error) {
      console.error('[SidePanel] 移除工作区附加文件失败:', error)
    }
  }, [workspaceSlug, currentWorkspaceId, setWsAttachedFilesMap])

  // 文件上传完成后递增版本号，触发 FileBrowser 刷新
  const handleFilesUploaded = React.useCallback(() => {
    setFilesVersion((prev) => prev + 1)
  }, [setFilesVersion])

  const handleSaveSessionFiles = React.useCallback(async (files: FilePanelUploadEntry[]): Promise<void> => {
    await window.electronAPI.saveFilesToAgentSession({
      workspaceSlug: workspaceSlug ?? '',
      sessionId,
      files,
    })
    handleFilesUploaded()
  }, [handleFilesUploaded, sessionId, workspaceSlug])

  const handleSaveWorkspaceFiles = React.useCallback(async (files: FilePanelUploadEntry[]): Promise<void> => {
    if (!workspaceSlug) {
      throw new Error('当前工作区尚未初始化')
    }
    await window.electronAPI.saveFilesToWorkspaceFiles({
      workspaceSlug,
      files,
    })
    handleFilesUploaded()
  }, [handleFilesUploaded, workspaceSlug])

  // 添加文件到聊天
  const pendingFiles = useAtomValue(agentPendingFilesAtomFamily(sessionId))
  const setPendingFiles = useSetAtom(agentPendingFilesAtomFamily(sessionId))
  const handleAddToChat = React.useCallback((entry: FileEntry) => {
    // 先在 setter 外部检查去重，避免在 updater 函数内执行不可逆副作用
    if (pendingFiles.some((f) => f.sourcePath === entry.path)) return

    const pending: AgentPendingFile = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: entry.name,
      mediaType: getMediaTypeFromFilename(entry.name),
      size: entry.size ?? 0,
      sourcePath: entry.path,
    }

    // 有 sourcePath 的文件发送时直接引用原路径，不需要存 base64
    setPendingFiles((prev) => [...prev, pending])
  }, [pendingFiles, setPendingFiles])

  // 面包屑：显示根路径最后两段
  const breadcrumb = React.useMemo(() => {
    if (!sessionPath) return ''
    const parts = sessionPath.split('/').filter(Boolean)
    return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : sessionPath
  }, [sessionPath])

  // 工作区文件目录路径
  const [workspaceFilesPath, setWorkspaceFilesPath] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!workspaceSlug) {
      setWorkspaceFilesPath(null)
      return
    }
    window.electronAPI.getWorkspaceFilesPath(workspaceSlug).then(setWorkspaceFilesPath).catch(() => setWorkspaceFilesPath(null))
  }, [workspaceSlug])

  const worktreeRepoPathsMemo = React.useMemo(
    () => [sessionPath, workspaceFilesPath, ...extraPathsMemo].filter(Boolean) as string[],
    [sessionPath, workspaceFilesPath, extraPathsMemo]
  )

  // RightSidePanel 完全由用户控制：Agent 文件变更不创建或切换 Tab，
  // 也不展开目录、滚动或定位；搜索结果点击仍可发送主动定位信号。

  // 同步 basePaths ref（供 handleFilePreview 使用，避免 hooks 声明顺序问题）
  basePathsRef.current = [sessionPath, workspaceFilesPath, ...fileAccessPathsMemo].filter(Boolean) as string[]
  const hasSessionAttachedItems = attachedDirs.length > 0 || attachedFiles.length > 0
  const hasWorkspaceAttachedItems = wsAttachedDirs.length > 0 || wsAttachedFiles.length > 0
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const sideChatMap = useAtomValue(agentSideChatMapAtom)
  const setSideChatMap = useSetAtom(agentSideChatMapAtom)
  const sideChatConversationId = sideChatMap.get(sessionId) ?? null
  const executionGraph = useAtomValue(agentRuntimeExecutionGraphAtomFamily(sessionId))
  const runtimePlanLifecycle = useAtomValue(agentRuntimePlanLifecycleAtom).get(sessionId)
  const runtimeHistory = useAtomValue(agentSidePanelRuntimeHistoryAtom).get(sessionId)
  const executionNodeTabSnapshots = useAtomValue(agentExecutionNodeTabSnapshotsAtom)
    .get(sessionId)
  const terminalTabSnapshots = useAtomValue(agentTerminalTabSnapshotsAtom).get(sessionId)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const agentStreamingStates = useAtomValue(agentStreamingStatesAtom)
  const effectiveExecutionGraph = React.useMemo(() => {
    const nodes = new Map<string, AgentRuntimeExecutionNode>(
      (runtimeHistory?.nodes ?? []).map((node) => [node.id, node]),
    )
    for (const node of executionGraph?.nodes ?? []) nodes.set(node.id, node)
    const fallbackTodos = executionGraph?.todos.length
      ? executionGraph.todos
      : (runtimeHistory?.todos ?? [])
    return {
      runtimeSessionId: executionGraph?.runtimeSessionId,
      nodes: Array.from(nodes.values()),
      todos: getVisibleRuntimePlanTodos(
        runtimePlanLifecycle,
        fallbackTodos,
      ),
      updatedAt: Math.max(
        executionGraph?.updatedAt ?? 0,
        runtimeHistory?.updatedAt ?? 0,
      ),
    }
  }, [executionGraph, runtimeHistory, runtimePlanLifecycle])
  const executionNodes = React.useMemo(
    () => buildSessionExecutionNodes({
      sessionId,
      runtimeGraph: effectiveExecutionGraph,
      sessions: agentSessions,
      liveRuntimeNodeIds: new Set(
        (executionGraph?.nodes ?? []).map((node) => node.id),
      ),
    }).filter(isSubagentExecutionNode),
    [agentSessions, effectiveExecutionGraph, executionGraph?.nodes, sessionId],
  )
  const hasExecutionGraph = executionNodes.length > 0
  const hasPlan = effectiveExecutionGraph.todos.length > 0
  const availableTabs = React.useMemo(() => {
    return getAvailableAgentSidePanelTabs({
      openTabs,
      hasExecutionGraph,
      hasPlan,
      hasSideChat: Boolean(sideChatConversationId),
    })
  }, [hasExecutionGraph, hasPlan, openTabs, sideChatConversationId])
  const activeExecutionNodeId = getAgentExecutionNodeId(activeTab)
  const activeTerminalSessionId = getAgentTerminalSessionId(activeTab)
  const activeTerminalSnapshot = isAgentTerminalTab(activeTab)
    ? terminalTabSnapshots?.get(activeTab)
    : undefined
  // 所有会话已打开的浏览器类 Tab（静态 browser + 实例 + 任务），用于多实例常驻渲染。
  // 注意：这里读全局 atom（而非仅当前会话的 openTabs），并固定 key = sessionId:tab，
  // 让每个会话的 webview 各自常驻、复用其专属 partition，切换会话只改显隐、不重载。
  const allSidePanelTabs = useAtomValue(agentSidePanelTabsAtom)
  const browserTabs = React.useMemo(
    () => Array.from(allSidePanelTabs.entries()).flatMap(([sessId, tabs]) =>
      tabs
        .filter((tab) =>
          tab === 'browser' || isBrowserInstanceTab(tab) || isBrowserTaskTab(tab),
        )
        .map((tab) => ({ sessionId: sessId, tab })),
    ),
    [allSidePanelTabs],
  )
  // 当前会话的激活 Tab 是否为浏览器类（决定常驻浏览器层是否可见/参与交互）。
  // 注：层内 webview 始终常驻挂载（含其他会话），仅在不显示浏览器时整层隐藏。
  const isActiveBrowserTab = (
    browserTabs.some((item) => item.sessionId === sessionId) && (
      activeTab === 'browser'
      || isBrowserInstanceTab(activeTab)
      || isBrowserTaskTab(activeTab)
    )
  )
  const activeExecutionNodeSnapshot = activeExecutionNodeId && isAgentExecutionNodeTab(activeTab)
    ? executionNodeTabSnapshots?.get(activeTab)
    : undefined
  // 优先使用实时节点，执行图暂时移除节点后才回退到打开 Tab 时保存的快照。
  const activeExecutionNode = (
    activeExecutionNodeId
      ? executionNodes.find((node) => node.id === activeExecutionNodeId)
      : undefined
  ) ?? activeExecutionNodeSnapshot?.node
  const activeExecutionNodeRunning = activeExecutionNode
    ? isSessionExecutionNodeDetailRunning(
        activeExecutionNode,
        agentStreamingStates.get(sessionId)?.running === true,
        activeExecutionNode.transcriptSessionId
          ? agentStreamingStates.get(activeExecutionNode.transcriptSessionId)?.running
          : undefined,
      )
    : false
  const getTabLabel = React.useCallback((tab: AgentSidePanelTab): string | undefined => {
    if (isAgentTerminalTab(tab)) {
      const terminal = terminalTabSnapshots?.get(tab)
      if (!terminal) return '终端'
      if (terminal.title) return terminal.title
      const baseTitle = getPathBasename(terminal.cwd) || terminal.shellName || '终端'
      const sameTitleTabs = openTabs.filter((openTab) => {
        if (!isAgentTerminalTab(openTab)) return false
        const item = terminalTabSnapshots?.get(openTab)
        if (!item || item.title) return false
        return (getPathBasename(item.cwd) || item.shellName || '终端') === baseTitle
      })
      const duplicateIndex = sameTitleTabs.indexOf(tab)
      return sameTitleTabs.length > 1 && duplicateIndex >= 0
        ? `${baseTitle} ${duplicateIndex + 1}`
        : baseTitle
    }
    const browserTaskId = getBrowserTaskId(tab)
    if (browserTaskId && isBrowserTaskTab(tab)) {
      const browserTask = browserAgentTasks.find((item) => item.taskId === browserTaskId)
      return browserTask?.title || '浏览器任务'
    }
    const browserInstanceId = getBrowserInstanceId(tab)
    if (browserInstanceId && isBrowserInstanceTab(tab)) {
      return `浏览器 ${browserInstanceId}`
    }
    const nodeId = getAgentExecutionNodeId(tab)
    if (!nodeId || !isAgentExecutionNodeTab(tab)) return undefined
    const node = executionNodeTabSnapshots?.get(tab)?.node
      ?? executionNodes.find((item) => item.id === nodeId)
    return node?.name || node?.description || '执行节点'
  }, [browserAgentTasks, executionNodeTabSnapshots, executionNodes, openTabs, terminalTabSnapshots])

  const handleCloseChatTab = React.useCallback(() => {
    setSideChatMap((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
    onCloseTab('chat')
  }, [onCloseTab, sessionId, setSideChatMap])
  const handleActiveTerminalExit = React.useCallback(() => {
    if (!activeTerminalSessionId) return
    onCloseTab(createAgentTerminalTab(activeTerminalSessionId))
  }, [activeTerminalSessionId, onCloseTab])

  React.useEffect(() => {
    if (sideChatConversationId || !openTabs.includes('chat')) return
    onCloseTab('chat')
  }, [onCloseTab, openTabs, sideChatConversationId])

  return (
    <div
      className={cn(
        // 只有顶部 34px 的 TabBar 可以拖动窗口。不要把整个侧栏设为 drag：
        // Windows 的 Chromium hitmask 可能吞掉嵌套 no-drag 区域内的 xterm 键盘焦点。
        'relative z-0 h-full flex-shrink-0 overflow-hidden bg-content-area',
        isClassic && 'rounded-2xl shadow-xl dark:shadow-md',
        shouldAnimate && 'transition-[width] duration-300 ease-in-out',
        isOpen ? '' : '!w-0',
      )}
      style={isOpen ? { width } : undefined}
    >
      {/* 面板内容 */}
      <div
        className={cn(
          'relative w-full h-full flex flex-col titlebar-no-drag',
          isWindows ? 'pt-[34px]' : 'pt-0',
          shouldAnimate && 'transition-opacity duration-300',
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        >
          {launcherVisible ? (
            <>
              <div className="relative flex h-[34px] shrink-0 items-center tabbar-bg">
                <div className={cn('absolute inset-0 titlebar-drag-region', isWindows && 'right-[126px]')} />
              </div>
              <SidePanelLauncher
                onOpenTab={onOpenTab}
                onCreateTerminal={onCreateTerminal}
              />
            </>
          ) : (
            <>
              <DiffPanelTabBar
                activeTab={activeTab}
                openTabs={openTabs}
                availableTabs={availableTabs}
                onTabChange={onTabChange}
                onTabClose={(tab) => {
                  if (tab === 'chat') handleCloseChatTab()
                  else onCloseTab(tab)
                }}
                onTabAdd={(tab) => {
                  if (tab === 'terminal') onCreateTerminal()
                  else onOpenTab(tab)
                }}
                onTabReorder={onReorderTabs}
                getTabLabel={getTabLabel}
                isWindows={isWindows}
              />

              <div className="relative flex min-h-0 flex-1 flex-col">
              {activeTerminalSessionId ? (
                <IntegratedTerminalPanel
                  sessionId={sessionId}
                  terminalSessionId={activeTerminalSessionId}
                  terminalCwd={activeTerminalSnapshot?.cwd ?? null}
                  currentSessionPath={sessionPath}
                  onCreateSibling={onCreateTerminal}
                  onExit={handleActiveTerminalExit}
                />
              ) : activeExecutionNodeId ? (
                activeExecutionNode ? (
                  <RuntimeExecutionNodePanel
                    cacheKey={`${sessionId}:${activeTab}`}
                    sessionId={sessionId}
                    sessionPath={sessionPath}
                    node={activeExecutionNode}
                    running={activeExecutionNodeRunning}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
                    该执行节点已不存在或尚未同步。
                  </div>
                )
              ) : activeTab === 'chat' ? (
                sideChatConversationId ? (
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ChatView conversationId={sideChatConversationId} />
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">暂无问答会话</div>
                )
              ) : activeTab === 'execution' ? (
                <RuntimeExecutionPanel
                  sessionId={sessionId}
                  onOpenNode={(node, runtimeSessionId) => {
                    const tab = createAgentExecutionNodeTab(node.id, runtimeSessionId)
                    openSidePanelTab({
                      sessionId,
                      tab,
                      executionNodeSnapshot: {
                        node,
                        runtimeSessionId,
                      },
                    })
                  }}
                />
              ) : activeTab === 'plan' ? (
                <RuntimePlanPanel sessionId={sessionId} />
              ) : isActiveBrowserTab ? (
                <div className="flex-1 min-h-0" data-persistent-browser-underlay />
              ) : activeTab === 'changes' ? (
                sessionPath ? (
                  <DiffChangesList
                    key={sessionId}
                    dirPath={sessionPath}
                    sessionId={sessionId}
                    sessionPath={sessionPath}
                    workspaceFilesPath={workspaceFilesPath || undefined}
                    extraPaths={fileAccessPathsMemo}
                    refreshVersion={diffRefreshVersion}
                    selectedFilePath={selectedFilePath}
                    onFileClick={handleDiffFileClick}
                    workspaceSlug={workspaceSlug || undefined}
                    worktreeRepoPaths={worktreeRepoPathsMemo}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">等待会话初始化...</div>
                )
              ) : activeTab === 'session' ? (
                <div className="flex-1 min-h-0 flex flex-col pt-0.5 mx-2 mb-2">
                  {sessionPath ? (
                    <>
                      <div className="flex items-center gap-1 px-2 h-[32px] flex-shrink-0">
                        <FolderOpen className="size-3 text-muted-foreground" />
                        <span className="text-[11px] font-medium text-muted-foreground">会话文件</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="size-3 text-muted-foreground/50 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[200px]">
                            <p>当前会话的专属文件，仅本次对话的 Agent 可以访问</p>
                          </TooltipContent>
                        </Tooltip>
                        <span className="text-[10px] text-muted-foreground/70 truncate flex-1 min-w-0" title={sessionPath}>
                          {breadcrumb}
                        </span>
                        <FilePanelAddButton
                          scope="session"
                          className={filePanelActionButtonClass}
                          onSaveFiles={handleSaveSessionFiles}
                          onReferenceFiles={handleSessionFilesAttached}
                          onReferenceDirectories={handleSessionDirectoriesDropped}
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={filePanelActionButtonClass}
                              onClick={() => window.electronAPI.openFile(sessionPath).catch(console.error)}
                            >
                              <FolderSearch />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p>在 Finder 中打开</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <FileSearchBar
                        workspaceFilesPath={null}
                        sessionPath={sessionPath}
                        sessionAttachedDirs={attachedDirs}
                        workspaceAttachedDirs={[]}
                        placeholder="搜索会话文件..."
                        sessionId={sessionId}
                        onFilePreview={handleFilePreview}
                      />
                      <FilePanelDropTarget
                        onSaveFiles={handleSaveSessionFiles}
                        onReferenceFiles={handleSessionFilesAttached}
                        onAddDirectories={handleSessionDirectoriesDropped}
                      >
                        <div className="hover-scrollbar-xy min-h-0 min-w-0 flex-1">
                          {attachedFiles.length > 0 && (
                            <AttachedFilesSection
                              attachedFiles={attachedFiles}
                              onDetach={handleDetachFile}
                              onAddToChat={handleAddToChat}
                              onFilePreview={handleFilePreview}
                              allowedPaths={basePathsRef.current}
                              sessionId={sessionId}
                            />
                          )}
                          {attachedDirs.length > 0 && (
                            <AttachedDirsSection
                              scope="session"
                              attachedDirs={attachedDirs}
                              onDetach={handleDetachDirectory}
                              refreshVersion={filesVersion}
                              onAddToChat={handleAddToChat}
                              onFilePreview={handleFilePreview}
                              allowedPaths={basePathsRef.current}
                              sessionId={sessionId}
                            />
                          )}
                          {hasSessionAttachedItems && (
                            <div className="mb-1 px-3 pt-2 text-[11px] font-medium text-muted-foreground">工作文件（存储于该工作区目录）</div>
                          )}
                          <FileBrowser rootPath={sessionPath} hideToolbar embedded hideEmpty={hasSessionAttachedItems} onAddToChat={handleAddToChat} onFilePreview={handleFilePreview} />
                        </div>
                      </FilePanelDropTarget>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">等待会话初始化...</div>
                  )}
                </div>
              ) : (
                <div className="flex-1 min-h-0 flex flex-col pt-0.5">
                  <div className="flex-1 min-h-0 flex flex-col mx-2 mb-2">
                    <div className="flex items-center gap-1 px-2 h-[32px] flex-shrink-0">
                      <FolderHeart className="size-3 text-muted-foreground" />
                      <span className="text-[11px] font-medium text-muted-foreground">工作区文件</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="size-3 text-muted-foreground/50 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-[220px]">
                          <p>工作区内所有会话可访问的文件和文件夹，每个新对话都可以自动读取</p>
                        </TooltipContent>
                      </Tooltip>
                      <div className="flex-1" />
                      <FilePanelAddButton
                        scope="workspace"
                        disabled={!workspaceFilesPath || !workspaceSlug}
                        className={filePanelActionButtonClass}
                        onSaveFiles={handleSaveWorkspaceFiles}
                        onReferenceFiles={handleWorkspaceFilesAttached}
                        onReferenceDirectories={handleWorkspaceDirectoriesDropped}
                      />
                      {workspaceFilesPath && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={filePanelActionButtonClass}
                              onClick={() => window.electronAPI.openFile(workspaceFilesPath).catch(console.error)}
                            >
                              <FolderSearch />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p>在 Finder 中打开工作区文件目录</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <FileSearchBar
                      workspaceFilesPath={workspaceFilesPath}
                      sessionPath={null}
                      sessionAttachedDirs={[]}
                      workspaceAttachedDirs={wsAttachedDirs}
                      placeholder="搜索工作区文件..."
                      sessionId={sessionId}
                      onFilePreview={handleFilePreview}
                    />
                    <FilePanelDropTarget
                      disabled={!workspaceFilesPath || !workspaceSlug}
                      onSaveFiles={handleSaveWorkspaceFiles}
                      onReferenceFiles={handleWorkspaceFilesAttached}
                      onAddDirectories={handleWorkspaceDirectoriesDropped}
                    >
                      <div className="hover-scrollbar-xy min-h-0 min-w-0 flex-1 pb-1">
                        {wsAttachedFiles.length > 0 && (
                          <AttachedFilesSection
                            attachedFiles={wsAttachedFiles}
                            onDetach={handleDetachWorkspaceFile}
                            onAddToChat={handleAddToChat}
                            onFilePreview={handleFilePreview}
                            allowedPaths={basePathsRef.current}
                            sessionId={sessionId}
                          />
                        )}
                        {wsAttachedDirs.length > 0 && (
                          <AttachedDirsSection
                            scope="workspace"
                            attachedDirs={wsAttachedDirs}
                            onDetach={handleDetachWorkspaceDirectory}
                            refreshVersion={filesVersion}
                            onAddToChat={handleAddToChat}
                            onFilePreview={handleFilePreview}
                            allowedPaths={basePathsRef.current}
                            sessionId={sessionId}
                          />
                        )}
                        {workspaceFilesPath && (
                          <>
                            {hasWorkspaceAttachedItems && (
                              <div className="mb-1 px-3 pt-2 text-[11px] font-medium text-muted-foreground">工作文件（存储于该工作区目录）</div>
                            )}
                            <FileBrowser rootPath={workspaceFilesPath} hideToolbar embedded hideEmpty={hasWorkspaceAttachedItems} onAddToChat={handleAddToChat} onFilePreview={handleFilePreview} />
                          </>
                        )}
                      </div>
                    </FilePanelDropTarget>
                  </div>
                </div>
              )}

              </div>
            </>
          )}

          {/* 常驻浏览器层：始终挂载，但不参与 flex 高度分配；固定定位在 34px Tab 栏下方。
              非浏览器 Tab 必须用 display:none。visibility/opacity/pointer-events 挡不住
              Electron webview 的原生合成层，会把文件列表的点击和滚动全部吞掉。 */}
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 z-[1]',
              !launcherVisible && isActiveBrowserTab ? 'block' : 'hidden',
            )}
            // macOS 只有 Tab 栏；Windows 还需要避开面板顶部的标题栏预留区。
            style={{ top: isWindows ? 68 : 34 }}
          >
            {/* 每个会话的每个浏览器 Tab（静态/实例/任务）独立挂载一个 webview，
                始终不卸载；仅当前会话的激活浏览器 Tab 显示，其余 display:none。
                切换会话 / 切换 Tab / 面板开合都不会重建 webview，已打开的页面不会重新加载。
                每个会话使用独立 partition（Cookie/localStorage/缓存隔离）。 */}
            <div
              className="absolute inset-0 z-[1] flex min-h-0 flex-col bg-background"
              data-persistent-browser-layer
            >
              {browserTabs.map(({ sessionId: tabSessionId, tab }) => {
                // 仅当前会话的激活浏览器 Tab 可见，其他会话/其他 Tab 常驻但隐藏
                const active = tabSessionId === sessionId && tab === activeTab
                const taskId = isBrowserTaskTab(tab)
                  ? (getBrowserTaskId(tab) ?? undefined)
                  : undefined
                const browserTask = taskId ? allBrowserAgentTasks.get(taskId) : undefined
                return (
                  <div
                    // key 固定为 sessionId:tab：常驻不卸载，切换会话只改显隐
                    key={`${tabSessionId}:${tab}`}
                    className={cn(
                      'absolute inset-0 flex min-h-0 flex-col bg-background',
                      active ? 'block' : 'hidden',
                    )}
                    data-persistent-browser-instance={`${tabSessionId}:${tab}`}
                  >
                    <BrowserPanel
                      key={`${tabSessionId}:${tab}`}
                      sessionId={tabSessionId}
                      taskId={taskId}
                      initialUrl={browserTask?.url}
                    />
                  </div>
                )
              })}
            </div>
          </div>
      </div>
    </div>
  )
}

const SIDE_PANEL_LAUNCHER_ENTRIES: Array<{
  tab: AgentSidePanelAddTab
  title: string
  description: string
  icon: React.ReactNode
}> = [
  {
    tab: 'browser',
    title: '浏览器',
    description: '打开内置浏览器，浏览网页并采集页面证据',
    icon: <Globe className="size-4" />,
  },
  {
    tab: 'session',
    title: '会话文件',
    description: '查看当前会话的专属文件',
    icon: <FolderOpen className="size-4" />,
  },
  {
    tab: 'workspace',
    title: '工作区文件',
    description: '查看工作区共享文件',
    icon: <FolderHeart className="size-4" />,
  },
  {
    tab: 'changes',
    title: '文件改动',
    description: '查看当前工作树的全部变更',
    icon: <FileDiff className="size-4" />,
  },
  {
    tab: 'terminal',
    title: '终端',
    description: '在当前会话目录打开交互式 Shell',
    icon: <Terminal className="size-4" />,
  },
]

export function SidePanelLauncher({
  onOpenTab,
  onCreateTerminal,
}: {
  onOpenTab: (tab: AgentSidePanelAddTab) => void
  onCreateTerminal?: () => void
}): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-[320px] space-y-1">
        {SIDE_PANEL_LAUNCHER_ENTRIES.map((entry) => (
          <button
            key={entry.tab}
            type="button"
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/55"
            onClick={() => {
              if (entry.tab === 'terminal' && onCreateTerminal) onCreateTerminal()
              else onOpenTab(entry.tab)
            }}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
              {entry.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{entry.title}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {entry.description}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ===== 附加文件容器 =====

interface AttachedFilesSectionProps {
  attachedFiles: string[]
  onDetach: (filePath: string) => void
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  allowedPaths?: string[]
  sessionId: string
}

function AttachedFilesSection({ attachedFiles, onDetach, onAddToChat, onFilePreview, allowedPaths, sessionId }: AttachedFilesSectionProps): React.ReactElement {
  return (
    <div className="pt-2.5 pb-1 flex-shrink-0">
      <div className="text-[11px] font-medium text-muted-foreground mb-1 px-3">附加文件（Agent 可以按原路径读取）</div>
      {attachedFiles.map((filePath) => {
        const name = getPathBasename(filePath)
        const entry: FileEntry = { name, path: filePath, isDirectory: false }
        return (
          <div
            key={filePath}
            className="flex w-max min-w-full items-center gap-1 py-1 pl-2 pr-2 text-sm cursor-pointer hover:bg-accent/50 group mx-2 rounded-lg"
            onClick={() => onFilePreview?.(filePath)}
          >
            <span className="w-3.5 flex-shrink-0" />
            <FileTypeIcon name={name} isDirectory={false} />
            <span className="shrink-0 text-xs whitespace-nowrap" title={filePath}>{name}</span>
            <div
              className="flex-shrink-0 mr-1"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70 text-muted-foreground hover:text-foreground invisible group-hover:visible focus-visible:visible data-[state=open]:visible"
                    title="更多操作"
                    aria-label="更多操作"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                  {onAddToChat && (
                    <DropdownMenuItem
                      className="text-xs py-1 [&>svg]:size-3.5"
                      onSelect={() => onAddToChat(entry)}
                    >
                      <MessageSquarePlus />
                      添加到聊天
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => window.electronAPI.showAttachedInFolder(filePath, { sessionId, candidateBasePaths: allowedPaths }).catch(console.error)}
                  >
                    <FolderSearch />
                    在文件夹中显示
                  </DropdownMenuItem>
                  {onFilePreview && (
                    <DropdownMenuItem
                      className="text-xs py-1 [&>svg]:size-3.5"
                      onSelect={() => onFilePreview(filePath)}
                    >
                      <ExternalLink />
                      打开文件
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-xs py-1 text-destructive focus:text-destructive [&>svg]:size-3.5"
                    onSelect={() => onDetach(filePath)}
                  >
                    <X />
                    移除附加
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ===== 可访问目录容器（管理选中状态） =====

interface AttachedDirsSectionProps {
  scope: 'session' | 'workspace'
  attachedDirs: string[]
  onDetach: (dirPath: string) => void
  /** 文件版本号，用于自动刷新已展开的目录 */
  refreshVersion: number
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  /** 所有允许访问的路径（传给 IPC 做路径校验） */
  allowedPaths?: string[]
  sessionId: string
}

/** 可访问目录区域：统一管理所有子项的选中状态 */
function AttachedDirsSection({ scope, attachedDirs, onDetach, refreshVersion, onAddToChat, onFilePreview, allowedPaths, sessionId }: AttachedDirsSectionProps): React.ReactElement {
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set())

  // ===== 接入搜索点击触发的 reveal：附加目录文件搜到后，需要展开/选中目标 =====
  const autoReveal = useAtomValue(fileBrowserAutoRevealAtom)
  // 找到 reveal target 命中的那个附加目录根。如果用户附加了嵌套目录（如同时附加 /a 和 /a/b），
  // 取"最深匹配"——只让真正包含该文件的最近一棵树展开，避免外层 /a 树被无谓打开。
  const revealRoot = React.useMemo(() => {
    if (!autoReveal) return null
    let best: string | null = null
    for (const dir of attachedDirs) {
      if (!isPathUnderRoot(dir, autoReveal.path)) continue
      if (!best || dir.length > best.length) best = dir
    }
    return best
  }, [autoReveal, attachedDirs])
  const revealTarget = revealRoot ? autoReveal!.path : null
  const revealTs = revealRoot ? autoReveal!.ts : 0

  // 命中本区域时把目标加入选中态（与 FileBrowser 行为对齐）
  const consumedSelectTsRef = React.useRef(0)
  React.useEffect(() => {
    if (!revealTarget || revealTs === 0) return
    if (revealTs <= consumedSelectTsRef.current) return
    consumedSelectTsRef.current = revealTs
    setSelectedPaths(new Set([revealTarget]))
  }, [revealTs, revealTarget])

  const handleSelect = React.useCallback((path: string, ctrlKey: boolean) => {
    setSelectedPaths((prev) => {
      if (ctrlKey) {
        // Ctrl+点击：切换选中
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      }
      // 普通点击：单选
      return new Set([path])
    })
  }, [])

  return (
    <div className="file-tree-guide-scope pt-2.5 pb-1 flex-shrink-0">
      <div className="mb-1 px-3">
        <div className="text-[11px] font-medium text-muted-foreground">可访问目录</div>
        <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground/70">
          {scope === 'workspace'
            ? '不会复制或作为消息附件；Agent 可直接读写，工作区内所有会话均可访问。'
            : '不会复制或作为消息附件；Agent 可在当前会话中直接读取和修改。'}
        </div>
      </div>
      {attachedDirs.map((dir) => {
        const isRevealRoot = dir === revealRoot
        return (
          <AttachedDirTree
            key={dir}
            dirPath={dir}
            onDetach={() => onDetach(dir)}
            selectedPaths={selectedPaths}
            onSelect={handleSelect}
            refreshVersion={refreshVersion}
            onAddToChat={onAddToChat}
            onFilePreview={onFilePreview}
            allowedPaths={allowedPaths}
            sessionId={sessionId}
            revealTarget={isRevealRoot ? revealTarget : null}
            revealTs={isRevealRoot ? revealTs : 0}
          />
        )
      })}
    </div>
  )
}

// ===== 附加目录树组件 =====

interface AttachedDirTreeProps {
  dirPath: string
  onDetach: () => void
  selectedPaths: Set<string>
  onSelect: (path: string, ctrlKey: boolean) => void
  refreshVersion: number
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  allowedPaths?: string[]
  sessionId: string
  /** 自动定位目标（仅当落在此 dirPath 之下时由父级传入，否则为 null） */
  revealTarget?: string | null
  /** 自动定位脉冲时间戳，变化时重新触发 */
  revealTs?: number
}

function AttachedDirTree({ dirPath, onDetach, selectedPaths, onSelect, refreshVersion, onAddToChat, onFilePreview, allowedPaths, sessionId, revealTarget = null, revealTs = 0 }: AttachedDirTreeProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [children, setChildren] = React.useState<FileEntry[]>([])
  const [loaded, setLoaded] = React.useState(false)

  const dirName = dirPath.split('/').filter(Boolean).pop() || dirPath

  // 计算从 dirPath 到 revealTarget 之间的祖先目录集合（用于子项决定是否自动展开）
  const revealAncestors = React.useMemo(
    () => revealTarget ? computeRevealAncestors(dirPath, revealTarget) : new Set<string>(),
    [dirPath, revealTarget],
  )

  // 当 refreshVersion 变化时，已展开的目录自动重新加载
  React.useEffect(() => {
    if (expanded && loaded) {
      window.electronAPI.listAttachedDirectory(dirPath, { sessionId, candidateBasePaths: allowedPaths })
        .then((items) => setChildren(items))
        .catch((err) => console.error('[AttachedDirTree] 刷新失败:', err))
    }
  }, [refreshVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 自动定位：reveal target 命中时自动加载子项 + 展开 =====
  React.useEffect(() => {
    if (revealTs === 0 || !revealTarget) return
    let cancelled = false
    const run = async (): Promise<void> => {
      if (!loaded) {
        try {
          const items = await window.electronAPI.listAttachedDirectory(dirPath, { sessionId, candidateBasePaths: allowedPaths })
          if (!cancelled) {
            setChildren(items)
            setLoaded(true)
          }
        } catch (err) {
          console.error('[AttachedDirTree] reveal 加载失败:', err)
          return
        }
      }
      if (!cancelled) setExpanded(true)
    }
    void run()
    return () => { cancelled = true }
  }, [revealTs]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleExpand = async (): Promise<void> => {
    if (!expanded && !loaded) {
      try {
        const items = await window.electronAPI.listAttachedDirectory(dirPath, { sessionId, candidateBasePaths: allowedPaths })
        setChildren(items)
        setLoaded(true)
      } catch (err) {
        console.error('[AttachedDirTree] 加载失败:', err)
      }
    }
    setExpanded(!expanded)
  }

  // depth=0 的根行，与 FileBrowser 保持一致的布局：铺满、无外边距、可 sticky
  const { paddingLeft, guideLeft } = computeTreeRowLayout(0)
  const isSticky = expanded

  return (
    <div className="relative w-max min-w-full">
      <div
        data-sticky-row={isSticky ? 'true' : undefined}
        className={cn(
          'file-tree-row relative flex h-8 w-max min-w-full items-center gap-1 pr-2 text-sm cursor-pointer group',
          isSticky && cn(STICKY_ROW_BASE_CLASS, 'top-0 z-10'),
        )}
        style={{ paddingLeft }}
        onClick={toggleExpand}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-2 right-2 z-0 rounded-[17px] transition-colors',
            // sticky 行 hover 用不透明色，避免下方滚动内容透出；普通行保持半透明柔和感
            isSticky ? 'group-hover:bg-accent' : 'group-hover:bg-accent/50',
          )}
        />
        <ChevronRight
          className={cn(
            'relative z-10 size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        <FileTypeIcon name={dirName} isDirectory isOpen={expanded} className="relative z-10" />
        <span className="relative z-10 text-xs whitespace-nowrap flex-1" title={dirPath}>
          {dirName}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative z-10 h-5 w-5 mr-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
          onClick={(e) => { e.stopPropagation(); onDetach() }}
        >
          <X className="size-3" />
        </Button>
      </div>
      {expanded && (
        <div className="relative">
          <span
            aria-hidden="true"
            className="file-tree-guide pointer-events-none absolute bottom-1 top-0 w-px bg-border/70"
            style={{ left: guideLeft }}
          />
          {children.length === 0 && loaded && (
            <div
              className="text-[11px] text-muted-foreground/50 py-1"
              style={{ paddingLeft: paddingLeft + 24 }}
            >
              空文件夹
            </div>
          )}
          {children.map((child) => (
            <AttachedDirItem key={child.path} entry={child} depth={1} selectedPaths={selectedPaths} onSelect={onSelect} refreshVersion={refreshVersion} onAddToChat={onAddToChat} onFilePreview={onFilePreview} allowedPaths={allowedPaths} sessionId={sessionId} revealTarget={revealTarget} revealTs={revealTs} revealAncestors={revealAncestors} />
          ))}
        </div>
      )}
    </div>
  )
}

interface AttachedDirItemProps {
  entry: FileEntry
  depth: number
  selectedPaths: Set<string>
  onSelect: (path: string, ctrlKey: boolean) => void
  refreshVersion: number
  onAddToChat?: (entry: FileEntry) => void
  onFilePreview?: (filePath: string) => void
  allowedPaths?: string[]
  sessionId: string
  /** 自动定位目标路径，命中则滚动到中心 */
  revealTarget?: string | null
  /** 自动定位脉冲时间戳，变化时重新触发 */
  revealTs?: number
  /** 祖先目录集合，命中则自动展开 */
  revealAncestors?: Set<string>
}

function AttachedDirItem({ entry, depth, selectedPaths, onSelect, refreshVersion, onAddToChat, onFilePreview, allowedPaths, sessionId, revealTarget = null, revealTs = 0, revealAncestors }: AttachedDirItemProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [children, setChildren] = React.useState<FileEntry[]>([])
  const [loaded, setLoaded] = React.useState(false)
  // 重命名状态
  const [isRenaming, setIsRenaming] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState(entry.name)
  const renameInputRef = React.useRef<HTMLInputElement>(null)
  // 当前显示的名称和路径（重命名后更新）
  const [currentName, setCurrentName] = React.useState(entry.name)
  const [currentPath, setCurrentPath] = React.useState(entry.path)
  const rowRef = React.useRef<HTMLDivElement>(null)

  const isSelected = selectedPaths.has(currentPath)

  // 当 refreshVersion 变化时，已展开的文件夹自动重新加载子项
  React.useEffect(() => {
    if (expanded && loaded && entry.isDirectory) {
      window.electronAPI.listAttachedDirectory(currentPath, { sessionId, candidateBasePaths: allowedPaths })
        .then((items) => setChildren(items))
        .catch((err) => console.error('[AttachedDirItem] 刷新子目录失败:', err))
    }
  }, [refreshVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 自动定位：祖先目录自动展开 + 目标行滚动到中心 =====
  React.useEffect(() => {
    if (revealTs === 0 || !revealTarget) return

    const isAncestor = !!revealAncestors && revealAncestors.has(currentPath)
    const isTarget = currentPath === revealTarget

    const scrollToTarget = (): void => {
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }

    // 自身需要展开：祖先目录 OR 目标本身就是目录
    const willExpand = entry.isDirectory && (isAncestor || isTarget) && !expanded
    if (willExpand) {
      let cancelled = false
      const run = async (): Promise<void> => {
        if (!loaded) {
          try {
            const items = await window.electronAPI.listAttachedDirectory(currentPath, { sessionId, candidateBasePaths: allowedPaths })
            if (!cancelled) {
              setChildren(items)
              setLoaded(true)
            }
          } catch (err) {
            console.error('[AttachedDirItem] reveal 加载子目录失败:', err)
            return
          }
        }
        if (cancelled) return
        setExpanded(true)
        // 目标自身就是这个目录时，等展开成功后再滚动，避免子项渲染改变行高使
        // smooth scroll 偏离；加载失败路径自然跳过滚动。
        if (isTarget) scrollToTarget()
      }
      void run()
      return () => { cancelled = true }
    }

    // 目标行：滚动到可视区中心（不打 flash，直接靠选中态高亮）
    if (isTarget) scrollToTarget()
  }, [revealTs]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDir = async (): Promise<void> => {
    if (!entry.isDirectory) return
    if (!expanded && !loaded) {
      try {
        const items = await window.electronAPI.listAttachedDirectory(currentPath, { sessionId, candidateBasePaths: allowedPaths })
        setChildren(items)
        setLoaded(true)
      } catch (err) {
        console.error('[AttachedDirItem] 加载子目录失败:', err)
      }
    }
    setExpanded(!expanded)
  }

  const handleClick = (e: React.MouseEvent): void => {
    const isMulti = e.ctrlKey || e.metaKey
    onSelect(currentPath, isMulti)
    if (isMulti) return
    if (entry.isDirectory) {
      void toggleDir()
    } else {
      onFilePreview?.(currentPath)
    }
  }

  // 开始重命名
  const startRename = (): void => {
    setRenameValue(currentName)
    setIsRenaming(true)
    // 延迟聚焦，等待 DOM 渲染
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  // 确认重命名
  const confirmRename = async (): Promise<void> => {
    const newName = renameValue.trim()
    if (!newName || newName === currentName) {
      setIsRenaming(false)
      return
    }
    try {
      await window.electronAPI.renameAttachedFile(currentPath, newName, { sessionId, candidateBasePaths: allowedPaths })
      // 更新本地显示
      const parentDir = currentPath.substring(0, currentPath.lastIndexOf('/'))
      const newPath = `${parentDir}/${newName}`
      // 更新选中状态中的路径
      onSelect(newPath, false)
      setCurrentName(newName)
      setCurrentPath(newPath)
    } catch (err) {
      console.error('[AttachedDirItem] 重命名失败:', err)
    }
    setIsRenaming(false)
  }

  // 取消重命名
  const cancelRename = (): void => {
    setIsRenaming(false)
    setRenameValue(currentName)
  }

  // 移动到文件夹
  const handleMove = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openFolderDialog()
      if (!result) return
      await window.electronAPI.moveAttachedFile(currentPath, result.path, { sessionId, candidateBasePaths: allowedPaths })
      // 移动后更新路径
      const newPath = `${result.path}/${currentName}`
      setCurrentPath(newPath)
    } catch (err) {
      console.error('[AttachedDirItem] 移动失败:', err)
    }
  }

  const { paddingLeft, guideLeft, stickyTop, stickyZIndex } = computeTreeRowLayout(depth)
  const isSticky = entry.isDirectory && expanded && canBeSticky(depth)

  return (
    <>
      <div
        ref={rowRef}
        data-sticky-row={isSticky ? 'true' : undefined}
        className={cn(
          'file-tree-row relative flex h-8 w-max min-w-full items-center gap-1 pr-2 text-sm cursor-pointer group',
          isSticky && STICKY_ROW_BASE_CLASS,
        )}
        style={{
          paddingLeft,
          top: isSticky ? stickyTop : undefined,
          zIndex: isSticky ? stickyZIndex : undefined,
        }}
        onClick={handleClick}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-y-0 left-2 right-2 z-0 rounded-[17px] transition-colors',
            // sticky 行 hover 用不透明色，避免下方滚动内容透出；普通行保持半透明柔和感
            isSelected
              ? 'bg-accent'
              : isSticky
                ? 'group-hover:bg-accent'
                : 'group-hover:bg-accent/50',
          )}
        />
        {/* sticky 行祖先链竖线，逻辑见 tree-row-layout.tsx 的 AncestorGuides。
            选中态下 bg-accent 不透明背景会盖住原 border 色，组件内部已切到 accent-foreground。 */}
        {isSticky && <AncestorGuides depth={depth} isSelected={isSelected} />}
        {entry.isDirectory ? (
          <ChevronRight
            className={cn(
              'relative z-10 size-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="relative z-10 w-3.5 flex-shrink-0" />
        )}
        <FileTypeIcon name={currentName} isDirectory={entry.isDirectory} isOpen={expanded} className="relative z-10" />

        {/* 名称：正常显示 / 重命名输入框 */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="relative z-10 text-xs flex-1 min-w-0 bg-background border border-primary rounded px-1 py-0.5 outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRename()
              if (e.key === 'Escape') cancelRename()
              e.stopPropagation()
            }}
            onBlur={confirmRename}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="relative z-10 shrink-0 whitespace-nowrap text-xs">{currentName}</span>
        )}

        {/* 右侧操作按钮占位 */}
        <div
          className="relative z-10 flex-shrink-0 mr-1"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 悬浮/选中状态：三点菜单 */}
          {!isRenaming && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'h-6 w-6 rounded flex items-center justify-center hover:bg-accent/70 text-muted-foreground hover:text-foreground',
                  !isSelected && 'invisible group-hover:visible focus-visible:visible data-[state=open]:visible',
                )}
                title="更多操作"
                aria-label="更多操作"
                onClick={() => {
                  if (!isSelected) onSelect(currentPath, false)
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                {onAddToChat && !entry.isDirectory && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onAddToChat({ ...entry, path: currentPath, name: currentName })}
                  >
                    <MessageSquarePlus />
                    添加到聊天
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={() => window.electronAPI.showAttachedInFolder(currentPath, { sessionId, candidateBasePaths: allowedPaths }).catch(console.error)}
                >
                  <FolderSearch />
                  在文件夹中显示
                </DropdownMenuItem>
                {!entry.isDirectory && onFilePreview && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onFilePreview(currentPath)}
                  >
                    <ExternalLink />
                    打开文件
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={startRename}
                >
                  <Pencil />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={handleMove}
                >
                  <FolderInput />
                  移动到...
                </DropdownMenuItem>
              </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
      </div>
      {expanded && (
        <div className="relative">
          <span
            aria-hidden="true"
            className="file-tree-guide pointer-events-none absolute bottom-1 top-0 w-px bg-border/70"
            style={{ left: guideLeft }}
          />
          {children.length === 0 && loaded && (
            <div
              className="text-[11px] text-muted-foreground/50 py-1"
              style={{ paddingLeft: paddingLeft + 24 }}
            >
              空文件夹
            </div>
          )}
          {children.map((child) => (
            <AttachedDirItem key={child.path} entry={child} depth={depth + 1} selectedPaths={selectedPaths} onSelect={onSelect} refreshVersion={refreshVersion} onAddToChat={onAddToChat} onFilePreview={onFilePreview} allowedPaths={allowedPaths} sessionId={sessionId} revealTarget={revealTarget} revealTs={revealTs} revealAncestors={revealAncestors} />
          ))}
        </div>
      )}
    </>
  )
}
