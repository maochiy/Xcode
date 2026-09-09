import type { RuntimeId } from '@proma/shared'

/** Proma 当前唯一允许建立执行会话的 Runtime。 */
export const EXECUTABLE_RUNTIME_ID = 'pi' as const

/**
 * 将历史 Runtime 标识迁移到 Pi。
 *
 * RuntimeId 暂时保留 legacy union 仅用于读取旧配置和旧会话；执行边界不能
 * 因为读到 hermes/codex/claude 而重新启动对应内核。
 */
export function normalizeExecutableRuntimeId(
  _runtimeId: RuntimeId | string | null | undefined,
): typeof EXECUTABLE_RUNTIME_ID {
  return EXECUTABLE_RUNTIME_ID
}

export function isExecutableRuntimeId(runtimeId: unknown): runtimeId is typeof EXECUTABLE_RUNTIME_ID {
  return runtimeId === EXECUTABLE_RUNTIME_ID
}
