import type {
  AgentQueryInput,
  AgentRuntimeProviderConfiguration,
  PromaPermissionMode,
  SDKMessage,
  ThinkingConfig,
  ThinkingEffortLevel,
} from '@proma/shared'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'

/**
 * Proma 交给 Pi 的查询上下文。模型、权限和工作目录由宿主显式指定。
 */
export interface PiAgentQueryOptions extends AgentQueryInput {
  channelId?: string
  env?: Record<string, string | undefined>
  providerConfiguration?: AgentRuntimeProviderConfiguration
  thinkingConfig?: ThinkingConfig
  effortLevel?: ThinkingEffortLevel
  sdkPermissionMode?: PromaPermissionMode
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  systemPrompt?: string
  resumeSessionId?: string
  mcpServers?: Record<string, unknown>
  maxTurns?: number
  maxBudgetUsd?: number
  fallbackModel?: string
  onSessionId?: (sessionId: string) => void
  onModelResolved?: (model: string) => void
  onContextWindow?: (contextWindow: number) => void
  /** 原生终态消息在发布到 Renderer、确认队列消费前同步落盘。 */
  onNativeMessage?: (message: SDKMessage) => void
  compactRequest?: boolean
  /** 仅用于没有 Pi 原生 Session 的旧会话迁移，不含本轮输入。 */
  historyMessages?: Array<{ role: string; content: string }>
}
