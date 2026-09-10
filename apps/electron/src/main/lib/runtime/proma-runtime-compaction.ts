/**
 * Proma Runtime 模型压缩策略计算（纯函数）。
 *
 * 主会话与后台 Harness（Claude Code / Codex / Pi）共用同一份压缩策略：
 * 按模型配置的 contextWindow（未配置时取默认 200000）计算触发阈值，
 * 默认取窗口的 80%。后台 Harness 的自动压缩事件不进入主会话 UI。
 */

import type { Channel, RuntimeModelRoute } from '@proma/shared'
import { DEFAULT_CONTEXT_WINDOW } from '@proma/shared'
import { resolvePiCompactionPolicy } from '../../../../resources/pi-runtime/workers/pi-compaction-settings.mjs'

/** 默认压缩阈值比例：上下文窗口的 80%。 */
export const DEFAULT_AUTO_COMPACT_RATIO = 0.8

/**
 * 解析模型最终生效的压缩触发占比（0-100 的百分比）。
 *
 * 优先级：模型级 autoCompactRatio → 供应商级 autoCompactRatio → 默认 80%。
 * 返回 0-100 之间的数值（已做边界收敛），未配置时返回 undefined 由调用方用默认值。
 */
export function resolveAutoCompactRatio(
  channel: Channel,
  modelId: string,
): number | undefined {
  const configuredModel = channel.models.find((model) => model.id === modelId)
  const ratio = configuredModel?.autoCompactRatio ?? channel.autoCompactRatio
  if (ratio == null) return undefined
  if (!Number.isFinite(ratio)) return undefined
  return Math.min(100, Math.max(0, ratio))
}

/**
 * 按渠道模型配置计算压缩策略。
 *
 * 触发占比取模型级 → 供应商级 → 默认 80% 的优先级；
 * contextWindow 优先用用户填写值，未填写时取默认 200000。
 */
export function compactionFor(
  channel: Channel,
  modelId: string,
): RuntimeModelRoute['compaction'] {
  const configuredModel = channel.models.find((model) => model.id === modelId)
  const contextWindow = configuredModel?.contextWindow
    ?? DEFAULT_CONTEXT_WINDOW
  if (!contextWindow) return undefined
  const ratio = resolveAutoCompactRatio(channel, modelId) ?? DEFAULT_AUTO_COMPACT_RATIO * 100
  const threshold = Math.round(contextWindow * ratio / 100)
  // 使用 Worker 相同的边界规则：0 沿用默认阈值，100% 至少为摘要预留两个 token。
  return resolvePiCompactionPolicy(contextWindow, { enabled: true, threshold })
}
