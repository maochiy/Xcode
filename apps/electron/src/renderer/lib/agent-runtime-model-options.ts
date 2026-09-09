import {
  CCB_NATIVE_CHANNEL_ID,
  type AgentRuntimeModelCatalog,
  type Channel,
  type ModelOption,
} from '@proma/shared'
import { findAgentRuntimeModel } from '@/lib/agent-thinking-effort'

/**
 * 将 Pi 会话模型下拉限制为 App 侧已启用渠道中的已启用模型。
 *
 * 模型 Provider 与 API 协议保持渠道原值；这里只移除旧 Runtime 自带的
 * CCB_NATIVE 模型入口，不会把 OpenAI、Anthropic 等 Provider 当作内核过滤。
 */
export function buildAgentAppModelOptions(input: {
  channelId: string | null | undefined
  catalog?: AgentRuntimeModelCatalog
  channels: readonly Channel[]
}): ModelOption[] {
  const channelId = input.channelId
  if (!channelId || channelId === CCB_NATIVE_CHANNEL_ID) return []

  const channel = input.channels.find(item => item.id === channelId)
  if (!channel?.enabled) return []

  const enabledModels = channel.models.filter(model => model.enabled)
  if (enabledModels.length === 0) return []
  const runtimeModels = input.catalog?.channelId === channel.id
    ? input.catalog.models
    : []

  return enabledModels.map(model => {
    const runtimeModel = findAgentRuntimeModel(
      runtimeModels,
      model.id,
    )
    return {
      channelId: channel.id,
      channelName: channel.name,
      modelId: model.id,
      modelName: model.name || runtimeModel?.displayName || model.id,
      provider: channel.provider,
      thinkingEffortLevels:
        model.thinkingEffortLevels ?? runtimeModel?.supportedEffortLevels,
      defaultThinkingEffortLevel:
        model.defaultThinkingEffortLevel ?? runtimeModel?.defaultEffortLevel,
      ...(runtimeModel ? { runtimeModelInfo: runtimeModel } : {}),
    }
  })
}

/** App 会话不应把 CLI 共用配置当作有效 Agent 渠道。 */
export function resolveAppAgentChannelId(
  channelId: string | null | undefined,
): string | null {
  if (!channelId || channelId === CCB_NATIVE_CHANNEL_ID) return null
  return channelId
}
