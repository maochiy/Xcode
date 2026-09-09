import type {
  Channel,
  RuntimeCapability,
  RuntimeModelRoute,
} from '@proma/shared'
import { compactionFor } from './proma-runtime-compaction'
import { resolvePromaRuntimeApiMode } from './proma-runtime-api-mode'
import { EXECUTABLE_RUNTIME_ID } from './pi-runtime-policy'

export function buildPromaRuntimeModelRoute(input: {
  channel: Channel
  modelId: string
  capabilities?: Partial<Record<RuntimeCapability, 'supported' | 'partial' | 'unsupported' | 'unknown'>>
}): RuntimeModelRoute {
  const { channel, modelId } = input
  return {
    routeRevision: `proma-channel:${channel.id}:${channel.updatedAt}:${modelId}`,
    runtimeId: EXECUTABLE_RUNTIME_ID,
    channelId: channel.id,
    modelId,
    // provider 是协议的唯一来源；禁止根据 modelId、Base URL 或凭证内容推断。
    provider: channel.provider,
    baseUrl: channel.baseUrl.trim(),
    apiMode: resolvePromaRuntimeApiMode(channel.provider),
    credentialRevision: `credential:${channel.id}:${channel.updatedAt}`,
    capabilities: input.capabilities || {},
    source: 'proma-channel',
    compaction: compactionFor(channel, modelId),
  }
}
