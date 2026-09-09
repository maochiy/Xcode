import type {
  AgentSessionMeta,
  ExecutableHarnessId,
  ExecutableRuntimeId,
  HarnessId,
  RuntimeDefinition,
  RuntimeId,
} from '@proma/shared'

/** Renderer 当前唯一允许展示和写入的新 Runtime。 */
export const DEFAULT_AGENT_RUNTIME_ID: ExecutableRuntimeId = 'pi'

/** Renderer 当前唯一允许写入的新 Harness。 */
export const DEFAULT_AGENT_HARNESS_ID: ExecutableHarnessId = 'pi'

/** 旧 Runtime 仍可被读取，但不能重新出现在可选内核列表中。 */
export function selectExecutableRuntimeDefinitions(
  runtimes: readonly RuntimeDefinition[],
): RuntimeDefinition[] {
  return runtimes.filter((runtime) => runtime.id === DEFAULT_AGENT_RUNTIME_ID)
}

/** 新会话和从旧数据恢复的会话在 Renderer 中统一绑定 Pi。 */
export function normalizeAgentSessionRuntime(
  session: AgentSessionMeta,
): AgentSessionMeta {
  if (session.runtimeId === DEFAULT_AGENT_RUNTIME_ID) return session
  return {
    ...session,
    runtimeId: DEFAULT_AGENT_RUNTIME_ID,
  }
}

export function normalizeAgentSessionRuntimes(
  sessions: readonly AgentSessionMeta[],
): AgentSessionMeta[] {
  return sessions.map(normalizeAgentSessionRuntime)
}

interface LegacyRoleRuntimeBinding {
  runtimeId: RuntimeId
  harnessId: HarnessId
}

/**
 * 角色名称和其它配置保持不变，只收敛其执行内核。
 *
 * 该纯函数供角色配置进入 Renderer 展示/编辑边界时复用；实际执行边界仍需由
 * Main Runtime Router 再次强制归一化。
 */
export function normalizeRoleRuntimeBinding<T extends LegacyRoleRuntimeBinding>(
  role: T,
): Omit<T, 'runtimeId' | 'harnessId'> & {
  runtimeId: ExecutableRuntimeId
  harnessId: ExecutableHarnessId
} {
  return {
    ...role,
    runtimeId: DEFAULT_AGENT_RUNTIME_ID,
    harnessId: DEFAULT_AGENT_HARNESS_ID,
  }
}
