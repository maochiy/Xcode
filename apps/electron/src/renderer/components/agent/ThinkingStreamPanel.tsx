import * as React from 'react'
import { ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSmoothStream } from '@proma/ui'

const FOLLOW_BOTTOM_THRESHOLD_PX = 24
export const THINKING_STREAM_MIN_DELAY_MS = 0
export const THINKING_STREAM_MAX_CHARS_PER_FRAME = 2
const useClientLayoutEffect = typeof window === 'undefined'
  ? React.useEffect
  : React.useLayoutEffect

interface ThinkingScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function isThinkingScrollNearBottom(
  metrics: ThinkingScrollMetrics,
): boolean {
  return (
    metrics.scrollHeight
    - metrics.scrollTop
    - metrics.clientHeight
  ) <= FOLLOW_BOTTOM_THRESHOLD_PX
}

/** 思考区按连续文本展示，去掉 Provider 分段或 Markdown 空段产生的大块纵向空白。 */
export function normalizeThinkingStreamContent(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*\n+/g, '\n')
}

interface ThinkingStreamPanelProps {
  content: string
  running: boolean
  className?: string
}

/**
 * Cursor 风格思考流：
 * - 固定高度常显，不折叠；
 * - 所有模型返回的 thinking 原文持续追加；
 * - 默认跟随最新内容，用户上滚后暂停自动跟随。
 */
export function ThinkingStreamPanel({
  content,
  running,
  className,
}: ThinkingStreamPanelProps): React.ReactElement | null {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const [followingLatest, setFollowingLatest] = React.useState(true)
  const normalizedContent = normalizeThinkingStreamContent(content)
  const { displayedContent } = useSmoothStream({
    content: normalizedContent,
    isStreaming: running,
    minDelay: THINKING_STREAM_MIN_DELAY_MS,
    maxCharsPerFrame: THINKING_STREAM_MAX_CHARS_PER_FRAME,
  })
  const hasContent = displayedContent.trim().length > 0

  const scrollToLatest = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    setFollowingLatest(true)
  }, [])

  useClientLayoutEffect(() => {
    if (!running || !followingLatest) return
    const viewport = viewportRef.current
    if (!viewport) return

    // 在浏览器绘制前完成滚动，避免每个流式字符先渲染、再滚动造成上下闪跳。
    viewport.scrollTop = viewport.scrollHeight
  }, [displayedContent, followingLatest, running])

  const handleScroll = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    setFollowingLatest(isThinkingScrollNearBottom(viewport))
  }, [])

  if (!running) return null

  return (
    <section
      className={cn('agent-activity-fade-in space-y-1.5', className)}
      data-agent-activity="thinking"
      data-thinking-stream="true"
    >
      <div
        className="agent-status-shimmer agent-thinking-status-shimmer text-[14px] text-muted-foreground whitespace-nowrap"
      >
        正在思考
      </div>
      <div className="relative">
        <div
          ref={viewportRef}
          className={cn(
            'agent-thinking-stream-surface h-36 overflow-y-scroll overscroll-contain',
            '[scrollbar-gutter:stable] [overflow-anchor:none]',
            'px-1 py-2 text-[13px] leading-[1.4] text-muted-foreground scrollbar-thin',
          )}
          data-thinking-scroll-viewport="true"
          onScroll={handleScroll}
          aria-live={running ? 'polite' : undefined}
        >
          {hasContent && (
            <div className="whitespace-pre-wrap break-words font-normal">
              {displayedContent}
            </div>
          )}
        </div>
        <div
          className="agent-thinking-stream-top-fade"
          data-thinking-top-fade="true"
          data-active={hasContent}
          aria-hidden="true"
        />
        {!followingLatest && (
          <button
            type="button"
            className={cn(
              'absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full',
              'bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-md backdrop-blur-sm',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
            )}
            onClick={scrollToLatest}
          >
            <ArrowDown className="size-3" aria-hidden="true" />
            回到最新
          </button>
        )}
      </div>
    </section>
  )
}
