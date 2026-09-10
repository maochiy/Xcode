/**
 * 隔离渠道压缩配置夹具。
 *
 * 调用：
 *   echo '<json>' | bun apps/electron/scripts/pi-compaction-channel-fixture.mjs create
 *   echo '<json>' | bun apps/electron/scripts/pi-compaction-channel-fixture.mjs update
 *   echo '<json>' | bun apps/electron/scripts/pi-compaction-channel-fixture.mjs inspect
 *
 * 必须由调用方设置 PROMA_COMPACTION_FIXTURE_HOME，并让 HOME 指向同一路径。
 * stdout 最后一条带前缀的 JSON 可供 Node/Bun 测试或 Vite localhost endpoint 解析。
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import path from 'node:path'
import { mock } from 'bun:test'

const OUTPUT_PREFIX = 'PROMA_COMPACTION_FIXTURE_JSON='
const fixtureHome = process.env.PROMA_COMPACTION_FIXTURE_HOME

assert.ok(fixtureHome, '必须设置 PROMA_COMPACTION_FIXTURE_HOME')
assert.equal(
  path.resolve(homedir()),
  path.resolve(fixtureHome),
  'HOME 必须与 PROMA_COMPACTION_FIXTURE_HOME 指向同一隔离目录',
)

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => fixtureHome,
  },
  clipboard: { writeText: () => {} },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`proma-compaction-fixture:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^proma-compaction-fixture:/, ''),
  },
  shell: { openExternal: async () => {} },
}))

const {
  createChannel,
  getChannelById,
  updateChannel,
} = await import('../src/main/lib/channel-manager.ts')
const {
  buildPromaRuntimeModelRoute,
} = await import('../src/main/lib/runtime/proma-runtime-model-route.ts')
const {
  buildChannelModelCatalog,
} = await import('../src/main/lib/ccb-runtime/pi-model-catalog.ts')

function assertLocalChannel(channel) {
  const url = new URL(channel.baseUrl)
  assert.ok(
    url.hostname === '127.0.0.1' || url.hostname === 'localhost',
    `隔离夹具只允许 localhost Provider：${channel.baseUrl}`,
  )
}

function snapshot(channelId, modelId) {
  const channel = getChannelById(channelId)
  assert.ok(channel, `渠道不存在：${channelId}`)
  assertLocalChannel(channel)
  const resolvedModelId = modelId || channel.defaultModelId || channel.models[0]?.id
  assert.ok(resolvedModelId, '渠道必须至少包含一个模型')
  return {
    channel: {
      ...channel,
      apiKey: '[isolated]',
    },
    route: buildPromaRuntimeModelRoute({ channel, modelId: resolvedModelId }),
    catalog: buildChannelModelCatalog(channel, resolvedModelId, true),
  }
}

async function readInput() {
  const raw = await Bun.stdin.text()
  return raw.trim() ? JSON.parse(raw) : {}
}

export async function runChannelFixtureCommand(action, input) {
  if (action === 'create') {
    assertLocalChannel(input.channel)
    const channel = createChannel(input.channel)
    return snapshot(channel.id, input.modelId)
  }
  if (action === 'update') {
    const existing = getChannelById(input.channelId)
    assert.ok(existing, `渠道不存在：${input.channelId}`)
    assertLocalChannel({
      ...existing,
      baseUrl: input.patch?.baseUrl ?? existing.baseUrl,
    })
    updateChannel(input.channelId, input.patch || {})
    return snapshot(input.channelId, input.modelId)
  }
  if (action === 'inspect') {
    return snapshot(input.channelId, input.modelId)
  }
  throw new Error(`未知隔离夹具命令：${action}`)
}

if (import.meta.main) {
  const result = await runChannelFixtureCommand(process.argv[2], await readInput())
  console.log(`${OUTPUT_PREFIX}${JSON.stringify(result)}`)
}
