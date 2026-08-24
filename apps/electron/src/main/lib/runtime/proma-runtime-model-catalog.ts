/**
 * Proma Runtime 模型目录。
 *
 * Runtime 不再连接另一套产品模型中心，目录直接投影 Proma 的 Channels。
 * 这里仅返回模型元数据和可用性摘要，不把明文凭证写入目录或发送到渲染进程。
 */

import type {
  ModelCenterModel,
  ModelCenterStatus,
} from '@proma/shared'
import { listChannels, resolveChannelRuntimeApiKey } from '../channel-manager'
import { resolvePromaRuntimeApiMode } from './proma-runtime-api-mode'

async function hasUsableCredential(channelId: string): Promise<boolean> {
  try {
    return Boolean((await resolveChannelRuntimeApiKey(channelId)).trim())
  } catch {
    return false
  }
}

export async function getPromaRuntimeModelCatalogStatus(): Promise<ModelCenterStatus> {
  const checkedAt = new Date().toISOString()
  const channels = listChannels()
  const enabledChannels = channels.filter((channel) => channel.enabled)
  if (enabledChannels.length === 0) {
    return {
      configured: channels.length > 0,
      connected: false,
      baseUrl: null,
      models: [],
      usableModelCount: 0,
      checkedAt,
      error: channels.length > 0 ? '没有启用的模型渠道。' : '尚未配置模型渠道。',
    }
  }

  const credentialStates = await Promise.all(
    enabledChannels.map(async (channel) => ({
      channelId: channel.id,
      usable: await hasUsableCredential(channel.id),
    })),
  )
  const usableByChannel = new Map(credentialStates.map((state) => [state.channelId, state.usable]))
  const models: ModelCenterModel[] = enabledChannels.flatMap((channel) => {
    const enabledModels = channel.models.filter((model) => model.enabled)
    if (enabledModels.length === 0) return []
    const modelIds = enabledModels.map((model) => model.id)
    return [{
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      providerKey: channel.provider,
      model: channel.defaultModelId && modelIds.includes(channel.defaultModelId)
        ? channel.defaultModelId
        : modelIds[0]!,
      models: modelIds,
      baseUrl: channel.baseUrl,
      apiMode: resolvePromaRuntimeApiMode(channel.provider),
      hasApiKey: usableByChannel.get(channel.id) === true,
      oauthAccountId: '',
      runtimeRevision: `proma-channel:${channel.id}:${channel.updatedAt}`,
    }]
  })
  const usableModelCount = models.reduce(
    (count, model) => count + (model.hasApiKey ? model.models.length : 0),
    0,
  )

  return {
    configured: true,
    connected: models.length > 0,
    baseUrl: null,
    models,
    usableModelCount,
    checkedAt,
    error: models.length > 0 ? null : '已启用渠道但没有可用模型。',
  }
}
