/**
 * ScrollMinimap — 消息导航迷你地图 + 滚动进度条
 *
 * 在消息区域左侧显示：
 * 1. 短横杠代表每条消息的位置（迷你地图），悬浮时弹出消息预览列表
 * 正文滚动条保持隐藏；迷你地图仅承担消息定位，不额外绘制滚动滑块。
 * 必须放在 StickToBottom（Conversation）内部使用。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Search } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Input } from '@/components/ui/input'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { channelsAtom } from '@/atoms/chat-atoms'
import { useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/utils'

export interface MinimapItem {
  id: string
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
}

interface ScrollMinimapProps {
  items: MinimapItem[]
}

/** 最少消息数才显示迷你地图 */
const MIN_ITEMS = 1
/** 迷你地图最多渲染的横杠数 */
const MAX_BARS = 20
/** 迷你地图横杠垂直间距（px） */
const MINIMAP_BAR_SPACING = 8

// ── Markdown 预览配置（轻量级，禁用重量级渲染） ──

const PREVIEW_REMARK_PLUGINS = [remarkGfm]

/* eslint-disable @typescript-eslint/no-explicit-any -- react-markdown components 类型复杂，使用内联对象即可 */
const PREVIEW_MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => <pre className="text-[11px] opacity-70 truncate">{children}</pre>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="text-[11px] bg-muted/50 px-0.5 rounded">{children}</code>,
  img: () => null as unknown as React.ReactElement,
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
} as const
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 辅助函数 ──

/** 计算 node 相对于 container 的实际顶部偏移（递归累积 offsetTop） */
function getOffsetTopRelativeTo(node: HTMLElement, container: HTMLElement): number {
  let top = 0
  let el: HTMLElement | null = node
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

/** 转义正则特殊字符 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 主组件 ──

export function ScrollMinimap({ items }: ScrollMinimapProps): React.ReactElement | null {
  const { scrollRef, stopScroll, state: stickyState } = useStickToBottomContext()
  const [hovered, setHovered] = React.useState(false)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const [visibleIds, setVisibleIds] = React.useState<Set<string>>(new Set())
  /** 主区视口几何中心当前对应的消息 id —— 面板打开时作为列表居中锚点 */
  const [centerVisibleId, setCenterVisibleId] = React.useState<string | undefined>(undefined)
  const [canScroll, setCanScroll] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  // ── 组件卸载时清理计时器 ──

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
    }
  }, [])

  // ── 可见消息 + 滚动指标追踪 ──

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const update = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = el
      setCanScroll(scrollHeight > clientHeight + 10)
      if (scrollHeight <= 0) return

      const viewportCenter = scrollTop + clientHeight / 2
      const nodes = el.querySelectorAll<HTMLElement>('[data-message-id]')
      const ids = new Set<string>()
      let centerId: string | undefined
      for (const node of nodes) {
        const top = getOffsetTopRelativeTo(node, el)
        const bottom = top + node.offsetHeight
        if (bottom > scrollTop && top < scrollTop + clientHeight) {
          const id = node.getAttribute('data-message-id')
          if (id) ids.add(id)
        }
        if (centerId === undefined && top <= viewportCenter && bottom > viewportCenter) {
          centerId = node.getAttribute('data-message-id') ?? undefined
        }
      }
      setVisibleIds(ids)
      setCenterVisibleId(centerId)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)

    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollRef])

  // ── 面板打开时自动聚焦搜索框 ──

  React.useEffect(() => {
    if (hovered && searchInputRef.current) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 80)
      return () => clearTimeout(timer)
    }
  }, [hovered])

  // ── 面板打开时把当前可见消息滚到列表中间，避免每次都从顶部开始 ──

  React.useEffect(() => {
    if (!hovered) return
    const timer = setTimeout(() => {
      const list = listRef.current
      if (!list) return
      const target = list.querySelector<HTMLElement>('[data-minimap-visible="true"]')
      if (!target) return
      // listRef 没有 position 设置，offsetTop / getOffsetTopRelativeTo 都不可靠，
      // 直接用 getBoundingClientRect 计算 target 相对 list 视口的偏移
      const listRect = list.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const offsetInList = (targetRect.top - listRect.top) + list.scrollTop
      const offset = offsetInList - (list.clientHeight - target.offsetHeight) / 2
      list.scrollTo({ top: Math.max(0, offset), behavior: 'auto' })
    }, 0)
    return () => clearTimeout(timer)
  }, [hovered])

  // ── 面板关闭时清空搜索 ──

  React.useEffect(() => {
    if (!hovered) setSearchQuery('')
  }, [hovered])

  // ── Cmd+F / Ctrl+F 快捷键：打开面板并聚焦搜索 ──

  const handleShortcutOpen = React.useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = undefined }
    setIsLeaving(false)
    setHovered(true)
  }, [])

  useShortcut('file-find', handleShortcutOpen, items.length >= MIN_ITEMS && canScroll)

  // ── 鼠标进出控制（仅迷你地图区域） ──

  /** 鼠标进入后需停留此时间（ms）才展开面板，防止掠过时闪烁 */
  const OPEN_DELAY = 180

  const handleMouseEnter = (): void => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)

    // 面板已打开则无需重复触发
    if (hovered) return

    // 延迟打开：鼠标需在触发条上停留足够时间
    if (!openTimerRef.current) {
      openTimerRef.current = setTimeout(() => {
        setHovered(true)
        openTimerRef.current = undefined
      }, OPEN_DELAY)
    }
  }

  const handleMouseLeave = (): void => {
    // 尚未打开就离开了 → 取消打开定时器
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = undefined
    }

    if (!hovered) return

    closeTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setHovered(false)
        setIsLeaving(false)
      }, 80)
    }, 40)
  }

  // ── 跳转到指定消息（直接操作 scrollTop，绕过 scrollIntoView） ──

  const scrollToMessage = React.useCallback((id: string) => {
    const el = scrollRef.current
    if (!el) return
    const target = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.getAttribute('data-message-id') === id
    )
    if (!target) return

    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0

    const offsetTop = getOffsetTopRelativeTo(target, el)
    const targetHeight = target.offsetHeight
    const viewportHeight = el.clientHeight
    const scrollTarget = targetHeight < viewportHeight
      ? offsetTop - (viewportHeight - targetHeight) / 2
      : offsetTop - 32
    el.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' })

    setHovered(false)
  }, [scrollRef, stopScroll, stickyState])

  // ── 搜索过滤 ──

  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((item) => item.preview.toLowerCase().includes(q))
  }, [items, searchQuery])

  /** 列表居中锚点：优先用主区视口中心对应的消息；该消息被搜索过滤掉时退回第一条可见消息 */
  const anchorId = React.useMemo(() => {
    if (centerVisibleId && filteredItems.some((item) => item.id === centerVisibleId)) {
      return centerVisibleId
    }
    return filteredItems.find((item) => visibleIds.has(item.id))?.id
  }, [centerVisibleId, filteredItems, visibleIds])

  if (items.length < MIN_ITEMS || !canScroll) return null

  // ── 迷你地图条纹 ──

  const barCount = Math.min(items.length, MAX_BARS)

  return (
    <div className="absolute bottom-0 left-3 top-0 z-30 flex pointer-events-none">
      {/* ── 迷你地图悬停区域（面板 + 横杠） ── */}
      <div className="flex h-full flex-row-reverse items-start">
        {/* 展开面板 */}
        {hovered && (
          <div
            className={cn(
              'ml-2 flex w-[280px] origin-top-left flex-col overflow-hidden rounded-lg border bg-popover shadow-xl pointer-events-auto',
              isLeaving
                ? 'animate-out fade-out-0 zoom-out-95 duration-75'
                : 'animate-in fade-in-0 zoom-in-95 duration-150'
            )}
            style={{ maxHeight: 'min(420px, 60vh)', marginTop: 12 }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
              <span className="text-xs font-medium text-popover-foreground/70">消息导航</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {visibleIds.size}/{items.length}
              </span>
            </div>

            {/* 搜索框 */}
            <div className="px-2 py-1.5 border-b shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
                <Input
                  ref={searchInputRef}
                  placeholder="搜索消息..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => {
                    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
                    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
                    setIsLeaving(false)
                  }}
                  className="h-7 text-xs pl-7 focus-visible:!border-border/60 focus-visible:!ring-0 focus-visible:!shadow-xs"
                />
              </div>
            </div>

            {/* 消息列表 */}
            <div ref={listRef} className="overflow-y-auto flex-1 p-1.5 space-y-0.5 scrollbar-thin">
              {filteredItems.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  未找到匹配消息
                </div>
              ) : (
                filteredItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-minimap-visible={item.id === anchorId ? 'true' : undefined}
                    className={cn(
                      'flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
                      visibleIds.has(item.id) && 'bg-accent/50'
                    )}
                    onClick={() => scrollToMessage(item.id)}
                  >
                    <ItemIcon item={item} />
                    <div className="max-h-12 min-w-0 flex-1 overflow-hidden">
                      <HighlightedPreview text={item.preview} query={searchQuery} />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* ── 迷你地图横杠 —— 只有这里触发面板展开 ── */}
        <div
          className="relative mt-3 flex-shrink-0 pointer-events-auto"
          style={{ width: 24, height: barCount * MINIMAP_BAR_SPACING }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {Array.from({ length: barCount }, (_, i) => {
            const start = Math.floor((i * items.length) / barCount)
            const end = Math.floor(((i + 1) * items.length) / barCount)
            const group = items.slice(start, end)
            const isVisible = group.some((it) => visibleIds.has(it.id))
            const hasUser = group.some((it) => it.role === 'user')
            const top = ((i + 0.5) / barCount) * 100
            return (
              <div
                key={i}
                className={cn(
                  'absolute left-1 h-[2px] w-[20px] rounded-full transition-colors',
                  isVisible
                    ? 'bg-primary dark:bg-primary/70 minimap-visible-indicator'
                    : hasUser
                      ? 'bg-primary/25 dark:bg-primary/15'
                      : 'bg-primary/40 dark:bg-primary/25'
                )}
                style={{ top: `${top}%` }}
              />
            )
          })}
        </div>
      </div>

    </div>
  )
}

// ── 子组件 ──

function ItemIcon({ item }: { item: MinimapItem }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (item.role === 'user' && item.avatar) {
    return <UserAvatar avatar={item.avatar} size={16} className="mt-0.5" />
  }
  if ((item.role === 'assistant') && item.model) {
    return (
      <img
        src={getModelLogo(item.model, resolveModelProvider(item.model, channels))}
        alt=""
        className="size-4 shrink-0 mt-0.5 rounded-[20%] object-cover"
      />
    )
  }
  if (item.role === 'status') {
    return <AlertTriangle className="size-4 shrink-0 mt-0.5 text-destructive" />
  }
  return <div className="size-4 shrink-0 mt-0.5 rounded-[20%] bg-muted" />
}

/** Markdown 预览（无搜索时）或 纯文本+高亮（搜索时） */
function HighlightedPreview({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!text) {
    return <span className="text-xs opacity-40">(空消息)</span>
  }

  if (query.trim()) {
    const escaped = escapeRegExp(query)
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
    return (
      <span className="text-xs text-popover-foreground/80 line-clamp-3">
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase()
            ? <mark key={i} className="bg-primary/20 text-primary rounded-sm px-0.5">{part}</mark>
            : part
        )}
      </span>
    )
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-popover-foreground/80 prose-p:my-0 prose-headings:my-0.5 prose-headings:text-xs prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-3 overflow-hidden">
      <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} components={PREVIEW_MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}
