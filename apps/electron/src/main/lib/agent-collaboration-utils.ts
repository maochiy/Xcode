/**
 * Agent 协作会话纯工具函数
 *
 * 不依赖 Electron 和磁盘服务，便于单元测试。
 */

import {
  PROMA_DEFAULT_PERMISSION_MODE,
  type AgentDelegationRole,
  type AgentDelegationStatus,
  type AgentRuntimeToolPolicy,
  type AgentSendInput,
  type AgentSessionMeta,
  type PromaPermissionMode,
  type RegisteredAgentRuntimeSnapshot,
  type ThinkingEffortLevel,
} from '@proma/shared'

const PERMISSION_RANK: Record<PromaPermissionMode, number> = {
  plan: 0,
  default: 1,
  bypassPermissions: 2,
}

export const MAX_RUNNING_DELEGATIONS_PER_PARENT = 50

export interface RecoveredDelegationState {
  delegationId: string
  parentSessionId: string
  childSessionId: string
  title: string
  role: AgentDelegationRole
  goal: string
  permissionMode: PromaPermissionMode
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
}

export function resolveDelegationPermissionMode(
  parentMode: PromaPermissionMode | undefined,
  requestedMode: PromaPermissionMode | undefined,
): PromaPermissionMode {
  const parent = parentMode ?? PROMA_DEFAULT_PERMISSION_MODE
  const requested = requestedMode ?? parent
  return PERMISSION_RANK[requested] <= PERMISSION_RANK[parent] ? requested : parent
}

function mostRestrictivePermissionMode(
  ...modes: Array<PromaPermissionMode | undefined>
): PromaPermissionMode | undefined {
  return modes
    .filter((mode): mode is PromaPermissionMode => mode !== undefined)
    .sort((left, right) => PERMISSION_RANK[left] - PERMISSION_RANK[right])[0]
}

export function buildRecoveredDelegationState(input: {
  parentSessionId: string
  delegationId: string
  session: AgentSessionMeta
  fallbackPermissionMode?: PromaPermissionMode
}): RecoveredDelegationState {
  const persistedStatus = input.session.delegationStatus
  // 从持久化记录恢复但不在 live Map 中，说明当前进程并没有这个委派在跑。
  // 若磁盘里还残留 running（例如应用重启/崩溃后），应视为 interrupted，
  // 否则 continue_delegation 会把它误判为“仍在运行”而拒绝恢复。
  const status = persistedStatus === 'running'
    ? 'interrupted'
    : (persistedStatus ?? 'interrupted')
  return {
    delegationId: input.delegationId,
    parentSessionId: input.parentSessionId,
    childSessionId: input.session.id,
    title: input.session.title,
    role: input.session.delegationRole ?? 'custom',
    goal: input.session.delegationGoal ?? '',
    permissionMode: input.session.permissionMode ?? input.fallbackPermissionMode ?? PROMA_DEFAULT_PERMISSION_MODE,
    status,
    startedAt: input.session.createdAt,
    completedAt: persistedStatus ? input.session.updatedAt : undefined,
  }
}

export function buildDelegationPrompt(input: {
  parentSessionId: string
  delegationId: string
  role: AgentDelegationRole
  task: string
  expectedOutput?: string
}): string {
  const expectedOutput = input.expectedOutput?.trim()
  return `你是 Proma 协作子 Agent。你由父 Agent 会话 ${input.parentSessionId} 委派创建，委派 ID 为 ${input.delegationId}。

## 工作边界

- 只处理下面的子任务，不要扩展到父任务的其他部分。
- 不要创建新的协作子会话。
- 你的角色只定义职责；无论 explore/research/implement/review/custom，实际执行内核始终是 Pi，不依赖 Codex 或 Claude Code。
- 如需修改文件，保持改动最小，并在最终回复说明文件路径和验证结果。
- 如果信息不足，直接列出缺口，不要编造。

## 子任务角色

${input.role}

## 子任务

${input.task.trim()}

## 输出要求

${expectedOutput || '最终回复请包含：关键发现、已执行操作、验证结果、剩余风险或建议。'}`
}

export function buildDelegationTaskWithSharedContext(input: {
  sharedContext?: string
  task: string
}): string {
  const sharedContext = input.sharedContext?.trim()
  const task = input.task.trim()
  if (!sharedContext) return task

  return `共享背景：
${sharedContext}

子任务：
${task}`
}

interface RegisteredAgentDefinitionLike {
  id: string
  name: string
  description: string
  prompt: string
  role?: AgentDelegationRole
  modelId?: string
  permissionMode?: PromaPermissionMode
  effortLevel?: ThinkingEffortLevel
  tools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
}

/** 固化注册定义，防止后续编辑改变已创建子会话的运行边界。 */
export function snapshotRegisteredAgent(
  definition: RegisteredAgentDefinitionLike,
): RegisteredAgentRuntimeSnapshot {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    prompt: definition.prompt,
    ...(definition.role ? { role: definition.role } : {}),
    ...(definition.modelId ? { modelId: definition.modelId } : {}),
    ...(definition.permissionMode ? { permissionMode: definition.permissionMode } : {}),
    ...(definition.effortLevel ? { effortLevel: definition.effortLevel } : {}),
    ...(definition.tools ? { tools: [...definition.tools] } : {}),
    ...(definition.disallowedTools ? { disallowedTools: [...definition.disallowedTools] } : {}),
    ...(definition.maxTurns != null ? { maxTurns: definition.maxTurns } : {}),
  }
}

/** 把持久化快照转换为真正参与 Runtime 查询的输入参数。 */
export function applyRegisteredAgentRuntimeSnapshot(
  input: AgentSendInput,
  snapshot: RegisteredAgentRuntimeSnapshot | undefined,
  parentPermissionMode?: PromaPermissionMode,
): AgentSendInput {
  if (!snapshot) return input
  const toolPolicy: AgentRuntimeToolPolicy = {
    ...(snapshot.tools ? { allowedTools: [...snapshot.tools] } : {}),
    ...(snapshot.disallowedTools ? { disallowedTools: [...snapshot.disallowedTools] } : {}),
  }
  const effectivePermissionMode = mostRestrictivePermissionMode(
    snapshot.permissionMode,
    input.permissionModeOverride,
    parentPermissionMode,
  )
  return {
    ...input,
    ...(snapshot.modelId ? { modelId: snapshot.modelId } : {}),
    ...(effectivePermissionMode ? { permissionModeOverride: effectivePermissionMode } : {}),
    runtimeThinking: {
      ...input.runtimeThinking,
      ...(snapshot.effortLevel ? { effortLevel: snapshot.effortLevel } : {}),
    },
    registeredAgentSystemPrompt: snapshot.prompt,
    ...(Object.keys(toolPolicy).length > 0 ? { runtimeToolPolicy: toolPolicy } : {}),
    ...(snapshot.maxTurns != null ? { maxTurnsOverride: snapshot.maxTurns } : {}),
  }
}
