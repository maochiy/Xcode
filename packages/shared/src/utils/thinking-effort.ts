import { DEFAULT_THINKING_EFFORT_LEVELS, type ThinkingEffortLevel } from '../types/agent'

/** 旧最大档归并为极高；缺省启用四档，显式空数组和自定义子集保持原意。 */
export function normalizeConfiguredThinkingEffortLevels(
  levels?: readonly ThinkingEffortLevel[],
): ThinkingEffortLevel[] {
  const selected = new Set<ThinkingEffortLevel>((levels ?? DEFAULT_THINKING_EFFORT_LEVELS)
    .map(level => level === 'max' ? 'xhigh' : level))
  return DEFAULT_THINKING_EFFORT_LEVELS.filter(level => selected.has(level))
}
