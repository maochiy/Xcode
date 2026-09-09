/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 核心职责：
 * - 拦截 AskUserQuestion 工具调用
 * - 解析问题列表，发送到渲染进程展示交互 UI
 * - 等待用户回答，通过 updatedInput 注入 answers 字段
 * - 管理 pending 请求生命周期
 *
 * 复用权限系统的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  AskUserRequest,
  AskUserQuestion,
  AskUserQuestionOption,
} from '@proma/shared'

/** canUseTool 返回的权限结果 */
type PermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 AskUser 请求 */
interface PendingAskUser {
  resolve: (result: PermissionResult) => void
  request: AskUserRequest
  signal: AbortSignal
  abortListener: () => void
  onSettled?: (request: AskUserRequest, outcome: AskUserSettlement) => void
}

export type AskUserSettlement = 'answered' | 'aborted' | 'cleared'

export interface AskUserLifecycleCallbacks {
  /** 请求已经进入 pending Map 后触发。 */
  onPending?: (request: AskUserRequest) => void
  /** 请求从 pending Map 移除后触发。 */
  onSettled?: (request: AskUserRequest, outcome: AskUserSettlement) => void
}

/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 单例模式，管理所有会话的 AskUser 请求。
 */
export class AgentAskUserService {
  /** 待处理的 AskUser 请求 Map（requestId → PendingAskUser） */
  private pendingRequests = new Map<string, PendingAskUser>()

  /**
   * 处理 AskUserQuestion 工具调用
   *
   * 解析问题列表，发送到渲染进程，阻塞等待用户回答，
   * 回答后通过 updatedInput 注入 answers 字段。
   */
  handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: AskUserRequest) => void,
    lifecycle?: AskUserLifecycleCallbacks,
  ): Promise<PermissionResult> {
    if (signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: '操作已中止' })
    }
    const questions = this.parseQuestions(input)

    const request: AskUserRequest = {
      requestId: randomUUID(),
      sessionId,
      questions,
      toolInput: input,
    }

    return new Promise<PermissionResult>((resolve) => {
      const abortListener = (): void => {
        this.settleRequest(
          request.requestId,
          { behavior: 'deny', message: '操作已中止' },
          'aborted',
        )
      }
      this.pendingRequests.set(request.requestId, {
        resolve,
        request,
        signal,
        abortListener,
        onSettled: lifecycle?.onSettled,
      })
      signal.addEventListener('abort', abortListener, { once: true })
      try {
        lifecycle?.onPending?.(request)
        sendToRenderer(request)
      } catch {
        this.settleRequest(
          request.requestId,
          { behavior: 'deny', message: '无法发起用户问答' },
          'aborted',
        )
      }
    })
  }

  private settleRequest(
    requestId: string,
    result: PermissionResult,
    outcome: AskUserSettlement,
  ): string | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null
    this.pendingRequests.delete(requestId)
    pending.signal.removeEventListener('abort', pending.abortListener)
    try {
      pending.onSettled?.(pending.request, outcome)
    } catch {
      console.warn('[Agent 问答] 同步等待状态失败，请求仍正常结束。')
    } finally {
      pending.resolve(result)
    }
    return pending.request.sessionId
  }

  /**
   * 响应 AskUser 请求（由 IPC handler 调用）
   *
   * @returns 对应的 sessionId，用于向渲染进程发送 resolved 事件；未找到返回 null
   */
  respondToAskUser(requestId: string, answers: Record<string, string>): string | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null

    // 构建 updatedInput：保留原始输入 + 注入 answers
    const updatedInput: Record<string, unknown> = {
      ...pending.request.toolInput,
      answers,
    }

    return this.settleRequest(requestId, {
      behavior: 'allow' as const,
      updatedInput,
    }, 'answered')
  }

  /**
   * 获取当前所有待处理的 AskUser 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): AskUserRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request)
  }

  /**
   * 清除指定会话的所有待处理 AskUser 请求
   */
  clearSessionPending(sessionId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        this.settleRequest(
          requestId,
          { behavior: 'deny', message: '会话已结束' },
          'cleared',
        )
      }
    }
  }

  /**
   * 从工具输入中解析问题列表
   *
   * SDK AskUserQuestion 工具输入格式：
   * { questions: [{ question, header, options: [{ label, description, preview }], multiSelect }] }
   */
  private parseQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return []

    return rawQuestions.map((q: unknown): AskUserQuestion => {
      const raw = q as Record<string, unknown>
      const options = Array.isArray(raw.options)
        ? (raw.options as Array<Record<string, unknown>>).map((o): AskUserQuestionOption => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : undefined,
            preview: typeof o.preview === 'string' ? o.preview.slice(0, 10_000) : undefined,
          }))
        : []

      return {
        question: typeof raw.question === 'string' ? raw.question : '',
        header: typeof raw.header === 'string' ? raw.header : undefined,
        options,
        multiSelect: raw.multiSelect === true,
      }
    })
  }
}

/** 全局 AskUser 服务实例 */
export const askUserService = new AgentAskUserService()
