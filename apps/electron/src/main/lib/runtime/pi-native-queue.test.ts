import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage, SDKUserMessageInput } from '@proma/shared'
import {
  createPiAssistantMessageStream,
  FrakioPiRuntimeAdapter,
  type PiAssistantMessageStream,
  type PiUsageSnapshot,
} from './frakio-pi-runtime-adapter'

interface TestMessageQueue {
  messages: SDKMessage[]
  finished: boolean
  failure?: Error
  push(message: SDKMessage): void
  finish(): void
  fail(error: Error): void
}

interface TestRunState {
  token: number
  runId: string
  sessionId: string
  runtimeBuildId: string
  queue: TestMessageQueue
  stream: PiAssistantMessageStream
  settled: boolean
  lastUsage?: PiUsageSnapshot
  nativeTranscript?: boolean
  abortController?: AbortController
  consumedUserIds?: Set<string>
  onNativeMessage?: (message: SDKMessage) => void
}

interface TestPendingUser {
  sessionId: string
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

interface PiAdapterHarness {
  bridgePool: MockPiBridge | null
  runStates: Map<string, TestRunState>
  sessionRuns: Map<string, string>
  pendingUsers: Map<string, TestPendingUser>
  handleBridgeEvent(value: unknown): void
}

interface SteerCall {
  sessionId: string
  message: string
  options?: Record<string, unknown>
}

class MockPiBridge {
  readonly steerCalls: SteerCall[] = []
  readonly cancelCalls: string[] = []
  steerError?: Error

  async steer(
    sessionId: string,
    message: string,
    options?: Record<string, unknown>,
  ): Promise<void> {
    this.steerCalls.push({ sessionId, message, options })
    if (this.steerError) throw this.steerError
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId)
  }
}

interface Harness {
  adapter: FrakioPiRuntimeAdapter
  access: PiAdapterHarness
  bridge: MockPiBridge
}

interface PromiseProbe {
  status: 'pending' | 'fulfilled' | 'rejected'
  error?: unknown
}

const CREDENTIAL_ENV_KEYS = [
  'PROMA_RUNTIME_API_KEY',
  'FRAKIO_RUNTIME_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const

let temporaryHome = ''
let originalHome: string | undefined
let originalPromaDev: string | undefined
let originalCredentialEnv = new Map<string, string | undefined>()

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), 'proma-pi-native-queue-'))
  originalHome = process.env.HOME
  originalPromaDev = process.env.PROMA_DEV
  originalCredentialEnv = new Map(
    CREDENTIAL_ENV_KEYS.map((key) => [key, process.env[key]]),
  )
  process.env.HOME = temporaryHome
  process.env.PROMA_DEV = '1'
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  for (const [key, value] of originalCredentialEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(temporaryHome, { recursive: true, force: true })
})

function createQueue(): TestMessageQueue {
  return {
    messages: [],
    finished: false,
    push(message) {
      this.messages.push(message)
    },
    finish() {
      this.finished = true
    },
    fail(error) {
      this.failure = error
    },
  }
}

function createRunState(sessionId: string, runId: string): TestRunState {
  return {
    token: 1,
    runId,
    sessionId,
    runtimeBuildId: 'pi-test-build',
    queue: createQueue(),
    stream: createPiAssistantMessageStream(sessionId),
    settled: false,
    abortController: new AbortController(),
  }
}

function createHarness(states: TestRunState[]): Harness {
  const adapter = new FrakioPiRuntimeAdapter()
  const access = adapter as unknown as PiAdapterHarness
  const bridge = new MockPiBridge()
  access.bridgePool = bridge
  for (const state of states) {
    access.runStates.set(state.runId, state)
    access.sessionRuns.set(state.sessionId, state.runId)
  }
  return { adapter, access, bridge }
}

function queuedUser(
  sessionId: string,
  uuid: string,
  text = '请继续处理',
): SDKUserMessageInput {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    rawText: text,
    parent_tool_use_id: null,
    priority: 'now',
    uuid,
    session_id: sessionId,
  }
}

function nativeUserMessage(sessionId: string, uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'text', text: '请继续处理' }],
    },
    _createdAt: 1_000,
    _promaNativeMessage: true,
    _promaQueuedDuringStreaming: true,
  } as SDKMessage
}

function nativeAssistantMessage(input: {
  sessionId: string
  uuid: string
  text: string
  partial: boolean
}): SDKMessage {
  return {
    type: 'assistant',
    uuid: input.uuid,
    session_id: input.sessionId,
    parent_tool_use_id: null,
    message: {
      id: `pi-${input.uuid}`,
      content: [{ type: 'text', text: input.text }],
    },
    _createdAt: 1_100,
    _promaNativeMessage: true,
    ...(input.partial ? { _partial: true } : {}),
  } as SDKMessage
}

function emitTranscriptMessage(
  access: PiAdapterHarness,
  runId: string,
  message: SDKMessage,
): void {
  access.handleBridgeEvent({
    runId,
    event: {
      type: 'transcript.message',
      payload: { message },
    },
  })
}

function observePromise(promise: Promise<void>): PromiseProbe {
  const probe: PromiseProbe = { status: 'pending' }
  void promise.then(
    () => {
      probe.status = 'fulfilled'
    },
    (error: unknown) => {
      probe.status = 'rejected'
      probe.error = error
    },
  )
  return probe
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('FrakioPiRuntimeAdapter 原生队列消费契约', () => {
  test('Given bridge 已接受入队 When Pi 尚未产生原生 user Then sendQueuedMessage 仍保持 pending', async () => {
    const state = createRunState('session-1', 'run-1')
    const { adapter, bridge } = createHarness([state])
    let accepted = 0

    const delivery = adapter.sendQueuedMessage(
      state.sessionId,
      queuedUser(state.sessionId, 'queued-1'),
      {
        interrupt: true,
        onAccepted: () => {
          accepted += 1
        },
      },
    )
    const probe = observePromise(delivery)
    await flushMicrotasks()

    expect(bridge.steerCalls).toEqual([{
      sessionId: 'session-1',
      message: '请继续处理',
      options: {
        uuid: 'queued-1',
        rawText: '请继续处理',
        interrupt: true,
      },
    }])
    expect(accepted).toBe(1)
    expect(probe.status).toBe('pending')

    const access = adapter as unknown as PiAdapterHarness
    emitTranscriptMessage(
      access,
      state.runId,
      nativeUserMessage(state.sessionId, 'queued-1'),
    )
    await delivery
  })

  test('Given 队列消息仍 pending When matching run/session/UUID 的原生 user 到达 Then 才 resolve', async () => {
    const state = createRunState('session-1', 'run-1')
    const { adapter, access } = createHarness([state])
    const delivery = adapter.sendQueuedMessage(
      state.sessionId,
      queuedUser(state.sessionId, 'queued-1'),
    )
    const probe = observePromise(delivery)
    await flushMicrotasks()

    emitTranscriptMessage(
      access,
      state.runId,
      nativeUserMessage(state.sessionId, 'queued-1'),
    )
    await delivery

    expect(probe.status).toBe('fulfilled')
    expect(state.consumedUserIds).toEqual(new Set(['queued-1']))
    expect(access.pendingUsers.size).toBe(0)
  })

  test('Given 相同 UUID 已有 pending 投递 When 调用方重复发送 Then 共享同一次 bridge 入队和消费确认', async () => {
    const state = createRunState('session-1', 'run-1')
    const { adapter, access, bridge } = createHarness([state])
    const message = queuedUser(state.sessionId, 'queued-1')

    const first = adapter.sendQueuedMessage(state.sessionId, message)
    const second = adapter.sendQueuedMessage(state.sessionId, message)
    const firstProbe = observePromise(first)
    const secondProbe = observePromise(second)
    await flushMicrotasks()

    expect(bridge.steerCalls).toHaveLength(1)
    expect(firstProbe.status).toBe('pending')
    expect(secondProbe.status).toBe('pending')

    emitTranscriptMessage(
      access,
      state.runId,
      nativeUserMessage(state.sessionId, 'queued-1'),
    )
    await Promise.all([first, second])

    expect(firstProbe.status).toBe('fulfilled')
    expect(secondProbe.status).toBe('fulfilled')
  })

  test('Given 原生 queued user 已完成 When Adapter 处理事件 Then 先同步保存再 push 并 resolve', async () => {
    const state = createRunState('session-1', 'run-1')
    const { adapter, access } = createHarness([state])
    const nativeUser = nativeUserMessage(state.sessionId, 'queued-1')
    const sequence: string[] = []
    const originalPush = state.queue.push.bind(state.queue)
    state.queue.push = (message) => {
      if (message === nativeUser) sequence.push('push')
      originalPush(message)
    }
    state.onNativeMessage = (message) => {
      sequence.push('callback')
      expect(message).toBe(nativeUser)
      expect(state.queue.messages).not.toContain(nativeUser)
      expect(access.pendingUsers.has('session-1:queued-1')).toBeTrue()
    }
    const delivery = adapter.sendQueuedMessage(
      state.sessionId,
      queuedUser(state.sessionId, 'queued-1'),
    )
    void delivery.then(() => {
      sequence.push('resolve')
    })
    await flushMicrotasks()

    emitTranscriptMessage(access, state.runId, nativeUser)

    expect(sequence).toEqual(['callback', 'push'])
    await delivery
    await flushMicrotasks()
    expect(sequence).toEqual(['callback', 'push', 'resolve'])
    expect(state.queue.messages).toContain(nativeUser)
  })

  test('Given 原生 queued user 同步保存抛错 When Adapter 处理事件 Then cancel 且 pending reject 不确认消费', async () => {
    const state = createRunState('session-1', 'run-1')
    const { adapter, access, bridge } = createHarness([state])
    const nativeUser = nativeUserMessage(state.sessionId, 'queued-1')
    state.onNativeMessage = () => {
      throw new Error('mock persist failed')
    }
    const delivery = adapter.sendQueuedMessage(
      state.sessionId,
      queuedUser(state.sessionId, 'queued-1'),
    )
    const probe = observePromise(delivery)
    await flushMicrotasks()

    emitTranscriptMessage(access, state.runId, nativeUser)

    await expect(delivery).rejects.toThrow('Pi 消息保存失败：mock persist failed')
    expect(probe.status).toBe('rejected')
    expect(bridge.cancelCalls).toEqual([state.sessionId])
    expect(state.settled).toBeTrue()
    expect(state.consumedUserIds).toBeUndefined()
    expect(state.queue.messages).not.toContain(nativeUser)
    expect(state.queue.messages.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['Pi 消息保存失败：mock persist failed'],
      _promaNativeMessage: true,
    })
    expect(access.pendingUsers.size).toBe(0)
  })

  test('Given 相同 UUID 的重复 pending When bridge steer 失败 Then 所有调用者都 reject', async () => {
    const state = createRunState('session-1', 'run-1')
    const { adapter, access, bridge } = createHarness([state])
    bridge.steerError = new Error('mock steer failed')
    const message = queuedUser(state.sessionId, 'queued-1')

    const first = adapter.sendQueuedMessage(state.sessionId, message)
    const second = adapter.sendQueuedMessage(state.sessionId, message)

    const outcomes = await Promise.allSettled([first, second])

    expect(bridge.steerCalls).toHaveLength(1)
    expect(outcomes).toEqual([
      { status: 'rejected', reason: bridge.steerError },
      { status: 'rejected', reason: bridge.steerError },
    ])
    expect(access.pendingUsers.size).toBe(0)
  })

  test('Given 队列消息尚未被消费 When run 提前终止 Then sendQueuedMessage reject', async () => {
    const state = createRunState('session-1', 'run-1')
    const { adapter, access } = createHarness([state])
    const delivery = adapter.sendQueuedMessage(
      state.sessionId,
      queuedUser(state.sessionId, 'queued-1'),
    )
    await flushMicrotasks()

    access.handleBridgeEvent({
      runId: state.runId,
      event: {
        type: 'run.cancelled',
        payload: { error: '测试终止' },
      },
    })

    await expect(delivery).rejects.toThrow('测试终止')
    expect(state.settled).toBeTrue()
    expect(state.queue.finished).toBeTrue()
    expect(access.pendingUsers.size).toBe(0)
  })

  test('Given UUID 相同但 run 或 session 不匹配 When 原生消息到达 Then 不能 resolve 当前投递', async () => {
    const state = createRunState('session-1', 'run-1')
    const otherState = createRunState('session-2', 'run-2')
    const { adapter, access } = createHarness([state, otherState])
    const delivery = adapter.sendQueuedMessage(
      state.sessionId,
      queuedUser(state.sessionId, 'queued-1'),
    )
    const probe = observePromise(delivery)
    await flushMicrotasks()

    emitTranscriptMessage(
      access,
      'stale-run',
      nativeUserMessage(state.sessionId, 'queued-1'),
    )
    emitTranscriptMessage(
      access,
      state.runId,
      nativeUserMessage(otherState.sessionId, 'queued-1'),
    )
    emitTranscriptMessage(
      access,
      otherState.runId,
      nativeUserMessage(otherState.sessionId, 'queued-1'),
    )
    await flushMicrotasks()

    expect(probe.status).toBe('pending')
    expect(access.pendingUsers.size).toBe(1)

    emitTranscriptMessage(
      access,
      state.runId,
      nativeUserMessage(state.sessionId, 'queued-1'),
    )
    await delivery
    expect(probe.status).toBe('fulfilled')
  })

  test('Given 原生 assistant partial/final 已进入 transcript When run 完成 Then 不再合成重复结束正文', () => {
    const state = createRunState('session-1', 'run-1')
    const { access } = createHarness([state])
    const partial = nativeAssistantMessage({
      sessionId: state.sessionId,
      uuid: 'assistant-1',
      text: '最终正文',
      partial: true,
    })
    const final = nativeAssistantMessage({
      sessionId: state.sessionId,
      uuid: 'assistant-1',
      text: '最终正文',
      partial: false,
    })

    emitTranscriptMessage(access, state.runId, partial)
    emitTranscriptMessage(access, state.runId, final)
    access.handleBridgeEvent({
      runId: state.runId,
      event: {
        type: 'run.completed',
        payload: { output: '最终正文' },
      },
    })

    const assistantMessages = state.queue.messages.filter(
      (message) => message.type === 'assistant',
    )
    expect(assistantMessages).toEqual([partial, final])
    expect(assistantMessages.every((message) =>
      (message as Record<string, unknown>)._promaNativeMessage === true
    )).toBeTrue()
    expect(state.queue.messages.at(-1)).toMatchObject({
      type: 'result',
      result: '最终正文',
      _promaNativeMessage: true,
    })
  })
})
