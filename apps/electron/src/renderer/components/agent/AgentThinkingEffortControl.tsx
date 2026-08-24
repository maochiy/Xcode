import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { ChevronDown } from 'lucide-react'
import type { ThinkingEffortLevel } from '@proma/shared'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  THINKING_EFFORT_LABELS,
  type AgentThinkingEffortCapability,
} from '@/lib/agent-thinking-effort'

interface AgentThinkingEffortControlProps {
  capability: AgentThinkingEffortCapability
  value: ThinkingEffortLevel
  onValueChange: (value: ThinkingEffortLevel) => void
}

interface CodexEffortSliderProps {
  levels: ThinkingEffortLevel[]
  value: number
  onValueChange: (value: number) => void
  onValueCommit: (value: number) => void
}

const THINKING_EFFORT_SHORT_LABELS: Record<ThinkingEffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '深',
  max: '最高',
}

function CodexEffortSlider({
  levels,
  value,
  onValueChange,
  onValueCommit,
}: CodexEffortSliderProps): React.ReactElement {
  return (
    <SliderPrimitive.Root
      value={[value]}
      min={0}
      max={levels.length - 1}
      step={1}
      aria-label="思考等级"
      onValueChange={([nextValue]) => {
        if (nextValue !== undefined) onValueChange(nextValue)
      }}
      onValueCommit={([nextValue]) => {
        if (nextValue !== undefined) onValueCommit(nextValue)
      }}
      className="relative flex h-7 w-full touch-none select-none items-center"
    >
      <SliderPrimitive.Track className="relative h-7 w-full grow overflow-hidden rounded-full bg-[#e9e9e9] dark:bg-white/10">
        <SliderPrimitive.Range className="absolute h-full bg-primary transition-colors" />
        <span className="pointer-events-none absolute inset-x-3.5 top-1/2 flex -translate-y-1/2 justify-between">
          {levels.map((level, index) => (
            <span
              key={level}
              className={cn(
                'size-1 rounded-full transition-colors',
                index <= value
                  ? 'bg-primary-foreground/90'
                  : 'bg-[#b7b7b7] dark:bg-white/30',
              )}
            />
          ))}
        </span>
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label="思考等级"
        className={cn(
          'block size-7 rounded-full border border-black/[0.06] bg-white',
          'shadow-[0_1px_4px_rgba(0,0,0,0.18)] transition-shadow',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35',
          'active:shadow-[0_1px_5px_rgba(0,0,0,0.24)]',
        )}
      />
    </SliderPrimitive.Root>
  )
}

export function AgentThinkingEffortControl({
  capability,
  value,
  onValueChange,
}: AgentThinkingEffortControlProps): React.ReactElement {
  const selectedIndex = Math.max(0, capability.levels.indexOf(value))
  const [previewIndex, setPreviewIndex] = React.useState(selectedIndex)

  React.useEffect(() => {
    setPreviewIndex(selectedIndex)
  }, [selectedIndex])

  const previewLevel = capability.levels[previewIndex] ?? value

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`思考等级：${THINKING_EFFORT_LABELS[value]}`}
          className={cn(
            'flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
          )}
        >
          <span>{THINKING_EFFORT_SHORT_LABELS[value]}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-56 p-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="mb-3 flex items-center">
          <span className="text-xs font-medium text-foreground/75">
            {THINKING_EFFORT_LABELS[previewLevel]}
          </span>
        </div>

        <div className="py-1">
          <CodexEffortSlider
            levels={capability.levels}
            value={previewIndex}
            onValueChange={setPreviewIndex}
            onValueCommit={(index) => {
              const level = capability.levels[index]
              if (level) onValueChange(level)
            }}
          />
        </div>

      </PopoverContent>
    </Popover>
  )
}
