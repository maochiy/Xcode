import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentWorkspace, Channel, SkillMeta } from '@proma/shared'
import { buildChannelModelCatalog } from './pi-model-catalog'
import { buildPiWorkspaceSkillCatalog } from './pi-workspace-skill-catalog'
import { createLegacyCcbUnsupportedError } from './legacy-ccb-api'

const runtimeDir = import.meta.dir
const mainDir = join(runtimeDir, '..', '..')

describe('Pi-only 主进程入口', () => {
  test('Given 旧 CCB 外部内核已删除 When 检查主进程入口 Then 不再存在 runtime-client 或原生模型服务', () => {
    expect(existsSync(join(runtimeDir, 'runtime-client.ts'))).toBe(false)
    expect(existsSync(join(runtimeDir, 'native-model-config-service.ts'))).toBe(false)
    expect(existsSync(join(runtimeDir, 'session-catalog-service.ts'))).toBe(false)

    const ipcSource = readFileSync(join(mainDir, 'ipc.ts'), 'utf8')
    expect(ipcSource).not.toContain('runtime-client')
    expect(ipcSource).not.toContain('syncCcbSession')
    expect(ipcSource).not.toContain('updateCcbNativeModelConfiguration')
  })

  test('Given 历史 CCB API 被调用 When 返回错误 Then 明确提示仅支持 Pi', () => {
    expect(createLegacyCcbUnsupportedError('原生模型配置').message)
      .toBe('旧 CCB 原生模型配置 已停用；Xcodes 仅支持 Pi Runtime')
  })

  test('Given Anthropic 与 OpenAI OAuth 渠道 When 构建模型目录 Then 只读取当前渠道模型且不需要凭证', () => {
    const createChannel = (provider: Channel['provider']): Channel => ({
      id: `channel-${provider}`,
      name: provider,
      provider,
      baseUrl: '',
      apiKey: '',
      models: [{
        id: `${provider}-model`,
        name: `${provider} model`,
        contextWindow: 128_000,
        enabled: true,
      }],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    })

    for (const provider of ['anthropic', 'openai-codex'] as const) {
      const channel = createChannel(provider)
      const catalog = buildChannelModelCatalog(channel)
      expect(catalog.channelId).toBe(channel.id)
      expect(catalog.models.map(model => model.value)).toEqual([`${provider}-model`])
    }
  })

  test('Given Pi 工作区包含启用和停用 Skill When 构建目录 Then 只标记工作区来源并保留状态', () => {
    const workspace: AgentWorkspace = {
      id: 'workspace-id',
      name: 'Workspace',
      slug: 'workspace',
      path: '/project',
      canonicalPath: '/project',
      createdAt: 0,
      updatedAt: 0,
    }
    const skills: SkillMeta[] = [
      { slug: 'active-skill', name: 'Active', enabled: true },
      { slug: 'inactive-skill', name: 'Inactive', enabled: false },
    ]

    const catalog = buildPiWorkspaceSkillCatalog(workspace, skills, {
      active: '/proma/skills',
      inactive: '/proma/skills-inactive',
    })

    expect(catalog.skills).toEqual([
      expect.objectContaining({
        id: 'active-skill',
        source: 'proma-project',
        path: '/proma/skills/active-skill',
        enabled: true,
      }),
      expect.objectContaining({
        id: 'inactive-skill',
        source: 'proma-project',
        path: '/proma/skills-inactive/inactive-skill',
        enabled: false,
      }),
    ])
  })
})
