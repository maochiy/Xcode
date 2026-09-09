import { describe, expect, test } from 'bun:test'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  RuntimeModelRoute,
  SDKMessage,
} from '@proma/shared'
import { RuntimeAdapterRouter } from './runtime-adapters'

class CapturingPiAdapter implements AgentProviderAdapter {
  input: AgentQueryInput | null = null

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    this.input = input
  }

  async abort(): Promise<void> {}

  dispose(): void {}
}

function legacyRoute(): RuntimeModelRoute {
  return {
    routeRevision: 'revision',
    runtimeId: 'claude',
    channelId: 'channel',
    modelId: 'model',
    provider: 'openai',
    baseUrl: 'https://example.test/v1',
    apiMode: 'openai_chat_completions',
    credentialRevision: 'credential',
    capabilities: {},
    source: 'proma-channel',
  }
}

describe('RuntimeAdapterRouter Pi-only 执行边界', () => {
  test('Given 查询仍携带旧 RuntimeId When 进入 Router Then 只向 Pi 传递规范化输入', async () => {
    const pi = new CapturingPiAdapter()
    const router = new RuntimeAdapterRouter(pi)
    for await (const _message of router.query({
      sessionId: 'session',
      runtimeId: 'claude',
      prompt: 'test',
      modelRoute: legacyRoute(),
    })) {
      // 捕获适配器不产生消息。
    }
    expect(pi.input?.runtimeId).toBe('pi')
    expect(pi.input?.modelRoute?.runtimeId).toBe('pi')
  })
})
