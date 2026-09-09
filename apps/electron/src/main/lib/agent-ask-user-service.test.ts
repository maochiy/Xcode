import { describe, expect, spyOn, test } from 'bun:test'
import type { AskUserRequest } from '@proma/shared'
import { AgentAskUserService } from './agent-ask-user-service'

const browserController = await import('./browser/browser-agent-controller')

describe('AgentAskUserService pending 生命周期', () => {
  test('Given 本轮操作过浏览器 When AskUser pending 后回答 Then waiting_user 恢复为 running', async () => {
    browserController.resetBrowserAgentTasksForTest()
    browserController.prepareSessionBrowserTasksForRun('session-1')
    browserController.upsertBrowserAgentTask({
      taskId: 'browser-1',
      sessionId: 'session-1',
      title: '等待登录',
    })
    const service = new AgentAskUserService()
    const abortController = new AbortController()
    let requestId = ''

    const resultPromise = service.handleAskUserQuestion(
      'session-1',
      { questions: [{ question: '请完成登录', options: [] }] },
      abortController.signal,
      (request) => {
        requestId = request.requestId
      },
      {
        onPending: (request) => {
          browserController.markSessionBrowserTasksWaitingForUser(
            request.sessionId,
            request.requestId,
          )
        },
        onSettled: (request, outcome) => {
          browserController.resolveSessionBrowserTasksWaitingForUser(
            request.sessionId,
            request.requestId,
            outcome === 'answered',
          )
        },
      },
    )

    expect(browserController.getBrowserAgentTask('browser-1')?.status).toBe('waiting_user')
    expect(service.respondToAskUser(requestId, { 请完成登录: '已完成' })).toBe('session-1')
    await resultPromise
    expect(browserController.getBrowserAgentTask('browser-1')?.status).toBe('running')
  })

  test('Given 浏览器等待中的 AskUser When 运行被中止 Then 不恢复执行且旧回答不可继续', async () => {
    browserController.resetBrowserAgentTasksForTest()
    browserController.prepareSessionBrowserTasksForRun('session-1')
    browserController.upsertBrowserAgentTask({
      taskId: 'browser-abort',
      sessionId: 'session-1',
      title: '等待验证码',
    })
    const service = new AgentAskUserService()
    const abortController = new AbortController()
    let requestId = ''

    const resultPromise = service.handleAskUserQuestion(
      'session-1',
      { questions: [{ question: '请输入验证码', options: [] }] },
      abortController.signal,
      (request) => {
        requestId = request.requestId
      },
      {
        onPending: (request) => {
          browserController.markSessionBrowserTasksWaitingForUser(
            request.sessionId,
            request.requestId,
          )
        },
        onSettled: (request, outcome) => {
          browserController.resolveSessionBrowserTasksWaitingForUser(
            request.sessionId,
            request.requestId,
            outcome === 'answered',
          )
        },
      },
    )

    abortController.abort()
    browserController.settleSessionBrowserTasks('session-1', 'paused')

    await expect(resultPromise).resolves.toEqual({
      behavior: 'deny',
      message: '操作已中止',
    })
    expect(browserController.getBrowserAgentTask('browser-abort')?.status).toBe('paused')
    expect(service.respondToAskUser(requestId, { 请输入验证码: '123456' })).toBeNull()
    expect(browserController.getBrowserAgentTask('browser-abort')?.status).toBe('paused')
  })

  test('Given AskUserQuestion When 请求发送到 Renderer Then 已先进入真实 pending Map', async () => {
    const service = new AgentAskUserService()
    const abortController = new AbortController()
    const lifecycle: string[] = []
    let requestId = ''

    const resultPromise = service.handleAskUserQuestion(
      'session-1',
      {
        questions: [{
          question: '是否继续？',
          options: [{ label: '继续' }],
        }],
      },
      abortController.signal,
      (request) => {
        requestId = request.requestId
        expect(service.getPendingRequests().map((item) => item.requestId)).toContain(request.requestId)
        lifecycle.push('sent')
      },
      {
        onPending: () => lifecycle.push('pending'),
        onSettled: (_request, outcome) => lifecycle.push(outcome),
      },
    )

    expect(lifecycle).toEqual(['pending', 'sent'])
    expect(service.respondToAskUser(requestId, { '是否继续？': '继续' })).toBe('session-1')
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [{
          question: '是否继续？',
          options: [{ label: '继续' }],
        }],
        answers: { '是否继续？': '继续' },
      },
    })
    expect(lifecycle).toEqual(['pending', 'sent', 'answered'])
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given AskUserQuestion 正在等待 When AbortSignal 中止 Then 请求以 aborted 收敛', async () => {
    const service = new AgentAskUserService()
    const abortController = new AbortController()
    const settled: Array<{ request: AskUserRequest; outcome: string }> = []

    const resultPromise = service.handleAskUserQuestion(
      'session-1',
      { questions: [] },
      abortController.signal,
      () => undefined,
      {
        onSettled: (request, outcome) => settled.push({ request, outcome }),
      },
    )
    abortController.abort()

    await expect(resultPromise).resolves.toEqual({
      behavior: 'deny',
      message: '操作已中止',
    })
    expect(settled).toHaveLength(1)
    expect(settled[0]?.request.sessionId).toBe('session-1')
    expect(settled[0]?.outcome).toBe('aborted')
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given 等待用户状态已建立 When 问答无法送达界面 Then 拒绝请求并撤销等待状态', async () => {
    browserController.resetBrowserAgentTasksForTest()
    browserController.prepareSessionBrowserTasksForRun('session-1')
    browserController.upsertBrowserAgentTask({
      taskId: 'undelivered',
      sessionId: 'session-1',
      title: '待确认',
    })
    const service = new AgentAskUserService()
    const result = await service.handleAskUserQuestion(
      'session-1',
      { questions: [{ question: '请完成操作', options: [] }] },
      new AbortController().signal,
      () => { throw new Error('测试窗口已关闭') },
      {
        onPending: (request) => {
          browserController.markSessionBrowserTasksWaitingForUser(request.sessionId, request.requestId)
        },
        onSettled: (request, outcome) => {
          browserController.resolveSessionBrowserTasksWaitingForUser(
            request.sessionId, request.requestId, outcome === 'answered',
          )
        },
      },
    )
    browserController.completeSessionBrowserTasks('session-1')

    expect(result.behavior).toBe('deny')
    expect(service.getPendingRequests()).toHaveLength(0)
    expect(browserController.getBrowserAgentTask('undelivered')?.status).toBe('paused')
  })

  test('Given 用户已回答 When 状态订阅回调异常 Then 问答 Promise 仍完成且不残留 pending', async () => {
    const service = new AgentAskUserService()
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      let requestId = ''
      const result = service.handleAskUserQuestion(
        'session-1',
        { questions: [{ question: '继续？', options: [] }] },
        new AbortController().signal,
        (request) => { requestId = request.requestId },
        { onSettled: () => { throw new Error('测试状态订阅异常') } },
      )

      expect(service.respondToAskUser(requestId, { '继续？': '是' })).toBe('session-1')
      expect((await result).behavior).toBe('allow')
      expect(service.getPendingRequests()).toHaveLength(0)
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
  })

  test('Given 多会话 AskUser 请求 When 清理指定会话 Then 不误清理其他会话', async () => {
    const service = new AgentAskUserService()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = service.handleAskUserQuestion(
      'session-1',
      { questions: [] },
      firstAbort.signal,
      () => undefined,
    )
    const second = service.handleAskUserQuestion(
      'session-2',
      { questions: [] },
      secondAbort.signal,
      () => undefined,
    )

    service.clearSessionPending('session-1')

    await expect(first).resolves.toEqual({
      behavior: 'deny',
      message: '会话已结束',
    })
    expect(service.getPendingRequests().map((request) => request.sessionId)).toEqual(['session-2'])
    secondAbort.abort()
    await second
  })
})
