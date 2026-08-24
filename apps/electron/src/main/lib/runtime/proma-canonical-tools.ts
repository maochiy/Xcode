/**
 * Proma canonical 工具（proma_*）的主进程实现。
 *
 * Pi Worker 声明了这些工具，但宿主原先把所有 tool.request 丢给 MCP 桥，
 * 导致「未知的 Pi 外部工具」。这里把已有的 auto-memory / 工作区文档 / 看板
 * 包成 Agent 可调用的最小服务；未实现的工具返回明确说明，而不是未知工具。
 */

import { TASKBOARD_CODEX_AGENT, TASK_STATUSES, type Task, type TaskStatus } from '@proma/shared'
import {
  getWorkspaceSkills,
  listWorkspaceAutoMemoryFiles,
  readWorkspaceAutoMemoryFile,
  readWorkspaceClaudeMd,
  readWorkspaceSkillContent,
  writeWorkspaceAutoMemoryFile,
} from '../agent-workspace-manager'
import { TaskboardError, TaskboardStore, taskboardStore } from '../taskboard/taskboard-store'

export interface PromaCanonicalToolContext {
  sessionId?: string
  workspaceSlug?: string
  taskStore?: TaskboardStore
}

const UNSUPPORTED_KNOWLEDGE_TOOLS = new Set([
  'proma_knowledge_source_propose',
  'proma_knowledge_changes_propose',
  'proma_knowledge_rules_propose',
  'proma_knowledge_lint',
  'proma_knowledge_draft_write',
])

const TASK_STATUS_ALIASES: Record<string, TaskStatus> = {
  backlog: 'backlog',
  todo: 'todo',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  'in-progress': 'in_progress',
  in_review: 'in_review',
  inreview: 'in_review',
  'in-review': 'in_review',
  blocked: 'blocked',
  done: 'done',
  complete: 'done',
  completed: 'done',
  canceled: 'canceled',
  cancelled: 'canceled',
}

export function isPromaCanonicalTool(name: string): boolean {
  return name.startsWith('proma_')
}

function textParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value.trim() : ''
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function flattenMemoryFiles(
  nodes: ReturnType<typeof listWorkspaceAutoMemoryFiles>,
): Array<{ relativePath: string; name: string }> {
  const files: Array<{ relativePath: string; name: string }> = []
  const walk = (items: typeof nodes): void => {
    for (const node of items) {
      if (node.type === 'file') files.push({ relativePath: node.relativePath, name: node.name })
      if (node.children?.length) walk(node.children)
    }
  }
  walk(nodes)
  return files
}

function snippetAround(content: string, query: string, radius = 160): string {
  const lower = content.toLowerCase()
  const needle = query.toLowerCase()
  const index = lower.indexOf(needle)
  if (index < 0) return content.slice(0, radius).trim()
  const start = Math.max(0, index - radius)
  const end = Math.min(content.length, index + needle.length + radius)
  return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`
}

function requireWorkspace(context: PromaCanonicalToolContext): string {
  const slug = context.workspaceSlug?.trim()
  if (!slug) throw new Error('当前会话没有工作区，无法访问 Proma 记忆或知识。')
  return slug
}

function storeOf(context: PromaCanonicalToolContext): TaskboardStore {
  return context.taskStore || taskboardStore
}

function taskSummary(task: Task) {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    version: task.version,
    description: task.description?.slice(0, 400) || '',
  }
}

async function searchMemory(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const slug = requireWorkspace(context)
  const query = textParam(params, 'query')
  if (!query) throw new Error('proma_memory_search 需要 query。')
  const limit = Math.min(Math.max(numberParam(params, 'limit', 8), 1), 20)
  const files = flattenMemoryFiles(listWorkspaceAutoMemoryFiles(slug))
  const hits: Array<{ path: string; snippet: string }> = []
  for (const file of files) {
    const body = readWorkspaceAutoMemoryFile(slug, file.relativePath)
    if (!body.isText || !body.content) continue
    if (!body.content.toLowerCase().includes(query.toLowerCase())) continue
    hits.push({ path: file.relativePath, snippet: snippetAround(body.content, query) })
    if (hits.length >= limit) break
  }
  return { query, count: hits.length, hits }
}

async function proposeMemory(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const slug = requireWorkspace(context)
  const fact = textParam(params, 'fact')
  if (!fact) throw new Error('proma_memory_propose 需要 fact。')
  const kind = textParam(params, 'kind') || 'agent_experience'
  const scope = textParam(params, 'scope') || 'vault'
  const existing = readWorkspaceAutoMemoryFile(slug, 'MEMORY.md')
  const stamp = new Date().toISOString()
  const block = `\n\n## ${stamp}\n- kind: ${kind}\n- scope: ${scope}\n- ${fact}\n`
  writeWorkspaceAutoMemoryFile(slug, 'MEMORY.md', `${existing.content || ''}${block}`)
  return { written: true, path: 'MEMORY.md', kind, scope }
}

function knowledgeDocuments(slug: string): Array<{ path: string; kind: string; content: string }> {
  const documents: Array<{ path: string; kind: string; content: string }> = []
  const claude = readWorkspaceClaudeMd(slug)
  if (claude.content) documents.push({ path: 'CLAUDE.md', kind: 'claude_md', content: claude.content })
  for (const skill of getWorkspaceSkills(slug)) {
    if (!skill.enabled) continue
    let content = skill.description || ''
    try {
      content = readWorkspaceSkillContent(slug, skill.slug) || content
    } catch { /* 只读失败时退回简介 */ }
    documents.push({
      path: `skills/${skill.slug}/SKILL.md`,
      kind: 'skill',
      content,
    })
  }
  for (const file of flattenMemoryFiles(listWorkspaceAutoMemoryFiles(slug))) {
    const body = readWorkspaceAutoMemoryFile(slug, file.relativePath)
    if (!body.isText || !body.content) continue
    documents.push({ path: `.claude/memory/${file.relativePath}`, kind: 'memory', content: body.content })
  }
  return documents
}

async function searchKnowledge(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const slug = requireWorkspace(context)
  const query = textParam(params, 'query')
  if (!query) throw new Error('proma_knowledge_search 需要 query。')
  const limit = Math.min(Math.max(numberParam(params, 'limit', 8), 1), 20)
  const hits = knowledgeDocuments(slug)
    .filter((doc) => doc.content.toLowerCase().includes(query.toLowerCase()))
    .slice(0, limit)
    .map((doc) => ({ path: doc.path, kind: doc.kind, snippet: snippetAround(doc.content, query) }))
  return { query, count: hits.length, hits }
}

async function readKnowledge(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const slug = requireWorkspace(context)
  const path = textParam(params, 'path')
  if (!path) throw new Error('proma_knowledge_read 需要 path。')
  const documents = knowledgeDocuments(slug)
  const match = documents.find((doc) => doc.path === path || doc.path.endsWith(path))
  if (!match) throw new Error(`未找到知识文档：${path}`)
  return { path: match.path, kind: match.kind, content: match.content.slice(0, 12_000) }
}

async function knowledgeStatus(context: PromaCanonicalToolContext) {
  const slug = requireWorkspace(context)
  const documents = knowledgeDocuments(slug).map((doc) => ({ path: doc.path, kind: doc.kind, chars: doc.content.length }))
  return { workspaceSlug: slug, count: documents.length, documents }
}

function resolveTaskStatus(value: string): TaskStatus {
  const mapped = TASK_STATUS_ALIASES[value.trim().toLowerCase()]
  if (!mapped) throw new Error(`不支持的任务状态：${value}。可用：${TASK_STATUSES.join(', ')}`)
  return mapped
}

async function getTask(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const store = storeOf(context)
  const taskId = textParam(params, 'taskId')
  if (taskId) {
    const task = store.getTask(taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)
    return taskSummary(task)
  }
  return {
    tasks: store.listTasks({ archived: 'false' }).slice(0, 20).map(taskSummary),
  }
}

async function updateTask(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const store = storeOf(context)
  const taskId = textParam(params, 'taskId')
  if (!taskId) throw new Error('proma_task_update 需要 taskId。')
  const current = store.getTask(taskId)
  if (!current) throw new Error(`任务不存在：${taskId}`)
  const statusValue = textParam(params, 'status')
  const detail = textParam(params, 'detail')
  const updated = store.updateTask({
    id: current.id,
    version: current.version,
    ...(statusValue ? { status: resolveTaskStatus(statusValue) } : {}),
    ...(detail ? { description: detail } : {}),
    actor: TASKBOARD_CODEX_AGENT,
  })
  return taskSummary(updated)
}

async function completeTask(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const store = storeOf(context)
  const taskId = textParam(params, 'taskId')
  if (!taskId) throw new Error('proma_task_complete 需要 taskId。')
  const current = store.getTask(taskId)
  if (!current) throw new Error(`任务不存在：${taskId}`)
  const summary = textParam(params, 'summary')
  const updated = store.updateTask({
    id: current.id,
    version: current.version,
    status: 'done',
    ...(summary ? { description: [current.description, `完成摘要：${summary}`].filter(Boolean).join('\n\n') } : {}),
    actor: TASKBOARD_CODEX_AGENT,
  })
  if (summary) {
    store.createComment({
      taskId: current.id,
      body: summary,
      actor: TASKBOARD_CODEX_AGENT,
      threadId: context.sessionId || null,
    })
  }
  return taskSummary(updated)
}

async function requestTaskInput(context: PromaCanonicalToolContext, params: Record<string, unknown>) {
  const store = storeOf(context)
  const taskId = textParam(params, 'taskId')
  const question = textParam(params, 'question')
  if (!taskId) throw new Error('proma_task_request_input 需要 taskId。')
  if (!question) throw new Error('proma_task_request_input 需要 question。')
  const current = store.getTask(taskId)
  if (!current) throw new Error(`任务不存在：${taskId}`)
  const updated = store.updateTask({
    id: current.id,
    version: current.version,
    status: 'blocked',
    actor: TASKBOARD_CODEX_AGENT,
  })
  store.createComment({
    taskId: current.id,
    body: `需要用户输入：${question}`,
    actor: TASKBOARD_CODEX_AGENT,
    threadId: context.sessionId || null,
  })
  return { ...taskSummary(updated), question }
}

export async function handlePromaCanonicalTool(
  name: string,
  params: Record<string, unknown> = {},
  context: PromaCanonicalToolContext = {},
): Promise<unknown> {
  if (UNSUPPORTED_KNOWLEDGE_TOOLS.has(name)) {
    return { supported: false, tool: name, message: '当前仅支持知识检索（search/read/status），写入/lint 尚未接通。' }
  }
  switch (name) {
    case 'proma_memory_search':
      return searchMemory(context, params)
    case 'proma_memory_propose':
      return proposeMemory(context, params)
    case 'proma_knowledge_search':
      return searchKnowledge(context, params)
    case 'proma_knowledge_read':
      return readKnowledge(context, params)
    case 'proma_knowledge_status':
      return knowledgeStatus(context)
    case 'proma_task_get':
      return getTask(context, params)
    case 'proma_task_update':
      return updateTask(context, params)
    case 'proma_task_complete':
      return completeTask(context, params)
    case 'proma_task_request_input':
      return requestTaskInput(context, params)
    case 'proma_artifact_publish':
      throw new Error('proma_artifact_publish 尚未实现，请直接把文件写到工作区后告知用户路径。')
    case 'proma_agent_handoff':
      throw new Error('proma_agent_handoff 尚未实现。内核切换由 Proma Dispatch Policy 负责，不要自行交接。')
    default:
      throw new Error(`未知的 Proma canonical 工具：${name}`)
  }
}

export function canonicalToolError(error: unknown): string {
  if (error instanceof TaskboardError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
