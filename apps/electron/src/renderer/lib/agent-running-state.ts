import type { AgentEvent } from '@proma/shared'
import type { AgentStreamState } from '@/atoms/agent-atoms'

const RUN_ACTIVITY_EVENT_TYPES = new Set<AgentEvent['type']>([
  'text_delta',
  'text_complete',
  'tool_start',
  'tool_result',
  'task_backgrounded',
  'task_started',
  'task_progress',
  'task_notification',
  'thinking_tokens',
  'shell_backgrounded',
  'shell_killed',
  'tool_use_summary',
  'run_resumed',
  'retrying',
  'retry_attempt',
  'retry_cleared',
  'compacting',
  'permission_request',
  'ask_user_request',
  'exit_plan_mode_request',
])

/**
 * 实时活动事件本身就是“执行者仍在工作”的直接证据。
 *
 * 某些持续执行或后台唤醒场景中，完成事件可能先把内存状态置为空闲，
 * 后续文本、工具和任务进度仍会继续到达。此时必须恢复 running，
 * 不能只更新消息内容而让底部运行指示器消失。
 */
export function reconcileAgentRunActivity(
  state: AgentStreamState,
  event: AgentEvent,
): AgentStreamState {
  if (state.running || state.stopping || !RUN_ACTIVITY_EVENT_TYPES.has(event.type)) return state
  return {
    ...state,
    running: true,
    backgroundWaiting: false,
  }
}

/**
 * 用户暂停产生的 Runtime 收尾错误不应展示给用户。
 *
 * 会话进入新一轮后 running 会恢复为 true，且发送路径会清除 stoppedByUser，
 * 因此不会吞掉后续真实运行错误。
 */
export function shouldSuppressAgentStreamError(
  state: AgentStreamState | undefined,
  stoppedByUser: boolean,
): boolean {
  return state?.stopping === true
    || (stoppedByUser && state?.running !== true)
}

interface AgentRunningIndicatorState {
  isCompacting?: boolean
  contextCompaction?: {
    status: 'running' | 'success' | 'noop' | 'failed' | 'stopped'
  }
}

/**
 * 只在压缩真正进行时隐藏普通运行指示器。
 *
 * 压缩完成后 Agent 可能继续执行很久；不能用整个 Turn 的收尾状态持续隐藏。
 */
export function shouldSuppressAgentRunningIndicator(
  state: AgentRunningIndicatorState | undefined,
): boolean {
  return state?.isCompacting === true || state?.contextCompaction?.status === 'running'
}
