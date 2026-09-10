import {
  normalizeConfiguredThinkingEffortLevels,
  type AgentRuntimeModelCatalog,
  type Channel,
} from '@proma/shared'
import { buildCcbProviderConfiguration } from './provider-environment'
import { buildFallbackModelCatalog } from './model-catalog-fallback'
import { compactionFor } from '../runtime/proma-runtime-compaction'

/**
 * 直接由当前渠道配置构建 Pi 模型目录。
 *
 * provider-environment 的通用渠道映射继续复用，但这里只读取本地模型元数据，
 * 不解析凭证、不访问 Provider，也不会启动其它内核。
 */
export function buildChannelModelCatalog(
  channel: Channel,
  defaultModel?: string,
  includeDisabledModels = false,
): AgentRuntimeModelCatalog {
  const providerConfiguration = buildCcbProviderConfiguration(
    channel,
    defaultModel,
    { includeDisabledModels },
  )
  const catalog = buildFallbackModelCatalog(channel.id, {
    ...providerConfiguration,
    models: providerConfiguration.models.map(model => ({
      ...model,
      effortLevels: normalizeConfiguredThinkingEffortLevels(model.effortLevels),
    })),
  })
  // 正常 Pi 目录与执行路由共用策略；不能沿用故障降级目录的“压缩关闭”和推测窗口。
  const policies = catalog.models.map(model => {
    const compaction = compactionFor(channel, model.value)
    if (!compaction?.contextWindow || compaction.threshold === undefined) {
      throw new Error(`模型「${model.value}」的上下文压缩配置无效`)
    }
    return {
      model: model.value,
      contextWindow: compaction.contextWindow,
      effectiveContextWindow: compaction.contextWindow,
      autoCompactThreshold: compaction.threshold,
    }
  })
  return {
    ...catalog,
    models: catalog.models.map((model, index) => ({
      ...model,
      contextWindow: policies[index]!.contextWindow,
    })),
    contextPolicy: {
      autoCompactEnabled: true,
      models: policies,
    },
  }
}
