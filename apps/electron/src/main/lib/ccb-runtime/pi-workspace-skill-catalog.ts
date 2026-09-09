import { join } from 'node:path'
import type {
  AgentWorkspace,
  RuntimeSkillCatalog,
  SkillMeta,
} from '@proma/shared'

/** 由 Pi 当前工作区目录构建 Skill Catalog。 */
export function buildPiWorkspaceSkillCatalog(
  workspace: AgentWorkspace,
  skills: readonly SkillMeta[],
  directories: {
    active: string
    inactive: string
  },
): RuntimeSkillCatalog {
  return {
    projectPath: workspace.canonicalPath || workspace.path,
    skills: skills.map(skill => ({
      id: skill.slug,
      name: skill.name,
      description: skill.description,
      source: 'proma-project',
      path: join(skill.enabled ? directories.active : directories.inactive, skill.slug),
      enabled: skill.enabled,
      userInvocable: skill.enabled,
      modelInvocable: skill.enabled,
    })),
    resolvedAt: Date.now(),
  }
}
