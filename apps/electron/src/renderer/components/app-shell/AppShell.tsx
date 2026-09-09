/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠/悬停飞出] | [MainArea: TabBar + TabContent] | [RightSidePanel 可折叠]
 *
 * 侧栏交互：
 * - 展开/收起：侧栏列动画 width（peekWidth ↔ 0）+ overflow 裁剪，主区同帧单方向伸缩
 * - 动画时长/缓动与侧栏共用 SIDEBAR_COLLAPSE_*，面板右缘与主区左缘始终贴齐
 * - 悬停（收起态）：临时飞出完整侧栏 overlay，不进文档流
 * - 点击切换按钮：固定展开 / 收起；折叠按钮 fixed，位置不跳
 *
 * MainArea 支持多标签页；Settings 视图作为顶层路由替换整个工作区。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { LeftSidebar } from './LeftSidebar'
import { RightSidePanel } from './RightSidePanel'
import { MainArea } from '@/components/tabs/MainArea'
import { SettingsView } from '@/components/settings/SettingsView'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import {
  AGENT_SIDE_PANEL_MIN_WIDTH,
  agentSidePanelWidthAtom,
  currentAgentSessionIdAtom,
  currentSessionSidePanelOpenAtom,
} from '@/atoms/agent-atoms'
import { leftSidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { sidebarCollapsedAtom, sidebarPeekingAtom } from '@/atoms/tab-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { interfaceVariantAtom } from '@/atoms/theme'
import { WindowControls } from '@/components/WindowControls'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { detectIsMac, detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import {
  clearSidebarPeekCloseTimer,
  isPointerInSidebarPeekZone,
  openSidebarPeek as openSidebarPeekShared,
  scheduleCloseSidebarPeek as scheduleCloseSidebarPeekShared,
  SIDEBAR_PEEK_HOTZONE_WIDTH,
  SIDEBAR_PEEK_TITLEBAR_HEIGHT,
} from '@/lib/sidebar-peek'
import {
  SIDEBAR_TOGGLE_LEFT,
  SIDEBAR_TOGGLE_SIZE,
  TITLEBAR_DRAG_LEFT,
  SIDEBAR_COLLAPSE_DURATION_MS,
  SIDEBAR_COLLAPSE_EASING,
  sidebarWidthTransition,
  titlebarDragLeftOffset,
} from '@/lib/sidebar-layout'
import { cn } from '@/lib/utils'

const RIGHT_PANEL_RESIZE_HANDLE_WIDTH = 8
const MIN_MAIN_AREA_WIDTH = 360

function getRightPanelMaxWidth(): number {
  if (typeof window === 'undefined') return Number.POSITIVE_INFINITY
  return Math.max(
    AGENT_SIDE_PANEL_MIN_WIDTH,
    window.innerWidth - MIN_MAIN_AREA_WIDTH - RIGHT_PANEL_RESIZE_HANDLE_WIDTH,
  )
}

function clampRightPanelWidth(width: number, maxWidth = getRightPanelMaxWidth()): number {
  return Math.max(AGENT_SIDE_PANEL_MIN_WIDTH, Math.min(maxWidth, width))
}

const MIN_LEFT_SIDEBAR_WIDTH = 260
const MAX_LEFT_SIDEBAR_WIDTH = 360

function clampLeftSidebarWidth(width: number): number {
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, width))
}

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const activeView = useAtomValue(activeViewAtom)
  const isSettingsView = activeView === 'settings'
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const isPanelOpen = useAtomValue(currentSessionSidePanelOpenAtom)
  const automationForm = useAtomValue(automationFormAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  // 定时任务表单打开时隐藏右侧文件面板，让中间区域扩展到全宽（表单内含自己的右栏配置）
  const showRightPanel = !isSettingsView
    && appMode === 'agent'
    && !!currentSessionId
    && !automationForm.open
    && activeView !== 'automations'
    && activeView !== 'agent-skills'
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const isMac = React.useMemo(() => detectIsMac(), [])

  // 左侧边栏可拖拽宽度
  const [leftSidebarWidth, setLeftSidebarWidth] = useAtom(leftSidebarWidthAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const leftDragging = React.useRef(false)
  const [isDraggingLeftSidebar, setIsDraggingLeftSidebar] = React.useState(false)
  // 防止 pointerdown + click 双触发导致折叠又立刻展开。
  // 用时间戳而不是 sticky flag：若 click 被 Electron 标题栏吞掉，armed 会永久卡住，
  // 下一次只收到 click 时会被误判为“已处理”而点不动。
  const sidebarToggleAtRef = React.useRef(0)
  // 折叠动画进行中禁止 peek，避免「滑出」过程中飞出层再插一刀造成双弹
  const sidebarAnimatingUntilRef = React.useRef(0)
  const clampedLeftSidebarWidth = clampLeftSidebarWidth(leftSidebarWidth)

  // 收起态：悬停飞出（状态与 TabBar 展开按钮共享）
  const [sidebarPeeking, setSidebarPeeking] = useAtom(sidebarPeekingAtom)

  const peekPanelWidth = isClassic ? clampedLeftSidebarWidth + 8 : clampedLeftSidebarWidth
  const toggleChromeRight = isMac ? TITLEBAR_DRAG_LEFT : 12 + SIDEBAR_TOGGLE_SIZE

  // 用 ref 读最新状态，避免 pointermove 闭包过期
  const sidebarCollapsedRef = React.useRef(sidebarCollapsed)
  const sidebarPeekingRef = React.useRef(sidebarPeeking)
  const peekPanelWidthRef = React.useRef(peekPanelWidth)
  const toggleChromeRightRef = React.useRef(toggleChromeRight)
  const lastPointerRef = React.useRef({ x: 0, y: 0 })
  sidebarCollapsedRef.current = sidebarCollapsed
  sidebarPeekingRef.current = sidebarPeeking
  peekPanelWidthRef.current = peekPanelWidth
  toggleChromeRightRef.current = toggleChromeRight

  const isPointerInExpandedPeekZone = React.useCallback((clientX: number, clientY: number) => {
    return isPointerInSidebarPeekZone(clientX, clientY, {
      panelWidth: peekPanelWidthRef.current,
      peeking: true,
      toggleChromeRight: toggleChromeRightRef.current,
    })
  }, [])

  const syncSidebarPeekFromPointer = React.useCallback((clientX: number, clientY: number) => {
    if (!sidebarCollapsedRef.current) return
    if (Date.now() < sidebarAnimatingUntilRef.current) return
    lastPointerRef.current = { x: clientX, y: clientY }
    const inside = isPointerInSidebarPeekZone(clientX, clientY, {
      panelWidth: peekPanelWidthRef.current,
      peeking: sidebarPeekingRef.current,
      toggleChromeRight: toggleChromeRightRef.current,
    })
    if (inside) {
      // 同步乐观更新 ref，避免本帧内移到 Code/顶栏时仍按「未飞出」热区判断而误关
      sidebarPeekingRef.current = true
      openSidebarPeekShared(setSidebarPeeking)
    } else if (sidebarPeekingRef.current) {
      scheduleCloseSidebarPeekShared(setSidebarPeeking, () => {
        // 关闭瞬间再判：若指针已回到 Code/折叠按钮/面板列，则保持飞出
        const { x, y } = lastPointerRef.current
        return !isPointerInExpandedPeekZone(x, y)
      })
    }
  }, [isPointerInExpandedPeekZone, setSidebarPeeking])

  const handleOpenSidebarPeek = React.useCallback(() => {
    if (!sidebarCollapsed) return
    if (Date.now() < sidebarAnimatingUntilRef.current) return
    openSidebarPeekShared(setSidebarPeeking)
  }, [setSidebarPeeking, sidebarCollapsed])

  const handleScheduleCloseSidebarPeek = React.useCallback(() => {
    if (!sidebarCollapsed) return
    scheduleCloseSidebarPeekShared(setSidebarPeeking, () => {
      const { x, y } = lastPointerRef.current
      return !isPointerInExpandedPeekZone(x, y)
    })
  }, [isPointerInExpandedPeekZone, setSidebarPeeking, sidebarCollapsed])

  // 收起态：用指针几何同步飞出，覆盖 Code / 折叠按钮 / 顶部镂空等 DOM leave 盲区
  React.useEffect(() => {
    if (!sidebarCollapsed) {
      clearSidebarPeekCloseTimer()
      setSidebarPeeking(false)
      return
    }

    const onPointerMove = (event: PointerEvent) => {
      syncSidebarPeekFromPointer(event.clientX, event.clientY)
    }
    const onPointerLeaveWindow = () => {
      if (sidebarPeekingRef.current) {
        scheduleCloseSidebarPeekShared(setSidebarPeeking, () => true)
      }
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onPointerLeaveWindow)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      document.documentElement.removeEventListener('mouseleave', onPointerLeaveWindow)
    }
  }, [setSidebarPeeking, sidebarCollapsed, syncSidebarPeekFromPointer])

  React.useEffect(() => () => clearSidebarPeekCloseTimer(), [])

  const handleToggleSidebar = React.useCallback(() => {
    // 副作用放在 setState 外；函数式更新避免闭包读到旧 collapsed
    clearSidebarPeekCloseTimer()
    setSidebarPeeking(false)
    setSidebarCollapsed((prev) => !prev)
  }, [setSidebarCollapsed, setSidebarPeeking])

  // 任意来源（按钮 / ⌘B）切换折叠时都锁住 peek，覆盖整段侧栏动画
  const isFirstCollapseAnimEffectRef = React.useRef(true)
  React.useEffect(() => {
    if (isFirstCollapseAnimEffectRef.current) {
      isFirstCollapseAnimEffectRef.current = false
      return
    }
    clearSidebarPeekCloseTimer()
    setSidebarPeeking(false)
    sidebarAnimatingUntilRef.current = Date.now() + SIDEBAR_COLLAPSE_DURATION_MS
  }, [setSidebarPeeking, sidebarCollapsed])

  React.useEffect(() => {
    if (clampedLeftSidebarWidth !== leftSidebarWidth) {
      setLeftSidebarWidth(clampedLeftSidebarWidth)
    }
  }, [clampedLeftSidebarWidth, leftSidebarWidth, setLeftSidebarWidth])

  const handleLeftSidebarMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    leftDragging.current = true
    setIsDraggingLeftSidebar(true)
    const startX = e.clientX
    const startWidth = clampedLeftSidebarWidth
    // 记录最新光标位置，rAF 回调读取它而非调度时捕获的旧事件，避免快拖时坐标滞后
    let latestClientX = startX
    let rafId = 0

    const applyWidth = () => {
      const delta = latestClientX - startX
      setLeftSidebarWidth(clampLeftSidebarWidth(startWidth + delta))
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!leftDragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onMouseUp = () => {
      leftDragging.current = false
      setIsDraggingLeftSidebar(false)
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      // 补一次最终 flush，保证落点停在光标实际位置而非上一帧
      applyWidth()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedLeftSidebarWidth, setLeftSidebarWidth])

  // 右侧面板可拖拽宽度
  const [rightPanelWidth, setRightPanelWidth] = useAtom(agentSidePanelWidthAtom)
  const dragging = React.useRef(false)
  const [viewportWidth, setViewportWidth] = React.useState(() => (
    typeof window === 'undefined' ? 0 : window.innerWidth
  ))
  const rightPanelMaxWidth = React.useMemo(() => {
    if (!viewportWidth) return Number.POSITIVE_INFINITY
    return Math.max(
      AGENT_SIDE_PANEL_MIN_WIDTH,
      viewportWidth - MIN_MAIN_AREA_WIDTH - RIGHT_PANEL_RESIZE_HANDLE_WIDTH,
    )
  }, [viewportWidth])
  const clampedRightPanelWidth = clampRightPanelWidth(rightPanelWidth, rightPanelMaxWidth)

  React.useEffect(() => {
    const syncViewportWidth = () => setViewportWidth(window.innerWidth)
    syncViewportWidth()
    window.addEventListener('resize', syncViewportWidth)
    return () => window.removeEventListener('resize', syncViewportWidth)
  }, [])

  React.useEffect(() => {
    if (clampedRightPanelWidth !== rightPanelWidth) {
      setRightPanelWidth(clampedRightPanelWidth)
    }
  }, [clampedRightPanelWidth, rightPanelWidth, setRightPanelWidth])

  const handleMouseDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    const startX = e.clientX
    const startWidth = clampedRightPanelWidth
    // 记录最新光标位置，rAF 回调读取它而非调度时捕获的旧事件，避免快拖时坐标滞后
    let latestClientX = startX
    let rafId = 0
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    // Electron <webview> 是原生合成层，会吞掉 CSS 上层元素上的 mousemove。
    // 拖拽期间关掉 guest 命中，手柄才能跟着光标走。
    const guests = Array.from(document.querySelectorAll('webview, iframe')) as HTMLElement[]
    guests.forEach((el) => { el.style.pointerEvents = 'none' })

    const applyWidth = () => {
      const delta = startX - latestClientX
      setRightPanelWidth(clampRightPanelWidth(startWidth + delta, rightPanelMaxWidth))
    }

    const onPointerMove = (ev: PointerEvent) => {
      if (!dragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onPointerUp = () => {
      dragging.current = false
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      // 补一次最终 flush，保证落点停在光标实际位置而非上一帧
      applyWidth()
      if (handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId)
      }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      guests.forEach((el) => { el.style.pointerEvents = '' })
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerUp)
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerUp)
  }, [clampedRightPanelWidth, rightPanelMaxWidth, setRightPanelWidth])


  // 设置页是独立路由，不再渲染普通对话侧栏，因此标题栏从窗口左侧开始。
  const titlebarDragLeft = titlebarDragLeftOffset({
    isMac,
    sidebarCollapsed: isSettingsView ? true : sidebarCollapsed,
    sidebarPeeking: isSettingsView ? false : sidebarPeeking,
    leftSidebarWidth: isSettingsView ? 0 : peekPanelWidth,
  })

  return (
    <AppShellProvider value={contextValue}>
      {!isSettingsView && (
        /* 顶栏固定折叠按钮：位置不随侧栏跳动。
           关键：不要把按钮嵌在 drag 父级里再挖 no-drag 洞——Electron/Chromium
           的 app-region hitmask 对「drag 内小矩形 no-drag」不可靠（Windows 控制按钮
           已踩过坑）。这里把 no-drag 热区与 drag 条在几何上彻底拆开。 */
        <div
          className="titlebar-no-drag fixed top-0 left-0 z-[200] flex h-[52px] items-center"
          style={{
            // 只覆盖红绿灯占位 + 折叠按钮，右侧交给独立 drag 条
            width: isMac ? TITLEBAR_DRAG_LEFT : 12 + SIDEBAR_TOGGLE_SIZE,
            WebkitAppRegion: 'no-drag',
            // Electron hit-test：完全透明 no-drag 有时不参与命中，给极淡底色
            backgroundColor: 'rgba(0,0,0,0.001)',
          } as React.CSSProperties}
          onMouseEnter={() => {
            // 飞出后移到折叠按钮：保持打开，不在未飞出时误弹出
            if (sidebarCollapsed && sidebarPeeking) {
              openSidebarPeekShared(setSidebarPeeking)
            }
          }}
          onMouseLeave={(e) => {
            if (!sidebarCollapsed || !sidebarPeeking) return
            lastPointerRef.current = { x: e.clientX, y: e.clientY }
            // 若仍在左侧面板几何内（例如移回 Code），保持打开
            if (
              isPointerInSidebarPeekZone(e.clientX, e.clientY, {
                panelWidth: peekPanelWidth,
                peeking: true,
                toggleChromeRight,
              })
            ) {
              openSidebarPeekShared(setSidebarPeeking)
              return
            }
            scheduleCloseSidebarPeekShared(setSidebarPeeking, () => {
              const { x, y } = lastPointerRef.current
              return !isPointerInExpandedPeekZone(x, y)
            })
          }}
        >
          {/* 红绿灯占位：不拦截事件，避免挡住原生 traffic lights */}
          <div
            className="h-full flex-shrink-0 pointer-events-none"
            style={{ width: isMac ? SIDEBAR_TOGGLE_LEFT : 12 }}
            aria-hidden
          />
          <button
            type="button"
            aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            className="titlebar-no-drag relative z-[1] size-8 flex-shrink-0 flex items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/75 active:bg-foreground/[0.08] transition-colors focus-visible:outline-none"
            style={{
              WebkitAppRegion: 'no-drag',
              backgroundColor: 'rgba(0,0,0,0.001)',
            } as React.CSSProperties}
            onPointerDown={(e) => {
              // 优先 pointerdown：即使某些环境 click 仍被标题栏吞掉也能切换
              if (e.button !== 0) return
              e.preventDefault()
              e.stopPropagation()
              sidebarToggleAtRef.current = Date.now()
              handleToggleSidebar()
            }}
            onMouseDown={(e) => {
              // 部分 Electron 标题栏场景 pointer 事件不稳定，mousedown 兜底
              if (e.button !== 0) return
              e.preventDefault()
              e.stopPropagation()
              if (Date.now() - sidebarToggleAtRef.current < SIDEBAR_COLLAPSE_DURATION_MS) return
              sidebarToggleAtRef.current = Date.now()
              handleToggleSidebar()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // pointerdown/mousedown 已在短窗口内切换过则跳过，避免双触发
              if (Date.now() - sidebarToggleAtRef.current < SIDEBAR_COLLAPSE_DURATION_MS) {
                return
              }
              handleToggleSidebar()
            }}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
        </div>
      )}

      {/* 独立 drag 条：从折叠按钮右缘开始，到右侧面板之前。
          右侧面板顶栏有自己的 titlebar-no-drag，不需要 drag 条覆盖。
          drag 条 z-50 低于主区 z-[60]，所以面板按钮始终可点击。
          面板打开时必须把 right 收到面板左缘：Electron 的 app-region hitmask
          不完全吃 z-index，铺到右侧会吞掉终端顶部的键盘焦点。 */}
      <div
        className={cn(
          'titlebar-drag-region fixed top-0 z-50 h-[52px]',
          !showRightPanel && (isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0'),
        )}
        style={{
          left: titlebarDragLeft,
          ...(showRightPanel
            ? { right: clampedRightPanelWidth + (isPanelOpen ? RIGHT_PANEL_RESIZE_HANDLE_WIDTH : 0) }
            : {}),
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
        aria-hidden
      />

      {/* Windows 自定义窗口控制按钮（最小化/最大化/关闭） */}
      <WindowControls />


      <div
        data-native-vibrancy={isMac && !isClassic && !isSettingsView && navigator.userAgent.includes('Electron/') ? 'true' : undefined}
        className="shell-bg relative h-screen w-screen flex overflow-hidden bg-background"
      >
        {isSettingsView ? (
          <div className="relative z-[60] flex min-w-0 flex-1">
            <SettingsView />
          </div>
        ) : (
          <>
        {/* 布局模型（width + 同步 translate，面板右缘与主区左缘同帧）：
            - 外列动画 width：peekWidth ↔ 0，主区同帧伸缩
            - 内层同曲线 translateX：0 ↔ -peekWidth，视觉上整栏往左滑出（而非右侧被裁切）
            - 任意时刻：内层右缘 = 外列右缘，不会和主区脱节
            - peek 用 overlay，不进文档流 */}
        <div
          className={cn(
            'relative z-[60] flex-shrink-0 overflow-hidden',
            sidebarCollapsed && !sidebarPeeking && 'pointer-events-none',
          )}
          style={{
            width: sidebarCollapsed ? 0 : peekPanelWidth,
            transition: sidebarWidthTransition(!isDraggingLeftSidebar),
          }}
          onMouseEnter={handleOpenSidebarPeek}
          onMouseLeave={handleScheduleCloseSidebarPeek}
        >
          <div
            className={cn('h-full', isClassic && 'p-2 pr-0')}
            style={{
              width: peekPanelWidth,
              transform: sidebarCollapsed ? `translateX(-${peekPanelWidth}px)` : 'translateX(0)',
              transition: isDraggingLeftSidebar
                ? undefined
                : `transform ${SIDEBAR_COLLAPSE_DURATION_MS}ms ${SIDEBAR_COLLAPSE_EASING}`,
            }}
          >
            <LeftSidebar width={clampedLeftSidebarWidth} noTransition />
          </div>
          {/* 分割线跟侧栏一起动，避免再单独动画 width 造成二次位移感 */}
          {!isClassic && (
            <div
              aria-hidden
              className="pointer-events-none absolute right-0 top-0 bottom-0 z-[1] w-px bg-border/55"
            />
          )}
          {/* 拖拽手柄：仅固定展开时可用 */}
          {!sidebarCollapsed && (
            <div
              className="absolute right-0 top-0 bottom-0 z-20 w-2 translate-x-1/2 cursor-col-resize transition-colors hover:bg-foreground/[0.035] active:bg-primary/20"
              onMouseDown={handleLeftSidebarMouseDown}
            />
          )}
        </div>

        {/* 收起态：左缘热区 + 飞出面板。
            开/关主要由 window pointermove 的几何判断驱动（见 syncSidebarPeekFromPointer），
            这里 DOM enter/leave 仅作补充。飞出后整列（含顶部 Code、折叠按钮）都算内侧。 */}
        {sidebarCollapsed && (
          <div
            data-sidebar-peek
            className={cn(
              'absolute left-0 bottom-0 z-[70] pointer-events-auto',
              sidebarPeeking
                ? cn(
                    'top-0',
                    !isClassic && 'shadow-[8px_0_32px_rgba(0,0,0,0.12)] dark:shadow-[8px_0_32px_rgba(0,0,0,0.45)]',
                  )
                : 'w-3',
            )}
            style={{
              width: sidebarPeeking ? peekPanelWidth : SIDEBAR_PEEK_HOTZONE_WIDTH,
              top: sidebarPeeking ? 0 : SIDEBAR_PEEK_TITLEBAR_HEIGHT,
            }}
            onMouseEnter={handleOpenSidebarPeek}
            onMouseLeave={handleScheduleCloseSidebarPeek}
          >
            {sidebarPeeking && (
              <div className={cn('h-full', isClassic && 'p-2 pr-0')}>
                <LeftSidebar width={clampedLeftSidebarWidth} noTransition />
              </div>
            )}
          </div>
        )}

        {/* 主区：随侧栏列宽单一动画伸缩，无自有位移 transition */}
        <div className={cn('relative z-[60] flex-1 min-w-0', isClassic && 'p-2')}>
          <MainArea />
        </div>

        {/* 右侧边栏：Agent 文件面板 */}
        {showRightPanel && (
          <div
            className={cn(
              'relative z-[60] flex items-stretch crt-sidebar',
              isClassic
                ? 'transition-[padding] duration-300 ease-in-out'
                : '',
              isClassic && (isPanelOpen ? 'p-2 pl-0' : 'p-0')
            )}
            style={!isClassic ? { paddingTop: '18px' } : undefined}
          >
            {!isClassic && (
              <div aria-hidden="true" className="pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-px bg-border/80 dark:bg-border/70" />
            )}
            {/* 独立占位，不要叠在 webview 上。Electron guest 视图会吞掉覆盖层上的 pointer 事件。 */}
            {isPanelOpen && (
              <div
                className="relative z-[80] w-2 flex-shrink-0 self-stretch cursor-col-resize hover:bg-foreground/[0.035] active:bg-primary/20 transition-colors titlebar-no-drag"
                onPointerDown={handleMouseDown}
              />
            )}
            <RightSidePanel width={clampedRightPanelWidth} />
          </div>
        )}
          </>
        )}
      </div>
    </AppShellProvider>
  )
}
