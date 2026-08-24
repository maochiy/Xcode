import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentRuntimeExecutionGraph } from '@proma/shared'
import {
  agentDiffPanelTabAtom,
  agentChildDelegationSessionsAtomFamily,
  agentRuntimeExecutionGraphAtomFamily,
  agentRuntimeExecutionGraphsAtom,
  agentRuntimeExecutionNodeByToolUseIdAtomFamily,
  agentSessionLiveMessagesAtomFamily,
  agentSessionsAtom,
  agentSidePanelTabsAtom,
  applyAgentEvent,
  areAgentRuntimeExecutionGraphsEqual,
  beginAgentSteeredTurn,
  createRuntimeExecutionNodeToolKey,
  fileBrowserAutoRevealAtom,
  markAgentFileModifiedAtom,
  mergeAgentRuntimeExecutionGraphAtom,
  recentlyModifiedPathsAtom,
  liveMessagesMapAtom,
  markAgentStreamStopped,
  stabilizeAgentRuntimeExecutionGraph,
  type AgentStreamState,
} from './agent-atoms'
import type { AgentSessionMeta, SDKMessage } from '@proma/shared'

function createStreamState(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    content: '',
    toolActivities: [],
    inputTokens: 180_000,
    outputTokens: 2_000,
    cacheReadTokens: 160_000,
    cacheCreationTokens: 18_000,
    contextWindow: 200_000,
    ...overrides,
  }
}

describe('Agent 上下文压缩状态', () => {
  test('given Pi 手动压缩提供预估 token when 压缩完成 then 显示预估值并清除旧明细', () => {
    const result = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })

    expect(result).toMatchObject({
      isCompacting: false,
      inputTokens: 32_000,
      contextWindow: 200_000,
      contextUsageIsEstimated: true,
    })
    expect(result.outputTokens).toBeUndefined()
    expect(result.cacheReadTokens).toBeUndefined()
    expect(result.cacheCreationTokens).toBeUndefined()
  })

  test('given 压缩后的预估值 when 当前压缩操作的收尾 result 没有 usage then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, { type: 'complete' })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 收到零 token result then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 下一轮收到真实 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'usage_update',
      usage: {
        inputTokens: 36_000,
        cacheReadTokens: 30_000,
        outputTokens: 800,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 36_000,
      cacheReadTokens: 30_000,
      outputTokens: 800,
      contextUsageIsEstimated: false,
    })
  })

  test('given 压缩后的预估值 when 下一轮仅在 result 返回 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 40_000,
        cacheReadTokens: 34_000,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 40_000,
      cacheReadTokens: 34_000,
      contextUsageIsEstimated: false,
    })
  })

  test('given 没有 Pi 预估 token 的压缩完成事件 when 处理 then 保持既有上下文用量', () => {
    const result = applyAgentEvent(createStreamState(), { type: 'compact_complete', status: 'success' })

    expect(result).toMatchObject({
      isCompacting: false,
      inputTokens: 180_000,
    })
    expect(result.contextUsageIsEstimated).toBeUndefined()
  })
})

describe('Agent 暂停即时反馈', () => {
  test('Given Agent 正在运行且存在未完成工具 When 用户点击暂停 Then 立即进入停止态并保留计时起点', () => {
    const state = createStreamState({
      startedAt: 123,
      backgroundWaiting: true,
      toolActivities: [{
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: {},
        done: false,
      }],
    })

    const stopped = markAgentStreamStopped(state)

    expect(stopped).toMatchObject({
      running: false,
      backgroundWaiting: false,
      stopping: true,
      startedAt: 123,
    })
    expect(stopped.toolActivities).toEqual([{
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: {},
      done: true,
    }])
  })

  test('Given Agent 已经停止 When 再次收敛暂停状态 Then 保持原对象避免无意义重渲染', () => {
    const state = createStreamState({ running: false })

    expect(markAgentStreamStopped(state)).toBe(state)
  })
})

describe('Agent 立即发送即时反馈', () => {
  test('Given Runtime 正在运行 When steering 立即发送 Then 只重置当前回合展示且保留 Runtime 纪元与上下文用量', () => {
    const previous = createStreamState({
      startedAt: 100,
      turnStartedAt: 100,
      content: '上一回合还在输出',
      toolActivities: [{
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: {},
        done: false,
      }],
      retrying: {
        currentAttempt: 1,
        maxAttempts: 3,
        history: [],
        failed: false,
      },
    })

    const next = beginAgentSteeredTurn(previous, 250)

    expect(next).toMatchObject({
      running: true,
      stopping: false,
      backgroundWaiting: false,
      content: '',
      toolActivities: [],
      startedAt: 100,
      turnStartedAt: 250,
      inputTokens: 180_000,
      contextWindow: 200_000,
    })
    expect(next.retrying).toBeUndefined()
  })
})

describe('Agent 实时消息按会话切片', () => {
  test('Given 当前会话已订阅实时消息 When 后台会话更新 Then 当前会话派生值保持原引用', () => {
    const store = createStore()
    const sessionA = 'session-a'
    const sessionB = 'session-b'
    const messagesA: SDKMessage[] = [{
      type: 'system',
      subtype: 'init',
      _createdAt: 1,
    } as SDKMessage]

    store.set(liveMessagesMapAtom, new Map([[sessionA, messagesA]]))
    const selectedBefore = store.get(agentSessionLiveMessagesAtomFamily(sessionA))

    store.set(liveMessagesMapAtom, (previous) => {
      const next = new Map(previous)
      next.set(sessionB, [{
        type: 'system',
        subtype: 'init',
        _createdAt: 2,
      } as SDKMessage])
      return next
    })

    expect(store.get(agentSessionLiveMessagesAtomFamily(sessionA))).toBe(selectedBefore)
    expect(store.get(agentSessionLiveMessagesAtomFamily(sessionA))).toBe(messagesA)
  })
})

describe('Agent 文件修改展示状态', () => {
  test('Given 右侧没有打开文件 Tab When Agent 修改文件 Then 只记录标记且不创建 Tab 或定位文件', () => {
    const store = createStore()
    const sessionId = 'agent-file-write-session'
    const path = '/tmp/project/src/new-file.ts'

    store.set(markAgentFileModifiedAtom, {
      sessionId,
      path,
      modifiedAt: 123,
    })

    expect(store.get(recentlyModifiedPathsAtom).get(sessionId)?.get(path)).toBe(123)
    expect(store.get(agentSidePanelTabsAtom).get(sessionId)).toBeUndefined()
    expect(store.get(agentDiffPanelTabAtom).get(sessionId)).toBeUndefined()
    expect(store.get(fileBrowserAutoRevealAtom)).toBeNull()
  })

  test('Given 用户已打开其他文件 Tab When Agent 修改文件 Then 不切换 Tab 且不覆盖用户定位状态', () => {
    const store = createStore()
    const sessionId = 'agent-file-write-session'
    const manualReveal = {
      sessionId,
      path: '/tmp/project/src/manual.ts',
      ts: 100,
    }
    store.set(agentSidePanelTabsAtom, new Map([[sessionId, ['workspace']]]))
    store.set(agentDiffPanelTabAtom, new Map([[sessionId, 'workspace']]))
    store.set(fileBrowserAutoRevealAtom, manualReveal)

    store.set(markAgentFileModifiedAtom, {
      sessionId,
      path: '/tmp/project/src/generated.ts',
      modifiedAt: 123,
    })

    expect(store.get(agentSidePanelTabsAtom).get(sessionId)).toEqual(['workspace'])
    expect(store.get(agentDiffPanelTabAtom).get(sessionId)).toBe('workspace')
    expect(store.get(fileBrowserAutoRevealAtom)).toEqual(manualReveal)
  })
})


describe('Agent Runtime 执行图合并短路', () => {
  const sessionId = 'runtime-graph-merge-session'

  function createGraph(
    overrides: Partial<AgentRuntimeExecutionGraph> = {},
  ): AgentRuntimeExecutionGraph {
    return {
      runtimeSessionId: 'runtime-1',
      nodes: [{
        id: 'node-1',
        kind: 'subagent',
        status: 'running',
        description: '执行任务',
        transcriptAvailable: false,
        toolUseId: 'tool-1',
      }],
      todos: [{
        id: 'todo-1',
        content: '完成实现',
        status: 'in_progress',
      }],
      updatedAt: 100,
      ...overrides,
    }
  }

  test('Given 相同内容的执行图 When 再次 merge Then 保持 Map 引用不变且不触发无意义写回', () => {
    const store = createStore()
    const first = createGraph({ updatedAt: 100 })
    store.set(mergeAgentRuntimeExecutionGraphAtom, { sessionId, graph: first })
    const mapAfterFirst = store.get(agentRuntimeExecutionGraphsAtom)
    const graphAfterFirst = mapAfterFirst.get(sessionId)

    store.set(mergeAgentRuntimeExecutionGraphAtom, {
      sessionId,
      graph: createGraph({ updatedAt: 100 }),
    })
    const mapAfterSecond = store.get(agentRuntimeExecutionGraphsAtom)

    expect(mapAfterSecond).toBe(mapAfterFirst)
    expect(mapAfterSecond.get(sessionId)).toBe(graphAfterFirst)
  })

  test('Given 仅 updatedAt 推进但 nodes/todos 相同 When merge Then 仍然短路不写回', () => {
    const store = createStore()
    store.set(mergeAgentRuntimeExecutionGraphAtom, {
      sessionId,
      graph: createGraph({ updatedAt: 100 }),
    })
    const mapAfterFirst = store.get(agentRuntimeExecutionGraphsAtom)

    store.set(mergeAgentRuntimeExecutionGraphAtom, {
      sessionId,
      graph: createGraph({ updatedAt: 999 }),
    })

    expect(store.get(agentRuntimeExecutionGraphsAtom)).toBe(mapAfterFirst)
    expect(store.get(agentRuntimeExecutionGraphsAtom).get(sessionId)?.updatedAt).toBe(100)
  })

  test('Given 更旧的 updatedAt When merge Then 仍丢弃旧图', () => {
    const store = createStore()
    store.set(mergeAgentRuntimeExecutionGraphAtom, {
      sessionId,
      graph: createGraph({
        updatedAt: 200,
        nodes: [{
          id: 'node-1',
          kind: 'subagent',
          status: 'completed',
          description: '新状态',
          transcriptAvailable: true,
          toolUseId: 'tool-1',
        }],
      }),
    })

    store.set(mergeAgentRuntimeExecutionGraphAtom, {
      sessionId,
      graph: createGraph({
        updatedAt: 100,
        nodes: [{
          id: 'node-1',
          kind: 'subagent',
          status: 'running',
          description: '旧状态',
          transcriptAvailable: false,
          toolUseId: 'tool-1',
        }],
      }),
    })

    expect(store.get(agentRuntimeExecutionGraphsAtom).get(sessionId)?.nodes[0]?.status).toBe('completed')
    expect(store.get(agentRuntimeExecutionGraphsAtom).get(sessionId)?.updatedAt).toBe(200)
  })

  test('Given 节点状态真实变化 When merge Then 正常写入新图', () => {
    const store = createStore()
    store.set(mergeAgentRuntimeExecutionGraphAtom, {
      sessionId,
      graph: createGraph({ updatedAt: 100 }),
    })
    const mapAfterFirst = store.get(agentRuntimeExecutionGraphsAtom)

    const next = createGraph({
      updatedAt: 150,
      nodes: [{
        id: 'node-1',
        kind: 'subagent',
        status: 'completed',
        description: '执行任务',
        transcriptAvailable: true,
        toolUseId: 'tool-1',
        completedAt: 150,
      }],
    })
    store.set(mergeAgentRuntimeExecutionGraphAtom, { sessionId, graph: next })
    const mapAfterSecond = store.get(agentRuntimeExecutionGraphsAtom)

    expect(mapAfterSecond).not.toBe(mapAfterFirst)
    expect(mapAfterSecond.get(sessionId)?.nodes[0]?.status).toBe('completed')
    expect(store.get(agentRuntimeExecutionGraphAtomFamily(sessionId))?.nodes[0]?.status).toBe('completed')
  })

  test('Given 两份等价执行图 When 比较 Then areAgentRuntimeExecutionGraphsEqual 为 true', () => {
    expect(
      areAgentRuntimeExecutionGraphsEqual(
        createGraph({ updatedAt: 1 }),
        createGraph({ updatedAt: 99 }),
      ),
    ).toBe(true)
  })
})


describe('Agent Runtime 执行图引用稳定与节点切片', () => {
  test('Given 仅某个节点状态变化 When stabilize Then 其他节点保持同一引用', () => {
    const existing = {
      runtimeSessionId: 'runtime-1',
      updatedAt: 100,
      todos: [{ id: 't1', content: 'todo', status: 'pending' as const }],
      nodes: [
        {
          id: 'n1',
          kind: 'subagent' as const,
          status: 'running' as const,
          description: 'A',
          transcriptAvailable: false,
          toolUseId: 'tool-a',
        },
        {
          id: 'n2',
          kind: 'subagent' as const,
          status: 'running' as const,
          description: 'B',
          transcriptAvailable: false,
          toolUseId: 'tool-b',
        },
      ],
    }
    const incoming = {
      ...existing,
      updatedAt: 200,
      nodes: [
        { ...existing.nodes[0]! },
        {
          ...existing.nodes[1]!,
          status: 'completed' as const,
          completedAt: 200,
          transcriptAvailable: true,
        },
      ],
    }

    const stabilized = stabilizeAgentRuntimeExecutionGraph(existing, incoming)
    expect(stabilized.nodes[0]).toBe(existing.nodes[0])
    expect(stabilized.nodes[1]).not.toBe(existing.nodes[1])
    expect(stabilized.nodes[1]?.status).toBe('completed')
    expect(stabilized.todos[0]).toBe(existing.todos[0])
  })

  test('Given 合并后仅部分节点变化 When 按 toolUseId 读取 Then 未变化节点 atom 保持原引用', () => {
    const store = createStore()
    const sessionId = 'node-slice-session'
    const first = {
      runtimeSessionId: 'runtime-1',
      updatedAt: 100,
      todos: [] as AgentRuntimeExecutionGraph['todos'],
      nodes: [
        {
          id: 'n1',
          kind: 'subagent' as const,
          status: 'running' as const,
          description: 'A',
          transcriptAvailable: false,
          toolUseId: 'tool-a',
        },
        {
          id: 'n2',
          kind: 'subagent' as const,
          status: 'running' as const,
          description: 'B',
          transcriptAvailable: false,
          toolUseId: 'tool-b',
        },
      ],
    }
    store.set(mergeAgentRuntimeExecutionGraphAtom, { sessionId, graph: first })
    const nodeAKey = createRuntimeExecutionNodeToolKey(sessionId, 'tool-a')
    const nodeBKey = createRuntimeExecutionNodeToolKey(sessionId, 'tool-b')
    const nodeA1 = store.get(agentRuntimeExecutionNodeByToolUseIdAtomFamily(nodeAKey))
    const nodeB1 = store.get(agentRuntimeExecutionNodeByToolUseIdAtomFamily(nodeBKey))

    store.set(mergeAgentRuntimeExecutionGraphAtom, {
      sessionId,
      graph: {
        ...first,
        updatedAt: 150,
        nodes: [
          { ...first.nodes[0]! },
          {
            ...first.nodes[1]!,
            status: 'completed',
            completedAt: 150,
            transcriptAvailable: true,
          },
        ],
      },
    })

    const nodeA2 = store.get(agentRuntimeExecutionNodeByToolUseIdAtomFamily(nodeAKey))
    const nodeB2 = store.get(agentRuntimeExecutionNodeByToolUseIdAtomFamily(nodeBKey))
    expect(nodeA2).toBe(nodeA1)
    expect(nodeB2).not.toBe(nodeB1)
    expect(nodeB2?.status).toBe('completed')
  })

  test('Given 子会话列表字段未变 When 全局 sessions 换新数组 Then child family 保持缓存引用', () => {
    const store = createStore()
    const parentId = 'parent-session'
    const child: AgentSessionMeta = {
      id: 'child-1',
      title: '子任务',
      createdAt: 1,
      updatedAt: 2,
      parentSessionId: parentId,
      sourceDelegationId: 'd1',
      delegationStatus: 'running',
    } as AgentSessionMeta

    store.set(agentSessionsAtom, [child])
    const first = store.get(agentChildDelegationSessionsAtomFamily(parentId))
    store.set(agentSessionsAtom, [{ ...child }])
    const second = store.get(agentChildDelegationSessionsAtomFamily(parentId))
    expect(second).toBe(first)

    store.set(agentSessionsAtom, [{
      ...child,
      delegationStatus: 'completed',
      updatedAt: 3,
    } as AgentSessionMeta])
    const third = store.get(agentChildDelegationSessionsAtomFamily(parentId))
    expect(third).not.toBe(first)
    expect(third[0]?.delegationStatus).toBe('completed')
  })
})
