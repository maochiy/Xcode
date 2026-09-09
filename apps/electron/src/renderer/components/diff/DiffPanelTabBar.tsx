/**
 * DiffPanelTabBar — 右侧动态功能区 Tab 栏
 *
 * 只展示当前会话已经打开的功能；加号菜单用于打开尚未显示的功能。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Plus, Terminal, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  agentDiffUnseenChangesAtom,
  isAgentExecutionNodeTab,
  isAgentTerminalTab,
  isBrowserTaskTab,
  isBrowserInstanceTab,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import type {
  AgentSidePanelStaticTab,
  AgentSidePanelTab,
} from '@/atoms/agent-atoms'
import { interfaceVariantAtom } from '@/atoms/theme'
import type { AgentSidePanelAddTab } from '@/lib/agent-side-panel-tabs'

interface DiffPanelTabBarProps {
  activeTab: AgentSidePanelTab
  openTabs: AgentSidePanelTab[]
  availableTabs: AgentSidePanelAddTab[]
  onTabChange: (tab: AgentSidePanelTab) => void
  onTabClose: (tab: AgentSidePanelTab) => void
  onTabAdd: (tab: AgentSidePanelAddTab) => void
  onTabReorder: (source: AgentSidePanelTab, target: AgentSidePanelTab) => void
  getTabLabel?: (tab: AgentSidePanelTab) => string | undefined
  isWindows?: boolean
}

interface PreviousTabState {
  sessionId: string | null
  activeTab: AgentSidePanelTab
}

export const AGENT_SIDE_PANEL_TAB_LABELS: Record<AgentSidePanelStaticTab, string> = {
  browser: '浏览器',
  session: '会话文件',
  workspace: '工作区文件',
  changes: '文件改动',
  plan: '计划',
  execution: '子智能体',
  chat: '问答',
}

const AGENT_SIDE_PANEL_ADD_TAB_LABELS: Record<AgentSidePanelAddTab, string> = {
  ...AGENT_SIDE_PANEL_TAB_LABELS,
  terminal: '终端',
}

export function DiffPanelTabBar({
  activeTab,
  openTabs,
  availableTabs,
  onTabChange,
  onTabClose,
  onTabAdd,
  onTabReorder,
  getTabLabel,
  isWindows = false,
}: DiffPanelTabBarProps): React.ReactElement {
  const unseenMap = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenMap = useSetAtom(agentDiffUnseenChangesAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const unseenChanges = unseenMap.get(currentSessionId ?? '') ?? false
  const prevTabStateRef = React.useRef<PreviousTabState>({ sessionId: currentSessionId, activeTab })
  const preventAddMenuFocusRestoreRef = React.useRef(false)
  const [draggingTab, setDraggingTab] = React.useState<AgentSidePanelTab | null>(null)
  const [addMenuOpen, setAddMenuOpen] = React.useState(false)

  React.useEffect(() => {
    if (availableTabs.length === 0) setAddMenuOpen(false)
  }, [availableTabs.length])

  const clearUnseen = React.useCallback((sessionId = currentSessionId) => {
    if (!sessionId) return
    setUnseenMap((previous) => {
      if (previous.get(sessionId) === false) return previous
      const next = new Map(previous)
      next.set(sessionId, false)
      return next
    })
  }, [currentSessionId, setUnseenMap])

  React.useEffect(() => {
    const previous = prevTabStateRef.current
    if (
      previous.sessionId === currentSessionId
      && previous.activeTab === 'changes'
      && activeTab !== 'changes'
    ) {
      clearUnseen(currentSessionId)
    }
    prevTabStateRef.current = { sessionId: currentSessionId, activeTab }
  }, [activeTab, clearUnseen, currentSessionId])

  const handleTabChange = React.useCallback((tab: AgentSidePanelTab) => {
    if (tab === 'changes') clearUnseen()
    onTabChange(tab)
  }, [clearUnseen, onTabChange])
  const resolveTabLabel = React.useCallback((tab: AgentSidePanelTab): string => {
    if (isAgentExecutionNodeTab(tab)) return getTabLabel?.(tab) ?? '执行节点'
    if (isAgentTerminalTab(tab)) return getTabLabel?.(tab) ?? '终端'
    if (isBrowserTaskTab(tab)) return getTabLabel?.(tab) ?? '浏览器任务'
    if (isBrowserInstanceTab(tab)) return getTabLabel?.(tab) ?? '浏览器'
    return AGENT_SIDE_PANEL_TAB_LABELS[tab as AgentSidePanelStaticTab]
  }, [getTabLabel])

  return (
    <div className="relative flex h-[34px] flex-shrink-0 items-end tabbar-bg">
      <div className={cn('absolute inset-0 titlebar-drag-region', isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
      <div className="relative flex min-w-0 flex-1 items-end titlebar-no-drag">
        <div className="scrollbar-none flex w-fit min-w-0 max-w-[calc(100%-72px)] flex-none items-end overflow-x-auto">
          {openTabs.map((tab) => {
            const label = resolveTabLabel(tab)
            return (
              <div
                key={tab}
                draggable
                onDragStart={() => setDraggingTab(tab)}
                onDragEnd={() => setDraggingTab(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  if (draggingTab && draggingTab !== tab) onTabReorder(draggingTab, tab)
                  setDraggingTab(null)
                }}
                className={cn(
                  'group flex h-[34px] w-[120px] min-w-[96px] max-w-[168px] flex-none items-center border-l border-r border-t text-xs transition-colors',
                  isClassic ? 'rounded-t-lg' : 'rounded-none',
                  activeTab === tab
                    ? isClassic
                      ? 'border-border/50 bg-content-area text-foreground'
                      : 'app-tab-active border-border/80 text-foreground'
                    : isClassic
                      ? 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      : 'app-tab-inactive border-transparent text-muted-foreground hover:text-foreground',
                  draggingTab === tab && 'opacity-55',
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 self-stretch px-2"
                  onClick={() => handleTabChange(tab)}
                >
                  <span className="flex items-center justify-center gap-1 truncate">
                    {isAgentTerminalTab(tab) && <Terminal className="size-3 shrink-0" />}
                    {tab === 'changes' && unseenChanges && activeTab !== 'changes' && (
                      <span className="size-2 shrink-0 rounded-full bg-primary ring-1 ring-background" />
                    )}
                    <span className="truncate">{label}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted/70 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`关闭${label} Tab`}
                  onClick={() => onTabClose(tab)}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>

        <Popover
          open={addMenuOpen}
          onOpenChange={(open) => {
            if (open) preventAddMenuFocusRestoreRef.current = false
            setAddMenuOpen(open)
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag mb-[3px] ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground disabled:opacity-35"
              aria-label="打开其他功能"
              disabled={availableTabs.length === 0}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Plus className="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="w-40 p-1"
            data-side-panel-add-menu
            onCloseAutoFocus={(event) => {
              if (!preventAddMenuFocusRestoreRef.current) return
              // 只有新建终端时才由 xterm 接管焦点；其它菜单操作保留 Radix 默认行为。
              preventAddMenuFocusRestoreRef.current = false
              event.preventDefault()
            }}
          >
            {availableTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent/70 focus-visible:bg-accent/70"
                onClick={() => {
                  preventAddMenuFocusRestoreRef.current = tab === 'terminal'
                  onTabAdd(tab)
                  setAddMenuOpen(false)
                }}
              >
                {AGENT_SIDE_PANEL_ADD_TAB_LABELS[tab]}
              </button>
            ))}
          </PopoverContent>
        </Popover>

      </div>
    </div>
  )
}
