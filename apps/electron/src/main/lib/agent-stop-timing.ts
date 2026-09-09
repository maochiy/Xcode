/**
 * 计算停止回合展示的耗时。
 *
 * Runtime 接收 abort 后可能还需要一段时间才能退出，因此用户停止回合的耗时
 * 必须冻结在点击停止的时刻，不能使用 Runtime 最终退出时间。
 */
export function resolveStoppedRunDurationMs(
  streamStartedAt: number,
  stopRequestedAt: number | undefined,
  completedAt = Date.now(),
): number {
  return Math.max(0, (stopRequestedAt ?? completedAt) - streamStartedAt)
}
