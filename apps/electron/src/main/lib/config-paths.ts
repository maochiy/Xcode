/**
 * 配置路径工具
 *
 * 管理 Xcode 应用的本地配置文件路径。
 * 所有用户配置存储在 ~/xcodes/ 目录下。
 */

import {
  CONFIG_DIRECTORY_NAMES,
  getConfigDirectoryName,
  getLegacyConfigDirectoryName,
  isDevelopmentConfigRequested,
} from '@proma/shared/config'
import { join, basename } from 'node:path'
import { mkdirSync, existsSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { ensureMigratedConfigDirectory } from './config-directory-migration'

/**
 * 获取配置目录名称
 *
 * 开发模式下返回 'xcodes-dev'，正式版本返回 'xcodes'。
 *
 * 检测优先级：
 * 1. XCODE_DEV=1 或 PROMA_DEV=1 环境变量（显式开发模式）
 * 2. Electron app.isPackaged（未打包 = 开发模式）
 * 3. 兜底 'xcodes'
 */
let _configDirName: string | undefined
let _configDirPath: string | undefined

export function getConfigDirName(): string {
  if (_configDirName === undefined) {
    let development = isDevelopmentConfigRequested(process.env)
    if (!development) {
      try {
        const { app } = require('electron')
        development = !app.isPackaged
      } catch {
        development = false
      }
    }
    _configDirName = getConfigDirectoryName(development)
    const mode = _configDirName === CONFIG_DIRECTORY_NAMES.development
      ? '开发模式'
      : '正式版本'
    console.log(`[配置] 配置目录: ~/${_configDirName}/（${mode}）`)
  }
  return _configDirName
}

/** 获取当前运行模式对应的旧版配置目录路径。 */
export function getLegacyConfigDir(): string {
  const development = getConfigDirName() === CONFIG_DIRECTORY_NAMES.development
  return join(homedir(), getLegacyConfigDirectoryName(development))
}

/**
 * 获取配置目录路径
 *
 * 开发模式返回 ~/xcodes-dev/，正式版本返回 ~/xcodes/。
 * 首次使用时会安全迁移对应的旧 .proma 目录。
 */
export function getConfigDir(): string {
  if (_configDirPath === undefined) {
    const home = homedir()
    const configDirName = getConfigDirName()
    const result = ensureMigratedConfigDirectory({
      legacyDirectory: getLegacyConfigDir(),
      targetDirectory: join(home, configDirName),
    })
    _configDirPath = result.directory

    if (result.status === 'migrated') {
      console.log(`[配置] 已迁移旧配置目录到: ${result.directory}`)
    } else if (result.status === 'fresh') {
      console.log(`[配置] 已创建配置目录: ${result.directory}`)
    } else if (result.status === 'legacy-fallback') {
      console.warn(
        `[配置] 旧配置目录自动迁移失败 [${result.failureCategory ?? 'unknown'}]，`
        + '本次继续使用旧目录',
      )
    }
  }

  return _configDirPath
}

/**
 * 获取渠道配置文件路径
 *
 * @returns ~/xcodes/channels.json
 */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/**
 * 获取对话索引文件路径
 *
 * @returns ~/xcodes/conversations.json
 */
export function getConversationsIndexPath(): string {
  return join(getConfigDir(), 'conversations.json')
}

/**
 * 获取对话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/xcodes/conversations/
 */
export function getConversationsDir(): string {
  const dir = join(getConfigDir(), 'conversations')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建对话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的消息文件路径
 *
 * @param id 对话 ID
 * @returns ~/xcodes/conversations/{id}.jsonl
 */
export function getConversationMessagesPath(id: string): string {
  return join(getConversationsDir(), `${id}.jsonl`)
}

/**
 * 获取附件存储根目录
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/xcodes/attachments/
 */
export function getAttachmentsDir(): string {
  const dir = join(getConfigDir(), 'attachments')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建附件目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定对话的附件目录
 *
 * 如果目录不存在则自动创建。
 *
 * @param conversationId 对话 ID
 * @returns ~/xcodes/attachments/{conversationId}/
 */
export function getConversationAttachmentsDir(conversationId: string): string {
  const dir = join(getAttachmentsDir(), conversationId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/** 获取 Agent 会话附件目录。附件属于 Proma 私有数据，不作为 Agent cwd。 */
export function getAgentSessionAttachmentsDir(sessionId: string): string {
  const dir = join(getAttachmentsDir(), 'agent', sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 解析 Agent 会话附件目录，不创建目录。 */
export function resolveAgentSessionAttachmentsDir(sessionId: string): string {
  return join(getConfigDir(), 'attachments', 'agent', sessionId)
}

/**
 * 解析附件相对路径为完整路径
 *
 * @param localPath 相对路径 {conversationId}/{uuid}.ext
 * @returns 完整路径 ~/xcodes/attachments/{conversationId}/{uuid}.ext
 */
export function resolveAttachmentPath(localPath: string): string {
  return join(getAttachmentsDir(), localPath)
}

/**
 * 获取应用设置文件路径
 *
 * @returns ~/xcodes/settings.json
 */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json')
}

/**
 * 获取系统默认 App 探测缓存路径
 *
 * @returns ~/xcodes/default-apps.json
 */
export function getDefaultAppsCachePath(): string {
  return join(getConfigDir(), 'default-apps.json')
}

/**
 * 获取用户档案文件路径
 *
 * @returns ~/xcodes/user-profile.json
 */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/**
 * 获取 New API 登录状态文件路径
 *
 * 文件只保存登录方式、渠道引用和用户展示信息，不保存账号密码或明文 API Key。
 *
 * @returns ~/xcodes/new-api-auth.json
 */
export function getNewApiAuthPath(): string {
  return join(getConfigDir(), 'new-api-auth.json')
}

/**
 * 获取代理配置文件路径
 *
 * @returns ~/xcodes/proxy-settings.json
 */
export function getProxySettingsPath(): string {
  return join(getConfigDir(), 'proxy-settings.json')
}

/**
 * 获取系统提示词配置文件路径
 *
 * @returns ~/xcodes/system-prompts.json
 */
export function getSystemPromptsPath(): string {
  return join(getConfigDir(), 'system-prompts.json')
}

/** 多 Runtime 原生 Session 的本地隔离目录。 */
export function getRuntimeSessionsDir(): string {
  const dir = join(getConfigDir(), 'runtime-sessions')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Runtime Session 目录: ${dir}`)
  }
  return dir
}

/**
 * 获取 Chat 工具配置文件路径
 *
 * @returns ~/xcodes/chat-tools.json
 */
export function getChatToolsConfigPath(): string {
  return join(getConfigDir(), 'chat-tools.json')
}

/**
 * 获取 Agent 会话索引文件路径
 *
 * @returns ~/xcodes/agent-sessions.json
 */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/** Proma 计划生命周期历史（当前、待继续、归档与过期时间）。 */
export function getAgentRuntimePlansPath(): string {
  return join(getConfigDir(), 'agent-runtime-plans.json')
}

/** Proma Runtime 配置目录。 */
export function getRuntimeConfigDir(): string {
  const dir = join(getConfigDir(), 'runtimes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getRuntimeConfigPath(): string {
  return join(getRuntimeConfigDir(), 'config.json')
}

/** Runtime 托管包与运行数据的默认根目录。 */
export function getRuntimeHomeDir(configDirectory = getConfigDir()): string {
  return join(configDirectory, 'runtime')
}

/** Hermes 动态调度运行索引。 */
export function getRuntimeDispatchRunsPath(): string {
  return join(getRuntimeConfigDir(), 'dispatch-runs.json')
}

/** 旧多 Runtime 工作流索引，仅供兼容迁移。 */
export function getAgentWorkflowsPath(): string {
  return join(getConfigDir(), 'agent-workflows.json')
}

/**
 * 获取 Agent 会话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/xcodes/agent-sessions/
 */
export function getAgentSessionsDir(): string {
  const dir = join(getConfigDir(), 'agent-sessions')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 会话的消息文件路径
 *
 * @param id 会话 ID
 * @returns ~/xcodes/agent-sessions/{id}.jsonl
 */
export function getAgentSessionMessagesPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.jsonl`)
}

/**
 * 获取 Agent 工作区索引文件路径
 *
 * @returns ~/xcodes/agent-workspaces.json
 */
export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), 'agent-workspaces.json')
}

/**
 * 获取 Agent 工作区根目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/xcodes/agent-workspaces/
 */
export function getAgentWorkspacesDir(): string {
  const dir = join(getConfigDir(), 'agent-workspaces')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 工作区的目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/xcodes/agent-workspaces/{slug}/
 */
export function getAgentWorkspacePath(slug: string): string {
  const dir = join(getAgentWorkspacesDir(), slug)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区: ${dir}`)
  }

  return dir
}

/**
 * 获取指定工作区的 MCP 配置文件路径
 *
 * @param slug 工作区 slug
 * @returns ~/xcodes/agent-workspaces/{slug}/mcp.json
 */
export function getWorkspaceMcpPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'mcp.json')
}

/**
 * 获取指定工作区的 Skills 目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/xcodes/agent-workspaces/{slug}/skills/
 */
export function getWorkspaceSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取工作区文件目录路径
 *
 * 工作区内所有会话可访问的文件存放于此。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/xcodes/agent-workspaces/{slug}/workspace-files/
 */
export function getWorkspaceFilesDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'workspace-files')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析工作区文件目录路径（只读，不创建目录）
 *
 * 与 getWorkspaceFilesDir 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @returns ~/xcodes/agent-workspaces/{slug}/workspace-files/
 */
export function resolveWorkspaceFilesDir(slug: string): string {
  return join(getConfigDir(), 'agent-workspaces', slug, 'workspace-files')
}

/**
 * 获取工作区不活跃 Skills 目录路径
 *
 * 禁用的 Skill 会被移动到此目录，Agent SDK 不会扫描该目录。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/xcodes/agent-workspaces/{slug}/skills-inactive/
 */
export function getInactiveSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills-inactive')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取默认 Skills 模板目录路径
 *
 * 新建工作区时自动复制此目录的内容到工作区 skills/ 下。
 *
 * @returns ~/xcodes/default-skills/
 */
export function getDefaultSkillsDir(): string {
  const dir = join(getConfigDir(), 'default-skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取打包进 App 的 proma CLI 二进制路径。
 *
 * 打包模式下从 process.resourcesPath/bin 取（electron-builder extraResources 注入）。
 * 开发模式下没有编译二进制——返回 undefined，由调用方回退到源码运行
 * （bun apps/cli/src/index.ts）。
 *
 * @returns 二进制绝对路径；不存在时返回 undefined
 */
export function getBundledCliPath(): string | undefined {
  const { app } = require('electron')
  if (!app.isPackaged) return undefined
  const binName = process.platform === 'win32' ? 'proma.exe' : 'proma'
  const cliPath = join(process.resourcesPath, 'bin', binName)
  return existsSync(cliPath) ? cliPath : undefined
}

/**
 * 从 SKILL.md 的 YAML frontmatter 中解析 version 字段
 *
 * 无 version 字段时返回 '0.0.0'（确保旧 Skill 会被更新）。
 */
export function parseSkillVersion(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return '0.0.0'

  try {
    let content = readFileSync(skillMdPath, 'utf-8')
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch?.[1]) return '0.0.0'

    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'version' && value) return value
    }
  } catch {
    // 解析失败视为最低版本
  }

  return '0.0.0'
}

/** 比较两个 semver 版本字符串
 *
 * @returns 正数表示 a > b，0 表示相等，负数表示 a < b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 防御性目录基名集合：复制 default skills 时永远跳过这些目录，避免
 *  .git 0444 文件、node_modules 文件爆炸等场景把启动期同步链路炸掉。 */
const DEFAULT_SKILL_COPY_BLOCKLIST = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
])

function defaultSkillCopyFilter(src: string): boolean {
  return !DEFAULT_SKILL_COPY_BLOCKLIST.has(basename(src))
}

/**
 * 从 app bundle 同步默认 Skills 到 ~/xcodes/default-skills/
 *
 * 打包模式下从 process.resourcesPath/default-skills 复制。
 * 开发模式下从源码 default-skills/ 目录复制。
 *
 * - 缺失的 Skill：直接复制
 * - 已存在的 Skill：比较 SKILL.md 中的 version，bundled 更新时才覆盖
 *   （避免每次启动同步 4MB+ 文件阻塞主进程）
 */
export function seedDefaultSkills(): void {
  const { app } = require('electron')
  const bundledDir = app.isPackaged
    ? join(process.resourcesPath, 'default-skills')
    : join(__dirname, '../default-skills')

  if (!existsSync(bundledDir)) {
    console.log('[配置] 未找到内置 default-skills 目录，跳过')
    return
  }

  const userDir = getDefaultSkillsDir()

  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const source = join(bundledDir, entry.name)
      const target = join(userDir, entry.name)

      try {
        if (!existsSync(target)) {
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已同步默认 Skill: ${entry.name}`)
          continue
        }

        const bundledVer = parseSkillVersion(source)
        const existingVer = parseSkillVersion(target)

        if (compareSemver(bundledVer, existingVer) > 0) {
          // rm-then-cp：rmSync 不依赖目标文件写权限（只读 .git/objects/ 等
          // 0444 文件用 cpSync({ force: true }) 无法覆盖会 EACCES，但
          // rmSync({ force: true }) 只需父目录可写就能 unlink）。
          rmSync(target, { recursive: true, force: true })
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已升级默认 Skill: ${entry.name} (${existingVer} → ${bundledVer})`)
        }
      } catch (err) {
        // 单 skill 失败不影响其他 skill 同步。这里吞错是为了防止启动期 bootstrap
        // 链路被任意一个 skill 的同步异常掀翻——窗口和托盘必须先出来。
        console.warn(`[配置] 同步默认 Skill 失败 (${entry.name})，跳过:`, err)
      }
    }
  } catch (err) {
    console.warn('[配置] 同步默认 Skills 失败:', err)
  }
}

/**
 * 获取微信配置文件路径
 *
 * @returns ~/xcodes/wechat.json
 */
export function getWeChatConfigPath(): string {
  return join(getConfigDir(), 'wechat.json')
}

/**
 * 获取微信长轮询同步游标路径
 *
 * @returns ~/xcodes/wechat-sync.json
 */
export function getWeChatSyncPath(): string {
  return join(getConfigDir(), 'wechat-sync.json')
}

/**
 * 获取微信聊天绑定持久化路径
 *
 * @returns ~/xcodes/wechat-bindings.json
 */
export function getWeChatBindingsPath(): string {
  return join(getConfigDir(), 'wechat-bindings.json')
}

/**
 * 获取钉钉配置文件路径
 *
 * @returns ~/xcodes/dingtalk.json
 */
export function getDingTalkConfigPath(): string {
  return join(getConfigDir(), 'dingtalk.json')
}

/**
 * 获取某个钉钉 Bot 的聊天绑定持久化路径
 *
 * @returns ~/xcodes/dingtalk-bindings-{botId}.json
 */
export function getDingTalkBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `dingtalk-bindings-${botId}.json`)
}

/**
 * 获取飞书配置文件路径
 *
 * @returns ~/xcodes/feishu.json
 */
export function getFeishuConfigPath(): string {
  return join(getConfigDir(), 'feishu.json')
}

/**
 * 获取飞书聊天绑定持久化路径
 *
 * @returns ~/xcodes/feishu-bindings.json
 */
export function getFeishuBindingsPath(): string {
  return join(getConfigDir(), 'feishu-bindings.json')
}

/**
 * 获取某个飞书 Bot 的聊天绑定持久化路径
 *
 * @returns ~/xcodes/feishu-bindings-{botId}.json
 */
export function getFeishuBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `feishu-bindings-${botId}.json`)
}

/**
 * 获取某个飞书 Bot 的运行时元数据持久化路径
 *
 * 用于保存最近交互用户 open_id 等需要跨进程重启恢复的状态。
 *
 * @returns ~/xcodes/feishu-metadata-{botId}.json
 */
export function getFeishuBotMetadataPath(botId: string): string {
  return join(getConfigDir(), `feishu-metadata-${botId}.json`)
}

/**
 * 获取 Scratch Pad 文件路径
 *
 * @returns ~/xcodes/scratch-pad.md
 */
export function getScratchPadPath(): string {
  return join(getConfigDir(), 'scratch-pad.md')
}

/**
 * 获取定时任务（Automation）配置文件路径
 *
 * @returns ~/xcodes/automations.json
 */
export function getAutomationsPath(): string {
  return join(getConfigDir(), 'automations.json')
}

/**
 * 获取任务看板（Taskboard）数据目录
 *
 * @returns ~/xcodes/taskboard/
 */
export function getTaskboardDir(): string {
  return join(getConfigDir(), 'taskboard')
}

/**
 * 获取任务看板项目索引路径
 *
 * @returns ~/xcodes/taskboard/projects.json
 */
export function getTaskboardProjectsPath(): string {
  return join(getTaskboardDir(), 'projects.json')
}

/**
 * 获取任务看板任务存储路径（JSONL，每任务一行）
 *
 * @returns ~/xcodes/taskboard/tasks.jsonl
 */
export function getTaskboardTasksPath(): string {
  return join(getTaskboardDir(), 'tasks.jsonl')
}

/**
 * 获取任务看板评论存储路径
 *
 * @returns ~/xcodes/taskboard/comments.json
 */
export function getTaskboardCommentsPath(): string {
  return join(getTaskboardDir(), 'comments.json')
}

/**
 * 获取任务看板活动时间线存储路径
 *
 * @returns ~/xcodes/taskboard/activities.json
 */
export function getTaskboardActivitiesPath(): string {
  return join(getTaskboardDir(), 'activities.json')
}

/**
 * 获取任务看板附件元数据存储路径
 *
 * @returns ~/xcodes/taskboard/attachments.json
 */
export function getTaskboardAttachmentsMetadataPath(): string {
  return join(getTaskboardDir(), 'attachments.json')
}

/**
 * 获取任务看板附件正文目录
 *
 * @returns ~/xcodes/taskboard/attachments/
 */
export function getTaskboardAttachmentsDir(): string {
  return join(getTaskboardDir(), 'attachments')
}

/**
 * 获取任务看板单个附件正文路径
 *
 * @returns ~/xcodes/taskboard/attachments/{id}
 */
export function getTaskboardAttachmentStoragePath(id: string): string {
  return join(getTaskboardAttachmentsDir(), id)
}

/**
 * 获取任务看板关系存储路径
 *
 * @returns ~/xcodes/taskboard/relations.json
 */
export function getTaskboardRelationsPath(): string {
  return join(getTaskboardDir(), 'relations.json')
}
