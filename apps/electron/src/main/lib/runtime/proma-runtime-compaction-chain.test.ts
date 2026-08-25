import { describe, expect, test, mock } from 'bun:test'

// 模拟 electron，让 gateway 的传递依赖链（channel-manager safeStorage 等）可加载
mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'proma' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf-8'),
  },
  BrowserWindow: class {},
  clipboard: {},
  ipcMain: { handle: () => {}, on: () => {} },
  webContents: { fromId: () => null },
  shell: { openPath: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))

import type { Channel, RuntimeModelRoute } from '@proma/shared'
import { claudeCompactionSettings } from './frakio-claude-runtime-adapter'
import { codexCompactionSettings } from './frakio-codex-runtime-adapter'

// gateway 内部走真实 channel-manager 的持久化读取；这里直接测纯链路：
// 带 ratio 的 Channel → compactionFor → Claude/Codex 参数
const { compactionFor } = await import('./proma-runtime-compaction')

function channelWith(opts: { modelRatio?: number; channelRatio?: number; contextWindow?: number }): Channel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider: 'anthropic',
    baseUrl: 'https://api.test',
    enabled: true,
    defaultModelId: null,
    autoCompactRatio: opts.channelRatio,
    models: [{
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
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

describe('压缩占比配置端到端传递（模型 → gateway → Claude/Codex）', () => {
  test('Given 供应商级占比 70 When 计算压缩策略 Then Claude/Codex 都收到 70% 窗口阈值', () => {
    const compaction = compactionFor(channelWith({ channelRatio: 70, contextWindow: 200_000 }), 'claude-sonnet-5')
    expect(compaction).toEqual({ enabled: true, threshold: 140_000, contextWindow: 200_000 })

    // Claude：autoCompactWindow 就是阈值
    expect(claudeCompactionSettings(compaction!)).toEqual({
      autoCompactEnabled: true,
      autoCompactWindow: 140_000,
    })
    // Codex：model_auto_compact_token_limit 就是阈值
    expect(codexCompactionSettings(compaction)).toEqual([
      '-c', 'model_auto_compact_token_limit=140000',
      '-c', 'model_context_window=200000',
    ])
  })

  test('Given 模型级占比 60 覆盖供应商级 70 When 计算压缩策略 Then 以模型级为准', () => {
    const compaction = compactionFor(
      channelWith({ modelRatio: 60, channelRatio: 70, contextWindow: 200_000 }),
      'claude-sonnet-5',
    )
    expect(compaction).toEqual({ enabled: true, threshold: 120_000, contextWindow: 200_000 })
    expect(claudeCompactionSettings(compaction!)).toEqual({
      autoCompactEnabled: true,
      autoCompactWindow: 120_000,
    })
    expect(codexCompactionSettings(compaction)).toEqual([
      '-c', 'model_auto_compact_token_limit=120000',
      '-c', 'model_context_window=200000',
    ])
  })

  test('Given 都未配置占比 When 计算压缩策略 Then 默认 80% 阈值同步给两个 Harness', () => {
    const compaction = compactionFor(channelWith({ contextWindow: 1_000_000 }), 'claude-sonnet-5')
    expect(compaction).toEqual({ enabled: true, threshold: 800_000, contextWindow: 1_000_000 })
    expect(claudeCompactionSettings(compaction!)).toEqual({
      autoCompactEnabled: true,
      autoCompactWindow: 800_000,
    })
    expect(codexCompactionSettings(compaction)).toEqual([
      '-c', 'model_auto_compact_token_limit=800000',
      '-c', 'model_context_window=1000000',
    ])
  })
  test('Given 未配置 contextWindow When 计算压缩策略 Then 用默认 200000 窗口同步给两个 Harness', () => {
    const compaction = compactionFor(channelWith({}), 'claude-sonnet-5')
    expect(compaction).toEqual({ enabled: true, threshold: 160_000, contextWindow: 200_000 })
    expect(claudeCompactionSettings(compaction!)).toEqual({
      autoCompactEnabled: true,
      autoCompactWindow: 160_000,
    })
    expect(codexCompactionSettings(compaction)).toEqual([
      '-c', 'model_auto_compact_token_limit=160000',
      '-c', 'model_context_window=200000',
    ])
  })
})
