import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { getContextCompactionProgress, isCompactionControlHistoryGroup } from './AgentMessages'

function systemMessage(fields: Record<string, unknown>): SDKMessage {
  return { type: 'system', ...fields } as unknown as SDKMessage
}

describe('context compaction status line state', () => {
  test('hides manual control messages but keeps completed boundary in history', () => {
    expect(isCompactionControlHistoryGroup({
      type: 'user',
      message: { type: 'user', message: { content: [{ type: 'text', text: '/compact' }] } },
    } as never)).toBe(true)
    expect(isCompactionControlHistoryGroup({
      type: 'user',
      message: { type: 'user', message: { content: [{ type: 'text', text: '/summarize' }] } },
    } as never)).toBe(false)
    expect(isCompactionControlHistoryGroup({
      type: 'system',
      message: { type: 'system', subtype: 'compact_boundary' },
    } as never)).toBe(false)
    expect(isCompactionControlHistoryGroup({
      type: 'system',
      message: { type: 'system', subtype: 'context_compaction_config' },
    } as never)).toBe(true)
    expect(isCompactionControlHistoryGroup({
      type: 'user',
      message: { type: 'user', message: { content: [{ type: 'text', text: '继续处理当前任务' }] } },
    } as never)).toBe(false)
  })


  test('shows a running state before the SDK emits a compacting message', () => {
    expect(getContextCompactionProgress([], true, undefined)).toMatchObject({
      status: 'running',
      placement: 'tail',
    })
  })

  test('retains a no-op terminal state after live messages are cleared', () => {
    expect(getContextCompactionProgress([], false, {
      status: 'noop',
      message: '当前上下文较小，暂时无需压缩。',
    })).toMatchObject({
      status: 'noop',
      placement: 'tail',
    })
  })

  test('maps successful compaction to its original history position', () => {
    expect(getContextCompactionProgress([
      systemMessage({ subtype: 'compact_boundary', summary: '已完成的工作已整理。' }),
    ], false, undefined)).toMatchObject({
      status: 'success',
      placement: 'history',
    })
  })

  test('keeps automatic source and token reduction as status-line metadata', () => {
    expect(getContextCompactionProgress([], false, {
      status: 'success',
      trigger: 'auto',
      preTokens: 168_000,
      postTokens: 24_000,
    })).toMatchObject({
      status: 'success',
      placement: 'tail',
      trigger: 'auto',
      preTokens: 168_000,
      postTokens: 24_000,
    })
  })

  test('manual running state uses the shared realtime line', () => {
    expect(getContextCompactionProgress([], false, {
      status: 'running',
      trigger: 'manual',
    })).toMatchObject({
      status: 'running',
      placement: 'tail',
      trigger: 'manual',
    })
  })

  test('auto running state uses the same realtime line implementation', () => {
    expect(getContextCompactionProgress([], false, {
      status: 'running',
      trigger: 'auto',
    })).toMatchObject({
      status: 'running',
      placement: 'tail',
      trigger: 'auto',
    })
  })

  test('persisted auto compact boundary preserves source without changing the label path', () => {
    expect(getContextCompactionProgress([
      systemMessage({ subtype: 'compact_boundary', compactTrigger: 'auto' }),
    ], false, undefined)).toMatchObject({
      status: 'success',
      placement: 'history',
      trigger: 'auto',
    })
  })

  test('maps a no-op result to a clear terminal state', () => {
    expect(getContextCompactionProgress([
      systemMessage({
        subtype: 'status',
        compact_result: 'noop',
        message: '当前上下文较小，暂时无需压缩。',
      }),
    ], false, undefined)).toMatchObject({
      status: 'noop',
      placement: 'history',
    })
  })

  test('keeps compaction failures visible with their error details', () => {
    expect(getContextCompactionProgress([
      systemMessage({
        subtype: 'status',
        compact_result: 'failed',
        compact_error: 'provider unavailable',
      }),
    ], false, undefined)).toMatchObject({
      status: 'failed',
      placement: 'history',
      detail: 'provider unavailable',
    })
  })

  test('uses stopped as a tail fallback when no persisted terminal message exists', () => {
    expect(getContextCompactionProgress([], false, {
      status: 'stopped',
      trigger: 'manual',
    })).toMatchObject({
      status: 'stopped',
      placement: 'tail',
      trigger: 'manual',
    })
  })

  test('prefers stopped over the latest compacting message while waiting for the native terminal event', () => {
    expect(getContextCompactionProgress([
      systemMessage({
        subtype: 'compacting',
        compactTrigger: 'manual',
      }),
    ], false, {
      status: 'stopped',
      trigger: 'manual',
    })).toMatchObject({
      status: 'stopped',
      placement: 'tail',
    })
  })

  test('prefers failed and noop control results over a stale compacting message', () => {
    const messages = [systemMessage({ subtype: 'compacting' })]

    expect(getContextCompactionProgress(messages, false, {
      status: 'failed',
      message: 'send failed',
    })).toMatchObject({
      status: 'failed',
      placement: 'tail',
      detail: 'send failed',
    })
    expect(getContextCompactionProgress(messages, false, {
      status: 'noop',
    })).toMatchObject({
      status: 'noop',
      placement: 'tail',
    })
  })

  test('does not let an old history terminal state suppress a new optimistic running request', () => {
    expect(getContextCompactionProgress([
      systemMessage({ subtype: 'compact_boundary' }),
    ], true, {
      status: 'running',
      trigger: 'manual',
    })).toMatchObject({
      status: 'running',
      placement: 'tail',
      trigger: 'manual',
    })
  })

  test('uses a visible tail fallback when success arrives before its boundary message', () => {
    expect(getContextCompactionProgress([], false, {
      status: 'success',
      trigger: 'auto',
    })).toMatchObject({
      status: 'success',
      placement: 'tail',
      trigger: 'auto',
    })
  })

  test('replaces a persisted abort failure with stopped in place instead of rendering two rows', () => {
    expect(getContextCompactionProgress([
      systemMessage({
        subtype: 'status',
        compact_result: 'failed',
        compact_error: 'aborted',
      }),
    ], false, {
      status: 'stopped',
      trigger: 'manual',
    })).toMatchObject({
      status: 'stopped',
      placement: 'history',
    })
  })

  test('does not render a terminal state at the tail when the system message already owns its position', () => {
    expect(getContextCompactionProgress([
      systemMessage({
        subtype: 'status',
        compact_result: 'noop',
      }),
    ], false, {
      status: 'noop',
      trigger: 'auto',
    })).toMatchObject({
      status: 'noop',
      placement: 'history',
    })
  })
})
