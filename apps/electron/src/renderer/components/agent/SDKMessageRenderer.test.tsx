import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  SDKAssistantMessage,
  SDKContentBlock,
  SDKSystemMessage,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@proma/shared'
import type { AssistantTurn } from '@proma/session-core'
import {
  agentRuntimeExecutionGraphsAtom,
  agentSessionsAtom,
} from '@/atoms/agent-atoms'
import { agentTimelineExpandedAtom } from '@/atoms/agent-timeline-atoms'
import {
  AssistantTurnRenderer,
  MessageGroupRenderer,
  SDKMessageRenderer,
} from './SDKMessageRenderer'

function indexOfOccurrence(html: string, marker: string, occurrence: number): number {
  let index = -1
  for (let current = 0; current < occurrence; current += 1) {
    index = html.indexOf(marker, index + 1)
  }
  return index
}

function renderAgentUserMessage(text: string): string {
  const message: SDKUserMessage = {
    type: 'user',
    uuid: 'cursor-user-message',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'text', text }],
    },
  }
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <SDKMessageRenderer message={message} allMessages={[message]} />
    </Provider>,
  )
}

describe('Agent 用户消息视觉', () => {
  test('Given Agent 短用户输入 When 服务端渲染 Then 卡片按内容宽度右对齐、正文左对齐且操作悬浮出现', () => {
    const html = renderAgentUserMessage('请继续核对 Cursor 风格的用户消息。')
    const messageTag = html.match(/<div\b[^>]*data-agent-user-message="true"[^>]*>/)?.[0] ?? ''
    const cardTag = html.match(/<div\b[^>]*data-agent-user-card="true"[^>]*>/)?.[0] ?? ''

    expect(html).toContain('data-agent-user-message="true"')
    expect(html).toContain('group/agent-user')
    expect(messageTag).toContain('items-end')
    expect(messageTag).not.toContain('items-start')
    expect(html).toContain('data-agent-user-card="true"')
    expect(html).toContain('group-[.is-user]:w-fit')
    expect(html).toContain('group-[.is-user]:max-w-full')
    expect(cardTag).toContain('group-[.is-user]:ml-auto')
    expect(cardTag).not.toContain('group-[.is-user]:ml-0')
    expect(cardTag).toContain('group-[.is-user]:items-start')
    expect(cardTag).not.toContain('text-right')
    expect(html).toContain('group-[.is-user]:rounded-xl')
    expect(html).toContain('group-[.is-user]:bg-muted/50')
    expect(html).toContain('group-[.is-user]:px-4')
    expect(html).toContain('shadow-sm')
    expect(html).toContain('data-agent-user-body="true"')
    expect(html).toContain('[--md-preview-font-size:14px]')
    expect(html).toContain('leading-6')
    expect(html).toContain('font-normal')
    expect(html).toContain('请继续核对 Cursor 风格的用户消息。')
    expect(html).toContain('data-agent-user-actions="true"')
    expect(html).toContain('opacity-0')
    expect(html).toContain('group-hover/agent-user:opacity-100')
    expect(html).toContain('group-focus-within/agent-user:opacity-100')
  })

  test('Given 用户消息复制按钮 When 悬停显示 Then 操作栏在气泡外独立占位且没有叠加卡片样式', () => {
    const html = renderAgentUserMessage('短消息')
    const actionsTag = html.match(/<div\b[^>]*data-agent-user-actions="true"[^>]*>/)?.[0] ?? ''

    expect(actionsTag).toContain('h-7')
    expect(actionsTag).toContain('group-[.is-user]:ml-auto')
    expect(actionsTag).not.toContain('absolute')
    expect(actionsTag).not.toContain('translate-y')
    expect(actionsTag).not.toContain('bg-background')
    expect(actionsTag).not.toContain('shadow')
    expect(actionsTag).not.toContain('backdrop-blur')
    // 正文和气泡都已闭合，操作栏才开始，避免按钮与气泡边缘重叠。
    expect(html).toContain(`</div></div>${actionsTag}`)
    expect(html).toContain('group-focus-within/agent-user:opacity-100')
    expect(html).toContain('复制')
  })

  test('Given Agent 长用户输入 When 超过可用列宽 Then 卡片受列宽约束并保留完整正文', () => {
    const longText = Array.from(
      { length: 24 },
      (_, index) => `第 ${index + 1} 段需要保留的用户输入`,
    ).join('，')
    const html = renderAgentUserMessage(longText)

    expect(html).toContain('data-agent-user-card="true"')
    expect(html).toContain('group-[.is-user]:w-fit')
    expect(html).toContain('group-[.is-user]:max-w-full')
    expect(html).toContain('break-words')
    expect(html).toContain(longText)
    expect(html.match(/data-agent-user-actions="true"/g)).toHaveLength(1)
  })

  test('Given 乐观用户消息尚未被 Pi 消费 When 分组渲染 Then 气泡略淡且保持右对齐自适应宽度', () => {
    const message: SDKUserMessage = {
      type: 'user',
      uuid: 'pending-user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '立即调整下一步。' }],
      },
    }
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <MessageGroupRenderer
          group={{ type: 'user', message }}
          allMessages={[message]}
          pendingUserMessage
        />
      </Provider>,
    )
    const cardTag = html.match(/<div\b[^>]*data-agent-user-card="true"[^>]*>/)?.[0] ?? ''

    expect(cardTag).toContain('data-agent-user-pending="true"')
    expect(cardTag).toContain('opacity-70')
    expect(cardTag).toContain('group-[.is-user]:w-fit')
    expect(cardTag).toContain('group-[.is-user]:max-w-full')
    expect(cardTag).toContain('group-[.is-user]:ml-auto')
    expect(html).not.toContain('正在处理')
  })

  test('Given 同 UUID 原生用户消息已到但乐观清理尚未完成 When 分组渲染 Then 原位恢复正常明度', () => {
    const message: SDKUserMessage = {
      type: 'user',
      uuid: 'consumed-user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '已被 Pi 消费。' }],
      },
    }
    Object.assign(message, { _promaNativeMessage: true })
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <MessageGroupRenderer
          group={{ type: 'user', message }}
          allMessages={[message]}
          pendingUserMessage={false}
        />
      </Provider>,
    )
    const cardTag = html.match(/<div\b[^>]*data-agent-user-card="true"[^>]*>/)?.[0] ?? ''

    expect(cardTag).not.toContain('data-agent-user-pending')
    expect(cardTag).not.toContain('opacity-70')
    expect(cardTag).toContain('group-[.is-user]:w-fit')
    expect(cardTag).toContain('group-[.is-user]:ml-auto')
    expect(html).not.toContain('正在处理')
  })

  test('Given Agent 助手正文 When 渲染 Then 保留 16px 左侧内边距且助手操作栏不重复缩进', () => {
    const assistantMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'aligned-assistant-message',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'text',
          text: '助手正文与用户卡片正文对齐。',
        }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '助手正文与用户卡片正文对齐。',
      usage: {
        input_tokens: 8,
        output_tokens: 12,
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMessage],
      turnMessages: [assistantMessage, result],
      model: 'gpt-5.6-sol',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[assistantMessage, result]}
          sessionId="aligned-session"
          turnId="aligned-turn"
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-assistant-message="true"')
    expect(html).toContain('data-agent-assistant-content="true"')
    expect(html).toContain('group-[.is-assistant]:pl-4')
    expect(html).not.toContain('group-[.is-assistant]:pl-8')
    expect(html).toContain('data-agent-final-answer="true"')
    expect(html).toContain('助手正文与用户卡片正文对齐。')
    expect(html.match(/data-agent-assistant-actions="true"/g)).toHaveLength(1)
  })
})

describe('SDKMessageRenderer 上下文压缩状态', () => {
  function renderSystemMessage(message: SDKSystemMessage): string {
    return renderToStaticMarkup(
      <Provider store={createStore()}>
        <SDKMessageRenderer message={message} allMessages={[message]} />
      </Provider>,
    )
  }

  test('Given 压缩正在进行 When 渲染 Then 使用单行灰字且不显示 spinner、卡片或分隔线', () => {
    const message = {
      type: 'system',
      subtype: 'compacting',
      compactTrigger: 'manual',
    } as SDKSystemMessage
    const html = renderSystemMessage(message)

    expect(html).toContain('data-agent-compaction-status="running"')
    expect(html).toContain('正在压缩上下文')
    expect(html).toContain('text-muted-foreground')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('h-px')
    expect(html).not.toContain('开始压缩上下文')
  })

  test('Given 自动压缩完成边界 When 历史渲染 Then 原位显示统一完成行且来源和 token 仅保留在 tooltip', () => {
    const message = {
      type: 'system',
      subtype: 'compact_boundary',
      compactTrigger: 'auto',
      compactPreTokens: 168_000,
      compactionEstimatedTokensAfter: 24_000,
    } as SDKSystemMessage
    const html = renderSystemMessage(message)

    expect(html).toContain('data-agent-compaction-status="success"')
    expect(html).toContain('上下文已压缩')
    expect(html).toContain('title="自动触发。 上下文约 168.0k → 24.0k tokens。"')
    expect(html).not.toContain('上下文已自动压缩')
    expect(html).not.toContain('h-px')
  })

  test('Given 压缩失败或无需执行 When 渲染 Then 终态不丢失且详情不扩张成错误卡片', () => {
    const failed = renderSystemMessage({
      type: 'system',
      subtype: 'status',
      compact_result: 'failed',
      compact_error: 'provider unavailable',
    })
    const noop = renderSystemMessage({
      type: 'system',
      subtype: 'status',
      compact_result: 'noop',
    })

    expect(failed).toContain('data-agent-compaction-status="failed"')
    expect(failed).toContain('上下文压缩失败')
    expect(failed).toContain('title="provider unavailable"')
    expect(failed).not.toContain('border-destructive')
    expect(noop).toContain('data-agent-compaction-status="noop"')
    expect(noop).toContain('当前上下文无需压缩')
  })

  test('Given Runtime 持久化 stopped 终态 When 渲染 Then 直接显示停止状态行', () => {
    const html = renderSystemMessage({
      type: 'system',
      subtype: 'status',
      compact_result: 'stopped',
    })

    expect(html).toContain('data-agent-compaction-status="stopped"')
    expect(html).toContain('上下文压缩已停止')
    expect(html).not.toContain('上下文压缩失败')
  })

  test('Given 用户停止时已持久化 abort failed When 分组渲染 Then 原位替换为 stopped 而不是同时显示失败行', () => {
    const failedMessage: SDKSystemMessage = {
      type: 'system',
      subtype: 'status',
      compact_result: 'failed',
      compact_error: 'aborted',
    }
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <MessageGroupRenderer
          group={{
            type: 'system',
            message: failedMessage,
            identityMessage: failedMessage,
          }}
          allMessages={[failedMessage]}
          compactionStatusOverride="stopped"
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-compaction-status="stopped"')
    expect(html).toContain('上下文压缩已停止')
    expect(html).not.toContain('上下文压缩失败')
    expect(html.match(/data-agent-compaction-bubble-id="summarization"/g)).toHaveLength(1)
  })
})

describe('AssistantTurnRenderer 流式活动折叠', () => {
  test('Given 多条 stop_reason=tool_use 的思考和过程文本 When 最新正文仍在流式渲染 Then 按原顺序穿插且思考默认收起', () => {
    const firstThinking: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'thinking-1',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{
          type: 'thinking',
          thinking: '先搜索登录入口。',
        }],
      },
    }
    const firstProcessText: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'process-text-1',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{
          type: 'text',
          text: '主源码目录确实有登录相关实现。让我并行读取核心文件。',
        }],
      },
    }
    const secondThinking: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'thinking-2',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{
          type: 'thinking',
          thinking: '继续检查 IPC 和 preload。',
        }],
      },
    }
    const latestProcessText: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'process-text-2',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{
          type: 'text',
          text: '现在看 IPC 桥接、preload 和 App 路由。',
        }],
      },
    }
    const assistantMessages = [
      firstThinking,
      firstProcessText,
      secondThinking,
      latestProcessText,
    ]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages: assistantMessages,
      model: 'deepseek-v4-flash',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={assistantMessages}
          sessionId="process-session"
          turnId="process-turn"
          isStreaming
          isLatestAssistantTurn
          runningStartedAt={Date.now() - 4_200}
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('现在看 IPC 桥接、preload 和 App 路由。')
    expect(html).toContain('主源码目录确实有登录相关实现')
    expect(html.match(/data-agent-timeline-entry="thinking"/g)).toHaveLength(2)
    expect(html.match(/>已思考</g)).toHaveLength(2)
    expect(html).not.toContain('>正在思考<')
    expect(html).not.toContain('先搜索登录入口。')
    expect(html).not.toContain('继续检查 IPC 和 preload。')
    const surfaceProcessCount = (html.match(/data-agent-activity="process-text"/g) ?? []).length
    expect(surfaceProcessCount).toBe(2)
    const firstThinkingIndex = indexOfOccurrence(html, 'data-agent-timeline-entry="thinking"', 1)
    const firstProcess = html.indexOf('主源码目录确实有登录相关实现')
    const secondThinkingIndex = indexOfOccurrence(html, 'data-agent-timeline-entry="thinking"', 2)
    const secondProcess = html.indexOf('现在看 IPC 桥接、preload 和 App 路由。')
    expect(firstThinkingIndex).toBeGreaterThanOrEqual(0)
    expect(firstProcess).toBeGreaterThan(firstThinkingIndex)
    expect(secondThinkingIndex).toBeGreaterThan(firstProcess)
    expect(secondProcess).toBeGreaterThan(firstProcess)
    expect(secondProcess).toBeGreaterThan(secondThinkingIndex)
  })

  test('Given 父流已结束但子智能体仍运行 When 渲染最新 Turn Then 只展示最新子智能体活动且不伪造已处理顶栏', () => {
    const agentTool: SDKToolUseBlock = {
      type: 'tool_use',
      id: 'agent-tool-1',
      name: 'Agent',
      input: {
        name: 'Explore',
        prompt: '检查登录流程',
      },
    }
    const blocks: SDKContentBlock[] = [
      {
        type: 'thinking',
        thinking: '先分析登录入口。',
      },
      {
        type: 'text',
        text: '我先定位登录入口，再创建子智能体。',
      },
      agentTool,
    ]
    const assistantMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-1',
      parent_tool_use_id: null,
      message: {
        content: blocks,
      },
    }
    const parentResult = {
      type: 'result' as const,
      subtype: 'success',
      result: '',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMessage],
      turnMessages: [assistantMessage, parentResult],
      model: 'gpt-5.6-sol',
    }
    const store = createStore()
    store.set(agentRuntimeExecutionGraphsAtom, new Map([[
      'parent-session',
      {
        runtimeSessionId: 'runtime-session',
        nodes: [{
          id: 'runtime-agent-1',
          kind: 'subagent',
          name: 'Explore',
          description: '检查登录流程',
          status: 'running',
          startedAt: Date.now() - 3_200,
          toolUseId: agentTool.id,
          transcriptAvailable: true,
          model: 'gpt-5.6-sol',
        }],
        todos: [],
        updatedAt: Date.now(),
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[assistantMessage, parentResult]}
        sessionId="parent-session"
        turnId="turn-1"
        isLatestAssistantTurn
        backgroundWaiting
        runningStartedAt={Date.now() - 3_200}
        />
      </Provider>,
    )

    // 父流结束但子智能体仍运行：整轮保持展开，子智能体工具组默认展开。
    expect(html).toContain('Explore')
    expect(html).toContain('正在运行')
    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('已处理')
    expect(html).toContain('我先定位登录入口')
    expect(html).toContain('已创建子智能体')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-agent-timeline-entry="tools"')
    expect(html).toContain('data-state="open" data-agent-timeline-entry="tools"')
    const thinkingIndex = html.indexOf('data-agent-timeline-entry="thinking"')
    const processIndex = html.indexOf('我先定位登录入口')
    const toolsIndex = html.indexOf('data-agent-timeline-entry="tools"')
    expect(processIndex).toBeGreaterThan(thinkingIndex)
    expect(toolsIndex).toBeGreaterThan(processIndex)
  })


  test('Given 流式开局尚无任何 block When 渲染超过 1 秒 Then 只显示单行中性等待反馈', () => {
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [],
      turnMessages: [],
      model: 'deepseek-v4-flash',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[]}
          sessionId="empty-stream-session"
          turnId="empty-stream-turn"
          isStreaming
          isLatestAssistantTurn
          runningStartedAt={Date.now() - 2_500}
        />
      </Provider>,
    )

    expect(html).toContain('正在准备下一步')
    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html.match(/正在准备下一步/g)).toHaveLength(1)
    expect(html).not.toContain('正在思考')
    expect(html).toContain('role="status"')
    expect(html).toContain('agent-status-shimmer')
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('已处理')
    expect(html).not.toContain('data-agent-timeline-entry')
    expect(html).not.toContain('data-agent-status-divider')
    expect(html).not.toContain('aria-expanded')
  })

  test('Given 子智能体详情隐藏 final 且空 assistant 首帧流式中 When 渲染 Then 仍只显示单行中性等待反馈', () => {
    const emptyAssistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'empty-subagent-assistant',
      parent_tool_use_id: null,
      message: {
        content: [],
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [emptyAssistant],
      turnMessages: [emptyAssistant],
      model: 'gpt-5.6-sol',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[emptyAssistant]}
          sessionId="empty-subagent-session"
          turnId="empty-subagent-turn"
          isStreaming
          isLatestAssistantTurn
          hideFinalItems
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).toContain('role="status"')
    expect(html.match(/正在准备下一步/g)).toHaveLength(1)
    expect(html).not.toContain('正在思考')
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('data-agent-timeline-entry')
    expect(html).not.toContain('data-agent-final-answer')
    expect(html).not.toContain('aria-expanded')
  })

  test('Given 正常结束且已有最终正文 When 渲染 Then 思考标题原位可见且正文详情仍默认收起', () => {
    const thinkingMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'thinking-done',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'thinking',
          thinking: '已经分析完成。',
        }],
      },
    }
    const answerMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'answer-done',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'text',
          text: '这是最终回答正文。',
        }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '这是最终回答正文。',
      _durationMs: 12_000,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [thinkingMsg, answerMsg],
      turnMessages: [thinkingMsg, answerMsg, result],
      model: 'claude-sonnet-4',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[thinkingMsg, answerMsg, result]}
          sessionId="done-session"
          turnId="done-turn"
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('已思考')
    expect(html).toContain('已处理 12 秒')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-agent-final-answer="true"')
    expect(html).toContain('这是最终回答正文。')
    expect(html).not.toContain('已经分析完成')
    expect(html.indexOf('已处理 12 秒')).toBeGreaterThan(
      html.indexOf('这是最终回答正文。'),
    )
  })

  test('Given 正常完成但旧执行图仍有运行节点 When 渲染最新 Turn Then 保留历史标题且不把旧节点恢复为运行态', () => {
    const assistantMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'stale-graph-assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '这部分已经完成。' },
          { type: 'tool_use', id: 'stale-tool', name: 'Read', input: { file_path: '/tmp/a' } },
          { type: 'text', text: '最终正文。' },
        ],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '最终正文。',
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMessage],
      turnMessages: [assistantMessage, result],
      model: 'gpt-5.6-sol',
    }
    const store = createStore()
    store.set(agentRuntimeExecutionGraphsAtom, new Map([[
      'stale-graph-session',
      {
        runtimeSessionId: 'runtime-session',
        nodes: [{
          id: 'stale-node',
          kind: 'subagent',
          name: 'Read',
          description: '旧执行节点',
          status: 'running',
          toolUseId: 'stale-tool',
          transcriptAvailable: true,
        }],
        todos: [],
        updatedAt: Date.now(),
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[assistantMessage, result]}
          sessionId="stale-graph-session"
          turnId="stale-graph-turn"
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('已思考')
    expect(html).toContain('data-agent-timeline-entry="tools"')
    expect(html).toContain('已查看 1 个文件')
    expect(html).toContain('已处理')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-agent-final-answer="true"')
    expect(html).toContain('最终正文。')
    expect(html).not.toContain('data-agent-activity="tool"')
    expect(html).not.toContain('agent-status-shimmer')
    expect(html).not.toContain('旧执行节点')
  })

  test('Given 流式正文已经出现 When 本轮尚未结束 Then 正文仍属于时间线且不会提前拆成 final', () => {
    const thinkingMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'thinking-before-final-stream',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'thinking',
          thinking: '正在整理最终结论。',
        }],
      },
    }
    const answerMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'answer-still-streaming',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'text',
          text: '这是正在流式生成的最终正文。',
        }],
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [thinkingMsg, answerMsg],
      turnMessages: [thinkingMsg, answerMsg],
      model: 'claude-sonnet-4',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[thinkingMsg, answerMsg]}
          sessionId="final-stream-session"
          turnId="final-stream-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('已思考')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-agent-activity="process-text"')
    expect(html).toContain('这是正在流式生成的最终正文。')
    expect(html).not.toContain('data-agent-final-answer="true"')
    expect(html).not.toContain('正在整理最终结论。')
    expect(html).not.toContain('正在思考')
  })

  test('Given 工具后正文已开始且子智能体节点仍运行 When 流式渲染 Then 正文留在时间线且子智能体工具保持展开', () => {
    const thinkingMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'thinking-before-final-with-stale-node',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'thinking',
          thinking: '正在整理项目架构。',
        }],
      },
    }
    const toolMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'tool-before-final-with-stale-node',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'stale-read-before-final',
          name: 'Read',
          input: { file_path: '/tmp/project.ts' },
        }],
      },
    }
    const toolResult = {
      type: 'user' as const,
      uuid: 'tool-result-before-final-with-stale-node',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'stale-read-before-final',
          content: 'project content',
        }],
      },
    }
    const answerMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'answer-with-stale-running-node',
      parent_tool_use_id: null,
      _partial: true,
      message: {
        content: [{
          type: 'text',
          text: 'Proma 是一个本地优先的 Agent 工作台。',
        }],
      },
    } as SDKAssistantMessage
    const assistantMessages = [thinkingMsg, toolMsg, answerMsg]
    const turnMessages = [
      thinkingMsg,
      toolMsg,
      toolResult,
      answerMsg,
    ]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'gpt-5.6-sol',
    }
    const store = createStore()
    store.set(agentRuntimeExecutionGraphsAtom, new Map([[
      'final-with-stale-node-session',
      {
        runtimeSessionId: 'runtime-session',
        nodes: [{
          id: 'stale-read-node',
          kind: 'subagent',
          name: 'Read',
          description: '读取项目文件',
          status: 'running',
          toolUseId: 'stale-read-before-final',
          transcriptAvailable: true,
        }],
        todos: [],
        updatedAt: Date.now(),
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="final-with-stale-node-session"
          turnId="final-with-stale-node-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-state="open" data-agent-timeline-entry="tools"')
    expect(html).toContain('project.ts')
    expect(html).toContain('data-agent-activity="process-text"')
    expect(html).toContain('Proma 是一个本地优先的 Agent 工作台。')
    expect(html).not.toContain('data-agent-final-answer="true"')
    expect(html).not.toContain('正在整理项目架构。')
  })

  test('Given Runtime 终态 result 已到但全局 streaming 标记尚未清理 When 渲染过渡帧 Then 思考记录保留为已思考入口', () => {
    const thinkingMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'thinking-before-terminal-result',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'thinking',
          thinking: '终态前的思考内容。',
        }],
      },
    }
    const resultMsg = {
      type: 'result' as const,
      subtype: 'success',
      result: '',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [thinkingMsg],
      turnMessages: [thinkingMsg, resultMsg],
      model: 'grok-4.5',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[thinkingMsg, resultMsg]}
          sessionId="terminal-transition-session"
          turnId="terminal-transition-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('已思考')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('agent-status-shimmer')
    expect(html).not.toContain('终态前的思考内容。')
    expect(html).toContain('已处理')
    expect(html).not.toContain('正在思考')
  })

  test('Given 后续轮次先收到空 assistant 再收到 Pi 正文分段 When 本轮仍在流式 Then thinking 与正文都留在时间线', () => {
    const emptyAssistant: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'second-turn-empty-assistant',
      parent_tool_use_id: null,
      message: {
        content: [],
      },
    }
    const finalSegment: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'second-turn-pi-final-segment',
      parent_tool_use_id: null,
      _partial: true,
      message: {
        id: 'pi-second-turn-final-segment',
        content: [
          {
            type: 'thinking',
            thinking: '确认身份约束后直接回答。',
          },
          {
            type: 'text',
            text: '我是 Proma。',
          },
        ],
      },
    } as SDKAssistantMessage
    const assistantMessages = [emptyAssistant, finalSegment]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages: assistantMessages,
      model: 'grok-4.5',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={assistantMessages}
          sessionId="second-turn-session"
          turnId="second-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('已思考')
    expect(html).toContain('data-agent-activity="process-text"')
    expect(html).toContain('我是 Proma。')
    expect(html).not.toContain('data-agent-final-answer="true"')
    expect(html).not.toContain('确认身份约束后直接回答。')
    expect(html).not.toContain('正在思考')
  })

  test('Given 本轮已经正常结束且包含多个工具 When 最终正文显示 Then 工具组标题原位可见且详情默认收起', () => {
    const firstTool: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'persistent-tool-1',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'persistent-read',
          name: 'Read',
          input: { file_path: '/tmp/first.ts' },
        }],
      },
    }
    const secondTool: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'persistent-tool-2',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'persistent-bash',
          name: 'Bash',
          input: { command: 'bun test' },
        }],
      },
    }
    const firstResult = {
      type: 'user' as const,
      uuid: 'persistent-result-1',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'persistent-read',
          content: 'file content',
        }],
      },
    }
    const secondResult = {
      type: 'user' as const,
      uuid: 'persistent-result-2',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'persistent-bash',
          content: '2 pass',
        }],
      },
    }
    const answer: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'persistent-answer',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '工具检查已经完成。' }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '工具检查已经完成。',
      _durationMs: 4_000,
    }
    const assistantMessages = [firstTool, secondTool, answer]
    const turnMessages = [
      firstTool,
      firstResult,
      secondTool,
      secondResult,
      answer,
      result,
    ]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'grok-4.5',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="persistent-tools-session"
          turnId="persistent-tools-turn"
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="tools"')
    expect(html).toContain('已调用 2 个工具')
    expect(html).toContain('已处理 4 秒')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-agent-final-answer="true"')
    expect(html).toContain('工具检查已经完成。')
    expect(html).not.toContain('data-agent-activity="tool"')
    expect(html).not.toContain('first.ts')
    expect(html).not.toContain('bun test')
    expect(html.indexOf('已处理 4 秒')).toBeGreaterThan(
      html.indexOf('工具检查已经完成。'),
    )
  })

  test('Given 正常完成的整轮已被用户手动展开 When 渲染 Then 时间线历史与最终正文同时保留', () => {
    const thinking: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'expanded-thinking',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'thinking', thinking: '手动展开后可继续查看的思考。' }],
      },
    }
    const process: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'expanded-process',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: '先读取配置，再核对调用点。' }],
      },
    }
    const tools: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'expanded-tools',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'expanded-read', name: 'Read', input: { file_path: '/tmp/config.ts' } },
          { type: 'tool_use', id: 'expanded-grep', name: 'Grep', input: { pattern: 'createConfig' } },
        ],
      },
    }
    const answer: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'expanded-answer',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '配置调用链已经确认。' }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '配置调用链已经确认。',
      _durationMs: 8_000,
    }
    const turnMessages = [thinking, process, tools, answer, result]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [thinking, process, tools, answer],
      turnMessages,
      model: 'gpt-5.6-sol',
    }
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([
      ['expanded-completed-session/expanded-completed-turn/turn', true],
      ['expanded-completed-session/expanded-completed-turn/thinking:0', true],
      ['expanded-completed-session/expanded-completed-turn/tool:expanded-read', true],
    ]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="expanded-completed-session"
          turnId="expanded-completed-turn"
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('已处理 8 秒')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-agent-timeline-entry="tools"')
    expect(html).toContain('已调用 2 个工具')
    expect(html).toContain('先读取配置，再核对调用点。')
    expect(html).toContain('data-agent-final-answer="true"')
    expect(html).toContain('配置调用链已经确认。')
    expect(html).toContain('手动展开后可继续查看的思考。')
    expect(html).toContain('config.ts')
    expect(html).toContain('createConfig')
    const thinkingIndex = html.indexOf('data-agent-timeline-entry="thinking"')
    const processIndex = html.indexOf('先读取配置，再核对调用点。')
    const toolsIndex = html.indexOf('data-agent-timeline-entry="tools"')
    const finalIndex = html.indexOf('data-agent-final-answer="true"')
    expect(processIndex).toBeGreaterThan(thinkingIndex)
    expect(toolsIndex).toBeGreaterThan(processIndex)
    expect(finalIndex).toBeGreaterThan(toolsIndex)
  })

  test('Given 正常完成的 Turn 以 fullTranscript 渲染 When 展示 Then thinking 与工具明细全部展开', () => {
    const thinking: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'transcript-thinking',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'thinking', thinking: '完整转录中的思考正文。' }],
      },
    }
    const process: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'transcript-process',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: '完整转录中的过程正文。' }],
      },
    }
    const tool: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'transcript-tool',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'transcript-read',
          name: 'Read',
          input: { file_path: '/tmp/full-transcript.ts' },
        }],
      },
    }
    const toolResult = {
      type: 'user' as const,
      uuid: 'transcript-tool-result',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'transcript-read',
          content: '读取完成',
        }],
      },
    }
    const answer: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'transcript-answer',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '完整转录最终回答。' }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '完整转录最终回答。',
    }
    const assistantMessages = [thinking, process, tool, answer]
    const turnMessages = [thinking, process, tool, toolResult, answer, result]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'grok-4.5',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="full-transcript-session"
          turnId="full-transcript-turn"
          fullTranscript
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-agent-thinking-content="true"')
    expect(html).toContain('完整转录中的思考正文。')
    expect(html).toContain('data-state="open" data-agent-timeline-entry="tools"')
    expect(html).toContain('full-transcript.ts')
    expect(html).toContain('完整转录中的过程正文。')
    expect(html).toContain('data-agent-final-answer="true"')
    expect(html).toContain('完整转录最终回答。')
  })

  test('Given 正常完成且末尾包含子智能体消息 When 渲染操作栏 Then 最终正文仍提供复制与主线分叉入口', () => {
    const agentToolMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'actions-agent-tool-message',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'actions-agent-tool',
          name: 'Agent',
          input: { name: 'Explore', prompt: '检查操作栏' },
        }],
      },
    }
    const mainlineAnswer: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'actions-mainline-answer',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '主线最终回答可复制和分叉。' }],
      },
    }
    const trailingSidechain: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'actions-sidechain-answer',
      parent_tool_use_id: 'actions-agent-tool',
      message: {
        content: [{ type: 'text', text: '子智能体内部正文不应成为主线最终回答。' }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'success',
      result: '主线最终回答可复制和分叉。',
    }
    const assistantMessages = [
      agentToolMessage,
      mainlineAnswer,
      trailingSidechain,
    ]
    const turnMessages = [...assistantMessages, result]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'gpt-5.6-sol',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="actions-session"
          turnId="actions-turn"
          onFork={() => {}}
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('data-agent-final-answer="true"')
    expect(html).toContain('主线最终回答可复制和分叉。')
    expect(html).not.toContain('子智能体内部正文不应成为主线最终回答。')
    expect(html).toContain('>复制<')
    expect(html).toContain('按当前模型从此处分叉')
  })

  test('Given Turn 在产生正文和工具记录后失败 When 渲染 Then 错误记录保留且工具默认展开', () => {
    const assistantMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'failed-with-history',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '失败前正在核对构建日志。' },
          { type: 'tool_use', id: 'failed-read', name: 'Read', input: { file_path: '/tmp/build.log' } },
          { type: 'text', text: '已经定位到构建阶段。' },
        ],
      },
      error: {
        message: '构建日志读取后执行失败。',
      },
    }
    const toolResult = {
      type: 'user' as const,
      uuid: 'failed-tool-result',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'failed-read',
          content: '错误日志',
          is_error: true,
        }],
      },
    }
    const turnMessages = [assistantMessage, toolResult]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMessage],
      turnMessages,
      model: 'deepseek-v4-flash',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="failed-history-session"
          turnId="failed-history-turn"
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="failed"')
    expect(html).toContain('执行失败')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-state="open" data-agent-timeline-entry="tools"')
    expect(html).toContain('已查看 1 个文件 · 1 项失败')
    expect(html).toContain('build.log')
    expect(html).toContain('data-agent-activity="process-text"')
    expect(html).not.toContain('data-agent-final-answer="true"')
    expect(html).toContain('已经定位到构建阶段。')
    expect(html).toContain('构建日志读取后执行失败。')
    expect(html).not.toContain('失败前正在核对构建日志。')
  })

  test('Given 工具前后都有流式正文 When 本轮尚未结束 Then 工具后的正文仍在同条时间线且历史不提前折叠', () => {
    const processSegment: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'process-segment-before-tool',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: '先检查项目结构。' }],
      },
    }
    const toolMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'tool-between-segments',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool-between-segments-id',
          name: 'Read',
          input: { file_path: '/tmp/project.ts' },
        }],
      },
    }
    const toolResult = {
      type: 'user' as const,
      uuid: 'tool-between-segments-result',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'tool-between-segments-id',
          content: 'project content',
        }],
      },
    }
    const finalSegment: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'final-segment-after-tool',
      parent_tool_use_id: null,
      _partial: true,
      message: {
        content: [
          { type: 'thinking', thinking: '整理最终结论。' },
          { type: 'text', text: '这是工具执行后的最终正文。' },
        ],
      },
    } as SDKAssistantMessage
    const assistantMessages = [processSegment, toolMessage, finalSegment]
    const turnMessages = [
      processSegment,
      toolMessage,
      toolResult,
      finalSegment,
    ]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'grok-4.5',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="segmented-pi-session"
          turnId="segmented-pi-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="tools"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('先检查项目结构。')
    expect(html).toContain('这是工具执行后的最终正文。')
    expect(html.match(/data-agent-activity="process-text"/g)).toHaveLength(2)
    expect(html).not.toContain('data-agent-final-answer="true"')
    expect(html).not.toContain('整理最终结论。')
    expect(html).not.toContain('project.ts')
    const processIndex = html.indexOf('先检查项目结构。')
    const toolsIndex = html.indexOf('data-agent-timeline-entry="tools"')
    const thinkingIndex = html.indexOf('data-agent-timeline-entry="thinking"')
    const trailingProcessIndex = html.indexOf('这是工具执行后的最终正文。')
    expect(toolsIndex).toBeGreaterThan(processIndex)
    expect(thinkingIndex).toBeGreaterThan(toolsIndex)
    expect(trailingProcessIndex).toBeGreaterThan(thinkingIndex)
    expect(html).not.toContain('正在思考')
  })

  test('Given Pi 工具后正文先于 tool_result 投影到达 When 流式渲染 Then 正文首增量仍追加到原时间线', () => {
    const firstUsage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pi-renderer-usage-before-tool',
      parent_tool_use_id: null,
      message: {
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
        },
      },
    }
    const thinkingBeforeTool: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pi-renderer-thinking-before-tool',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'thinking',
          thinking: '先读取目标文件。',
        }],
      },
    }
    const toolMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pi-renderer-tool-message',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'pi-renderer-read-tool',
          name: 'Read',
          input: { file_path: '/tmp/project.ts' },
        }],
      },
    }
    const secondUsage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pi-renderer-usage-after-tool',
      parent_tool_use_id: null,
      message: {
        content: [],
        usage: {
          input_tokens: 200,
          output_tokens: 20,
        },
      },
    }
    const finalPartial: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pi-renderer-final-segment',
      parent_tool_use_id: null,
      _partial: true,
      message: {
        content: [
          {
            type: 'thinking',
            thinking: '整理最终结论。',
          },
          {
            type: 'text',
            text: '最终正文首个增量。',
          },
        ],
      },
    } as SDKAssistantMessage
    const assistantMessages = [
      firstUsage,
      thinkingBeforeTool,
      toolMessage,
      secondUsage,
      finalPartial,
    ]
    // Pi 的 tool.completed 与后续 message.delta 分别进入 Renderer；
    // 这里故意不放 tool_result，固定真实运行中的竞态帧。
    const turnMessages = [...assistantMessages]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'gpt-5.6-sol',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="pi-tool-result-race-session"
          turnId="pi-tool-result-race-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-agent-timeline-entry="tools"')
    expect(html).toContain('正在查看 /tmp/project.ts')
    expect(html).toContain('data-agent-activity="process-text"')
    expect(html).toContain('最终正文首个增量。')
    expect(html).not.toContain('data-agent-final-answer="true"')
    expect(html).not.toContain('先读取目标文件。')
    expect(html.match(/\/tmp\/project\.ts/g)).toHaveLength(1)
    const thinkingIndex = html.indexOf('data-agent-timeline-entry="thinking"')
    const toolsIndex = html.indexOf('data-agent-timeline-entry="tools"')
    const processIndex = html.indexOf('最终正文首个增量。')
    expect(toolsIndex).toBeGreaterThan(thinkingIndex)
    expect(processIndex).toBeGreaterThan(toolsIndex)
  })

  test('Given 本轮运行中两条命令之间夹着已结束 thinking When 最新命令到达 Then 合为一个工具组且计数不包含思考', () => {
    const firstTool: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'live-tool-1',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'live-bash-first',
          name: 'Bash',
          input: { command: 'echo first-command' },
        }],
      },
    }
    const middleThinking: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'live-tool-middle-thinking',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'thinking',
          thinking: '简短检查第一条命令的结果。',
        }],
      },
    }
    const secondTool: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'live-tool-2',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'live-bash-second',
          name: 'Bash',
          input: { command: 'echo second-command' },
        }],
      },
    }
    const assistantMessages = [firstTool, middleThinking, secondTool]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages: assistantMessages,
      model: 'grok-4.5',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={assistantMessages}
          sessionId="live-tools-session"
          turnId="live-tools-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html.match(/data-agent-timeline-entry="tools"/g)).toHaveLength(1)
    expect(html).not.toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('正在运行 2 条命令')
    expect(html).not.toContain('正在运行 3 条命令')
    expect(html).toContain('data-state="closed" data-agent-timeline-entry="tools"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('first-command')
    expect(html).not.toContain('简短检查第一条命令的结果。')
    expect(html).not.toContain('second-command')
    expect(html).not.toContain('data-agent-activity="tool"')

    const expandedStore = createStore()
    expandedStore.set(agentTimelineExpandedAtom, new Map([
      ['live-tools-session/live-tools-turn/tool:live-bash-first', true],
      ['live-tools-session/live-tools-turn/thinking:1', true],
    ]))
    const expandedHtml = renderToStaticMarkup(
      <Provider store={expandedStore}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={assistantMessages}
          sessionId="live-tools-session"
          turnId="live-tools-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(expandedHtml).toContain('data-state="open" data-agent-timeline-entry="tools"')
    expect(expandedHtml.match(/data-agent-activity="tool"/g)).toHaveLength(2)
    expect(expandedHtml.match(/data-agent-timeline-entry="thinking"/g)).toHaveLength(1)
    expect(expandedHtml).toContain('>已思考<')
    expect(expandedHtml).toContain('简短检查第一条命令的结果。')
    const firstCommandIndex = expandedHtml.indexOf('first-command')
    const middleThinkingIndex = expandedHtml.indexOf('简短检查第一条命令的结果。')
    const secondCommandIndex = expandedHtml.indexOf('second-command')
    expect(middleThinkingIndex).toBeGreaterThan(firstCommandIndex)
    expect(secondCommandIndex).toBeGreaterThan(middleThinkingIndex)
  })

  test('Given thinking 后工具已经完成 When 仍等待下一段输出 Then 旧思考结束且底部只有一个中性等待反馈', () => {
    const thinkingMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'thinking-before-completed-tool',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'thinking', thinking: '先读取目标文件。' }],
      },
    }
    const toolMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'completed-tool-before-placeholder',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'completed-tool-before-placeholder-id',
          name: 'Read',
          input: { file_path: '/tmp/completed-before-placeholder.ts' },
        }],
      },
    }
    const toolResult = {
      type: 'user' as const,
      uuid: 'completed-tool-before-placeholder-result',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'completed-tool-before-placeholder-id',
          content: '读取完成',
        }],
      },
    }
    const assistantMessages = [thinkingMessage, toolMessage]
    const turnMessages = [...assistantMessages, toolResult]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'grok-4.5',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="completed-tool-placeholder-session"
          turnId="completed-tool-placeholder-turn"
          isStreaming
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('>已思考<')
    expect(html).toContain('data-agent-timeline-entry="tools"')
    expect(html).toContain('已查看 1 个文件')
    expect(html).not.toContain('正在查看 1 个文件')
    expect(html.match(/>正在准备下一步</g)).toHaveLength(1)
    expect(html).not.toContain('>正在思考<')
    expect(html.match(/agent-status-shimmer/g)).toHaveLength(1)
    expect(html).not.toContain('先读取目标文件。')
  })

  test('Given 工具前后存在多段 thinking、工具已完成且最新 thinking 已展开 When 流式渲染 Then 仅最新 thinking 保持运行态', () => {
    const firstThinking: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'stream-thinking-1',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'thinking', thinking: '第一段思考内容。' }],
      },
    }
    const toolMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'stream-tool-1',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'stream-tool-call-1',
          name: 'Read',
          input: { file_path: '/tmp/demo.ts' },
        }],
      },
    }
    const secondThinking: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'stream-thinking-2',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'thinking', thinking: '第二段思考内容。' }],
      },
    }
    const assistantMessages = [firstThinking, toolMessage, secondThinking]
    const toolResult = {
      type: 'user' as const,
      uuid: 'stream-tool-result-1',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: 'stream-tool-call-1',
          content: '读取完成',
        }],
      },
    }
    const turnMessages = [firstThinking, toolMessage, toolResult, secondThinking]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages,
      model: 'grok-4.5',
    }

    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([
      ['thinking-stream-session/thinking-stream-turn/thinking:2', true],
    ]))
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={turnMessages}
          sessionId="thinking-stream-session"
          turnId="thinking-stream-turn"
          isStreaming
          isLatestAssistantTurn
          runningStartedAt={Date.now() - 6_000}
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html.match(/data-agent-timeline-entry="thinking"/g)).toHaveLength(2)
    expect(html.match(/data-agent-timeline-entry="tools"/g)).toHaveLength(1)
    expect(html.match(/>已思考</g)).toHaveLength(1)
    expect(html.match(/>正在思考</g)).toHaveLength(1)
    expect(html).toContain('已查看 1 个文件')
    expect(html).not.toContain('正在查看 1 个文件')
    expect(html).not.toContain('第一段思考内容。')
    expect(html).toContain('第二段思考内容。')
    expect(html).toContain('data-agent-thinking-content="true"')
    const firstThinkingIndex = indexOfOccurrence(html, 'data-agent-timeline-entry="thinking"', 1)
    const toolsIndex = html.indexOf('data-agent-timeline-entry="tools"')
    const secondThinkingIndex = indexOfOccurrence(html, 'data-agent-timeline-entry="thinking"', 2)
    const activeThinkingHtml = html.slice(secondThinkingIndex)
    expect(toolsIndex).toBeGreaterThan(firstThinkingIndex)
    expect(secondThinkingIndex).toBeGreaterThan(toolsIndex)
    expect(activeThinkingHtml).toContain('role="status"')
    expect(activeThinkingHtml).toContain('第二段思考内容。')
    expect(activeThinkingHtml).toContain('aria-expanded="true"')
  })

  test('Given collaboration 委派工具已返回但子会话仍运行 When 父流结束 Then 委派活动继续作为当前最新活动显示', () => {
    const delegationTool: SDKToolUseBlock = {
      type: 'tool_use',
      id: 'delegation-tool-1',
      name: 'mcp__collaboration__delegate_agents',
      input: {
        items: [{
          title: '检查登录流程',
          prompt: '检查登录流程',
        }],
      },
    }
    const assistantMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-collaboration',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'thinking',
            thinking: '先分析再委派。',
          },
          delegationTool,
        ],
      },
    }
    const toolResultMessage = {
      type: 'user' as const,
      uuid: 'delegation-result',
      message: {
        content: [{
          type: 'tool_result' as const,
          tool_use_id: delegationTool.id,
          content: JSON.stringify({
            delegations: [{
              delegationId: 'delegation-1',
              childSessionId: 'child-session-1',
            }],
          }),
        }],
      },
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMessage],
      turnMessages: [assistantMessage, toolResultMessage],
      model: 'gpt-5.6-sol',
    }
    const store = createStore()
    store.set(agentRuntimeExecutionGraphsAtom, new Map())
    store.set(agentSessionsAtom, [{
      id: 'child-session-1',
      title: '检查登录流程',
      parentSessionId: 'parent-session',
      sourceDelegationId: 'delegation-1',
      delegationStatus: 'running',
      runtimeWorkerState: 'busy',
      createdAt: Date.now() - 4_200,
      updatedAt: Date.now(),
    }])

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[assistantMessage, toolResultMessage]}
          sessionId="parent-session"
          turnId="turn-collaboration"
          isLatestAssistantTurn
          backgroundWaiting
          runningStartedAt={Date.now() - 4_200}
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).not.toContain('正在处理')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-state="open" data-agent-timeline-entry="tools"')
    expect(html).toContain('检查登录流程')
    expect(html).toContain('正在运行')
    expect(html).toMatch(/正在(调用子智能体|COLLABORATION \/ delegate_agents)/)
  })


  test('Given 停止且无 assistant 内容 When 渲染 Then 只显示停止文案不显示正在思考', () => {
    const interrupted = {
      type: 'result' as const,
      subtype: 'interrupted' as const,
      usage: { input_tokens: 0, output_tokens: 0 },
      _stoppedByUser: true,
      _durationMs: 3475,
      _createdAt: Date.now(),
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [],
      turnMessages: [interrupted],
      model: 'deepseek-v4-flash',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[interrupted]}
          sessionId="stop-empty-session"
          turnId="stop-empty-turn"
          stoppedByUser
          isLatestAssistantTurn
          fallbackDurationMs={3475}
        />
      </Provider>,
    )

    expect(html).toContain('后停止了')
    expect(html).toContain('data-agent-turn-timeline="stopped"')
    expect(html).not.toContain('正在思考')
    expect(html).not.toContain('data-agent-activity="thinking"')
    expect(html).not.toContain('data-agent-timeline="true"')
    expect(html).not.toContain('data-agent-timeline-entry')
  })

  test('Given 多条过程正文后用户暂停 When 渲染 Then 旧过程正文仍在且按序显示', () => {
    const firstProcess: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pause-process-1',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: '第一段固定穿插说明。' }],
      },
    }
    const secondProcess: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pause-process-2',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: '第二段固定穿插说明。' }],
      },
    }
    const thinkingMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'pause-thinking',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'thinking', thinking: '暂停前还在思考。' }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'interrupted',
      _durationMs: 15_000,
      _stoppedByUser: true,
    }
    const assistantMessages = [firstProcess, secondProcess, thinkingMsg]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages: [...assistantMessages, result],
      model: 'claude-sonnet-4',
    }

    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([
      ['pause-process-session/pause-process-turn/thinking:2', true],
    ]))
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[...assistantMessages, result]}
          sessionId="pause-process-session"
          turnId="pause-process-turn"
          stoppedByUser
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('你在')
    expect(html).toContain('后停止了')
    expect(html).toContain('data-agent-turn-timeline="stopped"')
    expect(html).toContain('data-agent-timeline="true"')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('已思考')
    // 暂停后两段过程正文都还在，不能被藏掉。
    expect(html).toContain('第一段固定穿插说明')
    expect(html).toContain('第二段固定穿插说明')
    const firstIdx = html.indexOf('第一段固定穿插说明')
    const secondIdx = html.indexOf('第二段固定穿插说明')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    expect(html).toContain('暂停前还在思考。')
    expect(html).toContain('data-agent-thinking-content="true"')
    expect(html.match(/data-agent-activity=/g)?.length).toBe(2)
  })

  test('Given 多个工具的停止轮已继续新一轮 When 渲染历史轮 Then 老工具全部显示且均非运行态', () => {
    const thinkingMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'stop-thinking',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'thinking',
          thinking: '先搜索再读取。',
        }],
      },
    }
    const toolMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'stop-tool',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'read-stop-1',
          name: 'Read',
          input: { file_path: '/tmp/paused-first.ts' },
        }, {
          type: 'tool_use',
          id: 'grep-stop-2',
          name: 'Grep',
          input: { pattern: 'paused-second-marker' },
        }],
      },
    }
    const processMsg: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'stop-process',
      parent_tool_use_id: null,
      message: {
        stop_reason: 'tool_use',
        content: [{
          type: 'text',
          text: '已创建探索子智能体，正在等待结果。',
        }],
      },
    }
    const result = {
      type: 'result' as const,
      subtype: 'interrupted',
      _durationMs: 27_000,
      _stoppedByUser: true,
    }
    const assistantMessages = [thinkingMsg, toolMsg, processMsg]
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages,
      turnMessages: [...assistantMessages, result],
      model: 'claude-sonnet-4',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[...assistantMessages, result]}
          sessionId="stop-session"
          turnId="stop-turn"
        />
      </Provider>,
    )

    expect(html).toContain('你在')
    expect(html).toContain('后停止了')
    expect(html).toContain('data-agent-turn-timeline="stopped"')
    // 新轮已经开始后，旧停止轮仍从 result 自身识别停止状态。
    expect(html).toContain('已创建探索子智能体')
    // 停止后思考正文默认折叠，但工具组默认展开并保留所有已发生工具。
    expect(html).not.toContain('先搜索再读取')
    expect(html).toContain('data-agent-timeline-entry="thinking"')
    expect(html).toContain('data-state="open" data-agent-timeline-entry="tools"')
    expect(html).toContain('paused-first.ts')
    expect(html).toContain('paused-second-marker')
    expect(html.match(/data-agent-activity="tool"/g)?.length).toBe(2)
    expect(html).not.toContain('agent-status-shimmer')
  })

  test('Given 停止轮旧 turn 状态为 false When 渲染 Then 不隐藏工具且工具组 key 仍可单独收起', () => {
    const assistantMessage: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'manual-collapse-stopped-tools',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'manual-collapse-read',
          name: 'Read',
          input: { file_path: '/tmp/manual-collapse.ts' },
        }],
      },
    }
    const interrupted = {
      type: 'result' as const,
      subtype: 'interrupted',
      _stoppedByUser: true,
      _durationMs: 5_000,
    }
    const turn: AssistantTurn = {
      type: 'assistant-turn',
      assistantMessages: [assistantMessage],
      turnMessages: [assistantMessage, interrupted],
      model: 'gpt-5.6-sol',
    }
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([
      ['manual-collapse-session/manual-collapse-turn/turn', false],
    ]))

    const defaultHtml = renderToStaticMarkup(
      <Provider store={store}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[assistantMessage, interrupted]}
          sessionId="manual-collapse-session"
          turnId="manual-collapse-turn"
        />
      </Provider>,
    )

    expect(defaultHtml).toContain('后停止了')
    expect(defaultHtml).toContain('data-agent-turn-timeline="stopped"')
    expect(defaultHtml).toContain('data-agent-timeline="true"')
    expect(defaultHtml).toContain('data-state="open" data-agent-timeline-entry="tools"')
    expect(defaultHtml).toContain('manual-collapse.ts')
    expect(defaultHtml).toContain('data-agent-activity="tool"')

    const collapsedStore = createStore()
    collapsedStore.set(agentTimelineExpandedAtom, new Map([
      ['manual-collapse-session/manual-collapse-turn/turn', false],
      ['manual-collapse-session/manual-collapse-turn/tool:manual-collapse-read', false],
    ]))
    const collapsedHtml = renderToStaticMarkup(
      <Provider store={collapsedStore}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[assistantMessage, interrupted]}
          sessionId="manual-collapse-session"
          turnId="manual-collapse-turn"
        />
      </Provider>,
    )

    expect(collapsedHtml).toContain('data-agent-turn-timeline="stopped"')
    expect(collapsedHtml).toContain('data-agent-timeline="true"')
    expect(collapsedHtml).toContain('data-state="closed" data-agent-timeline-entry="tools"')
    expect(collapsedHtml).toContain('aria-expanded="false"')
    expect(collapsedHtml).not.toContain('manual-collapse.ts')
    expect(collapsedHtml).not.toContain('data-agent-activity="tool"')
  })
})
