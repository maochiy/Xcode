import { describe, expect, test } from 'bun:test'
import type { Channel, ChannelModel, ChannelsConfig } from '@proma/shared'
import { migrateChannelThinkingEffort } from './channel-thinking-effort-migration'

function createChannel(
  id: string,
  models: ChannelModel[],
  enabled: boolean,
): Channel {
  return {
    id,
    name: `测试渠道 ${id}`,
    provider: 'anthropic',
    baseUrl: 'https://example.invalid',
    apiKey: '',
    models,
    autoCompactRatio: 75,
    defaultModelId: models[0]?.id,
    enabled,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('渠道思考等级迁移', () => {
  test('Given 新旧模型分布在启用和停用渠道 When 迁移 Then 全部补齐并保留模型与渠道元数据', () => {
    const missingLevels: ChannelModel = {
      id: 'missing-levels',
      name: '未配置等级',
      description: '保留描述',
      contextWindow: 123_456,
      autoCompactRatio: 65,
      enabled: true,
      source: 'manual',
    }
    const explicitEmpty: ChannelModel = {
      id: 'no-effort',
      name: '显式不支持',
      enabled: false,
      thinkingEffortLevels: [],
    }
    const legacyMax: ChannelModel = {
      id: 'legacy-max',
      name: '旧最高档',
      enabled: false,
      source: 'fetched',
      thinkingEffortLevels: ['max', 'medium', 'xhigh', 'medium'],
      defaultThinkingEffortLevel: 'max',
    }
    const normalized: ChannelModel = {
      id: 'normalized',
      name: '已规范',
      enabled: true,
      thinkingEffortLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultThinkingEffortLevel: 'high',
    }
    const enabledChannel = createChannel(
      'enabled-channel',
      [missingLevels, explicitEmpty],
      true,
    )
    const disabledChannel = createChannel(
      'disabled-channel',
      [legacyMax],
      false,
    )
    const stableChannel = createChannel(
      'stable-channel',
      [normalized],
      true,
    )
    const config: ChannelsConfig = {
      version: 9,
      channels: [enabledChannel, disabledChannel, stableChannel],
    }

    const migrated = migrateChannelThinkingEffort(config)

    expect(migrated.version).toBe(9)
    expect(migrated.channels[0]).toMatchObject({
      id: enabledChannel.id,
      name: enabledChannel.name,
      autoCompactRatio: 75,
      defaultModelId: 'missing-levels',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    })
    expect(migrated.channels[0]?.models[0]).toEqual({
      ...missingLevels,
      thinkingEffortLevels: ['low', 'medium', 'high', 'xhigh'],
    })
    expect(migrated.channels[0]?.models[1]).toBe(explicitEmpty)
    expect(migrated.channels[1]?.models[0]).toEqual({
      ...legacyMax,
      thinkingEffortLevels: ['medium', 'xhigh'],
      defaultThinkingEffortLevel: 'xhigh',
    })
  })

  test('Given 仅部分对象需要迁移 When 迁移并再次迁移 Then 未变化对象保持引用且结果幂等', () => {
    const changedModel: ChannelModel = {
      id: 'legacy',
      name: '旧模型',
      enabled: true,
    }
    const stableModel: ChannelModel = {
      id: 'stable',
      name: '稳定模型',
      enabled: false,
      thinkingEffortLevels: [],
    }
    const normalizedModel: ChannelModel = {
      id: 'normalized',
      name: '已规范模型',
      enabled: true,
      thinkingEffortLevels: ['low', 'medium', 'high', 'xhigh'],
    }
    const changedChannel = createChannel(
      'changed-channel',
      [changedModel, stableModel],
      true,
    )
    const stableChannel = createChannel(
      'stable-channel',
      [normalizedModel],
      false,
    )
    const config: ChannelsConfig = {
      version: 3,
      channels: [changedChannel, stableChannel],
    }

    const migrated = migrateChannelThinkingEffort(config)

    expect(migrated).not.toBe(config)
    expect(migrated.channels[0]).not.toBe(changedChannel)
    expect(migrated.channels[0]?.models[0]).not.toBe(changedModel)
    expect(migrated.channels[0]?.models[1]).toBe(stableModel)
    expect(migrated.channels[1]).toBe(stableChannel)
    expect(migrateChannelThinkingEffort(migrated)).toBe(migrated)
  })
})
