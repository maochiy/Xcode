import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  SDKThinkingBlock,
  SDKMessage,
  SDKToolUseBlock,
} from '@proma/shared'
import { agentRuntimeExecutionGraphsAtom } from '@/atoms/agent-atoms'
import { ContentBlock } from './ContentBlock'

describe('ContentBlock Collaboration 结果摘要', () => {
  test('Given 已完成 thinking 活动 When 渲染 Then 思考面板自动隐藏', () => {
    const block: SDKThinkingBlock = {
      type: 'thinking',
      thinking: '正在核对登录流程。',
    }
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ContentBlock block={block} allMessages={[]} />
      </Provider>,
    )

    expect(html).not.toContain('data-agent-activity="thinking"')
    expect(html).not.toContain('正在核对登录流程')
    expect(html).not.toContain('data-thinking-icon="true"')
    expect(html).not.toContain('data-collapse-chevron="right"')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('Thinking')
    expect(html).not.toContain('stroke-dasharray')
  })

  test('Given 运行中 thinking 已有内容 When 渲染 Then 固定高度常显且带阴影滚动区', () => {
    const block: SDKThinkingBlock = {
      type: 'thinking',
      thinking: '正在核对登录流程。',
    }
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ContentBlock
          block={block}
          allMessages={[]}
          activityRunning
          activityItem
        />
      </Provider>,
    )

    expect(html).toContain('正在思考')
    expect(html).toContain('正在核对登录流程')
    expect(html).not.toContain('data-thinking-icon="true"')
    expect(html).not.toContain('data-collapse-chevron="right"')
    expect(html).toContain('data-thinking-scroll-viewport="true"')
    expect(html).toContain('agent-thinking-stream-surface')
    expect(html).toContain('h-36')
    expect(html).not.toContain('max-h-0')
    expect(html).toContain('agent-activity-fade-in')
  })

  test('Given 普通工具阶段行 When 渲染 Then 使用纯淡入入场动画', () => {
    const block: SDKToolUseBlock = {
      type: 'tool_use',
      id: 'tool-read-1',
      name: 'Read',
      input: { file_path: '/tmp/demo.ts' },
    }
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ContentBlock
          block={block}
          allMessages={[]}
          activityRunning
          activityItem
          isStreaming
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-activity="tool"')
    expect(html).toContain('agent-activity-fade-in')
    expect(html).toContain('agent-status-shimmer')
    expect(html).not.toContain('agent-activity-enter')
  })

  test('Given 工具调用已经返回结果 When 渲染最新工具 Then 不再显示运行中的白色波纹', () => {
    const block: SDKToolUseBlock = {
      type: 'tool_use',
      id: 'tool-read-completed',
      name: 'Read',
      input: { file_path: '/tmp/completed.ts' },
    }
    const messages: SDKMessage[] = [{
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: block.id,
          content: '读取完成',
        }],
      },
    }]
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ContentBlock
          block={block}
          allMessages={messages}
          activityRunning={false}
          activityItem
          isStreaming
        />
      </Provider>,
    )

    expect(html).toContain('data-agent-activity="tool"')
    expect(html).not.toContain('agent-status-shimmer')
  })

  test('Given list_delegations 返回完整委派数据 When 渲染正文 Then 只显示一句状态摘要', () => {
    const block: SDKToolUseBlock = {
      type: 'tool_use',
      id: 'list-delegations',
      name: 'mcp__collaboration__list_delegations',
      input: {},
    }
    const messages: SDKMessage[] = [{
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            maxRunningDelegations: 50,
            runningCount: 1,
            delegations: [
              {
                title: '节点一',
                status: 'completed',
                goal: '不应显示的完整任务说明',
                resultSummary: '不应显示的完整执行结果',
              },
              {
                title: '节点二',
                status: 'running',
              },
            ],
          }),
        }],
      },
    }]

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ContentBlock
          block={block}
          allMessages={messages}
          sessionId="parent-session"
        />
      </Provider>,
    )

    expect(html).toContain('共 2 个委派：1 个已完成，1 个执行中')
    expect(html).not.toContain('不应显示的完整任务说明')
    expect(html).not.toContain('不应显示的完整执行结果')
  })

  test('Given 并行批次中的兄弟工具先失败 When 当前工具收到级联取消 Then 显示已取消而非真实执行错误', () => {
    const block: SDKToolUseBlock = {
      type: 'tool_use',
      id: 'cancelled-bash',
      name: 'Bash',
      input: {
        command: 'adb shell run-as com.zmn.expert.android ...',
        description: '检查绑定账户状态',
      },
    }
    const messages: SDKMessage[] = [{
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: block.id,
          content: '<tool_use_error>Cancelled: parallel tool call Bash(adb devices -l …) errored</tool_use_error>',
          is_error: true,
        }],
      },
    }]

    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ContentBlock
          block={block}
          allMessages={messages}
        />
      </Provider>,
    )

    expect(html).toContain('已停止命令')
    expect(html).toContain('text-muted-foreground/45')
    expect(html).not.toContain('text-destructive/70')
  })

  test('Given Agent 工具已经创建运行节点 When 流式渲染 Then 先显示已创建再按顺序显示子智能体运行状态', () => {
    const block: SDKToolUseBlock = {
      type: 'tool_use',
      id: 'agent-tool-1',
      name: 'Agent',
      input: {
        name: 'Explore',
        prompt: '检查登录流程',
      },
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
          toolUseId: block.id,
          transcriptAvailable: true,
          model: 'test-model',
        }],
        todos: [],
        updatedAt: Date.now(),
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <ContentBlock
          block={block}
          allMessages={[]}
          sessionId="parent-session"
          isStreaming
          activityRunning
        />
      </Provider>,
    )

    const createdIndex = html.indexOf('已创建子智能体')
    const agentIndex = html.indexOf('Explore')
    const runningIndex = html.indexOf('正在运行')
    expect(createdIndex).toBeGreaterThanOrEqual(0)
    expect(agentIndex).toBeGreaterThan(createdIndex)
    expect(runningIndex).toBeGreaterThan(agentIndex)
    expect(html).not.toContain('正在调用子智能体')
  })
})
