/**
 * Proma Pi Bridge 适配器。
 *
 * Pi Runtime（pi-bridge + pi-worker + thread-context-v2）已内置到
 * `resources/pi-runtime/`，默认直接使用内置版本；仅当显式配置
 * `PROMA_PI_RUNTIME_PATH` / Runtime 源码目录时才回退到外部路径，
 * 保持工具、Session 和 Pi 原生事件协议一致。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntimeSessionOperationInput,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessageInput,
  SendQueuedMessageOptions,
  PromaRuntimeApiMode,
  ProviderType,
} from '@proma/shared'
import { getRuntimeSessionsDir } from '../config-paths'
import type { RuntimeModelRoute } from '@proma/shared'
import { getRuntimeConfig, isPackagedElectronApp } from './runtime-registry'
import { PiMcpBridge } from './pi-mcp-bridge'
import {
  formatPiMcpDiscoveryResult,
  PI_MCP_CALL_TOOL,
  PI_MCP_DISCOVER_TOOL,
  PI_MCP_GATEWAY_TOOLS,
} from './pi-mcp-tools'
import { canonicalToolError, handlePromaCanonicalTool, isPromaCanonicalTool } from './proma-canonical-tools'
import { isPromaProviderType, resolvePromaRuntimeApiMode } from './proma-runtime-api-mode'
import type { PiAgentQueryOptions as PiRuntimeQueryOptions } from './pi-query-options'
import { piApprovedToolInput, piPermissionTool } from './pi-tool-permission'

interface MessageQueue {
  iterable: AsyncIterable<SDKMessage>
  push(message: SDKMessage): void
  finish(): void
  fail(error: Error): void
}

interface FrakioPiEvent {
  type?: string
  payload?: Record<string, unknown>
}

interface FrakioPiBridge {
  on(event: 'event' | 'exit' | 'sessionDisposed', callback: (value: unknown) => void): void
  startRun(payload: Record<string, unknown>): Promise<Record<string, unknown>>
  steer(sessionId: string, message: string, options?: Record<string, unknown>): Promise<unknown>
  cancel(sessionId: string): Promise<unknown>
  compact(sessionId: string, input?: Record<string, unknown>): Promise<unknown>
  disposeSession(sessionId: string): Promise<unknown>
  close(): Promise<void>
}

interface FrakioPiBridgeModule {
  createPiBridgePool(input: Record<string, unknown>): FrakioPiBridge
}

interface PiRunState {
  token: number
  runId: string
  sessionId: string
  runtimeBuildId: string
  queue: MessageQueue
  stream: PiAssistantMessageStream
  settled: boolean
  lastUsage?: PiUsageSnapshot
  nativeTranscript?: boolean
  canUseTool?: PiRuntimeQueryOptions['canUseTool']
  abortController?: AbortController
  consumedUserIds?: Set<string>
  onNativeMessage?: PiRuntimeQueryOptions['onNativeMessage']
}

function compactTrigger(value: unknown): 'manual' | 'auto' {
  return value === 'threshold'
    || value === 'overflow'
    || value === 'auto_compact_start'
    || value === 'auto_compaction'
    ? 'auto'
    : 'manual'
}

function usageNumber(payload: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  const nested = payload.prompt_tokens_details
  if (nested && typeof nested === 'object') {
    for (const key of keys) {
      const value = (nested as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
  }
  return undefined
}

const PI_REASONING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 有思考档位且不是 off 时打开 Pi 模型 reasoning，才会向网关要思考 summary 流。 */
export function piWorkerModelReasoning(effortLevel?: string): boolean {
  const level = String(effortLevel || 'medium').toLowerCase()
  return PI_REASONING_LEVELS.has(level)
}

export const PI_WORKER_THINKING_LEVEL_MAP = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const

export interface PiUsageSnapshot {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  context_window?: number
}

export function piUsageSnapshot(payload: Record<string, unknown>): PiUsageSnapshot {
  const inputTokens = usageNumber(
    payload,
    'inputTokens',
    'input_tokens',
    'input',
  ) ?? 0
  const outputTokens = usageNumber(
    payload,
    'outputTokens',
    'output_tokens',
    'output',
  ) ?? 0
  const cacheReadTokens = usageNumber(
    payload,
    'cacheReadTokens',
    'cacheRead',
    'cache_read_input_tokens',
    'cached_tokens',
  )
  const cacheWriteTokens = usageNumber(
    payload,
    'cacheWriteTokens',
    'cacheWrite',
    'cache_write_tokens',
    'cache_creation_input_tokens',
  )
  const contextWindow = usageNumber(payload, 'contextWindow', 'context_window')
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheReadTokens != null ? { cache_read_input_tokens: cacheReadTokens } : {}),
    ...(cacheWriteTokens != null ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
    ...(contextWindow != null ? { context_window: contextWindow } : {}),
  }
}


/** 把 Pi 原生 context.compaction.* 事件转换为统一的 SDK system 消息。 */
export function compactionSystemMessage(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
): SDKMessage {
  if (eventType === 'context.compaction.started') {
    return {
      type: 'system',
      subtype: 'compacting',
      session_id: sessionId,
      uuid: randomUUID(),
      compactTrigger: compactTrigger(payload.trigger),
      compactPreTokens: usageNumber(payload, 'tokensBefore', 'preTokens'),
    } as SDKMessage
  }
  if (eventType === 'context.compaction.completed' && payload.noop === true) {
    return {
      type: 'system',
      subtype: 'status',
      session_id: sessionId,
      uuid: randomUUID(),
      compactTrigger: compactTrigger(payload.trigger),
      compact_result: 'noop',
      compact_error: String(payload.reason || '当前上下文无需压缩'),
    } as SDKMessage
  }
  const failed = eventType === 'context.compaction.failed'
  const estimatedTokensAfter = usageNumber(payload, 'tokensAfterEstimate', 'estimatedTokensAfter', 'postTokens')
  const summary = typeof payload.summary === 'string' && payload.summary.trim()
    ? payload.summary
    : undefined
  return {
    type: 'system',
    subtype: failed ? 'status' : 'compact_boundary',
    session_id: sessionId,
    uuid: randomUUID(),
    compactTrigger: compactTrigger(payload.trigger),
    compactPreTokens: usageNumber(payload, 'tokensBefore', 'preTokens'),
    ...(estimatedTokensAfter != null ? { compactionEstimatedTokensAfter: estimatedTokensAfter } : {}),
    ...(summary ? { summary } : {}),
    ...(failed
      ? {
          compact_result: payload.aborted === true ? 'stopped' : 'failed',
          compact_error: String(payload.error || (payload.aborted === true ? '上下文压缩已停止' : '上下文压缩失败')),
        }
      : { compact_metadata: {
          trigger: compactTrigger(payload.trigger),
          pre_tokens: usageNumber(payload, 'tokensBefore', 'preTokens'),
          post_tokens: estimatedTokensAfter,
          ...(summary ? { summary } : {}),
        } }),
  } as SDKMessage
}

/** 把 Pi 原生 context.usage.updated 事件转换为 SDK assistant usage 消息。 */
export function usageSystemMessage(
  sessionId: string,
  payload: Record<string, unknown>,
): SDKMessage {
  const usage = piUsageSnapshot(payload)
  return {
    type: 'assistant',
    message: {
      content: [],
      usage,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  } as SDKMessage
}

/**
 * 把模型路由里的压缩策略转换为 Renderer 可复用的 context_compaction_config
 * system 消息（与 CCB 适配器同一 subtype），供输入框上下文 Usage 徽标展示。
 *
 * 只有 enabled / threshold / contextWindow 三者齐全时才生成；该 subtype 可持久化，
 * 刷新会话后渲染层仍能还原压缩阈值。
 */
export function contextCompactionConfigMessage(
  compilation: NonNullable<RuntimeModelRoute['compaction']> | undefined,
  sessionId: string,
): SDKMessage | undefined {
  if (!compilation?.enabled) return undefined
  const threshold = compilation.threshold
  const contextWindow = compilation.contextWindow
  if (typeof threshold !== 'number' || typeof contextWindow !== 'number') return undefined
  return {
    type: 'system',
    subtype: 'context_compaction_config',
    session_id: sessionId,
    uuid: randomUUID(),
    autoCompactEnabled: true,
    autoCompactThreshold: threshold,
    effectiveContextWindow: contextWindow,
  } as unknown as SDKSystemMessage
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

function thinkingBlock(thinking: string): SDKContentBlock {
  return { type: 'thinking', thinking }
}

interface PiAssistantStreamMessage extends SDKAssistantMessage {
  message: SDKAssistantMessage['message'] & { id: string }
  _partial?: true
  _createdAt?: number
}

function assistantMessage(
  sessionId: string,
  text: string,
  thinking: string,
  partial: boolean,
  uuid: string,
  messageId: string,
  createdAt: number,
): PiAssistantStreamMessage {
  const content: SDKContentBlock[] = []
  if (thinking) content.push(thinkingBlock(thinking))
  if (text) content.push(textBlock(text))
  return {
    type: 'assistant',
    // message.id 是渲染层 liveMessages 去重（removeSupersededPartialMessages）
    // 与 Proma 历史路径 mergePersistedAndLiveMessages 共同的 assistant 身份字段，
    // 同一轮回复 partial 与 final 必须共享同一个 id，否则 token 会被重复落盘 / 铺开渲染。
    message: { id: messageId, content },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid,
    _createdAt: createdAt,
    ...(partial ? { _partial: true } : {}),
  } as PiAssistantStreamMessage
}

export interface PiAssistantMessageStream {
  readonly output: string
  readonly reasoning: string
  appendText(text: string): PiAssistantStreamMessage
  appendReasoning(reasoning: string): PiAssistantStreamMessage
  reconcileText(text: string): PiAssistantStreamMessage | undefined
  reconcileReasoning(reasoning: string): PiAssistantStreamMessage | undefined
  /**
   * 用整轮最终快照校正流式内容。
   *
   * steering 可能让旧 assistant 的最终快照晚于分段事件到达。此时不能把
   * 旧 assistant 缺失的尾部追加到新 assistant，否则旧内容会变成“只显示一部分”
   * 且新回复会混入旧回复。该方法会把缺失内容补回对应的上一段。
   */
  reconcileCumulativeText(text: string): PiAssistantStreamMessage[]
  reconcileCumulativeReasoning(reasoning: string): PiAssistantStreamMessage[]
  flush(usage?: PiUsageSnapshot): PiAssistantStreamMessage | undefined
}

/**
 * 管理单次 Pi run 内的 assistant 分段。
 * 压缩开始前 flush 当前分段，可确保正文先于压缩边界落盘；压缩后继续输出时使用新身份。
 */
export function createPiAssistantMessageStream(sessionId: string): PiAssistantMessageStream {
  let output = ''
  let reasoning = ''
  let segmentOutput = ''
  let segmentReasoning = ''
  let committedOutput = ''
  let committedReasoning = ''
  const committedSegments: Array<{
    uuid: string
    messageId: string
    createdAt: number
    output: string
    reasoning: string
  }> = []
  let messageUuid = randomUUID()
  let messageId = `pi-${sessionId}-${messageUuid}`
  let segmentCreatedAt = Date.now()

  const segmentMessage = (
    segment: {
      uuid: string
      messageId: string
      createdAt: number
      output: string
      reasoning: string
    },
    partial: boolean,
    usage?: PiUsageSnapshot,
  ): PiAssistantStreamMessage => {
    const message = assistantMessage(
      sessionId,
      segment.output,
      segment.reasoning,
      partial,
      segment.uuid,
      segment.messageId,
      segment.createdAt,
    )
    if (!partial && usage) {
      message.message = { ...message.message, usage }
    }
    return message
  }

  const currentMessage = (partial: boolean, usage?: PiUsageSnapshot): PiAssistantStreamMessage => {
    return segmentMessage({
      uuid: messageUuid,
      messageId,
      createdAt: segmentCreatedAt,
      output: segmentOutput,
      reasoning: segmentReasoning,
    }, partial, usage)
  }

  const rotateSegment = (): void => {
    committedSegments.push({
      uuid: messageUuid,
      messageId,
      createdAt: segmentCreatedAt,
      output: segmentOutput,
      reasoning: segmentReasoning,
    })
    committedOutput = output
    committedReasoning = reasoning
    segmentOutput = ''
    segmentReasoning = ''
    messageUuid = randomUUID()
    messageId = `pi-${sessionId}-${messageUuid}`
    segmentCreatedAt = Date.now()
  }

  const reconcile = (
    complete: string,
    current: string,
    committed: string,
    update: (nextComplete: string, nextSegment: string) => void,
  ): PiAssistantStreamMessage | undefined => {
    if (!complete || complete === current) return undefined
    if (complete.startsWith(current)) {
      const suffix = complete.slice(current.length)
      update(complete, `${complete.startsWith(committed) ? complete.slice(committed.length) : ''}`)
      return suffix ? currentMessage(true) : undefined
    }
    update(complete, complete.startsWith(committed) ? complete.slice(committed.length) : complete)
    return currentMessage(true)
  }

  const reconcileCumulative = (
    complete: string,
    kind: 'text' | 'reasoning',
  ): PiAssistantStreamMessage[] => {
    if (!complete) return []
    const current = kind === 'text' ? output : reasoning
    if (complete === current) return []

    const committed = kind === 'text' ? committedOutput : committedReasoning
    const currentSegment = kind === 'text' ? segmentOutput : segmentReasoning
    if (
      committedSegments.length > 0
      && complete.startsWith(committed)
      && complete.endsWith(currentSegment)
      && complete.length >= committed.length + currentSegment.length
    ) {
      const missing = complete.slice(
        committed.length,
        complete.length - currentSegment.length,
      )
      if (missing) {
        const previous = committedSegments.at(-1)!
        if (kind === 'text') previous.output += missing
        else previous.reasoning += missing
        if (kind === 'text') output = complete
        else reasoning = complete

        return [segmentMessage(previous, true)]
      }
    }

    const corrected = kind === 'text'
      ? reconcileTextInternal(complete)
      : reconcileReasoningInternal(complete)
    return corrected ? [corrected] : []
  }

  const reconcileTextInternal = (text: string): PiAssistantStreamMessage | undefined =>
    reconcile(text, output, committedOutput, (nextOutput, nextSegment) => {
      output = nextOutput
      segmentOutput = nextSegment
    })

  const reconcileReasoningInternal = (completeReasoning: string): PiAssistantStreamMessage | undefined =>
    reconcile(completeReasoning, reasoning, committedReasoning, (nextReasoning, nextSegment) => {
      reasoning = nextReasoning
      segmentReasoning = nextSegment
    })

  return {
    get output() {
      return output
    },
    get reasoning() {
      return reasoning
    },
    appendText(text) {
      output += text
      segmentOutput += text
      return currentMessage(true)
    },
    appendReasoning(delta) {
      reasoning += delta
      segmentReasoning += delta
      return currentMessage(true)
    },
    reconcileText(text) {
      return reconcileTextInternal(text)
    },
    reconcileReasoning(completeReasoning) {
      return reconcileReasoningInternal(completeReasoning)
    },
    reconcileCumulativeText(text) {
      return reconcileCumulative(text, 'text')
    },
    reconcileCumulativeReasoning(completeReasoning) {
      return reconcileCumulative(completeReasoning, 'reasoning')
    },
    flush(usage?: PiUsageSnapshot) {
      if (!segmentOutput && !segmentReasoning) return undefined
      const message = currentMessage(false, usage)
      rotateSegment()
      return message
    },
  }
}

export function resultMessage(
  sessionId: string,
  output: string,
  error = '',
  usage?: PiUsageSnapshot,
): SDKMessage {
  return {
    type: 'result',
    subtype: error ? 'error_during_execution' : 'success',
    result: output,
    errors: error ? [error] : undefined,
    usage: usage ?? { input_tokens: 0, output_tokens: 0 },
    session_id: sessionId,
  } as SDKMessage
}

function eventText(payload: Record<string, unknown>): string {
  return typeof payload.delta === 'string'
    ? payload.delta
    : typeof payload.text === 'string' ? payload.text : ''
}

function providerFor(env: Record<string, string | undefined>): ProviderType | null {
  const provider = env.PROMA_RUNTIME_MODEL_PROVIDER
    || env.PROMA_MODEL_CENTER_PROVIDER
    || env.FRAKIO_MODEL_CENTER_PROVIDER
    || ''
  return isPromaProviderType(provider) ? provider : null
}

function piProtocolMissing(): Error {
  return Object.assign(
    new Error('PI_MODEL_PROTOCOL_MISSING: Pi 缺少模型中心明确供应商协议，无法安全选择 API。'),
    { code: 'PI_MODEL_PROTOCOL_MISSING' },
  )
}

export interface ResolvedPiModelRoute {
  provider: ProviderType
  apiMode: Exclude<PromaRuntimeApiMode, 'legacy-compat'>
  routeRevision: string
  credentialRevision: string
}

export function resolvePiModelRoute(
  input: PiRuntimeQueryOptions,
  env: Record<string, string | undefined>,
): ResolvedPiModelRoute {
  if (input.modelRoute && input.modelRoute.apiMode !== 'legacy-compat') {
    if (!isPromaProviderType(input.modelRoute.provider)) throw piProtocolMissing()
    const apiMode = resolvePromaRuntimeApiMode(input.modelRoute.provider)
    if (input.modelRoute.apiMode !== apiMode) {
      throw Object.assign(
        new Error(
          `PI_MODEL_PROTOCOL_MISMATCH: 模型中心供应商协议 ${input.modelRoute.provider} `
          + `必须使用 ${apiMode}，实际收到 ${input.modelRoute.apiMode}。`,
        ),
        { code: 'PI_MODEL_PROTOCOL_MISMATCH' },
      )
    }
    return {
      provider: input.modelRoute.provider,
      apiMode,
      routeRevision: input.modelRoute.routeRevision,
      credentialRevision: input.modelRoute.credentialRevision,
    }
  }
  const provider = providerFor(env)
  if (!provider) throw piProtocolMissing()
  const apiMode = resolvePromaRuntimeApiMode(provider)
  return {
    provider,
    apiMode,
    routeRevision: `legacy-env:${provider}:${input.model || 'default'}`,
    credentialRevision: 'legacy-env',
  }
}

function systemPromptText(value: PiRuntimeQueryOptions['systemPrompt']): string {
  return value || ''
}

export interface PiWorkerSessionIdentity {
  profileSnapshot: {
    name: 'Proma'
    role: string
    soul: string
    scope: string
    revision: string
  }
  hostSystemPrompt: string
}

/** Pi Worker 的模型可见身份固定为 Proma，用户名只出现在 Context Packet 的 profile 里。 */
export function piWorkerSessionIdentity(input: {
  contextPacket?: { packetId?: string } | null
  systemPrompt?: PiRuntimeQueryOptions['systemPrompt']
}): PiWorkerSessionIdentity {
  void input.contextPacket
  return {
    profileSnapshot: {
      name: 'Proma',
      role: 'Proma Pi 基础内核',
      soul: '遵循 Proma System Prompt 和 Hermes 策略路由。',
      scope: '普通对话、需求澄清和最终结果汇总。',
      // 固定 revision，避免每轮 packetId UUID 打穿 prompt cache 前缀。
      revision: 'proma',
    },
    hostSystemPrompt: systemPromptText(input.systemPrompt),
  }
}

function findPiWorkerCompatShim(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'pi-worker-compat.cjs') : '',
    join(__dirname, 'resources', 'pi-worker-compat.cjs'),
    join(process.cwd(), 'resources', 'pi-worker-compat.cjs'),
    join(process.cwd(), 'apps', 'electron', 'resources', 'pi-worker-compat.cjs'),
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) || null
}

/**
 * 解析内置 Pi Runtime 目录（pi-bridge.mjs 所在目录）。
 *
 * 优先使用显式覆盖（PROMA_PI_RUNTIME_PATH / Runtime 源码目录），
 * 否则回退到内置 `resources/pi-runtime/`。与 ccb-runtime 的双模式定位一致：
 * - 生产：`process.resourcesPath/pi-runtime`
 * - 开发：`apps/electron/resources/pi-runtime`（build:resources 复制到 dist/resources/）
 */
function resolvePiRuntimeDir(config: { runtimeSourceHome?: string | null; frakioSourceHome?: string | null }): string {
  const bundledCandidates = [
    process.resourcesPath ? join(process.resourcesPath, 'pi-runtime') : '',
    join(__dirname, 'resources', 'pi-runtime'),
    join(process.cwd(), 'resources', 'pi-runtime'),
    join(process.cwd(), 'apps', 'electron', 'resources', 'pi-runtime'),
  ].filter(Boolean)
  const bundled = bundledCandidates.find((candidate) => existsSync(join(candidate, 'pi-bridge.mjs')))
  if (isPackagedElectronApp()) {
    if (!bundled) {
      throw new Error('未找到 Proma 内置 Pi Worker。请重新安装应用，不要依赖本机 PATH 或旧 Frakio 源码目录。')
    }
    return bundled
  }
  const override = process.env.PROMA_PI_RUNTIME_PATH?.trim()
  if (override) {
    const dir = isAbsolute(override) ? override : resolve(override)
    if (existsSync(join(dir, 'pi-bridge.mjs'))) return dir
  }
  // 开发环境才允许指向外部 Runtime 源码；安装包必须使用 extraResources 内的 Worker。
  const sourceHome = config.runtimeSourceHome || config.frakioSourceHome || ''
  if (sourceHome) {
    const externalDir = join(sourceHome, 'apps', 'api', 'runtime')
    if (existsSync(join(externalDir, 'pi-bridge.mjs'))) return externalDir
  }
  return bundled || bundledCandidates[0] || ''
}

/**
 * 解析 Pi Worker 加载 @earendil-works/* / typebox 等 npm 包时的根目录。
 * Worker 内部用 `<runtimeRoot>/node_modules/<pkg>` 解析依赖，因此这里返回
 * 应用 node_modules 的上级目录。内置模式下这些依赖随应用 node_modules 分发。
 */
function hasBundledPi(root: string): boolean {
  return existsSync(join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'))
}

function resolvePiDependencyRoot(configuredHome: string): string {
  const override = process.env.PROMA_PI_DEPENDENCY_ROOT?.trim()
  if (override && !isPackagedElectronApp()) {
    return isAbsolute(override) ? override : resolve(override)
  }
  const packagedCandidates = [
    // 生产：fork 的 Worker 无法读取 ASAR 内文件，必须使用 ASAR 外的
    // app.asar.unpacked/node_modules（@earendil-works/* 已在 asarUnpack 列出）。
    process.resourcesPath ? join(process.resourcesPath, 'app.asar.unpacked') : '',
    // 生产回退：非 ASAR 分发时的 app/node_modules
    process.resourcesPath ? join(process.resourcesPath, 'app') : '',
  ].filter(Boolean)
  const packaged = packagedCandidates.find((candidate) => hasBundledPi(candidate))
  if (packaged) return packaged
  if (isPackagedElectronApp()) {
    throw new Error('未找到 Proma 内置 Pi Runtime。请重新安装应用，不要依赖本机 PATH 中的 pi。')
  }
  const devCandidates = [
    join(process.cwd(), 'apps', 'electron'),
    join(process.cwd(), '..', '..'),
    join(__dirname, '..', '..', '..'),
    process.cwd(),
    configuredHome,
  ].filter(Boolean)
  const found = devCandidates.find((candidate) => hasBundledPi(candidate))
  if (!found) {
    throw new Error('未找到 Proma 内置 Pi Runtime。开发环境请安装 @earendil-works/pi-coding-agent。')
  }
  return found
}

function readPiCodingAgentVersion(runtimeDir: string): string {
  const packageJsonPath = join(runtimeDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error(`未找到内置 Pi Runtime：${packageJsonPath}。请重新安装 Proma，不要依赖本机 PATH 中的 pi。`)
  }
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string }
  const version = String(manifest.version || '').trim()
  if (!version) {
    throw new Error(`内置 Pi Runtime 缺少 version 字段：${packageJsonPath}`)
  }
  return version
}

export interface PiWorkerRuntimeBinding {
  runtimeDir: string
  runtimeVersion: string
  runtimeBuildId: string
  adapterProtocolVersion: 1
}

/**
 * Worker 的 expected 版本只能来自即将加载的目录里的 package.json。
 * 不能用 PATH、Runtime Center 激活包或 FRAKIO_PI_RUNTIME_VERSION：
 * 用户本机可能没装 pi，也可能是另一个版本。
 */
export function resolvePiWorkerRuntimeBinding(runtimeHome = ''): PiWorkerRuntimeBinding {
  const runtimeDir = resolvePiDependencyRoot(runtimeHome)
  const runtimeVersion = readPiCodingAgentVersion(runtimeDir)
  return {
    runtimeDir,
    runtimeVersion,
    runtimeBuildId: `pi-bundled-${runtimeVersion}`,
    adapterProtocolVersion: 1,
  }
}

function withPiWorkerCompatShim(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const shimPath = findPiWorkerCompatShim()
  if (!shimPath) return env
  return {
    ...env,
    PROMA_PI_WORKER_REQUIRE_PATH: shimPath,
  }
}

export class FrakioPiRuntimeAdapter implements AgentProviderAdapter {
  private bridgePool: FrakioPiBridge | null = null
  private bridgePoolModulePath = ''
  private readonly mcpBridges = new Map<string, PiMcpBridge>()
  private readonly runStates = new Map<string, PiRunState>()
  private readonly sessionRuns = new Map<string, string>()
  private readonly startingSessions = new Set<string>()
  private readonly workspaceSlugs = new Map<string, string>()
  private runGeneration = 0
  /** sessionId → Pi 原生 sessionFile 路径，用于跨轮/跨进程恢复 Pi 会话历史 */
  private readonly sessionFiles = new Map<string, string>()
  private sessionFilesLoaded = false
  private readonly pendingUsers = new Map<string, {
    sessionId: string
    promise: Promise<void>
    resolve(): void
    reject(error: Error): void
  }>()

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const queue = createQueue()
    this.startingSessions.add(input.sessionId)
    void this.run(input as PiRuntimeQueryOptions, queue)
    return queue.iterable
  }

  async abort(sessionId: string): Promise<void> {
    const runId = this.sessionRuns.get(sessionId)
    if (runId) this.runStates.get(runId)?.abortController?.abort()
    await this.bridgePool?.cancel(sessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    const runId = this.sessionRuns.get(sessionId)
    if (runId) {
      const state = this.runStates.get(runId)
      if (state && !state.settled) this.finishRun(state, '已取消')
      this.runStates.delete(runId)
      this.sessionRuns.delete(sessionId)
    }
    await this.bridgePool?.disposeSession(sessionId).catch(() => {})
    this.workspaceSlugs.delete(sessionId)
    const mcpBridge = this.mcpBridges.get(sessionId)
    if (mcpBridge) {
      await mcpBridge.dispose().catch(() => {})
      this.mcpBridges.delete(sessionId)
    }
  }

  async interruptQuery(sessionId: string): Promise<void> {
    await this.abort(sessionId)
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    if (!this.bridgePool) throw new Error('Proma Pi Session 尚未打开。')
    const runId = this.sessionRuns.get(sessionId)
    if (!runId && this.startingSessions.has(sessionId)) throw new Error('Pi session is not active.')
    if (!runId || !this.runStates.has(runId)) throw new Error('Pi turn already finished.')
    const uuid = message.uuid || randomUUID()
    if (this.runStates.get(runId)?.consumedUserIds?.has(uuid)) return
    const key = `${sessionId}:${uuid}`
    const existing = this.pendingUsers.get(key)
    if (existing) return existing.promise
    const pending = Promise.withResolvers<void>()
    // 原生消费/结束事件可能先于 IPC 的入队响应到达；提前挂接拒绝处理，
    // 返回的原始 Promise 仍把失败交给调用者恢复队列。
    void pending.promise.catch(() => {})
    this.pendingUsers.set(key, { ...pending, sessionId })
    // Worker 在原生 message_end(user) 确认消费后才完成投递；停止/失败时
    // 未被消费的消息返回 UI 队列，不能将“入队成功”误报成“已发送”。
    try {
      await this.bridgePool.steer(sessionId, message.message.content, {
        uuid,
        rawText: message.rawText ?? message.message.content,
        interrupt: options?.interrupt ?? true,
      })
      options?.onAccepted?.()
    } catch (error) {
      this.pendingUsers.delete(key)
      pending.reject(error)
      throw error
    }
    return pending.promise
  }

  async compactSession(input: AgentRuntimeSessionOperationInput, instructions?: string): Promise<void> {
    if (!this.bridgePool) throw new Error('Proma Pi Session 尚未打开。')
    await this.bridgePool.compact(input.sessionId, { instructions: instructions || '' })
  }

  private sessionFilesPath(): string {
    return join(getRuntimeSessionsDir(), 'pi', 'session-files.json')
  }

  private loadSessionFiles(): void {
    if (this.sessionFilesLoaded) return
    this.sessionFilesLoaded = true
    try {
      const filePath = this.sessionFilesPath()
      if (!existsSync(filePath)) return
      const data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>
      for (const [sessionId, sessionFile] of Object.entries(data)) {
        if (typeof sessionFile === 'string' && existsSync(sessionFile)) {
          this.sessionFiles.set(sessionId, sessionFile)
        }
      }
    } catch { /* 读取失败则视为无历史，正常新建 */ }
  }

  private persistSessionFiles(): void {
    try {
      const filePath = this.sessionFilesPath()
      mkdirSync(join(getRuntimeSessionsDir(), 'pi'), { recursive: true })
      writeFileSync(filePath, JSON.stringify(Object.fromEntries(this.sessionFiles), null, 2), 'utf8')
    } catch { /* 持久化失败不影响主流程 */ }
  }

  async dispose(): Promise<void> {
    for (const state of this.runStates.values()) {
      if (!state.settled) this.finishRun(state, '应用正在退出')
    }
    const mcpClosures = [...this.mcpBridges.values()].map((bridge) => bridge.dispose().catch(() => {}))
    this.mcpBridges.clear()
    this.workspaceSlugs.clear()
    this.sessionRuns.clear()
    this.runStates.clear()
    const pool = this.bridgePool
    this.bridgePool = null
    this.bridgePoolModulePath = ''
    await Promise.all([
      ...mcpClosures,
      pool?.close().catch(() => {}),
    ])
  }

  private finishRun(
    state: PiRunState,
    error = '',
    payload: Record<string, unknown> = {},
  ): void {
    if (state.settled) return
    state.settled = true
    state.abortController?.abort()
    const finalReasoning = typeof payload.reasoning === 'string' ? payload.reasoning : ''
    const finalOutput = typeof payload.output === 'string' ? payload.output : ''
    if (!state.nativeTranscript) {
      for (const correction of state.stream.reconcileCumulativeReasoning(finalReasoning)) {
        state.queue.push(correction)
      }
      for (const correction of state.stream.reconcileCumulativeText(finalOutput)) {
        state.queue.push(correction)
      }
      const finalAssistant = state.stream.flush(state.lastUsage)
      if (finalAssistant) state.queue.push(finalAssistant)
    }
    const result = resultMessage(state.sessionId, finalOutput || state.stream.output, error, state.lastUsage)
    if (state.nativeTranscript) {
      Object.assign(result, { _promaNativeMessage: true, _createdAt: Date.now(), uuid: randomUUID() })
    }
    state.queue.push(result)
    state.queue.finish()
    for (const [key, pending] of this.pendingUsers) {
      if (pending.sessionId !== state.sessionId) continue
      this.pendingUsers.delete(key)
      pending.reject(new Error(error || 'Pi 运行已结束，队列消息尚未消费。'))
    }
    this.runStates.delete(state.runId)
    if (this.sessionRuns.get(state.sessionId) === state.runId) {
      this.sessionRuns.delete(state.sessionId)
    }
  }

  private async handleToolRequest(
    name: string,
    params: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionId = String(context.sessionId || '')
    if (!sessionId) throw new Error('Pi 工具请求缺少 sessionId，已拒绝执行以避免串会话。')
    const runId = this.sessionRuns.get(sessionId)
    const run = runId ? this.runStates.get(runId) : undefined
    if (!run || run.settled || String(context.runId || '') !== run.runId) {
      throw new Error('Pi 工具请求不属于当前活跃运行，已拒绝执行。')
    }
    if (name === 'proma_permission_check') {
      if (!run.canUseTool || !run.abortController) {
        return { behavior: 'deny', message: 'Pi 运行未配置工具权限处理器。' }
      }
      const toolName = String(params.toolName || '')
      const toolInput = params.input && typeof params.input === 'object'
        ? params.input as Record<string, unknown>
        : {}
      // 通用调用入口不能成为权限后门：审批真实工具及其参数，而不是网关名称。
      const permissionTool = toolName === PI_MCP_CALL_TOOL
        ? this.mcpBridges.get(sessionId)?.resolveToolCall(toolInput)
        : piPermissionTool(toolName, toolInput)
      if (!permissionTool) throw new Error('MCP 会话不可用，请重新发现目标工具。')
      const result = await run.canUseTool(permissionTool.name, permissionTool.input, {
        signal: run.abortController.signal,
        toolUseID: String(params.toolCallId || ''),
        mcpReadOnly: 'mcpReadOnly' in permissionTool && permissionTool.mcpReadOnly === true,
      })
      return result.behavior === 'allow' && result.updatedInput
        ? {
            ...result,
            updatedInput: toolName === PI_MCP_CALL_TOOL
              ? { ...toolInput, arguments: result.updatedInput }
              : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'].includes(toolName)
                ? piApprovedToolInput(result.updatedInput)
                : result.updatedInput,
          }
        : result
    }
    if (isPromaCanonicalTool(name) && name !== PI_MCP_DISCOVER_TOOL && name !== PI_MCP_CALL_TOOL) {
      try {
        return await handlePromaCanonicalTool(name, params, {
          sessionId,
          workspaceSlug: this.workspaceSlugs.get(sessionId) || '',
        })
      } catch (error) {
        throw new Error(canonicalToolError(error))
      }
    }
    const mcpBridge = this.mcpBridges.get(sessionId)
    if (!mcpBridge) throw new Error(`Pi Session ${sessionId} 的 MCP 工具上下文不可用。`)
    if (name === PI_MCP_DISCOVER_TOOL) {
      if (params.server !== undefined && typeof params.server !== 'string') throw new Error('MCP server 必须为目录中的服务名称。')
      const server = params.server as string | undefined
      if (!server) return mcpBridge.discover()
      return formatPiMcpDiscoveryResult(server, await mcpBridge.discover(server))
    }
    if (name === PI_MCP_CALL_TOOL) return mcpBridge.call(params)
    throw new Error(`未注册的 Pi 外部工具：${name}。请通过 MCP 发现和调用入口使用。`)
  }

  private handleBridgeEvent(value: unknown): void {
    const message = value as { runId?: string; event?: FrakioPiEvent }
    const runId = String(message.runId || '')
    const state = this.runStates.get(runId)
    if (!state || state.settled) return
    const event = message.event
    const payload = event?.payload || {}
    if (event?.type === 'transcript.message') {
      const nativeMessage = payload.message
      if (!nativeMessage || typeof nativeMessage !== 'object') return
      const record = nativeMessage as Record<string, unknown>
      if (record._promaNativeMessage !== true || typeof record.uuid !== 'string') return
      if (record.session_id !== state.sessionId) return
      if (!['assistant', 'user'].includes(String(record.type))) return
      state.nativeTranscript = true
      if (record._partial !== true) {
        try {
          state.onNativeMessage?.(nativeMessage as SDKMessage)
        } catch (error) {
          void this.bridgePool?.cancel(state.sessionId).catch(() => {})
          this.finishRun(state, `Pi 消息保存失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
      state.queue.push(nativeMessage as SDKMessage)
      if (record._promaQueuedDuringStreaming === true) {
        state.consumedUserIds ??= new Set()
        state.consumedUserIds.add(record.uuid)
        const key = `${state.sessionId}:${record.uuid}`
        this.pendingUsers.get(key)?.resolve()
        this.pendingUsers.delete(key)
      }
    } else if (event?.type === 'context.compaction.started') {
      const finalAssistant = state.stream.flush(state.lastUsage)
      if (finalAssistant) state.queue.push(finalAssistant)
      this.publishNativeStatus(state, compactionSystemMessage(state.sessionId, event.type, payload))
    } else if (
      event?.type === 'context.compaction.completed'
      || event?.type === 'context.compaction.failed'
    ) {
      this.publishNativeStatus(state, compactionSystemMessage(state.sessionId, event.type, payload))
    } else if (event?.type === 'context.usage.updated') {
      state.lastUsage = piUsageSnapshot(payload)
      state.queue.push(usageSystemMessage(state.sessionId, payload))
    } else if (event?.type === 'run.turn.started') {
      // steering 的消息真正进入 Pi 上下文时才切换分段；不能在
      // steer() 仅入队时切换，否则旧模型尚未结束的输出会被误归到新回复。
      const finalAssistant = state.stream.flush(state.lastUsage)
      if (finalAssistant) state.queue.push(finalAssistant)
    } else if (
      event?.type === 'message.delta'
      || event?.type === 'reasoning.delta'
      || event?.type === 'reasoning.summary'
    ) {
      const text = eventText(payload)
      if (text) {
        state.queue.push(event.type === 'reasoning.delta' || event.type === 'reasoning.summary'
          ? state.stream.appendReasoning(text)
          : state.stream.appendText(text))
      }
    } else if (event?.type === 'tool.started') {
      // 工具调用会切断 Pi 的 assistant 消息。必须先固化工具前的过程正文，
      // 让工具后的最终正文使用新的 assistant 身份并排在工具之后。
      // 否则同 UUID partial 会一直原位更新在工具之前，Renderer 无法判断
      // 后续正文已经进入最终回答阶段，思考面板也就不能及时隐藏。
      const assistantBeforeTool = state.stream.flush(state.lastUsage)
      if (assistantBeforeTool) state.queue.push(assistantBeforeTool)
      state.queue.push({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: String(payload.toolCallId || randomUUID()),
            name: String(payload.toolName || 'Pi Tool'),
            input: (payload.args && typeof payload.args === 'object' ? payload.args : {}) as Record<string, unknown>,
          }],
        },
        parent_tool_use_id: null,
        session_id: state.sessionId,
        uuid: randomUUID(),
      } as SDKMessage)
    } else if (event?.type === 'tool.completed') {
      state.queue.push({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: String(payload.toolCallId || randomUUID()),
            content: String(payload.resultPreview || ''),
            is_error: Boolean(payload.isError),
          }],
        },
        parent_tool_use_id: null,
        session_id: state.sessionId,
        uuid: randomUUID(),
      } as SDKMessage)
    } else if (
      event?.type === 'run.completed'
      || event?.type === 'run.failed'
      || event?.type === 'run.cancelled'
    ) {
      this.finishRun(state, String(payload.error || ''), payload)
    }
  }

  private publishNativeStatus(state: PiRunState, message: SDKMessage): void {
    Object.assign(message, { _promaNativeMessage: true, _createdAt: Date.now() })
    try {
      // 压缩状态也按 Worker 事件顺序落盘，不能延迟到最终回答之后。
      state.onNativeMessage?.(message)
      state.queue.push(message)
    } catch (error) {
      void this.bridgePool?.cancel(state.sessionId).catch(() => {})
      this.finishRun(state, `Pi 消息保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private handleBridgeExit(value: unknown): void {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const binding = record.runtimeBinding && typeof record.runtimeBinding === 'object'
      ? record.runtimeBinding as Record<string, unknown>
      : {}
    const runtimeBuildId = String(binding.runtimeBuildId || '')
    const rawError = record.error
    const error = rawError instanceof Error ? rawError : new Error('Proma Pi Worker 已退出。')
    for (const state of [...this.runStates.values()]) {
      if (!runtimeBuildId || state.runtimeBuildId === runtimeBuildId) {
        this.finishRun(state, error.message)
      }
    }
  }

  private ensureBridgePool(
    bridgeModulePath: string,
    module: FrakioPiBridgeModule,
    bridgeEnv: Record<string, string | undefined>,
  ): FrakioPiBridge {
    if (this.bridgePool && this.bridgePoolModulePath === bridgeModulePath) return this.bridgePool
    const oldPool = this.bridgePool
    if (oldPool) void oldPool.close()
    const pool = module.createPiBridgePool({
      env: bridgeEnv,
      toolHandler: (
        name: string,
        params: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => this.handleToolRequest(name, params, context),
    })
    pool.on('event', (value) => this.handleBridgeEvent(value))
    pool.on('exit', (value) => this.handleBridgeExit(value))
    pool.on('sessionDisposed', (value) => {
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const sessionId = String(record.sessionId || '')
      const mcpBridge = this.mcpBridges.get(sessionId)
      if (mcpBridge) {
        this.mcpBridges.delete(sessionId)
        void mcpBridge.dispose().catch(() => {})
      }
      this.workspaceSlugs.delete(sessionId)
    })
    this.bridgePool = pool
    this.bridgePoolModulePath = bridgeModulePath
    return pool
  }

  private async run(input: PiRuntimeQueryOptions, queue: MessageQueue): Promise<void> {
    this.loadSessionFiles()
    try {
      const config = getRuntimeConfig()
      const runtimeDir = resolvePiRuntimeDir(config)
      const bridgeModulePath = join(runtimeDir, 'pi-bridge.mjs')
      if (!existsSync(bridgeModulePath)) {
        queue.fail(new Error(`未找到 Proma Pi Bridge：${bridgeModulePath}`))
        return
      }
      const module = await import(pathToFileURL(bridgeModulePath).href) as unknown as FrakioPiBridgeModule
      const env = input.env || {}
      const modelRoute = resolvePiModelRoute(input, env)
      const binding = resolvePiWorkerRuntimeBinding(config.runtimeHome || '')
      const bridgeEnv = withPiWorkerCompatShim({
        PROMA_RUNTIME_HOME: config.runtimeHome || '',
        ...(env.PROMA_RUNTIME_API_KEY ? { PROMA_RUNTIME_API_KEY: env.PROMA_RUNTIME_API_KEY } : {}),
        ...(env.FRAKIO_RUNTIME_TOKEN ? { FRAKIO_RUNTIME_TOKEN: env.FRAKIO_RUNTIME_TOKEN } : {}),
      })
      // 首轮只配置服务目录；真正发现服务时才初始化，普通聊天不等待任何 MCP。
      const mcpBridge = this.mcpBridges.get(input.sessionId) || new PiMcpBridge()
      mcpBridge.configure(input.mcpServers)
      const externalTools = PI_MCP_GATEWAY_TOOLS
      const workspaceSlug = input.contextPacket?.workspace?.slug || ''
      this.workspaceSlugs.set(input.sessionId, workspaceSlug)
      const existingRunId = this.sessionRuns.get(input.sessionId)
      const existingRun = existingRunId ? this.runStates.get(existingRunId) : undefined
      if (existingRun && !existingRun.settled) {
        this.finishRun(existingRun, '已取消')
        await this.bridgePool?.cancel(input.sessionId).catch(() => {})
      }
      const bridge = this.ensureBridgePool(bridgeModulePath, module, bridgeEnv)
      this.mcpBridges.set(input.sessionId, mcpBridge)
      // 把模型路由里的压缩策略作为可持久化的 system 消息先推给主进程，
      // 让输入框上下文 Usage 徽标能读取（与 CCB 适配器行为对齐）；
      // 刷新会话后该消息仍在 JSONL 中，压缩阈值不会丢失。
      const compactionConfigMessage = contextCompactionConfigMessage(
        input.modelRoute?.compaction,
        input.sessionId,
      )
      if (compactionConfigMessage) {
        Object.assign(compactionConfigMessage, { _promaNativeMessage: true, _createdAt: Date.now() })
        input.onNativeMessage?.(compactionConfigMessage)
        queue.push(compactionConfigMessage)
      }
      const piSessionRoot = join(getRuntimeSessionsDir(), 'pi', 'sessions')
      const piAgentDir = join(getRuntimeSessionsDir(), 'pi', 'agents', input.sessionId)
      const token = ++this.runGeneration
      const runState: PiRunState = {
        token,
        runId: `${input.sessionId}:${token}`,
        sessionId: input.sessionId,
        runtimeBuildId: binding.runtimeBuildId,
        queue,
        stream: createPiAssistantMessageStream(input.sessionId),
        settled: false,
        canUseTool: input.canUseTool,
        abortController: new AbortController(),
        onNativeMessage: input.onNativeMessage,
      }
      this.runStates.set(runState.runId, runState)
      this.sessionRuns.set(input.sessionId, runState.runId)
      this.startingSessions.delete(input.sessionId)
      const accepted = await bridge.startRun({
        runId: runState.runId,
        sessionId: input.sessionId,
        routeRevision: modelRoute.routeRevision,
        credentialRevision: modelRoute.credentialRevision,
        apiMode: modelRoute.apiMode,
        modelId: input.modelRoute?.modelId || input.model || 'default',
        runtimeBinding: {
          runtimeId: 'pi',
          runtimeVersion: binding.runtimeVersion,
          runtimeBuildId: binding.runtimeBuildId,
          runtimeDir: binding.runtimeDir,
          adapterProtocolVersion: binding.adapterProtocolVersion,
        },
        threadId: input.sessionId,
        cwd: input.cwd || process.cwd(),
        // Proma Pi Worker 会在启动时用这两个目录创建 auth.json 和原生
        // Session 文件；缺失时 path.resolve(undefined) 会直接让 Worker 失败。
        agentDir: piAgentDir,
        sessionRoot: piSessionRoot,
        // 已有历史时传 sessionFile，让 Pi 用 SessionManager.open 恢复上下文（否则每轮都是空会话）
        ...(this.sessionFiles.get(input.sessionId) ? { sessionFile: this.sessionFiles.get(input.sessionId) } : {}),
        // Pi Worker 已通过 systemPromptOverride 接收 Proma System Prompt，
        // Context Packet 也通过 contextPacket 单独注入；这里仅传本轮用户指令，
        // 避免每轮把两份完整上下文再次写进 Pi 原生会话。
        prompt: input.compactRequest ? '' : input.prompt,
        compactOnly: input.compactRequest === true,
        historyMessages: input.historyMessages,
        thinkingLevel: input.effortLevel || 'medium',
        // Proma MCP 工具（collaboration 子 Agent delegate_* 等）暴露给 Pi Worker。
        externalTools,
        mcpCatalog: mcpBridge.catalog(),
        mcpDiscoveredTools: mcpBridge.discoveredTools(),
        workspaceId: workspaceSlug,
        ...piWorkerSessionIdentity(input),
        model: {
          providerId: modelRoute.provider,
          modelId: input.modelRoute?.modelId || input.model || 'default',
          modelName: input.modelRoute?.modelId || input.model || 'default',
          apiMode: modelRoute.apiMode,
          baseUrl: input.modelRoute?.baseUrl
            || env.PROMA_RUNTIME_MODEL_BASE_URL
            || env.PROMA_MODEL_CENTER_PROVIDER_BASE_URL
            || env.FRAKIO_MODEL_CENTER_PROVIDER_BASE_URL
            || env.FRAKIO_MODEL_ROUTE_BASE_URL
            || env.OPENAI_BASE_URL
            || env.ANTHROPIC_BASE_URL
            || env.GEMINI_BASE_URL
            || config.frakioApiBaseUrl
            || '',
          apiKey: env.PROMA_RUNTIME_API_KEY
            || env.FRAKIO_RUNTIME_TOKEN
            || env.OPENAI_API_KEY
            || env.ANTHROPIC_API_KEY
            || env.ANTHROPIC_AUTH_TOKEN
            || env.GEMINI_API_KEY
            || env.GOOGLE_API_KEY
            || '',
          // 把用户对模型配置的压缩阈值同步给后台 Pi 内核，让后台任务按同样阈值
          // 自动压缩；压缩事件不进入主会话 UI，只保证运行期上下文不超限。
          compaction: input.modelRoute?.compaction,
          // 模型上下文窗口：优先取压缩策略里的 contextWindow（来自渠道模型配置），
          // 让 Pi 内核按真实窗口计算压缩触发点，而不是用 worker 兜底的 128K。
          contextWindow: input.modelRoute?.compaction?.contextWindow,
          reasoning: piWorkerModelReasoning(input.effortLevel),
          thinkingLevelMap: PI_WORKER_THINKING_LEVEL_MAP,
        },
        contextPacket: input.contextPacket || {
          dispatchPolicy: { instruction: systemPromptText(input.systemPrompt) },
        },
      })
      const acceptedSessionFile = typeof accepted.sessionFile === 'string' && accepted.sessionFile ? accepted.sessionFile : ''
      if (acceptedSessionFile && this.sessionFiles.get(input.sessionId) !== acceptedSessionFile) {
        this.sessionFiles.set(input.sessionId, acceptedSessionFile)
        this.persistSessionFiles()
      }
      if (input.compactRequest) {
        try {
          await bridge.compact(input.sessionId, { instructions: '', completeRun: true })
          this.finishRun(runState)
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          this.finishRun(runState, failure.message)
        }
      }
      input.onModelResolved?.(input.modelRoute?.modelId || input.model || '')
      const contextWindow = input.modelRoute?.compaction?.contextWindow
      if (contextWindow) input.onContextWindow?.(contextWindow)
      input.onSessionId?.(String(accepted.nativeSessionId || accepted.sessionId || input.sessionId))
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      const runId = this.sessionRuns.get(input.sessionId)
      const state = runId ? this.runStates.get(runId) : undefined
      if (state && state.queue === queue && !state.settled) {
        this.finishRun(state, failure.message)
      } else if (!state || state.queue !== queue) {
        queue.push(resultMessage(input.sessionId, '', failure.message))
        queue.finish()
      }
    } finally {
      this.startingSessions.delete(input.sessionId)
    }
  }
}
