import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  clearMatchedPartialAssistants,
  flushPartialAssistantsToAccumulated,
  stripKnownToolUseBlocks,
} from './agent-partial-flush'

function assistant(opts: {
  uuid: string
  messageId: string
  content: Array<Record<string, unknown>>
  partial?: boolean
  partialIndex?: number
}): SDKMessage {
  return {
    type: 'assistant',
    uuid: opts.uuid,
    parent_tool_use_id: null,
    ...(opts.partial ? { _partial: true } : {}),
    ...(opts.partialIndex !== undefined ? { _partialBlockIndex: opts.partialIndex } : {}),
    message: {
      id: opts.messageId,
      content: opts.content,
    },
  } as SDKMessage
}

function result(subtype: 'success' | 'interrupted' = 'success'): SDKMessage {
  return {
    type: 'result',
    subtype,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  } as SDKMessage
}

describe('agent-partial-flush', () => {
  test('Given partial 含过程正文与已回填 tool_use When flush Then 剥离工具并保留正文', () => {
    const partials = new Map<string, SDKMessage>([
      [
        'uuid:ccb-partial:msg-1:0',
        assistant({
          uuid: 'ccb-partial:msg-1:0',
          messageId: 'msg-1',
          partial: true,
          partialIndex: 0,
          content: [
            { type: 'text', text: '我先看项目结构' },
            { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
          ],
        }),
      ],
    ])
    const accumulated: SDKMessage[] = [
      assistant({
        uuid: 'backfill-tool',
        messageId: 'msg-backfill',
        content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
      }),
    ]
    const known = new Set(['call-1'])

    flushPartialAssistantsToAccumulated(partials, accumulated, known)

    const texts = accumulated
      .flatMap((message) => {
        const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } })
          .message?.content
        return Array.isArray(content) ? content : []
      })
      .filter((block) => block.type === 'text')
      .map((block) => block.text)

    expect(texts).toContain('我先看项目结构')
    expect(partials.size).toBe(0)
  })

  test('Given 仅已知 tool_use 的 partial When flush Then 不重复落盘', () => {
    const partials = new Map<string, SDKMessage>([
      [
        'uuid:ccb-partial:msg-1:0',
        assistant({
          uuid: 'ccb-partial:msg-1:0',
          messageId: 'msg-1',
          partial: true,
          content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }],
        }),
      ],
    ])
    const accumulated: SDKMessage[] = []
    flushPartialAssistantsToAccumulated(partials, accumulated, new Set(['call-1']))
    expect(accumulated).toHaveLength(0)
  })

  test('Given ccb-finalized 无 block 索引 When clearMatched Then 清除同 messageId 全部 partial', () => {
    const partials = new Map<string, SDKMessage>([
      [
        'uuid:ccb-partial:msg-1:0',
        assistant({
          uuid: 'ccb-partial:msg-1:0',
          messageId: 'msg-1',
          partial: true,
          content: [{ type: 'text', text: '过程' }],
        }),
      ],
      [
        'uuid:ccb-partial:msg-2:0',
        assistant({
          uuid: 'ccb-partial:msg-2:0',
          messageId: 'msg-2',
          partial: true,
          content: [{ type: 'text', text: '其他' }],
        }),
      ],
    ])
    clearMatchedPartialAssistants(
      partials,
      assistant({
        uuid: 'ccb-finalized:msg-1',
        messageId: 'msg-1',
        content: [{ type: 'text', text: '过程' }],
      }),
    )
    expect([...partials.keys()]).toEqual(['uuid:ccb-partial:msg-2:0'])
  })

  test('stripKnownToolUseBlocks 保留正文', () => {
    const message = assistant({
      uuid: 'p',
      messageId: 'msg-1',
      content: [
        { type: 'text', text: '正文' },
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: {} },
      ],
    })
    const stripped = stripKnownToolUseBlocks(message, new Set(['call-1']))
    expect(stripped).toBeDefined()
    const content = (stripped as { message: { content: Array<{ type: string }> } }).message.content
    expect(content.map((block) => block.type)).toEqual(['text'])
  })

  test('Given 最终正文与 success result 已到达 When flush thinking partial Then thinking 位于正文和 result 之前', () => {
    const partials = new Map<string, SDKMessage>([
      [
        'uuid:thinking-partial',
        assistant({
          uuid: 'thinking-partial',
          messageId: 'thinking-message',
          partial: true,
          content: [{ type: 'thinking', thinking: '分析项目结构' }],
        }),
      ],
    ])
    const accumulated: SDKMessage[] = [
      assistant({
        uuid: 'final-answer',
        messageId: 'final-message',
        content: [{ type: 'text', text: '这是最终正文' }],
      }),
      result('success'),
    ]

    flushPartialAssistantsToAccumulated(partials, accumulated)

    expect(accumulated.map((message) => message.type)).toEqual([
      'assistant',
      'assistant',
      'result',
    ])
    const firstContent = (accumulated[0] as {
      message: { content: Array<{ type: string }> }
    }).message.content
    expect(firstContent[0]?.type).toBe('thinking')
    expect((accumulated[0] as unknown as Record<string, unknown>)._createdAt).toBeUndefined()
  })

  test('Given 最终 assistant 同时含 thinking 与正文 When flush partial Then partial 仍插到最终 assistant 之前', () => {
    const partials = new Map<string, SDKMessage>([
      [
        'uuid:thinking-partial',
        assistant({
          uuid: 'thinking-partial',
          messageId: 'thinking-message',
          partial: true,
          content: [{ type: 'thinking', thinking: '更早的分析' }],
        }),
      ],
    ])
    const accumulated: SDKMessage[] = [
      assistant({
        uuid: 'final-answer',
        messageId: 'final-message',
        content: [
          { type: 'thinking', thinking: '最终整理' },
          { type: 'text', text: '这是最终正文' },
        ],
      }),
      result('success'),
    ]

    flushPartialAssistantsToAccumulated(partials, accumulated)

    const firstContent = (accumulated[0] as {
      message: { content: Array<{ type: string; thinking?: string }> }
    }).message.content
    expect(firstContent).toEqual([{ type: 'thinking', thinking: '更早的分析' }])
    expect(accumulated.at(-1)?.type).toBe('result')
  })

  test('Given 工具过程与 interrupted result 已到达 When flush thinking partial Then thinking 不落到 result 后', () => {
    const partials = new Map<string, SDKMessage>([
      [
        'uuid:thinking-partial',
        assistant({
          uuid: 'thinking-partial',
          messageId: 'thinking-message',
          partial: true,
          content: [{ type: 'thinking', thinking: '停止前的分析' }],
        }),
      ],
    ])
    const accumulated: SDKMessage[] = [
      assistant({
        uuid: 'tool-use',
        messageId: 'tool-message',
        content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }],
      }),
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
        },
      } as SDKMessage,
      result('interrupted'),
    ]

    flushPartialAssistantsToAccumulated(partials, accumulated)

    expect(accumulated.map((message) => message.type)).toEqual([
      'assistant',
      'user',
      'assistant',
      'result',
    ])
    const flushedContent = (accumulated[2] as {
      message: { content: Array<{ type: string; thinking?: string }> }
    }).message.content
    expect(flushedContent).toEqual([{ type: 'thinking', thinking: '停止前的分析' }])
    expect((accumulated[2] as unknown as Record<string, unknown>)._createdAt).toBeUndefined()
  })
})
