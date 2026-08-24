/**
 * Proma Runtime 的本地适配层。
 *
 * 这里把 Pi Worker、Hermes Bridge、Codex CLI 和现有 Claude Code Runtime
 * 统一成 AgentProviderAdapter，避免 AgentOrchestrator 直接依赖某一种原生协议。
 * 原生事件先转换成 Proma 已有的 SDKMessage，Renderer 和 JSONL 持久化无需改造。
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntimeSessionOperationInput,
  AgentRuntimeForkResult,
  AgentRuntimeRewindResult,
  SDKContentBlock,
  SDKMessage,
  SDKUserMessageInput,
  SendQueuedMessageOptions,
  RuntimeId,
  ThinkingConfig,
  ThinkingEffortLevel,
} from '@proma/shared'
import {
  detectRuntime,
  getRuntimeConfig,
  isPackagedElectronApp,
  scanLocalHermesRuntimePackages,
} from './runtime-registry'
import { getRuntimeSessionsDir } from '../config-paths'
import { CcbDesktopRuntimeAdapter } from '../ccb-runtime/ccb-agent-adapter'
import { ClaudeRuntimeAdapter } from './claude-runtime-adapter'
import { CodexRuntimeAdapter } from './codex-runtime-adapter'
import { PiRuntimeAdapter } from './pi-runtime-adapter'

interface MessageQueue {
  iterable: AsyncIterable<SDKMessage>
  push(message: SDKMessage): void
  finish(): void
  fail(error: Error): void
}

interface JsonLineProcess {
  child: ChildProcessWithoutNullStreams
  lines: Interface
}

interface HermesSession {
  process: HermesProcess
  queue: MessageQueue | null
  runId: string | null
  outputCursor: number
  eventCursor: number
  pollTimer: ReturnType<typeof setTimeout> | null
}

interface HermesProcess extends JsonLineProcess {
  endpoint: string
}

interface RuntimeQueryOptions extends AgentQueryInput {
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }
  env?: Record<string, string | undefined>
  channelId?: string
  providerConfiguration?: unknown
  sdkPermissionMode?: string
  thinkingConfig?: unknown
  effortLevel?: string
  mcpServers?: Record<string, unknown>
  resumeSessionId?: string
  fallbackModel?: string
  onSessionId?: (sessionId: string) => void
  onModelResolved?: (model: string) => void
}

function createQueue(): MessageQueue {
  const values: SDKMessage[] = []
  const waiters: Array<{
    resolve: (result: IteratorResult<SDKMessage>) => void
    reject: (error: Error) => void
  }> = []
  let finished = false
  let failure: Error | undefined
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKMessage>> {
            const value = values.shift()
            if (value) return Promise.resolve({ value, done: false })
            if (failure) return Promise.reject(failure)
            if (finished) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
          },
        }
      },
    },
    push(message) {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ value: message, done: false })
      else values.push(message)
    },
    finish() {
      finished = true
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true })
      }
    },
    fail(error) {
      failure = error
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
  }
}

function spawnJsonLine(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): JsonLineProcess {
  const child = spawn(command, args, {
    cwd,
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  return { child, lines }
}

function sendJsonLine(processHandle: JsonLineProcess, value: Record<string, unknown>): void {
  if (!processHandle.child.stdin.writable) throw new Error('Runtime stdin 不可写。')
  processHandle.child.stdin.write(`${JSON.stringify(value)}\n`)
}

function closeProcess(processHandle: JsonLineProcess): void {
  processHandle.lines.close()
  if (!processHandle.child.killed) processHandle.child.kill('SIGTERM')
}

function systemPromptText(value: RuntimeQueryOptions['systemPrompt']): string {
  if (typeof value === 'string') return value
  return value?.append ?? ''
}

function textBlock(text: string): SDKContentBlock {
  return { type: 'text', text }
}

function assistantMessage(
  content: SDKContentBlock[],
  sessionId: string,
  partial: boolean,
  model?: string,
): SDKMessage {
  return {
    type: 'assistant',
    message: { content, ...(model ? { model } : {}) },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: partial ? `runtime-partial:${sessionId}:${randomUUID()}` : randomUUID(),
    ...(partial ? { _partial: true } : {}),
  } as SDKMessage
}

function resultMessage(
  sessionId: string,
  output: string,
  failed = false,
): SDKMessage {
  return {
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    usage: { input_tokens: 0, output_tokens: 0 },
    errors: failed ? [output] : undefined,
    session_id: sessionId,
  } as SDKMessage
}

function eventText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['text', 'delta', 'content', 'output', 'message']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return ''
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

class HermesBridgeAdapter implements AgentProviderAdapter {
  private readonly sessions = new Map<string, HermesSession>()

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as RuntimeQueryOptions
    const queue = createQueue()
    void this.run(options, queue)
    return queue.iterable
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.runId) return
    sendJsonLine(session.process, { action: 'interrupt', session_id: sessionId })
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.pollTimer) clearTimeout(session.pollTimer)
    closeProcess(session.process)
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) void this.closeSession(sessionId)
  }

  private async run(options: RuntimeQueryOptions, queue: MessageQueue): Promise<void> {
    try {
      let session = this.sessions.get(options.sessionId)
      if (!session) {
        const processHandle = await this.startBridge(options)
        session = {
          process: processHandle,
          queue: null,
          runId: null,
          outputCursor: 0,
          eventCursor: 0,
          pollTimer: null,
        }
        this.sessions.set(options.sessionId, session)
        processHandle.child.stderr.on('data', (chunk: Buffer) => console.warn(`[Hermes Runtime] ${String(chunk).trim()}`))
      }
      session.queue = queue
      const accepted = await this.request(session.process, {
        action: 'chat',
        session_id: options.sessionId,
        message: options.prompt,
        instructions: systemPromptText(options.systemPrompt),
        model: options.model,
        workspace: options.cwd,
        wait: false,
      })
      session.runId = String(accepted.run_id || '')
      if (!session.runId) throw new Error('Hermes Bridge 未返回 run_id。')
      void this.poll(options.sessionId)
    } catch (error) {
      queue.fail(errorOf(error))
    }
  }

  private async startBridge(options: RuntimeQueryOptions): Promise<HermesProcess> {
    const config = getRuntimeConfig()
    const packaged = isPackagedElectronApp()
    const sourceHome = packaged
      ? ''
      : (
        process.env.PROMA_RUNTIME_SOURCE_HOME
        || process.env.FRAKIO_WORK_SOURCE_HOME
        || config.runtimeSourceHome
        || config.frakioSourceHome
        || ''
      )
    const bridge = [
      process.resourcesPath ? join(process.resourcesPath, 'hermes', 'runtime', 'agent-bridge', 'python', 'hermes_bridge.py') : '',
      process.resourcesPath ? join(process.resourcesPath, 'runtime', 'agent-bridge', 'python', 'hermes_bridge.py') : '',
      sourceHome ? join(sourceHome, 'runtime', 'agent-bridge', 'python', 'hermes_bridge.py') : '',
    ].filter(Boolean).find((candidate) => existsSync(candidate))
    if (!bridge) {
      throw new Error('未找到 Proma 内置 Hermes Bridge。请重新安装 Proma，不要依赖本机 PATH 中的 python3。')
    }
    const scanned = scanLocalHermesRuntimePackages(config.runtimeHome || '', sourceHome)
    const activeRuntime = scanned.find((item) => item.source === 'bundled')
      || (packaged ? undefined : scanned[0])
    const runtimeHome = activeRuntime?.runtimeDir || ''
    const python = activeRuntime?.executablePath
    if (!python) {
      throw new Error('未发现内置 Hermes Runtime。请重新安装 Proma，不要依赖本机 PATH 中的 python3。')
    }
    const endpoint = `ipc://${join(getRuntimeSessionsDir(), `hermes-${options.sessionId}.sock`)}`
    const processHandle = spawnJsonLine(
      python,
      [bridge, '--endpoint', endpoint, ...(runtimeHome ? ['--hermes-home', runtimeHome] : [])],
      options.cwd || process.cwd(),
      options.env || {},
    )
    processHandle.child.stderr.on('data', (chunk: Buffer) => console.warn(`[Hermes Runtime] ${String(chunk).trim()}`))
    // Hermes Bridge 是 Unix Socket 服务，不会向 stdout 输出
    // “ready” JSON；启动完成的唯一可靠信号是 ping 请求成功。
    const deadline = Date.now() + 15_000
    let lastError: Error | null = null
    while (Date.now() < deadline) {
      try {
        await this.request({ ...processHandle, endpoint }, { action: 'ping' })
        return { ...processHandle, endpoint }
      } catch (error) {
        lastError = errorOf(error)
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    closeProcess(processHandle)
    throw new Error(`Hermes Bridge 启动超时。${lastError ? ` ${lastError.message}` : ''}`)
  }

  private request(processHandle: HermesProcess, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID()
    return new Promise((resolvePromise, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        callback()
      }
      const timer = setTimeout(() => finish(() => reject(new Error(`Hermes Bridge 请求超时：${String(request.action)}`))), 30_000)
      const socket = processHandle.endpoint.startsWith('ipc://')
        ? createConnection(processHandle.endpoint.slice('ipc://'.length))
        : createConnection(processHandle.endpoint)
      let buffer = ''
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ ...request, request_id: requestId })}\n`)
      })
      socket.on('data', (chunk: Buffer) => {
        buffer += String(chunk)
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex < 0) return
        const line = buffer.slice(0, newlineIndex)
        try {
          const response = JSON.parse(line) as Record<string, unknown>
          finish(() => {
            if (response.ok === false) reject(new Error(String(response.error || 'Hermes Bridge 请求失败')))
            else resolvePromise(response)
          })
        } catch (error) {
          finish(() => reject(errorOf(error)))
        }
      })
      socket.once('error', (error) => finish(() => reject(error)))
    })
  }

  private async poll(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.runId || !session.queue) return
    const queue = session.queue
    try {
      const response = await this.request(session.process, {
        action: 'get_output',
        run_id: session.runId,
        cursor: session.outputCursor,
        event_cursor: session.eventCursor,
      })
      session.outputCursor = Number(response.cursor || session.outputCursor)
      session.eventCursor = Number(response.event_cursor || session.eventCursor)
      const delta = String(response.delta || '')
      if (delta) queue.push(assistantMessage([textBlock(delta)], sessionId, true))
      const events = Array.isArray(response.events) ? response.events : []
      for (const item of events) this.pushHermesEvent(session, item)
      if (response.done === true) {
        const output = String(response.output || '')
        if (output && !delta) queue.push(assistantMessage([textBlock(output)], sessionId, false))
        queue.push(resultMessage(sessionId, String(response.error || ''), Boolean(response.error)))
        queue.finish()
        session.queue = null
        session.runId = null
        return
      }
      session.pollTimer = setTimeout(() => void this.poll(sessionId), 80)
    } catch (error) {
      queue.fail(errorOf(error))
      session.queue = null
    }
  }

  private pushHermesEvent(session: HermesSession, value: unknown): void {
    if (!session.queue || !value || typeof value !== 'object') return
    const event = value as Record<string, unknown>
    const type = String(event.event || '')
    const sessionId = [...this.sessions.entries()].find(([, item]) => item === session)?.[0] || ''
    if (type === 'stream.delta' || type === 'reasoning.delta') {
      const text = String(event.text || event.delta || '')
      if (text) session.queue.push(assistantMessage([textBlock(text)], sessionId, true))
    } else if (type === 'tool.started') {
      session.queue.push(assistantMessage([{
        type: 'tool_use',
        id: String(event.tool_call_id || randomUUID()),
        name: String(event.tool_name || 'Hermes Tool'),
        input: (event.args && typeof event.args === 'object' ? event.args : {}) as Record<string, unknown>,
      }], sessionId, true))
    } else if (type === 'tool.completed') {
      session.queue.push({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: String(event.tool_call_id || randomUUID()), content: String(event.result_preview || event.result || ''), is_error: Boolean(event.is_error) }] },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: randomUUID(),
      } as SDKMessage)
    }
  }
}

class CodexCliAdapter implements AgentProviderAdapter {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>()

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as RuntimeQueryOptions
    const queue = createQueue()
    void this.run(options, queue)
    return queue.iterable
  }

  async abort(sessionId: string): Promise<void> {
    this.processes.get(sessionId)?.kill('SIGTERM')
  }

  async closeSession(sessionId: string): Promise<void> {
    this.processes.get(sessionId)?.kill('SIGTERM')
    this.processes.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.processes.keys()) void this.closeSession(sessionId)
  }

  private async run(options: RuntimeQueryOptions, queue: MessageQueue): Promise<void> {
    const runtime = detectRuntime('codex')
    const command = runtime?.installation.executablePath
    if (!command) {
      queue.fail(new Error('未发现内置 Codex Runtime。请重新安装 Proma，不要依赖本机 PATH 中的 codex。'))
      return
    }
    const child = spawn(command, [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
      '-C', options.cwd || process.cwd(), options.prompt,
    ], {
      cwd: options.cwd || process.cwd(),
      env: Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.processes.set(options.sessionId, child)
    let output = ''
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let value: unknown
      try { value = JSON.parse(line) as unknown } catch { return }
      if (!value || typeof value !== 'object') return
      const event = value as Record<string, unknown>
      const text = eventText(event.delta) || eventText(event.text)
      if (text) {
        output += text
        queue.push(assistantMessage([textBlock(text)], options.sessionId, true))
      }
      if (event.type === 'item.completed' || event.type === 'message.completed') {
        const completedText = eventText(event.item) || eventText(event.message)
        if (completedText && !output) queue.push(assistantMessage([textBlock(completedText)], options.sessionId, false))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => console.warn(`[Codex Runtime] ${String(chunk).trim()}`))
    await new Promise<void>((resolvePromise) => {
      child.once('error', (error) => { queue.fail(error); resolvePromise() })
      child.once('exit', (code) => {
        lines.close()
        this.processes.delete(options.sessionId)
        if (code && !output) {
          queue.push(resultMessage(options.sessionId, `Codex Runtime 退出，code=${code}`, true))
        } else {
          if (output) queue.push(assistantMessage([textBlock(output)], options.sessionId, false))
          queue.push(resultMessage(options.sessionId, code ? `Codex Runtime 退出，code=${code}` : ''))
        }
        queue.finish()
        resolvePromise()
      })
    })
  }
}

export class RuntimeAdapterRouter implements AgentProviderAdapter {
  private readonly claude = new ClaudeRuntimeAdapter()
  private readonly ccb = new CcbDesktopRuntimeAdapter()
  private readonly piBridge = new PiRuntimeAdapter()
  private readonly hermes = new HermesBridgeAdapter()
  private readonly codex = new CodexRuntimeAdapter()
  private readonly codexCli = new CodexCliAdapter()
  private readonly sessions = new Map<string, RuntimeId>()
  private readonly sessionAdapters = new Map<string, AgentProviderAdapter>()
  private disposePromise: Promise<void> | null = null

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const runtimeId = input.runtimeId || 'pi'
    this.sessions.set(input.sessionId, runtimeId)
    const adapter = this.adapterFor(runtimeId, input)
    this.sessionAdapters.set(input.sessionId, adapter)
    return adapter.query(input)
  }

  abort(sessionId: string): Promise<void> {
    return this.adapterForSession(sessionId).abort(sessionId)
  }

  closeSession(sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId)
    this.sessions.delete(sessionId)
    this.sessionAdapters.delete(sessionId)
    return adapter.closeSession?.(sessionId) ?? Promise.resolve()
  }

  interruptQuery(sessionId: string): Promise<void> {
    return this.adapterForSession(sessionId).interruptQuery?.(sessionId) ?? this.abort(sessionId)
  }

  sendQueuedMessage(sessionId: string, message: SDKUserMessageInput, options?: SendQueuedMessageOptions): Promise<void> {
    const adapter = this.adapterForSession(sessionId)
    return adapter.sendQueuedMessage?.(sessionId, message, options)
      ?? Promise.reject(new Error('当前 Runtime 不支持队列消息。'))
  }

  setPermissionMode(sessionId: string, mode: string): Promise<void> {
    return this.adapterForSession(sessionId).setPermissionMode?.(sessionId, mode) ?? Promise.resolve()
  }

  async updateRuntimeConfig(
    sessionId: string,
    updates: {
      model?: string
      thinkingConfig?: ThinkingConfig
      effortLevel?: ThinkingEffortLevel
    },
  ): Promise<boolean> {
    return false
  }

  async invalidateChannelConfiguration(channelId: string): Promise<void> {
    await this.ccb.invalidateChannelConfiguration(channelId)
  }

  async getExecutionGraph(
    sessionId: string,
  ): Promise<import('@proma/shared').AgentRuntimeExecutionGraph> {
    if (this.sessions.get(sessionId) !== 'claude') {
      return { nodes: [], todos: [], updatedAt: 0 }
    }
    return { nodes: [], todos: [], updatedAt: 0 }
  }

  async getSubagentTranscript(
    sessionId: string,
    executionNodeId: string,
  ): Promise<import('@proma/shared').AgentRuntimeSubagentTranscript> {
    if (this.sessions.get(sessionId) !== 'claude') {
      throw new Error('当前 Runtime 不支持子代理 Transcript。')
    }
    throw new Error('Proma Claude Code Runtime 不支持子代理 Transcript。')
  }

  forkSession(input: AgentRuntimeSessionOperationInput, upToMessageUuid?: string): Promise<AgentRuntimeForkResult> {
    return this.requireSessionAdapter(input.sessionId).forkSession?.(input, upToMessageUuid)
      ?? Promise.reject(new Error('当前 Runtime 不支持 Session 分叉。'))
  }

  rewindSession(input: AgentRuntimeSessionOperationInput, messageUuid: string): Promise<AgentRuntimeRewindResult> {
    return this.requireSessionAdapter(input.sessionId).rewindSession?.(input, messageUuid)
      ?? Promise.reject(new Error('当前 Runtime 不支持 Session 回退。'))
  }

  compactSession(input: AgentRuntimeSessionOperationInput, instructions?: string): Promise<void> {
    return this.requireSessionAdapter(input.sessionId).compactSession?.(input, instructions)
      ?? Promise.reject(new Error('当前 Runtime 不支持上下文压缩。'))
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = Promise.all([
        Promise.resolve(this.claude.dispose()),
        Promise.resolve(this.ccb.dispose()),
        Promise.resolve(this.piBridge.dispose()),
        Promise.resolve(this.hermes.dispose()),
        Promise.resolve(this.codex.dispose()),
        Promise.resolve(this.codexCli.dispose()),
      ]).then(() => {
        this.sessions.clear()
        this.sessionAdapters.clear()
      })
    }
    await this.disposePromise
  }

  private adapterFor(runtimeId: RuntimeId, input?: AgentQueryInput): AgentProviderAdapter {
    switch (runtimeId) {
      case 'claude':
        return this.claude
      case 'hermes': return this.hermes
      case 'codex':
        return this.codex
      case 'pi': return this.piBridge
    }
  }

  private adapterForSession(sessionId: string): AgentProviderAdapter {
    return this.sessionAdapters.get(sessionId)
      || this.adapterFor(this.sessions.get(sessionId) || 'pi')
  }

  private requireSessionAdapter(sessionId: string): AgentProviderAdapter {
    if (!this.sessions.has(sessionId)) throw new Error('Runtime Session 尚未打开。')
    return this.adapterForSession(sessionId)
  }
}
