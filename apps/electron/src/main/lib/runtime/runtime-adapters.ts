/**
 * Proma Runtime 的 Pi-only 路由层。
 *
 * RuntimeId 暂时保留历史联合类型用于读取旧会话，但所有查询和 Session 操作
 * 都只委托给 PiRuntimeAdapter。这里不得重新注册 Hermes、Codex、Claude Code
 * 或 CCB 的可执行入口。
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntimeSessionOperationInput,
  AgentRuntimeForkResult,
  AgentRuntimeRewindResult,
  SDKMessage,
  SDKUserMessageInput,
  SendQueuedMessageOptions,
  ThinkingConfig,
  ThinkingEffortLevel,
} from '@proma/shared'
import { PiRuntimeAdapter } from './pi-runtime-adapter'
import { EXECUTABLE_RUNTIME_ID } from './pi-runtime-policy'

export class RuntimeAdapterRouter implements AgentProviderAdapter {
  private readonly pi: AgentProviderAdapter
  private readonly sessions = new Set<string>()
  private disposePromise: Promise<void> | null = null

  constructor(piAdapter: AgentProviderAdapter = new PiRuntimeAdapter()) {
    this.pi = piAdapter
  }

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    this.sessions.add(input.sessionId)
    return this.pi.query({
      ...input,
      runtimeId: EXECUTABLE_RUNTIME_ID,
      modelRoute: input.modelRoute
        ? { ...input.modelRoute, runtimeId: EXECUTABLE_RUNTIME_ID }
        : undefined,
    })
  }

  abort(sessionId: string): Promise<void> {
    return this.pi.abort(sessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    await this.pi.closeSession?.(sessionId)
  }

  interruptQuery(sessionId: string): Promise<void> {
    return this.pi.interruptQuery?.(sessionId) ?? this.abort(sessionId)
  }

  sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    return this.pi.sendQueuedMessage?.(sessionId, message, options)
      ?? Promise.reject(new Error('Pi Runtime 不支持队列消息。'))
  }

  setPermissionMode(sessionId: string, mode: string): Promise<void> {
    return this.pi.setPermissionMode?.(sessionId, mode) ?? Promise.resolve()
  }

  async updateRuntimeConfig(
    _sessionId: string,
    _updates: {
      model?: string
      thinkingConfig?: ThinkingConfig
      effortLevel?: ThinkingEffortLevel
    },
  ): Promise<boolean> {
    return false
  }

  async invalidateChannelConfiguration(_channelId: string): Promise<void> {
    // Pi 通过每次查询携带的 routeRevision/credentialRevision 判断是否重建 Session。
  }

  async getExecutionGraph(
    _sessionId: string,
  ): Promise<import('@proma/shared').AgentRuntimeExecutionGraph> {
    return { nodes: [], todos: [], updatedAt: 0 }
  }

  async getSubagentTranscript(
    _sessionId: string,
    _executionNodeId: string,
  ): Promise<import('@proma/shared').AgentRuntimeSubagentTranscript> {
    throw new Error('Pi Runtime 不提供原生子代理 Transcript；协作子会话使用 Proma 本地消息记录。')
  }

  forkSession(
    input: AgentRuntimeSessionOperationInput,
    upToMessageUuid?: string,
  ): Promise<AgentRuntimeForkResult> {
    return this.requirePiSession(input.sessionId).forkSession?.(input, upToMessageUuid)
      ?? Promise.reject(new Error('Pi Runtime 不支持 Session 分叉。'))
  }

  rewindSession(
    input: AgentRuntimeSessionOperationInput,
    messageUuid: string,
  ): Promise<AgentRuntimeRewindResult> {
    return this.requirePiSession(input.sessionId).rewindSession?.(input, messageUuid)
      ?? Promise.reject(new Error('Pi Runtime 不支持 Session 回退。'))
  }

  compactSession(input: AgentRuntimeSessionOperationInput, instructions?: string): Promise<void> {
    return this.requirePiSession(input.sessionId).compactSession?.(input, instructions)
      ?? Promise.reject(new Error('Pi Runtime 不支持上下文压缩。'))
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = Promise.resolve(this.pi.dispose()).then(() => {
        this.sessions.clear()
      })
    }
    await this.disposePromise
  }

  private requirePiSession(sessionId: string): AgentProviderAdapter {
    if (!this.sessions.has(sessionId)) throw new Error('Runtime Session 尚未打开。')
    return this.pi
  }
}
