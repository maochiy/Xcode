import { afterEach, describe, expect, test } from 'bun:test'
import type { DispatchRun } from '@proma/shared'
import { dispatchForRequest } from './dispatch-policy'
import {
  approveDispatchTask,
  createDispatchRun,
  getDispatchRun,
  setDispatchStoreAdapter,
} from './hermes-dispatcher'
import { HermesTaskScheduler } from './hermes-task-scheduler'

describe('Hermes 动态任务调度', () => {
  afterEach(() => {
    setDispatchStoreAdapter(undefined)
  })

  test('Given 已确认的实现需求 When Hermes 驱动任务图 Then 自动执行可运行节点并停在用户审批', async () => {
    let store: { runs: DispatchRun[]; updatedAt: number } = { runs: [], updatedAt: 0 }
    setDispatchStoreAdapter({
      read: () => store,
      write: (next) => { store = next },
    })
    const created = createDispatchRun({
      sessionId: 'scheduler-session',
      prompt: '实现登录页面',
      decision: dispatchForRequest({
        message: '实现登录页面',
        requirementsConfirmed: true,
      }),
    })
    const executed: string[] = []
    const scheduler = new HermesTaskScheduler()

    const waiting = await scheduler.run(created.id, {
      buildRequest: (run, task) => ({
        runId: run.id,
        taskId: task.id,
        sessionId: run.sessionId,
        runtimeId: task.runtimeId,
        harnessId: task.harnessId,
        prompt: task.prompt,
      }),
      executeTask: async ({ task }) => {
        executed.push(task.runtimeId)
        return `${task.runtimeId} 已完成`
      },
    })

    expect(executed).toEqual(['pi', 'pi'])
    expect(waiting?.status).toBe('waiting_user')
    expect(waiting?.plan.graph.tasks.find((task) => task.kind === 'implementation')?.status).toBe('waiting_approval')
  })

  test('Given 用户批准实施任务 When 继续驱动 Then 实施、审查和汇总角色均由 Pi 执行', async () => {
    let store: { runs: DispatchRun[]; updatedAt: number } = { runs: [], updatedAt: 0 }
    setDispatchStoreAdapter({
      read: () => store,
      write: (next) => { store = next },
    })
    const created = createDispatchRun({
      sessionId: 'scheduler-approval-session',
      prompt: '实现设置页',
      decision: dispatchForRequest({
        message: '实现设置页',
        requirementsConfirmed: true,
      }),
    })
    const scheduler = new HermesTaskScheduler()
    await scheduler.run(created.id, {
      buildRequest: (run, task) => ({
        runId: run.id,
        taskId: task.id,
        sessionId: run.sessionId,
        runtimeId: task.runtimeId,
        harnessId: task.harnessId,
        prompt: task.prompt,
      }),
      executeTask: async ({ task }) => `${task.runtimeId} 已完成`,
    })
    const waiting = store.runs[0]!
    const implementation = waiting.plan.graph.tasks.find((task) => task.kind === 'implementation')!
    approveDispatchTask(waiting.id, implementation.id)

    const executed: string[] = []
    const completed = await scheduler.run(waiting.id, {
      buildRequest: (run, task) => ({
        runId: run.id,
        taskId: task.id,
        sessionId: run.sessionId,
        runtimeId: task.runtimeId,
        harnessId: task.harnessId,
        prompt: task.prompt,
      }),
      executeTask: async ({ task }) => {
        executed.push(task.runtimeId)
        return `${task.runtimeId} 已完成`
      },
    })

    expect(executed).toEqual(['pi', 'pi', 'pi'])
    expect(completed?.status).toBe('completed')
  })

  test('Given 磁盘任务图仍保存旧 runtimeId/harnessId When 读取 Then 保留任务图并迁移为 Pi', () => {
    let store: { runs: DispatchRun[]; updatedAt: number } = { runs: [], updatedAt: 0 }
    setDispatchStoreAdapter({
      read: () => store,
      write: (next) => { store = next },
    })
    const created = createDispatchRun({
      sessionId: 'legacy-runtime-session',
      prompt: '审查实现',
      decision: dispatchForRequest({ message: '审查实现' }),
    })
    const originalTask = store.runs[0]!.plan.graph.tasks[0]!
    store.runs[0]!.plan.graph.tasks[0] = {
      ...originalTask,
      runtimeId: 'claude',
      harnessId: 'codex',
    }

    const migrated = getDispatchRun(created.id)
    expect(migrated?.plan.graph.tasks).toHaveLength(created.plan.graph.tasks.length)
    expect(migrated?.plan.graph.tasks[0]?.kind).toBe(originalTask.kind)
    expect(migrated?.plan.graph.tasks[0]?.status).toBe(originalTask.status)
    expect(migrated?.plan.graph.tasks[0]?.runtimeId).toBe('pi')
    expect(migrated?.plan.graph.tasks[0]?.harnessId).toBe('pi')
  })
})
