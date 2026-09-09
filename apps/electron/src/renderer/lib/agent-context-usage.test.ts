import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeModelCatalog, SDKMessage } from '@proma/shared'
import {
  derivePersistedAgentContextUsage,
  resolveAgentContextPolicy,
} from './agent-context-usage'

describe('历史会话上下文圆环水合', () => {
  test('Given CCB 轻量策略目录 When 打开历史会话 Then 无需启动 Turn 即可读取可用窗口', () => {
    const catalog: AgentRuntimeModelCatalog = {
      channelId: 'channel-1',
      models: [],
      contextPolicy: {
        autoCompactEnabled: true,
        models: [
          {
            model: 'claude-sonnet-4-6',
            contextWindow: 200_000,
            effectiveContextWindow: 180_000,
            autoCompactThreshold: 167_000,
          },
        ],
      },
    }

    expect(resolveAgentContextPolicy(catalog, 'claude-sonnet-4-6[1m]')).toEqual(
      catalog.contextPolicy.models[0],
    )
  })

  test('Given 普通 assistant usage When 重开会话 Then 恢复最近上下文占用', () => {
    const restored = derivePersistedAgentContextUsage([
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 12_000,
            output_tokens: 800,
            cache_read_input_tokens: 30_000,
            cache_creation_input_tokens: 2_000,
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: {
          model: { contextWindow: 200_000 },
        },
      },
    ] as SDKMessage[])

    expect(restored).toMatchObject({
      inputTokens: 44_000,
      outputTokens: 800,
      cacheReadTokens: 30_000,
      cacheCreationTokens: 2_000,
      cumulativeInputTokens: 12_000,
      cumulativeCacheReadTokens: 30_000,
      cumulativeCacheCreationTokens: 2_000,
      contextWindow: 200_000,
      contextUsageIsEstimated: false,
    })
  })

  test('Given 手动压缩边界和压缩 result When 重开会话 Then 保留 post_tokens', () => {
    const restored = derivePersistedAgentContextUsage([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 168_000,
          post_tokens: 24_000,
        },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 168_000,
          output_tokens: 2_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          model: { contextWindow: 200_000 },
        },
      },
    ] as SDKMessage[])

    expect(restored).toMatchObject({
      inputTokens: 24_000,
      contextWindow: 200_000,
      contextUsageIsEstimated: true,
    })
  })

  test('Given 最新压缩边界位于投影开头 When 后面仍有旧 usage Then 按创建时间保留压缩后占用', () => {
    const restored = derivePersistedAgentContextUsage([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 0,
          post_tokens: 984,
        },
        _createdAt: 2_000,
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 2_516,
            output_tokens: 1_128,
            cache_read_input_tokens: 55_040,
            cache_creation_input_tokens: 0,
          },
        },
        _createdAt: 1_000,
      },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: {
          model: { contextWindow: 200_000 },
        },
        _createdAt: 1_000,
      },
    ] as SDKMessage[])

    expect(restored).toMatchObject({
      inputTokens: 984,
      contextWindow: 200_000,
      contextUsageIsEstimated: true,
    })
  })

  test('Given 同一时刻同时存在压缩边界和累计 result When 恢复 Then 压缩边界优先', () => {
    const restored = derivePersistedAgentContextUsage([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 58_684,
          post_tokens: 984,
        },
        _createdAt: 2_000,
      },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 57_941,
          output_tokens: 3_258,
          cache_read_input_tokens: 297_216,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          model: { contextWindow: 200_000 },
        },
        _createdAt: 2_000,
      },
    ] as SDKMessage[])

    expect(restored).toMatchObject({
      inputTokens: 984,
      contextWindow: 200_000,
      contextUsageIsEstimated: true,
    })
  })

  test('Given 压缩后产生了更新的 assistant usage When 恢复 Then 使用最新真实用量', () => {
    const restored = derivePersistedAgentContextUsage([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 58_684,
          post_tokens: 984,
        },
        _createdAt: 2_000,
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 1_200,
            output_tokens: 300,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
          },
        },
        _createdAt: 3_000,
      },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: {
          model: { contextWindow: 200_000 },
        },
        _createdAt: 3_000,
      },
    ] as SDKMessage[])

    expect(restored).toMatchObject({
      inputTokens: 2_100,
      outputTokens: 300,
      cacheReadTokens: 900,
      cacheCreationTokens: 0,
      cumulativeInputTokens: 1_200,
      cumulativeCacheReadTokens: 900,
      cumulativeCacheCreationTokens: 0,
      contextWindow: 200_000,
      contextUsageIsEstimated: false,
    })
  })

  test('Given 会话已收到 CCB 压缩配置 When 重开会话 Then 恢复完整上下文面板', () => {
    const restored = derivePersistedAgentContextUsage([
      {
        type: 'system',
        subtype: 'context_compaction_config',
        autoCompactEnabled: true,
        autoCompactThreshold: 167_000,
        effectiveContextWindow: 180_000,
        _createdAt: 1_000,
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 20_000,
            output_tokens: 500,
            cache_read_input_tokens: 10_000,
            cache_creation_input_tokens: 0,
          },
        },
        _createdAt: 2_000,
      },
      {
        type: 'result',
        subtype: 'success',
        modelUsage: {
          model: { contextWindow: 200_000 },
        },
        _createdAt: 2_000,
      },
    ] as SDKMessage[])

    expect(restored).toMatchObject({
      inputTokens: 30_000,
      outputTokens: 500,
      cacheReadTokens: 10_000,
      cacheCreationTokens: 0,
      cumulativeInputTokens: 20_000,
      cumulativeCacheReadTokens: 10_000,
      cumulativeCacheCreationTokens: 0,
      contextWindow: 200_000,
      contextUsageIsEstimated: false,
      autoCompactEnabled: true,
      autoCompactThreshold: 167_000,
      effectiveContextWindow: 180_000,
    })
  })
})
