import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import {
  DEFAULT_AUTO_COMPACT_RATIO,
  compactionFor,
  resolveAutoCompactRatio,
} from './proma-runtime-compaction'
import { DEFAULT_CONTEXT_WINDOW } from '@proma/shared'
import { piCompactionSettings } from '../../../../resources/pi-runtime/workers/pi-compaction-settings.mjs'

function channelWith(
  modelId: string,
  provider: string,
  opts: {
    contextWindow?: number
    modelRatio?: number
    channelRatio?: number
  } = {},
): Channel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider,
    baseUrl: 'https://api.test',
    enabled: true,
    defaultModelId: null,
    autoCompactRatio: opts.channelRatio,
    models: [{
      id: modelId,
      name: modelId,
      enabled: true,
      ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
      ...(opts.modelRatio != null ? { autoCompactRatio: opts.modelRatio } : {}),
    }],
    apiMode: 'anthropic_messages',
    capabilities: {},
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Channel
}

describe('Proma Runtime 模型压缩策略计算', () => {
  test.each([
    [0, 160_000],
    [0.01, 20],
    [70, 140_000],
    [80, 160_000],
    [100, 199_998],
  ])('Given 比例 %s When 执行与显示读取同一策略 Then 阈值与 Worker 实际预留预算一致', (modelRatio, expectedThreshold) => {
    const policy = compactionFor(channelWith('fixture', 'custom', {
      contextWindow: 200_000, modelRatio,
    }), 'fixture')!
    const native = piCompactionSettings(200_000, {
      enabled: true, threshold: Math.round(200_000 * modelRatio / 100),
    })
    expect(policy.threshold).toBe(expectedThreshold)
    expect(policy.threshold).toBe(200_000 - native.reserveTokens)
    expect(policy.enabled).toBe(native.enabled)
  })

  test('Given 模型未配置压缩占比 When 解析占比 Then 返回 undefined 由默认值兜底', () => {
    expect(resolveAutoCompactRatio(channelWith('claude-test', 'anthropic'), 'claude-test'))
      .toBeUndefined()
  })

  test('Given 只配置供应商级占比 When 解析占比 Then 使用供应商级', () => {
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { channelRatio: 70 }),
      'claude-test',
    )).toBe(70)
  })

  test('Given 同时配置模型级与供应商级 When 解析占比 Then 模型级优先', () => {
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { modelRatio: 60, channelRatio: 70 }),
      'claude-test',
    )).toBe(60)
  })

  test('Given 模型配置了 contextWindow 且占比 80 When 计算压缩策略 Then 阈值取窗口的 80%', () => {
    const compaction = compactionFor(
      channelWith('claude-test', 'anthropic', { contextWindow: 200_000, modelRatio: 80 }),
      'claude-test',
    )
    expect(compaction).toEqual({
      enabled: true,
      threshold: Math.round(200_000 * DEFAULT_AUTO_COMPACT_RATIO),
      contextWindow: 200_000,
    })
  })

  test('Given 模型配置占比 60 When 计算压缩策略 Then 阈值取窗口的 60%', () => {
    const compaction = compactionFor(
      channelWith('claude-test', 'anthropic', { contextWindow: 200_000, modelRatio: 60 }),
      'claude-test',
    )
    expect(compaction).toEqual({
      enabled: true,
      threshold: 120_000,
      contextWindow: 200_000,
    })
  })

  test('Given 供应商级占比 70 且模型未配置 When 计算压缩策略 Then 阈值取窗口的 70%', () => {
    const compaction = compactionFor(
      channelWith('claude-test', 'anthropic', { contextWindow: 200_000, channelRatio: 70 }),
      'claude-test',
    )
    expect(compaction).toEqual({
      enabled: true,
      threshold: 140_000,
      contextWindow: 200_000,
    })
  })

  test('Given 模型未配置 contextWindow When 计算压缩策略 Then 使用默认窗口 200000 并取默认 80%', () => {
    const compaction = compactionFor(channelWith('claude-opus-4-7', 'anthropic'), 'claude-opus-4-7')
    expect(compaction).toEqual({
      enabled: true,
      threshold: Math.round(DEFAULT_CONTEXT_WINDOW * DEFAULT_AUTO_COMPACT_RATIO),
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    })
  })

  test('Given 超出边界的占比 When 解析占比 Then 收敛到 0-100', () => {
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { modelRatio: 150 }),
      'claude-test',
    )).toBe(100)
    expect(resolveAutoCompactRatio(
      channelWith('claude-test', 'anthropic', { modelRatio: -20 }),
      'claude-test',
    )).toBe(0)
  })

  test('Given 模型不在渠道中 When 计算压缩策略 Then 使用默认窗口并启用压缩', () => {
    const compaction = compactionFor(channelWith('known-model', 'anthropic'), 'unknown-model')
    expect(compaction).toEqual({
      enabled: true,
      threshold: Math.round(DEFAULT_CONTEXT_WINDOW * DEFAULT_AUTO_COMPACT_RATIO),
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    })
  })
})
