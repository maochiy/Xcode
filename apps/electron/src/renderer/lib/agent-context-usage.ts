import type {
  AgentRuntimeContextPolicy,
  AgentRuntimeModelCatalog,
  SDKMessage,
} from '@proma/shared'
import type { AgentContextStatus } from '../atoms/agent-atoms'

export interface RestoredAgentContextUsage {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** 会话累计净输入 tokens（不含缓存；对齐 opencode adjusted input 口径） */
  cumulativeInputTokens?: number
  /** 会话累计缓存读取 tokens（用于计算缓存命中率） */
  cumulativeCacheReadTokens?: number
  /** 会话累计缓存写入 tokens */
  cumulativeCacheCreationTokens?: number
  contextWindow?: number
  contextUsageIsEstimated: boolean
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  effectiveContextWindow?: number
}

type ContextUsageSnapshotSource = 'result' | 'assistant' | 'compact'

interface ContextUsageSnapshot {
  value: RestoredAgentContextUsage
  source: ContextUsageSnapshotSource
  createdAt?: number
  index: number
}

/** 按 CCB 规范化后的模型 ID 从轻量 Context Policy 目录读取策略。 */
export function resolveAgentContextPolicy(
  catalog: AgentRuntimeModelCatalog | undefined,
  modelId: string | null | undefined,
): AgentRuntimeContextPolicy | undefined {
  if (!catalog || !modelId) return undefined
  const normalizedModelId = modelId.replace(/\[1m\]$/i, '')
  return catalog.contextPolicy.models.find(
    policy =>
      policy.model === modelId || policy.model === normalizedModelId,
  )
}

/** 活跃轮只显示该轮的执行快照；空闲时展示下一轮选定模型的配置。 */
export function resolveAgentContextStatus(
  status: AgentContextStatus,
  catalog: AgentRuntimeModelCatalog | undefined,
  modelId: string | null | undefined,
  active: boolean,
): AgentContextStatus {
  if (active) return status
  const policy = resolveAgentContextPolicy(catalog, modelId)
  if (!policy) return status
  return {
    ...status,
    contextWindow: policy.contextWindow,
    autoCompactEnabled: catalog!.contextPolicy.autoCompactEnabled,
    autoCompactThreshold: policy.autoCompactThreshold,
    effectiveContextWindow: policy.effectiveContextWindow,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function readUsage(value: unknown): Omit<RestoredAgentContextUsage, 'contextUsageIsEstimated'> | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const directInput = numberValue(usage.input_tokens)
  if (directInput == null) return undefined
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens) ?? 0
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens) ?? 0
  return {
    inputTokens: directInput + cacheReadTokens + cacheCreationTokens,
    outputTokens: numberValue(usage.output_tokens),
    cacheReadTokens,
    cacheCreationTokens,
  }
}

function readContextWindow(value: unknown): number | undefined {
  const usageByModel = asRecord(value)
  if (!usageByModel) return undefined
  let contextWindow: number | undefined
  for (const modelUsage of Object.values(usageByModel)) {
    const candidate = numberValue(asRecord(modelUsage)?.contextWindow)
    if (candidate == null) continue
    contextWindow = Math.max(contextWindow ?? 0, candidate)
  }
  return contextWindow
}

function sourcePriority(source: ContextUsageSnapshotSource): number {
  switch (source) {
    case 'compact':
      return 3
    case 'assistant':
      return 2
    case 'result':
      return 1
  }
}

function shouldReplaceSnapshot(
  current: ContextUsageSnapshot | undefined,
  candidate: ContextUsageSnapshot,
): boolean {
  if (!current) return true

  if (candidate.createdAt != null || current.createdAt != null) {
    if (candidate.createdAt == null) return false
    if (current.createdAt == null) return true
    if (candidate.createdAt !== current.createdAt) {
      return candidate.createdAt > current.createdAt
    }

    const candidatePriority = sourcePriority(candidate.source)
    const currentPriority = sourcePriority(current.source)
    if (candidatePriority !== currentPriority) {
      return candidatePriority > currentPriority
    }
  }

  return candidate.index > current.index
}

/**
 * 从 Proma 本地 SDKMessage 投影恢复最近一次上下文用量。
 *
 * 这只用于圆环冷启动水合，不参与 CCB 的模型上下文恢复。真正的执行上下文仍由
 * runtimeSessionId 对应的 CCB Transcript 通过 session.resume 加载。
 */
export function derivePersistedAgentContextUsage(
  messages: SDKMessage[],
): RestoredAgentContextUsage | undefined {
  let snapshot: ContextUsageSnapshot | undefined
  let contextWindow: number | undefined
  let autoCompactEnabled: boolean | undefined
  let autoCompactThreshold: number | undefined
  let effectiveContextWindow: number | undefined
  let hasAssistantUsageInTurn = false
  let compactResultPending = false
  // 会话累计（缓存命中率），对齐 opencode adjusted input 口径
  let cumulativeInputTokens = 0
  let cumulativeCacheReadTokens = 0
  let cumulativeCacheCreationTokens = 0

  const accumulateUsage = (usage: { inputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }): void => {
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheCreation = usage.cacheCreationTokens ?? 0
    cumulativeCacheReadTokens += cacheRead
    cumulativeCacheCreationTokens += cacheCreation
    cumulativeInputTokens += Math.max(0, usage.inputTokens - cacheRead - cacheCreation)
  }

  for (const [index, message] of messages.entries()) {
    const record = asRecord(message)
    if (!record) continue
    const createdAt = numberValue(record._createdAt)

    if (record.type === 'user' && record.parent_tool_use_id == null) {
      hasAssistantUsageInTurn = false
      continue
    }

    if (record.type === 'system' && record.subtype === 'context_compaction_config') {
      const restoredThreshold = numberValue(record.autoCompactThreshold)
      const restoredEffectiveWindow = numberValue(record.effectiveContextWindow)
      if (
        typeof record.autoCompactEnabled === 'boolean'
        && restoredThreshold != null
        && restoredEffectiveWindow != null
      ) {
        autoCompactEnabled = record.autoCompactEnabled
        autoCompactThreshold = restoredThreshold
        effectiveContextWindow = restoredEffectiveWindow
      }
      continue
    }

    if (record.type === 'assistant' && record.parent_tool_use_id == null) {
      const usage = readUsage(asRecord(record.message)?.usage)
      if (!usage || usage.inputTokens <= 0) continue
      accumulateUsage(usage)
      const candidate: ContextUsageSnapshot = {
        value: {
          ...usage,
          contextUsageIsEstimated: false,
        },
        source: 'assistant',
        createdAt,
        index,
      }
      if (shouldReplaceSnapshot(snapshot, candidate)) snapshot = candidate
      hasAssistantUsageInTurn = true
      compactResultPending = false
      continue
    }

    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const metadata = asRecord(record.compact_metadata)
      const postTokens =
        numberValue(record.compactionEstimatedTokensAfter)
        ?? numberValue(metadata?.post_tokens)
      if (postTokens != null && postTokens > 0) {
        const candidate: ContextUsageSnapshot = {
          value: {
            inputTokens: postTokens,
            contextUsageIsEstimated: true,
          },
          source: 'compact',
          createdAt,
          index,
        }
        if (shouldReplaceSnapshot(snapshot, candidate)) snapshot = candidate
      }
      compactResultPending = true
      hasAssistantUsageInTurn = false
      continue
    }

    if (record.type !== 'result') continue

    const reportedWindow = readContextWindow(record.modelUsage)
    if (reportedWindow != null) {
      contextWindow = Math.max(contextWindow ?? 0, reportedWindow)
    }

    const isCompactionResult =
      compactResultPending || record.isSyntheticCompactionResult === true
    compactResultPending = false
    if (isCompactionResult || hasAssistantUsageInTurn) {
      hasAssistantUsageInTurn = false
      continue
    }

    const usage = readUsage(record.usage)
    if (usage && usage.inputTokens > 0) {
      accumulateUsage(usage)
      const candidate: ContextUsageSnapshot = {
        value: {
          ...usage,
          contextUsageIsEstimated: false,
        },
        source: 'result',
        createdAt,
        index,
      }
      if (shouldReplaceSnapshot(snapshot, candidate)) snapshot = candidate
    }
    hasAssistantUsageInTurn = false
  }

  if (!snapshot) return undefined
  return {
    ...snapshot.value,
    cumulativeInputTokens,
    cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens,
    contextWindow,
    ...(autoCompactEnabled !== undefined && { autoCompactEnabled }),
    ...(autoCompactThreshold !== undefined && { autoCompactThreshold }),
    ...(effectiveContextWindow !== undefined && { effectiveContextWindow }),
  }
}
