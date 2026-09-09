import type {
  AgentDelegationRole,
  PromaPermissionMode,
  ThinkingEffortLevel,
} from './agent'

/** 可由用户配置并委派的子 Agent。 */
export interface RegisteredAgent {
  id: string
  name: string
  description: string
  prompt: string
  enabled: boolean
  role?: AgentDelegationRole
  modelId?: string
  permissionMode?: PromaPermissionMode
  effortLevel?: ThinkingEffortLevel
  tools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
}

/** 子 Agent 注册配置及其本地文件位置。 */
export interface AgentRegistrationConfig {
  agents: RegisteredAgent[]
  globalInstructions: string
  agentsPath: string
  instructionsPath: string
}

/** Renderer 保存子 Agent 配置时提交的完整内容。 */
export interface AgentRegistrationUpdate {
  agents: RegisteredAgent[]
  globalInstructions: string
}

/** 子 Agent 注册配置 IPC 通道。 */
export const AGENT_REGISTRATION_IPC_CHANNELS = {
  GET: 'agent-registration:get',
  SAVE: 'agent-registration:save',
} as const
