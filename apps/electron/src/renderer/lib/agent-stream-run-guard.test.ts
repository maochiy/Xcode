import { describe, expect, test } from 'bun:test'
import {
  recordCompletedAgentStreamRun,
  shouldAcceptAgentStreamRun,
} from './agent-stream-run-guard'

describe('Agent 实时运行回合保护', () => {
  test('完成后的同一回合尾部事件不再被接受', () => {
    expect(shouldAcceptAgentStreamRun({
      payloadRunStartedAt: 100,
      currentRunStartedAt: 100,
      completedRunStartedAt: 100,
      currentRunRunning: false,
    })).toBe(false)
  })

  test('立即发送建立新回合后，旧回合事件被丢弃，新回合事件正常接收', () => {
    expect(shouldAcceptAgentStreamRun({
      payloadRunStartedAt: 100,
      currentRunStartedAt: 200,
      completedRunStartedAt: 100,
      currentRunRunning: true,
    })).toBe(false)
    expect(shouldAcceptAgentStreamRun({
      payloadRunStartedAt: 200,
      currentRunStartedAt: 200,
      completedRunStartedAt: 100,
      currentRunRunning: true,
    })).toBe(true)
  })

  test('没有回合时间戳的尾部事件不能重新激活已结束状态', () => {
    expect(shouldAcceptAgentStreamRun({
      completedRunStartedAt: 100,
      currentRunRunning: false,
    })).toBe(false)
  })

  test('完成标记只向前推进，不被旧回合覆盖', () => {
    expect(recordCompletedAgentStreamRun(undefined, 100)).toBe(100)
    expect(recordCompletedAgentStreamRun(200, 100)).toBe(200)
    expect(recordCompletedAgentStreamRun(100, 200)).toBe(200)
  })
})
