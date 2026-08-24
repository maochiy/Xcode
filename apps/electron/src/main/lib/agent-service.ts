/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE } from '@proma/shared'
import type {
  AgentSendInput,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  PromaPermissionMode,
  AgentExternalRunSource,
  AgentMessage,
  ForkSessionInput,
  AgentSessionMeta,
  ThinkingConfig,
  ThinkingEffortLevel,
  AgentRuntimeExecutionGraph,
  AgentRuntimeSubagentTranscript,
  AgentTurnChangeStats,
} from '@proma/shared'
import { RuntimeAdapterRouter } from './runtime/runtime-adapters'
import { ccbDesktopRuntimeClient } from './ccb-runtime/runtime-client'
import { AgentEventBus } from './agent-event-bus'
import { AgentOrchestrator } from './agent-orchestrator'
import { getAgentSessionAttachmentsDir, getWorkspaceFilesDir } from './config-paths'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { syncSessionToTask } from './taskboard/taskboard-session-sync'
import { setAgentStopper, setHeadlessAgentRunner } from './agent-headless-runner-registry'
import { sendAgentStreamComplete } from './agent-completion-payload'
import {
  clearAgentTurnChangeTracking,
  getAgentTurnChangeStats as readAgentTurnChangeStats,
} from './agent-turn-change-tracker'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()
const adapter = new RuntimeAdapterRouter()
const orchestrator = new AgentOrchestrator(adapter, eventBus)

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

// 注册协作子会话 EventBus 阻塞事件监听
import('./agent-collaboration-tools').then(({ registerCollaborationEventBus }) => {
  registerCollaborationEventBus(eventBus)
}).catch(() => { /* collaboration 模块可能未加载 */ })

/**
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new Map<string, WebContents>()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
function registerWebContents(sessionId: string, wc: WebContents): void {
  // 同一 sessionId 切换 webContents 时直接覆盖；旧 wc 的 destroyed 钩子仍由 WeakSet 持有，
  // 触发时会扫描 sessionWebContents 清理所有指向旧 wc 的条目（见下方实现）。
  sessionWebContents.set(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理所有指向它的条目
    for (const [sid, mappedWc] of sessionWebContents) {
      if (mappedWc === wc) sessionWebContents.delete(sid)
    }
  })
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.getURL()
  if (!url) return false
  if (url.startsWith('data:')) return false
  return !url.includes('window=quick-task')
    && !url.includes('window=voice-dictation')
    && !url.includes('window=detached-preview')
}

function getMainRendererWebContents(): WebContents | null {
  const win = BrowserWindow.getAllWindows().find(isMainRendererWindow)
  return win && !win.webContents.isDestroyed() ? win.webContents : null
}

// ===== EventBus IPC 转发中间件 =====

eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
  if (wc && !wc.isDestroyed()) {
    try {
      wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  next()
})

// ===== IPC 薄包装函数 =====

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
): Promise<void> {
  // 更新 webContents 映射（允许覆盖 — 由 orchestrator.activeSessions 处理真正的并发保护）
  registerWebContents(input.sessionId, webContents)
  // 开始新一轮执行时清除"完成未确认"标记
  try {
    updateAgentSessionMeta(input.sessionId, { completedButUnconfirmed: false })
  } catch { /* 新会话可能尚未写入索引 */ }
  // 自动任务会话"毕业"：用户手动发消息（非定时触发）即视为接管，标记后该会话回到普通项目列表，
  // 调度器也不再复用它注入新的定时运行。
  if (input.triggeredBy !== 'automation') {
    try {
      const meta = getAgentSessionMeta(input.sessionId)
      if (meta?.sourceAutomationId && !meta.automationGraduated) {
        updateAgentSessionMeta(input.sessionId, { automationGraduated: true })
        // 向渲染进程发送毕业事件，触发 toast 提示
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'automation_graduated' },
        })
      }
    } catch { /* 新会话可能尚未写入索引 */ }
  }
  try {
    await orchestrator.sendMessage(input, {
      onError: (error) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.sessionId,
            error,
          })
        }
      },
      onRunStarted: () => {
        // 草稿会话发送首条消息时转为正式会话
        const session = getAgentSessionMeta(input.sessionId)
        if (session?.draft) {
          updateAgentSessionMeta(input.sessionId, { draft: false })
        }
        // 发送成功开始运行 → 绑定任务 threadId（任务→会话方向已通过 taskboardTaskId 关联）。
        // 即使中途暂停/停止，任务也已绑定会话，任务详情可查看对话。
        // 注意：draft 已在上方置 false，需重新读取会话（旧快照仍为 draft=true，
        // 会导致 syncSessionToTask 的 shouldAutoCreateTask 提前返回而不绑定）。
        const activeSession = getAgentSessionMeta(input.sessionId)
        if (activeSession) {
          try {
            syncSessionToTask(activeSession)
          } catch (error) {
            console.error('[任务看板] 发送时绑定任务失败:', error)
          }
        }
      },
      onComplete: (messages, opts) => {
        if (!webContents.isDestroyed()) {
          sendAgentStreamComplete(webContents, input, {
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            lastStopDurationMs: opts?.lastStopDurationMs,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
          })
        }
      },
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    if (!webContents.isDestroyed()) {
      webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: input.sessionId,
        error: errorMessage,
      })
      sendAgentStreamComplete(webContents, input, {
        messages: [],
        stoppedByUser: false,
      })
    }
  } finally {
    // 仅在 orchestrator 已完成此会话时清理映射
    // 避免被拒绝的请求误删仍在运行的会话映射
    if (!orchestrator.isActive(input.sessionId)) {
      sessionWebContents.delete(input.sessionId)
    }
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: {
    onError: (error: string) => void
    onComplete: (messages?: AgentMessage[]) => void
    onTitleUpdated: (title: string) => void
    source?: AgentExternalRunSource
  },
): Promise<void> {
  // 尝试注册主窗口 webContents，让流式事件同步推送到桌面端
  const wc = getMainRendererWebContents()
  const runInput: AgentSendInput = input.startedAt != null ? input : { ...input, startedAt: Date.now() }
  const startedAt = runInput.startedAt!
  if (wc) {
    registerWebContents(runInput.sessionId, wc)
  }

  try {
    await orchestrator.sendMessage(runInput, {
      onError: (error) => {
        callbacks.onError(error)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: runInput.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, opts) => {
        callbacks.onComplete(messages)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          sendAgentStreamComplete(wc, runInput, {
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            lastStopDurationMs: opts?.lastStopDurationMs,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
          })
        }
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: { type: 'title_updated', title },
        })
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt }) => {
        const session = getAgentSessionMeta(runInput.sessionId)
        eventBus.emit(runInput.sessionId, {
          kind: 'proma_event',
          event: {
            type: 'external_run_started',
            source: callbacks.source ?? 'bridge',
            sessionId: runInput.sessionId,
            title: session?.title,
            workspaceId: runInput.workspaceId ?? session?.workspaceId,
            modelId: runInput.modelId,
            startedAt: persistedStartedAt,
          },
        })
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    callbacks.onError(errorMessage)
    callbacks.onComplete()
    if (wc && !wc.isDestroyed()) {
      wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: runInput.sessionId, error: errorMessage })
      sendAgentStreamComplete(wc, runInput, {
        messages: [],
        stoppedByUser: false,
        startedAt,
      })
    }
  } finally {
    if (!orchestrator.isActive(runInput.sessionId)) {
      sessionWebContents.delete(runInput.sessionId)
    }
  }
}

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 中止指定会话的 Agent 执行
 */
export async function stopAgent(sessionId: string): Promise<void> {
  await orchestrator.stop(sessionId)
}

export async function closeAgentSessionRuntime(sessionId: string): Promise<void> {
  clearAgentTurnChangeTracking(sessionId)
  await orchestrator.closeSession(sessionId)
}

/** 获取当前 Agent 本轮相对执行前基线产生的文件改动统计。 */
export async function getAgentTurnChangeStats(
  sessionId: string,
): Promise<AgentTurnChangeStats | null> {
  return readAgentTurnChangeStats(sessionId)
}

setHeadlessAgentRunner(runAgentHeadless)
setAgentStopper(stopAgent)

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<import('@proma/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid)
}

/** 使用 CCB Runtime 原生 transcript 分叉并创建 Proma 会话投影。 */
export async function forkAgentRuntimeSession(
  input: ForkSessionInput,
): Promise<AgentSessionMeta> {
  return orchestrator.forkSession(input)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return orchestrator.isActive(sessionId)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  orchestrator.stopAll()
}

/**
 * 退出前关闭 CCB Desktop Runtime Host 及其 Session Worker 进程树。
 */
export async function shutdownAgentRuntime(): Promise<void> {
  await Promise.all([
    Promise.resolve(adapter.dispose()),
    ccbDesktopRuntimeClient.shutdown(),
  ])
}

/**
 * 运行中动态切换会话的权限模式
 *
 * 同时更新 Proma 侧权限状态和 CCB Session Worker 的权限模式。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: PromaPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

/** 清除当前进程内该会话的“计划已就绪”标记。 */
export function clearAgentPlanReady(sessionId: string): void {
  orchestrator.clearPlanReady(sessionId)
}

/** 实时更新已打开的 CCB Session；未打开时返回 false，由下次 turn 使用持久化设置。 */
export async function updateAgentRuntimeConfig(
  sessionId: string,
  updates: {
    model?: string
    thinkingConfig?: ThinkingConfig
    effortLevel?: ThinkingEffortLevel
  },
): Promise<boolean> {
  return adapter.updateRuntimeConfig(sessionId, updates)
}

/**
 * 模型配置变更后刷新关联的 CCB Session Worker。
 *
 * 空闲会话立即释放旧 Worker；运行中会话在当前 Turn 完成后释放，
 * 因此不会中断正在进行的工具调用。
 */
export async function invalidateAgentRuntimeConfiguration(
  channelId: string,
): Promise<void> {
  await adapter.invalidateChannelConfiguration(channelId)
}

export async function getAgentRuntimeExecutionGraph(
  sessionId: string,
): Promise<AgentRuntimeExecutionGraph> {
  return adapter.getExecutionGraph(sessionId)
}

export async function getAgentRuntimeSubagentTranscript(
  sessionId: string,
  executionNodeId: string,
): Promise<AgentRuntimeSubagentTranscript> {
  return adapter.getSubagentTranscript(sessionId, executionNodeId)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    input.rawUserMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt },
    input.mentionedSkills,
    input.mentionedMcpServers,
    input.mentionedSessionIds,
  )
}

// ===== 文件操作 =====

/**
 * 保存文件到 Proma 私有的 Agent session 附件目录
 *
 * 文件通过绝对路径注入 Prompt，CCB cwd 仍保持为用户选择的真实项目目录。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionAttachmentsDir(input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(sessionDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    // 防御性检查：base64 字符串长度估算是否超 100MB 限制
    // base64 编码膨胀率约 4/3，data.length * 0.75 ≈ 原始字节数
    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * 保存文件到工作区文件目录
 *
 * 将 base64 编码的文件写入工作区 workspace-files/ 目录，所有会话均可访问。
 */
export function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): AgentSavedFile[] {
  const wsFilesDir = getWorkspaceFilesDir(input.workspaceSlug)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(wsFilesDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 工作区文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(wsFilesDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
