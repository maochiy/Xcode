import * as React from 'react'
import { ChevronRight, RotateCcw, Zap } from 'lucide-react'
import type { ThinkingEffortLevel } from '@proma/shared'
import {
  getThinkingEffortSliderLevels,
  THINKING_EFFORT_LABELS,
  type AgentThinkingEffortCapability,
} from '@/lib/agent-thinking-effort'
import { ThinkingEffortSlider } from './ThinkingEffortSlider'

interface AgentThinkingEffortControlProps {
  capability: AgentThinkingEffortCapability | null
  value?: ThinkingEffortLevel
  modelName: string
  onModelClick: () => void
  onValueChange: (value: ThinkingEffortLevel) => void
}

/** 模型选择弹层的思考等级页；打开模型列表后可原位返回。 */
export function AgentThinkingEffortControl({
  capability,
  value,
  modelName,
  onModelClick,
  onValueChange,
}: AgentThinkingEffortControlProps): React.ReactElement {
  const selectedLevel = value ?? capability?.defaultLevel ?? 'medium'
  const levels = React.useMemo(
    () => getThinkingEffortSliderLevels(capability?.levels ?? [], selectedLevel),
    [capability?.levels, selectedLevel],
  )
  const selectedIndex = Math.max(0, levels.indexOf(selectedLevel))
  const [previewIndex, setPreviewIndex] = React.useState(selectedIndex)

  React.useEffect(() => {
    setPreviewIndex(selectedIndex)
  }, [selectedIndex, selectedLevel])

  const previewLevel = levels[previewIndex] ?? selectedLevel
  const hasEffort = levels.length > 0

  return (
    <div className="p-3">
      <div className="mb-3 grid grid-cols-[28px_minmax(0,1fr)_28px] items-start gap-1">
        <button
          type="button"
          aria-label="快速模式（当前内核暂不支持）"
          aria-disabled="true"
          disabled
          title="当前 Pi 内核暂未接入快速模式"
          className="flex size-7 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground/45"
        >
          <Zap className="size-3.5" />
        </button>
        <button
          type="button"
          autoFocus
          onClick={onModelClick}
          aria-label={`选择模型，当前：${modelName}`}
          className="group flex min-w-0 flex-col items-center rounded-lg px-1 py-0.5 outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center gap-0.5 text-xs font-medium text-[#3A83F7]">
            {hasEffort ? THINKING_EFFORT_LABELS[previewLevel] : '选择模型'}
            <ChevronRight className="size-3 text-muted-foreground" />
          </span>
          <span className="mt-0.5 max-w-full truncate text-xs text-muted-foreground group-hover:text-foreground">
            {modelName}
          </span>
        </button>
        <button
          type="button"
          aria-label="重置思考等级"
          title="恢复默认思考等级"
          disabled={!capability}
          onClick={() => {
            if (!capability) return
            setPreviewIndex(Math.max(0, levels.indexOf(capability.defaultLevel)))
            if (capability.defaultLevel !== selectedLevel) {
              onValueChange(capability.defaultLevel)
            }
          }}
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>
      {hasEffort ? (
        <ThinkingEffortSlider
          levels={levels}
          value={selectedIndex}
          onPreviewChange={setPreviewIndex}
          onValueCommit={index => {
            const level = levels[index]
            if (level) onValueChange(level)
          }}
        />
      ) : (
        <p className="py-1 text-center text-xs text-muted-foreground">该模型未启用思考等级</p>
      )}
    </div>
  )
}
