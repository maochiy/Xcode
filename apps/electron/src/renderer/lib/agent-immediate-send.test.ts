import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKUserMessage } from '@proma/shared'
import { appendImmediateUserMessages, deliverImmediateAgentMessage, isImmediateSendCancelledByUser, removeImmediateUserMessage } from './agent-immediate-send'

function user(uuid: string): SDKUserMessage {
  return { type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: '同文指令' }] } }
}

describe('立即发送：Pi 原生 steering，不打断工具', () => {
  test('Given 主动停止取消未消费指令 When IPC 返回 abort Then 安静退回队列，其他故障仍提示', () => {
    const aborted = new Error("Error invoking remote method 'agent:queue-message': Error: Request was aborted.")
    expect(isImmediateSendCancelledByUser(aborted, true)).toBe(true)
    expect(isImmediateSendCancelledByUser(aborted, false)).toBe(false)
    expect(isImmediateSendCancelledByUser(new Error('Network disconnected'), true)).toBe(false)
  })

  test('Given 工具运行中 When 立即发送 Then 立即显示新消息，旧工具后续结果仍留在原生顺序', () => {
    const old: SDKMessage[] = [user('old')]
    const pending = [user('next'), user('third')]
    expect(appendImmediateUserMessages(old, pending)).toEqual([...old, ...pending])
    const tool: SDKMessage = {
      type: 'user', uuid: 'tool-result',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: '已完成' }] },
    }
    const settled = [...old, tool]
    expect(appendImmediateUserMessages(settled, pending)).toEqual([...settled, ...pending])
    expect(old).toEqual([user('old')])
  })

  test('Given 同文连续 steering When 原生消息逐条消费 Then 按 UUID 对账，未消费消息不消失', () => {
    const next = user('next')
    const third = user('third')
    const native = { ...next, _promaNativeMessage: true }
    const messages = [user('old'), native]
    expect(appendImmediateUserMessages(messages, [next, third])).toEqual([...messages, third])
    expect(appendImmediateUserMessages(messages, [next])).toBe(messages)
    const pending = new Map([['session', [next, third]], ['other', [user('other')]]])
    const consumed = removeImmediateUserMessage(pending, 'session', 'next')
    expect(consumed.get('session')).toEqual([third])
    expect(consumed.get('other')).toBe(pending.get('other'))
    expect(pending.get('session')).toHaveLength(2)
    expect(removeImmediateUserMessage(consumed, 'session', 'next')).toBe(consumed)
    expect(removeImmediateUserMessage(consumed, 'session', 'third').has('session')).toBe(false)
  })

  test('Given 当前工具尚未完成 When 点击立即发送 Then 立刻调用 steer，不启动第二个 run、不等待工具完成', async () => {
    const calls: string[] = []
    let consume!: () => void
    const consumed = new Promise<void>((resolve) => { consume = resolve })
    const delivery = deliverImmediateAgentMessage({
      active: true,
      steer: async () => { calls.push('steer'); await consumed },
      start: async () => { calls.push('start') },
    })
    expect(calls).toEqual(['steer'])
    consume()
    await delivery
    expect(calls).toEqual(['steer'])
  })

  test('Given 已停止的会话 When 点击立即发送 Then 仅启动新 run', async () => {
    const calls: string[] = []
    await deliverImmediateAgentMessage({
      active: false,
      steer: async () => { calls.push('steer') },
      start: async () => { calls.push('start') },
    })
    expect(calls).toEqual(['start'])
  })

  test('Given 入队时运行刚结束或用户停止 Then 返回未消费失败，不偷偷重试并发新 run', async () => {
    let started = false
    await expect(deliverImmediateAgentMessage({
      active: true,
      steer: async () => { throw new Error('Pi turn already finished.') },
      start: async () => { started = true },
    })).rejects.toThrow('Pi turn already finished.')
    expect(started).toBe(false)
  })
})
