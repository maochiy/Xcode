import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillMeta } from '@proma/shared'

const {
  buildMentionedToolsBlock,
  formatMentionedToolsBlock,
  resolveMentionedSkills,
} = await import('./agent-skill-activation')

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createSkillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-mentioned-skills-'))
  temporaryDirectories.push(root)
  return root
}

function skill(slug: string, name = slug, enabled = true): SkillMeta {
  return { slug, name, enabled }
}

function writeSkill(root: string, slug: string, content: string): string {
  const directory = join(root, slug)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), content, 'utf-8')
  return directory
}

describe('mentioned Skills 按需正文加载', () => {
  test('Given 本轮未选择 Skill When 解析激活项 Then 不访问不存在的 Skills 目录', () => {
    expect(resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: [],
      availableSkills: [],
      skillsRoot: '/path/that/does/not/exist',
    })).toEqual([])

    expect(buildMentionedToolsBlock({
      mentionedMcpServers: ['browser'],
    })).toContain('MCP 服务器: browser')
  })

  test('Given 两个重名 Skill 且只选择其中一个 When 加载正文 Then 仅按 slug 读取目标且不截断', () => {
    const root = createSkillsRoot()
    const longContent = `---\nname: Same Name\n---\n${'正文'.repeat(3000)}\nTAIL-SENTINEL`
    writeSkill(root, 'alpha', longContent)

    const betaDirectory = join(root, 'beta')
    mkdirSync(join(betaDirectory, 'SKILL.md'), { recursive: true })

    const activated = resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: ['alpha', 'alpha'],
      availableSkills: [
        skill('alpha', 'Same Name'),
        skill('beta', 'Same Name'),
      ],
      skillsRoot: root,
    })

    expect(activated).toHaveLength(1)
    expect(activated[0]?.slug).toBe('alpha')
    expect(activated[0]?.content).toBe(longContent)
    expect(activated[0]?.content.endsWith('TAIL-SENTINEL')).toBe(true)
    expect(activated[0]?.source).toBe('workspace:workspace-a/alpha')
    expect(activated[0]?.directory).toBe(realpathSync(join(root, 'alpha')))
  })

  test('Given Skill slug 非法、失效或未启用 When 加载正文 Then 明确报错且不回退到其他路径', () => {
    const root = createSkillsRoot()
    writeSkill(root, 'alpha', '# Alpha')

    expect(() => resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: ['../alpha'],
      availableSkills: [skill('alpha')],
      skillsRoot: root,
    })).toThrow('Skill 标识 非法')

    expect(() => resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: ['missing'],
      availableSkills: [skill('alpha')],
      skillsRoot: root,
    })).toThrow('工作区中不存在或未启用 Skill: workspace-a/missing')

    expect(() => resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: ['stale'],
      availableSkills: [skill('stale')],
      skillsRoot: root,
    })).toThrow('Skill 目录不存在: workspace-a/stale')

    expect(() => resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: ['alpha'],
      availableSkills: [skill('alpha', 'Alpha', false)],
      skillsRoot: root,
    })).toThrow('工作区中不存在或未启用 Skill: workspace-a/alpha')
  })

  test('Given 白名单 Skill 目录通过符号链接逃逸 When 加载正文 Then 拒绝工作区外路径', () => {
    const root = createSkillsRoot()
    const outside = createSkillsRoot()
    writeSkill(outside, 'external', '# External')
    symlinkSync(join(outside, 'external'), join(root, 'linked'), 'dir')

    expect(() => resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: ['linked'],
      availableSkills: [skill('linked')],
      skillsRoot: root,
    })).toThrow('Skill linked 路径越界')
  })

  test('Given 已激活 Skill When 生成本轮引用块 Then 保留完整正文、来源和目录', () => {
    const root = createSkillsRoot()
    const content = '# 完整正文\n不要截断\nTAIL'
    const directory = realpathSync(writeSkill(root, 'alpha', content))
    const activated = resolveMentionedSkills({
      workspaceSlug: 'workspace-a',
      mentionedSkills: ['alpha'],
      availableSkills: [skill('alpha', 'Alpha')],
      skillsRoot: root,
    })

    const block = formatMentionedToolsBlock(activated, ['browser'])

    expect(block).toContain(content)
    expect(block).toContain('source="workspace:workspace-a/alpha"')
    expect(block).toContain(`directory="${directory}"`)
    expect(block).toContain(`file="${join(directory, 'SKILL.md')}"`)
    expect(block).toContain('MCP 服务器: browser')
  })

  test('Given 正常发送与排队发送 When 检查 mention enrichment Then 两条路径复用同一实现', () => {
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf-8')
    const usages = source.match(/buildWorkspaceMentionedToolsBlock\(\{/g) ?? []
    const normalSend = source.slice(
      source.indexOf('async sendMessage('),
      source.indexOf('/** 中止指定会话'),
    )
    const queuedSend = source.slice(source.indexOf('async queueMessage('))

    expect(usages).toHaveLength(2)
    expect(source).not.toContain('请立即调用此 Skill')
    expect(normalSend.indexOf('buildWorkspaceMentionedToolsBlock({')).toBeGreaterThan(
      normalSend.indexOf('try {'),
    )
    expect(normalSend).toContain('} finally {\n      // 只在 generation 匹配时才清理')
    expect(normalSend).toContain('releaseActiveRun()')
    expect(queuedSend.indexOf('buildWorkspaceMentionedToolsBlock({')).toBeLessThan(
      queuedSend.indexOf('deliverQueuedMessageToRuntime('),
    )
    expect(queuedSend.indexOf('deliverQueuedMessageToRuntime(')).toBeLessThan(
      queuedSend.indexOf('uuids.add(uuid)'),
    )
    expect(queuedSend.indexOf('deliverQueuedMessageToRuntime(')).toBeLessThan(
      queuedSend.indexOf('this.queuedMessageUuids.set(sessionId, uuids)'),
    )
  })
})
