import { createHash } from 'node:crypto'
import type {
  AgentRuntimeModelCatalog,
  AgentRuntimeModelCatalogDraftInput,
  Channel,
} from '@proma/shared'
import { CCB_NATIVE_CHANNEL_ID } from '@proma/shared'
import { getChannelById } from '../channel-manager'
import { getAgentWorkspace } from '../agent-workspace-manager'
import { createLegacyCcbUnsupportedError } from './legacy-ccb-api'
import { buildChannelModelCatalog } from './pi-model-catalog'

interface CachedModelCatalog {
  fingerprint: string
  catalog: AgentRuntimeModelCatalog
}

const catalogCache = new Map<string, CachedModelCatalog>()
let draftCatalogCache: CachedModelCatalog | undefined

function hashChannelCatalog(
  channel: Channel,
  defaultModel?: string,
  includeDisabledModels = false,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      channelId: channel.id,
      updatedAt: channel.updatedAt,
      provider: channel.provider,
      defaultModel,
      models: channel.models,
      autoCompactRatio: channel.autoCompactRatio,
      includeDisabledModels,
    }))
    .digest('hex')
}

/** 读取当前 Channel 的 Pi 模型目录。workspaceId 只用于校验当前项目来源。 */
export async function resolveAgentRuntimeModelCatalog(
  channelId: string,
  defaultModel?: string,
  workspaceId?: string,
): Promise<AgentRuntimeModelCatalog> {
  if (channelId === CCB_NATIVE_CHANNEL_ID) {
    throw createLegacyCcbUnsupportedError('原生模型配置')
  }
  if (workspaceId && !getAgentWorkspace(workspaceId)) {
    throw new Error('项目不存在，请重新选择项目')
  }

  const channel = getChannelById(channelId)
  if (!channel || !channel.enabled) {
    throw new Error('Xcodes Agent 渠道不存在或已禁用')
  }

  const fingerprint = hashChannelCatalog(channel, defaultModel)
  const cached = catalogCache.get(channelId)
  if (cached?.fingerprint === fingerprint) return cached.catalog

  const catalog = buildChannelModelCatalog(channel, defaultModel)
  catalogCache.set(channelId, { fingerprint, catalog })
  return catalog
}

/** 直接由尚未保存的渠道草稿构建 Pi 模型目录。 */
export async function resolveDraftAgentRuntimeModelCatalog(
  input: AgentRuntimeModelCatalogDraftInput,
): Promise<AgentRuntimeModelCatalog> {
  if (input.models.length === 0) {
    throw new Error('请先添加至少一个模型')
  }

  const channel: Channel = {
    id: '__draft__',
    name: '临时模型配置',
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKey: '',
    models: input.models,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const fingerprint = hashChannelCatalog(channel, input.defaultModel, true)
  if (draftCatalogCache?.fingerprint === fingerprint) {
    return draftCatalogCache.catalog
  }

  const catalog = buildChannelModelCatalog(channel, input.defaultModel, true)
  draftCatalogCache = { fingerprint, catalog }
  return catalog
}

export function clearAgentRuntimeModelCatalogCache(channelId?: string): void {
  if (channelId) {
    catalogCache.delete(channelId)
    return
  }
  catalogCache.clear()
  draftCatalogCache = undefined
}
