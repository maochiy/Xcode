import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentRuntimeExecutionGraph, AgentSessionMeta } from '@proma/shared'
import type { BrowserAgentTask } from '@proma/shared'
import {
  type AgentFloatingPanelExecutionNodeState,
  agentFloatingPanelExecutionNodeStatesAtom,
  agentFloatingPanelPlanStatesAtom,
  agentRuntimeExecutionGraphsAtom,
  agentSessionsAtom,
  agentStreamingStatesAtom,
} from '@/atoms/agent-atoms'
import { browserAgentTasksAtom } from '@/atoms/browser-atoms'
import { createFloatingPlanSignature } from '@/lib/session-floating-runtime-lifecycle'
import {
  allocateFloatingRuntimeListRows,
  SessionFloatingPanel,
} from './SessionFloatingPanel'
import { selectRuntimePlanVisibleItems } from './runtime-plan-visible-window'

const SESSION_ID = 'floating-panel-test'

const EXECUTION_GRAPH: AgentRuntimeExecutionGraph = {
  nodes: [
    {
      id: 'main-task',
      kind: 'shell',
      status: 'completed',
      description: '构建主任务',
      transcriptAvailable: false,
    },
    {
      id: 'subagent-1',
      kind: 'subagent',
      name: '布局分析',
      status: 'running',
      description: '分析会话区动态布局',
      transcriptAvailable: true,
    },
  ],
  todos: [
    {
      id: '1',
      content: '完成悬浮面板布局',
      status: 'completed',
    },
    {
      id: '2',
      content: '实现动态功能区',
      status: 'in_progress',
      activeForm: '重组右侧 Tabs',
    },
    {
      id: '3',
      content: '验证计划入口',
      status: 'pending',
    },
  ],
  updatedAt: 1,
}

function renderFloatingPanel(
  running: boolean,
  sessions: AgentSessionMeta[] = [],
  graph: AgentRuntimeExecutionGraph = EXECUTION_GRAPH,
  browserTasks: BrowserAgentTask[] = [],
): string {
  const store = createStore()
  store.set(agentRuntimeExecutionGraphsAtom, new Map([[SESSION_ID, graph]]))
  store.set(agentSessionsAtom, sessions)
  store.set(browserAgentTasksAtom, new Map(browserTasks.map((task) => [task.taskId, task])))
  const executionStates = new Map<string, AgentFloatingPanelExecutionNodeState>()
  for (const node of graph.nodes) {
    executionStates.set(node.id, {
      node: { ...node, source: 'runtime' },
      expiresAt: Date.now() + 10_000,
    })
  }
  for (const session of sessions) {
    if (session.parentSessionId !== SESSION_ID || !session.sourceDelegationId) continue
    executionStates.set(`delegation:${session.id}`, {
      node: {
        id: `delegation:${session.id}`,
        kind: 'subagent',
        name: session.title,
        description: session.delegationGoal ?? session.title,
        status: session.delegationStatus === 'completed'
          ? 'completed'
          : 'running',
        transcriptAvailable: true,
        source: 'delegation',
        transcriptSessionId: session.id,
      },
      expiresAt: Date.now() + 10_000,
    })
  }
  store.set(agentFloatingPanelExecutionNodeStatesAtom, new Map([[
    SESSION_ID,
    executionStates,
  ]]))
  store.set(agentStreamingStatesAtom, new Map([[
    SESSION_ID,
    {
      running,
      content: '',
      toolActivities: [],
    },
  ]]))

  return renderToStaticMarkup(
    <Provider store={store}>
      <SessionFloatingPanel sessionId={SESSION_ID} sessionPath={null} />
    </Provider>,
  )
}

describe('SessionFloatingPanel 会话悬浮面板', () => {
  test('Given 悬浮面板渲染 When 检查外层容器 Then 圆角与输入框保持一致', () => {
    const html = renderFloatingPanel(false)

    expect(html).toContain('!rounded-[24px]')
    expect(html).toContain('max-h-[calc(100%-72px)]')
    expect(html).not.toContain('max-h-[min(380px')
    expect(html).not.toContain('h-[380px]')
    expect(html).toContain('overflow-y-auto')
    expect(html).toContain('scrollbar-none')
  })

  test('Given 会话存在计划和节点 When 渲染 Then 悬浮面板移除重复计划并展示后台智能体', () => {
    const html = renderFloatingPanel(true)

    expect(html).toContain('环境信息')
    expect(html).toContain('分支')
    expect(html).not.toContain('data-session-plan-progress')
    expect(html).not.toContain('完成悬浮面板布局')
    expect(html).toContain('正在运行')
    expect(html).toContain('1 个后台智能体')
    expect(html).not.toContain('构建主任务')
    expect(html).toContain('布局分析')
    expect(html).not.toContain('分析会话区动态布局')
    expect(html).toContain('data-session-floating-runtime-region')
    expect(html).not.toContain('data-session-floating-scroll-region')
  })

  test('Given 父会话已经停止但 CCB 子智能体仍在实时图运行 When 渲染 Then 继续显示正在运行', () => {
    const html = renderFloatingPanel(false)

    expect(html).toContain('正在运行')
    expect(html).toContain('animate-spin')
  })

  test('Given Proma collaboration 创建了子会话 When 渲染 Then 与 CCB 原生节点合并展示', () => {
    const html = renderFloatingPanel(true, [{
      id: 'child-session-1',
      title: '分析右侧动态 Tabs',
      parentSessionId: SESSION_ID,
      sourceDelegationId: 'delegation-1',
      delegationRole: 'explore',
      delegationStatus: 'completed',
      delegationGoal: '检查动态 Tab 的打开与关闭逻辑',
      createdAt: 10,
      updatedAt: 20,
    }])

    expect(html).toContain('2 个后台智能体')
    expect(html).toContain('分析右侧动态 Tabs')
    expect(html).not.toContain('检查动态 Tab 的打开与关闭逻辑')
    expect(html).not.toContain('全部停止')
  })

  test('Given 活跃节点全部是可停止的 Collaboration 子会话 When 渲染 Then 显示全部停止', () => {
    const html = renderFloatingPanel(true, [{
      id: 'running-child',
      title: '运行中的协作节点',
      parentSessionId: SESSION_ID,
      sourceDelegationId: 'delegation-running',
      delegationStatus: 'running',
      createdAt: 10,
      updatedAt: 20,
    }], {
      nodes: [],
      todos: [],
      updatedAt: 100,
    })

    expect(html).toContain('1 个后台智能体')
    expect(html).toContain('运行中的协作节点')
    expect(html).toContain('全部停止')
  })

  test('Given 没有计划和执行节点 When 渲染 Then 不显示空区块标题和占位提示', () => {
    const html = renderFloatingPanel(false, [], {
      nodes: [],
      todos: [],
      updatedAt: 1,
    })

    expect(html).not.toContain('data-session-plan-progress')
    expect(html).not.toContain('0 个后台智能体')
    expect(html).not.toContain('当前没有执行节点')
  })

  test('Given 新一轮开始且上一轮计划已完成 When 旧图仍未刷新 Then 悬浮面板不显示旧计划', () => {
    const store = createStore()
    store.set(agentRuntimeExecutionGraphsAtom, new Map([[SESSION_ID, {
      nodes: [],
      todos: [{ id: '1', content: '上一轮计划', status: 'completed' }],
      updatedAt: 100,
    }]]))
    store.set(agentFloatingPanelPlanStatesAtom, new Map([[SESSION_ID, {
      observedTurnEpoch: 200,
      suppressedCompletedPlanSignature: createFloatingPlanSignature([
        { id: '1', content: '上一轮计划', status: 'completed' },
      ]),
    }]]))
    store.set(agentSessionsAtom, [])
    store.set(agentStreamingStatesAtom, new Map([[
      SESSION_ID,
      {
        running: true,
        content: '',
        toolActivities: [],
        startedAt: 200,
      },
    ]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SessionFloatingPanel sessionId={SESSION_ID} sessionPath={null} />
      </Provider>,
    )

    expect(html).not.toContain('上一轮计划')
    expect(html).not.toContain('data-session-plan-progress')
  })

  test('Given 执行节点终态保留时间已经到期 When 渲染悬浮面板 Then 不再显示该节点', () => {
    const store = createStore()
    store.set(agentRuntimeExecutionGraphsAtom, new Map([[SESSION_ID, {
      nodes: [{
        id: 'completed-node',
        kind: 'subagent',
        name: '已经完成的节点',
        description: '历史节点',
        status: 'completed',
        transcriptAvailable: true,
      }],
      todos: [],
      updatedAt: 100,
    }]]))
    store.set(agentFloatingPanelExecutionNodeStatesAtom, new Map([[
      SESSION_ID,
      new Map([[
        'completed-node',
        {
          node: {
            id: 'completed-node',
            kind: 'subagent',
            name: '已经完成的节点',
            description: '历史节点',
            status: 'completed',
            transcriptAvailable: true,
            source: 'runtime',
          },
          expiresAt: Date.now() - 1,
        },
      ]]),
    ]]))
    store.set(agentSessionsAtom, [])
    store.set(agentStreamingStatesAtom, new Map())

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SessionFloatingPanel sessionId={SESSION_ID} sessionPath={null} />
      </Provider>,
    )

    expect(html).not.toContain('已经完成的节点')
    expect(html).not.toContain('1 个后台智能体')
  })

  test('Given CCB 节点仍在排队且父会话已停止 When 渲染 Then 节点仍显示且不会被当作终态关闭', () => {
    const html = renderFloatingPanel(false, [], {
      nodes: [{
        id: 'queued-node',
        kind: 'subagent',
        name: '等待执行的 CCB 节点',
        description: '等待调度',
        status: 'queued',
        transcriptAvailable: true,
      }],
      todos: [],
      updatedAt: 100,
    })

    expect(html).toContain('1 个后台智能体')
    expect(html).toContain('等待执行的 CCB 节点')
  })

  test('Given 计划和子智能体都很多 When 渲染 Then 只截断子智能体且不重复展示计划', () => {
    const graph: AgentRuntimeExecutionGraph = {
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `node-${index + 1}`,
        kind: 'subagent',
        name: `子智能体 ${index + 1}`,
        description: `执行任务 ${index + 1}`,
        status: index === 0 ? 'running' : 'queued',
        transcriptAvailable: true,
      })),
      todos: Array.from({ length: 7 }, (_, index) => ({
        id: `${index + 1}`,
        content: `计划步骤 ${index + 1}`,
        status: index === 0 ? 'in_progress' : 'pending',
      })),
      updatedAt: 1,
    }

    const html = renderFloatingPanel(true, [], graph)

    expect(html).not.toContain('data-session-plan-view-all')
    expect(html).toContain('data-session-subagent-view-all')
    expect(html).toContain('6 个后台智能体')
    expect(html).toContain('overflow-y-auto')
    expect(
      allocateFloatingRuntimeListRows(graph.todos.length, graph.nodes.length),
    ).toEqual({
      visiblePlanItems: 5,
      visibleSubagentItems: 4,
    })
  })

  test('Given 计划超过可见数量 When 渲染悬浮面板 Then 不展示重复计划但纯函数仍不修改原计划', () => {
    const todos: AgentRuntimeExecutionGraph['todos'] = Array.from(
      { length: 8 },
      (_, index) => ({
        id: `${index + 1}`,
        content: `计划步骤 ${index + 1}`,
        status: index < 3
          ? 'completed'
          : index === 3
            ? 'in_progress'
            : 'pending',
      }),
    )
    const originalIds = todos.map((todo) => todo.id)
    const visible = selectRuntimePlanVisibleItems(todos, 5)

    expect(visible.map((todo) => todo.id)).toEqual(['4', '5', '6', '7', '8'])
    expect(todos.map((todo) => todo.id)).toEqual(originalIds)

    const html = renderFloatingPanel(true, [], {
      nodes: [],
      todos,
      updatedAt: 1,
    })
    expect(html).not.toContain('计划步骤 1')
    expect(html).not.toContain('计划步骤 4')
    expect(html).not.toContain('计划步骤 8')
    expect(html).not.toContain('data-session-plan-view-all')
  })

  test('Given 当前步骤接近计划末尾 When 计算可见窗口 Then 向前补齐但保持原计划顺序', () => {
    const todos: AgentRuntimeExecutionGraph['todos'] = Array.from(
      { length: 6 },
      (_, index) => ({
        id: `${index + 1}`,
        content: `计划步骤 ${index + 1}`,
        status: index < 3
          ? 'completed'
          : index === 3
            ? 'in_progress'
            : 'pending',
      }),
    )

    expect(
      selectRuntimePlanVisibleItems(todos, 5).map((todo) => todo.id),
    ).toEqual(['2', '3', '4', '5', '6'])
  })

  test('Given 全部计划已经完成 When 计算可见窗口 Then 保留完成数据且不触碰跨轮重置状态', () => {
    const todos: AgentRuntimeExecutionGraph['todos'] = Array.from(
      { length: 7 },
      (_, index) => ({
        id: `${index + 1}`,
        content: `已完成步骤 ${index + 1}`,
        status: 'completed',
      }),
    )

    expect(
      selectRuntimePlanVisibleItems(todos, 5).map((todo) => todo.id),
    ).toEqual(['3', '4', '5', '6', '7'])
    expect(todos.every((todo) => todo.status === 'completed')).toBe(true)
  })

  test('Given 前面的子智能体已经完成 When 数据超过可见数量 Then 后续节点依次向前补位', () => {
    const graph: AgentRuntimeExecutionGraph = {
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `node-${index + 1}`,
        kind: 'subagent',
        name: `子智能体 ${index + 1}`,
        description: `执行任务 ${index + 1}`,
        status: index === 0 ? 'completed' : index === 1 ? 'running' : 'queued',
        transcriptAvailable: true,
        startedAt: index + 1,
      })),
      todos: [],
      updatedAt: 1,
    }

    const html = renderFloatingPanel(true, [], graph)

    expect(html).toContain('6 个后台智能体')
    expect(html).toContain('子智能体 2')
    expect(html).toContain('子智能体 5')
    expect(html).not.toContain('子智能体 6</span>')
    expect(html).toContain('data-session-subagent-view-all')
  })

  test('Given CCB 节点仍为 running 且仍在实时图 When 父会话已停止 Then 保留独立运行状态', () => {
    const html = renderFloatingPanel(false, [], {
      nodes: [{
        id: 'running-node',
        kind: 'subagent',
        name: '仍在运行的 CCB 节点',
        description: '独立执行',
        status: 'running',
        transcriptAvailable: true,
      }],
      todos: [],
      updatedAt: 100,
    })

    expect(html).toContain('仍在运行的 CCB 节点')
    expect(html).toContain('正在运行')
    expect(html).toContain('animate-spin')
  })

  test('Given Collaboration 子会话刚完成 When 终态保留时间未到 Then 先显示完成状态', () => {
    const html = renderFloatingPanel(false, [{
      id: 'completed-child',
      title: '已完成的协作节点',
      parentSessionId: SESSION_ID,
      sourceDelegationId: 'delegation-completed',
      delegationStatus: 'completed',
      createdAt: 10,
      updatedAt: 20,
    }], {
      nodes: [],
      todos: [],
      updatedAt: 100,
    })

    expect(html).toContain('已完成的协作节点')
    expect(html).toContain('text-emerald-500')
  })

  test('Given 执行节点变化导致 updatedAt 变化 When Todo 签名未变化 Then 已完成旧计划仍保持隐藏', () => {
    const todos = [{ id: '1', content: '签名稳定的旧计划', status: 'completed' as const }]
    const store = createStore()
    store.set(agentRuntimeExecutionGraphsAtom, new Map([[SESSION_ID, {
      nodes: [{
        id: 'new-node',
        kind: 'subagent',
        name: '新节点',
        description: '只改变执行图',
        status: 'running',
        transcriptAvailable: true,
      }],
      todos,
      updatedAt: 999,
    }]]))
    store.set(agentFloatingPanelPlanStatesAtom, new Map([[SESSION_ID, {
      observedTurnEpoch: 200,
      suppressedCompletedPlanSignature: createFloatingPlanSignature(todos),
    }]]))
    store.set(agentSessionsAtom, [])
    store.set(agentStreamingStatesAtom, new Map())

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SessionFloatingPanel sessionId={SESSION_ID} sessionPath={null} />
      </Provider>,
    )

    expect(html).not.toContain('签名稳定的旧计划')
    expect(html).toContain('新节点')
  })

  test('Given 存在运行中的浏览器任务 When 渲染悬浮面板 Then 展示浏览器任务区块与条目', () => {
    const html = renderFloatingPanel(false, [], {
      nodes: [],
      todos: [],
      updatedAt: 1,
    }, [{
      taskId: 'appstore-connect',
      sessionId: SESSION_ID,
      title: 'App Store Connect',
      url: 'https://appstoreconnect.apple.com/login',
      status: 'running',
      createdAt: 100,
      updatedAt: 100,
    }])

    expect(html).toContain('data-session-floating-browser-region')
    expect(html).toContain('1 个浏览器任务')
    expect(html).toContain('App Store Connect')
    expect(html).toContain('data-browser-task-entry=\"appstore-connect\"')
    expect(html).toContain('agent-status-shimmer')
    expect(html).not.toContain('animate-spin')
  })

  test('Given 浏览器任务明确等待用户 When 渲染悬浮面板 Then 保留可操作入口但不执行流光', () => {
    const html = renderFloatingPanel(false, [], {
      nodes: [],
      todos: [],
      updatedAt: 1,
    }, [{
      taskId: 'waiting-browser-task',
      sessionId: SESSION_ID,
      title: '请完成网页登录',
      url: 'https://example.com/login',
      status: 'waiting_user',
      createdAt: 100,
      updatedAt: 100,
    }])

    expect(html).toContain('data-session-floating-browser-region')
    expect(html).toContain('data-browser-task-entry=\"waiting-browser-task\"')
    expect(html).toContain('请完成网页登录')
    expect(html).toContain('等待操作')
    expect(html).not.toContain('agent-status-shimmer')
  })

  test('Given 浏览器任务已暂停或失败 When 渲染悬浮面板 Then 不显示（只显示运行或等待用户）', () => {
    const html = renderFloatingPanel(false, [], {
      nodes: [],
      todos: [],
      updatedAt: 1,
    }, [
      {
        taskId: 'paused-task',
        sessionId: SESSION_ID,
        title: '暂停的页面',
        url: 'about:blank',
        status: 'paused',
        createdAt: 100,
        updatedAt: 100,
      },
      {
        taskId: 'failed-task',
        sessionId: SESSION_ID,
        title: '失败的页面',
        url: 'about:blank',
        status: 'failed',
        createdAt: 100,
        updatedAt: 100,
      },
    ])

    expect(html).not.toContain('data-session-floating-browser-region')
    expect(html).not.toContain('暂停的页面')
    expect(html).not.toContain('失败的页面')
  })

  test('Given 浏览器任务已完成 When 渲染悬浮面板 Then 不显示（只有 running 显示）', () => {
    const html = renderFloatingPanel(false, [], {
      nodes: [],
      todos: [],
      updatedAt: 1,
    }, [{
      taskId: 'completed-task',
      sessionId: SESSION_ID,
      title: '已完成的页面',
      url: 'about:blank',
      status: 'completed',
      createdAt: 100,
      updatedAt: 100,
    }])

    expect(html).not.toContain('data-session-floating-browser-region')
    expect(html).not.toContain('已完成的页面')
  })
})
