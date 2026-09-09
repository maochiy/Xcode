import * as React from 'react'
import { DEFAULT_THINKING_EFFORT_LEVELS, normalizeConfiguredThinkingEffortLevels } from '@proma/shared'
import type {
  AgentRuntimeModelInfo,
  ThinkingEffortLevel,
} from '@proma/shared'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { THINKING_EFFORT_LABELS } from '@/lib/agent-thinking-effort'

export interface CcbConfiguredModelEditorValue {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  /** 模型级上下文自动压缩触发占比（0-100，百分比）；未配置时回退供应商级。 */
  autoCompactRatio?: number
  effortLevels?: ThinkingEffortLevel[]
}

interface CcbConfiguredModelEditorProps {
  value: CcbConfiguredModelEditorValue
  onChange: (patch: Partial<CcbConfiguredModelEditorValue>) => void
  runtimeModel?: AgentRuntimeModelInfo
  idError?: string
}

export function CcbConfiguredModelEditor({
  value,
  onChange,
  runtimeModel,
  idError,
}: CcbConfiguredModelEditorProps): React.ReactElement {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <ModelField label="模型 ID" required error={idError}>
          <Input
            value={value.id}
            onChange={event => onChange({ id: event.target.value })}
            placeholder="例如 gpt-5.6-sol"
            aria-invalid={Boolean(idError)}
          />
        </ModelField>
        <ModelField label="显示名称">
          <Input
            value={value.name ?? ''}
            onChange={event => onChange({ name: event.target.value })}
            placeholder={runtimeModel?.displayName || '模型选择器中显示的名称'}
          />
        </ModelField>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_220px]">
        <ModelField label="描述">
          <Textarea
            value={value.description ?? ''}
            onChange={event => onChange({ description: event.target.value })}
            placeholder={runtimeModel?.description || '可选的模型说明'}
            className="min-h-20 resize-y"
          />
        </ModelField>
        <ModelField
          label="Context Window"
          description="Token 数，留空使用内核默认值"
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={value.contextWindow ?? ''}
            onChange={event => {
              const raw = event.target.value.trim()
              onChange({ contextWindow: raw ? Number(raw) : undefined })
            }}
            placeholder={
              runtimeModel?.contextWindow
                ? `默认：${runtimeModel.contextWindow.toLocaleString()}`
                : '例如 200000'
            }
          />
        </ModelField>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_220px]">
        <div className="md:col-span-2">
          <div className="mb-2 text-xs font-medium">上下文自动压缩</div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            达到上下文窗口的该比例时自动压缩。留空表示使用供应商级配置；都不配置时默认 80%。
          </p>
        </div>
        <ModelField
          label="压缩触发占比"
          description="百分比，0-100；留空由供应商级或默认 80% 兜底"
        >
          <Input
            type="number"
            min={0}
            max={100}
            step={5}
            value={value.autoCompactRatio ?? ''}
            onChange={event => {
              const raw = event.target.value.trim()
              onChange({ autoCompactRatio: raw ? Number(raw) : undefined })
            }}
            placeholder="默认 80%"
          />
        </ModelField>
      </div>

      <EffortLevelEditor
        value={value.effortLevels}
        onChange={effortLevels => onChange({ effortLevels })}
      />

    </div>
  )
}

interface ModelFieldProps {
  label: string
  description?: string
  required?: boolean
  error?: string
  children: React.ReactNode
}

function ModelField({
  label,
  description,
  required,
  error,
  children,
}: ModelFieldProps): React.ReactElement {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-medium">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {description && (
        <span className="block text-[11px] text-muted-foreground">{description}</span>
      )}
      {children}
      {error && (
        <span className="block text-[11px] text-destructive">{error}</span>
      )}
    </label>
  )
}

interface EffortLevelEditorProps {
  value?: ThinkingEffortLevel[]
  onChange: (value: ThinkingEffortLevel[]) => void
}

function EffortLevelEditor({
  value,
  onChange,
}: EffortLevelEditorProps): React.ReactElement {
  const selectedLevels = normalizeConfiguredThinkingEffortLevels(value)

  const toggleLevel = (level: ThinkingEffortLevel): void => {
    onChange(
      selectedLevels.includes(level)
        ? selectedLevels.filter(item => item !== level)
        : [...selectedLevels, level],
    )
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-xs font-medium">思考等级</p>
        <p className="text-[11px] text-muted-foreground">
          默认勾选全部思考等级，可按需取消；全部取消表示该模型不支持思考等级
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {DEFAULT_THINKING_EFFORT_LEVELS.map(level => {
          const selected = selectedLevels.includes(level)
          return (
            <button
              key={level}
              type="button"
              aria-pressed={selected}
              onClick={() => toggleLevel(level)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs transition-colors',
                selected
                  ? 'bg-primary/15 font-medium text-primary ring-1 ring-primary/25'
                  : 'bg-muted/65 text-muted-foreground hover:text-foreground',
              )}
            >
              {THINKING_EFFORT_LABELS[level]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
