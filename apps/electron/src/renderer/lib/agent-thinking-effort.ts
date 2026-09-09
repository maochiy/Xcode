import {
  DEFAULT_THINKING_EFFORT_LEVELS,
  type AgentRuntimeModelInfo,
  type ThinkingConfig,
  type ThinkingEffortLevel,
} from '@proma/shared'

export const THINKING_EFFORT_ORDER: readonly ThinkingEffortLevel[] = [
  ...DEFAULT_THINKING_EFFORT_LEVELS,
  'max',
]

export const THINKING_EFFORT_LABELS: Record<ThinkingEffortLevel, string> = {
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '极高',
}

/** 连续拖动位置只在预览档位和最终提交时取整，避免滑块在拖动途中跳格。 */
export function snapThinkingEffortPosition(position: number, levelCount: number): number {
  return Math.max(0, Math.min(Math.max(0, levelCount - 1), Math.round(position)))
}

/** 键盘始终一次切换一档，不沿用指针拖动的细分步长。 */
export function getThinkingEffortKeyIndex(
  key: string,
  index: number,
  levelCount: number,
): number | undefined {
  if (key === 'Home') return 0
  if (key === 'End') return Math.max(0, levelCount - 1)
  if (['ArrowLeft', 'ArrowDown', 'PageDown'].includes(key)) {
    return snapThinkingEffortPosition(index - 1, levelCount)
  }
  if (['ArrowRight', 'ArrowUp', 'PageUp'].includes(key)) {
    return snapThinkingEffortPosition(index + 1, levelCount)
  }
  return undefined
}

/** 输入框合并最高档的展示；保留当前 max 值，避免仅打开面板就改变请求。 */
export function getThinkingEffortSliderLevels(
  levels: readonly ThinkingEffortLevel[],
  value: ThinkingEffortLevel,
): ThinkingEffortLevel[] {
  const highestLevel = value === 'max' && levels.includes('max')
    ? 'max'
    : levels.includes('xhigh') ? 'xhigh' : 'max'
  return THINKING_EFFORT_ORDER.filter(level =>
    levels.includes(level)
    && (level !== 'max' && level !== 'xhigh' || level === highestLevel),
  )
}

export interface AgentThinkingEffortCapability {
  levels: ThinkingEffortLevel[]
  defaultLevel: ThinkingEffortLevel
}

export interface AgentRuntimeThinkingSelection {
  thinkingConfig?: ThinkingConfig
  effortLevel?: ThinkingEffortLevel
}

/** 优先精确匹配；仅在 Runtime 规范化 `[1m]` 后缀时回退到规范化 ID。 */
export function findAgentRuntimeModel(
  models: AgentRuntimeModelInfo[],
  modelId: string | null | undefined,
): AgentRuntimeModelInfo | undefined {
  if (!modelId) return undefined
  const exact = models.find(model => model.value === modelId)
  if (exact) return exact

  const normalizedModelId = modelId.replace(/\[1m\]$/i, '')
  if (normalizedModelId === modelId) return undefined
  return models.find(model => model.value === normalizedModelId)
}

/**
 * Thinking/Effort 能力完全以 Runtime 的模型目录为准。
 *
 * Renderer 不根据 Provider 或模型名称做任何推断；Runtime 不可用或明确不支持时隐藏控件。
 */
export function resolveAgentThinkingEffortCapability(
  modelInfo: AgentRuntimeModelInfo | undefined,
): AgentThinkingEffortCapability | null {
  if (
    !modelInfo
    || !modelInfo.supportsEffort
    || modelInfo.supportedEffortLevels.length === 0
  ) {
    return null
  }

  const levels = [...modelInfo.supportedEffortLevels]
  const defaultLevel =
    modelInfo.defaultEffortLevel
    && levels.includes(modelInfo.defaultEffortLevel)
      ? modelInfo.defaultEffortLevel
      : levels[0]!

  return { levels, defaultLevel }
}

export function normalizeAgentThinkingEffortLevel(
  capability: AgentThinkingEffortCapability | null,
  value: ThinkingEffortLevel | undefined,
): ThinkingEffortLevel | undefined {
  if (!capability) return undefined
  if (value === 'max' && capability.levels.includes('xhigh')) return 'xhigh'
  return value && capability.levels.includes(value)
    ? value
    : capability.defaultLevel
}

/** 只把模型目录声明支持的 Thinking/Effort 配置发送给 Runtime。 */
export function resolveAgentRuntimeThinkingSelection(
  modelInfo: AgentRuntimeModelInfo | undefined,
  thinkingConfig: ThinkingConfig | undefined,
  effortLevel: ThinkingEffortLevel | undefined,
): AgentRuntimeThinkingSelection {
  const capability = resolveAgentThinkingEffortCapability(modelInfo)
  return {
    thinkingConfig: modelInfo?.supportsAdaptiveThinking
      ? thinkingConfig
      : undefined,
    effortLevel: normalizeAgentThinkingEffortLevel(capability, effortLevel),
  }
}
