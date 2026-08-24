/**
 * Proma Runtime 动态调度类型。
 *
 * 这些类型描述 Hermes 的内部任务图，不是产品 Workflow UI 的数据模型。
 * 任务图可以按策略增删任务、调整依赖和 Runtime，不能假设固定阶段顺序。
 */

import type { BrowserAnnotation } from './browser'
import type { HarnessId, RuntimeCapability, RuntimeId } from './runtime'

/** Proma 模型中心可选择并传递给 Runtime 的标准供应商协议。 */
export type PromaRuntimeApiMode =
  | 'anthropic_messages'
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'openai_responses_oauth'
  | 'google_generative_language'
  | 'legacy-compat'

export type RuntimeTaskKind =
  | 'conversation'
  | 'clarification'
  | 'coordination'
  | 'planning'
  | 'implementation'
  | 'review'
  | 'summary'
  | 'research'

export type RuntimeTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'waiting_approval'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type DispatchRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface RuntimeTaskArtifact {
  id: string
  taskId: string
  kind: string
  content: string
  createdAt: number
}

export interface RuntimeTask {
  id: string
  title: string
  kind: RuntimeTaskKind
  runtimeId: RuntimeId
  harnessId: HarnessId
  status: RuntimeTaskStatus
  dependsOn: string[]
  inputArtifactIds: string[]
  outputArtifactIds: string[]
  requiresUserApproval: boolean
  approvalState: 'not_required' | 'pending' | 'approved' | 'rejected'
  retryCount: number
  maxRetries: number
  timeoutMs: number | null
  prompt: string
  result: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface RuntimeTaskGraph {
  id: string
  rootTaskId: string
  tasks: RuntimeTask[]
  revision: number
  createdAt: number
  updatedAt: number
}

export interface DispatchPlan {
  id: string
  /** 生成任务图时的原始用户需求，用于确认后创建下一版动态计划。 */
  prompt?: string
  intent: string
  strategyId: string
  graph: RuntimeTaskGraph
  requiresRequirementsConfirmation: boolean
  requiresPlanApproval: boolean
  generatedBy: 'policy' | 'hermes'
  createdAt: number
}

export interface DispatchRun {
  id: string
  sessionId: string
  workspaceId: string | null
  status: DispatchRunStatus
  plan: DispatchPlan
  artifacts: RuntimeTaskArtifact[]
  approvedTaskIds: string[]
  currentTaskId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface RuntimeExecutionRequest {
  runId: string
  taskId: string
  sessionId: string
  runtimeId: RuntimeId
  harnessId: HarnessId
  prompt: string
  cwd?: string
  model?: string
  modelRoute?: RuntimeModelRoute
  contextPacket?: ContextPacket
}

export interface RuntimeModelRoute {
  routeRevision: string
  runtimeId: RuntimeId
  channelId: string
  modelId: string
  provider: string
  baseUrl: string
  apiMode: PromaRuntimeApiMode
  credentialRevision: string
  capabilities: Partial<Record<RuntimeCapability, 'supported' | 'partial' | 'unsupported' | 'unknown'>>
  source: 'proma-channel' | 'legacy-compat'
  /**
   * 模型上下文压缩策略。
   *
   * Hermes 调度后台 Harness（Claude Code / Codex）或 Pi 内核时，把用户对
   * 模型配置的压缩阈值同步过去，让后台任务按同样的阈值自动压缩上下文。
   * 后台 Harness 的压缩事件不进入主会话 UI，只保证运行期上下文不超限。
   */
  compaction?: {
    /** 是否启用自动压缩 */
    enabled: boolean
    /** 压缩触发阈值（token 数）；未配置时由内核按 contextWindow × 0.8 兜底 */
    threshold?: number
    /** 模型上下文窗口（token） */
    contextWindow?: number
  }
}

export interface ContextPacket {
  schemaVersion: 1
  packetId: string
  sessionId: string
  workspaceId: string | null
  compiledAt: number
  profile: {
    userName: string
    avatar: string
  }
  conversation: {
    recentMessages: Array<{ role: string; content: string }>
    messageCount: number
  }
  workspace: {
    name: string
    slug: string
    path: string
    rules: string[]
    attachedDirectories: string[]
    attachedFiles: string[]
  }
  memory: {
    claudeMd: string
    autoMemoryFiles: string[]
  }
  skills: Array<{ name: string; description?: string; path?: string; content?: string }>
  mcp: {
    enabledServers: string[]
    builtinServers: string[]
  }
  attachments: string[]
  browserAnnotations: BrowserAnnotation[]
  taskGraph: RuntimeTaskGraph | null
  artifacts: RuntimeTaskArtifact[]
  runtime: {
    runtimeId: RuntimeId
    capabilities: Partial<Record<RuntimeCapability, 'supported' | 'partial' | 'unsupported' | 'unknown'>>
  }
  model: {
    modelId: string
    provider: string
    routeRevision: string
  }
  dispatchPolicy: {
    strategyId: string
    instruction: string
  }
}

export interface RuntimeDispatchStore {
  runs: DispatchRun[]
  updatedAt: number
}
