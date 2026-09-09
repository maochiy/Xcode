import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  getNativeAgentSteeringTurn,
  getAssistantModelMessageId,
  hasUnpersistedLiveAssistantNarrative,
  hasUnpersistedPausedAgentContent,
  markPausedAgentMessages,
  mergeAgentLiveMessages,
  mergeAgentLiveMessagesAtQueuedUserBoundary,
  mergePersistedAndLiveMessages,
  preservePausedAgentContent,
  upsertAgentLiveMessage,
} from './agent-live-message'

function assistant(
  uuid: string,
  messageId: string,
  block: Record<string, unknown>,
  partial = false,
): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    _partial: partial,
    parent_tool_use_id: null,
    message: {
      id: messageId,
      content: [block],
    },
  } as SDKMessage
}

describe('Agent 实时消息合并', () => {
  test('Given 当前轮包含工具结果 user When 停止 Then 保留并冻结结果之前的 assistant 工具调用', () => {
    const input: SDKMessage = {
      type: 'user', uuid: 'input', message: { content: [{ type: 'text', text: '处理文件' }] },
    }
    const call = assistant('call', 'call', { type: 'tool_use', id: 't1', name: 'Read', input: {} }, true)
    const result: SDKMessage = {
      type: 'user', uuid: 'result',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '已读取' }] },
    }
    const paused = markPausedAgentMessages([input, call, result])
    expect(paused).toHaveLength(3)
    expect(paused[1]).toMatchObject({ _promaPausedByUser: true, _partial: false })
    expect(paused[2]).toBe(result)
    const nextInput: SDKMessage = {
      type: 'user', uuid: 'next', message: { content: [{ type: 'text', text: '下一轮' }] },
    }
    const nextAssistant = assistant('next-answer', 'next-answer', { type: 'text', text: '继续' }, true)
    const nextPaused = markPausedAgentMessages([...paused, nextInput, nextAssistant])
    expect(nextPaused[1]).toBe(paused[1])
    expect(nextPaused[4]).toMatchObject({ _promaPausedByUser: true, _partial: false })
  })

  test('Given 一帧内收到多条不同消息 When 批量刷新 Then 保持 IPC 到达顺序且不丢消息', () => {
    const merged = mergeAgentLiveMessages(
      [],
      [
        assistant('first', 'msg-1', { type: 'text', text: '先处理文件' }),
        assistant('second', 'msg-2', { type: 'text', text: '再运行测试' }),
      ],
    )

    expect(merged.map((message) => (message as { uuid?: string }).uuid))
      .toEqual(['first', 'second'])
  })

  test('Given 一帧内先收到 partial 后收到 final When 批量刷新 Then 只保留最终快照', () => {
    const merged = mergeAgentLiveMessages(
      [],
      [
        assistant('same', 'msg-1', { type: 'thinking', thinking: '正在思考' }, true),
        assistant('same-final', 'msg-1', { type: 'thinking', thinking: '完成回答' }),
      ],
    )

    expect(merged).toHaveLength(1)
    expect(JSON.stringify(merged)).toContain('完成回答')
    expect(JSON.stringify(merged)).not.toContain('正在思考')
  })

  test('Given 已有 thinking partial When 同 UUID 新快照到达 Then 原位替换为累计内容', () => {
    const before = [
      assistant('ccb-partial:msg-1:0', 'msg-1', {
        type: 'thinking',
        thinking: '第一段',
      }, true),
    ]

    const result = upsertAgentLiveMessage(
      before,
      assistant('ccb-partial:msg-1:0', 'msg-1', {
        type: 'thinking',
        thinking: '第一段，第二段',
      }, true),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      message: {
        content: [{ type: 'thinking', thinking: '第一段，第二段' }],
      },
    })
  })

  test('Given thinking partial 已显示 When Runtime 最终 thinking 消息到达 Then 删除临时快照并保留最终 UUID', () => {
    const result = upsertAgentLiveMessage(
      [
        assistant('ccb-partial:msg-2:0', 'msg-2', {
          type: 'thinking',
          thinking: '累计思考',
        }, true),
      ],
      assistant('runtime-final-uuid', 'msg-2', {
        type: 'thinking',
        thinking: '累计思考',
      }),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      uuid: 'runtime-final-uuid',
      _partial: false,
    })
  })

  test('Given 最终 thinking 已存在且 text partial 正在生成 When text 最终消息到达 Then 不删除 thinking', () => {
    const result = upsertAgentLiveMessage(
      [
        assistant('runtime-thinking', 'msg-3', {
          type: 'thinking',
          thinking: '思考完成',
        }),
        assistant('ccb-partial:msg-3:1', 'msg-3', {
          type: 'text',
          text: '回答中',
        }, true),
      ],
      assistant('runtime-text', 'msg-3', {
        type: 'text',
        text: '回答完成',
      }),
    )

    expect(result.map((message) =>
      (message as Record<string, unknown>).uuid
    )).toEqual(['runtime-thinking', 'runtime-text'])
  })

  test('Given 同一模型消息存在两个 thinking partial When 第一个 thinking 终态到达 Then 仅移除内容匹配的临时快照', () => {
    const result = upsertAgentLiveMessage(
      [
        assistant('ccb-partial:msg-4:0', 'msg-4', {
          type: 'thinking',
          thinking: '第一段思考',
        }, true),
        assistant('ccb-partial:msg-4:2', 'msg-4', {
          type: 'thinking',
          thinking: '第二段仍在生成',
        }, true),
      ],
      assistant('runtime-thinking-1', 'msg-4', {
        type: 'thinking',
        thinking: '第一段思考',
      }),
    )

    expect(result.map((message) =>
      (message as Record<string, unknown>).uuid
    )).toEqual(['ccb-partial:msg-4:2', 'runtime-thinking-1'])
  })

  test('Given 最终消息携带内容块索引 When 内容与 partial 有差异 Then 仍精确替换指定 partial', () => {
    const firstPartial = assistant('ccb-partial:msg-indexed:0', 'msg-indexed', {
      type: 'thinking',
      thinking: '第一段仍在生成',
    }, true)
    const secondPartial = assistant('ccb-partial:msg-indexed:2', 'msg-indexed', {
      type: 'thinking',
      thinking: '第二段仍在生成',
    }, true)
    ;(firstPartial as Record<string, unknown>)._partialBlockIndex = 0
    ;(secondPartial as Record<string, unknown>)._partialBlockIndex = 2
    const finalMessage = assistant('runtime-indexed', 'msg-indexed', {
      type: 'thinking',
      thinking: '第一段最终内容',
    })
    ;(finalMessage as Record<string, unknown>)._partialBlockIndex = 0

    const result = upsertAgentLiveMessage(
      [firstPartial, secondPartial],
      finalMessage,
    )

    expect(result.map((message) =>
      (message as Record<string, unknown>).uuid
    )).toEqual(['ccb-partial:msg-indexed:2', 'runtime-indexed'])
  })

  test('Given partial 和 final UUID 不同 When 模型 message ID 相同 Then 返回相同稳定身份', () => {
    const partial = assistant('ccb-partial:msg-stable:0', 'msg-stable', {
      type: 'thinking',
      thinking: '思考中',
    }, true)
    const finalMessage = assistant('runtime-stable', 'msg-stable', {
      type: 'thinking',
      thinking: '思考完成',
    })

    expect(getAssistantModelMessageId(partial)).toBe('msg-stable')
    expect(getAssistantModelMessageId(finalMessage)).toBe('msg-stable')
  })

  test('Given 非 partial 消息已存在 When 相同 UUID 再次到达 Then 保持原数组引用', () => {
    const before = [
      assistant('runtime-final', 'msg-5', {
        type: 'text',
        text: '最终回答',
      }),
    ]

    const result = upsertAgentLiveMessage(
      before,
      assistant('runtime-final', 'msg-5', {
        type: 'text',
        text: '最终回答',
      }),
    )

    expect(result).toBe(before)
  })

  test('Given Pi 原生消息内容与时间相同但 UUID 不同 When 合并 Then 按到达顺序全部保留', () => {
    const first = {
      type: 'user',
      uuid: 'native-user-1',
      message: { content: [{ type: 'text', text: '继续' }] },
      _createdAt: 100,
      _promaNativeMessage: true,
    } as SDKMessage
    const second = {
      ...first,
      uuid: 'native-user-2',
    } as SDKMessage

    const merged = mergeAgentLiveMessages([], [first, second])

    expect(merged.map((message) => (message as { uuid?: string }).uuid))
      .toEqual(['native-user-1', 'native-user-2'])
  })

  test('Given Pi 重复推送相同原生 UUID When 合并 Then 仅按 UUID 去重', () => {
    const first = assistant('native-assistant', 'native-model-message', {
      type: 'text',
      text: '第一份快照',
    })
    ;(first as Record<string, unknown>)._promaNativeMessage = true
    const duplicate = assistant('native-assistant', 'native-model-message', {
      type: 'text',
      text: '重复终态',
    })
    ;(duplicate as Record<string, unknown>)._promaNativeMessage = true

    const merged = mergeAgentLiveMessages([], [first, duplicate])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(first)
  })

  test('Given Pi 原生 partial 已因用户停止被冻结 When 同 UUID final 到达 Then 原位替换为最终快照', () => {
    const partial = assistant('native-assistant', 'native-model-message', {
      type: 'text',
      text: '停止前的部分内容',
    }, true)
    ;(partial as Record<string, unknown>)._promaNativeMessage = true
    const [frozen] = markPausedAgentMessages([partial])
    const finalMessage = assistant('native-assistant', 'native-model-message', {
      type: 'text',
      text: 'Runtime 最终内容',
    })
    ;(finalMessage as Record<string, unknown>)._promaNativeMessage = true

    const merged = upsertAgentLiveMessage([frozen!], finalMessage)

    expect(merged).toEqual([finalMessage])
    expect((merged[0] as Record<string, unknown>)._promaPausedByUser).toBeUndefined()
    expect(JSON.stringify(merged[0])).toContain('Runtime 最终内容')
    expect(JSON.stringify(merged[0])).not.toContain('停止前的部分内容')
  })

  test('Given 乐观 user 已占据原位置 When 同 UUID 原生 user 到达 Then 原位替换且不新增气泡', () => {
    const optimistic = {
      type: 'user',
      uuid: 'user-stable',
      message: { content: [{ type: 'text', text: '继续' }] },
      _createdAt: 100,
    } as SDKMessage
    const native = {
      ...optimistic,
      _createdAt: 150,
      _promaNativeMessage: true,
    } as SDKMessage

    const merged = upsertAgentLiveMessage([optimistic], native)

    expect(merged).toEqual([native])
  })

  test('Given assistant partial 已在新用户消息之前 When final 快照补到 Then 保留原始时间位置', () => {
    const partial = assistant('partial', 'msg-order', {
      type: 'text',
      text: '旧回复中',
    }, true)
    ;(partial as Record<string, unknown>)._createdAt = 100
    const final = assistant('final', 'msg-order', {
      type: 'text',
      text: '旧回复完成',
    })
    const merged = upsertAgentLiveMessage([partial], final)

    expect((merged[0] as Record<string, unknown>)._createdAt).toBe(100)
    expect(merged[0]).toMatchObject({
      uuid: 'final',
      message: { content: [{ type: 'text', text: '旧回复完成' }] },
    })
  })

  test('Given 旧 assistant 已冻结且 Runtime 复用 UUID When 新回合消息到达 Then 新回合消息仍单独显示', () => {
    const paused = assistant('same-uuid', 'same-model-message', {
      type: 'text',
      text: '旧回合内容',
    })
    ;(paused as Record<string, unknown>)._promaPausedByUser = true
    ;(paused as Record<string, unknown>)._partial = false
    const next = upsertAgentLiveMessage(
      [paused],
      assistant('same-uuid', 'same-model-message', {
        type: 'text',
        text: '新回合内容',
      }),
    )

    expect(next).toHaveLength(2)
    expect(next.map((message) => JSON.stringify(message))).toEqual([
      JSON.stringify(paused),
      JSON.stringify(assistant('same-uuid', 'same-model-message', {
        type: 'text',
        text: '新回合内容',
      })),
    ])
  })
})


describe('mergePersistedAndLiveMessages 暂停后继续对话顺序', () => {
  test('Given 持久化顺序被立即发送竞态打乱 When 合并 Then 旧 assistant 仍位于新 user 之前', () => {
    const user1 = {
      type: 'user',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: '第一轮' }] },
      _createdAt: 1000,
    } as SDKMessage
    const user2 = {
      type: 'user',
      uuid: 'u2',
      message: { content: [{ type: 'text', text: '立即发送' }] },
      _createdAt: 3000,
    } as SDKMessage
    const assistant1 = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'm1',
        content: [{ type: 'text', text: '第一轮完整回复' }],
      },
      _createdAt: 2000,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages([user1, user2, assistant1], [])

    expect(merged.map((item) => (item as { uuid?: string }).uuid))
      .toEqual(['u1', 'a1', 'u2'])
  })

  test('Given 第一轮 assistant 仅在 live 且第二轮 user 已持久化 When 合并 Then assistant 仍在第一轮 user 之后', () => {
    const user1 = {
      type: 'user',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: '第一轮' }] },
      _createdAt: 1000,
    } as any
    const interrupted = {
      type: 'result',
      subtype: 'interrupted',
      uuid: 'r1',
      _createdAt: 1300,
    } as any
    const user2 = {
      type: 'user',
      uuid: 'u2',
      message: { content: [{ type: 'text', text: '第二轮' }] },
      _createdAt: 2000,
    } as any
    const assistant1 = {
      type: 'assistant',
      uuid: 'a1',
      message: { id: 'm1', content: [{ type: 'text', text: '第一轮回复' }] },
      _createdAt: 1200,
    } as any

    const merged = mergePersistedAndLiveMessages(
      [user1, interrupted, user2],
      [assistant1],
    )

    expect(merged.map((item) => (item as any).uuid)).toEqual(['u1', 'a1', 'r1', 'u2'])
  })

  test('Given live 与 persisted 有相同 assistant When 合并 Then 不重复', () => {
    const assistant = {
      type: 'assistant',
      uuid: 'a1',
      message: { id: 'm1', content: [{ type: 'text', text: '回复' }] },
      _createdAt: 1200,
    } as any
    const merged = mergePersistedAndLiveMessages([assistant], [{ ...assistant }])
    expect(merged).toHaveLength(1)
  })

  test('Given Pi 原生 transcript 的时间戳不单调 When 合并 Then 保持持久化流顺序不重排', () => {
    const user = {
      type: 'user',
      uuid: 'native-user',
      message: { content: [{ type: 'text', text: '继续' }] },
      _createdAt: 300,
      _promaNativeMessage: true,
    } as SDKMessage
    const assistantMessage = {
      type: 'assistant',
      uuid: 'native-assistant',
      message: {
        id: 'native-model-message',
        content: [{ type: 'text', text: '已继续' }],
      },
      _createdAt: 200,
      _promaNativeMessage: true,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages(
      [user, assistantMessage],
      [],
    )

    expect(merged.map((message) => (message as { uuid?: string }).uuid))
      .toEqual(['native-user', 'native-assistant'])
  })

  test('Given 持久化原生前缀与实时原生后缀 When 合并 Then 按来源流顺序直接拼接', () => {
    const persistedUser = {
      type: 'user',
      uuid: 'native-user',
      message: { content: [{ type: 'text', text: '开始' }] },
      _createdAt: 300,
      _promaNativeMessage: true,
    } as SDKMessage
    const liveAssistant = {
      type: 'assistant',
      uuid: 'native-assistant',
      message: {
        id: 'native-model-message',
        content: [{ type: 'text', text: '处理中' }],
      },
      _createdAt: 200,
      _promaNativeMessage: true,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages(
      [persistedUser],
      [liveAssistant],
    )

    expect(merged.map((message) => (message as { uuid?: string }).uuid))
      .toEqual(['native-user', 'native-assistant'])
  })

  test('Given 单一来源重复出现原生 UUID When 合并 Then 不按内容判断且仅保留第一条流事件', () => {
    const first = {
      type: 'user',
      uuid: 'native-user',
      message: { content: [{ type: 'text', text: '第一份内容' }] },
      _createdAt: 100,
      _promaNativeMessage: true,
    } as SDKMessage
    const duplicate = {
      ...first,
      message: { content: [{ type: 'text', text: '重复事件内容' }] },
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages([], [first, duplicate])

    expect(merged).toEqual([first])
  })

  test('Given 持久化乐观 user 与实时原生 user UUID 相同 When 合并 Then 使用原生消息替换且位置不变', () => {
    const optimistic = {
      type: 'user',
      uuid: 'stable-user',
      message: { content: [{ type: 'text', text: '继续' }] },
      _createdAt: 100,
    } as SDKMessage
    const native = {
      ...optimistic,
      _createdAt: 150,
      _promaNativeMessage: true,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages([optimistic], [native])

    expect(merged).toEqual([native])
  })

  test('Given renderer 乐观 user 与主进程落盘 user 没有 uuid 但共享 startedAt When 合并 Then 用户消息只显示一次', () => {
    const optimistic = {
      type: 'user',
      message: { content: [{ type: 'text', text: '你是什么模型' }] },
      parent_tool_use_id: null,
      _createdAt: 3000,
      _promaQueuedDuringStreaming: true,
    } as SDKMessage
    const persisted = {
      type: 'user',
      message: { content: [{ type: 'text', text: '你是什么模型' }] },
      parent_tool_use_id: null,
      _createdAt: 3000,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages(
      [persisted],
      [optimistic],
    )

    expect(merged).toHaveLength(1)
    expect((merged[0] as Record<string, unknown>)._createdAt).toBe(3000)
  })

  test('Given 暂停快照与 JSONL 中的旧 assistant 文本相同 When 合并 Then 不显示重复旧内容', () => {
    const persisted = {
      type: 'assistant',
      uuid: 'runtime-old',
      message: {
        id: 'runtime-message-old',
        content: [{ type: 'text', text: '旧回合完整回复' }],
      },
      _createdAt: 1200,
    } as SDKMessage
    const paused = {
      type: 'assistant',
      uuid: 'session:paused-stream:1000',
      message: {
        id: 'session:paused-stream:1000',
        content: [{ type: 'text', text: '旧回合完整回复' }],
      },
      _createdAt: 1000,
      _promaPausedByUser: true,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages([persisted], [paused])

    expect(merged).toHaveLength(1)
    expect((merged[0] as Record<string, unknown>).uuid).toBe('runtime-old')
  })

  test('Given JSONL 只有更完整的旧回复 When 合并暂停中的部分快照 Then 使用更完整内容且不重复', () => {
    const persisted = {
      type: 'assistant',
      uuid: 'runtime-old-full',
      message: {
        id: 'runtime-message-old-full',
        content: [{ type: 'text', text: '旧回合已显示的内容，后续完整内容' }],
      },
      _createdAt: 1200,
    } as SDKMessage
    const paused = {
      type: 'assistant',
      uuid: 'session:paused-stream:1001',
      message: {
        id: 'session:paused-stream:1001',
        content: [{ type: 'text', text: '旧回合已显示的内容' }],
      },
      _createdAt: 1000,
      _promaPausedByUser: true,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages([persisted], [paused])

    expect(merged).toHaveLength(1)
    expect(JSON.stringify(merged[0])).toContain('后续完整内容')
  })

  test('Given 暂停前 live 同时存在累计快照和增量快照 When 合并 Then 只保留内容更完整的一份', () => {
    const partial = {
      type: 'assistant',
      uuid: 'partial-old',
      message: {
        id: 'partial-message-old',
        content: [{ type: 'text', text: '接下来会核对降级条件' }],
      },
      _createdAt: 1100,
      _promaPausedByUser: true,
    } as SDKMessage
    const cumulative = {
      type: 'assistant',
      uuid: 'cumulative-old',
      message: {
        id: 'cumulative-message-old',
        content: [{ type: 'text', text: '先检查项目，再接下来会核对降级条件' }],
      },
      _createdAt: 1000,
      _promaPausedByUser: true,
    } as SDKMessage

    const merged = mergePersistedAndLiveMessages([], [partial, cumulative])

    expect(merged).toHaveLength(1)
    expect(JSON.stringify(merged[0])).toContain('先检查项目')
    expect(JSON.stringify(merged[0])).not.toContain('"uuid":"partial-old"')
  })
})

describe('Pi 原生 steering 消费确认', () => {
  test('Given 原生 user 已实际进入上下文 When 读取 Turn 开始信号 Then 使用稳定 UUID 与实际消费时间', () => {
    const message = {
      type: 'user',
      uuid: 'queued-message-id',
      message: { content: [{ type: 'text', text: '立即处理' }] },
      _createdAt: 250,
      _promaNativeMessage: true,
      _promaQueuedDuringStreaming: true,
    } as SDKMessage

    expect(getNativeAgentSteeringTurn(message)).toEqual({
      uuid: 'queued-message-id',
      createdAt: 250,
    })
  })

  test('Given user 仍是 Renderer 乐观消息 When 读取 Turn 开始信号 Then 不提前切换可见回合', () => {
    const optimistic = {
      type: 'user',
      uuid: 'queued-message-id',
      message: { content: [{ type: 'text', text: '立即处理' }] },
      _createdAt: 200,
      _promaQueuedDuringStreaming: true,
    } as SDKMessage

    expect(getNativeAgentSteeringTurn(optimistic)).toBeUndefined()
  })

  test('Given 普通 Pi 原生 assistant 流事件 When 判断是否为 queued user 消费确认 Then 不触发同步刷新信号', () => {
    const message = assistant('native-assistant', 'native-model-message', {
      type: 'text',
      text: '流式回答',
    }, true)
    ;(message as Record<string, unknown>)._promaNativeMessage = true

    expect(getNativeAgentSteeringTurn(message)).toBeUndefined()
  })

  test('Given queued user 前仍有待合帧 assistant 与 tool final When 同步消费边界 Then 先保留完整前缀再追加 user', () => {
    const currentUser = {
      type: 'user',
      uuid: 'current-user',
      message: { content: [{ type: 'text', text: '先执行旧任务' }] },
      _createdAt: 100,
      _promaNativeMessage: true,
    } as SDKMessage
    const assistantFinal = assistant('assistant-final', 'old-assistant', {
      type: 'tool_use',
      id: 'tool-1',
      name: 'read',
      input: { path: 'src/index.ts' },
    })
    ;(assistantFinal as Record<string, unknown>)._promaNativeMessage = true
    const toolFinal = {
      type: 'user',
      uuid: 'tool-final',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: [{ type: 'text', text: '读取完成' }],
        }],
      },
      _createdAt: 200,
      _promaNativeMessage: true,
    } as SDKMessage
    const queuedUser = {
      type: 'user',
      uuid: 'queued-user',
      message: { content: [{ type: 'text', text: '现在处理新问题' }] },
      _createdAt: 300,
      _promaNativeMessage: true,
      _promaQueuedDuringStreaming: true,
    } as SDKMessage

    const merged = mergeAgentLiveMessagesAtQueuedUserBoundary(
      [currentUser],
      [assistantFinal, toolFinal],
      queuedUser,
    )

    expect(merged.map((message) => (message as { uuid?: string }).uuid))
      .toEqual(['current-user', 'assistant-final', 'tool-final', 'queued-user'])
  })
})

describe('hasUnpersistedLiveAssistantNarrative', () => {
  test('Given live 仅有过程正文且 JSONL 只有 thinking When 判断 Then 视为未落盘', () => {
    const live = [
      assistant('live-text', 'msg-1', { type: 'text', text: '我先看项目结构' }, true),
    ]
    const persisted = [
      assistant('disk-think', 'msg-1', { type: 'thinking', thinking: 'plan' }),
    ]
    expect(hasUnpersistedLiveAssistantNarrative(live, persisted)).toBe(true)
  })

  test('Given live 过程正文已在 JSONL When 判断 Then 视为已落盘', () => {
    const live = [
      assistant('live-text', 'msg-1', { type: 'text', text: '我先看项目结构' }, true),
    ]
    const persisted = [
      assistant('disk-text', 'msg-1', { type: 'text', text: '我先看项目结构' }),
    ]
    expect(hasUnpersistedLiveAssistantNarrative(live, persisted)).toBe(false)
  })
})

describe('立即发送时固化旧回合正文', () => {
  test('Given 旧正文只存在 streamState.content When 启动新回合 Then 旧正文保留为暂停快照且新正文独立', () => {
    const paused = preservePausedAgentContent(
      [],
      '旧回合已经输出的内容',
      'session-1',
      100,
      'model-old',
    )
    const nextUser = {
      type: 'user',
      uuid: 'user-2',
      message: { content: [{ type: 'text', text: '新问题' }] },
      _createdAt: 200,
    } as SDKMessage
    const newAssistant = assistant(
      'assistant-2',
      'model-message-2',
      { type: 'text', text: '新回合只回答新问题' },
    )

    const messages = [...paused, nextUser, newAssistant]
    expect((messages[0] as Record<string, unknown>)._promaPausedByUser).toBe(true)
    expect(messages[0]).toMatchObject({
      message: { content: [{ type: 'text', text: '旧回合已经输出的内容' }] },
    })
    expect(messages[2]).toMatchObject({
      message: { content: [{ type: 'text', text: '新回合只回答新问题' }] },
    })
    expect(JSON.stringify(messages[2])).not.toContain('旧回合已经输出的内容')
  })

  test('Given 旧 assistant 已在 live 中 When 暂停旧回合 Then 原消息被标记为暂停且不被新回合清理', () => {
    const oldAssistant = assistant(
      'assistant-old',
      'model-message-old',
      { type: 'text', text: '旧回合已显示的内容' },
      true,
    )
    ;(oldAssistant as Record<string, unknown>)._createdAt = 200
    const preserved = preservePausedAgentContent(
      [oldAssistant],
      '旧回合已显示的内容',
      'session-2',
      100,
      'model-old',
    )

    expect(preserved[0]).toMatchObject({
      _promaPausedByUser: true,
      message: { content: [{ type: 'text', text: '旧回合已显示的内容' }] },
    })
    expect(hasUnpersistedPausedAgentContent(preserved, [])).toBe(true)
    expect(hasUnpersistedPausedAgentContent(preserved, preserved)).toBe(false)
  })

  test('Given 旧正文只通过 sdk_message 进入 live When 立即发送 Then 旧 assistant 快照被冻结为独立内容', () => {
    const oldAssistant = assistant(
      'assistant-live-only',
      'model-message-live-only',
      { type: 'text', text: '只存在实时消息里的旧内容' },
      true,
    )
    const paused = markPausedAgentMessages([oldAssistant])

    expect(paused[0]).toMatchObject({
      _partial: false,
      _promaPausedByUser: true,
    })
    expect(hasUnpersistedPausedAgentContent(paused, [])).toBe(true)
  })

  test('Given live 没有旧消息时间戳 When 固化旧正文 Then 快照排在 live 中已有消息之后', () => {
    const oldUser = {
      type: 'user',
      uuid: 'user-old',
      message: { content: [{ type: 'text', text: '旧问题' }] },
      _createdAt: 100,
    } as SDKMessage
    const preserved = preservePausedAgentContent(
      [oldUser],
      '旧回合正文',
      'session-3',
      50,
      'model-old',
    )

    expect((preserved[1] as Record<string, unknown>)._createdAt).toBe(101)
  })
})
