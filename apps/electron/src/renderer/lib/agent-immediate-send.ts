import type { SDKMessage, SDKUserMessage } from '@proma/shared'

/** 主动停止产生的队列取消不是发送故障；其他错误仍需提示。 */
export function isImmediateSendCancelledByUser(error: unknown, stoppedByUser: boolean): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return stoppedByUser && /\b(aborted|cancelled|canceled)\b/i.test(message)
}

/** 仅做乐观投影；消费前不改变当前回合，原生 UUID 到达后原位对账。 */
export function appendImmediateUserMessages(
  messages: SDKMessage[],
  pending: readonly SDKUserMessage[] | undefined,
): SDKMessage[] {
  if (!pending?.length) return messages
  const userIds = new Set(messages.flatMap((message) => message.type === 'user' ? [(message as SDKUserMessage).uuid] : []))
  const missing = pending.filter((message) => !userIds.has(message.uuid))
  return missing.length ? [...messages, ...missing] : messages
}

/** 只移除已消费/失败的那一条，连续插入的新指令互不覆盖。 */
export function removeImmediateUserMessage(
  sessions: Map<string, SDKUserMessage[]>,
  sessionId: string,
  uuid: string,
): Map<string, SDKUserMessage[]> {
  const messages = sessions.get(sessionId)
  if (!messages?.some((message) => message.uuid === uuid)) return sessions
  const remaining = messages.filter((message) => message.uuid !== uuid)
  const next = new Map(sessions)
  if (remaining.length) next.set(sessionId, remaining)
  else next.delete(sessionId)
  return next
}

/** 活跃回合只使用 Pi steering；独立停止按钮才有权取消当前工具。 */
export async function deliverImmediateAgentMessage(options: {
  active: boolean
  steer: () => Promise<void>
  start: () => Promise<void>
}): Promise<void> {
  if (options.active) await options.steer()
  else await options.start()
}
