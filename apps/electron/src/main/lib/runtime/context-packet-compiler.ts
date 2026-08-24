/**
 * Proma Context Packet 编译器。
 *
 * 统一收集 Proma 已有的 Profile、会话、工作区、Skills、MCP、Memory、附件、
 * 浏览器标注和 Hermes 任务产物，再按 Runtime 投影到不同 Harness。
 */

import type {
  AgentMessage,
  AgentWorkspace,
  BrowserAnnotation,
  ContextPacket,
  RuntimeCapability,
  RuntimeId,
  RuntimeModelRoute,
  RuntimeTaskArtifact,
  RuntimeTaskGraph,
} from '@proma/shared'
import {
  getWorkspaceAttachedDirectories,
  getWorkspaceAttachedFiles,
  getWorkspaceMcpConfig,
  getWorkspaceSkills,
  readWorkspaceSkillContent,
  getWorkspaceAutoMemoryDir,
  readWorkspaceClaudeMd,
  listWorkspaceAutoMemoryFiles,
} from '../agent-workspace-manager'
import { getAgentSessionMessages } from '../agent-session-manager'
import { getUserProfile } from '../user-profile-service'
import { getRuntimeCapabilities } from './runtime-registry'
import type { DispatchRun } from '@proma/shared'
import { listBuiltinMcpServers } from '../builtin-mcp/catalog'
export { contextPacketText } from './context-packet-text'

export interface CompileContextPacketInput {
  sessionId: string
  workspace?: AgentWorkspace
  modelRoute: RuntimeModelRoute
  runtimeId: RuntimeId
  browserAnnotations?: BrowserAnnotation[]
  attachments?: string[]
  taskGraph?: RuntimeTaskGraph | null
  artifacts?: RuntimeTaskArtifact[]
  strategyId: string
  strategyInstruction: string
  recentMessageLimit?: number
}

/** Skill 全文注入预算上限（字符）。防止大 Skill 全文挤爆上下文，超出只保留简介。 */
const SKILL_CONTENT_BUDGET = 12000
/** 单个 Skill 全文最大长度（字符）。 */
const SKILL_CONTENT_MAX_LENGTH = 4000

function contentOfMessage(message: AgentMessage): string {
  return typeof message.content === 'string' ? message.content : ''
}

function recentMessages(sessionId: string, limit: number): Array<{ role: string; content: string }> {
  if (limit <= 0) return []
  const messages = getAgentSessionMessages(sessionId)
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-limit)
    .map((message) => ({ role: message.role, content: contentOfMessage(message) }))
}

function runtimeCapabilities(runtimeId: RuntimeId): Partial<Record<RuntimeCapability, 'supported' | 'partial' | 'unsupported' | 'unknown'>> {
  return getRuntimeCapabilities(runtimeId).capabilities
}

function readMemoryFiles(workspaceSlug: string): string[] {
  try {
    const root = getWorkspaceAutoMemoryDir(workspaceSlug)
    return listWorkspaceAutoMemoryFiles(workspaceSlug)
      .filter((node) => node.type === 'file')
      .map((node) => `${root}/${node.relativePath}`)
  } catch {
    return []
  }
}

function readClaudeMd(workspaceSlug: string): string {
  try {
    return readWorkspaceClaudeMd(workspaceSlug).content || ''
  } catch {
    return ''
  }
}

function workspaceRules(workspace: AgentWorkspace | undefined, claudeMd: string): string[] {
  const rules = claudeMd
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => line.slice(2).trim())
  return Array.from(new Set([
    ...(workspace ? [`工作区：${workspace.name}`, `项目路径：${workspace.canonicalPath || workspace.path}`] : []),
    ...rules,
  ]))
}

function enabledMcpNames(workspaceSlug: string | undefined): { enabled: string[]; builtin: string[] } {
  if (!workspaceSlug) return { enabled: [], builtin: [] }
  const config = getWorkspaceMcpConfig(workspaceSlug)
  const enabled = Object.entries(config.servers)
    .filter(([, entry]) => entry.enabled)
    .map(([name]) => name)
  const builtin = listBuiltinMcpServers({ workspaceSlug }).map((server) => server.name)
  return { enabled, builtin }
}

export function compileContextPacket(input: CompileContextPacketInput): ContextPacket {
  const profile = getUserProfile()
  const workspaceSlug = input.workspace?.slug
  const claudeMd = workspaceSlug ? readClaudeMd(workspaceSlug) : ''
  const mcp = enabledMcpNames(workspaceSlug)
  const skills = workspaceSlug
    ? (() => {
        const metas = getWorkspaceSkills(workspaceSlug)
        let used = 0
        return metas.map((skill) => {
          // 读取 SKILL.md 全文注入 Context Packet，让 Pi/Hermes/Codex/Claude Code
          // 都能看到完整触发条件与操作约定（否则只有 name+description 一行，
          // 模型无法按 Skill 标准流程执行，例如 computer-use 的内置 browser MCP 路由约束）。
          // 受总量与单条预算约束，避免大 Skill 全文挤爆上下文。
          let content = ''
          const remainingBudget = SKILL_CONTENT_BUDGET - used
          if (remainingBudget > 0) {
            try {
              const raw = readWorkspaceSkillContent(workspaceSlug, skill.slug)
              content = raw.slice(0, SKILL_CONTENT_MAX_LENGTH)
              used += content.length
            } catch {
              content = ''
            }
          }
          return {
            name: skill.name,
            description: skill.description,
            path: skill.runtimePath,
            ...(content ? { content } : {}),
          }
        })
      })()
    : []
  const autoMemoryFiles = workspaceSlug ? readMemoryFiles(workspaceSlug) : []
  const attachedDirectories = workspaceSlug ? getWorkspaceAttachedDirectories(workspaceSlug) : []
  const attachedFiles = workspaceSlug ? getWorkspaceAttachedFiles(workspaceSlug) : []
  const messages = recentMessages(input.sessionId, input.recentMessageLimit ?? 24)
  const capabilities = runtimeCapabilities(input.runtimeId)
  const now = Date.now()

  return {
    schemaVersion: 1,
    packetId: `context-${input.sessionId}`,
    sessionId: input.sessionId,
    workspaceId: input.workspace?.id || null,
    compiledAt: now,
    profile: {
      userName: profile.userName,
      avatar: profile.avatar,
    },
    conversation: {
      recentMessages: messages,
      messageCount: getAgentSessionMessages(input.sessionId).length,
    },
    workspace: {
      name: input.workspace?.name || '默认工作区',
      slug: input.workspace?.slug || '',
      path: input.workspace?.canonicalPath || input.workspace?.path || '',
      rules: workspaceRules(input.workspace, claudeMd),
      attachedDirectories,
      attachedFiles,
    },
    memory: {
      claudeMd,
      autoMemoryFiles,
    },
    skills,
    mcp: {
      enabledServers: mcp.enabled,
      builtinServers: mcp.builtin,
    },
    attachments: input.attachments || attachedFiles,
    browserAnnotations: input.browserAnnotations || [],
    taskGraph: input.taskGraph || null,
    artifacts: input.artifacts || [],
    runtime: {
      runtimeId: input.runtimeId,
      capabilities,
    },
    model: {
      modelId: input.modelRoute.modelId,
      provider: input.modelRoute.provider,
      routeRevision: input.modelRoute.routeRevision,
    },
    dispatchPolicy: {
      strategyId: input.strategyId,
      instruction: input.strategyInstruction,
    },
  }
}

export function contextPacketFromRun(
  input: CompileContextPacketInput,
  run: DispatchRun,
): ContextPacket {
  return compileContextPacket({
    ...input,
    taskGraph: run.plan.graph,
    // 子任务只需要依赖链上的产物。若把整个 Run 的产物都投影进去，
    // 后续任务会收到与当前任务无关的结果，并且增加上下文超限风险。
    artifacts: input.artifacts ?? run.artifacts,
  })
}
