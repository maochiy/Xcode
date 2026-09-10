import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_THINKING_EFFORT_LEVELS,
  type Channel,
  type ThinkingEffortLevel,
} from '@proma/shared'
import { buildChannelModelCatalog } from './pi-model-catalog'
import { buildPromaRuntimeModelRoute } from '../runtime/proma-runtime-model-route'

function createChannel(
  models: Channel['models'],
): Channel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    models,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function getSupportedEffortLevels(
  channel: Channel,
  modelId: string,
  includeDisabledModels = false,
): ThinkingEffortLevel[] | undefined {
  return buildChannelModelCatalog(channel, undefined, includeDisabledModels)
    .models
    .find(model => model.value === modelId)
    ?.supportedEffortLevels
}

describe('Pi 模型目录思考等级', () => {
  test('Given 旧模型未配置思考等级 When 构建目录 Then 默认支持全部等级', () => {
    const channel = createChannel([{
      id: 'legacy-model',
      name: 'Legacy Model',
      enabled: true,
    }])

    expect(getSupportedEffortLevels(channel, 'legacy-model'))
      .toEqual([...DEFAULT_THINKING_EFFORT_LEVELS])
  })

  test('Given 模型显式配置空数组 When 构建目录 Then 保留不支持思考等级语义', () => {
    const channel = createChannel([{
      id: 'no-effort-model',
      name: 'No Effort Model',
      enabled: true,
      thinkingEffortLevels: [],
    }])

    const model = buildChannelModelCatalog(channel).models[0]
    expect(model?.supportedEffortLevels).toEqual([])
    expect(model?.supportsEffort).toBe(false)
  })

  test('Given 模型显式配置思考等级子集 When 构建目录 Then 不使用默认全集覆盖', () => {
    const channel = createChannel([{
      id: 'subset-model',
      name: 'Subset Model',
      enabled: true,
      thinkingEffortLevels: ['high', 'low', 'high'],
    }])

    expect(getSupportedEffortLevels(channel, 'subset-model'))
      .toEqual(['low', 'high'])
  })

  test('Given 旧模型混用 max 与 xhigh When 构建目录 Then 归并为统一四档中的 xhigh 并排序去重', () => {
    const channel = createChannel([{
      id: 'legacy-max-model',
      name: 'Legacy Max Model',
      enabled: true,
      thinkingEffortLevels: ['max', 'medium', 'xhigh', 'max'],
    }])

    expect(getSupportedEffortLevels(channel, 'legacy-max-model'))
      .toEqual(['medium', 'xhigh'])
  })

  test('Given 渠道包含停用模型 When 构建目录 Then includeDisabledModels 控制是否包含且缺省等级仍补齐', () => {
    const channel = createChannel([
      {
        id: 'enabled-model',
        name: 'Enabled Model',
        enabled: true,
      },
      {
        id: 'disabled-model',
        name: 'Disabled Model',
        enabled: false,
      },
    ])

    expect(buildChannelModelCatalog(channel).models.map(model => model.value))
      .toEqual(['enabled-model'])

    const catalog = buildChannelModelCatalog(channel, undefined, true)
    expect(catalog.models.map(model => model.value))
      .toEqual(['enabled-model', 'disabled-model'])
    expect(catalog.models[1]?.supportedEffortLevels)
      .toEqual([...DEFAULT_THINKING_EFFORT_LEVELS])
  })
})

describe('Pi 配置、目录与执行使用同一压缩策略', () => {
  test('Given 供应商默认 80% 与模型覆盖 70% When 读取模型目录 Then 分别显示 160K 和 70K 且与执行路由一致', () => {
    const channel = {
      ...createChannel([
        { id: 'A', name: 'A', enabled: true, contextWindow: 200_000 },
        { id: 'B', name: 'B', enabled: true, contextWindow: 100_000, autoCompactRatio: 70 },
      ]),
      autoCompactRatio: 80,
    }
    const catalog = buildChannelModelCatalog(channel)
    expect(catalog.contextPolicy.autoCompactEnabled).toBe(true)
    expect(catalog.contextPolicy.models.map(policy => policy.autoCompactThreshold))
      .toEqual([160_000, 70_000])
    for (const policy of catalog.contextPolicy.models) {
      const route = buildPromaRuntimeModelRoute({ channel, modelId: policy.model })
      expect(route.compaction).toEqual({
        enabled: true,
        contextWindow: policy.contextWindow,
        threshold: policy.autoCompactThreshold,
      })
      expect(catalog.models.find(model => model.value === policy.model)?.contextWindow)
        .toBe(policy.effectiveContextWindow)
    }
  })

  test('Given 模型未填窗口与压缩比例 When 读取目录 Then 使用与运行层相同的 200K 和 80% 而非模型名推测值', () => {
    const channel = createChannel([{ id: 'deepseek-v4-flash', name: '默认窗口模型', enabled: true }])
    const catalog = buildChannelModelCatalog(channel)
    expect(catalog.models[0]?.contextWindow).toBe(200_000)
    expect(catalog.contextPolicy.models[0]).toEqual({
      model: 'deepseek-v4-flash', contextWindow: 200_000,
      effectiveContextWindow: 200_000, autoCompactThreshold: 160_000,
    })
  })

  test('Given 仅供应商比例改变 When 重新读取目录 Then 模型元数据不变但继承阈值随配置变化', () => {
    const channel = createChannel([{ id: 'A', name: 'A', enabled: true, contextWindow: 200_000 }])
    const before = buildChannelModelCatalog(channel)
    const after = buildChannelModelCatalog({ ...channel, autoCompactRatio: 60 })
    expect(after.models).toEqual(before.models)
    expect(after.contextPolicy.models[0]?.autoCompactThreshold).toBe(120_000)
    expect(after.contextPolicy).not.toEqual(before.contextPolicy)
  })
})
