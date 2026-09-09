import {
  normalizeConfiguredThinkingEffortLevels,
  type AgentRuntimeModelCatalog,
  type Channel,
} from '@proma/shared'
import { buildCcbProviderConfiguration } from './provider-environment'
import { buildFallbackModelCatalog } from './model-catalog-fallback'

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
  return buildFallbackModelCatalog(channel.id, {
    ...providerConfiguration,
    models: providerConfiguration.models.map(model => ({
      ...model,
      effortLevels: normalizeConfiguredThinkingEffortLevels(model.effortLevels),
    })),
  })
}
