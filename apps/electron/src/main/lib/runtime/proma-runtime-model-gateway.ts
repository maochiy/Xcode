/**
 * Proma Runtime Model Gateway。
 *
 * Runtime 只从这里获得模型路由和凭证，避免 Pi、Hermes、Codex、Claude Code
 * 各自再维护一套模型中心。Gateway 不把明文凭证写入持久化路由。
 */

import type {
  Channel,
  CodexOAuthCredentials,
  RuntimeCapability,
  RuntimeId,
  RuntimeModelRoute,
} from '@proma/shared'
import {
  CCB_NATIVE_CHANNEL_ID,
} from '@proma/shared'
import {
  getChannelById,
  resolveChannelRuntimeApiKey,
  resolveCodexOAuthCredentials,
} from '../channel-manager'
import { buildCcbProviderEnvironment } from '../ccb-runtime/provider-environment'
import { compactionFor } from './proma-runtime-compaction'
import { resolvePromaRuntimeApiMode } from './proma-runtime-api-mode'
import { getPromaUserAgent } from '@proma/core'
import pkg from '../../../../package.json' with { type: 'json' }

export interface RuntimeModelGatewayResolution {
  channel: Channel
  route: RuntimeModelRoute
  apiKey: string
  codexCredentials?: CodexOAuthCredentials
  environment: Record<string, string | undefined>
}

export interface ResolveRuntimeModelRouteInput {
  channelId: string
  modelId?: string
  runtimeId: RuntimeId
  capabilities?: Partial<Record<RuntimeCapability, 'supported' | 'partial' | 'unsupported' | 'unknown'>>
}

function modelFor(channel: Channel, requestedModelId?: string): string {
  const requested = requestedModelId?.trim()
  if (requested && channel.models.some((model) => model.enabled && model.id === requested)) return requested
  const defaultModel = channel.defaultModelId
  if (defaultModel && channel.models.some((model) => model.enabled && model.id === defaultModel)) return defaultModel
  const first = channel.models.find((model) => model.enabled)
  if (!first) throw new Error(`渠道「${channel.name}」没有启用的模型`)
  return first.id
}

function baseUrlFor(channel: Channel): string {
  return channel.baseUrl.trim()
}

export async function resolvePromaRuntimeModelRoute(
  input: ResolveRuntimeModelRouteInput,
): Promise<RuntimeModelGatewayResolution | null> {
  if (!input.channelId || input.channelId === CCB_NATIVE_CHANNEL_ID) return null
  const channel = getChannelById(input.channelId)
  if (!channel) throw new Error(`渠道不存在：${input.channelId}`)
  if (!channel.enabled) throw new Error(`渠道「${channel.name}」已禁用`)
  const modelId = modelFor(channel, input.modelId)
  const apiKey = await resolveChannelRuntimeApiKey(channel.id)
  const codexCredentials = channel.provider === 'openai-codex'
    ? await resolveCodexOAuthCredentials(channel.id)
    : undefined
  const routeRevision = `proma-channel:${channel.id}:${channel.updatedAt}:${modelId}`
  const route: RuntimeModelRoute = {
    routeRevision,
    runtimeId: input.runtimeId,
    channelId: channel.id,
    modelId,
    provider: channel.provider,
    baseUrl: baseUrlFor(channel),
    apiMode: resolvePromaRuntimeApiMode(channel.provider),
    credentialRevision: `credential:${channel.id}:${channel.updatedAt}`,
    capabilities: input.capabilities || {},
    source: 'proma-channel',
    compaction: compactionFor(channel, modelId),
  }
  const providerEnvironment = buildCcbProviderEnvironment({
    provider: channel.provider,
    apiKey,
    baseUrl: channel.baseUrl,
    modelId,
    userAgent: getPromaUserAgent(pkg.version),
    codexCredentials,
  })
  return {
    channel,
    route,
    apiKey,
    codexCredentials,
    environment: {
      ...providerEnvironment,
      PROMA_RUNTIME_MODEL_PROVIDER: channel.provider,
      PROMA_RUNTIME_MODEL_ID: modelId,
      PROMA_RUNTIME_MODEL_BASE_URL: channel.baseUrl,
      PROMA_RUNTIME_MODEL_API_MODE: resolvePromaRuntimeApiMode(channel.provider),
    },
  }
}
