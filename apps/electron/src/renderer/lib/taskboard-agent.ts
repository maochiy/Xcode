/**
 * taskboard-agent — 任务看板与 Code（Agent）模式联动
 *
 * 集中处理任务→会话的自动执行与摘要提取：
 * - runTaskSession：任务进入处理中时自动创建 Agent 会话并触发执行
 * - extractTaskSessionSummary：从会话消息中提取最新进度 / 阻塞原因
 * - loadTaskboardModelOptions：为任务编辑对话框加载可执行模型列表
 */

import type {
  AgentRuntimeModelCatalog,
  AgentSendInput,
  AgentSessionMeta,
  Channel,
  ModelOption,
  SDKContentBlock,
  SDKMessage,
  Task,
} from '@proma/shared'
import { buildAgentAppModelOptions } from '@/lib/agent-runtime-model-options'

/** 任务会话自动执行时使用的默认用户提示词 */
export function buildTaskRunPrompt(task: Task): string {
  const lines = [
    `请执行任务「${task.title}」`,
  ]
  if (task.description.trim()) {
    lines.push('', '任务描述：', task.description.trim())
  }
  lines.push('', '请先了解任务上下文，明确执行步骤后开始工作，完成后总结结果。')
  return lines.join('\n')
}

/** 解析当前工作区+渠道下的可用模型列表（与 AgentView 一致的过滤逻辑） */
export function buildTaskboardModelOptions(input: {
  channelId: string | null | undefined
  catalog?: AgentRuntimeModelCatalog
  channels: readonly Channel[]
}): ModelOption[] {
  return buildAgentAppModelOptions(input)
}

/** 把 SDK 消息中的 assistant 文本块拼接成摘要文本 */
function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  const inner = (message as { message?: { content?: unknown } }).message
  if (!inner || !Array.isArray(inner.content)) return ''
  const parts: string[] = []
  for (const block of inner.content as SDKContentBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim())
    }
  }
  return parts.join('\n')
}

/** 截断长文本为摘要（保留前 N 字符，带省略号） */
function clipSummary(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, maxLength)}…`
}

/**
 * 从会话消息中提取最新进度摘要。
 *
 * 规则：取最后一条非空的 assistant 文本（最新一轮输出），截断展示。
 */
export function extractTaskSessionSummary(
  messages: readonly SDKMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message) continue
    const text = extractAssistantText(message)
    if (text) return clipSummary(text)
  }
  return null
}

/**
 * 从会话消息中提取阻塞原因摘要。
 *
 * 规则：优先取最后的 assistant 文本；若没有则回退到最后一条 user 消息
 * （原始任务描述）作为线索。
 */
export function extractTaskBlockedReason(
  messages: readonly SDKMessage[],
): string | null {
  const assistant = extractTaskSessionSummary(messages)
  if (assistant) return assistant
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.type !== 'user') continue
    const inner = (message as { message?: { content?: unknown } }).message
    if (!inner || !Array.isArray(inner.content)) continue
    for (const block of inner.content as SDKContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return clipSummary(block.text.trim(), 200)
      }
    }
  }
  return null
}

/** 判断会话是否正在运行（从 stream states 或 meta 推导） */
export function isSessionRunning(
  session: AgentSessionMeta,
  runningSessionIds: ReadonlySet<string>,
): boolean {
  return runningSessionIds.has(session.id)
    || session.runtimeWorkerState === 'busy'
    || session.runtimeWorkerState === 'starting'
    || session.runtimeWorkerState === 'ready'
}

/** 构造任务自动执行时的 AgentSendInput */
export function buildTaskRunInput(input: {
  sessionId: string
  task: Task
  channelId: string | null | undefined
  modelId: string | null | undefined
  workspaceId: string | null | undefined
  runtimeThinking?: NonNullable<AgentSendInput['runtimeThinking']>
  permissionModeOverride?: AgentSendInput['permissionModeOverride']
}): AgentSendInput {
  return {
    sessionId: input.sessionId,
    userMessage: buildTaskRunPrompt(input.task),
    channelId: input.channelId ?? '',
    modelId: input.modelId ?? undefined,
    workspaceId: input.workspaceId ?? undefined,
    runtimeThinking: input.runtimeThinking,
    permissionModeOverride: input.permissionModeOverride,
    triggeredBy: 'automation',
  }
}
