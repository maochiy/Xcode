import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { serializeCodexCredentials } from '@proma/shared'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  clipboard: {
    writeText: () => undefined,
  },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeChannels(channels: unknown[], version = 2): void {
  const configDir = join(tempHome, 'xcodes')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'channels.json'),
    JSON.stringify({ version, channels }),
    'utf-8',
  )
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-channel-runtime-key-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, 'xcodes'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('渠道运行时认证解析', () => {
  test('Given ChatGPT OAuth 渠道 When 解析运行时 key Then 返回 access token 而不是凭据 JSON', async () => {
    writeChannels([
      {
        id: 'codex-channel',
        name: 'ChatGPT',
        provider: 'openai-codex',
        baseUrl: '',
        apiKey: serializeCodexCredentials({
          access: 'oauth-access-token',
          refresh: 'oauth-refresh-token',
          expires: Date.now() + 3_600_000,
        }),
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('codex-channel'))
      .resolves.toBe('oauth-access-token')
  })

  test('Given 普通渠道 When 解析运行时 key Then 返回解密后的 API Key', async () => {
    writeChannels([
      {
        id: 'api-key-channel',
        name: 'Anthropic',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'plain-api-key',
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('api-key-channel'))
      .resolves.toBe('plain-api-key')
  })
})

describe('渠道删除持久化', () => {
  test('Given 仅剩一个 DeepSeek 配置 When 删除并重新读取 Then 不自动恢复预设配置', () => {
    writeChannels([
      {
        id: 'deepseek-channel',
        name: 'DeepSeek',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'plain-api-key',
        models: [],
        enabled: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    channelManager.deleteChannel('deepseek-channel')

    expect(channelManager.listChannels()).toEqual([])
  })
})

describe('渠道默认模型', () => {
  test('Given v2 渠道没有默认模型 When 读取配置 Then 迁移第一个启用模型并持久化 v3', () => {
    writeChannels([
      {
        id: 'anthropic-channel',
        name: 'Anthropic',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'plain-api-key',
        models: [
          { id: 'disabled-model', name: 'Disabled', enabled: false },
          { id: 'default-model', name: 'Default', enabled: true },
          { id: 'backup-model', name: 'Backup', enabled: true },
        ],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    expect(channelManager.listChannels()[0]?.defaultModelId)
      .toBe('default-model')
    const persisted = JSON.parse(
      readFileSync(join(tempHome, 'xcodes', 'channels.json'), 'utf-8'),
    ) as {
      version: number
      channels: Array<{ defaultModelId?: string }>
    }
    expect(persisted.version).toBe(3)
    expect(persisted.channels[0]?.defaultModelId).toBe('default-model')
  })

  test('Given 默认模型被禁用 When 保存模型列表 Then 自动回退到下一个启用模型', () => {
    writeChannels([
      {
        id: 'openai-channel',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'plain-api-key',
        models: [
          { id: 'model-a', name: 'A', enabled: true },
          { id: 'model-b', name: 'B', enabled: true },
        ],
        defaultModelId: 'model-a',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ], 3)

    const updated = channelManager.updateChannel('openai-channel', {
      models: [
        { id: 'model-a', name: 'A', enabled: false },
        { id: 'model-b', name: 'B', enabled: true },
      ],
    })

    expect(updated.defaultModelId).toBe('model-b')
  })
})
