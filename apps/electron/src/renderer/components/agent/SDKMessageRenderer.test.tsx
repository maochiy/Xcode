import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  SDKAssistantMessage,
  SDKContentBlock,
  SDKToolUseBlock,
} from '@proma/shared'
import type { AssistantTurn } from '@proma/session-core'
import {
  agentRuntimeExecutionGraphsAtom,
  agentSessionsAtom,
} from '@/atoms/agent-atoms'
import { AssistantTurnRenderer } from './SDKMessageRenderer'

describe('AssistantTurnRenderer 流式活动折叠', () => {
  test('Given 多条 stop_reason=tool_use 的思考和过程文本 When 最新正文仍在流式渲染 Then 思考面板持续显示在正文下方', () => {
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

    // 超过约 1 秒：「已处理」常驻；过程正文固定全部露出
    expect(html).toContain('已处理')
    expect(html).toContain('现在看 IPC 桥接、preload 和 App 路由。')
    expect(html).toContain('主源码目录确实有登录相关实现')
    // 本轮尚未结束：正文继续渲染时，已有思考内容仍固定显示在正文下方。
    expect(html).toContain('正在思考')
    expect(html).not.toContain('已完成思考')
    expect(html).toContain('先搜索登录入口。')
    expect(html).toContain('继续检查 IPC 和 preload。')
    expect(html.match(/data-thinking-scroll-viewport="true"/g)?.length).toBe(1)
    // 两段过程正文仍固定露出。
    const surfaceProcessCount = (html.match(/data-agent-activity="process-text"/g) ?? []).length
    expect(surfaceProcessCount).toBe(2)
    const firstProcess = html.indexOf('主源码目录确实有登录相关实现')
    const secondProcess = html.indexOf('现在看 IPC 桥接、preload 和 App 路由。')
    const thinkingPanelIdx = html.indexOf('data-thinking-stream="true"')
    expect(firstProcess).toBeGreaterThanOrEqual(0)
    expect(secondProcess).toBeGreaterThan(firstProcess)
    expect(thinkingPanelIdx).toBeGreaterThan(secondProcess)
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
          runningStartedAt={Date.now() - 3_200}
        />
      </Provider>,
    )

    // 最终正文未开始：整轮「已处理」常驻；过程正文固定 + 最新子智能体活动
    expect(html).toContain('Explore')
    expect(html).toContain('正在运行')
    expect(html).toContain('已处理')
    expect(html).not.toContain('已完成思考')
    // 过程正文固定显示，不因工具出现而消失
    expect(html).toContain('我先定位登录入口')
    expect(html).toContain('已创建子智能体')
  })


  test('Given 流式开局尚无任何 block When 渲染超过 1 秒 Then 顶栏已处理且下方仍有正在思考', () => {
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

    expect(html).toContain('已处理')
    expect(html).toContain('正在思考')
    expect(html).toContain('data-agent-activity="thinking"')
  })

  test('Given 正常结束且已有最终正文 When 渲染 Then 正文保留且思考面板自动隐藏', () => {
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

    expect(html).toContain('这是最终回答正文。')
    expect(html).not.toContain('已处理')
    expect(html).not.toContain('已经分析完成')
    expect(html).not.toContain('data-thinking-scroll-viewport="true"')
  })

  test('Given 第一行正文已经出现但本轮尚未结束 When 流式渲染 Then 思考内容仍显示在正文下方', () => {
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

    expect(html).toContain('这是正在流式生成的最终正文。')
    expect(html).toContain('data-thinking-stream="true"')
    expect(html).toContain('正在整理最终结论。')
    expect(html.indexOf('data-thinking-stream="true"')).toBeGreaterThan(
      html.indexOf('这是正在流式生成的最终正文。'),
    )
  })

  test('Given Runtime 终态 result 已到但全局 streaming 标记尚未清理 When 渲染过渡帧 Then 立即隐藏思考面板', () => {
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

    expect(html).not.toContain('data-thinking-stream="true"')
    expect(html).not.toContain('终态前的思考内容。')
  })

  test('Given 后续轮次先收到空 assistant 再收到 Pi 正文分段 When 尚无终态 result Then 思考面板继续显示', () => {
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

    expect(html).toContain('我是 Proma。')
    expect(html).toContain('data-thinking-stream="true"')
    expect(html).toContain('确认身份约束后直接回答。')
  })

  test('Given 本轮已经正常结束且包含多个工具 When 最终正文显示 Then 工具调用和思考内容一样自动隐藏', () => {
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

    expect(html).toContain('工具检查已经完成。')
    expect(html).not.toContain('data-agent-tool-shelf="true"')
    expect(html).not.toContain('data-agent-tool-latest="true"')
  })

  test('Given 工具前过程正文已固化且工具后 Pi 正文分段开始 When 仍在流式渲染 Then 工具和思考面板继续显示到终态', () => {
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

    expect(html).toContain('这是工具执行后的最终正文。')
    expect(html).toContain('data-agent-tool-shelf="true"')
    expect(html).toContain('data-thinking-stream="true"')
    expect(html).toContain('整理最终结论。')
  })

  test('Given 本轮运行中连续调用多个工具 When 最新工具到达 Then 只显示最新工具并由其折叠箭头承载历史', () => {
    const firstTool: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'live-tool-1',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'live-read',
          name: 'Read',
          input: { file_path: '/tmp/first-tool.ts' },
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
          id: 'live-grep',
          name: 'Grep',
          input: { pattern: 'latest-tool-marker' },
        }],
      },
    }
    const assistantMessages = [firstTool, secondTool]
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

    expect(html).toContain('data-agent-tool-shelf="true"')
    expect(html).toContain('data-agent-tool-latest="true"')
    expect(html).toContain('data-agent-tool-history-count="1"')
    expect(html).toContain('data-collapse-chevron="right"')
    expect(html).not.toContain('工具调用')
    expect(html.match(/data-agent-activity="tool"/g)?.length).toBe(1)
  })

  test('Given 工具前后存在多段 thinking When 流式渲染 Then 同一阴影面板按顺序显示全部内容', () => {
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
          sessionId="thinking-stream-session"
          turnId="thinking-stream-turn"
          isStreaming
          isLatestAssistantTurn
          runningStartedAt={Date.now() - 6_000}
        />
      </Provider>,
    )

    expect(html.match(/data-thinking-scroll-viewport="true"/g)?.length).toBe(1)
    expect(html).toContain('第一段思考内容。')
    expect(html).toContain('第二段思考内容。')
    expect(html.indexOf('第一段思考内容。')).toBeLessThan(
      html.indexOf('第二段思考内容。'),
    )
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
          runningStartedAt={Date.now() - 4_200}
        />
      </Provider>,
    )

    // 最终正文未开始时：整轮「已处理」常驻 + 当前委派活动
    expect(html).toContain('已处理')
    expect(html).not.toContain('已完成思考')
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
      turnMessages: [interrupted as any],
      model: 'deepseek-v4-flash',
    }

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AssistantTurnRenderer
          turn={turn}
          allMessages={[interrupted as any]}
          sessionId="stop-empty-session"
          turnId="stop-empty-turn"
          stoppedByUser
          isLatestAssistantTurn
          fallbackDurationMs={3475}
        />
      </Provider>,
    )

    expect(html).toContain('后停止了')
    expect(html).not.toContain('正在思考')
    expect(html).not.toContain('data-agent-activity="thinking"')
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

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
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
    // 暂停后两段过程正文都还在，不能被藏掉
    expect(html).toContain('第一段固定穿插说明')
    expect(html).toContain('第二段固定穿插说明')
    const firstIdx = html.indexOf('第一段固定穿插说明')
    const secondIdx = html.indexOf('第二段固定穿插说明')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    // 停止后思考面板自动隐藏，只保留两条过程正文。
    expect(html.match(/data-agent-activity=/g)?.length).toBe(2)
  })

  test('Given 用户停止且已有思考与工具 When 渲染 Then 显示停止文案且默认只露最新一行', () => {
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
          id: 'bash-stop-1',
          name: 'Bash',
          input: { command: 'ls' },
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
          stoppedByUser
          isLatestAssistantTurn
        />
      </Provider>,
    )

    expect(html).toContain('你在')
    expect(html).toContain('后停止了')
    // 收起态只露最新一行（过程叙述是最后一条活动）
    expect(html).toContain('已创建探索子智能体')
    // 停止后思考面板自动隐藏；旧工具仍不在收起表面堆叠。
    expect(html).not.toContain('先搜索再读取')
    expect(html).not.toContain('data-thinking-scroll-viewport="true"')
    expect(html).not.toContain('已完成思考')
  })
})
