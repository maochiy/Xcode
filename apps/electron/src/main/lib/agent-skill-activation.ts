import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { SkillMeta } from '@proma/shared'

export interface ActivatedMentionedSkill {
  slug: string
  name: string
  description?: string
  source: string
  directory: string
  skillFile: string
  content: string
}

export interface ResolveMentionedSkillsInput {
  workspaceSlug: string
  mentionedSkills: readonly string[]
  availableSkills: readonly SkillMeta[]
  skillsRoot: string
}

function assertSafePathSegment(value: string, label: string): void {
  if (
    !value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new Error(`${label} 非法: ${value || '空值'}`)
  }
}

function assertPathInside(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate)
  if (
    relativePath === ''
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`${label} 路径越界`)
  }
}

/**
 * 按工作区活跃 Skill 白名单解析本轮明确选择的 Skills。
 *
 * 只读取被选择 Skill 的 SKILL.md，且正文不做截断。
 */
export function resolveMentionedSkills(input: ResolveMentionedSkillsInput): ActivatedMentionedSkill[] {
  if (input.mentionedSkills.length === 0) return []

  assertSafePathSegment(input.workspaceSlug, '工作区标识')

  if (!existsSync(input.skillsRoot)) {
    throw new Error(`工作区 Skills 目录不存在: ${input.skillsRoot}`)
  }

  const canonicalRoot = realpathSync(input.skillsRoot)
  const skillsBySlug = new Map(input.availableSkills.map((skill) => [skill.slug, skill]))
  const uniqueSlugs = Array.from(new Set(input.mentionedSkills))

  return uniqueSlugs.map((slug) => {
    assertSafePathSegment(slug, 'Skill 标识')

    const skill = skillsBySlug.get(slug)
    if (!skill || !skill.enabled) {
      throw new Error(`工作区中不存在或未启用 Skill: ${input.workspaceSlug}/${slug}`)
    }

    const requestedDirectory = join(canonicalRoot, slug)
    if (!existsSync(requestedDirectory)) {
      throw new Error(`Skill 目录不存在: ${input.workspaceSlug}/${slug}`)
    }

    const directory = realpathSync(requestedDirectory)
    assertPathInside(canonicalRoot, directory, `Skill ${slug}`)
    if (!statSync(directory).isDirectory()) {
      throw new Error(`Skill 路径不是目录: ${input.workspaceSlug}/${slug}`)
    }

    const requestedSkillFile = join(directory, 'SKILL.md')
    if (!existsSync(requestedSkillFile)) {
      throw new Error(`Skill 缺少 SKILL.md: ${input.workspaceSlug}/${slug}`)
    }

    const skillFile = realpathSync(requestedSkillFile)
    assertPathInside(directory, skillFile, `Skill ${slug} 的 SKILL.md`)
    if (!statSync(skillFile).isFile()) {
      throw new Error(`Skill 的 SKILL.md 不是文件: ${input.workspaceSlug}/${slug}`)
    }

    return {
      slug,
      name: skill.name,
      description: skill.description,
      source: `workspace:${input.workspaceSlug}/${slug}`,
      directory,
      skillFile,
      content: readFileSync(skillFile, 'utf-8'),
    }
  })
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function buildMentionedToolsBlock(input: {
  workspaceSlug?: string
  mentionedSkills?: readonly string[]
  mentionedMcpServers?: readonly string[]
  availableSkills?: readonly SkillMeta[]
  skillsRoot?: string
}): string {
  const skillSlugs = input.mentionedSkills ?? []
  const mcpNames = input.mentionedMcpServers ?? []
  if (skillSlugs.length === 0 && mcpNames.length === 0) return ''

  if (skillSlugs.length > 0 && !input.workspaceSlug) {
    throw new Error('当前会话未选择工作区，无法加载 mentioned Skill')
  }
  if (skillSlugs.length > 0 && !input.skillsRoot) {
    throw new Error('当前工作区缺少 Skills 目录，无法加载 mentioned Skill')
  }

  const activatedSkills = skillSlugs.length > 0
    ? resolveMentionedSkills({
        workspaceSlug: input.workspaceSlug!,
        mentionedSkills: skillSlugs,
        availableSkills: input.availableSkills ?? [],
        skillsRoot: input.skillsRoot!,
      })
    : []
  return formatMentionedToolsBlock(activatedSkills, mcpNames)
}

export function formatMentionedToolsBlock(
  activatedSkills: readonly ActivatedMentionedSkill[],
  mcpNames: readonly string[],
): string {
  if (activatedSkills.length === 0 && mcpNames.length === 0) return ''

  const sections: string[] = [
    '用户在消息中明确引用了以下工具，请在本次回复中主动使用：',
  ]

  for (const skill of activatedSkills) {
    sections.push(
      `- Skill: ${skill.slug}（已加载完整正文）`,
      `<mentioned_skill slug="${escapeXmlAttribute(skill.slug)}" name="${escapeXmlAttribute(skill.name)}" source="${escapeXmlAttribute(skill.source)}" directory="${escapeXmlAttribute(skill.directory)}" file="${escapeXmlAttribute(skill.skillFile)}">`,
      skill.content,
      '</mentioned_skill>',
    )
  }
  for (const name of mcpNames) {
    sections.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
  }

  return `<mentioned_tools>\n${sections.join('\n')}\n</mentioned_tools>`
}
