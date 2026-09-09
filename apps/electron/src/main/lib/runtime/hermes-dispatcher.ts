/**
 * Hermes 动态调度器。
 *
 * Hermes 只管理任务图和执行生命周期，不向渲染进程暴露 Workflow 状态机。
 * 具体 Runtime 的启动仍由 RuntimeAdapterRouter 完成，任务产物通过 JSON/JSONL
 * 之外的轻量 JSON 状态保存，便于重启后恢复和审计。
 */

import { randomUUID } from 'node:crypto'
import type {
  DispatchPlan,
  DispatchRun,
  DispatchRunStatus,
  RuntimeExecutionRequest,
  RuntimeTask,
  RuntimeTaskArtifact,
  RuntimeTaskGraph,
  RuntimeTaskKind,
  RuntimeTaskStatus,
} from '@proma/shared'
import { getRuntimeDispatchRunsPath } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { dispatchForRequest, type DispatchDecision, type DispatchInput } from './dispatch-policy'
import { EXECUTABLE_RUNTIME_ID } from './pi-runtime-policy'

export interface DispatchStore {
  runs: DispatchRun[]
  updatedAt: number
}

export interface DispatchStoreAdapter {
  read: () => DispatchStore
  write: (store: DispatchStore) => void
}

export interface CreateDispatchRunInput {
  sessionId: string
  workspaceId?: string
  prompt: string
  decision?: DispatchDecision
  dispatchInput?: DispatchInput
}

export interface DispatchTaskUpdate {
  result?: string
  error?: string
  timeout?: boolean
}

let storeAdapter: DispatchStoreAdapter | undefined

function defaultStoreAdapter(): DispatchStoreAdapter {
  return {
    read: () => {
      const store = readJsonFileSafe<Partial<DispatchStore>>(getRuntimeDispatchRunsPath())
      return {
        runs: Array.isArray(store?.runs) ? store.runs : [],
        updatedAt: typeof store?.updatedAt === 'number' ? store.updatedAt : 0,
      }
    },
    write: (store) => writeJsonFileAtomic(getRuntimeDispatchRunsPath(), {
      runs: store.runs,
      updatedAt: Date.now(),
    }),
  }
}

export function setDispatchStoreAdapter(adapter: DispatchStoreAdapter | undefined): void {
  storeAdapter = adapter
}

function readStore(): DispatchStore {
  const adapter = (storeAdapter ??= defaultStoreAdapter())
  const stored = adapter.read()
  const migrated = migrateDispatchStoreToPi(stored)
  if (migrated !== stored) adapter.write(migrated)
  return migrated
}

function writeStore(store: DispatchStore): void {
  ;(storeAdapter ??= defaultStoreAdapter()).write(store)
}

function now(): number {
  return Date.now()
}

function harnessIdFor(): RuntimeTask['harnessId'] {
  return EXECUTABLE_RUNTIME_ID
}

/**
 * 读取旧任务图时把 runtimeId/harnessId 迁移为 Pi。
 *
 * 任务 kind、依赖、审批和状态保持不变，只有可执行内核标识被收敛。
 */
export function migrateDispatchStoreToPi(store: DispatchStore): DispatchStore {
  let changed = false
  const runs = store.runs.map((run) => {
    const tasks = run.plan.graph.tasks.map((task) => {
      if (
        task.runtimeId === EXECUTABLE_RUNTIME_ID
        && task.harnessId === EXECUTABLE_RUNTIME_ID
      ) {
        return task
      }
      changed = true
      return {
        ...task,
        runtimeId: EXECUTABLE_RUNTIME_ID,
        harnessId: EXECUTABLE_RUNTIME_ID,
      }
    })
    if (!tasks.some((task, index) => task !== run.plan.graph.tasks[index])) return run
    return {
      ...run,
      plan: {
        ...run.plan,
        graph: {
          ...run.plan.graph,
          tasks,
        },
      },
    }
  })
  return changed ? { ...store, runs, updatedAt: now() } : store
}

function initialTaskStatus(
  kind: RuntimeTaskKind,
  requiresApproval: boolean,
  hasDependencies: boolean,
): RuntimeTaskStatus {
  // Pi 的澄清先执行，执行完成后才等待用户确认需求。
  if (kind === 'clarification' && !hasDependencies) return 'ready'
  if (requiresApproval && !hasDependencies) return 'waiting_approval'
  if (!hasDependencies) return 'ready'
  return 'pending'
}

function buildTask(
  blueprint: DispatchDecision['taskBlueprint'][number],
  index: number,
  prompt: string,
  taskIds: string[],
): RuntimeTask {
  const createdAt = now()
  const id = `task-${index + 1}-${randomUUID()}`
  const dependsOn = blueprint.dependsOn
    .map((dependencyIndex) => taskIds[dependencyIndex])
    .filter((taskId): taskId is string => Boolean(taskId))
  return {
    id,
    title: blueprint.title,
    kind: blueprint.kind,
    runtimeId: EXECUTABLE_RUNTIME_ID,
    harnessId: harnessIdFor(),
    status: initialTaskStatus(blueprint.kind, blueprint.requiresUserApproval, dependsOn.length > 0),
    dependsOn,
    inputArtifactIds: [],
    outputArtifactIds: [],
    requiresUserApproval: blueprint.requiresUserApproval,
    approvalState: blueprint.requiresUserApproval ? 'pending' : 'not_required',
    retryCount: 0,
    maxRetries: blueprint.maxRetries ?? 2,
    timeoutMs: null,
    prompt,
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
  }
}

function buildPlan(prompt: string, decision: DispatchDecision): DispatchPlan {
  const taskIds: string[] = []
  for (let index = 0; index < decision.taskBlueprint.length; index += 1) {
    taskIds.push(`task-${index + 1}-${randomUUID()}`)
  }
  const tasks = decision.taskBlueprint.map((blueprint, index) => {
    const task = buildTask(blueprint, index, prompt, taskIds)
    return { ...task, id: taskIds[index]! }
  })
  const createdAt = now()
  const graph: RuntimeTaskGraph = {
    id: `graph-${randomUUID()}`,
    rootTaskId: tasks[0]?.id || '',
    tasks,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  }
  return {
    id: `plan-${randomUUID()}`,
    prompt,
    intent: decision.intent,
    strategyId: decision.strategyId,
    graph,
    requiresRequirementsConfirmation: decision.requiresRequirementsConfirmation,
    requiresPlanApproval: decision.requiresPlanApproval,
    generatedBy: 'policy',
    createdAt,
  }
}

function runStatusFor(run: DispatchRun): DispatchRunStatus {
  if (run.error) return 'failed'
  if (run.plan.graph.tasks.some((task) => task.status === 'running' || task.status === 'retrying')) return 'running'
  // 只要仍有可执行节点，就继续驱动它们；不能被后续审批节点提前阻塞。
  if (run.plan.graph.tasks.some((task) => task.status === 'ready')) return 'running'
  if (run.plan.graph.tasks.some((task) => task.status === 'waiting_approval')) return 'waiting_user'
  if (run.plan.graph.tasks.some((task) => task.status === 'blocked')) return 'blocked'
  if (run.plan.graph.tasks.length > 0 && run.plan.graph.tasks.every((task) => task.status === 'completed')) return 'completed'
  if (run.plan.graph.tasks.some((task) => task.status === 'failed')) return 'failed'
  if (run.plan.graph.tasks.every((task) => task.status === 'cancelled')) return 'cancelled'
  return 'pending'
}

function replaceRun(store: DispatchStore, next: DispatchRun): DispatchRun {
  const updated = { ...next, updatedAt: now() }
  store.runs = store.runs.map((run) => run.id === updated.id ? updated : run)
  store.updatedAt = updated.updatedAt
  writeStore(store)
  return updated
}

function getRunOrThrow(store: DispatchStore, runId: string): DispatchRun {
  const run = store.runs.find((candidate) => candidate.id === runId)
  if (!run) throw new Error(`找不到 Hermes Dispatch Run：${runId}`)
  return run
}

function dependenciesCompleted(run: DispatchRun, task: RuntimeTask): boolean {
  return task.dependsOn.every((dependencyId) => (
    run.plan.graph.tasks.find((candidate) => candidate.id === dependencyId)?.status === 'completed'
  ))
}

function dependencyFailed(run: DispatchRun, task: RuntimeTask): boolean {
  return task.dependsOn.some((dependencyId) => {
    const dependency = run.plan.graph.tasks.find((candidate) => candidate.id === dependencyId)
    return dependency?.status === 'failed' || dependency?.status === 'cancelled' || dependency?.status === 'blocked'
  })
}

function refreshTaskReadiness(run: DispatchRun): DispatchRun {
  const tasks = run.plan.graph.tasks.map((task) => {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    if (dependencyFailed(run, task)) {
      return { ...task, status: 'blocked' as const, error: '前置任务失败或已取消。', updatedAt: now() }
    }
    if (!dependenciesCompleted(run, task)) return task
    if (task.kind !== 'clarification' && task.requiresUserApproval && task.approvalState !== 'approved') {
      return { ...task, status: 'waiting_approval' as const, updatedAt: now() }
    }
    return { ...task, status: 'ready' as const, updatedAt: now() }
  })
  const graph = { ...run.plan.graph, tasks, revision: run.plan.graph.revision + 1, updatedAt: now() }
  const next = { ...run, plan: { ...run.plan, graph }, status: runStatusFor({ ...run, plan: { ...run.plan, graph } }) }
  return next
}

export function createDispatchRun(input: CreateDispatchRunInput): DispatchRun {
  const decision = input.decision ?? dispatchForRequest(input.dispatchInput ?? { message: input.prompt })
  const plan = buildPlan(input.prompt, decision)
  const run: DispatchRun = {
    id: `run-${randomUUID()}`,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId || null,
    status: 'pending',
    plan,
    artifacts: [],
    approvedTaskIds: [],
    currentTaskId: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
    completedAt: null,
  }
  const store = readStore()
  const refreshed = refreshTaskReadiness(run)
  store.runs.unshift(refreshed)
  store.updatedAt = now()
  writeStore(store)
  return refreshed
}

export function listDispatchRuns(sessionId?: string): DispatchRun[] {
  return readStore().runs
    .filter((run) => !sessionId || run.sessionId === sessionId)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export function getDispatchRun(runId: string): DispatchRun | null {
  return readStore().runs.find((run) => run.id === runId) || null
}

export function getLatestDispatchRun(sessionId: string): DispatchRun | null {
  return listDispatchRuns(sessionId)[0] || null
}

export function getRunnableDispatchTasks(runId: string): RuntimeTask[] {
  const store = readStore()
  const run = refreshTaskReadiness(getRunOrThrow(store, runId))
  replaceRun(store, run)
  return run.plan.graph.tasks.filter((task) => task.status === 'ready')
}

export function confirmRequirements(runId: string): DispatchRun {
  return approveFirstApprovalTask(runId, 'requirements')
}

function approveFirstApprovalTask(runId: string, reason: string): DispatchRun {
  const store = readStore()
  const current = getRunOrThrow(store, runId)
  const task = current.plan.graph.tasks.find((candidate) => (
    candidate.requiresUserApproval && candidate.approvalState === 'pending'
  ))
  if (!task) throw new Error(`当前 Dispatch Run 没有等待批准的任务：${reason}`)
  return approveDispatchTask(runId, task.id)
}

export function approveDispatchTask(runId: string, taskId: string): DispatchRun {
  const store = readStore()
  const current = getRunOrThrow(store, runId)
  const task = current.plan.graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`找不到待批准任务：${taskId}`)
  if (!task.requiresUserApproval) return current
  const updatedTasks = current.plan.graph.tasks.map((candidate) => candidate.id === taskId
    ? { ...candidate, approvalState: 'approved' as const, status: 'pending' as const, updatedAt: now() }
    : candidate)
  const updated: DispatchRun = {
    ...current,
    approvedTaskIds: Array.from(new Set([...current.approvedTaskIds, taskId])),
    plan: {
      ...current.plan,
      graph: { ...current.plan.graph, tasks: updatedTasks, revision: current.plan.graph.revision + 1, updatedAt: now() },
    },
  }
  return replaceRun(store, refreshTaskReadiness(updated))
}

export function rejectDispatchTask(runId: string, taskId: string, reason = '用户拒绝执行任务。'): DispatchRun {
  const store = readStore()
  const current = getRunOrThrow(store, runId)
  const updatedTasks = current.plan.graph.tasks.map((task) => task.id === taskId
    ? { ...task, status: 'failed' as const, approvalState: 'rejected' as const, error: reason, updatedAt: now() }
    : task)
  const updated: DispatchRun = {
    ...current,
    error: reason,
    plan: {
      ...current.plan,
      graph: { ...current.plan.graph, tasks: updatedTasks, revision: current.plan.graph.revision + 1, updatedAt: now() },
    },
  }
  return replaceRun(store, { ...updated, status: 'failed' })
}

export function startDispatchTask(runId: string, taskId: string): DispatchRun {
  const store = readStore()
  const current = refreshTaskReadiness(getRunOrThrow(store, runId))
  const task = current.plan.graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task || task.status !== 'ready') throw new Error('任务当前不可执行，可能仍在等待依赖或审批。')
  const updatedTasks = current.plan.graph.tasks.map((candidate) => candidate.id === taskId
    ? { ...candidate, status: 'running' as const, startedAt: now(), updatedAt: now() }
    : candidate)
  return replaceRun(store, {
    ...current,
    status: 'running',
    currentTaskId: taskId,
    plan: {
      ...current.plan,
      graph: { ...current.plan.graph, tasks: updatedTasks, revision: current.plan.graph.revision + 1, updatedAt: now() },
    },
  })
}

export function completeDispatchTask(runId: string, taskId: string, result: string): DispatchRun {
  const store = readStore()
  const current = getRunOrThrow(store, runId)
  const task = current.plan.graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`找不到任务：${taskId}`)
  const artifact: RuntimeTaskArtifact = {
    id: `artifact-${randomUUID()}`,
    taskId,
    kind: task.kind,
    content: result,
    createdAt: now(),
  }
  const updatedTasks = current.plan.graph.tasks.map((candidate) => candidate.id === taskId
    ? {
        ...candidate,
        status: 'completed' as const,
        result,
        error: null,
        outputArtifactIds: [...candidate.outputArtifactIds, artifact.id],
        completedAt: now(),
        updatedAt: now(),
      }
    : candidate)
  const updatedGraph = {
    ...current.plan.graph,
    tasks: updatedTasks.map((candidate) => candidate.dependsOn.includes(taskId)
      ? {
          ...candidate,
          inputArtifactIds: Array.from(new Set([...candidate.inputArtifactIds, artifact.id])),
          updatedAt: now(),
        }
      : candidate),
    revision: current.plan.graph.revision + 1,
    updatedAt: now(),
  }
  const updated: DispatchRun = {
    ...current,
    artifacts: [...current.artifacts, artifact],
    currentTaskId: current.currentTaskId === taskId ? null : current.currentTaskId,
    plan: { ...current.plan, graph: updatedGraph },
  }
  const refreshed = refreshTaskReadiness(updated)
  const status = runStatusFor(refreshed)
  return replaceRun(store, {
    ...refreshed,
    status,
    completedAt: status === 'completed' ? now() : null,
  })
}

export function failDispatchTask(runId: string, taskId: string, update: DispatchTaskUpdate = {}): DispatchRun {
  const store = readStore()
  const current = getRunOrThrow(store, runId)
  const task = current.plan.graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`找不到任务：${taskId}`)
  const nextRetryCount = task.retryCount + 1
  const retryable = nextRetryCount <= task.maxRetries && !update.timeout
  const status: RuntimeTaskStatus = retryable ? 'retrying' : 'failed'
  const updatedTasks = current.plan.graph.tasks.map((candidate) => candidate.id === taskId
    ? {
        ...candidate,
        status,
        retryCount: nextRetryCount,
        error: update.error || (update.timeout ? '任务执行超时。' : '任务执行失败。'),
        updatedAt: now(),
      }
    : candidate)
  const updated: DispatchRun = {
    ...current,
    error: retryable ? null : (update.error || '任务执行失败。'),
    status: retryable ? 'running' : 'failed',
    plan: {
      ...current.plan,
      graph: { ...current.plan.graph, tasks: updatedTasks, revision: current.plan.graph.revision + 1, updatedAt: now() },
    },
  }
  const refreshed = retryable
    ? refreshTaskReadiness({
        ...updated,
        plan: {
          ...updated.plan,
          graph: {
            ...updated.plan.graph,
            tasks: updated.plan.graph.tasks.map((candidate) => candidate.id === taskId
              ? { ...candidate, status: 'pending' as const, updatedAt: now() }
              : candidate),
          },
        },
      })
    : updated
  return replaceRun(store, refreshed)
}

export function recoverDispatchRun(runId: string): DispatchRun {
  const store = readStore()
  const current = getRunOrThrow(store, runId)
  const tasks = current.plan.graph.tasks.map((task) => (
    task.status === 'running' || task.status === 'retrying'
      ? { ...task, status: 'pending' as const, updatedAt: now() }
      : task
  ))
  const recovered = refreshTaskReadiness({
    ...current,
    error: null,
    plan: { ...current.plan, graph: { ...current.plan.graph, tasks, revision: current.plan.graph.revision + 1, updatedAt: now() } },
  })
  return replaceRun(store, { ...recovered, status: runStatusFor(recovered) })
}

export function cancelDispatchRun(runId: string, reason = '用户取消调度。'): DispatchRun {
  const store = readStore()
  const current = getRunOrThrow(store, runId)
  const tasks = current.plan.graph.tasks.map((task) => (
    task.status === 'completed' ? task : { ...task, status: 'cancelled' as const, error: reason, updatedAt: now() }
  ))
  return replaceRun(store, {
    ...current,
    status: 'cancelled',
    error: reason,
    completedAt: now(),
    plan: { ...current.plan, graph: { ...current.plan.graph, tasks, revision: current.plan.graph.revision + 1, updatedAt: now() } },
  })
}

export function toRuntimeExecutionRequest(
  run: DispatchRun,
  taskId: string,
  input: Pick<RuntimeExecutionRequest, 'sessionId' | 'cwd' | 'model' | 'modelRoute' | 'contextPacket'>,
): RuntimeExecutionRequest {
  const task = run.plan.graph.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`找不到任务：${taskId}`)
  return {
    runId: run.id,
    taskId,
    sessionId: input.sessionId,
    runtimeId: EXECUTABLE_RUNTIME_ID,
    harnessId: EXECUTABLE_RUNTIME_ID,
    prompt: task.prompt,
    cwd: input.cwd,
    model: input.model,
    modelRoute: input.modelRoute
      ? { ...input.modelRoute, runtimeId: EXECUTABLE_RUNTIME_ID }
      : undefined,
    contextPacket: input.contextPacket,
  }
}

export function isDispatchTaskApproved(run: DispatchRun, taskId: string): boolean {
  return run.approvedTaskIds.includes(taskId)
}

export function taskById(run: DispatchRun, taskId: string): RuntimeTask | null {
  return run.plan.graph.tasks.find((task) => task.id === taskId) || null
}

export function taskArtifacts(run: DispatchRun, task: RuntimeTask): RuntimeTaskArtifact[] {
  return task.inputArtifactIds
    .map((id) => run.artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is RuntimeTaskArtifact => Boolean(artifact))
}
