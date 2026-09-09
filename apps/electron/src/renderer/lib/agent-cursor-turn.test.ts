import { describe, expect, test } from 'bun:test'
import type {
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
} from '@proma/shared'
import type { AssistantTurn } from '@proma/session-core'
import { buildCursorTurnPresentation } from './agent-cursor-turn'

function text(value: string): SDKContentBlock {
  return { type: 'text', text: value }
}

function thinking(value: string): SDKContentBlock {
  return { type: 'thinking', thinking: value }
}

function tool(id: string, name = 'Read'): SDKContentBlock {
  return { type: 'tool_use', id, name, input: {} }
}

function result(
  subtype: string = 'success',
  extras: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'result',
    subtype,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
    },
    ...extras,
  } as SDKMessage
}

function toolResult(toolUseId: string): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'ok',
      }],
    },
  }
}

function createTurn(
  blocks: SDKContentBlock[],
  turnMessages: SDKMessage[] = [],
): AssistantTurn {
  const assistant: SDKAssistantMessage = {
    type: 'assistant',
    uuid: 'assistant-1',
    parent_tool_use_id: null,
    message: { content: blocks },
  }
  return {
    type: 'assistant-turn',
    assistantMessages: [assistant],
    turnMessages: [assistant, ...turnMessages],
    model: 'cursor-test-model',
  }
}

describe('Cursor Agent Turn 纯投影', () => {
  test('Given 原生正文已开始但首字未到 When 等待增量 Then 使用中性等待，首字到达后替换而不叠加', () => {
    const blocks = [text('')]
    const turn = createTurn(blocks)
    Object.assign(turn.assistantMessages[0]!, {
      _promaNativeMessage: true, _partial: true, _promaActivityPhase: 'text',
    })
    const input = { id: 'native-empty-text', turn, blocks, isStreaming: true }
    expect(buildCursorTurnPresentation(input).showWaitingPlaceholder).toBe(true)
    expect(buildCursorTurnPresentation(input).showThinkingPlaceholder).toBe(false)
    blocks[0] = text('开始回复')
    expect(buildCursorTurnPresentation(input).showWaitingPlaceholder).toBe(false)
  })

  test('Given 旧消息只有空思考块 When 标题已经呈现运行状态 Then 不再添加第二个等待提示', () => {
    const blocks = [thinking('')]
    const turn = createTurn(blocks)
    const presentation = buildCursorTurnPresentation({
      id: 'empty-thinking', turn, blocks, isStreaming: true,
    })
    expect(presentation.activities[0]?.running).toBe(true)
    expect(presentation.showThinkingPlaceholder).toBe(false)
    expect(presentation.showWaitingPlaceholder).toBe(false)
  })

  test('Given Pi 过程正文已结束但 run 仍执行 When 尚无下一阶段事件 Then 保留正文而不猜测正在思考', () => {
    const blocks = [text('接下来继续核对。')]
    const turn = createTurn(blocks)
    Object.assign(turn.assistantMessages[0]!, { _promaNativeMessage: true })
    const input = { id: 'between-messages', turn, blocks, isStreaming: true }
    const waiting = buildCursorTurnPresentation(input)
    expect(waiting.status).toBe('running')
    expect(waiting.showThinkingPlaceholder).toBe(false)
    expect(waiting.showWaitingPlaceholder).toBe(true)
    expect(waiting.activities[0]?.running).toBe(false)
    expect(waiting.activities[0]?.block).toBe(blocks[0])

    Object.assign(turn.assistantMessages[0]!, { _partial: true })
    const writing = buildCursorTurnPresentation(input)
    expect(writing.showThinkingPlaceholder).toBe(false)
    expect(writing.showWaitingPlaceholder).toBe(false)
    expect(writing.activities[0]?.running).toBe(true)

    turn.turnMessages.push(result())
    const completed = buildCursorTurnPresentation(input)
    expect(completed.showThinkingPlaceholder).toBe(false)
    expect(completed.showWaitingPlaceholder).toBe(false)
  })

  test('Given Pi 工具执行与下一条空消息 When 原生 message_start 到达 Then 工具优先，完成后显示准备状态而非猜测思考', () => {
    const blocks = [tool('read-current'), text('下一步说明')]
    const turn = createTurn(blocks)
    Object.assign(turn.assistantMessages[0]!, { _promaNativeMessage: true })
    const input = { id: 'tool-handoff', turn, blocks, isStreaming: true }
    expect(buildCursorTurnPresentation(input).showThinkingPlaceholder).toBe(false)
    expect(buildCursorTurnPresentation(input).activities[0]?.running).toBe(true)
    turn.turnMessages.push(toolResult('read-current'))
    const emptyAssistant: SDKAssistantMessage = {
      type: 'assistant', uuid: 'next', parent_tool_use_id: null, message: { content: [] },
    }
    Object.assign(emptyAssistant, { _promaNativeMessage: true, _partial: true, _promaActivityPhase: 'waiting' })
    turn.assistantMessages.push(emptyAssistant)
    turn.turnMessages.push(emptyAssistant)
    expect(buildCursorTurnPresentation(input).showThinkingPlaceholder).toBe(false)
    expect(buildCursorTurnPresentation(input).showWaitingPlaceholder).toBe(true)
    expect(buildCursorTurnPresentation(input).activities.every((item) => !item.running)).toBe(true)
  })

  test('Given 原生思考阶段与 usage-only 快照 When 实时投影 Then 不被用量消息遮蔽且正文阶段不重复显示思考', () => {
    const blocks = [thinking('正在核对')]
    const turn = createTurn(blocks)
    Object.assign(turn.assistantMessages[0]!, {
      _promaNativeMessage: true, _partial: true, _promaActivityPhase: 'thinking',
    })
    turn.assistantMessages.push({
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [], usage: { input_tokens: 42 } },
    })
    const input = { id: 'native-phase', turn, blocks, isStreaming: true }
    expect(buildCursorTurnPresentation(input).activities[0]?.running).toBe(true)
    expect(buildCursorTurnPresentation(input).showThinkingPlaceholder).toBe(false)
    turn.assistantMessages[0]!._promaActivityPhase = 'idle'
    expect(buildCursorTurnPresentation(input).activities[0]?.running).toBe(false)
    expect(buildCursorTurnPresentation(input).showThinkingPlaceholder).toBe(false)
    expect(buildCursorTurnPresentation(input).showWaitingPlaceholder).toBe(true)
    blocks.push(text('回复正文'))
    turn.assistantMessages[0]!._promaActivityPhase = 'text'
    expect(buildCursorTurnPresentation(input).activities.map((item) => item.running)).toEqual([false, true])
    expect(buildCursorTurnPresentation(input).showThinkingPlaceholder).toBe(false)
    expect(buildCursorTurnPresentation(input).showWaitingPlaceholder).toBe(false)
  })

  test('Given 已创建正文 block 但首个字符未到 When 流式投影 Then 等待状态仍可见且不丢原始 block', () => {
    const blocks = [text('')]
    const presentation = buildCursorTurnPresentation({
      id: 'empty-text', turn: createTurn(blocks), blocks, isStreaming: true,
    })
    expect(presentation.showThinkingPlaceholder).toBe(false)
    expect(presentation.showWaitingPlaceholder).toBe(true)
    expect(presentation.activities[0]?.block).toBe(blocks[0])
    const filled = [text('开始回答')]
    const writing = buildCursorTurnPresentation({
      id: 'empty-text', turn: createTurn(filled), blocks: filled, isStreaming: true,
    })
    expect(writing.showThinkingPlaceholder).toBe(false)
    expect(writing.showWaitingPlaceholder).toBe(false)
  })
  test('Given 流式 blocks 中思考、工具和正文穿插 When 投影 Then 保持原顺序与原 index', () => {
    const blocks = [
      thinking('先分析'),
      tool('read-1'),
      text('过程说明'),
      tool('bash-1', 'Bash'),
      text('尚未结束的正文'),
    ]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-order',
      turn: createTurn(blocks),
      blocks,
      isStreaming: true,
    })

    expect(presentation.status).toBe('running')
    expect(presentation.finalItems).toEqual([])
    expect(presentation.activities.map((item) => item.index)).toEqual([
      0, 1, 2, 3, 4,
    ])
    expect(presentation.activities.map((item) => item.block)).toEqual(blocks)
  })

  test('Given 两个内容相同的正文 block When 投影 Then 不按内容去重', () => {
    const blocks = [text('相同正文'), text('相同正文')]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-duplicate-text',
      turn: createTurn(blocks),
      blocks,
      isStreaming: true,
    })

    expect(presentation.activities).toHaveLength(2)
    expect(presentation.activities.map((item) => item.index)).toEqual([0, 1])
  })

  test('Given 工具后已有正文但 Turn 尚未结束 When 终态到达 Then 才提取连续最终正文', () => {
    const blocks = [
      thinking('分析'),
      tool('read-1'),
      text('最终回答第一段'),
      text('最终回答第二段'),
    ]
    const turn = createTurn(blocks)

    const streaming = buildCursorTurnPresentation({
      id: 'turn-final-gate',
      turn,
      blocks,
      isStreaming: true,
    })
    const completed = buildCursorTurnPresentation({
      id: 'turn-final-gate',
      turn,
      blocks,
      isStreaming: false,
    })

    expect(streaming.finalItems).toEqual([])
    expect(streaming.activities.map((item) => item.index)).toEqual([0, 1, 2, 3])
    expect(completed.activities.map((item) => item.index)).toEqual([0, 1])
    expect(completed.finalItems.map((item) => item.index)).toEqual([2, 3])
    expect(completed.finalItems.map((item) => item.kind)).toEqual([
      'answer',
      'answer',
    ])
  })

  test('Given forced 过程正文位于尾部候选之前 When Turn 完成 Then forced block 保留活动且后续正文成为 final', () => {
    const blocks = [
      tool('read-1'),
      text('强制过程说明'),
      text('最终回答'),
    ]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-forced',
      turn: createTurn(blocks, [result()]),
      blocks,
      isStreaming: true,
      forcedActivityIndexes: new Set([1]),
    })

    expect(presentation.activities.map((item) => item.index)).toEqual([0, 1])
    expect(presentation.finalItems.map((item) => item.index)).toEqual([2])
  })

  test('Given result 已到达且正文为空 When 投影 Then 旧 thinking 不再 running 且不合成 result 正文', () => {
    const blocks = [thinking('已完成分析')]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-empty-result',
      turn: createTurn(blocks, [result('success', { result: '' })]),
      blocks,
      isStreaming: true,
    })

    expect(presentation.status).toBe('completed')
    expect(presentation.activities[0]?.running).toBe(false)
    expect(presentation.finalItems).toEqual([])
    expect(presentation.showThinkingPlaceholder).toBe(false)
    expect(presentation.showWaitingPlaceholder).toBe(false)
  })

  test('Given thinking 后工具已经完成且下一段模型输出未到 When 仍在流式 Then 只显示中性等待反馈而不回标旧 thinking', () => {
    const blocks = [thinking('旧思考'), tool('read-1')]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-placeholder',
      turn: createTurn(blocks, [toolResult('read-1')]),
      blocks,
      isStreaming: true,
    })

    expect(presentation.activities.map((item) => item.running)).toEqual([
      false,
      false,
    ])
    expect(presentation.showThinkingPlaceholder).toBe(false)
    expect(presentation.showWaitingPlaceholder).toBe(true)
  })

  test('Given 多个并行工具都没有 tool_result When 投影 Then 所有未完成工具同时为 running', () => {
    const blocks = [
      tool('read-1'),
      tool('grep-1', 'Grep'),
      tool('bash-1', 'Bash'),
    ]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-parallel-tools',
      turn: createTurn(blocks, [toolResult('grep-1')]),
      blocks,
      isStreaming: true,
    })

    expect(presentation.activities.map((item) => item.running)).toEqual([
      true,
      false,
      true,
    ])
    expect(presentation.showThinkingPlaceholder).toBe(false)
    expect(presentation.showWaitingPlaceholder).toBe(false)
  })

  test('Given Turn 被暂停或失败 When 投影 Then 不提升正文且关闭全部动画和占位', () => {
    const blocks = [tool('read-1'), text('半成品正文')]
    const stopped = buildCursorTurnPresentation({
      id: 'turn-stopped',
      turn: createTurn(blocks, [
        result('interrupted', { _stoppedByUser: true }),
      ]),
      blocks,
      isStreaming: false,
    })
    const failed = buildCursorTurnPresentation({
      id: 'turn-failed',
      turn: createTurn(blocks),
      blocks,
      isStreaming: true,
      hasErrorOrBlockingItem: true,
    })

    expect(stopped.status).toBe('stopped')
    expect(stopped.activities.map((item) => item.index)).toEqual([0, 1])
    expect(stopped.finalItems).toEqual([])
    expect(stopped.activities.every((item) => !item.running)).toBe(true)
    expect(stopped.showThinkingPlaceholder).toBe(false)
    expect(stopped.showWaitingPlaceholder).toBe(false)
    expect(failed.status).toBe('failed')
    expect(failed.activities.map((item) => item.index)).toEqual([0, 1])
    expect(failed.finalItems).toEqual([])
    expect(failed.activities.every((item) => !item.running)).toBe(true)
    expect(failed.showThinkingPlaceholder).toBe(false)
    expect(failed.showWaitingPlaceholder).toBe(false)
  })

  test('Given 父 result 已到达但 background 子 Agent 仍运行 When 投影 Then 延续 running 且停止优先', () => {
    const blocks = [tool('agent-1', 'Agent')]
    const turn = createTurn(blocks, [
      toolResult('agent-1'),
      result(),
    ])
    const background = buildCursorTurnPresentation({
      id: 'turn-background',
      turn,
      blocks,
      isStreaming: false,
      hasRunningSubagent: true,
      runningActivityToolIds: new Set(['agent-1']),
    })
    const stopped = buildCursorTurnPresentation({
      id: 'turn-background-stopped',
      turn,
      blocks,
      isStreaming: false,
      stoppedByUser: true,
      hasRunningSubagent: true,
      runningActivityToolIds: new Set(['agent-1']),
    })

    expect(background.status).toBe('running')
    expect(background.activities[0]?.running).toBe(true)
    expect(background.showThinkingPlaceholder).toBe(false)
    expect(background.showWaitingPlaceholder).toBe(false)
    expect(stopped.status).toBe('stopped')
    expect(stopped.activities[0]?.running).toBe(false)
    expect(stopped.showWaitingPlaceholder).toBe(false)
  })

  test('Given 原生 idle 空档已有专用交互状态 When 投影 Then 不叠加通用等待反馈', () => {
    const blocks = [text('请确认下一步。')]
    const turn = createTurn(blocks)
    Object.assign(turn.assistantMessages[0]!, {
      _promaNativeMessage: true,
      _promaActivityPhase: 'idle',
    })

    const presentation = buildCursorTurnPresentation({
      id: 'turn-dedicated-status',
      turn,
      blocks,
      isStreaming: true,
      suppressWaitingFeedback: true,
    })

    expect(presentation.status).toBe('running')
    expect(presentation.activities[0]?.running).toBe(false)
    expect(presentation.showThinkingPlaceholder).toBe(false)
    expect(presentation.showWaitingPlaceholder).toBe(false)
  })

  test('Given 任务进度工具夹在阶段和正文之间 When 投影 Then 跳过显示但保留其他 block 原 index 且不阻断 final 判定', () => {
    const blocks = [
      tool('read-1'),
      tool('task-1', 'TaskUpdate'),
      text('最终正文'),
    ]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-task-progress',
      turn: createTurn(blocks, [result()]),
      blocks,
      isStreaming: false,
    })

    expect(presentation.activities.map((item) => item.index)).toEqual([0])
    expect(presentation.finalItems.map((item) => item.index)).toEqual([2])
  })

  test('Given 非 TASK_TOOL_NAMES 的旧任务工具 When 投影 Then 不凭名称隐藏', () => {
    const blocks = [
      tool('todo-1', 'TodoWrite'),
      tool('list-1', 'TaskList'),
      tool('get-1', 'TaskGet'),
      tool('plan-1', 'update_plan'),
    ]

    const presentation = buildCursorTurnPresentation({
      id: 'turn-visible-task-tools',
      turn: createTurn(blocks),
      blocks,
      isStreaming: true,
    })

    expect(presentation.activities.map((item) => item.index)).toEqual([
      0, 1, 2, 3,
    ])
  })

  test('Given 运行中和完成后的显式 plan block When 投影 Then 运行时原位保留且完成后标记为 plan', () => {
    const blocks = [
      thinking('规划'),
      { type: 'plan_proposal', content: '执行计划' },
    ]
    const turn = createTurn(blocks)
    const streaming = buildCursorTurnPresentation({
      id: 'turn-plan',
      turn,
      blocks,
      isStreaming: true,
    })
    const completed = buildCursorTurnPresentation({
      id: 'turn-plan',
      turn,
      blocks,
      isStreaming: false,
    })

    expect(streaming.activities.map((item) => item.index)).toEqual([0, 1])
    expect(streaming.finalItems).toEqual([])
    expect(completed.activities.map((item) => item.index)).toEqual([0])
    expect(completed.finalItems).toEqual([{
      block: blocks[1]!,
      index: 1,
      kind: 'plan',
    }])
  })

  test('Given 原生 result 提供 duration_ms When 提取耗时 Then 兼容该字段且优先使用 _durationMs', () => {
    const blocks = [text('完成')]
    const nativeDuration = buildCursorTurnPresentation({
      id: 'turn-native-duration',
      turn: createTurn(blocks, [result('success', { duration_ms: 4321 })]),
      blocks,
      isStreaming: false,
    })
    const preferredDuration = buildCursorTurnPresentation({
      id: 'turn-preferred-duration',
      turn: createTurn(blocks, [result('success', {
        duration_ms: 4321,
        _durationMs: 1234,
      })]),
      blocks,
      isStreaming: false,
    })

    expect(nativeDuration.durationMs).toBe(4321)
    expect(preferredDuration.durationMs).toBe(1234)
  })
})


test('Given 同一 run 在工具后消费 steering When 新段结束 Then 耗时从新原生 user 起算而非重复整轮耗时', () => {
  const blocks = [text('新指令完成')]
  const turn = createTurn(blocks, [result('success', { _createdAt: 75_000, _durationMs: 74_000 })])
  ;(turn.assistantMessages[0] as unknown as Record<string, unknown>)._createdAt = 70_000
  const allMessages: SDKMessage[] = [{
    type: 'user', uuid: 'steer-user', _promaNativeMessage: true,
    _promaQueuedDuringStreaming: true, _createdAt: 65_000,
    message: { content: [{ type: 'text', text: '新指令' }] },
  }, ...turn.turnMessages]
  expect(buildCursorTurnPresentation({ id: 'steered', turn, blocks, allMessages }).durationMs).toBe(10_000)
  expect(buildCursorTurnPresentation({ id: 'steered', turn, blocks, allMessages,
    isStreaming: true, runningDurationMs: 3000,
  }).durationMs).toBe(3000)
})
