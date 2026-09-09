import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import type { ThinkingEffortLevel } from '@proma/shared'
import {
  getThinkingEffortKeyIndex,
  snapThinkingEffortPosition,
  THINKING_EFFORT_LABELS,
} from '@/lib/agent-thinking-effort'
import { cn } from '@/lib/utils'

interface ThinkingEffortSliderProps {
  levels: readonly ThinkingEffortLevel[]
  value: number
  onPreviewChange: (index: number) => void
  onValueCommit: (index: number) => void
}

/** 连续位置只在滑杆内更新；预览按档位变化，松手后才提交等级。 */
export function ThinkingEffortSlider({
  levels,
  value,
  onPreviewChange,
  onValueCommit,
}: ThinkingEffortSliderProps): React.ReactElement {
  const [position, setPosition] = React.useState(value)
  const [dragging, setDragging] = React.useState(false)
  const [hasInteracted, setHasInteracted] = React.useState(false)
  const pointerDownRef = React.useRef(false)
  const committedIndexRef = React.useRef(value)
  const previewIndex = snapThinkingEffortPosition(position, levels.length)
  const previewLevel = levels[previewIndex]
  const disabled = levels.length <= 1
  const animatePosition = hasInteracted && !dragging

  React.useEffect(() => {
    committedIndexRef.current = value
    setPosition(value)
  }, [value])

  const commitPosition = (nextPosition: number): void => {
    const index = snapThinkingEffortPosition(nextPosition, levels.length)
    setPosition(index)
    onPreviewChange(index)
    if (index === committedIndexRef.current) return
    committedIndexRef.current = index
    onValueCommit(index)
  }

  return (
    <SliderPrimitive.Root
      value={[Math.min(position, Math.max(0, levels.length - 1))]}
      min={0}
      max={Math.max(1, levels.length - 1)}
      step={0.001}
      disabled={disabled}
      onValueChange={([nextPosition]) => {
        if (nextPosition === undefined) return
        setPosition(nextPosition)
        onPreviewChange(snapThinkingEffortPosition(nextPosition, levels.length))
      }}
      onValueCommit={([nextPosition]) => {
        if (nextPosition !== undefined) commitPosition(nextPosition)
      }}
      onPointerDown={() => {
        if (disabled) return
        pointerDownRef.current = true
        setHasInteracted(true)
      }}
      onPointerMove={() => {
        if (pointerDownRef.current) setDragging(true)
      }}
      onPointerUp={() => {
        pointerDownRef.current = false
        setDragging(false)
      }}
      onPointerCancel={() => {
        pointerDownRef.current = false
        setDragging(false)
        setPosition(committedIndexRef.current)
        onPreviewChange(committedIndexRef.current)
      }}
      onKeyDown={event => {
        if (disabled) return
        const index = getThinkingEffortKeyIndex(event.key, previewIndex, levels.length)
        if (index === undefined) return
        event.preventDefault()
        setHasInteracted(true)
        commitPosition(index)
      }}
      data-dragging={dragging}
      className={cn(
        'relative flex h-8 w-full touch-none select-none items-center',
        // Radix 初始化时会校准 Thumb 位置；交互后才启用过渡，避免打开时从最低档滑入。
        animatePosition && 'motion-safe:[&>span:has(>[role=slider])]:transition-[left] motion-safe:[&>span:has(>[role=slider])]:duration-150 motion-safe:[&>span:has(>[role=slider])]:ease-out',
      )}
    >
      <SliderPrimitive.Track className="relative h-6 w-full grow overflow-hidden rounded-full bg-foreground/15">
        <SliderPrimitive.Range className={cn(
          'absolute h-full bg-[#3A83F7]',
          animatePosition && 'motion-safe:transition-[left,right] motion-safe:duration-150 motion-safe:ease-out',
        )} />
        <span className="pointer-events-none absolute inset-x-4 top-1/2 flex -translate-y-1/2 justify-between">
          {levels.map((level, index) => (
            <span key={level} className={cn(
              'size-1 rounded-full',
              index <= previewIndex ? 'bg-white/60' : 'bg-foreground/25',
            )} />
          ))}
        </span>
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label="思考等级"
        aria-valuenow={previewIndex}
        aria-valuetext={previewLevel ? THINKING_EFFORT_LABELS[previewLevel] : undefined}
        className="block size-8 rounded-full bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
    </SliderPrimitive.Root>
  )
}
