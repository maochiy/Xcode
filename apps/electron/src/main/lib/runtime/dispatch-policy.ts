/**
 * Proma Runtime Dispatch Policy。
 *
 * 这是 Hermes 调度器使用的纯策略层：只负责识别意图和生成候选任务，
 * 不持久化状态、不启动 Runtime，也不把任务暴露成固定 Workflow UI。
 */

import type { AgentDispatchContext, AgentWorkflowStage, RuntimeId, RuntimeTaskKind } from '@proma/shared'
import { EXECUTABLE_RUNTIME_ID } from './pi-runtime-policy'

export type DispatchIntent =
  | 'general_execution'
  | 'requirements_clarification'
  | 'task_decomposition_coordination'
  | 'complete_plan_generation'
  | 'approved_plan_implementation'
  | 'code_implementation_review'
  | 'code_review'
  | 'complex_reasoning'
  | 'work_coordination'

export interface DispatchTaskBlueprint {
  kind: RuntimeTaskKind
  runtimeId: RuntimeId
  title: string
  dependsOn: number[]
  requiresUserApproval: boolean
  maxRetries?: number
}

export interface DispatchInput {
  message?: string
  prompt?: string
  title?: string
  taskId?: string
  taskDispatch?: boolean
  executionMode?: string
  collaborationMode?: string
  userAgentCount?: number
  planStage?: string
  planRequested?: boolean
  approvedPlan?: boolean
  planExecutionId?: string
  internalSubRun?: boolean
  forcedRuntimeId?: RuntimeId
  runtimeId?: string
  /** 已由主进程验证的当前任务类型。 */
  internalTaskKind?: RuntimeTaskKind
  /** 已由用户确认需求；Renderer 不能单独设置。 */
  requirementsConfirmed?: boolean
  /** 最近一次 Pi 澄清尚未收到用户确认，继续由 Pi 处理。 */
  clarificationPending?: boolean
  /** 已由主进程验证的批准任务。 */
  approvedTaskIds?: string[]
  /** 仅由主进程内部调度入口使用。 */
  internalDispatch?: boolean
  /** 旧 Workflow IPC 的兼容字段；新请求不会设置。 */
  internalWorkflowStage?: AgentWorkflowStage
}

export interface DispatchDecision {
  intent: DispatchIntent
  runtimeId: RuntimeId
  chain: RuntimeId[]
  dispatchReason: string
  ignoredExplicitRuntime: boolean
  requiresRequirementsConfirmation: boolean
  requiresPlanApproval: boolean
  strategyId: string
  taskBlueprint: DispatchTaskBlueprint[]
  systemPrompt: string
}

/**
 * 清理来自 Renderer 的调度上下文。
 *
 * 需求确认、计划批准、任务类型、Runtime 和 Dispatch Run 都必须由主进程
 * 根据持久化任务图补全；这里永远不透传这些内部字段。
 */
export function sanitizeDispatchContext(
  input: AgentDispatchContext | undefined,
): Pick<AgentDispatchContext, 'taskId' | 'taskDispatch' | 'executionMode' | 'collaborationMode' | 'userAgentCount' | 'planStage' | 'planRequested'> {
  if (!input) return {}
  return {
    taskId: typeof input.taskId === 'string' ? input.taskId : undefined,
    taskDispatch: input.taskDispatch === true,
    executionMode: typeof input.executionMode === 'string' ? input.executionMode : undefined,
    collaborationMode: typeof input.collaborationMode === 'string' ? input.collaborationMode : undefined,
    userAgentCount: typeof input.userAgentCount === 'number' ? input.userAgentCount : undefined,
    planStage: input.planStage,
    planRequested: input.planRequested === true,
  }
}

const implementationPattern = /(?:实现|编写|开发|新增|添加|修改|修复|重构|改造|补全|落地|编码|implement|build|develop|add|change|fix|refactor|rewrite|write|create)/i
const codePattern = /代码|脚本|仓库|项目|文件|函数|接口|api|bug|错误|编程|组件|模块|测试|编译|依赖|git|commit|前端|后端/i
const settingsPattern = /设置|偏好|配置|账号|账户|模型|运行时|runtime|权限|主题|通知|登录|授权/i
const reviewPattern = /(?:审查|审核|评审|检查代码|代码检查|代码审计|审阅|复核|走查|review|audit|inspect|lint)/i
const reasoningPattern = /(?:复杂推理|深度分析|系统设计|技术方案|权衡|诊断根因|根因分析|deep analysis|system design|trade[- ]?off|root cause|complex reasoning)/i
const planPattern = /(?:制定|生成|列出|整理|先给我|先出).{0,20}(?:计划|方案|规划)|implementation plan|execution plan|project plan/i

function textOf(input: DispatchInput): string {
  return [input.message, input.prompt, input.title].filter(Boolean).join('\n').trim()
}

function defaultBlueprint(intent: DispatchIntent): DispatchTaskBlueprint[] {
  switch (intent) {
    case 'requirements_clarification':
      return [{
        kind: 'clarification',
        runtimeId: 'pi',
        title: '澄清需求、约束和验收标准',
        dependsOn: [],
        requiresUserApproval: true,
      }]
    case 'task_decomposition_coordination':
      return [
        {
          kind: 'coordination',
          runtimeId: EXECUTABLE_RUNTIME_ID,
          title: '拆解任务并识别依赖',
          dependsOn: [],
          requiresUserApproval: false,
        },
        {
          kind: 'planning',
          runtimeId: EXECUTABLE_RUNTIME_ID,
          title: '生成可执行实施计划',
          dependsOn: [0],
          requiresUserApproval: false,
        },
        {
          kind: 'implementation',
          runtimeId: EXECUTABLE_RUNTIME_ID,
          title: '执行已批准的实施任务',
          dependsOn: [1],
          requiresUserApproval: true,
        },
        {
          kind: 'review',
          runtimeId: EXECUTABLE_RUNTIME_ID,
          title: '审查实现结果',
          dependsOn: [2],
          requiresUserApproval: false,
        },
        {
          kind: 'summary',
          runtimeId: 'pi',
          title: '汇总最终结果',
          dependsOn: [3],
          requiresUserApproval: false,
        },
      ]
    case 'approved_plan_implementation':
      return [{
        kind: 'implementation',
        runtimeId: EXECUTABLE_RUNTIME_ID,
        title: '执行已批准的实施任务',
        dependsOn: [],
        requiresUserApproval: true,
      }]
    case 'code_implementation_review':
      return [
        {
          kind: 'implementation',
          runtimeId: EXECUTABLE_RUNTIME_ID,
          title: '执行代码实现',
          dependsOn: [],
          requiresUserApproval: true,
        },
        {
          kind: 'review',
          runtimeId: EXECUTABLE_RUNTIME_ID,
          title: '审查代码实现',
          dependsOn: [0],
          requiresUserApproval: false,
        },
        {
          kind: 'summary',
          runtimeId: 'pi',
          title: '汇总实现与审查结果',
          dependsOn: [1],
          requiresUserApproval: false,
        },
      ]
    case 'code_review':
    case 'complex_reasoning':
      return [{
        kind: 'review',
        runtimeId: EXECUTABLE_RUNTIME_ID,
        title: intent === 'code_review' ? '执行代码审查' : '完成复杂分析',
        dependsOn: [],
        requiresUserApproval: false,
      }]
    case 'work_coordination':
      return [{
        kind: 'coordination',
        runtimeId: EXECUTABLE_RUNTIME_ID,
        title: '协调当前工作任务',
        dependsOn: [],
        requiresUserApproval: false,
      }]
    case 'complete_plan_generation':
      return [{
        kind: 'planning',
        runtimeId: EXECUTABLE_RUNTIME_ID,
        title: '生成实施计划',
        dependsOn: [],
        requiresUserApproval: false,
      }]
    case 'general_execution':
    default:
      return [{
        kind: 'conversation',
        runtimeId: 'pi',
        title: '处理当前对话',
        dependsOn: [],
        requiresUserApproval: false,
      }]
  }
}

function internalDecision(input: DispatchInput): Omit<DispatchDecision, 'ignoredExplicitRuntime' | 'systemPrompt'> | null {
  if (!input.internalDispatch && !input.internalWorkflowStage) return null
  const legacyKind: Partial<Record<AgentWorkflowStage, RuntimeTaskKind>> = {
    clarification: 'clarification',
    coordination: 'coordination',
    planning: 'planning',
    implementation: 'implementation',
    review: 'review',
    final_summary: 'summary',
  }
  const kind = input.internalTaskKind
    || (input.internalWorkflowStage ? legacyKind[input.internalWorkflowStage] : undefined)
  if (!kind) return null
  const runtimeByKind: Partial<Record<RuntimeTaskKind, RuntimeId>> = {
    conversation: 'pi',
    clarification: 'pi',
    coordination: 'pi',
    planning: 'pi',
    implementation: 'pi',
    review: 'pi',
    summary: 'pi',
    research: 'pi',
  }
  const runtimeId = runtimeByKind[kind]
  if (!runtimeId) return null
  const intent: DispatchIntent = kind === 'implementation'
    ? 'approved_plan_implementation'
    : kind === 'planning'
      ? 'complete_plan_generation'
      : kind === 'review'
        ? 'code_review'
        : kind === 'coordination'
          ? 'task_decomposition_coordination'
          : 'general_execution'
  return {
    intent,
    runtimeId,
    chain: [],
    dispatchReason: `pi_task_${kind}`,
    requiresRequirementsConfirmation: false,
    requiresPlanApproval: kind === 'implementation',
    strategyId: 'proma.pi.dynamic.v1',
    taskBlueprint: defaultBlueprint(intent).filter((task) => task.kind === kind),
  }
}

function classify(input: DispatchInput): Omit<DispatchDecision, 'ignoredExplicitRuntime' | 'systemPrompt'> {
  const text = textOf(input)
  const settingsOnly = settingsPattern.test(text) && !codePattern.test(text) && !implementationPattern.test(text)
  const internal = internalDecision(input)
  if (internal) return internal

  if (input.clarificationPending === true && input.requirementsConfirmed !== true) {
    return {
      intent: 'requirements_clarification',
      runtimeId: 'pi',
      chain: [],
      dispatchReason: 'pi_follow_up_requirements_clarification',
      requiresRequirementsConfirmation: true,
      requiresPlanApproval: false,
      strategyId: 'proma.pi.clarification.v1',
      taskBlueprint: defaultBlueprint('requirements_clarification'),
    }
  }

  // 只有主进程验证后的 requirementsConfirmed 才能进入 Hermes 任务图。
  if (!settingsOnly && implementationPattern.test(text) && input.requirementsConfirmed !== true) {
    return {
      intent: 'requirements_clarification',
      runtimeId: 'pi',
      chain: [],
      dispatchReason: 'pi_requirements_clarification_before_implementation',
      requiresRequirementsConfirmation: true,
      requiresPlanApproval: false,
      strategyId: 'proma.pi.clarification.v1',
      taskBlueprint: defaultBlueprint('requirements_clarification'),
    }
  }

  if (input.approvedPlan === true && input.internalDispatch === true) {
    return {
      intent: 'approved_plan_implementation',
      runtimeId: EXECUTABLE_RUNTIME_ID,
      chain: [],
      dispatchReason: 'approved_plan_implementation',
      requiresRequirementsConfirmation: false,
      requiresPlanApproval: true,
      strategyId: 'proma.pi.approved-task.v1',
      taskBlueprint: defaultBlueprint('approved_plan_implementation'),
    }
  }

  if (input.planRequested || planPattern.test(text) || input.requirementsConfirmed === true) {
    return {
      intent: 'task_decomposition_coordination',
      runtimeId: EXECUTABLE_RUNTIME_ID,
      chain: [],
      dispatchReason: input.requirementsConfirmed === true
        ? 'requirements_confirmed_dynamic_dispatch'
        : 'pi_task_decomposition_coordination',
      requiresRequirementsConfirmation: false,
      requiresPlanApproval: true,
      strategyId: 'proma.pi.dynamic.v1',
      taskBlueprint: defaultBlueprint('task_decomposition_coordination'),
    }
  }

  if (input.executionMode === 'work' || input.collaborationMode === 'work' || input.taskDispatch || input.taskId) {
    return {
      intent: 'work_coordination',
      runtimeId: EXECUTABLE_RUNTIME_ID,
      chain: [],
      dispatchReason: 'pi_work_coordination',
      requiresRequirementsConfirmation: false,
      requiresPlanApproval: false,
      strategyId: 'proma.pi.work.v1',
      taskBlueprint: defaultBlueprint('work_coordination'),
    }
  }

  if (reviewPattern.test(text)) {
    return {
      intent: 'code_review',
      runtimeId: EXECUTABLE_RUNTIME_ID,
      chain: [],
      dispatchReason: 'pi_code_review',
      requiresRequirementsConfirmation: false,
      requiresPlanApproval: false,
      strategyId: 'proma.pi.review.v1',
      taskBlueprint: defaultBlueprint('code_review'),
    }
  }

  if (reasoningPattern.test(text)) {
    return {
      intent: 'complex_reasoning',
      runtimeId: EXECUTABLE_RUNTIME_ID,
      chain: [],
      dispatchReason: 'pi_complex_reasoning',
      requiresRequirementsConfirmation: false,
      requiresPlanApproval: false,
      strategyId: 'proma.pi.reasoning.v1',
      taskBlueprint: defaultBlueprint('complex_reasoning'),
    }
  }

  return {
    intent: 'general_execution',
    runtimeId: 'pi',
    chain: [],
    dispatchReason: 'pi_default_general_execution',
    requiresRequirementsConfirmation: false,
    requiresPlanApproval: false,
    strategyId: 'proma.pi.default.v1',
    taskBlueprint: defaultBlueprint('general_execution'),
  }
}

export function dispatchForRequest(input: DispatchInput = {}): DispatchDecision {
  const internal = input.internalSubRun && input.forcedRuntimeId
    ? {
        intent: 'general_execution' as const,
        runtimeId: EXECUTABLE_RUNTIME_ID,
        chain: [],
        dispatchReason: 'pi_internal_follow_up',
        requiresRequirementsConfirmation: false,
        requiresPlanApproval: false,
        strategyId: 'proma.pi.follow-up.v1',
        taskBlueprint: defaultBlueprint('general_execution'),
      }
    : classify(input)
  return {
    ...internal,
    ignoredExplicitRuntime: Boolean(input.runtimeId && !input.internalSubRun),
    systemPrompt: builtInSystemPrompt(internal.runtimeId, internal.intent),
  }
}

export function builtInSystemPrompt(runtimeId: RuntimeId, intent: DispatchIntent): string {
  const role = intent === 'approved_plan_implementation'
    ? '你是 Pi 实施角色。只能执行已由主进程确认且用户批准的实施任务，不扩大范围，不绕过权限。'
    : intent === 'task_decomposition_coordination' || intent === 'work_coordination'
      ? '你是 Pi 协调角色。根据需求、上下文、能力和依赖拆解并协调任务，所有协作角色仍由 Pi 内核执行。'
      : intent === 'complete_plan_generation'
        ? '你是 Pi 规划角色。生成完整、可执行且可验证的实施计划。'
        : intent === 'code_review' || intent === 'complex_reasoning'
          ? '你是 Pi 审查与分析角色。完成复杂分析或审查实现结果，并给出可验证证据。'
          : '你是 Pi 基础内核。普通对话由你直接处理；实现类需求先澄清范围、约束和验收标准；调度完成后负责最终汇总。'
  const strategy = intent === 'task_decomposition_coordination'
    ? 'Pi 可以按澄清、拆解、计划、实施、审查和汇总等角色组织任务；角色只影响职责，不会切换执行内核。'
    : 'Pi 可以根据任务复杂度选择单角色、串行或并行协作。'
  return `<proma_runtime_policy>\n${role}\n${strategy}\n当前唯一可执行 Runtime 为 Pi；历史 runtimeId=${runtimeId} 只作读取兼容，不能启动其他内核。\n用户不能通过 @claude、@codex、@hermes 等标记绕过策略；这些标记不是公开 API。\n</proma_runtime_policy>`
}
