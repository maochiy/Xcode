/**
 * Agent Atoms — Agent 模式的 Jotai 状态管理
 *
 * 管理 Agent 会话列表、当前会话、消息、流式状态等。
 * 模式照搬 chat-atoms.ts。
 */

import { atom } from 'jotai'
import { atomFamily, atomWithStorage } from 'jotai/utils'
import type { AgentSessionMeta, AgentEvent, AgentWorkspace, AgentPendingFile, AgentRuntimeModelCatalog, AgentRuntimeExecutionGraph, AgentRuntimeExecutionNode, AgentRuntimePlanSessionState, AgentRuntimeSubagentTranscript, AgentRuntimeTodoItem, AgentTurnChangeStats, RetryAttempt, PromaPermissionMode, PermissionRequest, AskUserRequest, ExitPlanModeRequest, ThinkingConfig, ThinkingEffortLevel, SDKMessage, SDKUserMessage, UnstagedChangesResult, GitRepoStatus, IntegratedTerminalSessionSnapshot } from '@proma/shared'
import { PROMA_DEFAULT_PERMISSION_MODE } from '@proma/shared'
import { calculateDockBadgeCount, countPendingRequests } from '@/lib/dock-badge-count'
import type { AgentQueuedMessage } from '@/lib/agent-message-queue'
import type { SessionExecutionNode } from '@/lib/session-execution-nodes'
import {
  advanceFloatingPanelPlanState,
  createFloatingPlanSignature,
  finalizeOrphanedRuntimeExecutionNodes,
  FLOATING_EXECUTION_NODE_COMPLETION_DELAY_MS,
  FLOATING_EXECUTION_NODE_COMPLETION_STAGGER_MS,
  isFloatingExecutionNodeTerminal,
} from '@/lib/session-floating-runtime-lifecycle'
import type { AgentFloatingPanelPlanState } from '@/lib/session-floating-runtime-lifecycle'
import {
  activateRuntimePlanTodo,
  applyRuntimePlanGraph,
  beginRuntimePlanTurn,
  interruptRuntimePlan,
} from '@/lib/runtime-plan-lifecycle'

/** 活动状态 */
export type ActivityStatus = 'pending' | 'running' | 'completed' | 'error' | 'backgrounded'

/** 工具活动状态 */
export interface ToolActivity {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  intent?: string
  displayName?: string
  result?: string
  isError?: boolean
  done: boolean
  parentToolUseId?: string
  elapsedSeconds?: number
  taskId?: string
  shellId?: string
  isBackground?: boolean
  /** MCP 工具返回的图片附件 */
  imageAttachments?: Array<{ localPath: string; filename: string; mediaType: string }>
}

/** 活动分组（Task 子代理） */
export interface ActivityGroup {
  parent: ToolActivity
  children: ToolActivity[]
}

/**
 * 将流式状态中未完成的 toolActivities 标记为终态。
 * 用于 complete、handleStop、STREAM_COMPLETE 等多个终态入口的兜底清理。
 * 当所有项已处于终态时返回原引用，避免不必要的 React 重渲染。
 */
export function finalizeStreamingActivities(
  toolActivities: ToolActivity[],
): { toolActivities: ToolActivity[] } {
  const hasUnfinishedTools = toolActivities.some((ta) => !ta.done)

  return {
    toolActivities: hasUnfinishedTools
      ? toolActivities.map((ta) => (ta.done ? ta : { ...ta, done: true }))
      : toolActivities,
  }
}

/**
 * 将用户点击暂停后的流式状态立即收敛到停止态。
 *
 * Runtime 的真正停止仍由主进程异步确认；这里仅负责前端反馈，避免按钮继续显示
 * 运行中。保留 startedAt 和已有内容，供停止文案与消息收尾逻辑继续使用。
 */
export function markAgentStreamStopped(state: AgentStreamState): AgentStreamState {
  if (!state.running) return state
  const startedAt = state.turnStartedAt ?? state.startedAt
  return {
    ...state,
    running: false,
    backgroundWaiting: false,
    stopping: true,
    ...(state.isCompacting && {
      isCompacting: false,
      contextCompaction: finishPendingCompaction(state.contextCompaction, true),
    }),
    // 停止点击时立即冻结耗时，避免后端完成事件返回另一套计时口径后跳变。
    stopDurationMs: state.stopDurationMs ?? (
      startedAt == null ? undefined : Math.max(0, Date.now() - startedAt)
    ),
    ...finalizeStreamingActivities(state.toolActivities),
  }
}

export interface ContextCompactionState {
  status: 'running' | 'success' | 'noop' | 'failed' | 'stopped'
  trigger?: 'manual' | 'auto'
  summary?: string
  message?: string
  preTokens?: number
  postTokens?: number
}

/** 没有收到原生压缩完成事件时，不能把流结束推断为压缩成功。 */
export function finishPendingCompaction(
  compaction: ContextCompactionState | undefined,
  stoppedByUser: boolean,
): ContextCompactionState {
  return {
    ...compaction,
    status: stoppedByUser ? 'stopped' : 'failed',
    message: stoppedByUser ? undefined : '未收到上下文压缩完成确认',
  }
}

/** Agent 会话的流式状态 */
export interface AgentStreamState {
  running: boolean
  /** 用户已点击停止，等待 Runtime 完成真正收尾。 */
  stopping?: boolean
  /**
   * 后台任务等待态（软空闲）：本轮主体已结束、UI 可输入，但 SDK 通道仍开着等后台任务唤醒。
   * 此状态下 running 为 false，但服务端 activeSessions 仍保留，新消息必须走注入通道而非新建 run。
   */
  backgroundWaiting?: boolean
  content: string
  toolActivities: ToolActivity[]
  model?: string
  /** 当前输入 token 数（上下文使用量） */
  inputTokens?: number
  /** 输出 token 数 */
  outputTokens?: number
  /** 缓存读取 token 数 */
  cacheReadTokens?: number
  /** 缓存写入 token 数 */
  cacheCreationTokens?: number
  /** 会话累计净输入 tokens（不含缓存；对齐 opencode 的 adjusted input 口径） */
  cumulativeInputTokens?: number
  /** 会话累计缓存读取 tokens（用于计算缓存命中率） */
  cumulativeCacheReadTokens?: number
  /** 会话累计缓存写入 tokens */
  cumulativeCacheCreationTokens?: number
  /** 费用（美元） */
  costUsd?: number
  /** 模型上下文窗口大小 */
  contextWindow?: number
  /** 当前上下文 token 是 CCB 压缩后的估算值 */
  contextUsageIsEstimated?: boolean
  /** CCB 当前模型的自动压缩配置。 */
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  effectiveContextWindow?: number
  /** 当前 thinking block 的 token 估算值（SDK 实时估算，非计费值） */
  thinkingEstimatedTokens?: number
  /** 是否正在压缩上下文 */
  isCompacting?: boolean
  /** 当前或最近一次压缩状态，保留到实时消息清理完成后供底部进度区展示。 */
  contextCompaction?: ContextCompactionState
  /** 流式开始时间戳（用于思考计时持久化） */
  startedAt?: number
  /** 用户点击停止时冻结的耗时，避免完成事件到达后停止文案跳变。 */
  stopDurationMs?: number
  /**
   * 当前可见回合的开始时间戳。
   *
   * 运行中的 steering 会复用同一个 Runtime run，不能改写 startedAt，
   * 否则旧 run 的 complete 事件会被竞态保护误判为陈旧事件。UI 计时
   * 使用这个字段，让新回合从 Pi 实际消费 steering user 时开始计时。
   */
  turnStartedAt?: number
  /** 重试状态（扩展版） */
  retrying?: {
    /** 当前第几次尝试 */
    currentAttempt: number
    /** 最大尝试次数 */
    maxAttempts: number
    /** 重试历史记录（按时间顺序） */
    history: RetryAttempt[]
    /** 是否已失败 */
    failed: boolean
  }
}

/**
 * Pi 实际消费 steering user 后开始对应回合的前端展示。
 *
 * Runtime 仍处于同一个 run 时，startedAt 必须保持不变，才能让旧 run
 * 的完成事件正常收尾；turnStartedAt 仅用于当前回合的处理中计时。
 */
export function beginAgentSteeredTurn(
  previous: AgentStreamState,
  turnStartedAt: number,
): AgentStreamState {
  return {
    ...previous,
    running: true,
    stopping: false,
    backgroundWaiting: false,
    content: '',
    toolActivities: [],
    retrying: undefined,
    stopDurationMs: undefined,
    turnStartedAt,
  }
}

/** Assistant Turn 整轮活动的用户手动折叠状态，仅保存在当前应用内存。 */
export type AgentTurnCollapseState = 'expanded' | 'collapsed'
export const agentTurnCollapseStatesAtom = atom<
  Map<string, Map<string, AgentTurnCollapseState>>
>(new Map())

/** 会话悬浮面板中的后台智能体区域展开状态，与正文 Turn 折叠相互独立。 */
export const agentFloatingSubagentsExpandedAtom = atom<Map<string, boolean>>(new Map())

/** 从 ToolActivity 派生状态 */
export function getActivityStatus(activity: ToolActivity): ActivityStatus {
  if (activity.isBackground) return 'backgrounded'
  if (!activity.done) return 'running'
  if (activity.isError) return 'error'
  return 'completed'
}

/**
 * 合并同层 TodoWrite 活动：多次调用只保留最新 input，置底显示
 *
 * TodoWrite 每次调用都包含完整的 todo 列表，只需展示最新状态。
 */
function mergeTodoWrites(activities: ToolActivity[]): ToolActivity[] {
  const todoWrites: ToolActivity[] = []
  const others: ToolActivity[] = []

  for (const a of activities) {
    if (a.toolName === 'TodoWrite') {
      todoWrites.push(a)
    } else {
      others.push(a)
    }
  }

  if (todoWrites.length === 0) return activities

  const latest = todoWrites[todoWrites.length - 1]!
  const allDone = todoWrites.every((t) => t.done)

  const merged: ToolActivity = {
    ...latest,
    done: allDone,
    isError: allDone && todoWrites.some((t) => t.isError),
  }

  return [...others, merged]
}

/**
 * 将扁平活动列表按 parentToolUseId 分组
 *
 * 返回顶层项（ActivityGroup | ToolActivity），
 * Task 类型的工具作为 group.parent，其子活动嵌套在 children 中。
 * 每层内 TodoWrite 合并去重并置底。
 */
export function groupActivities(activities: ToolActivity[]): Array<ActivityGroup | ToolActivity> {
  // 过滤幽灵条目：tool_progress 创建的空 input 条目，完成后仍无内容
  const filtered = activities.filter((a) => {
    if (a.done && Object.keys(a.input).length === 0 && !a.result) return false
    return true
  })
  const processed = mergeTodoWrites(filtered)

  const parentIds = new Set<string>()
  for (const a of processed) {
    if (a.toolName === 'Task' || a.toolName === 'Agent') parentIds.add(a.toolUseId)
  }

  const childrenMap = new Map<string, ToolActivity[]>()
  const topLevel: Array<ActivityGroup | ToolActivity> = []

  for (const a of processed) {
    if (a.parentToolUseId && parentIds.has(a.parentToolUseId)) {
      const children = childrenMap.get(a.parentToolUseId) ?? []
      children.push(a)
      childrenMap.set(a.parentToolUseId, children)
    } else {
      topLevel.push(a)
    }
  }

  return topLevel.map((item) => {
    if ('toolUseId' in item && parentIds.has(item.toolUseId)) {
      const children = childrenMap.get(item.toolUseId) ?? []
      return { parent: item, children: mergeTodoWrites(children) } as ActivityGroup
    }
    return item
  })
}

/** 判断是否为 ActivityGroup */
export function isActivityGroup(item: ActivityGroup | ToolActivity): item is ActivityGroup {
  return 'parent' in item && 'children' in item
}


/** 待自动发送的 Agent 提示（从设置页"对话完成配置"触发） */
export interface AgentPendingPrompt {
  sessionId: string
  message: string
  additionalDirectories?: string[]
}

// ===== Atoms =====

export const agentSessionsAtom = atom<AgentSessionMeta[]>([])
export const agentWorkspacesAtom = atom<AgentWorkspace[]>([])
export const currentAgentWorkspaceIdAtom = atom<string | null>(null)
/** 侧栏「自动任务」合成项目组在项目列表中的位置索引（默认 0 = 最靠前；从 settings.json 加载） */
export const automationGroupOrderAtom = atom<number>(0)
/** 全局默认渠道 ID（新会话继承用，从 settings.json 加载） */
export const agentChannelIdAtom = atom<string | null>(null)
/** 全局默认模型 ID（新会话继承用，从 settings.json 加载） */
export const agentModelIdAtom = atom<string | null>(null)
/** Agent 启用的渠道 ID 列表（多选，设置页 Switch 开关控制） */
export const agentChannelIdsAtom = atom<string[]>([])
/** CCB Runtime 按「项目 + Channel」解析的模型目录；仅保存在内存中。 */
export const agentRuntimeModelCatalogsAtom = atom<Map<string, AgentRuntimeModelCatalog>>(new Map())
/** 模型配置保存后的刷新序号，用于立即重新向 CCB Runtime 读取目录。 */
export const agentRuntimeModelCatalogRevisionAtom = atom(0)

export function getAgentRuntimeModelCatalogKey(
  workspaceId: string | null | undefined,
  channelId: string,
): string {
  return `${workspaceId ?? '__default__'}:${channelId}`
}

/** Per-session 渠道 ID Map — sessionId → channelId */
export const agentSessionChannelMapAtom = atom<Map<string, string>>(new Map())
/** Per-session 模型 ID Map — sessionId → modelId */
export const agentSessionModelMapAtom = atom<Map<string, string>>(new Map())
export const currentAgentSessionIdAtom = atom<string | null>(null)
export const agentStreamingStatesAtom = atom<Map<string, AgentStreamState>>(new Map())

/**
 * 单个 session 的 streaming state 派生 atomFamily — 按 sessionId 切片订阅。
 *
 * 直接订阅 agentStreamingStatesAtom 会让任意 session 的流式更新都触发 AgentView
 * 整树重渲染（10–30fps）。本 family 让订阅者只在本 session 的 state 引用变化时
 * 重渲染——其他 session 的更新虽然让 base atom 变化，但派生 atom 输出引用未变，
 * jotai 自动跳过通知。
 */
export const agentSessionStreamingStateAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(agentStreamingStatesAtom).get(sessionId)),
)

/**
 * 实时 SDKMessage 累积 Map — Phase 2 新增
 *
 * 流式期间每条 SDKMessage 直接追加，供新 UI 渲染。
 * 流式完成后清空（持久化消息从 JSONL 加载）。
 */
export const liveMessagesMapAtom = atom<Map<string, SDKMessage[]>>(new Map())

/**
 * 单个 session 的实时消息派生 atom — 按 sessionId 切片订阅。
 *
 * 实时消息以 Map 形式集中写入，但展示组件不应订阅整个 Map。
 * 否则后台会话每收到一个 SDK 增量，所有打开的 AgentView 都会重渲染。
 */
export const agentSessionLiveMessagesAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(liveMessagesMapAtom).get(sessionId)),
)

export const agentPendingPromptAtom = atom<AgentPendingPrompt | null>(null)

/**
 * Agent 待发送文件列表 Map — 以 sessionId 为 key
 * 切换会话时保留各 session 自己的 pending files，与文字草稿语义一致
 */
export const agentSessionPendingFilesAtom = atom<Map<string, AgentPendingFile[]>>(new Map())

/**
 * 单个 session 的 pending files 派生 atom（读写）— 按 sessionId 切片
 * read：返回当前 session 的数组（空数组兜底）
 * write：接受新数组或 updater 函数，写回时空数组转为 delete，避免 Map 长期残留空 entry
 */
export const agentPendingFilesAtomFamily = atomFamily((sessionId: string) =>
  atom(
    (get) => get(agentSessionPendingFilesAtom).get(sessionId) ?? [],
    (_get, set, update: AgentPendingFile[] | ((prev: AgentPendingFile[]) => AgentPendingFile[])) => {
      set(agentSessionPendingFilesAtom, (prev) => {
        const current = prev.get(sessionId) ?? []
        const next = typeof update === 'function' ? update(current) : update
        const map = new Map(prev)
        if (next.length === 0) {
          map.delete(sessionId)
        } else {
          map.set(sessionId, next)
        }
        return map
      })
    },
  ),
)

/**
 * Agent 运行中待发送消息队列 Map — 以 sessionId 为 key。
 * 队列只保存在渲染进程内存中，避免跨重启恢复时误把过期上下文继续发送。
 */
export const agentSessionMessageQueueAtom = atom<Map<string, AgentQueuedMessage[]>>(new Map())

/** Pi steering 消费前的可见 user；只用于投影，不写入原生历史。 */
export const agentImmediateUserMessagesAtom = atom<Map<string, SDKUserMessage[]>>(new Map())

/**
 * 单个 session 的队列派生 atom（读写）。
 * 空队列写回时删除 Map entry，避免长时间使用后残留空数组。
 */
export const agentMessageQueueAtomFamily = atomFamily((sessionId: string) =>
  atom(
    (get) => get(agentSessionMessageQueueAtom).get(sessionId) ?? [],
    (_get, set, update: AgentQueuedMessage[] | ((prev: AgentQueuedMessage[]) => AgentQueuedMessage[])) => {
      set(agentSessionMessageQueueAtom, (prev) => {
        const current = prev.get(sessionId) ?? []
        const next = typeof update === 'function' ? update(current) : update
        const map = new Map(prev)
        if (next.length === 0) {
          map.delete(sessionId)
        } else {
          map.set(sessionId, next)
        }
        return map
      })
    },
  ),
)

/** 工作区能力版本号 — 每次修改 MCP/Skills 后自增，触发侧边栏重新获取 */
export const workspaceCapabilitiesVersionAtom = atom(0)

/** 工作区文件版本号 — 文件变化时自增，触发文件浏览器重新加载 */
export const workspaceFilesVersionAtom = atom(0)

/** CCB 原生 Subagent / Teams / Workflow / Todo 执行图，按会话隔离。 */
export const agentRuntimeExecutionGraphsAtom = atom<
  Map<string, AgentRuntimeExecutionGraph>
>(new Map())

/**
 * 单个 session 的 runtime execution graph 派生 atomFamily — 按 sessionId 切片订阅。
 *
 * 超大会话中可能有数千个 ToolUseBlock；若直接订阅全局 Map，任意 session 的图更新
 * 都会触发全部 tool 组件重渲染。本 family 让订阅者只在本 session 的 graph 引用变化时
 * 重渲染。
 */
export const agentRuntimeExecutionGraphAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(agentRuntimeExecutionGraphsAtom).get(sessionId)),
)

/** 浅比较两个执行节点是否等价（用于 merge 短路与引用稳定）。 */
export function areAgentRuntimeExecutionNodesEqual(
  left: AgentRuntimeExecutionNode,
  right: AgentRuntimeExecutionNode,
): boolean {
  return (
    left.id === right.id
    && left.parentId === right.parentId
    && left.kind === right.kind
    && left.name === right.name
    && left.status === right.status
    && left.description === right.description
    && left.startedAt === right.startedAt
    && left.completedAt === right.completedAt
    && left.toolUseId === right.toolUseId
    && left.transcriptAvailable === right.transcriptAvailable
    && left.summary === right.summary
    && left.model === right.model
    && left.agentType === right.agentType
    && left.teamName === right.teamName
    && left.turnCompletionPolicy === right.turnCompletionPolicy
  )
}

/** 浅比较两个 Todo 项是否等价。 */
function areAgentRuntimeTodoItemsEqual(
  left: AgentRuntimeTodoItem,
  right: AgentRuntimeTodoItem,
): boolean {
  if (
    left.id !== right.id
    || left.content !== right.content
    || left.status !== right.status
    || left.activeForm !== right.activeForm
    || left.owner !== right.owner
  ) {
    return false
  }
  const leftBlocks = left.blocks ?? []
  const rightBlocks = right.blocks ?? []
  if (leftBlocks.length !== rightBlocks.length) return false
  for (let i = 0; i < leftBlocks.length; i += 1) {
    if (leftBlocks[i] !== rightBlocks[i]) return false
  }
  const leftBlockedBy = left.blockedBy ?? []
  const rightBlockedBy = right.blockedBy ?? []
  if (leftBlockedBy.length !== rightBlockedBy.length) return false
  for (let i = 0; i < leftBlockedBy.length; i += 1) {
    if (leftBlockedBy[i] !== rightBlockedBy[i]) return false
  }
  return true
}

/**
 * 判断两份执行图业务内容是否等价（忽略 updatedAt）。
 * 供 merge 短路使用：1s 轮询常返回相同 nodes/todos，即使时间戳推进也不应写回 Map。
 */
export function areAgentRuntimeExecutionGraphsEqual(
  left: AgentRuntimeExecutionGraph,
  right: AgentRuntimeExecutionGraph,
): boolean {
  if (left === right) return true
  if (left.runtimeSessionId !== right.runtimeSessionId) return false
  if (left.nodes.length !== right.nodes.length) return false
  if (left.todos.length !== right.todos.length) return false
  for (let i = 0; i < left.nodes.length; i += 1) {
    if (!areAgentRuntimeExecutionNodesEqual(left.nodes[i]!, right.nodes[i]!)) {
      return false
    }
  }
  for (let i = 0; i < left.todos.length; i += 1) {
    if (!areAgentRuntimeTodoItemsEqual(left.todos[i]!, right.todos[i]!)) {
      return false
    }
  }
  return true
}

/**
 * 合并写入前尽量复用旧 node/todo 引用。
 * 这样按 toolUseId 切片的派生 atom 在节点内容未变时保持 Object.is 相等，避免误伤重渲染。
 */
export function stabilizeAgentRuntimeExecutionGraph(
  existing: AgentRuntimeExecutionGraph | undefined,
  incoming: AgentRuntimeExecutionGraph,
): AgentRuntimeExecutionGraph {
  if (!existing) return incoming
  if (areAgentRuntimeExecutionGraphsEqual(existing, incoming)) return existing

  const previousNodesById = new Map(existing.nodes.map((node) => [node.id, node]))
  let nodesChanged = existing.nodes.length !== incoming.nodes.length
  const nodes = incoming.nodes.map((node, index) => {
    const previous = previousNodesById.get(node.id) ?? existing.nodes[index]
    if (previous && areAgentRuntimeExecutionNodesEqual(previous, node)) {
      return previous
    }
    nodesChanged = true
    return node
  })
  if (!nodesChanged) {
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i] !== existing.nodes[i]) {
        nodesChanged = true
        break
      }
    }
  }

  const previousTodosById = new Map(existing.todos.map((todo) => [todo.id, todo]))
  let todosChanged = existing.todos.length !== incoming.todos.length
  const todos = incoming.todos.map((todo, index) => {
    const previous = previousTodosById.get(todo.id) ?? existing.todos[index]
    if (previous && areAgentRuntimeTodoItemsEqual(previous, todo)) {
      return previous
    }
    todosChanged = true
    return todo
  })
  if (!todosChanged) {
    for (let i = 0; i < todos.length; i += 1) {
      if (todos[i] !== existing.todos[i]) {
        todosChanged = true
        break
      }
    }
  }

  if (
    !nodesChanged
    && !todosChanged
    && existing.runtimeSessionId === incoming.runtimeSessionId
  ) {
    return existing
  }

  return {
    runtimeSessionId: incoming.runtimeSessionId,
    nodes: nodesChanged ? nodes : existing.nodes,
    todos: todosChanged ? todos : existing.todos,
    updatedAt: incoming.updatedAt,
  }
}

/** 构造 session + toolUseId 的 atomFamily key。 */
export function createRuntimeExecutionNodeToolKey(
  sessionId: string,
  toolUseId: string,
): string {
  return `${sessionId}\0${toolUseId}`
}

/**
 * 按 session + toolUseId 订阅单个 runtime 节点。
 * 配合 stabilizeAgentRuntimeExecutionGraph，未变化节点保持引用稳定，避免全量 ToolUseBlock 重渲染。
 */
export const agentRuntimeExecutionNodeByToolUseIdAtomFamily = atomFamily((key: string) =>
  atom((get) => {
    const separator = key.indexOf('\0')
    if (separator < 0) return undefined
    const sessionId = key.slice(0, separator)
    const toolUseId = key.slice(separator + 1)
    if (!sessionId || !toolUseId) return undefined
    const graph = get(agentRuntimeExecutionGraphsAtom).get(sessionId)
    return graph?.nodes.find((node) => node.toolUseId === toolUseId)
  }),
)

const EMPTY_DELEGATION_SESSIONS: AgentSessionMeta[] = []

function areDelegationSessionsEquivalent(
  left: AgentSessionMeta,
  right: AgentSessionMeta,
): boolean {
  return (
    left === right
    || (
      left.id === right.id
      && left.parentSessionId === right.parentSessionId
      && left.sourceDelegationId === right.sourceDelegationId
      && left.title === right.title
      && left.delegationStatus === right.delegationStatus
      && left.delegationGoal === right.delegationGoal
      && left.delegationRole === right.delegationRole
      && left.modelId === right.modelId
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && left.runtimeWorkerState === right.runtimeWorkerState
    )
  )
}

/**
 * 父会话下 collaboration 子会话列表（稳定引用）。
 * 仅委派 UI 订阅，避免普通 tool 块绑定全局 agentSessionsAtom。
 */
export const agentChildDelegationSessionsAtomFamily = atomFamily((parentSessionId: string) => {
  let cached: AgentSessionMeta[] = EMPTY_DELEGATION_SESSIONS
  return atom((get) => {
    const next = get(agentSessionsAtom).filter((session) => (
      session.parentSessionId === parentSessionId
      && !!session.sourceDelegationId
    ))
    if (
      cached.length === next.length
      && cached.every((session, index) => areDelegationSessionsEquivalent(session, next[index]!))
    ) {
      return cached
    }
    cached = next
    return next
  })
})

/** Agent 本轮相对执行前工作树基线产生的文件改动统计，按会话隔离。 */
export const agentTurnChangeStatsAtom = atom<
  Map<string, AgentTurnChangeStats>
>(new Map())

// ===== 侧面板 Atoms =====

/** 侧面板是否打开（全局共享，所有会话共用一个状态） */
export const agentSidePanelOpenAtom = atomWithStorage<boolean>('proma-agent-sidepanel-open', true)

export const AGENT_SIDE_PANEL_MIN_WIDTH = 300
/** 重新打开功能区时的默认宽度；拖拽不再受这个上限限制。 */
export const AGENT_SIDE_PANEL_DEFAULT_WIDTH = 560
/** @deprecated 拖拽不再使用固定最大宽度，请改用窗口剩余空间。 */
export const AGENT_SIDE_PANEL_MAX_WIDTH = AGENT_SIDE_PANEL_DEFAULT_WIDTH

/** 侧面板宽度（全局共享，用户拖拽后持久化） */
export const agentSidePanelWidthAtom = atomWithStorage<number>(
  'proma-agent-sidepanel-width',
  AGENT_SIDE_PANEL_DEFAULT_WIDTH,
)

/** @deprecated 保留以兼容旧代码，但实际所有 session 都读全局 atom */
export const agentSidePanelOpenMapAtom = atom<Map<string, boolean>>(new Map())

export type AgentSidePanelStaticTab =
  | 'browser'
  | 'session'
  | 'workspace'
  | 'changes'
  | 'plan'
  | 'execution'
  | 'chat'

export type AgentExecutionNodeTab = `execution-node:${string}`
export type AgentTerminalTab = `terminal:${string}`
export type BrowserTaskTab = `browser-task:${string}`
export type BrowserInstanceTab = `browser-instance:${string}`

export type AgentSidePanelTab =
  | AgentSidePanelStaticTab
  | AgentExecutionNodeTab
  | AgentTerminalTab
  | BrowserTaskTab
  | BrowserInstanceTab

const EXECUTION_NODE_TAB_PREFIX = 'execution-node:'
const TERMINAL_TAB_PREFIX = 'terminal:'
const BROWSER_TASK_TAB_PREFIX = 'browser-task:'

/** 为执行节点创建独立的右侧动态 Tab ID。 */
export function createAgentExecutionNodeTab(
  nodeId: string,
  runtimeSessionId?: string,
): AgentExecutionNodeTab {
  if (!runtimeSessionId) return `${EXECUTION_NODE_TAB_PREFIX}${nodeId}`
  return `${EXECUTION_NODE_TAB_PREFIX}${encodeURIComponent(runtimeSessionId)}::${encodeURIComponent(nodeId)}`
}

/** 判断右侧动态 Tab 是否为执行节点详情。 */
export function isAgentExecutionNodeTab(tab: AgentSidePanelTab): tab is AgentExecutionNodeTab {
  return tab.startsWith(EXECUTION_NODE_TAB_PREFIX)
}

/** 从执行节点动态 Tab 中还原节点 ID。 */
export function getAgentExecutionNodeId(tab: AgentSidePanelTab): string | null {
  if (!isAgentExecutionNodeTab(tab)) return null
  const value = tab.slice(EXECUTION_NODE_TAB_PREFIX.length)
  const separatorIndex = value.indexOf('::')
  return separatorIndex < 0
    ? value
    : decodeURIComponent(value.slice(separatorIndex + 2))
}

export function createAgentTerminalTab(sessionId: string): AgentTerminalTab {
  return `${TERMINAL_TAB_PREFIX}${sessionId}`
}

export function isAgentTerminalTab(tab: AgentSidePanelTab): tab is AgentTerminalTab {
  return tab.startsWith(TERMINAL_TAB_PREFIX)
}

export function getAgentTerminalSessionId(tab: AgentSidePanelTab): string | null {
  return isAgentTerminalTab(tab)
    ? tab.slice(TERMINAL_TAB_PREFIX.length)
    : null
}

/** 为浏览器任务创建独立的右侧动态 Tab ID。 */
export function createBrowserTaskTab(taskId: string): BrowserTaskTab {
  return `${BROWSER_TASK_TAB_PREFIX}${encodeURIComponent(taskId)}`
}

/** 判断右侧动态 Tab 是否为浏览器任务。 */
export function isBrowserTaskTab(tab: AgentSidePanelTab): tab is BrowserTaskTab {
  return tab.startsWith(BROWSER_TASK_TAB_PREFIX)
}

/** 从浏览器任务 Tab 还原任务 ID。 */
export function getBrowserTaskId(tab: AgentSidePanelTab): string | null {
  return isBrowserTaskTab(tab)
    ? decodeURIComponent(tab.slice(BROWSER_TASK_TAB_PREFIX.length))
    : null
}

const BROWSER_INSTANCE_TAB_PREFIX = 'browser-instance:'

/** 为手动打开的浏览器实例创建唯一动态 Tab ID（可同时打开多个）。 */
export function createBrowserInstanceTab(id: string): BrowserInstanceTab {
  return `${BROWSER_INSTANCE_TAB_PREFIX}${encodeURIComponent(id)}`
}

/** 判断右侧动态 Tab 是否为浏览器实例。 */
export function isBrowserInstanceTab(tab: AgentSidePanelTab): tab is BrowserInstanceTab {
  return tab.startsWith(BROWSER_INSTANCE_TAB_PREFIX)
}

/** 从浏览器实例 Tab 还原实例 ID。 */
export function getBrowserInstanceId(tab: AgentSidePanelTab): string | null {
  return isBrowserInstanceTab(tab)
    ? decodeURIComponent(tab.slice(BROWSER_INSTANCE_TAB_PREFIX.length))
    : null
}

/** 侧面板当前 Tab：会话文件 / 工作区文件 / 文件改动 / Chat（per-session Map） */
export const agentDiffPanelTabAtom = atom<Map<string, AgentSidePanelTab>>(new Map())

/** 右侧功能区已打开的动态 Tabs，按会话隔离并保留打开顺序。 */
export const agentSidePanelTabsAtom = atom<Map<string, AgentSidePanelTab[]>>(new Map())

/** 浏览器实例序号，按会话隔离（每会话从 1 递增，生成唯一 browser-instance Tab）。 */
export const agentBrowserInstanceCounterAtom = atom<Map<string, number>>(new Map())

/** 右侧功能区是否显示默认启动页，按会话隔离。 */
export const agentSidePanelLauncherAtom = atom<Map<string, boolean>>(new Map())

/** 执行详情需要自动定位并展开的节点 ID，按会话隔离。 */
export const agentFocusedExecutionNodeAtom = atom<Map<string, string | null>>(new Map())

export interface AgentExecutionNodeTabSnapshot {
  node: SessionExecutionNode
  runtimeSessionId?: string
}

/** 已打开节点 Tab 的身份与展示快照，避免 Runtime 切换后串到同 ID 的新节点。 */
export const agentExecutionNodeTabSnapshotsAtom = atom<
  Map<string, Map<AgentExecutionNodeTab, AgentExecutionNodeTabSnapshot>>
>(new Map())

export interface AgentTerminalTabSnapshot extends IntegratedTerminalSessionSnapshot {
  title?: string
}

/** 已打开集成终端的会话快照和动态标题，按 Agent 会话隔离。 */
export const agentTerminalTabSnapshotsAtom = atom<
  Map<string, Map<AgentTerminalTab, AgentTerminalTabSnapshot>>
>(new Map())

/** 节点正文缓存；终态节点切换 Tab 后仍可查看已经加载过的完整内容。 */
export const agentExecutionNodeTranscriptCacheAtom = atom<
  Map<string, AgentRuntimeSubagentTranscript>
>(new Map())

/** 用户是否希望显示会话悬浮面板；自动隐藏不会改写该偏好。 */
export const agentFloatingPanelEnabledAtom = atomWithStorage<boolean>(
  'proma-agent-floating-panel-enabled',
  true,
)

/** 用户在空间不足时主动要求强制显示悬浮面板的会话；不持久化。 */
export const agentFloatingPanelForcedSessionsAtom = atom<Set<string>>(new Set<string>())

/** 悬浮面板当前是否实际显示，供顶部开关区分“隐藏”和“被自动隐藏”。 */
export const agentFloatingPanelVisibleSessionsAtom = atom<Set<string>>(new Set<string>())

/** 悬浮面板旧完成计划的签名屏蔽状态；计划显隐统一由生命周期 Atom 决定。 */
export const agentFloatingPanelPlanStatesAtom = atom<
  Map<string, AgentFloatingPanelPlanState>
>(new Map())

/**
 * 当前计划、隐藏的待继续计划及归档计划的统一生命周期状态。
 * 三个计划入口都从这里读取，避免各自使用 session running 推断状态。
 */
export const agentRuntimePlanLifecycleAtom = atom<
  Map<string, AgentRuntimePlanSessionState>
>(new Map())

/** 独立于 SDK 流式状态的悬浮面板轮次标识，软空闲续轮也会更新。 */
export const agentFloatingPanelTurnEpochsAtom = atom<Map<string, number>>(new Map())

export interface BeginAgentFloatingPanelTurnInput {
  sessionId: string
  epoch: number
}

/** 标记一次真正开始发送给模型的新用户轮次。 */
export const beginAgentFloatingPanelTurnAtom = atom(
  null,
  (get, set, input: BeginAgentFloatingPanelTurnInput) => {
    if (get(agentFloatingPanelTurnEpochsAtom).get(input.sessionId) === input.epoch) {
      return
    }
    const graphTodos = get(agentRuntimeExecutionGraphsAtom).get(input.sessionId)?.todos ?? []
    const historyTodos = get(agentSidePanelRuntimeHistoryAtom)
      .get(input.sessionId)?.todos ?? []
    const todos = graphTodos.length > 0 ? graphTodos : historyTodos
    const nextPlanState = advanceFloatingPanelPlanState({
      turnEpoch: input.epoch,
      todos,
    })

    set(agentFloatingPanelTurnEpochsAtom, (previous) => {
      const next = new Map(previous)
      next.set(input.sessionId, input.epoch)
      return next
    })
    set(agentFloatingPanelPlanStatesAtom, (previous) => {
      const next = new Map(previous)
      next.set(input.sessionId, nextPlanState)
      return next
    })
    set(agentRuntimePlanLifecycleAtom, (previous) => {
      const next = new Map(previous)
      const current = previous.get(input.sessionId)
      const seeded = current ?? applyRuntimePlanGraph(
        undefined,
        todos,
        Date.now(),
      )
      next.set(
        input.sessionId,
        beginRuntimePlanTurn(
          seeded,
          input.epoch,
          Date.now(),
        ),
      )
      return next
    })
  },
)

export const activateAgentRuntimePlanTodoAtom = atom(
  null,
  (_get, set, input: { sessionId: string; todoId: string }) => {
    set(agentRuntimePlanLifecycleAtom, (previous) => {
      const current = previous.get(input.sessionId)
      const updated = activateRuntimePlanTodo(
        current,
        input.todoId,
        Date.now(),
      )
      if (updated === current || updated == null) return previous
      const next = new Map(previous)
      next.set(input.sessionId, updated)
      return next
    })
  },
)

export const interruptAgentRuntimePlanAtom = atom(
  null,
  (_get, set, sessionId: string) => {
    set(agentRuntimePlanLifecycleAtom, (previous) => {
      const current = previous.get(sessionId)
      const updated = interruptRuntimePlan(current, Date.now())
      if (updated === current || updated == null) return previous
      const next = new Map(previous)
      next.set(sessionId, updated)
      return next
    })
  },
)

export interface AgentFloatingPanelExecutionNodeState {
  node: SessionExecutionNode
  expiresAt: number
}

/**
 * 悬浮面板正在短暂展示的执行节点终态。
 * 到期后直接删除记录，不保留历史隐藏节点，也不删除执行详情或子会话数据。
 */
export const agentFloatingPanelExecutionNodeStatesAtom = atom<
  Map<string, Map<string, AgentFloatingPanelExecutionNodeState>>
>(new Map())

export interface AgentSidePanelRuntimeHistory {
  /** 快照所属 Runtime；新的非空 Runtime 到达时整体替换旧 Runtime 数据。 */
  runtimeSessionId?: string
  /** 最近一次非空计划；执行图清空时仍供已打开的“计划”Tab 查看。 */
  todos: AgentRuntimeTodoItem[]
  /** CCB 原生节点完整快照；Collaboration 子会话继续从会话元数据实时投影。 */
  nodes: SessionExecutionNode[]
  updatedAt: number
}

/**
 * 右侧“计划 / 子智能体”Tab 的会话级历史快照。
 *
 * 与悬浮面板的短暂终态展示分离：执行图重置或悬浮节点消失时，
 * 已打开的右侧列表与节点详情仍保留完整数据和最终状态。
 */
export const agentSidePanelRuntimeHistoryAtom = atom<
  Map<string, AgentSidePanelRuntimeHistory>
>(new Map())

export interface MergeAgentRuntimeExecutionGraphInput {
  sessionId: string
  graph: AgentRuntimeExecutionGraph
  /** 查询发起时看到的 Runtime ID；期间已切换 Runtime 时丢弃旧响应。 */
  baseRuntimeSessionId?: string | null
}

/** 统一合并执行图，避免异步查询覆盖更新的实时事件，并同步捕获 CCB 节点终态。 */
export const mergeAgentRuntimeExecutionGraphAtom = atom(
  null,
  (get, set, input: MergeAgentRuntimeExecutionGraphInput) => {
    const existing = get(agentRuntimeExecutionGraphsAtom).get(input.sessionId)
    if (
      input.baseRuntimeSessionId !== undefined
      && (existing?.runtimeSessionId ?? null) !== input.baseRuntimeSessionId
    ) {
      return
    }
    if (
      existing
      && existing.runtimeSessionId === input.graph.runtimeSessionId
      && existing.updatedAt > input.graph.updatedAt
    ) {
      return
    }
    // 业务内容完全相同（忽略 updatedAt）时短路：轮询与重复事件不应写回 Map / 级联副作用。
    if (existing && areAgentRuntimeExecutionGraphsEqual(existing, input.graph)) {
      return
    }

    const graph = stabilizeAgentRuntimeExecutionGraph(existing, input.graph)
    // stabilize 可能在仅时间戳变化时直接返回 existing
    if (graph === existing) {
      return
    }

    const historyBeforeMerge = get(agentSidePanelRuntimeHistoryAtom)
      .get(input.sessionId)
    const previousNodes = new Map<string, AgentRuntimeExecutionNode>(
      (historyBeforeMerge?.nodes ?? []).map((node) => [node.id, node]),
    )
    for (const node of existing?.nodes ?? []) {
      previousNodes.set(node.id, node)
    }
    const completionBaseTime = Date.now()
    // 权威快照（updatedAt > 0）下，把已从实时图消失但仍 running 的历史节点收敛为 stopped。
    const finalizedHistoryNodes = finalizeOrphanedRuntimeExecutionNodes(
      Array.from(previousNodes.values()),
      graph.nodes,
      {
        graphUpdatedAt: graph.updatedAt,
        completedAt: completionBaseTime,
      },
    )
    const terminalTransitions = [
      ...graph.nodes.filter((node) => {
        const previous = previousNodes.get(node.id)
        return (
          previous != null
          && (previous.status === 'queued' || previous.status === 'running')
          && isFloatingExecutionNodeTerminal(node)
        )
      }),
      ...finalizedHistoryNodes.filter((node) => {
        const previous = previousNodes.get(node.id)
        return (
          previous != null
          && (previous.status === 'queued' || previous.status === 'running')
          && isFloatingExecutionNodeTerminal(node)
          && !graph.nodes.some((live) => live.id === node.id)
        )
      }),
    ]

    set(agentRuntimeExecutionGraphsAtom, (previous) => {
      const next = new Map(previous)
      next.set(input.sessionId, graph)
      return next
    })

    set(agentRuntimePlanLifecycleAtom, (previous) => {
      const current = previous.get(input.sessionId)
      const updated = applyRuntimePlanGraph(
        current,
        graph.todos,
        Date.now(),
      )
      if (updated === current || updated == null) return previous
      const next = new Map(previous)
      next.set(input.sessionId, updated)
      return next
    })

    set(agentSidePanelRuntimeHistoryAtom, (previous) => {
      const current = previous.get(input.sessionId)
      const runtimeChanged = (
        graph.runtimeSessionId != null
        && current?.runtimeSessionId != null
        && graph.runtimeSessionId !== current.runtimeSessionId
      )
      const hasRuntimeData = graph.nodes.length > 0 || graph.todos.length > 0
      const base = runtimeChanged && hasRuntimeData ? undefined : current
      const nodes = new Map(
        finalizeOrphanedRuntimeExecutionNodes(
          base?.nodes ?? [],
          graph.nodes,
          {
            graphUpdatedAt: graph.updatedAt,
            completedAt: completionBaseTime,
          },
        ).map((node) => [node.id, node]),
      )
      for (const node of graph.nodes) {
        nodes.set(node.id, { ...node, source: 'runtime' })
      }

      const next = new Map(previous)
      next.set(input.sessionId, {
        runtimeSessionId: graph.runtimeSessionId ?? base?.runtimeSessionId,
        todos: graph.todos.length > 0
          ? graph.todos
          : (base?.todos ?? []),
        nodes: Array.from(nodes.values()),
        updatedAt: Math.max(base?.updatedAt ?? 0, graph.updatedAt),
      })
      return next
    })

    set(agentFloatingPanelPlanStatesAtom, (previous) => {
      const current = previous.get(input.sessionId)
      const suppressedSignature = current?.suppressedCompletedPlanSignature
      if (!current || !suppressedSignature || graph.todos.length === 0) {
        return previous
      }
      // 新一轮开始后的空图只是 Runtime 重置过程，不能据此让上一轮已完成计划重新出现。
      // 只有观察到内容或状态确实不同的新计划后，才解除旧计划签名的屏蔽。
      if (createFloatingPlanSignature(graph.todos) === suppressedSignature) {
        return previous
      }
      const next = new Map(previous)
      next.set(input.sessionId, {
        ...current,
        suppressedCompletedPlanSignature: undefined,
      })
      return next
    })

    if (terminalTransitions.length > 0) {
      set(agentFloatingPanelExecutionNodeStatesAtom, (previous) => {
        const next = new Map(previous)
        const sessionStates = new Map(previous.get(input.sessionId) ?? [])
        terminalTransitions.forEach((node, index) => {
          sessionStates.set(node.id, {
            node: { ...node, source: 'runtime' },
            expiresAt: (
              completionBaseTime
              + FLOATING_EXECUTION_NODE_COMPLETION_DELAY_MS
              + index * FLOATING_EXECUTION_NODE_COMPLETION_STAGGER_MS
            ),
          })
        })
        next.set(input.sessionId, sessionStates)
        return next
      })
    }
  },
)

export interface AgentSessionGitSummary {
  repoStatus: GitRepoStatus | null
  filesChanged: number
  additions: number
  deletions: number
  updatedAt: number
}

/** 会话悬浮面板使用的 Git 环境与总变更摘要缓存。 */
export const agentSessionGitSummaryAtom = atom<Map<string, AgentSessionGitSummary>>(new Map())

export interface OpenAgentSidePanelTabInput {
  sessionId: string
  tab: AgentSidePanelTab
  focusedExecutionNodeId?: string | null
  executionNodeSnapshot?: AgentExecutionNodeTabSnapshot
  terminalSnapshot?: AgentTerminalTabSnapshot
}

export interface ReorderAgentSidePanelTabsInput {
  sessionId: string
  source: AgentSidePanelTab
  target: AgentSidePanelTab
}

/** 从右上角按钮打开右侧功能区：已有 Tabs 原样恢复，没有 Tabs 时显示启动页。 */
export const openAgentSidePanelLauncherAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const wasOpen = get(agentSidePanelOpenAtom)
    const openTabs = get(agentSidePanelTabsAtom).get(sessionId) ?? []
    const activeTab = get(agentDiffPanelTabAtom).get(sessionId)

    if (!wasOpen) {
      set(agentSidePanelWidthAtom, AGENT_SIDE_PANEL_DEFAULT_WIDTH)
    }
    set(agentSidePanelOpenAtom, true)
    set(agentSidePanelLauncherAtom, (previous) => {
      const next = new Map(previous)
      next.set(sessionId, openTabs.length === 0)
      return next
    })
    const fallbackTab = openTabs[0]
    if (fallbackTab && (!activeTab || !openTabs.includes(activeTab))) {
      set(agentDiffPanelTabAtom, (previous) => {
        const next = new Map(previous)
        next.set(sessionId, fallbackTab)
        return next
      })
    }
  },
)

/** 收起整个右侧功能区；已打开 Tabs、激活项和节点定位状态继续保留。 */
export const closeAgentSidePanelAtom = atom(
  null,
  (_get, set, _sessionId: string) => {
    set(agentSidePanelOpenAtom, false)
  },
)

/** 关闭单个动态 Tab；关闭最后一个后自动返回默认启动页。 */
export const closeAgentSidePanelTabAtom = atom(
  null,
  (get, set, input: OpenAgentSidePanelTabInput) => {
    const currentTabs = get(agentSidePanelTabsAtom).get(input.sessionId) ?? []
    const closedIndex = currentTabs.indexOf(input.tab)
    if (closedIndex < 0) return
    const nextTabs = currentTabs.filter((tab) => tab !== input.tab)

    set(agentSidePanelTabsAtom, (previous) => {
      const next = new Map(previous)
      next.set(input.sessionId, nextTabs)
      return next
    })

    if (input.tab === 'execution' || isAgentExecutionNodeTab(input.tab)) {
      set(agentFocusedExecutionNodeAtom, (previous) => {
        if (!previous.has(input.sessionId)) return previous
        const next = new Map(previous)
        next.delete(input.sessionId)
        return next
      })
    }
    if (isAgentExecutionNodeTab(input.tab)) {
      const executionNodeTab = input.tab
      set(agentExecutionNodeTabSnapshotsAtom, (previous) => {
        const sessionSnapshots = previous.get(input.sessionId)
        if (!sessionSnapshots?.has(executionNodeTab)) return previous
        const next = new Map(previous)
        const nextSessionSnapshots = new Map(sessionSnapshots)
        nextSessionSnapshots.delete(executionNodeTab)
        if (nextSessionSnapshots.size > 0) next.set(input.sessionId, nextSessionSnapshots)
        else next.delete(input.sessionId)
        return next
      })
    }
    if (isAgentTerminalTab(input.tab)) {
      const terminalTab = input.tab
      set(agentTerminalTabSnapshotsAtom, (previous) => {
        const sessionSnapshots = previous.get(input.sessionId)
        if (!sessionSnapshots?.has(terminalTab)) return previous
        const next = new Map(previous)
        const nextSessionSnapshots = new Map(sessionSnapshots)
        nextSessionSnapshots.delete(terminalTab)
        if (nextSessionSnapshots.size > 0) next.set(input.sessionId, nextSessionSnapshots)
        else next.delete(input.sessionId)
        return next
      })
    }

    if (nextTabs.length === 0) {
      set(agentSidePanelLauncherAtom, (previous) => {
        const next = new Map(previous)
        next.set(input.sessionId, true)
        return next
      })
      set(agentDiffPanelTabAtom, (previous) => {
        if (!previous.has(input.sessionId)) return previous
        const next = new Map(previous)
        next.delete(input.sessionId)
        return next
      })
      return
    }

    const activeTab = get(agentDiffPanelTabAtom).get(input.sessionId)
    if (activeTab === input.tab || !activeTab || !nextTabs.includes(activeTab)) {
      const nextActiveTab = nextTabs[Math.min(closedIndex, nextTabs.length - 1)]
      if (!nextActiveTab) return
      set(agentDiffPanelTabAtom, (previous) => {
        const next = new Map(previous)
        next.set(input.sessionId, nextActiveTab)
        return next
      })
    }
  },
)

/** 调整动态 Tabs 的顺序并按会话保存。 */
export const reorderAgentSidePanelTabsAtom = atom(
  null,
  (get, set, input: ReorderAgentSidePanelTabsInput) => {
    if (input.source === input.target) return
    const current = get(agentSidePanelTabsAtom).get(input.sessionId) ?? []
    const sourceIndex = current.indexOf(input.source)
    const targetIndex = current.indexOf(input.target)
    if (sourceIndex < 0 || targetIndex < 0) return
    const reordered = [...current]
    reordered.splice(sourceIndex, 1)
    reordered.splice(targetIndex, 0, input.source)
    set(agentSidePanelTabsAtom, (previous) => {
      const next = new Map(previous)
      next.set(input.sessionId, reordered)
      return next
    })
  },
)

/**
 * 统一打开右侧功能 Tab。
 *
 * 悬浮面板、文件预览和侧边问答都通过该入口写入状态，
 * 避免只切换 activeTab 却没有把 Tab 加入动态列表。
 */
export const openAgentSidePanelTabAtom = atom(
  null,
  (get, set, input: OpenAgentSidePanelTabInput) => {
    if (!get(agentSidePanelOpenAtom)) {
      set(agentSidePanelWidthAtom, AGENT_SIDE_PANEL_DEFAULT_WIDTH)
    }
    set(agentSidePanelOpenAtom, true)
    set(agentSidePanelLauncherAtom, (previous) => {
      const next = new Map(previous)
      next.set(input.sessionId, false)
      return next
    })
    set(agentSidePanelTabsAtom, (previous) => {
      const current = previous.get(input.sessionId) ?? []
      if (current.includes(input.tab)) return previous
      const next = new Map(previous)
      next.set(input.sessionId, [...current, input.tab])
      return next
    })
    set(agentDiffPanelTabAtom, (previous) => {
      const next = new Map(previous)
      next.set(input.sessionId, input.tab)
      return next
    })
    if (input.tab === 'execution') {
      set(agentFocusedExecutionNodeAtom, (previous) => {
        const next = new Map(previous)
        next.set(input.sessionId, input.focusedExecutionNodeId ?? null)
        return next
      })
    }
    if (isAgentExecutionNodeTab(input.tab) && input.executionNodeSnapshot) {
      const executionNodeTab = input.tab
      set(agentExecutionNodeTabSnapshotsAtom, (previous) => {
        const next = new Map(previous)
        const sessionSnapshots = new Map(previous.get(input.sessionId) ?? [])
        sessionSnapshots.set(executionNodeTab, input.executionNodeSnapshot!)
        next.set(input.sessionId, sessionSnapshots)
        return next
      })
    }
    if (isAgentTerminalTab(input.tab) && input.terminalSnapshot) {
      const terminalTab = input.tab
      set(agentTerminalTabSnapshotsAtom, (previous) => {
        const next = new Map(previous)
        const sessionSnapshots = new Map(previous.get(input.sessionId) ?? [])
        sessionSnapshots.set(terminalTab, input.terminalSnapshot!)
        next.set(input.sessionId, sessionSnapshots)
        return next
      })
    }
  },
)

/** Diff 视图模式：'split' | 'unified'，默认使用统一预览 */
export const agentDiffViewModeAtom = atom<'split' | 'unified'>('unified')

/** Diff 刷新版本号 — 按 session 隔离，Agent 写工具完成时递增 */
export const agentDiffRefreshVersionAtom = atom(new Map<string, number>())

/** 当前会话选中的 worktree 路径，null = 默认行为（显示 session 改动） */
export const agentSelectedWorktreeAtom = atom(new Map<string, string | null>())

/** 是否有未查看的代码改动 — 按 session 隔离 */
export const agentDiffUnseenChangesAtom = atom(new Map<string, boolean>())

/** Agent 本轮刚修改但用户尚未查看的文件路径 — 按 session 隔离，Map<sessionId, Set<filePath>> */
export const agentDiffUnseenFilesAtom = atom(new Map<string, Set<string>>())

/**
 * Diff 数据缓存 — 按 session 隔离，存放上一次 IPC 拉取到的未暂存改动结果。
 *
 * 让 DiffChangesList 切走再切回时能立即拿到旧数据渲染（SWR 模式），
 * 避免 mount 时空数组误命中"没有代码改动"分支造成 ~1s 闪烁。
 * 数据新鲜度由 [[agentDiffRefreshVersionAtom]] 触发的后台 fetch 维护，无 TTL。
 */
export const agentDiffDataAtom = atom(new Map<string, UnstagedChangesResult>())

/** 当前会话的侧面板是否打开（派生只读：全局共享，但仅在有当前会话且为 Agent 模式时显示） */
export const currentSessionSidePanelOpenAtom = atom<boolean>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return false
  return get(agentSidePanelOpenAtom)
})

/** 当前会话的工作路径 Map — sessionId → path */
export const agentSessionPathMapAtom = atom<Map<string, string>>(new Map())

/**
 * 文件浏览器主动定位信号：仅由用户操作（例如点击文件搜索结果）设置。
 * FileBrowser 实例订阅后，若路径落在自身 rootPath 下则展开祖先、滚动并高亮。
 * Agent 写文件不得设置该 atom，避免执行期间影响用户的右侧 Tab 与文件树视口。
 * `ts` 用于触发同路径的二次脉冲（atom 比对引用）。
 */
export interface FileBrowserAutoReveal {
  sessionId: string
  path: string
  ts: number
}
export const fileBrowserAutoRevealAtom = atom<FileBrowserAutoReveal | null>(null)

/**
 * 最近被 Agent 修改的文件路径（per-session，path → 修改时间戳 ms）。
 * FileBrowser 据此在文件行左侧渲染标记，60s 后自动消失。
 */
export const recentlyModifiedPathsAtom = atom<Map<string, Map<string, number>>>(new Map())

export interface MarkAgentFileModifiedInput {
  sessionId: string
  path: string
  modifiedAt: number
}

/**
 * 记录 Agent 最近修改的文件。
 *
 * 该动作只更新标记，不触碰右侧面板开关、动态 Tabs 或文件浏览器定位信号。
 */
export const markAgentFileModifiedAtom = atom(
  null,
  (_get, set, input: MarkAgentFileModifiedInput) => {
    set(recentlyModifiedPathsAtom, (previous) => {
      const next = new Map(previous)
      const sessionPaths = new Map(next.get(input.sessionId) ?? new Map())
      sessionPaths.set(input.path, input.modifiedAt)
      next.set(input.sessionId, sessionPaths)
      return next
    })
  },
)

/** 最近修改标记的存活时间（毫秒） */
export const RECENTLY_MODIFIED_TTL_MS = 60_000

// ===== 权限系统 Atoms =====

/** 新会话默认权限模式 */
export const agentDefaultPermissionModeAtom = atom<PromaPermissionMode>(PROMA_DEFAULT_PERMISSION_MODE)

/** Per-session 权限模式 Map — sessionId → PromaPermissionMode */
export const agentPermissionModeMapAtom = atom<Map<string, PromaPermissionMode>>(new Map())

/**
 * 按 sessionId 派生该 session 的持久化权限模式。
 * 返回 `undefined`（session 不存在或未设置）或具体的 PromaPermissionMode 字符串，
 * jotai 用 === 比较，只有值真正变化时才通知下游——避免流式中无关字段更新引发 re-render。
 */
export const sessionPersistedPermissionModeAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const sessions = get(agentSessionsAtom)
    return sessions.find((s) => s.id === sessionId)?.permissionMode
  }),
)

/** 按 sessionId 派生持久化的独立计划模式开关。 */
export const sessionPersistedPlanModeEnabledAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const sessions = get(agentSessionsAtom)
    return sessions.find((s) => s.id === sessionId)?.planModeEnabled === true
  }),
)

/** 按 sessionId 派生该 session 是否存在于列表中（冷启动判断用） */
export const sessionExistsAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const sessions = get(agentSessionsAtom)
    return sessions.some((s) => s.id === sessionId)
  }),
)

/** Agent 思考模式：未加载持久化设置前也默认开启，避免输入栏按钮短暂显示为关闭。 */
export const agentThinkingAtom = atom<ThinkingConfig | undefined>({ type: 'adaptive' })

/** Agent 思考强度；会按当前模型能力自动归一化。 */
export const agentThinkingEffortLevelAtom = atom<ThinkingEffortLevel | undefined>(undefined)

/** 会话级思考强度覆盖；max 等临时档位不会污染全局持久化偏好。 */
export const agentSessionThinkingEffortMapAtom = atom<Map<string, ThinkingEffortLevel>>(new Map())

/** Agent 最大预算（美元/次） */
export const agentMaxBudgetUsdAtom = atom<number | undefined>(undefined)

/** Agent 最大轮次 */
export const agentMaxTurnsAtom = atom<number | undefined>(undefined)

/** 待处理的权限请求 Map — 以 sessionId 为 key，切换会话时保留状态 */
export const allPendingPermissionRequestsAtom = atom<Map<string, readonly PermissionRequest[]>>(new Map())

type PermissionRequestsUpdate = readonly PermissionRequest[] | ((prev: readonly PermissionRequest[]) => readonly PermissionRequest[])

/** 当前会话的权限请求队列（派生读写原子） */
export const pendingPermissionRequestsAtom = atom(
  (get): readonly PermissionRequest[] => {
    const currentId = get(currentAgentSessionIdAtom)
    if (!currentId) return []
    return get(allPendingPermissionRequestsAtom).get(currentId) ?? []
  },
  (get, set, update: PermissionRequestsUpdate) => {
    const currentId = get(currentAgentSessionIdAtom)
    if (!currentId) return
    set(allPendingPermissionRequestsAtom, (prev) => {
      const map = new Map(prev)
      const current = map.get(currentId) ?? []
      const newValue = typeof update === 'function' ? update(current) : update
      if (newValue.length === 0) map.delete(currentId)
      else map.set(currentId, newValue)
      return map
    })
  }
)

/** 待处理的 AskUser 请求 Map — 以 sessionId 为 key，切换会话时保留状态 */
export const allPendingAskUserRequestsAtom = atom<Map<string, readonly AskUserRequest[]>>(new Map())

/** AskUser 单题答案草稿 */
export interface AskUserQuestionDraft {
  selected: string[]
  customText: string
  showCustom: boolean
}

/** AskUser 请求级草稿 — 以 requestId 为 key，组件卸载后仍保留 */
export interface AskUserRequestDraft {
  activeTab: number
  focusedOptIdx: number
  answers: Map<number, AskUserQuestionDraft>
}

/** 待提交 AskUser 草稿 Map — 以 requestId 为 key，切换预览/会话时保留填写进度 */
export const askUserDraftsAtom = atom<Map<string, AskUserRequestDraft>>(new Map())

type AskUserRequestsUpdate = readonly AskUserRequest[] | ((prev: readonly AskUserRequest[]) => readonly AskUserRequest[])

/** 当前会话的 AskUser 请求队列（派生读写原子） */
export const pendingAskUserRequestsAtom = atom(
  (get): readonly AskUserRequest[] => {
    const currentId = get(currentAgentSessionIdAtom)
    if (!currentId) return []
    return get(allPendingAskUserRequestsAtom).get(currentId) ?? []
  },
  (get, set, update: AskUserRequestsUpdate) => {
    const currentId = get(currentAgentSessionIdAtom)
    if (!currentId) return
    set(allPendingAskUserRequestsAtom, (prev) => {
      const map = new Map(prev)
      const current = map.get(currentId) ?? []
      const newValue = typeof update === 'function' ? update(current) : update
      if (newValue.length === 0) map.delete(currentId)
      else map.set(currentId, newValue)
      return map
    })
  }
)

/** 待处理的 ExitPlanMode 请求 Map — 以 sessionId 为 key */
export const allPendingExitPlanRequestsAtom = atom<Map<string, readonly ExitPlanModeRequest[]>>(new Map())

/** 当前处于 Plan 模式的会话 ID 集合 */
export const agentPlanModeSessionsAtom = atom<Set<string>>(new Set<string>())

export const currentAgentSessionAtom = atom<AgentSessionMeta | null>((get) => {
  const sessions = get(agentSessionsAtom)
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return null
  return sessions.find((s) => s.id === currentId) ?? null
})

export const agentStreamingAtom = atom<boolean>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return false
  return get(agentStreamingStatesAtom).get(currentId)?.running ?? false
})

export const agentStreamingContentAtom = atom<string>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return ''
  return get(agentStreamingStatesAtom).get(currentId)?.content ?? ''
})

export const agentToolActivitiesAtom = atom<ToolActivity[]>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return []
  return get(agentStreamingStatesAtom).get(currentId)?.toolActivities ?? []
})

export const agentStreamingModelAtom = atom<string | undefined>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return undefined
  return get(agentStreamingStatesAtom).get(currentId)?.model
})

export const agentRetryingAtom = atom<AgentStreamState['retrying'] | undefined>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return undefined
  return get(agentStreamingStatesAtom).get(currentId)?.retrying
})

export const agentStartedAtAtom = atom<number | undefined>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return undefined
  return get(agentStreamingStatesAtom).get(currentId)?.startedAt
})

export const agentRunningSessionIdsAtom = atom<Set<string>>((get) => {
  const states = get(agentStreamingStatesAtom)
  const ids = new Set<string>()
  for (const [id, state] of states) {
    if (state.running) ids.add(id)
  }
  return ids
})

/** 侧边栏会话指示点状态 */
export type SessionIndicatorStatus = 'idle' | 'running' | 'blocked' | 'completed'

/** 已完成但用户尚未查看的会话 ID 集合 */
export const unviewedCompletedSessionIdsAtom = atom<Set<string>>(new Set<string>())

let lastIndicatorSignature = ''
let lastIndicatorMap = new Map<string, SessionIndicatorStatus>()

function getStableIndicatorMap(entries: Array<[string, SessionIndicatorStatus]>): Map<string, SessionIndicatorStatus> {
  entries.sort(([a], [b]) => a.localeCompare(b))
  const signature = entries.map(([id, status]) => `${id}:${status}`).join('|')
  if (signature === lastIndicatorSignature) return lastIndicatorMap
  lastIndicatorSignature = signature
  lastIndicatorMap = new Map(entries)
  return lastIndicatorMap
}

/** Dock/Launcher 角标数量：未查看完成会话 + 待处理阻塞请求 */
export const dockBadgeCountAtom = atom<number>((get) => {
  return calculateDockBadgeCount({
    unviewedCompletedCount: get(unviewedCompletedSessionIdsAtom).size,
    pendingPermissionCount: countPendingRequests(get(allPendingPermissionRequestsAtom)),
    pendingAskUserCount: countPendingRequests(get(allPendingAskUserRequestsAtom)),
    pendingExitPlanCount: countPendingRequests(get(allPendingExitPlanRequestsAtom)),
  })
})

/**
 * 每个会话的指示点状态（只包含非 idle 的会话）
 * 优先级：blocked > running > completed > idle
 */
export const agentSessionIndicatorMapAtom = atom<Map<string, SessionIndicatorStatus>>((get) => {
  const streamStates = get(agentStreamingStatesAtom)
  const pendingPerms = get(allPendingPermissionRequestsAtom)
  const pendingAskUser = get(allPendingAskUserRequestsAtom)
  const pendingExitPlan = get(allPendingExitPlanRequestsAtom)
  const unviewedCompleted = get(unviewedCompletedSessionIdsAtom)

  const map = new Map<string, SessionIndicatorStatus>()

  for (const [id, state] of streamStates) {
    if (!state.running) continue
    const hasBlock = (pendingPerms.get(id)?.length ?? 0) > 0
      || (pendingAskUser.get(id)?.length ?? 0) > 0
      || (pendingExitPlan.get(id)?.length ?? 0) > 0
    map.set(id, hasBlock ? 'blocked' : 'running')
  }

  for (const id of unviewedCompleted) {
    if (!map.has(id)) {
      map.set(id, 'completed')
    }
  }

  return getStableIndicatorMap(Array.from(map.entries()))
})

/**
 * 处理 AgentEvent 并更新流式状态（纯函数）
 */
export function applyAgentEvent(
  prev: AgentStreamState,
  event: AgentEvent,
): AgentStreamState {
  switch (event.type) {
    case 'text_delta':
      // 开始接收文本 - 清除重试状态（重试成功）
      return { ...prev, content: prev.content + event.text, retrying: undefined }

    case 'text_complete':
      // 用完整文本替换增量累积的文本（用于回放场景：只需 text_complete 即可重建文本状态）
      return { ...prev, content: event.text }

    case 'tool_start': {
      const existing = prev.toolActivities.find((t) => t.toolUseId === event.toolUseId)
      if (existing) {
        return {
          ...prev,
          toolActivities: prev.toolActivities.map((t) =>
            t.toolUseId === event.toolUseId
              ? { ...t, input: event.input, intent: event.intent || t.intent, displayName: event.displayName || t.displayName }
              : t
          ),
          // 开始工具调用 - 清除重试状态（重试成功）
          retrying: undefined,
        }
      }
      return {
        ...prev,
        toolActivities: [...prev.toolActivities, {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          intent: event.intent,
          displayName: event.displayName,
          done: false,
          parentToolUseId: event.parentToolUseId,
        }],
        // 开始工具调用 - 清除重试状态（重试成功）
        retrying: undefined,
      }
    }

    case 'tool_result':
      return {
        ...prev,
        toolActivities: prev.toolActivities.map((t) =>
          t.toolUseId === event.toolUseId
            ? { ...t, result: event.result, isError: event.isError, done: true, imageAttachments: event.imageAttachments }
            : t
        ),
      }

    case 'task_backgrounded':
      return {
        ...prev,
        toolActivities: prev.toolActivities.map((t) =>
          t.toolUseId === event.toolUseId
            ? { ...t, isBackground: true, taskId: event.taskId, done: true }
            : t
        ),
      }

    case 'task_progress':
      // 普通 tool 计时语义（仅当有真实 elapsedSeconds 时更新）
      if (event.elapsedSeconds != null) {
        return {
          ...prev,
          toolActivities: prev.toolActivities.map((t) =>
            t.toolUseId === event.toolUseId
              ? { ...t, elapsedSeconds: event.elapsedSeconds! }
              : t
          ),
        }
      }
      return prev

    case 'task_started': {
      // 查找匹配 toolUseId 的 ToolActivity，更新 intent 和 taskId
      let nextActivities = prev.toolActivities
      if (event.toolUseId) {
        if (prev.toolActivities.some((t) => t.toolUseId === event.toolUseId)) {
          nextActivities = prev.toolActivities.map((t) =>
            t.toolUseId === event.toolUseId
              ? { ...t, intent: event.description, taskId: event.taskId }
              : t
          )
        }
      }
      return { ...prev, toolActivities: nextActivities }
    }

    case 'shell_backgrounded':
      return {
        ...prev,
        toolActivities: prev.toolActivities.map((t) =>
          t.toolUseId === event.toolUseId
            ? { ...t, isBackground: true, shellId: event.shellId, done: true }
            : t
        ),
      }

    case 'shell_killed':
      return prev

    case 'task_notification':
      return prev

    case 'thinking_tokens':
      return {
        ...prev,
        thinkingEstimatedTokens: event.estimatedTokens,
      }

    case 'tool_use_summary':
      // 工具使用摘要 — 目前不影响流式状态，仅用于 UI 展示
      return prev

    case 'complete': {
      // 成功完成 — 清除 retrying，但保持 running: true
      // 等待 STREAM_COMPLETE IPC 回调通过删除流式状态来控制 UI 就绪状态
      // 这避免了用户在后端尚未完成清理时就能发送新消息的竞态条件
      // 同时将未完成的工具活动标记为 done（兜底）
      //
      // token 计数（inputTokens / 缓存 / outputTokens）默认只信任流式中每条 assistant
      // 消息的 usage_update：单条模型调用的 input+缓存 ≈ 当轮完整 prompt = 当前真实上下文。
      // SDK 的 result.usage 是整个 query 内所有模型调用的累计求和（cache_read 会被累加 N 次），
      // 直接覆盖会让进度环虚高、冲破 100%（PR #821 修的正是这个问题）。
      //
      // 但 GLM-5.2 等走 Anthropic 兼容端点的渠道，流式 assistant 消息不携带 usage 字段，
      // 真实值只在 result 中返回。若完全不用 result.usage，这些渠道的 ContextUsageBadge
      // 永远停留在 inputTokens=0 不显示。
      //
      // 折中：仅当「整个 query 期间从未收到流式 usage_update」（prev.inputTokens 为空/0）
      // 才从 result.usage 兜底写入 token 字段；已有流式真实值时不动。
      // - contextWindow：取流式与 result 的较大值（result 未必更权威——多 entry 时
      //   子 Agent 的小窗口可能拉低值，Fix 1/2 已从源头取 max，此处作为安全网）。
      // - costUsd：始终覆盖（本就该是整轮累计成本）
      const needResultFallback = !prev.inputTokens || prev.inputTokens <= 0 || prev.contextUsageIsEstimated === true
      const shouldUseResultUsage = needResultFallback
        && event.usage?.inputTokens != null
        && (event.usage.inputTokens > 0 || prev.contextUsageIsEstimated !== true)
      // 会话累计（缓存命中率）：仅在兜底场景（流式从未上报 usage）累加一次，
      // 避免与流式 usage_update 的累计重复；result.usage 是整 query 累计值，
      // 净输入 = totalInput - cacheRead - cacheCreation（对齐 opencode adjusted input）。
      const fallbackCacheRead = event.usage?.cacheReadTokens ?? 0
      const fallbackCacheCreation = event.usage?.cacheCreationTokens ?? 0
      const fallbackTotalInput = event.usage?.inputTokens ?? 0
      const fallbackNetInput = fallbackTotalInput > 0 ? Math.max(0, fallbackTotalInput - fallbackCacheRead - fallbackCacheCreation) : 0
      return {
        ...prev,
        ...(shouldUseResultUsage && {
          cumulativeInputTokens: (prev.cumulativeInputTokens ?? 0) + fallbackNetInput,
          cumulativeCacheReadTokens: (prev.cumulativeCacheReadTokens ?? 0) + fallbackCacheRead,
          cumulativeCacheCreationTokens: (prev.cumulativeCacheCreationTokens ?? 0) + fallbackCacheCreation,
        }),
        ...(event.usage ? {
          ...(event.usage.costUsd != null && { costUsd: event.usage.costUsd }),
          ...(event.usage.contextWindow != null && {
            contextWindow: prev.contextWindow != null
              ? Math.max(prev.contextWindow, event.usage.contextWindow)
              : event.usage.contextWindow,
          }),
          ...(shouldUseResultUsage && {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheReadTokens,
            cacheCreationTokens: event.usage.cacheCreationTokens,
            contextUsageIsEstimated: false,
          }),
        } : {}),
        retrying: undefined,
        ...finalizeStreamingActivities(prev.toolActivities),
      }
    }

    case 'run_resumed':
      // 后台任务完成自动唤醒：从"空闲可输入"恢复到运行态（防御性，监听器已显式处理）。
      return { ...prev, running: true, backgroundWaiting: false }

    case 'typed_error':
      // 处理类型化错误（TypedError）
      // 停止运行，清除重试状态
      return {
        ...prev,
        running: false,
        retrying: undefined,
        ...(prev.isCompacting && {
          isCompacting: false,
          contextCompaction: {
            status: 'failed' as const,
            trigger: prev.contextCompaction?.trigger,
            message: event.error.message,
          },
        }),
      }

    case 'error':
      // 改进：error 事件不再清除 retrying 状态
      // retrying 状态由专用事件控制
      return {
        ...prev,
        running: false,
        ...(prev.isCompacting && {
          isCompacting: false,
          contextCompaction: {
            status: 'failed' as const,
            trigger: prev.contextCompaction?.trigger,
            message: event.message,
          },
        }),
      }

    case 'usage_update': {
      // Pi 的 message_start/流式快照可能携带全零 usage，此时尚未拿到用量，
      // 不能把压缩前的有效值或压缩后的估算值清空。窗口和费用仍可独立更新。
      const hasTokenUsage = [
        event.usage.inputTokens,
        event.usage.outputTokens,
        event.usage.cacheReadTokens,
        event.usage.cacheCreationTokens,
      ].some((value) => value != null && value > 0)
      // 会话累计（缓存命中率）：event.usage.inputTokens 是含缓存的整轮 totalInput，
      // 净输入 = totalInput - cacheRead - cacheCreation（对齐 opencode adjusted input）。
      const cacheRead = event.usage.cacheReadTokens ?? 0
      const cacheCreation = event.usage.cacheCreationTokens ?? 0
      const totalInput = event.usage.inputTokens ?? 0
      const netInputDelta = totalInput > 0 ? Math.max(0, totalInput - cacheRead - cacheCreation) : 0
      const cumulativeInputTokens = (prev.cumulativeInputTokens ?? 0) + (event.usage.inputTokens != null ? netInputDelta : 0)
      const cumulativeCacheReadTokens = (prev.cumulativeCacheReadTokens ?? 0) + (event.usage.cacheReadTokens != null ? cacheRead : 0)
      const cumulativeCacheCreationTokens = (prev.cumulativeCacheCreationTokens ?? 0) + (event.usage.cacheCreationTokens != null ? cacheCreation : 0)
      return {
        ...prev,
        ...(hasTokenUsage && event.usage.inputTokens != null && {
          inputTokens: event.usage.inputTokens,
          contextUsageIsEstimated: false,
        }),
        ...(hasTokenUsage && event.usage.outputTokens != null && { outputTokens: event.usage.outputTokens }),
        ...(hasTokenUsage && event.usage.cacheReadTokens != null && { cacheReadTokens: event.usage.cacheReadTokens }),
        ...(hasTokenUsage && event.usage.cacheCreationTokens != null && { cacheCreationTokens: event.usage.cacheCreationTokens }),
        cumulativeInputTokens,
        cumulativeCacheReadTokens,
        cumulativeCacheCreationTokens,
        ...(event.usage.costUsd != null && { costUsd: event.usage.costUsd }),
        // contextWindow 取 max：本分支同时承载「流式 assistant 消息按模型名推断的窗口」
        // 与「后端从 SDK result 透传的真实窗口（context_window 事件）」两个来源。
        // 模型窗口在同一会话内不会缩小，取更大值可兼顾两类端点——既不会让推断偏小的
        // 端点（如 GLM 剥掉 [1m] 后缀）挡住真实的 1M，也不会让回报偏小的端点覆盖正确的 1M。
        ...(event.usage.contextWindow && {
          contextWindow: Math.max(prev.contextWindow ?? 0, event.usage.contextWindow),
        }),
      }
    }

    case 'compacting':
      return {
        ...prev,
        isCompacting: true,
        contextCompaction: { status: 'running', trigger: event.trigger },
      }

    case 'compact_complete': {
      const contextCompaction = {
        status: prev.stopping && event.status === 'failed' ? 'stopped' as const : event.status,
        trigger: event.trigger,
        summary: event.summary,
        message: event.message,
        preTokens: event.preTokens,
        postTokens: event.estimatedTokensAfter,
      }
      if (event.estimatedTokensAfter == null) {
        return { ...prev, isCompacting: false, contextCompaction }
      }
      return {
        ...prev,
        isCompacting: false,
        contextCompaction,
        inputTokens: event.estimatedTokensAfter,
        outputTokens: undefined,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        contextUsageIsEstimated: true,
      }
    }

    case 'context_compaction_config':
      return {
        ...prev,
        autoCompactEnabled: event.autoCompactEnabled,
        autoCompactThreshold: event.autoCompactThreshold,
        effectiveContextWindow: event.effectiveContextWindow,
      }

    case 'model_resolved':
      // 不用 SDK 返回的实际模型名覆盖，保持用户选择的 modelId
      // 以确保 resolveModelDisplayName 能匹配到渠道配置的显示名
      return prev

    case 'retrying':
      // 向后兼容：保留原有的简单 retrying 事件
      return {
        ...prev,
        retrying: prev.retrying ?? {
          currentAttempt: event.attempt,
          maxAttempts: event.maxAttempts,
          history: [],
          failed: false,
        },
      }

    case 'retry_attempt': {
      // 新增：记录详细的重试尝试
      const currentHistory = prev.retrying?.history ?? []
      return {
        ...prev,
        retrying: {
          currentAttempt: event.attemptData.attempt,
          maxAttempts: prev.retrying?.maxAttempts ?? 3,
          history: [...currentHistory, event.attemptData],
          failed: false,
        },
      }
    }

    case 'retry_cleared':
      // 新增：重试成功，清除状态
      return { ...prev, retrying: undefined }

    case 'retry_failed': {
      // 新增：重试失败，标记为 failed 但保留历史
      const finalHistory = prev.retrying?.history ?? []
      return {
        ...prev,
        running: false,
        retrying: {
          currentAttempt: event.finalAttempt.attempt,
          maxAttempts: prev.retrying?.maxAttempts ?? 3,
          history: [...finalHistory, event.finalAttempt],
          failed: true,
        },
      }
    }

    case 'permission_request':
      // 权限请求事件由 PermissionBanner 处理，不影响流式状态
      return prev

    case 'permission_resolved':
      // 权限解决事件由 PermissionBanner 处理，不影响流式状态
      return prev

    case 'ask_user_request':
      // AskUser 请求事件由 AskUserBanner 处理，不影响流式状态
      return prev

    case 'ask_user_resolved':
      // AskUser 解决事件由 AskUserBanner 处理，不影响流式状态
      return prev

    case 'prompt_suggestion':
      // 提示建议由全局监听器处理，不影响流式状态
      return prev

    default:
      return prev
  }
}

/** 上下文使用量状态 */
export interface AgentContextStatus {
  isCompacting: boolean
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** 会话累计净输入 tokens（不含缓存） */
  cumulativeInputTokens?: number
  /** 会话累计缓存读取 tokens（用于计算缓存命中率） */
  cumulativeCacheReadTokens?: number
  /** 会话累计缓存写入 tokens */
  cumulativeCacheCreationTokens?: number
  costUsd?: number
  contextWindow?: number
  /** 当前上下文 token 是否为 CCB 压缩后的估算值 */
  contextUsageIsEstimated?: boolean
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  effectiveContextWindow?: number
}

/** 当前会话的上下文使用量派生 atom */
export const agentContextStatusAtom = atom<AgentContextStatus>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return { isCompacting: false }
  const state = get(agentStreamingStatesAtom).get(currentId)
  return {
    isCompacting: state?.isCompacting ?? false,
    inputTokens: state?.inputTokens,
    outputTokens: state?.outputTokens,
    cacheReadTokens: state?.cacheReadTokens,
    cacheCreationTokens: state?.cacheCreationTokens,
    cumulativeInputTokens: state?.cumulativeInputTokens,
    cumulativeCacheReadTokens: state?.cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens: state?.cumulativeCacheCreationTokens,
    costUsd: state?.costUsd,
    contextWindow: state?.contextWindow,
    contextUsageIsEstimated: state?.contextUsageIsEstimated,
    autoCompactEnabled: state?.autoCompactEnabled,
    autoCompactThreshold: state?.autoCompactThreshold,
    effectiveContextWindow: state?.effectiveContextWindow,
  }
})

/**
 * Agent 流式错误消息 Map — 以 sessionId 为 key
 * 错误发生时写入，下次发送或手动关闭时清除
 */
export const agentStreamErrorsAtom = atom<Map<string, string>>(new Map())

/**
 * Agent 消息刷新版本 Map — 以 sessionId 为 key
 * 全局监听器在流式完成/错误时递增版本号，
 * AgentView 监听版本号变化来重新加载消息。
 */
export const agentMessageRefreshAtom = atom<Map<string, number>>(new Map())

/**
 * 持久化 SDKMessage 的内存缓存 Map — 以 sessionId 为 key
 * 用于消除「切换会话时先清空 → 等待 IPC 全量读盘」的可见空窗：
 * 命中缓存可立即填充消息区，IPC 返回后再覆盖为最新数据。
 *
 * 内存安全：缓存条目随会话数增长会无限膨胀（长会话的消息数组很大），
 * 因此通过 setSessionMessagesCache 做 LRU 淘汰，仅保留最近访问的
 * AGENT_MSG_CACHE_MAX 个会话；会话删除时也需主动剔除对应条目。
 */
export const AGENT_MSG_CACHE_MAX = 20
export const agentSDKMessagesCacheAtom = atom<Map<string, SDKMessage[]>>(new Map())

/**
 * 写入会话消息缓存并执行 LRU 淘汰。
 * 利用 JS Map 的插入顺序：删除已存在的 key 再重新 set，使其移到「最新」位置；
 * 超出上限时从头部（最旧）删除，直到回到上限内。返回新的 Map（不可变更新）。
 */
export function setSessionMessagesCache(
  prev: Map<string, SDKMessage[]>,
  sessionId: string,
  messages: SDKMessage[],
): Map<string, SDKMessage[]> {
  const next = new Map(prev)
  next.delete(sessionId)
  next.set(sessionId, messages)
  while (next.size > AGENT_MSG_CACHE_MAX) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

/** 当前 Agent 会话的错误消息（派生只读原子） */
export const currentAgentErrorAtom = atom<string | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return null
  return get(agentStreamErrorsAtom).get(currentId) ?? null
})

/**
 * Agent 会话输入框草稿 Map — 以 sessionId 为 key
 * 用于在切换会话时保留输入框内容
 */
export const agentSessionDraftsAtom = atom<Map<string, string>>(new Map())

/** 单个 session 的 markdown 草稿派生 atom — 按 sessionId 切片订阅 */
export const agentSessionDraftAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(agentSessionDraftsAtom).get(sessionId) ?? ''),
)

/**
 * Agent 会话输入框 HTML 草稿 Map — 以 sessionId 为 key
 * 保存 TipTap 编辑器的原始 HTML，用于切换会话时恢复 mention 等富文本节点
 */
export const agentSessionDraftHtmlAtom = atom<Map<string, string>>(new Map())

/** 单个 session 的 HTML 草稿派生 atom — 按 sessionId 切片订阅 */
export const agentSessionDraftHtmlAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(agentSessionDraftHtmlAtom).get(sessionId) ?? ''),
)

/**
 * 会话可访问目录 Map — 以 sessionId 为 key
 * 存储每个会话通过“添加访问目录”关联的外部目录路径列表。
 * 这些路径作为 CCB additionalDirectories 参数传递。
 */
export const agentAttachedDirectoriesMapAtom = atom<Map<string, string[]>>(new Map())

/**
 * 会话附加文件 Map — 以 sessionId 为 key
 * 存储每个会话通过"附加文件"功能关联的外部文件路径列表。
 */
export const agentAttachedFilesMapAtom = atom<Map<string, string[]>>(new Map())

/**
 * 工作区级附加目录列表（按 workspaceId 存储）
 *
 * 工作区内所有会话共享这些附加目录。
 */
export const workspaceAttachedDirectoriesMapAtom = atom<Map<string, string[]>>(new Map())

/**
 * 工作区级附加文件列表（按 workspaceId 存储）
 *
 * 工作区内所有会话共享这些附加文件。
 */
export const workspaceAttachedFilesMapAtom = atom<Map<string, string[]>>(new Map())

/** 当前 Agent 会话的草稿内容（派生读写原子） */
export const currentAgentSessionDraftAtom = atom(
  (get) => {
    const currentId = get(currentAgentSessionIdAtom)
    if (!currentId) return ''
    return get(agentSessionDraftsAtom).get(currentId) ?? ''
  },
  (get, set, newDraft: string) => {
    const currentId = get(currentAgentSessionIdAtom)
    if (!currentId) return
    set(agentSessionDraftsAtom, (prev) => {
      const map = new Map(prev)
      if (newDraft.trim() === '') {
        map.delete(currentId)
      } else {
        map.set(currentId, newDraft)
      }
      return map
    })
  }
)

// ===== 提示建议 Atoms =====

/** Agent 提示建议 Map — 以 sessionId 为 key，存储最近一条建议 */
export const agentPromptSuggestionsAtom = atom<Map<string, string>>(new Map())

/** 当前 Agent 会话的提示建议（派生只读原子） */
export const currentAgentSuggestionAtom = atom<string | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom)
  if (!currentId) return null
  return get(agentPromptSuggestionsAtom).get(currentId) ?? null
})

// ===== 后台任务管理 =====

/**
 * 后台任务数据结构
 *
 * 用于 ActiveTasksBar 显示运行中的 Agent 任务和 Shell 任务。
 */
export interface BackgroundTask {
  /** 任务或 Shell ID */
  id: string
  /** 任务类型 */
  type: 'agent' | 'shell'
  /** 关联的工具调用 ID（用于滚动定位到实时工具调用） */
  toolUseId: string
  /** 任务开始时间戳 */
  startTime: number
  /** 已耗时（秒） */
  elapsedSeconds: number
  /** 任务意图/描述 */
  intent?: string
}

/**
 * 后台任务列表原子家族
 *
 * 按 sessionId 隔离，每个会话独立管理后台任务。
 * 任务完成后从列表中移除（只显示运行中任务）。
 */
export const backgroundTasksAtomFamily = atomFamily((sessionId: string) =>
  atom<BackgroundTask[]>([])
)

// ===== 用户打断状态 =====

/** 被用户手动打断的会话集合（仅当前 streaming 周期有效，reload 后清除） */
export const stoppedByUserSessionsAtom = atom<Set<string>>(new Set<string>())

// ===== 初始化就绪状态 =====

/** AgentSettingsInitializer 是否已完成加载（渠道/工作区/设置全部就绪） */
export const agentSettingsReadyAtom = atom(false)
