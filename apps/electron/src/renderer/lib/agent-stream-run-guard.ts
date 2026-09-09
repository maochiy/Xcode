/**
 * 判断实时事件是否仍属于当前可接受的运行。
 *
 * 一个 session 在“立即发送”或手动停止时，旧 Runtime 的尾部事件可能晚于
 * STREAM_COMPLETE 到达。完成后的同一回合事件不能再次把 UI 激活，也不能
 * 写进新回合。
 */
export function shouldAcceptAgentStreamRun(args: {
  payloadRunStartedAt?: number
  currentRunStartedAt?: number
  completedRunStartedAt?: number
  currentRunRunning: boolean
}): boolean {
  const {
    payloadRunStartedAt,
    currentRunStartedAt,
    completedRunStartedAt,
    currentRunRunning,
  } = args

  if (
    payloadRunStartedAt != null
    && completedRunStartedAt != null
    && payloadRunStartedAt <= completedRunStartedAt
  ) {
    return false
  }

  if (
    payloadRunStartedAt != null
    && currentRunStartedAt != null
    && payloadRunStartedAt < currentRunStartedAt
  ) {
    return false
  }

  // 兼容极少数没有携带 runStartedAt 的旧事件：如果 session 已经收到
  // STREAM_COMPLETE 且当前不再运行，不能让无标识尾部事件重新激活状态。
  if (
    payloadRunStartedAt == null
    && completedRunStartedAt != null
    && !currentRunRunning
  ) {
    return false
  }

  return true
}

/**
 * 记录 session 已完成的最新回合。只保留最大时间戳，避免旧回合的完成
 * 通知晚到时覆盖新回合的完成标记。
 */
export function recordCompletedAgentStreamRun(
  previous: number | undefined,
  completed: number | undefined,
): number | undefined {
  if (completed == null) return previous
  if (previous == null || completed > previous) return completed
  return previous
}
