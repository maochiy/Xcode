import * as React from 'react'
import { ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useStickToBottomContext } from 'use-stick-to-bottom'

export const AGENT_BOTTOM_THRESHOLD_PX = 24
export const AGENT_SCROLL_TO_BOTTOM_DURATION_MS = 260

function getDistanceFromBottom(element: HTMLElement): number {
  return Math.max(
    0,
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** Agent 会话专用的 24px 贴底判断和约 260ms 显式滚底。 */
export function useAgentConversationScroll(): {
  isAtBottom: boolean
  scrollToBottom: () => void
} {
  const context = useStickToBottomContext()
  const [isAtBottom, setIsAtBottom] = React.useState(true)

  React.useEffect(() => {
    const element = context.scrollRef.current
    if (!element) return
    const update = (): void => {
      setIsAtBottom(
        getDistanceFromBottom(element) <= AGENT_BOTTOM_THRESHOLD_PX,
      )
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (context.contentRef.current) observer.observe(context.contentRef.current)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [context.contentRef, context.scrollRef])

  const scrollToBottom = React.useCallback((): void => {
    const element = context.scrollRef.current
    if (!element) return
    const distance = getDistanceFromBottom(element)
    if (
      distance <= AGENT_BOTTOM_THRESHOLD_PX
      || prefersReducedMotion()
    ) {
      void context.scrollToBottom('instant')
      return
    }

    context.stopScroll()
    const start = element.scrollTop
    const target = Math.max(0, element.scrollHeight - element.clientHeight)
    const startedAt = performance.now()
    const tick = (now: number): void => {
      const progress = Math.min(
        1,
        (now - startedAt) / AGENT_SCROLL_TO_BOTTOM_DURATION_MS,
      )
      const eased = 1 - ((1 - progress) ** 3)
      element.scrollTop = start + ((target - start) * eased)
      if (progress < 1) {
        requestAnimationFrame(tick)
      } else {
        void context.scrollToBottom('instant')
      }
    }
    requestAnimationFrame(tick)
  }, [context])

  return { isAtBottom, scrollToBottom }
}

/**
 * use-stick-to-bottom 1.1.2 内部使用 70px near-bottom。
 * Agent 会话按规则收紧到 24px，并且只在用户主动滚动时解除/恢复跟随。
 */
export function AgentConversationScrollController({
  submittedMessageId,
}: { submittedMessageId?: string } = {}): null {
  const context = useStickToBottomContext()
  const userScrollUntilRef = React.useRef(0)
  const lastSubmittedRef = React.useRef(submittedMessageId)
  React.useEffect(() => {
    const previous = lastSubmittedRef.current
    lastSubmittedRef.current = submittedMessageId
    if (submittedMessageId && previous !== submittedMessageId) {
      // 新用户指令主动回到最新；后续模型增量仍尊重用户上翻暂停跟随。
      void context.scrollToBottom('instant')
    }
  }, [context, submittedMessageId])

  React.useEffect(() => {
    const element = context.scrollRef.current
    if (!element) return

    const markUserScroll = (): void => {
      userScrollUntilRef.current = Date.now() + 180
    }
    const enforceThreshold = (): void => {
      if (Date.now() > userScrollUntilRef.current) return
      const distance = getDistanceFromBottom(element)
      if (distance <= AGENT_BOTTOM_THRESHOLD_PX) {
        void context.scrollToBottom('instant')
      } else {
        context.stopScroll()
      }
    }
    const handleScroll = (): void => {
      enforceThreshold()
      window.setTimeout(enforceThreshold, 4)
    }
    const handleWheel = (): void => markUserScroll()
    const handleTouch = (): void => markUserScroll()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (![
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
        'Home',
        'End',
        ' ',
      ].includes(event.key)) return
      markUserScroll()
    }

    element.addEventListener('wheel', handleWheel, { passive: true })
    element.addEventListener('touchstart', handleTouch, { passive: true })
    element.addEventListener('touchmove', handleTouch, { passive: true })
    element.addEventListener('keydown', handleKeyDown)
    element.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      element.removeEventListener('wheel', handleWheel)
      element.removeEventListener('touchstart', handleTouch)
      element.removeEventListener('touchmove', handleTouch)
      element.removeEventListener('keydown', handleKeyDown)
      element.removeEventListener('scroll', handleScroll)
    }
  }, [context])

  return null
}

/** 与主会话和子 Agent 共用跟随规则，不引入第二套滚动状态。 */
export function AgentConversationScrollButton(): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useAgentConversationScroll()
  if (isAtBottom) return null
  return (
    <Button type="button" variant="ghost" size="icon" aria-label="回到最新" title="回到最新"
      className="absolute bottom-3 left-1/2 z-20 size-8 -translate-x-1/2 rounded-full bg-background shadow-sm hover:bg-accent"
      onClick={scrollToBottom}>
      <ArrowDown className="size-4" />
    </Button>
  )
}
