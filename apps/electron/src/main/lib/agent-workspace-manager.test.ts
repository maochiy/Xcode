import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentWorkspaceManager = typeof import('./agent-workspace-manager')
type ConfigPathsModule = typeof import('./config-paths')

let manager: AgentWorkspaceManager
let configPaths: ConfigPathsModule
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
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-agent-workspace-manager-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  configPaths = await import('./config-paths')
  manager = await import('./agent-workspace-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, 'xcodes'), { recursive: true, force: true })
  rmSync(join(tempHome, 'projects'), { recursive: true, force: true })
  mkdirSync(join(tempHome, 'xcodes'), { recursive: true })
  mkdirSync(join(tempHome, 'projects'), { recursive: true })
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

function writeWorkspaceSkill(workspaceSlug: string, skillSlug: string, name: string): void {
  const skillDir = join(configPaths.getWorkspaceSkillsDir(workspaceSlug), skillSlug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8')
}

function createProject(name: string): string {
  const projectPath = join(tempHome, 'projects', name)
  mkdirSync(projectPath, { recursive: true })
  return projectPath
}

describe('Agent 工作区 MCP 配置', () => {
  test('Given 工作区 MCP 包含内置保留名 When 归一化配置 Then 剔除冲突项并保留普通服务器', () => {
    const normalized = manager.normalizeWorkspaceMcpConfig({
      servers: {
        automation: {
          type: 'stdio',
          command: 'custom-automation',
          enabled: true,
        },
        nano_banana: {
          type: 'stdio',
          command: 'custom-nano',
          enabled: true,
        },
        github: {
          type: 'stdio',
          command: 'github-mcp',
          enabled: true,
        },
      },
    })

    expect(Object.keys(normalized.servers).sort()).toEqual(['github'])
    expect(normalized.servers.github?.command).toBe('github-mcp')
  })
})

describe('Agent 工作区创建', () => {
  test('Given 项目名称是 Windows 保留设备名 When 创建工作区 Then slug 避免直接使用保留名', () => {
    const projectPath = createProject('CON')
    const workspace = manager.createAgentWorkspace(projectPath)

    expect(workspace.slug).toBe('workspace-con')
    expect(workspace.canonicalPath).toBe(realpathSync.native(projectPath))
    expect(existsSync(configPaths.getAgentWorkspacePath(workspace.slug))).toBe(true)
  })

  test('Given 默认 Skill 包含 blocklist 目录 When 创建工作区 Then 初始化 Skills 时跳过高风险目录', () => {
    const defaultSkillDir = join(configPaths.getDefaultSkillsDir(), 'sample-skill')
    mkdirSync(join(defaultSkillDir, '.git', 'objects'), { recursive: true })
    mkdirSync(join(defaultSkillDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(defaultSkillDir, 'SKILL.md'), '---\nname: Sample\n---\n', 'utf-8')
    writeFileSync(join(defaultSkillDir, '.git', 'objects', 'locked'), 'skip', 'utf-8')
    writeFileSync(join(defaultSkillDir, 'node_modules', 'pkg', 'index.js'), 'skip', 'utf-8')

    const workspace = manager.createAgentWorkspace(createProject('Filtered Copy'))
    const copiedSkillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample-skill')

    expect(existsSync(join(copiedSkillDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(copiedSkillDir, '.git'))).toBe(false)
    expect(existsSync(join(copiedSkillDir, 'node_modules'))).toBe(false)
  })

  test('Given 同一本机目录被重复选择 When 添加项目 Then 复用原项目记录', () => {
    const projectPath = createProject('Proma')

    const first = manager.createAgentWorkspace(projectPath)
    const second = manager.createAgentWorkspace(projectPath)

    expect(second.id).toBe(first.id)
    expect(manager.listAgentWorkspaces()).toHaveLength(1)
  })

  test('Given 项目通过符号链接再次选择 When 添加项目 Then 按真实路径去重', () => {
    const projectPath = createProject('Claude Code')
    const aliasPath = join(tempHome, 'projects', 'ccb-alias')
    symlinkSync(projectPath, aliasPath, 'dir')

    const first = manager.createAgentWorkspace(projectPath)
    const second = manager.createAgentWorkspace(aliasPath)

    expect(second.id).toBe(first.id)
    expect(manager.listAgentWorkspaces()).toHaveLength(1)
  })

  test('Given 已添加的本机项目 When 从 Proma 移除 Then 只删除私有配置不删除项目目录', () => {
    const projectPath = createProject('Keep Me')
    writeFileSync(join(projectPath, 'README.md'), '# keep\n', 'utf-8')
    const workspace = manager.createAgentWorkspace(projectPath)
    const privateConfigPath = join(
      configPaths.getAgentWorkspacesDir(),
      workspace.slug,
    )

    manager.deleteAgentWorkspace(workspace.id)

    expect(existsSync(projectPath)).toBe(true)
    expect(existsSync(join(projectPath, 'README.md'))).toBe(true)
    expect(existsSync(privateConfigPath)).toBe(false)
  })

  test('Given v2 内部工作区索引 When 首次读取 Then 备份旧索引并清空项目列表', () => {
    const indexPath = configPaths.getAgentWorkspacesIndexPath()
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: 2,
        workspaces: [
          {
            id: 'legacy',
            name: '旧工作区',
            slug: 'legacy',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      'utf-8',
    )

    expect(manager.listAgentWorkspaces()).toEqual([])
    const backup = readdirSync(join(tempHome, 'xcodes')).find((name) =>
      name.startsWith('legacy-agent-workspaces-index-'),
    )
    expect(backup).toBeDefined()
  })
})

describe('Agent 工作区 Skill 扫描', () => {
  test('Given Skill 标识包含路径穿越 When 删除或切换 Then 拒绝访问 Skills 目录外路径', () => {
    expect(() => manager.deleteWorkspaceSkill('workspace-a', '../outside')).toThrow('Skill 标识 非法')
    expect(() => manager.toggleWorkspaceSkill('workspace-a', '../outside', false)).toThrow('Skill 标识 非法')
  })

  test('Given Skills 目录包含 broken symlink When 获取工作区 Skills Then 跳过坏条目并继续扫描后续 Skill', () => {
    const workspaceSlug = 'workspace-a'
    const skillsDir = configPaths.getWorkspaceSkillsDir(workspaceSlug)

    writeWorkspaceSkill(workspaceSlug, 'alpha', 'Alpha')
    symlinkSync(join(skillsDir, 'missing-target'), join(skillsDir, 'broken-link'), 'dir')
    writeWorkspaceSkill(workspaceSlug, 'zeta', 'Zeta')

    for (let i = 0; i < 20; i++) {
      const entryNames = readdirSync(skillsDir)
      const brokenIndex = entryNames.indexOf('broken-link')
      const hasSkillAfterBroken = entryNames.slice(brokenIndex + 1).some((name) => name !== 'missing-target')
      if (brokenIndex !== -1 && hasSkillAfterBroken) break
      writeWorkspaceSkill(workspaceSlug, `tail-${i}`, `Tail ${i}`)
    }

    const finalEntryNames = readdirSync(skillsDir)
    const finalBrokenIndex = finalEntryNames.indexOf('broken-link')
    expect(finalBrokenIndex).not.toBe(-1)
    expect(finalEntryNames.slice(finalBrokenIndex + 1).some((name) => name !== 'missing-target')).toBe(true)

    const expectedSlugs = finalEntryNames
      .filter((name) => name !== 'broken-link')
      .sort()
    const skills = manager.getWorkspaceSkills(workspaceSlug)

    expect(skills.map((skill) => skill.slug).sort()).toEqual(expectedSlugs)
  })
})
