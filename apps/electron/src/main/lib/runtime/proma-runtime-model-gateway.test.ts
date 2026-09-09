import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import { buildPromaRuntimeModelRoute } from './proma-runtime-model-route'

function channel(provider: Channel['provider'], modelId: string, baseUrl: string): Channel {
  return {
    id: `channel-${provider}`,
    name: '测试渠道',
    provider,
    baseUrl,
    apiKey: '',
    models: [{ id: modelId, name: modelId, enabled: true }],
    defaultModelId: modelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('Pi Runtime 模型路由', () => {
  test('Given 模型名伪装成其他供应商 When 构建路由 Then 协议只由渠道 provider 决定', () => {
    const route = buildPromaRuntimeModelRoute({
      channel: channel('openai', 'claude-sonnet-looking-name', 'https://anthropic-looking.test/v1'),
      modelId: 'claude-sonnet-looking-name',
    })
    expect(route.runtimeId).toBe('pi')
    expect(route.provider).toBe('openai')
    expect(route.apiMode).toBe('openai_chat_completions')
  })

  test('Given 历史多内核调用方 When 构建模型路由 Then 输出始终绑定 Pi', () => {
    const route = buildPromaRuntimeModelRoute({
      channel: channel('anthropic', 'gpt-looking-name', 'https://openai-looking.test/v1'),
      modelId: 'gpt-looking-name',
    })
    expect(route.runtimeId).toBe('pi')
    expect(route.provider).toBe('anthropic')
    expect(route.apiMode).toBe('anthropic_messages')
  })
})
