/**
 * Agent 实时事件目标注册表。
 *
 * 同一会话的旧回合与新回合可能在停止收尾阶段短暂重叠：
 * 新回合先注册事件目标，旧回合随后进入 finally。删除时必须校验
 * 注册版本，避免旧回合把新回合的实时事件通道一起删除。
 */
export class AgentStreamTargetRegistry<T extends object> {
  private readonly targets = new Map<string, {
    target: T
    registrationId: number
  }>()

  private nextRegistrationId = 1

  register(sessionId: string, target: T): number {
    const registrationId = this.nextRegistrationId
    this.nextRegistrationId += 1
    this.targets.set(sessionId, { target, registrationId })
    return registrationId
  }

  get(sessionId: string): T | undefined {
    return this.targets.get(sessionId)?.target
  }

  deleteIfCurrent(sessionId: string, registrationId: number): boolean {
    const current = this.targets.get(sessionId)
    if (!current || current.registrationId !== registrationId) return false
    return this.targets.delete(sessionId)
  }

  deleteTarget(target: T): void {
    for (const [sessionId, registration] of this.targets) {
      if (registration.target === target) {
        this.targets.delete(sessionId)
      }
    }
  }
}
