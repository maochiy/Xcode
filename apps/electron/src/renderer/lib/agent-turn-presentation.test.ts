import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKMessage, SDKToolUseBlock } from '@proma/shared'
import type { AssistantTurn } from '@proma/session-core'
import {
  buildAgentTurnPresentation,
  dedupeAssistantSnapshotsForPresentation,
  orderAssistantMessagesForPresentation,
  collectPriorFoldableActivities,
  collectPriorToolActivities,
  resolveVisibleTurnActivities,
} from './agent-turn-presentation'
import { resolveAgentTurnExpanded } from './agent-turn-collapse'

const thinking = (value = '分析中'): SDKContentBlock => ({
  type: 'thinking',
  thinking: value,
})
const text = (value: string): SDKContentBlock => ({ type: 'text', text: value })
const tool = (id: string, name = 'Read'): SDKContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})

function createTurn(blocks: SDKContentBlock[], turnMessages: SDKMessage[] = []): AssistantTurn {
  const assistant = {
    type: 'assistant' as const,
    uuid: 'assistant-1',
    parent_tool_use_id: null,
    message: { content: blocks },
  }
  return {
    type: 'assistant-turn',
    assistantMessages: [assistant],
    turnMessages: [assistant, ...turnMessages],
    model: 'claude-sonnet-4',
  }
}

function createToolResultMessage(input: {
  toolUseId: string
  toolUseResult?: Record<string, unknown>
  parentToolUseId?: string | null
}): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: input.parentToolUseId ?? null,
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: input.toolUseId,
        content: '工具结果',
      }],
    },
    tool_use_result: input.toolUseResult,
  } as SDKMessage
}

describe('Agent Turn 展示模型', () => {
  test('Given 立即发送冻结了同一旧回合的累计快照和短快照 When 渲染 Then 只显示完整正文一次', () => {
    const cumulative = {
      type: 'assistant' as const,
      uuid: 'paused-cumulative',
      parent_tool_use_id: null,
      message: {
        id: 'old-message',
        content: [
          text('先检查项目，再核对降级条件。'),
        ],
      },
      _promaPausedByUser: true,
    }
    const shorter = {
      type: 'assistant' as const,
      uuid: 'paused-shorter',
      parent_tool_use_id: null,
      message: {
        id: 'old-message',
        content: [
          text('再核对降级条件。'),
        ],
      },
      _promaPausedByUser: true,
    }

    const deduped = dedupeAssistantSnapshotsForPresentation([cumulative, shorter])

    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.uuid).toBe('paused-cumulative')
  })

  test('Given 同一 message id 的 CCB 不同 block When 渲染 Then 不误删不同过程块', () => {
    const thinkingMessage = {
      type: 'assistant' as const,
      uuid: 'thinking-block',
      parent_tool_use_id: null,
      message: {
        id: 'ccb-message',
        content: [thinking('先分析')],
      },
      _partial: true,
      _partialBlockIndex: 0,
    }
    const textMessage = {
      type: 'assistant' as const,
      uuid: 'text-block',
      parent_tool_use_id: null,
      message: {
        id: 'ccb-message',
        content: [text('继续处理')],
      },
      _partial: true,
      _partialBlockIndex: 2,
    }

    expect(
      dedupeAssistantSnapshotsForPresentation([thinkingMessage, textMessage]),
    ).toHaveLength(2)
  })

  test('Given 同一 block 的 partial 和 final When 渲染 Then final 替换 partial', () => {
    const partial = {
      type: 'assistant' as const,
      uuid: 'partial',
      parent_tool_use_id: null,
      message: {
        id: 'ccb-message-final',
        content: [text('正在生成')],
      },
      _partial: true,
      _partialBlockIndex: 2,
    }
    const final = {
      type: 'assistant' as const,
      uuid: 'final',
      parent_tool_use_id: null,
      message: {
        id: 'ccb-message-final',
        content: [text('正在生成完成')],
      },
      _partialBlockIndex: 2,
    }

    const deduped = dedupeAssistantSnapshotsForPresentation([partial, final])

    expect(deduped).toHaveLength(1)
    expect(deduped[0]?.uuid).toBe('final')
  })

  test('Given 立即发送后旧 turn 的不同身份快照重复 When turn 被中断 Then 只保留完整正文', () => {
    const firstSnapshot = {
      type: 'assistant' as const,
      uuid: 'runtime-snapshot',
      parent_tool_use_id: null,
      message: {
        id: 'runtime-message-1',
        content: [text('先检查项目。接下来核对降级条件。')],
      },
    }
    const secondSnapshot = {
      type: 'assistant' as const,
      uuid: 'paused-snapshot',
      parent_tool_use_id: null,
      message: {
        id: 'paused-message-1',
        content: [text('接下来核对降级条件。')],
      },
    }
    const interrupted = {
      type: 'result' as const,
      subtype: 'interrupted',
      _stoppedByUser: true,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [firstSnapshot, secondSnapshot],
      turnMessages: [firstSnapshot, secondSnapshot, interrupted],
      model: 'claude-sonnet-4',
    }

    const ordered = orderAssistantMessagesForPresentation(turn)

    expect(ordered).toHaveLength(1)
    expect(ordered[0]?.uuid).toBe('runtime-snapshot')
  })

  test('Given Pi 暂停时两个不同 UUID 返回同文正文 When 展示 Then 两条原生消息仍按原位保留', () => {
    const first = {
      type: 'assistant' as const,
      uuid: 'pi-same-text-1',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: {
        id: 'pi-same-text-1',
        content: [text('相同正文')],
      },
    }
    const second = {
      type: 'assistant' as const,
      uuid: 'pi-same-text-2',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: {
        id: 'pi-same-text-2',
        content: [text('相同正文')],
      },
    }
    const interrupted = {
      type: 'result' as const,
      subtype: 'interrupted',
      uuid: 'pi-interrupted',
      _promaNativeMessage: true,
      _stoppedByUser: true,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [first, second],
      turnMessages: [first, second, interrupted],
      model: 'gpt-5.6-sol',
    }

    const ordered = orderAssistantMessagesForPresentation(turn)

    expect(ordered.map((message) => message.uuid)).toEqual([
      'pi-same-text-1',
      'pi-same-text-2',
    ])
  })

  test('Given Pi 同一 UUID 的 partial 与 final 位于原消息槽位 When 展示 Then 原位采用最后快照', () => {
    const before = {
      type: 'assistant' as const,
      uuid: 'pi-before',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: { content: [thinking('先分析')] },
    }
    const partial = {
      type: 'assistant' as const,
      uuid: 'pi-snapshot',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      _partial: true,
      message: { content: [text('部分正文')] },
    }
    const after = {
      type: 'assistant' as const,
      uuid: 'pi-after',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: { content: [thinking('继续分析')] },
    }
    const final = {
      type: 'assistant' as const,
      uuid: 'pi-snapshot',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: { content: [text('最终正文')] },
    }

    const deduped = dedupeAssistantSnapshotsForPresentation([
      before,
      partial,
      after,
      final,
    ])

    expect(deduped.map((message) => message.uuid)).toEqual([
      'pi-before',
      'pi-snapshot',
      'pi-after',
    ])
    expect(deduped[1]?.message.content).toEqual([text('最终正文')])
  })

  test('Given 原生快照后混有同文 legacy 暂停快照 When 兼容去重 Then legacy 算法不能吞掉原生消息', () => {
    const native = {
      type: 'assistant' as const,
      uuid: 'native-paused',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      _promaPausedByUser: true,
      message: { content: [text('已检查')] },
    }
    const legacy = {
      type: 'assistant' as const,
      uuid: 'legacy-paused',
      parent_tool_use_id: null,
      _promaPausedByUser: true,
      message: { content: [text('已检查并完成')] },
    }
    expect(dedupeAssistantSnapshotsForPresentation([native, legacy], {
      allowCrossIdentityTextSnapshots: true,
    }).map((message) => message.uuid)).toEqual(['native-paused', 'legacy-paused'])
  })

  test('Given Pi result 携带整次 run 累计正文且本轮只有工具 When 展示 Then 不虚构重复最终正文', () => {
    const assistant = {
      type: 'assistant' as const,
      uuid: 'pi-tool-only',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: { content: [tool('pi-read', 'Read')] },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      uuid: 'pi-cumulative-result',
      _promaNativeMessage: true,
      result: '上一原生 turn 正文。本原生 turn 正文。',
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, result],
      model: 'gpt-5.6-sol',
    }

    const presentation = buildAgentTurnPresentation({
      id: 'pi-cumulative-result',
      turn,
      blocks: assistant.message.content,
    })

    expect(presentation.finalItems).toHaveLength(0)
    expect(presentation.activities.map((item) => item.block)).toEqual([
      tool('pi-read', 'Read'),
    ])
  })

  test('Given Pi turn 混有新旧 assistant 且 result 匹配首条正文 When 排序 Then 不移动原消息顺序', () => {
    const nativeAnswer = {
      type: 'assistant' as const,
      uuid: 'native-answer-first',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: {
        id: 'native-answer-first',
        content: [text('最终正文')],
      },
    }
    const legacyActivity = {
      type: 'assistant' as const,
      uuid: 'legacy-activity-second',
      parent_tool_use_id: null,
      message: {
        id: 'legacy-activity-second',
        content: [thinking('旧投影活动')],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '最终正文',
      _promaNativeMessage: true,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [nativeAnswer, legacyActivity],
      turnMessages: [nativeAnswer, legacyActivity, result],
      model: 'gpt-5.6-sol',
    }

    expect(
      orderAssistantMessagesForPresentation(turn).map((message) => message.uuid),
    ).toEqual(['native-answer-first', 'legacy-activity-second'])
  })

  test('Given Pi 原生 tool_result 缺少 tool_use When 展示 Then 不猜测或补造工具活动', () => {
    const assistant = {
      type: 'assistant' as const,
      uuid: 'pi-thinking-only',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: { content: [thinking('等待原生工具事件')] },
    }
    const toolResult = {
      type: 'user' as const,
      uuid: 'pi-tool-result-only',
      parent_tool_use_id: null,
      _promaNativeMessage: true,
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'pi-missing-tool-use',
          content: '1\tconst value = true',
        }],
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistant],
      turnMessages: [assistant, toolResult],
      model: 'gpt-5.6-sol',
    }

    const presentation = buildAgentTurnPresentation({
      id: 'pi-no-missing-tool-projection',
      turn,
      blocks: assistant.message.content,
    })

    expect(presentation.activities.map((item) => item.block.type)).toEqual([
      'thinking',
    ])
  })

  test('Given 纯正文 When 分类 Then 正文与唯一 Logo 同行且没有活动折叠', () => {
    const turn = createTurn([text('最终回答')])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })
    expect(presentation.activities).toHaveLength(0)
    expect(presentation.finalItems.map((item) => item.kind)).toEqual(['answer'])
    expect(presentation.collapsePolicy.collapsible).toBe(false)
  })

  test('Given thinking only When 完成 Then 不提升为最终正文', () => {
    const turn = createTurn([thinking('这不是最终回答')])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })
    expect(presentation.finalItems).toHaveLength(0)
    expect(presentation.activities).toHaveLength(1)
    expect(presentation.collapsePolicy.collapsible).toBe(false)
  })

  test('Given 工具后出现正文 When 工具完成 Then 流式正文移到活动外', () => {
    const result = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
      },
    }
    const turn = createTurn([tool('tool-1'), text('最终回答')], [result])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })
    expect(presentation.activities.map((item) => item.block.type)).toEqual(['tool_use'])
    expect(presentation.finalItems.map((item) => item.block.type)).toEqual(['text'])
  })

  test('Given Pi 工具后最终正文先于 tool_result 投影到达 When 流式渲染 Then 正文首增量立即进入最终回答区', () => {
    const firstUsage = {
      type: 'assistant' as const,
      uuid: 'pi-usage-before-tool',
      parent_tool_use_id: null,
      message: {
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
        },
      },
    }
    const thinkingBeforeTool = {
      type: 'assistant' as const,
      uuid: 'pi-thinking-before-tool',
      parent_tool_use_id: null,
      message: {
        id: 'pi-segment-before-tool',
        content: [thinking('先读取目标文件。')],
      },
    }
    const toolMessage = {
      type: 'assistant' as const,
      uuid: 'pi-tool-message',
      parent_tool_use_id: null,
      message: {
        content: [tool('pi-read-tool', 'Read')],
      },
    }
    const secondUsage = {
      type: 'assistant' as const,
      uuid: 'pi-usage-after-tool',
      parent_tool_use_id: null,
      message: {
        content: [],
        usage: {
          input_tokens: 200,
          output_tokens: 20,
        },
      },
    }
    const finalPartial = {
      type: 'assistant' as const,
      uuid: 'pi-final-segment',
      parent_tool_use_id: null,
      _partial: true,
      message: {
        id: 'pi-final-segment-id',
        content: [
          thinking('整理最终结论。'),
          text('最终正文首个增量。'),
        ],
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [
        firstUsage,
        thinkingBeforeTool,
        toolMessage,
        secondUsage,
        finalPartial,
      ],
      // Pi 的 tool.completed 与后续 message.delta 来自不同事件；
      // Renderer 合帧时最终正文可能先可见，tool_result 下一帧才进入 Turn。
      turnMessages: [
        firstUsage,
        thinkingBeforeTool,
        toolMessage,
        secondUsage,
        finalPartial,
      ],
      model: 'gpt-5.6-sol',
    }
    const ordered = orderAssistantMessagesForPresentation(turn)
    const presentation = buildAgentTurnPresentation({
      id: 'turn-pi-tool-result-race',
      turn,
      blocks: ordered.flatMap((message) => message.message.content),
      isStreaming: true,
    })

    expect(presentation.finalAnswerStarted).toBe(true)
    expect(presentation.finalItems.map((item) => item.block.type)).toEqual(['text'])
    expect(presentation.activities.map((item) => item.block.type)).toEqual([
      'thinking',
      'tool_use',
      'thinking',
    ])
  })

  test('Given thinking 后直接出现正文 When 流式渲染 Then 正文立即进入最终回答区', () => {
    const turn = createTurn([thinking(), text('最终回答')])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
      runningDurationMs: 4_200,
    })
    expect(presentation.activities.map((item) => item.block.type)).toEqual(['thinking'])
    expect(presentation.finalItems.map((item) => item.block.type)).toEqual(['text'])
    expect(presentation.status).toBe('completed')
    expect(presentation.durationMs).toBe(4_200)
    expect(presentation.collapsePolicy).toMatchObject({
      collapsible: true,
      defaultExpanded: false,
    })
  })

  test('Given Bash 工具仍未完成 When 流式渲染 Then 状态为正在运行命令', () => {
    const turn = createTurn([thinking(), tool('tool-1', 'Bash')])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })
    expect(presentation.status).toBe('running-command')
  })

  test('Given 流式中连续产生多个活动 When 最终回答尚未开始 Then 完整轨迹保留但默认只显示最新活动', () => {
    const completedRead = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }],
      },
    }
    const turn = createTurn([
      thinking('先分析'),
      tool('read-1', 'Read'),
      text('继续检查命令'),
      tool('bash-1', 'Bash'),
    ], [completedRead])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })

    expect(presentation.activities).toHaveLength(4)
    expect(presentation.activities.map((item) => item.running)).toEqual([
      false,
      false,
      false,
      true,
    ])
    expect(presentation.activities.map((item) => item.foldable)).toEqual([
      true,
      true,
      false,
      true,
    ])
    // 收起态：过程正文固定 + 最新工具（工具替换思考，过程正文不消失）
    expect(presentation.visibleActivities.map((item) => item.block.type)).toEqual([
      'text',
      'tool_use',
    ])
    expect(presentation.visibleActivities.at(-1)?.block).toMatchObject({
      type: 'tool_use',
      id: 'bash-1',
    })
    expect(presentation.collapsePolicy.collapsible).toBe(false)
  })

  test('Given 流式活动全部完成且出现新的思考摘要 When 更新运行区 Then 旧活动保留在折叠轨迹且只显示最新摘要', () => {
    const readResult = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }],
      },
    }
    const turn = createTurn([
      thinking('第一段摘要'),
      tool('read-1', 'Read'),
      thinking('正在整理最新结果'),
    ], [readResult])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })

    expect(presentation.activities).toHaveLength(3)
    expect(presentation.activities.map((item) => item.running)).toEqual([
      false,
      false,
      true,
    ])
    expect(presentation.visibleActivities).toHaveLength(1)
    expect(presentation.visibleActivities.at(-1)?.block).toMatchObject({
      type: 'thinking',
      thinking: '正在整理最新结果',
    })
  })

  test('Given 多段 thinking 被工具调用隔开 When 构建展示 Then 全部原文进入统一思考流', () => {
    const turn = createTurn([
      thinking('第一段原始思考。'),
      tool('read-1', 'Read'),
      thinking('## 第二段标题\n继续分析 IPC。'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-thinking-stream',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })

    expect(presentation.thinkingContent).toBe(
      '第一段原始思考。\n## 第二段标题\n继续分析 IPC。',
    )
  })

  test('Given 最终回答已经开始 When 仍处于流式阶段 Then 活动轨迹默认收起且不残留伪运行项', () => {
    const readResult = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }],
      },
    }
    const turn = createTurn([
      thinking('先分析'),
      tool('read-1', 'Read'),
      text('最终回答'),
    ], [readResult])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })

    expect(presentation.activities).toHaveLength(2)
    expect(presentation.visibleActivities).toHaveLength(0)
    expect(presentation.activities.every((item) => !item.running)).toBe(true)
    expect(presentation.collapsePolicy).toMatchObject({
      collapsible: true,
      defaultExpanded: false,
    })
  })

  test('Given 穿插过程正文与思考 When 流式分类 Then 过程正文固定全部露出且不进最终回答', () => {
    const turn = createTurn([
      thinking('第一段分析'),
      text('主源码目录确实有登录相关实现。让我并行读取核心文件。'),
      thinking('继续分析 IPC 和 preload。'),
      text('现在看 IPC 桥接、preload 和 App 路由。'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-process-text',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
      forcedActivityIndexes: new Set([1, 3]),
    })

    expect(presentation.finalAnswerStarted).toBe(false)
    expect(presentation.finalItems).toHaveLength(0)
    expect(presentation.activities).toHaveLength(4)
    expect(presentation.activities.map((item) => item.foldable)).toEqual([
      true,
      false,
      true,
      false,
    ])
    // 过程正文固定全部露出；正文替换思考后，下方新增一行「正在思考」
    expect(presentation.visibleActivities.map((item) => item.block.type)).toEqual([
      'text',
      'text',
      'thinking',
    ])
    expect(presentation.visibleActivities.slice(0, 2).map((item) => (
      item.block.type === 'text' ? item.block.text : null
    ))).toEqual([
      '主源码目录确实有登录相关实现。让我并行读取核心文件。',
      '现在看 IPC 桥接、preload 和 App 路由。',
    ])
    expect(presentation.visibleActivities[2]?.running).toBe(true)
    expect(presentation.visibleActivities[2]?.index).toBeLessThan(0) // 合成新的正在思考
  })

  test('Given 过程正文后继续思考 When 流式收起 Then 过程正文固定且下方显示新的正在思考', () => {
    const turn = createTurn([
      thinking('第一段分析'),
      text('主源码目录确实有登录相关实现。'),
      thinking('继续分析 IPC。'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-process-then-thinking',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
      forcedActivityIndexes: new Set([1]),
    })

    expect(presentation.visibleActivities.map((item) => item.block.type)).toEqual([
      'text',
      'thinking',
    ])
    expect(presentation.visibleActivities[0]?.block).toMatchObject({
      type: 'text',
      text: '主源码目录确实有登录相关实现。',
    })
    expect(presentation.visibleActivities[1]?.block).toMatchObject({
      type: 'thinking',
      thinking: '继续分析 IPC。',
    })
    expect(presentation.visibleActivities[1]?.running).toBe(true)
  })

  test('Given 多条过程正文穿插思考 When 流式收起 Then 过程正文全部按序追加且思考落在时间序位置', () => {
    const turn = createTurn([
      thinking('第一段分析'),
      text('主源码目录有登录实现。'),
      thinking('继续看 IPC'),
      text('现在读取 preload。'),
      thinking('准备调用工具'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-process-chrono',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
      forcedActivityIndexes: new Set([1, 3]),
    })

    expect(presentation.visibleActivities.map((item) => item.block.type)).toEqual([
      'text',
      'text',
      'thinking',
    ])
    expect(presentation.visibleActivities.map((item) => (
      item.block.type === 'text'
        ? item.block.text
        : item.block.type === 'thinking'
          ? item.block.thinking
          : null
    ))).toEqual([
      '主源码目录有登录实现。',
      '现在读取 preload。',
      '准备调用工具',
    ])
    // 旧正文不能被最新正文顶掉
    expect(presentation.visibleActivities.filter((item) => item.block.type === 'text')).toHaveLength(2)
  })

  test('Given 用户暂停且已有多条过程正文 When 展示停止轮 Then 完整活动按原顺序保留', () => {
    const turn = createTurn([
      thinking('先分析'),
      text('第一段固定说明'),
      text('第二段固定说明'),
      thinking('还在分析'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-stop-keep-process',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: false,
      stoppedByUser: true,
      forcedActivityIndexes: new Set([1, 2]),
    })

    expect(presentation.status).toBe('stopped')
    expect(presentation.visibleActivities.map((item) => item.block.type)).toEqual([
      'thinking',
      'text',
      'text',
      'thinking',
    ])
    expect(presentation.visibleActivities.map((item) => (
      item.block.type === 'text' ? item.block.text : item.block.type === 'thinking' ? item.block.thinking : null
    ))).toEqual([
      '先分析',
      '第一段固定说明',
      '第二段固定说明',
      '还在分析',
    ])
  })


  test('Given 用户暂停且末尾是未标记过程正文 When 展示停止轮 Then 不提升为最终回答且多条正文仍可见', () => {
    // 运行中这些正文因 isStreaming 不会进 final；暂停后也不能因 !isStreaming 被吃掉
    const turn = createTurn([
      thinking('先分析'),
      text('第一段说明'),
      text('第二段说明'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-stop-trailing-process',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: false,
      stoppedByUser: true,
      // 模拟 forced 标记丢失或尚未带上 stop_reason 的情况
      forcedActivityIndexes: new Set(),
    })

    expect(presentation.status).toBe('stopped')
    expect(presentation.finalAnswerStarted).toBe(false)
    expect(presentation.finalItems.filter((item) => item.kind === 'answer')).toHaveLength(0)
    expect(presentation.visibleActivities.filter((item) => item.block.type === 'text')).toHaveLength(2)
    expect(presentation.visibleActivities.map((item) => (
      item.block.type === 'text' ? item.block.text : item.block.type
    ))).toEqual([
      'thinking',
      '第一段说明',
      '第二段说明',
    ])
  })

  test('Given 相邻 thinking 合并 When 重映射 forced 下标 Then 过程正文仍保留在活动区', () => {
    const turn = createTurn([
      thinking('第一段思考'),
      thinking('第二段思考'),
      text('过程说明正文'),
      thinking('继续'),
    ])
    // 合并前 text 在 index 2；合并相邻 thinking 后应落到 index 1
    const presentation = buildAgentTurnPresentation({
      id: 'turn-merge-forced-remap',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: false,
      stoppedByUser: true,
      forcedActivityIndexes: new Set([2]),
    })

    expect(presentation.status).toBe('stopped')
    const processTexts = presentation.activities.filter((item) => item.block.type === 'text')
    expect(processTexts).toHaveLength(1)
    expect(processTexts[0]?.block).toMatchObject({
      type: 'text',
      text: '过程说明正文',
    })
    expect(processTexts[0]?.foldable).toBe(false)
    expect(presentation.finalItems.filter((item) => item.kind === 'answer')).toHaveLength(0)
    expect(presentation.visibleActivities.some((item) => (
      item.block.type === 'text'
      && item.block.text === '过程说明正文'
    ))).toBe(true)
  })

  test('Given 过程正文后最终回答开始 When 仍流式 Then 过程正文仍固定露出', () => {
    const readResult = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }],
      },
    }
    const turn = createTurn([
      thinking('先分析'),
      text('中间过程说明'),
      tool('read-1', 'Read'),
      text('最终回答正文'),
    ], [readResult])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-final-keep-process',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
      forcedActivityIndexes: new Set([1]),
    })

    expect(presentation.finalAnswerStarted).toBe(true)
    // 最终回答开始后仍保留过程正文，不能清空成 []
    expect(presentation.visibleActivities.map((item) => item.block.type)).toEqual(['text'])
    expect(presentation.visibleActivities[0]?.block).toMatchObject({
      type: 'text',
      text: '中间过程说明',
    })
    expect(presentation.finalItems.some((item) => item.kind === 'answer')).toBe(true)
  })

  test('Given 同一波次多条工具 When 流式收起 Then 只露最新工具', () => {
    const turn = createTurn([
      thinking('先定位文件'),
      tool('read-1', 'Read'),
      tool('read-2', 'Read'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-multi-tool',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })

    expect(presentation.visibleActivities).toHaveLength(1)
    expect(presentation.visibleActivities[0]?.block).toMatchObject({
      type: 'tool_use',
      id: 'read-2',
    })
  })

  test('Given 工具已完成但没有最终输出 When Turn 完成 Then 只显示已完成且不伪造已处理折叠', () => {
    const result = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
      },
    }
    const turn = createTurn([tool('tool-1', 'Read')], [result])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })
    expect(presentation.status).toBe('activity-completed')
    expect(presentation.finalAnswerStarted).toBe(false)
    expect(presentation.collapsePolicy.collapsible).toBe(false)
  })

  test('Given wait 工具 When 分类 Then 不进入会话活动也不产生完成状态行', () => {
    const turn = createTurn([tool('wait-1', 'mcp__collaboration__wait_for_delegations')])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })
    expect(presentation.activities).toHaveLength(0)
    expect(presentation.hasRenderableActivity).toBe(false)
    expect(presentation.finalItems).toHaveLength(0)
  })

  test('Given ExitPlanMode 前有 Markdown When 分类 Then 计划位于永久内容而不是活动区', () => {
    const turn = createTurn([
      thinking(),
      text('## 实施步骤\n\n1. 修改展示层'),
      tool('exit-plan', 'ExitPlanMode'),
    ])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })
    expect(presentation.finalItems.map((item) => item.kind)).toEqual([
      'plan',
      'persistent',
    ])
    expect(presentation.activities.map((item) => item.block.type)).toEqual([
      'thinking',
    ])
  })

  test('Given 最终回答已开始且后台子智能体仍运行 When 计算折叠策略 Then 默认保持展开', () => {
    const result = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
      },
    }
    const turn = createTurn([tool('tool-1'), text('最终回答')], [result])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      hasRunningSubagent: true,
    })
    expect(presentation.collapsePolicy.collapsible).toBe(true)
    expect(presentation.collapsePolicy.defaultExpanded).toBe(true)
    expect(presentation.collapsePolicy.blockedReason).toBe('background-agent-running')
  })

  test('Given 用户已有手动状态 When 默认策略变化 Then 手动状态优先', () => {
    const policy = {
      collapsible: true,
      defaultExpanded: false,
    }
    expect(resolveAgentTurnExpanded(policy, 'expanded')).toBe(true)
    expect(resolveAgentTurnExpanded(policy, 'collapsed')).toBe(false)
    expect(resolveAgentTurnExpanded(policy, 'collapsed', true)).toBe(true)
  })

  test('Given Turn 同时包含正文和错误 When 计算状态 Then 不显示正常已处理', () => {
    const turn = createTurn([thinking(), text('部分回答')])
    turn.assistantMessages[0]!.error = {
      message: '执行失败',
    }
    const presentation = buildAgentTurnPresentation({
      id: 'turn-1',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })
    expect(presentation.status).toBe('failed')
    expect(presentation.collapsePolicy.defaultExpanded).toBe(true)
  })

  test('Given 用户中断且无 result 消息 When 计算 Then 用 _createdAt 时间戳推算耗时并显示已停止', () => {
    const userMsg = {
      type: 'user' as const,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text' as const, text: '你好' }] },
      _createdAt: 1_000_000,
    }
    const assistantMsg = {
      type: 'assistant' as const,
      uuid: 'a1',
      parent_tool_use_id: null,
      message: { content: [thinking('分析中')] },
      _createdAt: 1_010_000,
    }
    const systemMsg = {
      type: 'system' as const,
      _createdAt: 1_010_500,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMsg],
      turnMessages: [userMsg, assistantMsg, systemMsg],
      model: 'claude-sonnet-4',
    }
    const presentation = buildAgentTurnPresentation({
      id: 'turn-stopped',
      turn,
      blocks: [thinking('分析中')],
      stoppedByUser: true,
    })
    // 没有 result 消息时，用 _createdAt 差值（10.5 秒 → 11 秒）计算耗时
    expect(presentation.durationMs).toBe(10_500)
    expect(presentation.status).toBe('stopped')
    // 展示层仍可提供手动折叠，但 presentation 不再把停止轮压成最新一行。
    expect(presentation.collapsePolicy.collapsible).toBe(true)
    expect(presentation.collapsePolicy.defaultExpanded).toBe(false)
    expect(presentation.visibleActivities.map((item) => item.block.type)).toEqual(['thinking'])
  })

  test('Given 用户中断且 result 带 _durationMs When 展示 Then 使用 result 耗时', () => {
    const assistantMsg = {
      type: 'assistant' as const,
      uuid: 'a1',
      parent_tool_use_id: null,
      message: { content: [thinking('分析中'), text('先看代码')] },
      _createdAt: 1_000_000,
    }
    const result = {
      type: 'result' as const,
      subtype: 'interrupted',
      usage: { input_tokens: 0, output_tokens: 0 },
      _durationMs: 12_300,
      _createdAt: 1_012_300,
      _stoppedByUser: true,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMsg],
      turnMessages: [assistantMsg, result],
      model: 'claude-sonnet-4',
    }
    const presentation = buildAgentTurnPresentation({
      id: 'turn-stopped-result',
      turn,
      blocks: [thinking('分析中'), text('先看代码')],
      stoppedByUser: true,
      forcedActivityIndexes: new Set([1]),
    })
    expect(presentation.durationMs).toBe(12_300)
    expect(presentation.status).toBe('stopped')
    expect(presentation.hasRenderableActivity).toBe(true)
  })

  test('Given 立即发送产生错误 result 与 interrupted result When 展示旧回合 Then 不把过程正文副本注入为最终正文', () => {
    const processText = '先读取项目说明。'
    const nextProcessText = '已读取项目说明，继续检查应用配置。'
    const assistantMsg = {
      type: 'assistant' as const,
      uuid: 'paused-assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          text(processText),
          tool('read-package'),
          text(nextProcessText),
        ],
      },
    }
    const executionError = {
      type: 'result' as const,
      subtype: 'error_during_execution',
      result: `${processText}${nextProcessText}`,
      errors: ['Request was aborted'],
    }
    const interrupted = {
      type: 'result' as const,
      subtype: 'interrupted',
      _stoppedByUser: true,
      _durationMs: 12_000,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMsg],
      turnMessages: [assistantMsg, executionError, interrupted],
      model: 'claude-sonnet-4',
    }

    const presentation = buildAgentTurnPresentation({
      id: 'turn-immediate-send-interrupted',
      turn,
      blocks: assistantMsg.message.content,
    })

    expect(presentation.status).toBe('stopped')
    expect(presentation.finalItems).toHaveLength(0)
    expect(
      presentation.activities
        .filter((item) => item.block.type === 'text')
        .map((item) => (item.block as { type: 'text'; text: string }).text),
    ).toEqual([processText, nextProcessText])
  })

  
  test('Given 用户中断 result 已落盘且续聊清除 session 标记 When 展示 Then 仍为 stopped 而非已完成', () => {
    const assistantMsg = {
      type: 'assistant' as const,
      uuid: 'a1',
      parent_tool_use_id: null,
      message: { content: [thinking('分析中'), text('先看代码')] },
      _createdAt: 1_000_000,
    }
    const result = {
      type: 'result' as const,
      subtype: 'interrupted',
      usage: { input_tokens: 0, output_tokens: 0 },
      _durationMs: 8_200,
      _createdAt: 1_008_200,
      _stoppedByUser: true,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMsg],
      turnMessages: [assistantMsg, result],
      model: 'claude-sonnet-4',
    }
    const presentation = buildAgentTurnPresentation({
      id: 'turn-stopped-history',
      turn,
      blocks: [thinking('分析中'), text('先看代码')],
      // 续聊后 session 级 stoppedByUser 已清除
      stoppedByUser: false,
      forcedActivityIndexes: new Set([1]),
    })
    expect(presentation.status).toBe('stopped')
    expect(presentation.durationMs).toBe(8_200)
    // 历史停止轮：可折叠、默认收起，续聊不退化成「已完成」
    expect(presentation.collapsePolicy.collapsible).toBe(true)
    expect(presentation.collapsePolicy.defaultExpanded).toBe(false)
  })

  test('Given 多个工具的停止轮已继续新一轮 When 重建历史展示 Then 老工具全部可见且均非运行态', () => {
    const firstTool = tool('stopped-read', 'Read')
    const secondTool = tool('stopped-grep', 'Grep')
    const assistantMsg = {
      type: 'assistant' as const,
      uuid: 'stopped-tools-assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          thinking('先读取再搜索'),
          firstTool,
          secondTool,
        ],
      },
    }
    const interrupted = {
      type: 'result' as const,
      subtype: 'interrupted',
      _stoppedByUser: true,
      _durationMs: 9_000,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMsg],
      turnMessages: [assistantMsg, interrupted],
      model: 'gpt-5.6-sol',
    }

    const presentation = buildAgentTurnPresentation({
      id: 'stopped-tools-history',
      turn,
      blocks: assistantMsg.message.content,
      // 继续新一轮后，会话级停止标记已经清除。
      stoppedByUser: false,
    })

    expect(presentation.status).toBe('stopped')
    expect(
      presentation.visibleActivities
        .filter((item) => item.block.type === 'tool_use')
        .map((item) => ({
          id: (item.block as SDKToolUseBlock).id,
          running: item.running,
        })),
    ).toEqual([
      { id: 'stopped-read', running: false },
      { id: 'stopped-grep', running: false },
    ])
  })

test('Given CCB 最终回复被同步到工具活动之前 When 展示 Then 仍识别为已处理并默认折叠活动', () => {
    const finalMessageId = 'final-message'
    const finalThinking = {
      type: 'assistant' as const,
      uuid: 'final-thinking',
      parent_tool_use_id: null,
      message: {
        id: finalMessageId,
        content: [thinking('已经完成分析，准备回答')],
      },
    }
    const finalText = {
      type: 'assistant' as const,
      uuid: 'final-text',
      parent_tool_use_id: null,
      message: {
        id: finalMessageId,
        content: [text('最终登录流程分析')],
      },
    }
    const activity = {
      type: 'assistant' as const,
      uuid: 'activity',
      parent_tool_use_id: null,
      message: {
        id: 'activity-message',
        content: [thinking('先读取登录相关代码')],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '最终登录流程分析',
      _durationMs: 32_736,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [finalThinking, finalText, activity],
      turnMessages: [finalThinking, finalText, activity, result],
      model: 'deepseek-v4-flash',
    }
    const ordered = orderAssistantMessagesForPresentation(turn)
    expect(ordered.map((message) => message.uuid)).toEqual([
      'activity',
      'final-thinking',
      'final-text',
    ])

    const blocks = ordered.flatMap((message) => message.message.content)
    const presentation = buildAgentTurnPresentation({
      id: 'turn-ccb',
      turn,
      blocks,
    })
    expect(presentation.status).toBe('completed')
    expect(presentation.durationMs).toBe(32_736)
    // 连续的 thinking block 被合并为一个活动项
    expect(presentation.activities.map((item) => item.block.type)).toEqual([
      'thinking',
    ])
    expect(presentation.finalItems.map((item) => item.kind)).toEqual(['answer'])
    expect(presentation.collapsePolicy).toMatchObject({
      collapsible: true,
      defaultExpanded: false,
    })
  })

  test('Given 仅有 tool_result 文本且无 tool_use When 展示 Then 按内容启发式投影工具类型', () => {
    const globResult = {
      type: 'user' as const,
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'glob-missing',
          content: 'Found 40 files limit: 40\nlib/a.dart\nlib/b.dart',
        }],
      },
    }
    const readResult = {
      type: 'user' as const,
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'read-missing-text',
          content: "1\timport 'dart:async';\n2\t",
        }],
      },
    }
    const turn = createTurn(
      [thinking('先找登录相关代码')],
      [globResult, readResult, {
        type: 'result' as const,
        subtype: 'interrupted',
        _stoppedByUser: true,
        _durationMs: 17350,
      } as any],
    )
    const presentation = buildAgentTurnPresentation({
      id: 'turn-content-project',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: false,
      stoppedByUser: true,
    })

    const projected = presentation.activities
      .filter((item) => item.block.type === 'tool_use')
      .map((item) => ({
        id: (item.block as any).id,
        name: (item.block as any).name,
      }))
    expect(projected).toEqual([
      { id: 'glob-missing', name: 'Glob' },
      { id: 'read-missing-text', name: 'Read' },
    ])
    expect(
      presentation.visibleActivities
        .filter((item) => item.block.type === 'tool_use')
        .map((item) => (item.block as { id: string }).id),
    ).toEqual(['glob-missing', 'read-missing-text'])
  })

  test('Given CCB 只保存 Read 结果 When 展示 Then 投影缺失的读取活动并保留最终回答', () => {
    const readResult = createToolResultMessage({
      toolUseId: 'read-missing',
      toolUseResult: {
        type: 'text',
        file: {
          filePath: '/workspace/package.json',
          content: '{"name":"proma"}',
          startLine: 0,
          numLines: 20,
        },
      },
    })
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '读取完成',
    }
    const turn = createTurn(
      [thinking('先检查文件'), text('读取完成')],
      [readResult, result],
    )

    const presentation = buildAgentTurnPresentation({
      id: 'turn-missing-read',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })

    expect(presentation.activities.map((item) => item.block)).toContainEqual({
      type: 'tool_use',
      id: 'read-missing',
      name: 'Read',
      input: {
        file_path: '/workspace/package.json',
        offset: 1,
        limit: 20,
      },
    })
    expect(presentation.finalItems.map((item) => item.block)).toEqual([
      text('读取完成'),
    ])
    expect(presentation.activities.at(-1)?.block).toMatchObject({
      type: 'tool_use',
      id: 'read-missing',
    })
  })

  test('Given CCB 只保存 stdout When 展示 Then 投影缺失的命令活动', () => {
    const bashResult = createToolResultMessage({
      toolUseId: 'bash-missing',
      toolUseResult: {
        stdout: 'hello\n',
        stderr: '',
        interrupted: false,
      },
    })
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '命令完成',
    }
    const turn = createTurn([text('命令完成')], [bashResult, result])

    const presentation = buildAgentTurnPresentation({
      id: 'turn-missing-bash',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })

    expect(presentation.activities.map((item) => item.block)).toEqual([{
      type: 'tool_use',
      id: 'bash-missing',
      name: 'Bash',
      input: {},
    }])
    expect(presentation.finalItems.map((item) => item.kind)).toEqual(['answer'])
  })

  test('Given 已有相同 tool_use When 展示 Then 不重复投影活动', () => {
    const readResult = createToolResultMessage({
      toolUseId: 'read-existing',
      toolUseResult: {
        file: {
          filePath: '/workspace/existing.ts',
          startLine: 0,
          numLines: 10,
        },
      },
    })
    const turn = createTurn(
      [tool('read-existing', 'Read'), text('读取完成')],
      [readResult],
    )

    const presentation = buildAgentTurnPresentation({
      id: 'turn-existing-read',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })

    expect(
      presentation.activities.filter((item) =>
        item.block.type === 'tool_use'
        && item.block.id === 'read-existing',
      ),
    ).toHaveLength(1)
  })

  test('Given 子级 tool_result 有 parent_tool_use_id When 展示 Then 不提升为顶层活动', () => {
    const childResult = createToolResultMessage({
      toolUseId: 'nested-read',
      parentToolUseId: 'parent-agent',
      toolUseResult: {
        file: {
          filePath: '/workspace/nested.ts',
          startLine: 0,
          numLines: 10,
        },
      },
    })
    const turn = createTurn([text('子智能体已完成')], [childResult])

    const presentation = buildAgentTurnPresentation({
      id: 'turn-nested-result',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
    })

    expect(presentation.activities).toHaveLength(0)
    expect(presentation.finalItems.map((item) => item.kind)).toEqual(['answer'])
  })
  test('Given 流式尚无任何活动 When 收起展示 Then 占位正在思考', () => {
    const visible = resolveVisibleTurnActivities([], {
      isStreaming: true,
      finalAnswerStarted: false,
    })
    expect(visible).toHaveLength(1)
    expect(visible[0]?.block.type).toBe('thinking')
    expect(visible[0]?.running).toBe(true)
  })


  test('Given 用户停止且无任何活动 When 收起展示 Then 不伪造正在思考占位', () => {
    const visible = resolveVisibleTurnActivities([], {
      isStreaming: false,
      collapsedSurface: true,
      finalAnswerStarted: false,
    })
    expect(visible).toHaveLength(0)
  })

  test('Given 用户停止且有真实思考 When 收起展示 Then 只露最新一行且非 running', () => {
    const activities = [{
      block: { type: 'thinking', thinking: '先分析登录入口' } as any,
      index: 0,
      foldable: true,
      running: true,
    }]
    const visible = resolveVisibleTurnActivities(activities as any, {
      isStreaming: false,
      collapsedSurface: true,
      finalAnswerStarted: false,
    })
    expect(visible).toHaveLength(1)
    expect(visible[0]?.block).toMatchObject({ type: 'thinking' })
    expect(visible[0]?.running).toBe(false)
  })

  test('Given 工具已完成仍在流式 When 收起展示 Then 回到正在思考而不是停在已完成工具', () => {
    const result = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }],
      },
    }
    const turn = createTurn([
      thinking('先分析'),
      tool('read-1', 'Read'),
    ], [result])
    const presentation = buildAgentTurnPresentation({
      id: 'turn-back-to-thinking',
      turn,
      blocks: turn.assistantMessages[0]!.message.content,
      isStreaming: true,
    })
    expect(presentation.visibleActivities).toHaveLength(1)
    expect(presentation.visibleActivities[0]?.block.type).toBe('thinking')
    expect(presentation.visibleActivities[0]?.running).toBe(true)
  })


  test('Given 多工具波次 When 收集 prior 工具 Then 仅当前波次更早工具', () => {
    const activities = [
      { block: { type: 'thinking', thinking: 'a' } as any, index: 0, foldable: true, running: false },
      { block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } as any, index: 1, foldable: true, running: false },
      { block: { type: 'tool_use', id: 't2', name: 'Read', input: {} } as any, index: 2, foldable: true, running: false },
      { block: { type: 'thinking', thinking: 'b' } as any, index: 3, foldable: true, running: false },
      { block: { type: 'tool_use', id: 't3', name: 'Bash', input: {} } as any, index: 4, foldable: true, running: true },
      { block: { type: 'tool_use', id: 't4', name: 'Bash', input: {} } as any, index: 5, foldable: true, running: true },
    ]
    const prior = collectPriorToolActivities(activities as any, activities[5] as any)
    expect(prior.map((item) => (item.block as any).id)).toEqual(['t3'])
  })

  test('Given 思考前有工具与过程正文 When 收集 prior foldable Then 不含过程正文', () => {
    const activities = [
      { block: { type: 'thinking', thinking: 'a' } as any, index: 0, foldable: true, running: false },
      { block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } as any, index: 1, foldable: true, running: false },
      { block: { type: 'text', text: '过程说明' } as any, index: 2, foldable: false, running: false },
      { block: { type: 'thinking', thinking: 'b' } as any, index: 3, foldable: true, running: true },
    ]
    const prior = collectPriorFoldableActivities(activities as any, activities[3] as any)
    expect(prior.map((item) => item.block.type)).toEqual(['thinking', 'tool_use'])
  })


})
