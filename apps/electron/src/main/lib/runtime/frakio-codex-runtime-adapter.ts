/**
 * Proma Codex App Server 适配器。
 *
 * Codex Harness 不再调用 `codex exec` 的一次性 CLI，而是按 Proma Runtime 的
 * Proma Runtime Model Gateway 路由启动 `codex app-server`，使用 thread/turn JSON-RPC 协议。
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { join } from 'node:path'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  RuntimeModelRoute,
  SDKContentBlock,
  SDKMessage,
  SDKUserMessageInput,
  SendQueuedMessageOptions,
} from '@proma/shared'
import { detectRuntime, getRuntimeConfig } from './runtime-registry'
import { getRuntimeSessionsDir } from '../config-paths'

interface MessageQueue {
  iterable: AsyncIterable<SDKMessage>
  push(message: SDKMessage): void
  finish(): void
  fail(error: Error): void
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CodexSession {
  child: ChildProcessWithoutNullStreams
  lines: Interface
  queue: MessageQueue | null
  threadId: string
  turnId: string
  turnState: 'starting' | 'active' | 'completed'
  output: string
  pending: Map<string, PendingRequest>
  sequence: number
  /** 同一轮回复的流式消息身份：固定 uuid + message.id，让 partial 覆盖/去重生效 */
  streamUuid: string
  streamMessageId: string
  /** item.id → toolUseId，用于 item/completed 时配对 tool_result */
  itemToolUseIds: Map<string, string>
  /** collab 子 agent 线程 id → 其父级 Agent tool_use id，用于子 agent 活动归组 */
  collabThreadToolUseIds: Map<string, string>
  /** 当前推理块：reasoningItemId → 累积文本与消息身份（流式覆盖） */
  reasoningStates: Map<string, { text: string; uuid: string; messageId: string }>
}

interface CodexRuntimeQueryOptions extends AgentQueryInput {
  env?: Record<string, string | undefined>
  sdkPermissionMode?: string
  effortLevel?: string
  resumeSessionId?: string
}

interface CodexMcpLaunchConfiguration {
  args: string[]
  env: Record<string, string>
}

export function codexQueuedMessageRequest(
  threadId: string,
  turnId: string,
  message: SDKUserMessageInput,
): Record<string, unknown> {
  return {
    threadId,
    expectedTurnId: turnId,
    clientUserMessageId: message.uuid ?? null,
    input: [{
      type: 'text',
      text: message.message.content,
      text_elements: [],
    }],
  }
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
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
    },
    fail(error) {
      failure = error
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
  }
}

function textBlock(text: string): SDKContentBlock {
  return { type: 'text', text }
}

/**
 * 流式回复消息：同一轮共用固定 uuid + message.id。
 * app-server 推的是增量 delta，渲染层 text_complete 是「替换」语义，
 * 必须推累计文本并用固定身份，否则每个 token 会被固化为独立消息、渲染全部换行。
 */
function streamAssistantMessage(session: CodexSession, sessionId: string, partial: boolean): SDKMessage {
  return {
    type: 'assistant',
    message: { id: session.streamMessageId, content: [textBlock(session.output)] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: session.streamUuid,
    ...(partial ? { _partial: true } : {}),
  } as SDKMessage
}

function resultMessage(sessionId: string, output: string, error?: string): SDKMessage {
  return {
    type: 'result',
    subtype: error ? 'error_during_execution' : 'success',
    session_id: sessionId,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(error ? { errors: [error] } : {}),
    ...(output ? { result: output } : {}),
  } as SDKMessage
}

/** Codex ThreadItem → Proma 工具名（对齐 Claude SDK 的命名，渲染层零改动） */
export function codexItemToolName(item: Record<string, unknown>): string {
  const type = String(item.type || '')
  switch (type) {
    case 'commandExecution': return 'Bash'
    case 'fileChange': return 'Edit'
    case 'mcpToolCall': {
      // MCP 工具沿用 mcp__server__tool 约定，渲染层按此前缀识别
      const server = String(item.server || '').trim()
      const tool = String(item.tool || '').trim()
      return server && tool ? `mcp__${server}__${tool}` : tool || 'MCP'
    }
    case 'dynamicToolCall': return String(item.tool || 'Tool')
    case 'webSearch': return 'WebSearch'
    case 'collabAgentToolCall': return 'Agent'
    default: return 'Tool'
  }
}

/** Codex ThreadItem → tool_use 的 input（保留关键上下文字段供渲染层展示） */
export function codexItemToolInput(item: Record<string, unknown>): Record<string, unknown> {
  const type = String(item.type || '')
  switch (type) {
    case 'commandExecution':
      return {
        command: item.command,
        description: typeof item.command === 'string' ? String(item.command).slice(0, 120) : undefined,
        cwd: item.cwd,
      }
    case 'fileChange':
      return { changes: item.changes }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return (item.arguments && typeof item.arguments === 'object'
        ? item.arguments
        : { arguments: item.arguments }) as Record<string, unknown>
    case 'webSearch':
      return { query: item.query }
    case 'collabAgentToolCall':
      return {
        prompt: item.prompt,
        model: item.model,
        description: typeof item.prompt === 'string' ? String(item.prompt).slice(0, 120) : undefined,
      }
    default:
      return {}
  }
}

/** Codex ThreadItem → tool_result 的文本内容（item/completed 时回填） */
export function codexItemToolResultText(item: Record<string, unknown>): string {
  const type = String(item.type || '')
  switch (type) {
    case 'commandExecution':
      return textOf(item.aggregatedOutput) || textOf(item.output)
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .map((change) => (change && typeof change === 'object' ? (change as Record<string, unknown>).path : null))
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
      return paths.length > 0 ? `已改动 ${paths.length} 个文件：\n${paths.join('\n')}` : '文件已改动'
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return textOf(item.result) || textOf(item.error)
    case 'webSearch':
      return textOf(item.action) || '搜索完成'
    case 'collabAgentToolCall': {
      const status = item.status && typeof item.status === 'object'
        ? String((item.status as Record<string, unknown>).status || (item.status as Record<string, unknown>).state || '')
        : String(item.status || '')
      return status ? `子 Agent ${status}` : '子 Agent 调用完成'
    }
    default:
      return ''
  }
}

/** Codex ThreadItem 是否视为出错的 tool_result */
export function codexItemIsError(item: Record<string, unknown>): boolean {
  const status = String(
    (item.status && typeof item.status === 'object'
      ? (item.status as Record<string, unknown>).status ?? (item.status as Record<string, unknown>).state
      : item.status) || '',
  ).toLowerCase()
  if (status === 'failed' || status === 'error' || status === 'declined' || status === 'cancelled') return true
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return true
  if (item.error) return true
  return false
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['text', 'delta', 'content']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return ''
}

function routeFor(input: CodexRuntimeQueryOptions): { baseUrl: string; token: string } {
  const env = input.env || {}
  const config = getRuntimeConfig()
  const baseUrl = String(
    input.modelRoute?.baseUrl
      || env.PROMA_RUNTIME_MODEL_BASE_URL
      || env.PROMA_MODEL_CENTER_PROVIDER_BASE_URL
      || env.FRAKIO_MODEL_CENTER_PROVIDER_BASE_URL
      || env.FRAKIO_MODEL_ROUTE_BASE_URL
      || env.OPENAI_BASE_URL
      || config.runtimeApiBaseUrl
      || config.frakioApiBaseUrl
      || '',
  ).replace(/\/+$/, '')
  const token = String(
    env.PROMA_RUNTIME_API_KEY
      || env.FRAKIO_RUNTIME_TOKEN
      || env.OPENAI_API_KEY
      || env.ANTHROPIC_AUTH_TOKEN
      || env.ANTHROPIC_API_KEY
      || '',
  )
  if (!baseUrl || !token || !input.model) {
    throw new Error('Codex 缺少模型中心配置（baseUrl/token/model）。')
  }
  return { baseUrl, token }
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

function tomlStringMap(value: Record<string, string>): string {
  return `{${Object.entries(value)
    .map(([key, item]) => `${tomlKey(key)}=${JSON.stringify(item)}`)
    .join(',')}}`
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/**
 * 将 Proma 运行时的动态 MCP 配置投影为 Codex `-c mcp_servers.*` 参数。
 *
 * HTTP header 不直接写入进程参数，避免 token 出现在进程列表中；改为通过
 * `env_http_headers` 引用当前 Codex 子进程的临时环境变量。
 */
export function codexMcpLaunchConfiguration(
  mcpServers: Record<string, unknown> | undefined,
): CodexMcpLaunchConfiguration {
  const args: string[] = []
  const env: Record<string, string> = {}
  if (!mcpServers) return { args, env }

  let serverIndex = 0
  for (const [name, rawConfig] of Object.entries(mcpServers)) {
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue
    const config = rawConfig as Record<string, unknown>
    const prefix = `mcp_servers.${tomlKey(name)}`
    const type = String(config.type || '').toLowerCase()

    if ((type === 'http' || type === 'sse') && typeof config.url === 'string') {
      args.push('-c', `${prefix}.url=${JSON.stringify(config.url)}`)
      const headers = stringRecord(config.headers)
      if (Object.keys(headers).length > 0) {
        const envHeaders: Record<string, string> = {}
        let headerIndex = 0
        for (const [header, value] of Object.entries(headers)) {
          const envName = `PROMA_CODEX_MCP_${serverIndex}_${headerIndex}`
          env[envName] = value
          envHeaders[header] = envName
          headerIndex += 1
        }
        args.push('-c', `${prefix}.env_http_headers=${tomlStringMap(envHeaders)}`)
      }
    } else if (type === 'stdio' && typeof config.command === 'string') {
      args.push('-c', `${prefix}.command=${JSON.stringify(config.command)}`)
      const commandArgs = Array.isArray(config.args)
        ? config.args.filter((item): item is string => typeof item === 'string')
        : []
      if (commandArgs.length > 0) {
        args.push('-c', `${prefix}.args=${JSON.stringify(commandArgs)}`)
      }
      const commandEnv = stringRecord(config.env)
      if (Object.keys(commandEnv).length > 0) {
        args.push('-c', `${prefix}.env=${tomlStringMap(commandEnv)}`)
      }
    } else {
      continue
    }

    if (typeof config.startup_timeout_sec === 'number' && Number.isFinite(config.startup_timeout_sec)) {
      args.push('-c', `${prefix}.startup_timeout_sec=${config.startup_timeout_sec}`)
    }
    if (typeof config.tool_timeout_sec === 'number' && Number.isFinite(config.tool_timeout_sec)) {
      args.push('-c', `${prefix}.tool_timeout_sec=${config.tool_timeout_sec}`)
    }
    serverIndex += 1
  }

  return { args, env }
}

function codexArguments(input: CodexRuntimeQueryOptions): string[] {
  const route = routeFor(input)
  const setting = (key: string, value: string): string[] => ['-c', `${key}=${JSON.stringify(value)}`]
  const mcp = codexMcpLaunchConfiguration(input.mcpServers)
  return [
    ...setting('model_provider', 'proma'),
    ...setting('model', input.modelRoute?.modelId || input.model || ''),
    ...setting('model_providers.proma.name', 'Proma Runtime'),
    ...setting('model_providers.proma.base_url', route.baseUrl),
    ...setting('model_providers.proma.env_key', 'PROMA_RUNTIME_API_KEY'),
    ...setting('model_providers.proma.wire_api', 'responses'),
    // 后台 Codex 的自动压缩：把用户对模型配置的压缩策略同步过去，
    // 达到阈值自动压缩上下文，压缩事件不进入主会话 UI。
    ...codexCompactionSettings(input.modelRoute?.compaction, setting),
    ...mcp.args,
    'app-server',
  ]
}

/**
 * 把 Runtime 压缩策略投影为 Codex 的 `-c` 配置项。
 *
 * model_auto_compact_token_limit：触发自动压缩的 token 阈值（默认 80% × 窗口）；
 * model_context_window：模型上下文窗口，让 Codex 知道何时触发压缩。
 */
export function codexCompactionSettings(
  compaction: RuntimeModelRoute['compaction'] | undefined,
  setting: (key: string, value: string) => string[] = (key, value) => ['-c', `${key}=${JSON.stringify(value)}`],
): string[] {
  if (!compaction) return []
  return [
    ...(compaction.threshold != null
      ? setting('model_auto_compact_token_limit', String(compaction.threshold))
      : []),
    ...(compaction.contextWindow != null
      ? setting('model_context_window', String(compaction.contextWindow))
      : []),
  ]
}

/** Codex 要求 CODEX_HOME 在进程启动前已经存在，否则 app-server 会直接退出。 */
export function prepareCodexRuntimeHome(runtimeHome: string): void {
  mkdirSync(runtimeHome, { recursive: true })
}

function spawnEnvironment(input: CodexRuntimeQueryOptions, runtimeHome: string): Record<string, string> {
  const route = routeFor(input)
  const mcp = codexMcpLaunchConfiguration(input.mcpServers)
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      ...input.env,
      ...mcp.env,
      CODEX_HOME: runtimeHome,
      PROMA_RUNTIME_API_KEY: route.token,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

export class FrakioCodexRuntimeAdapter implements AgentProviderAdapter {
  private readonly sessions = new Map<string, CodexSession>()

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const queue = createQueue()
    void this.run(input as CodexRuntimeQueryOptions, queue)
    return queue.iterable
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.turnId) return
    await this.request(session, 'turn/interrupt', {
      threadId: session.threadId,
      turnId: session.turnId,
    }).catch(() => {})
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.turnState === 'starting') {
      throw new Error('Proma Codex Session 尚未打开。')
    }
    if (!session.threadId || !session.turnId || session.turnState === 'completed') {
      throw new Error('Proma Codex Session 当前没有可介入的活跃 Turn。')
    }
    if (!options?.interrupt) {
      throw new Error('Proma Codex Runtime 暂不支持在当前 Turn 内追加普通等待消息。')
    }

    await this.request(
      session,
      'turn/steer',
      codexQueuedMessageRequest(session.threadId, session.turnId, message),
    )
    options.onAccepted?.()
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex Runtime Session 已关闭。'))
    }
    session.pending.clear()
    session.lines.close()
    if (!session.child.killed) session.child.kill('SIGTERM')
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) void this.closeSession(sessionId)
  }

  private async run(input: CodexRuntimeQueryOptions, queue: MessageQueue): Promise<void> {
    let session: CodexSession | undefined
    try {
      session = await this.startSession(input, queue)
      const thread = input.resumeSessionId
        ? await this.request(session, 'thread/resume', {
            threadId: input.resumeSessionId,
            cwd: input.cwd || process.cwd(),
            model: input.modelRoute?.modelId || input.model,
          }, 60_000)
        : await this.request(session, 'thread/start', {
            cwd: input.cwd || process.cwd(),
            model: input.model,
            approvalPolicy: input.sdkPermissionMode === 'bypassPermissions' ? 'never' : 'on-request',
            sandbox: input.sdkPermissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
            serviceName: 'proma',
          }, 60_000)
      session.threadId = String((thread.thread as Record<string, unknown> | undefined)?.id || input.resumeSessionId || '')
      if (!session.threadId) throw new Error('Codex Runtime 未返回 thread id。')
      input.onSessionId?.(session.threadId)
      const turn = await this.request(session, 'turn/start', {
        threadId: session.threadId,
        input: [{
          type: 'text',
          text: `${typeof input.systemPrompt === 'string' ? input.systemPrompt : input.systemPrompt?.append || ''}\n\n${input.prompt}`,
        }],
        cwd: input.cwd || process.cwd(),
        model: input.modelRoute?.modelId || input.model,
        ...(input.effortLevel && input.effortLevel !== 'default' ? { effort: input.effortLevel } : {}),
        approvalPolicy: input.sdkPermissionMode === 'bypassPermissions' ? 'never' : 'on-request',
        sandboxPolicy: input.sdkPermissionMode === 'bypassPermissions'
          ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [input.cwd || process.cwd()] },
        summary: 'concise',
      }, 60_000)
      session.turnId = String((turn.turn as Record<string, unknown> | undefined)?.id || '')
      if (!session.turnId) throw new Error('Codex Runtime 未返回 turn id。')
      session.turnState = 'active'
      await this.waitForTurn(session, input.sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      queue.push(resultMessage(input.sessionId, '', message))
      // 已通过 result.errors 传递错误详情，正常结束队列，避免上层再走
      // catch 错误链路生成第二条相同错误。
      queue.finish()
      if (session) await this.closeSession(input.sessionId)
    }
  }

  private async startSession(input: CodexRuntimeQueryOptions, queue: MessageQueue): Promise<CodexSession> {
    const runtime = detectRuntime('codex')
    const command = runtime?.installation.executablePath
    if (!command) {
      throw new Error('未发现内置 Codex Runtime。请重新安装 Proma，不要依赖本机 PATH 中的 codex。')
    }
    const runtimeHome = join(getRuntimeSessionsDir(), 'codex', input.sessionId)
    prepareCodexRuntimeHome(runtimeHome)
    const child = spawn(command, codexArguments(input), {
      cwd: input.cwd || process.cwd(),
      env: spawnEnvironment(input, runtimeHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const session: CodexSession = {
      child,
      lines: createInterface({ input: child.stdout }),
      queue,
      threadId: '',
      turnId: '',
      turnState: 'starting',
      output: '',
      pending: new Map(),
      sequence: 0,
      streamUuid: randomUUID(),
      streamMessageId: `codex-${input.sessionId}-${randomUUID()}`,
      itemToolUseIds: new Map(),
      collabThreadToolUseIds: new Map(),
      reasoningStates: new Map(),
    }
    this.sessions.set(input.sessionId, session)
    session.lines.on('line', (line) => this.handleLine(session, input.sessionId, line))
    child.stderr.on('data', (chunk: Buffer) => console.warn(`[Proma Codex Runtime] ${String(chunk).trim()}`))
    child.once('error', (error) => queue.fail(error))
    child.once('exit', (code) => {
      if (code && session.queue) session.queue.fail(new Error(`Codex App Server 已退出，code=${code}`))
    })
    await this.request(session, 'initialize', {
      clientInfo: { name: 'proma', title: 'Proma', version: '0.16.2' },
    }, 30_000)
    this.write(session, { method: 'initialized', params: {} })
    return session
  }

  private waitForTurn(session: CodexSession, sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const poll = (): void => {
        if (!this.sessions.has(sessionId)) {
          reject(new Error('Codex Session 已关闭。'))
          return
        }
        if (!session.turnId) {
          session.queue?.push(resultMessage(sessionId, session.output))
          session.queue?.finish()
          resolve()
          return
        }
        setTimeout(poll, 50)
      }
      poll()
    })
  }

  private handleLine(session: CodexSession, sessionId: string, line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      return
    }
    if (!value || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = session.pending.get(String(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      session.pending.delete(String(message.id))
      if (message.error && typeof message.error === 'object') {
        pending.reject(new Error(String((message.error as Record<string, unknown>).message || 'Codex 请求失败')))
      } else {
        pending.resolve((message.result as Record<string, unknown>) || {})
      }
      return
    }
    const method = String(message.method || '')
    const params = (message.params as Record<string, unknown> | undefined) || {}
   if (method === 'item/agentMessage/delta') {
     const delta = textOf(params.delta)
     session.output += delta
     if (delta) session.queue?.push(streamAssistantMessage(session, sessionId, true))
     return
   }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      this.handleReasoningDelta(session, sessionId, params)
      return
    }
   if (method === 'item/started') {
     this.handleItemStarted(session, sessionId, params)
     return
   }
    if (method === 'item/completed') {
      const item = (params.item as Record<string, unknown> | undefined) || {}
      if (item.type === 'agentMessage' && !session.output) {
        const text = textOf(item.text || item.content)
        session.output = text
        if (text) session.queue?.push(streamAssistantMessage(session, sessionId, false))
        return
      }
      this.handleItemCompleted(session, sessionId, item)
      return
    }
    if (method === 'turn/completed') {
      const turn = (params.turn as Record<string, unknown> | undefined) || {}
      const status = String(turn.status || params.status || 'completed')
      const error = status === 'failed' || status === 'error'
        ? String(((turn.error as Record<string, unknown> | undefined)?.message) || params.error || 'Codex 执行失败')
        : ''
      if (session.output) session.queue?.push(streamAssistantMessage(session, sessionId, false))
      session.queue?.push(resultMessage(sessionId, session.output, error))
      session.queue?.finish()
      session.turnId = ''
      session.turnState = 'completed'
      return
    }
  }

  /**
   * item/started：把 Codex 的执行项（工具调用、子 Agent 派生、命令执行、文件改动、
   * MCP 工具等）映射为 Proma 的 tool_use assistant 消息，接入现有消息流与悬浮面板。
   *
   * 命名对齐 Claude SDK（Bash/Edit/WebSearch/Agent/mcp__server__tool），渲染层零改动。
   * collabAgentToolCall 会建立 子 Agent 线程 id → 父 Agent tool_use id 的映射，
   * 供后续子 Agent 活动归组到父节点下。
   */
  private handleItemStarted(session: CodexSession, sessionId: string, params: Record<string, unknown>): void {
    const item = (params.item as Record<string, unknown> | undefined) || {}
    const type = String(item.type || '')
    // 子 Agent 活动（subAgentActivity）：归组到其父 Agent 节点下展示执行轨迹
    if (type === 'subAgentActivity') {
      this.handleSubAgentActivityItem(session, sessionId, item)
      return
    }
    // 正文 / 思考走各自的流式通道，这里只处理工具与子 Agent 类执行项
    const toolTypes = new Set([
      'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall',
    ])
    if (!toolTypes.has(type)) return

    const itemId = String(item.id || randomUUID())
    const toolUseId = `codex-tool-${itemId}`
    session.itemToolUseIds.set(itemId, toolUseId)

    // 子 Agent 派生：登记 接收方线程 id → 父 Agent tool_use id
    if (type === 'collabAgentToolCall') {
      const receiverIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
      for (const receiverId of receiverIds) {
        if (typeof receiverId === 'string' && receiverId) {
          session.collabThreadToolUseIds.set(receiverId, toolUseId)
        }
      }
    }

    session.queue?.push({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: toolUseId,
          name: codexItemToolName(item),
          input: codexItemToolInput(item),
        }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    } as SDKMessage)
  }

  /**
   * item/completed：回填工具的 tool_result（user 消息），与 item/started 的 tool_use 配对。
   * agentMessage 类型由 handleLine 单独处理（正文终态），这里只处理工具类。
   */
  private handleItemCompleted(session: CodexSession, sessionId: string, item: Record<string, unknown>): void {
   const type = String(item.type || '')
   if (type === 'agentMessage' || type === 'userMessage') return
   const itemId = String(item.id || '')
   const toolUseId = session.itemToolUseIds.get(itemId)
   // 没有对应 tool_use（例如未捕获到 item/started）则跳过，避免悬空 tool_result
   if (!toolUseId) return
   session.itemToolUseIds.delete(itemId)

   session.queue?.push({
     type: 'user',
     message: {
       content: [{
         type: 'tool_result',
         tool_use_id: toolUseId,
         content: codexItemToolResultText(item),
         is_error: codexItemIsError(item),
       }],
     },
     parent_tool_use_id: null,
     session_id: sessionId,
     uuid: randomUUID(),
   } as SDKMessage)
 }

  /**
   * 子 Agent 活动项（subAgentActivity）：将子 Agent 的 started/interacted/interrupted
   * 轨迹归组到其父 Agent（collabAgentToolCall）节点下，供消息流与悬浮面板展示
   * 子 Agent 的执行状态。通过 collabThreadToolUseIds 找到父 Agent 的 tool_use id。
   */
  private handleSubAgentActivityItem(session: CodexSession, sessionId: string, item: Record<string, unknown>): void {
    const agentThreadId = String(item.agentThreadId || '')
    const parentToolUseId = session.collabThreadToolUseIds.get(agentThreadId) ?? null
    const kind = String(item.kind || '')
    const agentPath = String(item.agentPath || '')
    const kindLabel = kind === 'started' ? '启动' : kind === 'interrupted' ? '已中断' : '执行中'
    const label = agentPath ? `子 Agent（${agentPath}）${kindLabel}` : `子 Agent ${kindLabel}`

    session.queue?.push({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: `codex-subagent-${String(item.id || randomUUID())}`,
          name: 'SubAgent',
          input: { description: label, agentThreadId, kind, agentPath },
        }],
      },
      parent_tool_use_id: parentToolUseId,
      session_id: sessionId,
      uuid: randomUUID(),
    } as SDKMessage)
  }

  /**
   * item/reasoning/*Delta：累积 Codex 的思考过程为 thinking block，流式覆盖同一条
   * 消息（固定 uuid + message.id），让渲染层折叠展示思考轨迹。
   */
  private handleReasoningDelta(session: CodexSession, sessionId: string, params: Record<string, unknown>): void {
    const itemId = String(params.itemId || params.id || 'default')
    const delta = textOf(params.delta)
    if (!delta) return
    let state = session.reasoningStates.get(itemId)
    if (!state) {
      state = { text: '', uuid: randomUUID(), messageId: `codex-reasoning-${sessionId}-${randomUUID()}` }
      session.reasoningStates.set(itemId, state)
    }
    state.text += delta
    session.queue?.push({
      type: 'assistant',
      message: { id: state.messageId, content: [{ type: 'thinking', thinking: state.text }] },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: state.uuid,
      _partial: true,
    } as SDKMessage)
  }

  private write(session: CodexSession, message: Record<string, unknown>): void {
    if (!session.child.stdin.writable) throw new Error('Codex App Server stdin 不可写。')
    session.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request(
    session: CodexSession,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const id = `proma_codex_${++session.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new Error(`Codex 请求超时：${method}`))
      }, timeoutMs)
      session.pending.set(id, { resolve, reject, timer })
      this.write(session, { method, id, params })
    })
  }
}
