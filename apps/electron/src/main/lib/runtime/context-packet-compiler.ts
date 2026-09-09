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
  getWorkspaceAutoMemoryDir,
  readWorkspaceClaudeMd,
  listWorkspaceAutoMemoryFiles,
} from '../agent-workspace-manager'
import { getWorkspaceSkillsDir } from '../config-paths'
import { getAgentSessionMessages } from '../agent-session-manager'
import { getUserProfile } from '../user-profile-service'
import { getRuntimeCapabilities } from './runtime-registry'
import type { DispatchRun } from '@proma/shared'
import { listBuiltinMcpServers } from '../builtin-mcp/catalog'
import { EXECUTABLE_RUNTIME_ID } from './pi-runtime-policy'
import { join } from 'node:path'
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

function runtimeCapabilities(): Partial<Record<RuntimeCapability, 'supported' | 'partial' | 'unsupported' | 'unknown'>> {
  return getRuntimeCapabilities(EXECUTABLE_RUNTIME_ID).capabilities
}

function piTaskGraph(taskGraph: RuntimeTaskGraph | null | undefined): RuntimeTaskGraph | null {
  if (!taskGraph) return null
  return {
    ...taskGraph,
    tasks: taskGraph.tasks.map((task) => ({
      ...task,
      runtimeId: EXECUTABLE_RUNTIME_ID,
      harnessId: EXECUTABLE_RUNTIME_ID,
    })),
  }
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
    ? getWorkspaceSkills(workspaceSlug).map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.runtimePath
          ? join(skill.runtimePath, 'SKILL.md')
          : join(getWorkspaceSkillsDir(workspaceSlug), skill.slug, 'SKILL.md'),
      }))
    : []
  const autoMemoryFiles = workspaceSlug ? readMemoryFiles(workspaceSlug) : []
  const attachedDirectories = workspaceSlug ? getWorkspaceAttachedDirectories(workspaceSlug) : []
  const attachedFiles = workspaceSlug ? getWorkspaceAttachedFiles(workspaceSlug) : []
  const messages = recentMessages(input.sessionId, input.recentMessageLimit ?? 24)
  const capabilities = runtimeCapabilities()
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
    taskGraph: piTaskGraph(input.taskGraph),
    artifacts: input.artifacts || [],
    runtime: {
      runtimeId: EXECUTABLE_RUNTIME_ID,
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
