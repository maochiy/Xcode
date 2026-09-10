import { describe, expect, test } from 'bun:test'
import { atom, createStore } from 'jotai'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  agentSessionsAtom,
  agentStreamingStatesAtom,
} from './agent-atoms'
import { selectAgentModelAtom } from './agent-model-control'

describe('输入框模型切换', () => {
  test.each([
    { name: '正在运行', running: true, backgroundWaiting: false, stopping: false },
    { name: '后台等待', running: false, backgroundWaiting: true, stopping: false },
    { name: '停止收尾', running: false, backgroundWaiting: false, stopping: true },
  ])('Given 当前轮$name When 从 A 切换到 B Then 保存新选择但不修改当前轮状态', (status) => {
    const store = createStore()
    store.set(agentSessionsAtom, [
      { id: 'current', title: '当前任务', channelId: 'channel', modelId: 'a', createdAt: 1, updatedAt: 1 },
    ])
    const state = {
      running: status.running,
      backgroundWaiting: status.backgroundWaiting,
      stopping: status.stopping,
      model: 'a',
      content: '已有正文',
      toolActivities: [{ toolUseId: 'tool-1', toolName: 'Read', input: {}, done: false }],
      contextWindow: 128_000,
      inputTokens: 1_000,
      outputTokens: 200,
      startedAt: 1,
    }
    const states = new Map([['current', state]])
    store.set(agentStreamingStatesAtom, states)

    expect(store.set(selectAgentModelAtom, {
      sessionId: 'current', channelId: 'channel', modelId: 'b',
    })).toBe(true)

    expect(store.get(agentSessionChannelMapAtom).get('current')).toBe('channel')
    expect(store.get(agentSessionModelMapAtom).get('current')).toBe('b')
    expect(store.get(agentSessionsAtom)[0]).toMatchObject({ channelId: 'channel', modelId: 'b' })
    expect(store.get(agentChannelIdAtom)).toBe('channel')
    expect(store.get(agentModelIdAtom)).toBe('b')
    expect(store.get(agentStreamingStatesAtom)).toBe(states)
    expect(store.get(agentStreamingStatesAtom).get('current')).toBe(state)
  })

  test('Given 当前会话和另一会话 When 切换模型 Then 只通知一致的最终选择并清理当前上下文窗口', () => {
    const store = createStore()
    const other = { id: 'other', title: '其他任务', createdAt: 1, updatedAt: 1 }
    store.set(agentSessionsAtom, [
      { id: 'current', title: '当前任务', channelId: 'old', modelId: 'a', createdAt: 1, updatedAt: 1 },
      other,
    ])
    const otherState = { running: false, content: '', toolActivities: [], contextWindow: 100 }
    store.set(agentStreamingStatesAtom, new Map([
      ['current', { ...otherState, content: '已有正文' }],
      ['other', otherState],
    ]))
    const selection = atom(get => [
      get(agentSessionChannelMapAtom).get('current'),
      get(agentSessionModelMapAtom).get('current'),
      get(agentSessionsAtom)[0]?.modelId,
      get(agentChannelIdAtom),
      get(agentModelIdAtom),
    ])
    const observed: unknown[] = []
    const unsubscribe = store.sub(selection, () => observed.push(store.get(selection)))

    expect(store.set(selectAgentModelAtom, { sessionId: 'current', channelId: 'new', modelId: 'b' })).toBe(true)
    expect(observed).toEqual([['new', 'b', 'b', 'new', 'b']])
    expect(store.get(agentSessionsAtom)[1]).toBe(other)
    expect(store.get(agentStreamingStatesAtom).get('other')).toBe(otherState)
    expect(store.get(agentStreamingStatesAtom).get('current')).toMatchObject({
      contextWindow: undefined, content: '已有正文',
    })
    unsubscribe()
  })

  test('Given 已选中模型 When 重复选择 Then 不通知订阅者且提示调用方无需再次持久化', () => {
    const store = createStore()
    const target = { sessionId: 'current', channelId: 'channel', modelId: 'a' }
    store.set(selectAgentModelAtom, target)
    const models = store.get(agentSessionModelMapAtom)
    let notifications = 0
    const unsubscribe = store.sub(agentSessionModelMapAtom, () => { notifications++ })
    expect(store.set(selectAgentModelAtom, target)).toBe(false)
    expect(store.get(agentSessionModelMapAtom)).toBe(models)
    expect(notifications).toBe(0)
    unsubscribe()
  })

  test('Given 快速连续选择 When 第二次选择完成 Then 各项状态指向最后选择', () => {
    const store = createStore()
    store.set(selectAgentModelAtom, { sessionId: 'current', channelId: 'channel', modelId: 'a' })
    store.set(selectAgentModelAtom, { sessionId: 'current', channelId: 'channel', modelId: 'b' })
    expect(store.get(agentSessionModelMapAtom).get('current')).toBe('b')
    expect(store.get(agentModelIdAtom)).toBe('b')
  })
})
