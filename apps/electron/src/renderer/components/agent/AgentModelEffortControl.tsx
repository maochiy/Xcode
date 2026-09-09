import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, ChevronDown, ChevronLeft, Search } from 'lucide-react'
import type { ModelOption, ThinkingEffortLevel } from '@proma/shared'
import { agentModelSelectorOpenAtom } from '@/atoms/agent-model-control'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { THINKING_EFFORT_LABELS, type AgentThinkingEffortCapability } from '@/lib/agent-thinking-effort'
import { cn } from '@/lib/utils'
import { AgentThinkingEffortControl } from './AgentThinkingEffortControl'

interface AgentModelEffortControlProps {
  models: ModelOption[]
  selectedModel: { channelId: string; modelId: string } | null
  loading: boolean
  modelSwitchDisabled: boolean
  capability: AgentThinkingEffortCapability | null
  effortLevel?: ThinkingEffortLevel
  onModelSelect: (model: ModelOption) => void
  onModelListOpen?: () => void
  onEffortChange: (level: ThinkingEffortLevel) => void
}

/** 输入框只保留一个触发器，模型列表与思考配置共用同一个弹层。 */
export function AgentModelEffortControl({
  models,
  selectedModel,
  loading,
  modelSwitchDisabled,
  capability,
  effortLevel,
  onModelSelect,
  onModelListOpen,
  onEffortChange,
}: AgentModelEffortControlProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [modelListOpen, setModelListOpen] = React.useState(false)
  const [modelListRequested, setModelListRequested] = useAtom(agentModelSelectorOpenAtom)
  const [search, setSearch] = React.useState('')
  const searchRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const refreshedForOpenRef = React.useRef(false)
  const currentModel = models.find(model =>
    model.channelId === selectedModel?.channelId && model.modelId === selectedModel?.modelId,
  ) ?? models.find(model =>
    model.channelId === selectedModel?.channelId
    && model.modelId === selectedModel?.modelId.replace(/\[1m\]$/i, ''),
  )
  const modelName = currentModel?.modelName || selectedModel?.modelId || '选择模型'
  const query = search.trim().toLowerCase()
  const filteredModels = React.useMemo(() => {
    if (!modelListOpen) return []
    if (!query) return models
    return models.filter(model =>
      `${model.modelName} ${model.modelId} ${model.channelName}`.toLowerCase().includes(query),
    )
  }, [modelListOpen, models, query])

  React.useEffect(() => {
    if (!modelListRequested) return
    setOpen(true)
    setModelListOpen(true)
    setModelListRequested(false)
  }, [modelListRequested, setModelListRequested])

  React.useEffect(() => {
    if (modelListOpen) {
      setSearch('')
      searchRef.current?.focus({ preventScroll: true })
      // 在同一弹层内往返只切换视图，不重复拉取配置、重建模型列表。
      if (!refreshedForOpenRef.current) {
        refreshedForOpenRef.current = true
        onModelListOpen?.()
      }
    }
  }, [modelListOpen, onModelListOpen])

  const closePopover = (): void => {
    setOpen(false)
    setModelListOpen(false)
    setSearch('')
    refreshedForOpenRef.current = false
  }

  const handleListKeyDown = (event: React.KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.findIndex(item => item === document.activeElement)
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowUp' ? (currentIndex <= 0 ? items.length : currentIndex) - 1
      : (currentIndex + 1) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={nextOpen => {
        if (nextOpen) setOpen(true)
        else closePopover()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`模型与思考等级：${modelName}${effortLevel ? `，${THINKING_EFFORT_LABELS[effortLevel]}` : ''}`}
          className="flex h-7 min-w-0 max-w-[220px] items-center gap-1 rounded-full bg-foreground/[0.06] px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate text-foreground/85">{modelName}</span>
          {effortLevel && <span className="shrink-0">{THINKING_EFFORT_LABELS[effortLevel]}</span>}
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        aria-label={modelListOpen ? '选择模型' : '模型与思考等级'}
        className="w-64 overflow-hidden rounded-2xl border-0 bg-muted p-0 shadow-[0_8px_32px_rgba(0,0,0,0.18),0_0_0_1px_rgba(128,128,128,0.12)]"
        onOpenAutoFocus={event => {
          if (modelListOpen) {
            event.preventDefault()
            searchRef.current?.focus({ preventScroll: true })
          }
        }}
        onEscapeKeyDown={event => {
          if (modelListOpen) {
            event.preventDefault()
            setOpen(true)
            setModelListOpen(false)
          }
        }}
      >
        {modelListOpen ? (
          <div className="p-2" onKeyDown={handleListKeyDown}>
            <div className="mb-1 flex items-center gap-1 px-1">
              <button
                type="button"
                aria-label="返回思考等级"
                onClick={() => {
                  setOpen(true)
                  setModelListOpen(false)
                }}
                className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors duration-100 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="text-xs text-muted-foreground">选择模型</span>
            </div>
            <div className="mb-1 flex items-center gap-1.5 rounded-lg bg-foreground/[0.04] px-2">
              <Search className="size-3 text-muted-foreground" />
              <input
                ref={searchRef}
                value={search}
                onChange={event => setSearch(event.target.value)}
                aria-label="搜索模型"
                placeholder="搜索模型"
                className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            {modelSwitchDisabled && <p className="px-2 py-1 text-[11px] text-muted-foreground">任务完成后可切换模型</p>}
            <div ref={listRef} className="max-h-[min(280px,50vh)] overflow-y-auto overscroll-contain">
              {filteredModels.map(model => {
                const selected = model === currentModel
                return (
                  <button
                    key={`${model.channelId}:${model.modelId}`}
                    type="button"
                    disabled={modelSwitchDisabled}
                    aria-pressed={selected}
                    onClick={() => {
                      setOpen(true)
                      setModelListOpen(false)
                      setSearch('')
                      if (!selected) onModelSelect(model)
                    }}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
                      !selected && 'enabled:hover:bg-foreground/15 enabled:hover:text-foreground focus-visible:bg-foreground/15',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.modelName}</span>
                    {selected && <Check className="size-3 shrink-0 text-muted-foreground" />}
                  </button>
                )
              })}
              {filteredModels.length === 0 && (
                <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                  {loading ? '加载模型…' : query ? '未找到模型' : '暂无可用模型'}
                </p>
              )}
            </div>
          </div>
        ) : (
          <AgentThinkingEffortControl
            key={`${selectedModel?.channelId}:${selectedModel?.modelId}`}
            capability={capability}
            value={effortLevel}
            modelName={modelName}
            onModelClick={() => setModelListOpen(true)}
            onValueChange={onEffortChange}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
