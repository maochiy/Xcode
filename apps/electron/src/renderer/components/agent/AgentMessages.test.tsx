import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AskUserRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  SDKMessage,
  SDKUserMessage,
} from '@proma/shared'
import {
  agentImmediateUserMessagesAtom,
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  allPendingPermissionRequestsAtom,
} from '@/atoms/agent-atoms'
import { AgentMessages } from './AgentMessages'

const previous: SDKMessage[] = [
  {
    type: 'user', uuid: 'old-user', parent_tool_use_id: null, _createdAt: 100,
    _promaNativeMessage: true,
    message: { content: [{ type: 'text', text: '旧问题' }] },
  },
  {
    type: 'assistant', uuid: 'old-tool', parent_tool_use_id: null, _createdAt: 110,
    _promaNativeMessage: true, _promaPausedByUser: true,
    message: { id: 'old-tool', content: [
      { type: 'tool_use', id: 'read-old', name: 'Read', input: { file_path: '/tmp/old.ts' } },
    ] },
  },
  {
    type: 'result', uuid: 'old-result', subtype: 'interrupted',
    _stoppedByUser: true, _createdAt: 120,
  },
]
const newUser: SDKMessage = {
  type: 'user', uuid: 'new-user', parent_tool_use_id: null, _createdAt: 200,
  // 已停止的会话发送新 run，使用独立的回合时间戳。
  _promaQueuedDuringStreaming: true,
  message: { content: [{ type: 'text', text: '新的问题' }] },
}

function renderMessages(current: SDKMessage[] = []): string {
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <AgentMessages
        sessionId="immediate-next-run"
        messagesLoaded
        streaming
        persistedSDKMessages={[...previous, newUser]}
        liveMessages={[...previous, newUser, ...current]}
        streamState={{ running: true, startedAt: 200, turnStartedAt: 200, content: '', toolActivities: [] }}
      />
    </Provider>,
  )
}

describe('立即发送后的新回合执行过程', () => {
  test('Given 当前工具运行中 When 连续立即发送且 Pi 尚未消费 Then 新消息立刻显示，旧工具仍运行且没有额外思考占位', () => {
    const store = createStore()
    const pending = [newUser as SDKUserMessage, {
      ...newUser, uuid: 'third', _createdAt: 201,
      message: { content: [{ type: 'text' as const, text: '再次调整指令' }] },
    } as SDKUserMessage]
    store.set(agentImmediateUserMessagesAtom, new Map([['pending-session', pending]]))
    const runningMessages: SDKMessage[] = [previous[0]!, {
      ...previous[1]!, _promaPausedByUser: false,
    } as SDKMessage]
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentMessages sessionId="pending-session" streaming messagesLoaded
          persistedSDKMessages={runningMessages} liveMessages={runningMessages}
          streamState={{ running: true, startedAt: 100, turnStartedAt: 100, content: '', toolActivities: [] }}
        />
      </Provider>,
    )
    expect(html).toContain('正在查看 /tmp/old.ts')
    expect(html).toContain('data-agent-turn-timeline="running"')
    expect(html).toContain('新的问题')
    expect(html).toContain('再次调整指令')
    expect(html.match(/data-agent-user-pending="true"/g)).toHaveLength(2)
    expect(html.match(/opacity-70/g)).toHaveLength(2)
    expect(html).not.toContain('正在准备新一轮')
    expect(html).not.toContain('正在思考')
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('后停止了')
  })

  test('Given Pi 已消费 steering When 乐观清理尚未到达 Then 新消息只显示一次，新执行过程跟在其后', () => {
    const store = createStore()
    store.set(agentImmediateUserMessagesAtom, new Map([['steered', [newUser as SDKUserMessage]]]))
    const nativeUser = { ...newUser, _promaNativeMessage: true }
    const messages = [...previous.slice(0, 2).map((message) => ({ ...message, _promaPausedByUser: false })), nativeUser]
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentMessages sessionId="steered" streaming messagesLoaded
          persistedSDKMessages={messages} liveMessages={messages}
          streamState={{ running: true, startedAt: 100, turnStartedAt: 200, content: '', toolActivities: [] }}
        />
      </Provider>,
    )
    expect(html.match(/新的问题/g)).toHaveLength(1)
    expect(html).not.toContain('data-agent-user-pending="true"')
    expect(html).not.toContain('opacity-70')
    expect(html.slice(html.indexOf('新的问题'))).toContain('正在准备下一步')
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('后停止了')
  })
  test('Given 旧工具停止记录仍留在 live When 新 run 尚未输出首帧 Then 新 user 后立即出现运行占位', () => {
    const html = renderMessages()
    expect(html).toContain('old.ts')
    expect(html).toContain('后停止了')
    const newUserIndex = html.indexOf('新的问题')
    expect(newUserIndex).toBeGreaterThan(-1)
    expect(html.slice(newUserIndex)).toContain('正在准备下一步')
  })

  test('Given 新 run 输出 thinking 与工具 When 旧轮已停止 Then 新过程正常展示且不继承旧停止状态', () => {
    const html = renderMessages([{
      type: 'assistant', uuid: 'new-assistant', parent_tool_use_id: null, _createdAt: 210,
      _promaNativeMessage: true, _partial: true,
      message: { id: 'new-assistant', content: [
        { type: 'thinking', thinking: '正在分析新问题' },
        { type: 'tool_use', id: 'read-new', name: 'Read', input: { file_path: '/tmp/new.ts' } },
      ] },
    }])
    const newContent = html.slice(html.indexOf('新的问题'))
    expect(newContent).toContain('data-agent-turn-timeline="running"')
    expect(newContent).not.toContain('正在处理')
    expect(newContent).toContain('data-agent-timeline-entry="thinking"')
    expect(newContent).toContain('data-agent-timeline-entry="tools"')
    expect(newContent).toContain('已思考')
    expect(newContent).toContain('正在查看 /tmp/new.ts')
    expect(newContent.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(newContent).not.toContain('正在分析新问题')
    expect(newContent.match(/\/tmp\/new\.ts/g)).toHaveLength(1)
    expect(newContent).not.toContain('后停止了')
  })
})

describe('运行空档专用状态互斥', () => {
  const idleAssistant: SDKMessage = {
    type: 'assistant',
    uuid: 'idle-assistant',
    parent_tool_use_id: null,
    _promaNativeMessage: true,
    _promaActivityPhase: 'idle',
    message: {
      content: [{ type: 'text', text: '等待用户确认。' }],
    },
  }

  function renderWithInteraction(
    kind: 'permission' | 'ask-user' | 'exit-plan',
  ): string {
    const sessionId = `${kind}-waiting-session`
    const store = createStore()
    if (kind === 'permission') {
      const request: PermissionRequest = {
        requestId: 'permission-1',
        sessionId,
        toolName: 'Bash',
        toolInput: { command: 'bun test' },
        description: '运行测试',
        dangerLevel: 'normal',
      }
      store.set(allPendingPermissionRequestsAtom, new Map([[sessionId, [request]]]))
    } else if (kind === 'ask-user') {
      const request: AskUserRequest = {
        requestId: 'ask-user-1',
        sessionId,
        questions: [{
          question: '是否继续？',
          options: [{ label: '继续', description: '继续执行' }],
        }],
        toolInput: {},
      }
      store.set(allPendingAskUserRequestsAtom, new Map([[sessionId, [request]]]))
    } else {
      const request: ExitPlanModeRequest = {
        requestId: 'exit-plan-1',
        sessionId,
        toolInput: {},
        allowedPrompts: [],
      }
      store.set(allPendingExitPlanRequestsAtom, new Map([[sessionId, [request]]]))
    }

    return renderToStaticMarkup(
      <Provider store={store}>
        <AgentMessages
          sessionId={sessionId}
          messagesLoaded
          streaming
          persistedSDKMessages={[idleAssistant]}
          liveMessages={[idleAssistant]}
          streamState={{
            running: true,
            content: '',
            toolActivities: [],
          }}
        />
      </Provider>,
    )
  }

  test('Given 原生 idle 空档正在等待专用交互 When 渲染 Then 不叠加中性等待与 thinking 状态', () => {
    for (const kind of ['permission', 'ask-user', 'exit-plan'] as const) {
      const html = renderWithInteraction(kind)
      expect(html).toContain('等待用户确认。')
      expect(html).not.toContain('正在准备下一步')
      expect(html).not.toContain('正在思考')
      expect(html).not.toContain('正在处理')
    }
  })
})

describe('AgentMessages Cursor 上下文压缩展示', () => {
  test('Given 手动压缩已开始但尚无终态 When 渲染 Then 隐藏控制气泡且只有一行压缩状态而没有 thinking spinner', () => {
    const compactControl: SDKMessage = {
      type: 'user',
      uuid: 'compact-control',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '/compact' }] },
    }
    const compacting = {
      type: 'system',
      subtype: 'compacting',
      compactTrigger: 'manual',
    } as SDKMessage
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentMessages
          sessionId="compacting-session"
          messagesLoaded
          streaming
          persistedSDKMessages={[compactControl, compacting]}
          liveMessages={[compactControl, compacting]}
          streamState={{
            running: true,
            content: '',
            toolActivities: [],
            isCompacting: true,
            contextCompaction: { status: 'running', trigger: 'manual' },
          }}
        />
      </Provider>,
    )

    expect(html).not.toContain('/compact')
    expect(html.match(/正在压缩上下文/g)).toHaveLength(1)
    expect(html.match(/data-agent-compaction-bubble-id="summarization"/g)).toHaveLength(1)
    expect(html).not.toContain('正在思考')
    expect(html).not.toContain('正在准备下一步')
    expect(html).not.toContain('animate-spin')
  })

  test('Given 压缩完成边界位于两段消息之间 When 渲染 Then 完成行留在原生位置且列表末尾不重复', () => {
    const before: SDKMessage = {
      type: 'assistant',
      uuid: 'before-compaction',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '压缩前正文' }] },
    }
    const compacting = {
      type: 'system',
      subtype: 'compacting',
      compactTrigger: 'auto',
    } as SDKMessage
    const completed = {
      type: 'system',
      subtype: 'compact_boundary',
      compactTrigger: 'auto',
    } as SDKMessage
    const after: SDKMessage = {
      type: 'assistant',
      uuid: 'after-compaction',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '压缩后正文' }] },
    }
    const messages = [before, compacting, completed, after]
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentMessages
          sessionId="completed-compaction-session"
          messagesLoaded
          streaming={false}
          persistedSDKMessages={messages}
          liveMessages={messages}
          streamState={{
            running: false,
            content: '',
            toolActivities: [],
            contextCompaction: { status: 'success', trigger: 'auto' },
          }}
        />
      </Provider>,
    )

    expect(html.match(/上下文已压缩/g)).toHaveLength(1)
    const beforeIndex = html.indexOf('压缩前正文')
    const statusIndex = html.indexOf('上下文已压缩')
    const afterIndex = html.indexOf('压缩后正文')
    expect(statusIndex).toBeGreaterThan(beforeIndex)
    expect(afterIndex).toBeGreaterThan(statusIndex)
  })

  test('Given 用户停止且 Runtime 同时持久化 abort failed When 渲染 Then 只在原位显示 stopped', () => {
    const compacting = {
      type: 'system',
      subtype: 'compacting',
      compactTrigger: 'manual',
    } as SDKMessage
    const aborted = {
      type: 'system',
      subtype: 'status',
      compact_result: 'failed',
      compact_error: 'aborted',
    } as SDKMessage
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentMessages
          sessionId="stopped-compaction-session"
          messagesLoaded
          streaming={false}
          persistedSDKMessages={[compacting, aborted]}
          liveMessages={[compacting, aborted]}
          streamState={{
            running: false,
            content: '',
            toolActivities: [],
            contextCompaction: { status: 'stopped', trigger: 'manual' },
          }}
        />
      </Provider>,
    )

    expect(html.match(/上下文压缩已停止/g)).toHaveLength(1)
    expect(html).not.toContain('上下文压缩失败')
    expect(html.match(/data-agent-compaction-bubble-id="summarization"/g)).toHaveLength(1)
  })

  test('Given 用户已停止但原生终态尚未到达 When 历史末尾仍是 compacting Then 不回退为 running', () => {
    const compacting = {
      type: 'system',
      subtype: 'compacting',
      compactTrigger: 'manual',
    } as SDKMessage
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentMessages
          sessionId="stopped-before-native-terminal"
          messagesLoaded
          streaming={false}
          persistedSDKMessages={[compacting]}
          liveMessages={[compacting]}
          streamState={{
            running: false,
            content: '',
            toolActivities: [],
            contextCompaction: { status: 'stopped', trigger: 'manual' },
          }}
        />
      </Provider>,
    )

    expect(html.match(/上下文压缩已停止/g)).toHaveLength(1)
    expect(html).not.toContain('正在压缩上下文')
  })

  test('Given success 先于 compact boundary 到达 When 渲染 Then 仍有一条可见完成兜底', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentMessages
          sessionId="success-before-boundary"
          messagesLoaded
          streaming={false}
          streamState={{
            running: false,
            content: '',
            toolActivities: [],
            contextCompaction: { status: 'success', trigger: 'auto' },
          }}
        />
      </Provider>,
    )

    expect(html.match(/上下文已压缩/g)).toHaveLength(1)
    expect(html).toContain('data-agent-compaction-status="success"')
  })
})
