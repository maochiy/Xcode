import { describe, expect, test } from 'bun:test'
import { resolveStoppedRunDurationMs } from './agent-stop-timing'

describe('resolveStoppedRunDurationMs', () => {
  test('Given 用户在 19 秒时停止且 Runtime 延迟到 50 秒退出 When 计算停止耗时 Then 保持点击时的 19 秒', () => {
    expect(resolveStoppedRunDurationMs(1_000, 20_000, 51_000)).toBe(19_000)
  })

  test('Given 没有停止请求时间 When 计算耗时 Then 使用最终完成时间兜底', () => {
    expect(resolveStoppedRunDurationMs(1_000, undefined, 6_000)).toBe(5_000)
  })

  test('Given 异常时间早于回合开始 When 计算耗时 Then 不产生负数', () => {
    expect(resolveStoppedRunDurationMs(10_000, 9_000, 12_000)).toBe(0)
  })
})
