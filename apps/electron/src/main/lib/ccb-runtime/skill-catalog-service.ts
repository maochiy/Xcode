import { existsSync, statSync } from 'node:fs'
import type {
  RuntimeSkillCatalog,
} from '@proma/shared'
import {
  getAgentWorkspace,
  getAllWorkspaceSkills,
} from '../agent-workspace-manager'
import { getInactiveSkillsDir, getWorkspaceSkillsDir } from '../config-paths'
import { buildPiWorkspaceSkillCatalog } from './pi-workspace-skill-catalog'

/** 按当前项目读取 Pi/Proma 工作区 Skills。 */
export async function resolveAgentRuntimeSkillCatalog(
  workspaceId: string,
): Promise<RuntimeSkillCatalog> {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) throw new Error('项目不存在，请重新选择项目')

  const projectPath = workspace.canonicalPath || workspace.path
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`项目目录不可用，请重新添加项目：${projectPath}`)
  }

  return buildPiWorkspaceSkillCatalog(
    workspace,
    getAllWorkspaceSkills(workspace.slug),
    {
      active: getWorkspaceSkillsDir(workspace.slug),
      inactive: getInactiveSkillsDir(workspace.slug),
    },
  )
}
