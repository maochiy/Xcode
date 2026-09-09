/**
 * Agent 会话管理器
 *
 * 负责 Agent 会话的 CRUD 操作和消息持久化。
 * - 会话索引：~/.proma/agent-sessions.json（轻量元数据）
 * - 消息存储：~/.proma/agent-sessions/{id}.jsonl（JSONL 格式，逐行追加）
 *
 * 照搬 conversation-manager.ts 的模式。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { writeJsonFileAtomic, writeTextFileAtomic, readJsonFileSafe } from './safe-file'
import { randomUUID } from 'node:crypto'
import { rmSyncWithRetry, renameWithRetry } from './fs-retry'
import { join } from 'node:path'
import {
  getAgentSessionsIndexPath,
  getAgentSessionsDir,
  getAgentSessionMessagesPath,
  getAgentSessionAttachmentsDir,
  resolveAgentSessionAttachmentsDir,
  getConfigDir,
} from './config-paths'
import { getAgentWorkspace, getWorkspaceAutoMemoryDir } from './agent-workspace-manager'
import { getSettings } from './settings-service'
import { applyClaudeSdkAttributionSettings, isGitAttributionEnabled } from './agent-git-attribution'
import type {
  AgentSessionMeta,
  AgentMessage,
  SDKMessage,
  ForkSessionInput,
  AgentMessageSearchResult,
  AgentSessionReferenceSearchInput,
  AgentSessionReferenceSearchResult,
  AgentRuntimeSessionSummary,
  RegisteredAgentRuntimeSnapshot,
} from '@proma/shared'
import { migratePermissionMode } from '@proma/shared'
import { getConversationMessages } from './conversation-manager'
// 旧格式 → SDKMessage 的转换逻辑下沉到 @proma/session-core 作为唯一真源，避免主进程与渲染层各存一份。
import { convertLegacyMessage } from '@proma/session-core'
import { clearNanoBananaAgentHistory } from './chat-tools/nano-banana-mcp'
import { assertEnabledModelForChannel } from './agent-model-selection'
import { copyForkWorkspaceFiles } from './agent-fork-workspace-copy'
import { promaBuiltinMcpHttpHost } from './builtin-mcp/http-host'
import {
  createRuntimeSessionProjectionTitle,
  hasRuntimePromptContext,
} from './title-generation'
import { normalizeCcbAssistantMessage } from './ccb-runtime/ccb-assistant-message-normalization'

/**
 * 会话索引文件格式
 */
interface AgentSessionsIndex {
  /** 配置版本号 */
  version: number
  /** 会话元数据列表 */
  sessions: AgentSessionMeta[]
}

/** 当前索引版本 */
const INDEX_VERSION = 2

function createEmptyIndex(): AgentSessionsIndex {
  return {
    version: INDEX_VERSION,
    sessions: [],
  }
}

/**
 * 项目尚未上线时不迁移 Claude SDK/Pi 开发期 Session。
 * 发现旧 Schema 后将索引、消息与旧 SDK 配置非破坏性移动到时间戳目录。
 */
function archiveLegacyAgentData(indexPath: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveDir = join(getConfigDir(), 'legacy-agent-data', timestamp)
  mkdirSync(archiveDir, { recursive: true })
  const candidates = [
    { source: indexPath, name: 'agent-sessions.json' },
    { source: join(getConfigDir(), 'agent-sessions'), name: 'agent-sessions' },
    { source: join(getConfigDir(), 'sdk-config'), name: 'sdk-config' },
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate.source)) continue
    renameWithRetry(candidate.source, join(archiveDir, candidate.name))
  }
  console.log(`[Agent 会话] 已备份旧 Runtime 开发数据: ${archiveDir}`)
}

/**
 * 会话引用最大返回数。
 *
 * 无搜索词时只返回索引中的轻量元数据，200 条可以显著扩大可选范围，
 * 同时避免极端会话数量下向渲染进程传输过大列表。
 */
const MAX_SESSION_REFERENCE_LIMIT = 200

interface JsonlParseError {
  lineNumber: number
  message: string
}

/**
 * 逐行解析 JSONL，调用方按业务场景决定容错或严格失败。
 */
function parseJsonlLines<T>(lines: string[]): { records: T[]; errors: JsonlParseError[] } {
  const records: T[] = []
  const errors: JsonlParseError[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as T)
    } catch (err) {
      errors.push({
        lineNumber: i + 1,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { records, errors }
}

/**
 * 展示/检索类读取：跳过损坏行，保留其它可读消息。
 */
function parseJsonlLenient<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  for (const error of errors) {
    console.warn(`[Agent 会话] ${context} — JSONL 第 ${error.lineNumber} 行解析失败，已跳过:`, error.message)
  }
  return records
}

/**
 * 回退/文件恢复类读取：任何损坏行都可能破坏消息顺序或快照完整性，必须停止。
 */
function parseJsonlStrict<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`${context} 失败：JSONL 第 ${first.lineNumber} 行解析失败: ${first.message}`)
  }
  return records
}

function normalizePersistedSDKMessage(parsed: unknown): SDKMessage {
  // 旧格式检测：AgentMessage 有 `role` 字段，SDKMessage 有 `type` 字段
  if (parsed && typeof parsed === 'object' && 'role' in parsed && !('type' in parsed)) {
    return normalizeCcbAssistantMessage(convertLegacyMessage(parsed as AgentMessage))
  }
  return normalizeCcbAssistantMessage(parsed as SDKMessage)
}

/**
 * CCB Transcript 会保留上游自动重试产生的原始 assistant.error。
 *
 * Proma 编排层会在重试最终失败时单独生成结构化错误消息，因此这些没有
 * `error.message` 的 Runtime 原始记录既会重复展示，也只能被 Renderer 识别成
 * “未知错误”。UI 投影读取和 Transcript 合并时统一过滤，Runtime 自身 Transcript
 * 不受影响，后续 resume 仍保留完整执行上下文。
 */
function isUnstructuredRuntimeAssistantError(message: SDKMessage): boolean {
  if (message.type !== 'assistant') return false
  const error = (message as unknown as { error?: unknown }).error
  if (!error) return false
  if (typeof error !== 'object') return true
  return typeof (error as { message?: unknown }).message !== 'string'
}
/**
 * CCB 用户中断时写入 transcript 的合成 user 文本。
 * 这不是真实用户输入：CCB CLI 用它做会话边界，UI 应忽略。
 * 若写入 Proma JSONL，会变成用户气泡，并触发「你在 N 秒后停止了」二次显示。
 */
const CCB_INTERRUPT_USER_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

/** 是否为 CCB 中断合成 user 消息（应丢弃，不进入 UI 投影） */
export function isCcbInterruptUserMessage(message: SDKMessage): boolean {
  const text = getUserMessageText(message)
  return Boolean(text && CCB_INTERRUPT_USER_TEXTS.has(text))
}

/**
 * CCB 自动压缩后会写入一条「This session is being continued...」合成 user，
 * 用于 Runtime 续写上下文，不是用户真实输入，UI 投影中应丢弃。
 */
export function isCcbCompactionContinuationUserMessage(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  if ((message as { parent_tool_use_id?: unknown }).parent_tool_use_id) return false
  if (isToolResultOnlyUserMessage(message)) return false
  const text = getUserMessageText(message)
  if (!text) return false
  return /^This session is being continued from a previous conversation\b/i.test(text)
}

/**
 * CCB 在 abort / 429 重试等场景会写入仅含 “API Error: ...” 的 assistant。
 * 这不是有用的过程正文；桌面端已有 interrupted result / 停止文案，投影中应丢弃。
 */
function isCcbTransientApiErrorAssistantMessage(message: SDKMessage): boolean {
  if (message.type !== 'assistant') return false
  const content = getMessageContentBlocks(message)
  if (content.length === 0) return false
  let textCount = 0
  let onlyApiErrorText = true
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      onlyApiErrorText = false
      break
    }
    const record = block as { type?: unknown; text?: unknown; thinking?: unknown }
    if (record.type === 'thinking') {
      // 允许夹带空 thinking，但仍需至少一段 API Error 正文
      continue
    }
    if (record.type === 'text' && typeof record.text === 'string') {
      textCount += 1
      const text = record.text.trim()
      if (
        !/^API Error:\s*Request was aborted\.?$/i.test(text)
        && !/^API Error:\s*\d{3}\b/i.test(text)
      ) {
        onlyApiErrorText = false
        break
      }
      continue
    }
    onlyApiErrorText = false
    break
  }
  return onlyApiErrorText && textCount > 0
}

/** @deprecated 语义并入 isCcbTransientApiErrorAssistantMessage */
function isCcbAbortAssistantMessage(message: SDKMessage): boolean {
  return isCcbTransientApiErrorAssistantMessage(message)
}


function migrateLegacyPermissionMode(index: AgentSessionsIndex): boolean {
  let changed = false
  for (const session of index.sessions) {
    const rawMode = session.permissionMode as string | undefined
    if (!rawMode) continue
    if (rawMode === 'plan') {
      session.permissionMode = 'default'
      session.planModeEnabled = true
      changed = true
      continue
    }
    const nextMode = migratePermissionMode(rawMode)
    if (nextMode !== rawMode) {
      session.permissionMode = nextMode
      changed = true
    }
  }
  return changed
}

/**
 * 读取会话索引文件
 */
function readIndex(): AgentSessionsIndex {
  const indexPath = getAgentSessionsIndexPath()
  const data = readJsonFileSafe<AgentSessionsIndex>(indexPath)
  if (data) {
    if (data.version !== INDEX_VERSION) {
      archiveLegacyAgentData(indexPath)
      const fresh = createEmptyIndex()
      writeIndex(fresh)
      return fresh
    }
    const permissionModeMigrated = migrateLegacyPermissionMode(data)
    if (permissionModeMigrated) {
      writeIndex(data)
      console.log('[Agent 会话] 已迁移历史权限模式与独立计划模式')
    }
    return data
  }
  return createEmptyIndex()
}

/**
 * 写入会话索引文件
 */
function writeIndex(index: AgentSessionsIndex): void {
  const indexPath = getAgentSessionsIndexPath()

  try {
    writeJsonFileAtomic(indexPath, index)
  } catch (error) {
    console.error('[Agent 会话] 写入索引文件失败:', error)
    throw new Error('写入 Agent 会话索引失败')
  }
}

/**
 * 获取所有会话（按 updatedAt 降序）
 */
export function listAgentSessions(): AgentSessionMeta[] {
  const index = readIndex()
  return index.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 将 CCB Transcript 目录同步为 Proma UI 投影。
 *
 * Proma 本地索引是桌面 UI 会话真源；CCB Catalog 只负责导入 Runtime 原生
 * 会话和刷新已知 Runtime 元数据。Catalog 的一次暂时缺失绝不能删除 Proma
 * 会话，真实删除只能由用户显式操作触发。
 */
export function syncRuntimeSessionCatalog(
  workspaceId: string,
  runtimeSessions: AgentRuntimeSessionSummary[],
): AgentSessionMeta[] {
  const index = readIndex()
  let changed = false
  for (const runtimeSession of runtimeSessions) {
    const runtimeTitle = createRuntimeSessionProjectionTitle(
      runtimeSession.title || runtimeSession.summary,
    ) ?? '新 Agent 会话'
    const existing = index.sessions.find(
      session => session.runtimeSessionId === runtimeSession.runtimeSessionId,
    )
    if (existing) {
      // CCB 原生导入会话由 Transcript 标题持续驱动；Proma 创建、自动生成或
      // 用户手动修改的标题由桌面端持有，避免 Catalog 同步覆盖用户选择。
      const runtimeOwnsTitle =
        existing.titleSource === 'runtime'
        || (
          existing.titleSource === undefined
          && (
            existing.id === existing.runtimeSessionId
            || existing.title === '新 Agent 会话'
            || hasRuntimePromptContext(existing.title)
          )
        )
      const nextTitle = runtimeOwnsTitle ? runtimeTitle : existing.title
      // Proma 创建的会话以本地消息写入时间维护侧栏顺序。Catalog 查询可能由
      // 模型配置、窗口聚焦等无关操作触发，不能用 CCB Transcript 时间把它
      // 重新排序；只有 CCB 原生导入会话继续接受 Runtime 时间戳。
      const runtimeOwnsTimestamp =
        existing.titleSource === 'runtime'
        || existing.id === existing.runtimeSessionId
      const nextUpdatedAt = runtimeOwnsTimestamp
        ? runtimeSession.updatedAt
        : existing.updatedAt
      if (
        existing.workspaceId !== workspaceId
        || existing.title !== nextTitle
        || (runtimeOwnsTitle && existing.titleSource !== 'runtime')
        || existing.updatedAt !== nextUpdatedAt
      ) {
        existing.workspaceId = workspaceId
        existing.title = nextTitle
        if (runtimeOwnsTitle) existing.titleSource = 'runtime'
        existing.updatedAt = nextUpdatedAt
        changed = true
      }
      continue
    }
    const now = runtimeSession.createdAt ?? runtimeSession.updatedAt
    index.sessions.push({
      id: index.sessions.some(session => session.id === runtimeSession.runtimeSessionId)
        ? randomUUID()
        : runtimeSession.runtimeSessionId,
      runtimeSessionId: runtimeSession.runtimeSessionId,
      title: runtimeTitle,
      titleSource: 'runtime',
      workspaceId,
      createdAt: now,
      updatedAt: runtimeSession.updatedAt,
      runtimeWorkerState: 'cold',
    })
    changed = true
  }
  if (changed) writeIndex(index)
  return index.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 获取单个会话的元数据
 */
export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  const index = readIndex()
  return index.sessions.find((s) => s.id === id)
}

/**
 * 创建新会话
 */
export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  modelId?: string,
  draft: boolean = false,
  taskboardTaskId?: string,
): AgentSessionMeta {
  const index = readIndex()
  const now = Date.now()

  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || '新 Agent 会话',
    draft,
    titleSource: title ? 'user' : 'generated',
    channelId,
    modelId,
    runtimeId: 'pi',
    workspaceId,
    ...(taskboardTaskId ? { taskboardTaskId } : {}),
    createdAt: now,
    updatedAt: now,
  }

  index.sessions.push(meta)
  writeIndex(index)

  // 确保消息目录存在
  getAgentSessionsDir()

  // v3 项目模型下，Agent cwd 直接使用用户选择的本机项目目录。
  // 不再为每个会话创建独立工作目录，也不向用户项目写入 .claude 配置。

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`)
  return meta
}

/**
 * 读取会话的所有消息
 */
export function getAgentSessionMessages(id: string): AgentMessage[] {
  const filePath = getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return parseJsonlLenient<AgentMessage>(lines, `读取会话消息 (${id})`)
  } catch (error) {
    console.error(`[Agent 会话] 读取消息失败 (${id}):`, error)
    return []
  }
}

/**
 * 追加一条消息到会话的 JSONL 文件
 */
export function appendAgentMessage(id: string, message: AgentMessage): void {
  const filePath = getAgentSessionMessagesPath(id)

  try {
    const line = JSON.stringify(message) + '\n'
    appendFileSync(filePath, line, 'utf-8')

    // 追加消息时更新 updatedAt，若已归档则自动恢复活跃
    const index = readIndex()
    const idx = index.sessions.findIndex((s) => s.id === id)
    if (idx !== -1) {
      const session = index.sessions[idx]!
      session.updatedAt = Date.now()
      if (session.archived) session.archived = false
      writeIndex(index)
    }
  } catch (error) {
    console.error(`[Agent 会话] 追加消息失败 (${id}):`, error)
    throw new Error('追加 Agent 消息失败')
  }
}

/** 单条 SDKMessage 序列化后最大长度（UTF-16 code units，超出则截断内容） */
const MAX_SDK_MESSAGE_LENGTH = 256 * 1024 // ~256K chars
/** 截断后保留的预览文本长度 */
const TRUNCATED_PREVIEW_LENGTH = 2000

/**
 * 追加 SDKMessage 到会话的 JSONL 文件（Phase 4 新持久化格式）
 *
 * 每条 SDKMessage 单独一行 JSON。读取时通过 `type` 字段区分新旧格式。
 * 超过 256K chars 的消息会被自动截断以防止存储膨胀。
 */
export function appendSDKMessages(id: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return

  const filePath = getAgentSessionMessagesPath(id)

  try {
    for (const message of messages) {
      appendFileSync(filePath, serializeSDKMessageForStorage(message) + '\n', 'utf-8')
    }
  } catch (error) {
    console.error(`[Agent 会话] 追加 SDKMessage 失败 (${id}):`, error)
    throw new Error('追加 SDKMessage 失败')
  }
}

/**
 * 修复 JSONL 追加写入造成的时间顺序倒置。
 *
 * 「立即发送」会先把新的 user 写入 JSONL，旧 Runtime 的 assistant 最终快照
 * 可能稍后才到达并追加到文件尾部。文件物理顺序因此可能变成：
 *   旧 user → 新 user → 旧 assistant
 *
 * 这里只重排带 `_createdAt` 的消息槽位，未带时间戳的旧历史仍保持原位置，
 * 避免迁移旧数据时把无法判断先后的消息错误挪动。
 */
export function orderSDKMessagesByCreatedAt(messages: SDKMessage[]): SDKMessage[] {
  // 升级后的 Pi 消息按原生生命周期追加。时间戳只用于展示，不是排序键；
  // 即使系统时间回拨，也不能把新的消息移到另一个用户回合中。
  const nativeStart = messages.findIndex((message) =>
    (message as Record<string, unknown>)._promaNativeMessage === true)
  if (nativeStart >= 0) {
    return [
      ...orderSDKMessagesByCreatedAt(messages.slice(0, nativeStart)),
      ...messages.slice(nativeStart),
    ]
  }
  const timestamped = messages
    .filter((message) => typeof (message as Record<string, unknown>)._createdAt === 'number')

  if (timestamped.length < 2) return messages

  const isChronological = timestamped.every((message, index) => {
    if (index === 0) return true
    const previous = timestamped[index - 1] as Record<string, unknown>
    const current = message as Record<string, unknown>
    return Number(previous._createdAt) <= Number(current._createdAt)
  })
  if (isChronological) return messages

  const ordered = [...timestamped].sort((left, right) => {
    const leftAt = Number((left as Record<string, unknown>)._createdAt)
    const rightAt = Number((right as Record<string, unknown>)._createdAt)
    return leftAt - rightAt
  })
  let orderedIndex = 0
  return messages.map((message) => {
    if (typeof (message as Record<string, unknown>)._createdAt !== 'number') {
      return message
    }
    return ordered[orderedIndex++]!
  })
}

/**
 * 截断超大 SDKMessage 的内容，保留元数据结构。
 * 处理三类膨胀源：超长 text block、超大 tool_result、内嵌 base64 图片。
 */
function sanitizeOversizedMessage(msg: SDKMessage, originalLength: number): SDKMessage {
  const truncationNote = `\n[内容已截断: 原始 ${(originalLength / 1024).toFixed(0)}K chars 超出存储限制]`
  const truncationThreshold = MAX_SDK_MESSAGE_LENGTH / 2

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone: any = JSON.parse(JSON.stringify(msg))
  const content = clone.message?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (!block || typeof block !== 'object') continue

      // 截断超长 text block
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > truncationThreshold) {
        block.text = block.text.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
      }

      // 截断超大 tool_result
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string' && block.content.length > truncationThreshold) {
          block.content = block.content.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
        }
        // 剥离 base64 图片数据
        if (Array.isArray(block.content)) {
          block.content = block.content.map((item: Record<string, unknown>) => {
            if (item?.type === 'image' && (item.source as Record<string, unknown>)?.data) {
              const dataLen = String((item.source as Record<string, unknown>).data).length
              return { type: 'image', _truncated: true, _originalLength: dataLen }
            }
            return item
          })
        }
      }
    }
  }

  // 截断 error.message
  if (clone.error && typeof clone.error === 'object' && typeof clone.error.message === 'string' && clone.error.message.length > truncationThreshold) {
    clone.error.message = clone.error.message.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
  }

  return clone as SDKMessage
}

/**
 * 读取会话的所有 SDKMessage（兼容旧 AgentMessage 格式）
 *
 * 旧格式（有 `role` 字段）会被转换为近似的 SDKMessage。
 * 新格式（有 `type` 字段）直接返回。
 */
export function getAgentSessionSDKMessages(id: string): SDKMessage[] {
  const filePath = getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    const messages = parseJsonlLenient<unknown>(lines, `读取 SDKMessage (${id})`)
      .map(normalizePersistedSDKMessage)
      .filter(message => !isUnstructuredRuntimeAssistantError(message))
    return collapseDuplicateAssistantMessageGroups(orderSDKMessagesByCreatedAt(messages))
  } catch (error) {
    console.error(`[Agent 会话] 读取 SDKMessage 失败 (${id}):`, error)
    return []
  }
}

/**
 * 折叠 Transcript 中 compact / 同步产生的重复快照。
 *
 * 1) 同一 assistant message.id 的非连续重复：正常流式拆分会以相同 message.id
 *    连续出现，需要保留；compact 后再落一次完整消息时丢弃。
 * 2) 新 message.id 但 assistant tool_use call id 已出现过：compact 可能改写 message.id
 *    却保留原 call id，把历史工具调用重新甩到最新一轮之后，需要按 call id 折叠。
 *    注意：仅看 assistant tool_use，不因先出现的 tool_result 误杀真正的工具调用。
 * 3) 纯 tool_result 用户消息按 tool_use_id 去重，避免 compact 后结果重放。
 */
export function collapseDuplicateAssistantMessageGroups(
  messages: SDKMessage[],
): SDKMessage[] {
  const seenAssistantMessageIds = new Set<string>()
  const seenToolResultIds = new Set<string>()
  // 仅统计 assistant 侧已见 tool_use。不能把 tool_result 算作“已出现 tool_use”，
  // 否则顺序错乱（result 先于 use）时会把真正的 Agent/工具调用整段丢掉。
  const knownAssistantToolUseIds = new Set<string>()
  // 顶层用户原文：用于折叠 429 重试导入的重复用户气泡
  const seenTopLevelUserTexts = new Set<string>()
  const collapsed: SDKMessage[] = []
  const nativeMessageSlots = new Map<string, number>()

  for (const message of messages) {
    const record = message as Record<string, unknown>
    if (record._promaNativeMessage === true) {
      // 原生身份相同才更新快照；相同文案、时间或工具参数不是重复依据。
      const uuid = typeof record.uuid === 'string' ? record.uuid : undefined
      const slot = uuid ? nativeMessageSlots.get(uuid) : undefined
      if (slot !== undefined) collapsed[slot] = message
      else {
        if (uuid) nativeMessageSlots.set(uuid, collapsed.length)
        collapsed.push(message)
      }
      continue
    }
    // 丢弃 CCB 中断合成 user，避免显示为用户气泡 / 二次停止状态
    if (isCcbInterruptUserMessage(message)) {
      continue
    }
    // 丢弃压缩续写合成 user
    if (isCcbCompactionContinuationUserMessage(message)) {
      continue
    }
    // 丢弃 abort / 429 等瞬时 API Error 合成 assistant
    if (isCcbTransientApiErrorAssistantMessage(message)) {
      continue
    }

    // 顶层同文案重复 user：保留带桌面元数据的真实发送；无元数据的多为 Runtime 重试导入
    const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id
    const topLevelUserText =
      message.type === 'user'
      && !parentToolUseId
      && !isToolResultOnlyUserMessage(message)
        ? getUserMessageText(message)
        : undefined
    if (topLevelUserText) {
      if (
        seenTopLevelUserTexts.has(topLevelUserText)
        && !hasDesktopMessageMetadata(message)
      ) {
        continue
      }
    }
    const assistantMessageId = getAssistantMessageId(message)
    if (assistantMessageId) {
      if (seenAssistantMessageIds.has(assistantMessageId)) {
        const previous = collapsed[collapsed.length - 1]
        if (!previous || getAssistantMessageId(previous) !== assistantMessageId) {
          continue
        }
      } else {
        seenAssistantMessageIds.add(assistantMessageId)
      }
    }

    const assistantToolUseIds = uniqueStrings(extractAssistantToolUseIds(message))
    if (
      assistantToolUseIds.length > 0
      && assistantToolUseIds.every((id) => knownAssistantToolUseIds.has(id))
    ) {
      // 同 message.id 的连续流式拆分可能重复携带已出现的 tool_use，仍保留。
      const previous = collapsed[collapsed.length - 1]
      const isContiguousSameAssistantId =
        Boolean(assistantMessageId)
        && previous !== undefined
        && getAssistantMessageId(previous) === assistantMessageId
      if (!isContiguousSameAssistantId) {
        continue
      }
    }

    if (isToolResultOnlyUserMessage(message)) {
      const toolResultIds = uniqueStrings(extractUserToolResultIds(message))
      if (
        toolResultIds.length > 0
        && toolResultIds.every((id) => seenToolResultIds.has(id))
      ) {
        continue
      }
    }

    collapsed.push(message)

    if (topLevelUserText) {
      seenTopLevelUserTexts.add(topLevelUserText)
    }
    for (const id of assistantToolUseIds) {
      knownAssistantToolUseIds.add(id)
    }
    for (const id of extractUserToolResultIds(message)) {
      seenToolResultIds.add(id)
    }
  }

  return collapsed
}

function getMessageContentBlocks(message: SDKMessage): unknown[] {
  const content = (
    message as unknown as {
      message?: { content?: unknown }
    }
  ).message?.content
  return Array.isArray(content) ? content : []
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function extractAssistantToolUseIds(message: SDKMessage): string[] {
  if (message.type !== 'assistant') return []
  const ids: string[] = []
  for (const block of getMessageContentBlocks(message)) {
    if (!block || typeof block !== 'object') continue
    const record = block as { type?: unknown; id?: unknown }
    if (
      record.type === 'tool_use'
      && typeof record.id === 'string'
      && record.id.length > 0
    ) {
      ids.push(record.id)
    }
  }
  return ids
}

function extractUserToolResultIds(message: SDKMessage): string[] {
  if (message.type !== 'user') return []
  const ids: string[] = []
  for (const block of getMessageContentBlocks(message)) {
    if (!block || typeof block !== 'object') continue
    const record = block as { type?: unknown; tool_use_id?: unknown }
    if (
      record.type === 'tool_result'
      && typeof record.tool_use_id === 'string'
      && record.tool_use_id.length > 0
    ) {
      ids.push(record.tool_use_id)
    }
  }
  return ids
}

function isToolResultOnlyUserMessage(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const blocks = getMessageContentBlocks(message)
  if (blocks.length === 0) return false
  return blocks.every((block) => {
    if (!block || typeof block !== 'object') return false
    return (block as { type?: unknown }).type === 'tool_result'
  })
}

function getSDKMessageIdentity(message: SDKMessage): string {
  const uuid = (message as { uuid?: unknown }).uuid
  if (typeof uuid === 'string' && uuid.length > 0) return `uuid:${uuid}`
  const record = message as unknown as Record<string, unknown>
  return `content:${message.type}:${JSON.stringify({
    message: record.message,
    subtype: record.subtype,
    parent_tool_use_id: record.parent_tool_use_id,
  })}`
}

function getAssistantMessageId(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant') return undefined
  const messageId = (
    message as unknown as {
      message?: { id?: unknown }
    }
  ).message?.id
  return typeof messageId === 'string' && messageId.length > 0
    ? messageId
    : undefined
}

function getUserMessageText(message: SDKMessage): string | undefined {
  if (message.type !== 'user') return undefined
  const content = (
    message as unknown as {
      message?: { content?: unknown }
    }
  ).message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        Boolean(
          block
          && typeof block === 'object'
          && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string',
        ),
    )
    .map(block => block.text)
    .join('\n')
    .trim()
  return text || undefined
}

const RUNTIME_USER_CONTEXT_TAGS = [
  'mentioned_tools',
  'referenced_sessions',
] as const

/**
 * CCB Transcript 保存的是实际提交给 Runtime 的增强 Prompt，而 Proma 本地投影
 * 保存用户原文。仅剥离 Proma 在消息头部注入的已知上下文块，用于二者匹配；
 * 展示时仍保留本地原文，避免把工具/会话引用说明显示给用户。
 */
function normalizeRuntimeUserMessageText(text: string): string {
  let normalized = text.trim()

  for (const tag of RUNTIME_USER_CONTEXT_TAGS) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const contextBlock = new RegExp(
      `^<${escapedTag}>[\\s\\S]*?<\\/${escapedTag}>\\s*`,
    )
    normalized = normalized.replace(contextBlock, '').trimStart()
  }

  return normalized.trim()
}

function areEquivalentUserMessageTexts(
  runtimeText: string,
  localText: string,
): boolean {
  if (runtimeText === localText) return true
  return normalizeRuntimeUserMessageText(runtimeText) === localText
}

function getMessageCreatedAt(message: SDKMessage): number | undefined {
  const record = message as unknown as {
    _createdAt?: unknown
    timestamp?: unknown
  }
  if (
    typeof record._createdAt === 'number'
    && Number.isFinite(record._createdAt)
  ) {
    return record._createdAt
  }
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
    return record.timestamp
  }
  if (typeof record.timestamp === 'string') {
    const timestamp = Date.parse(record.timestamp)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return undefined
}

function hasDesktopMessageMetadata(message: SDKMessage): boolean {
  return Object.keys(message as unknown as Record<string, unknown>)
    .some(key => key.startsWith('_'))
}

/**
 * 评估一组 assistant 消息的内容完整度。
 *
 * 同一 message.id 下，桌面端可能只有流式 partial（仅 thinking / 单段 text），
 * 而 Runtime Transcript 已是 THINK + TEXT + tool_use 的完整消息。
 * 合并时不能只因本地有 `_createdAt` 等桌面元数据就压过更完整的 Runtime。
 */
function scoreAssistantMessagesCompleteness(messages: SDKMessage[]): number {
  let textLength = 0
  let thinkingLength = 0
  let toolUseCount = 0
  let blockCount = 0
  const toolUseIds = new Set<string>()

  for (const message of messages) {
    for (const block of getMessageContentBlocks(message)) {
      if (!block || typeof block !== 'object') continue
      const record = block as {
        type?: unknown
        text?: unknown
        thinking?: unknown
        id?: unknown
      }
      blockCount += 1
      if (record.type === 'text' && typeof record.text === 'string') {
        textLength += record.text.trim().length
      } else if (record.type === 'thinking') {
        const thinkingText =
          typeof record.thinking === 'string'
            ? record.thinking
            : typeof record.text === 'string'
              ? record.text
              : ''
        thinkingLength += thinkingText.trim().length
      } else if (record.type === 'tool_use') {
        toolUseCount += 1
        if (typeof record.id === 'string' && record.id.length > 0) {
          toolUseIds.add(record.id)
        }
      }
    }
  }

  // 正文与 tool_use 权重高于 thinking，避免「仅 thinking 的 partial」压过完整 Runtime。
  let score = 0
  score += textLength * 10
  score += thinkingLength
  score += toolUseCount * 500
  score += toolUseIds.size * 100
  score += blockCount * 20
  if (textLength > 0) score += 1000
  if (toolUseCount > 0) score += 2000
  return score
}

function mergeRuntimeMessageWithLocalMetadata(
  runtimeMessage: SDKMessage,
  localMessage: SDKMessage,
): SDKMessage {
  const runtimeRecord = runtimeMessage as unknown as Record<string, unknown>
  const localRecord = localMessage as unknown as Record<string, unknown>
  const desktopMetadata = Object.fromEntries(
    Object.entries(localRecord).filter(([key]) => key.startsWith('_')),
  )
  // 内容以 Runtime 完整消息为准时，丢弃本地 partial 流式索引，避免误导后续合并。
  delete desktopMetadata._partialBlockIndex
  delete desktopMetadata._partialBlockIndexes
  return {
    ...runtimeRecord,
    ...desktopMetadata,
  } as unknown as SDKMessage
}

/**
 * 将 Runtime 尚未覆盖的 Proma 本地消息放回原时间位置。
 *
 * CCB Transcript 是执行顺序来源，但 Proma JSONL 还可能含有刚发送、被并发守卫
 * 拒绝或仅桌面端持久化的消息。不能把这些消息统一追加到末尾，否则后台同步会让
 * 旧用户消息突然移动到最新回复之后，看起来像回复消失。
 */
function insertLocalMessageByCreatedAt(
  messages: SDKMessage[],
  localMessage: SDKMessage,
): void {
  const createdAt = getMessageCreatedAt(localMessage)
  if (createdAt === undefined) {
    messages.push(localMessage)
    return
  }

  const firstLaterIndex = messages.findIndex((message) => {
    const messageCreatedAt = getMessageCreatedAt(message)
    return messageCreatedAt !== undefined && messageCreatedAt > createdAt
  })

  if (firstLaterIndex < 0) {
    messages.push(localMessage)
    return
  }
  messages.splice(firstLaterIndex, 0, localMessage)
}

/**
 * 将 CCB Transcript 合并进 Proma JSONL UI 投影。
 *
 * Runtime Transcript 负责补齐执行消息，但不能删除本地尚未落入 Transcript 的
 * 用户消息、附件、错误和桌面专有元数据。即使 Transcript 暂时为空，也保持
 * 当前本地投影不变。
 */
export function mergeAgentSessionSDKMessages(
  id: string,
  runtimeMessages: SDKMessage[],
): SDKMessage[] {
  const localMessages = getAgentSessionSDKMessages(id)
  const projectionRuntimeMessages = runtimeMessages
    .map(normalizeCcbAssistantMessage)
    .filter(message => !isUnstructuredRuntimeAssistantError(message))
    .filter(message => !isCcbInterruptUserMessage(message))
    .filter(message => !isCcbCompactionContinuationUserMessage(message))
    .filter(message => !isCcbTransientApiErrorAssistantMessage(message))
  if (projectionRuntimeMessages.length === 0) return localMessages

  const consumedLocalIndexes = new Set<number>()
  const seenAssistantMessageIds = new Set<string>()
  const seenToolResultIds = new Set<string>()
  const knownExecutedToolIds = new Set<string>()
  // 仅 assistant 侧 tool_use。不能把本地 tool_result 算作“已有 tool_use”，
  // 否则停止后残缺 partial（无 tool_use 仅有 tool_result）会让 Runtime 完整
  // assistant 被误判为 compact 重放而整条丢弃，正文与工具调用一并消失。
  const knownAssistantToolUseIds = new Set<string>()
  const merged: SDKMessage[] = []
  let lastMatchedLocalCreatedAt: number | undefined
  // 已并入投影的顶层用户原文。CCB 429 重试会在 Transcript 重复同一 prompt；
  // 本地没有新的 user 发送时不应再导入成多个用户气泡。
  const mergedTopLevelUserTexts = new Set<string>()

  const findLocalIndexes = (
    predicate: (message: SDKMessage) => boolean,
  ): number[] => localMessages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        !consumedLocalIndexes.has(index) && predicate(message),
    )
    .map(({ index }) => index)

  const registerMessageToolIds = (message: SDKMessage): void => {
    for (const id of extractAssistantToolUseIds(message)) {
      knownAssistantToolUseIds.add(id)
      knownExecutedToolIds.add(id)
    }
    for (const id of extractUserToolResultIds(message)) {
      seenToolResultIds.add(id)
      knownExecutedToolIds.add(id)
    }
  }

  // 先登记本地已有 tool id，这样 Runtime 在 compact 后把历史工具重放到末尾时
  // 可以立刻识别并跳过，而不是等最终 collapse。
  for (const localMessage of localMessages) {
    registerMessageToolIds(localMessage)
  }

  const markAssistantMessageSeen = (message: SDKMessage): void => {
    const assistantMessageId = getAssistantMessageId(message)
    if (assistantMessageId) seenAssistantMessageIds.add(assistantMessageId)
    registerMessageToolIds(message)
  }

  const consumeLocalAssistantDuplicates = (assistantMessageId: string): void => {
    for (const index of findLocalIndexes(
      localMessage => getAssistantMessageId(localMessage) === assistantMessageId,
    )) {
      consumedLocalIndexes.add(index)
    }
  }

  const isCompactToolReplay = (message: SDKMessage): boolean => {
    const assistantToolUseIds = uniqueStrings(extractAssistantToolUseIds(message))
    if (
      assistantToolUseIds.length > 0
      && assistantToolUseIds.every((id) => knownAssistantToolUseIds.has(id))
    ) {
      return true
    }
    if (isToolResultOnlyUserMessage(message)) {
      const toolResultIds = uniqueStrings(extractUserToolResultIds(message))
      if (
        toolResultIds.length > 0
        && toolResultIds.every((id) => seenToolResultIds.has(id))
      ) {
        return true
      }
    }
    return false
  }

  const sameToolResultIdSet = (
    left: string[],
    right: string[],
  ): boolean => {
    if (left.length === 0 || left.length !== right.length) return false
    return left.every((id) => right.includes(id))
  }

  for (const runtimeMessage of projectionRuntimeMessages) {
    const assistantMessageId = getAssistantMessageId(runtimeMessage)
    // Runtime Transcript 在 compact 后可能重复给出同一 message.id。
    // 已合并过的 id 直接跳过，否则旧回复会被再次追加到最新一轮之后。
    if (assistantMessageId && seenAssistantMessageIds.has(assistantMessageId)) {
      consumeLocalAssistantDuplicates(assistantMessageId)
      continue
    }
    // 先按 message.id / tool_result 匹配本地消息，再判定 compact 重放。
    // 否则「本地已有完整 tool_use/tool_result」时会把 Runtime 的正确交错顺序
    // 整段跳过，最终回落 insertLocalMessageByCreatedAt，停止后过程正文顺序错乱。
    if (assistantMessageId) {
      const matchingIndexes = findLocalIndexes(
        localMessage =>
          getAssistantMessageId(localMessage) === assistantMessageId,
      )
      if (matchingIndexes.length > 0) {
        const sortedMatchingIndexes = [...matchingIndexes].sort((a, b) => a - b)
        // 只保留首次连续分组（流式拆分），丢弃文件尾部同 id 的重复完整消息。
        const firstGroupIndexes: number[] = []
        for (const index of sortedMatchingIndexes) {
          const previous = firstGroupIndexes[firstGroupIndexes.length - 1]
          if (previous === undefined || index === previous + 1) {
            firstGroupIndexes.push(index)
            continue
          }
          break
        }
        const desktopIndexes = firstGroupIndexes.filter(index =>
          hasDesktopMessageMetadata(localMessages[index]!),
        )
        // 与历史行为一致：有桌面元数据时优先评估桌面拆分（避免把本地残留的
        // 无元数据完整副本算进“本地完整度”，导致拆条与 Runtime 并存）。
        const preferredIndexes =
          desktopIndexes.length > 0 ? desktopIndexes : firstGroupIndexes
        const preferredMessages = preferredIndexes.map(
          index => localMessages[index]!,
        )
        const preferredScore = scoreAssistantMessagesCompleteness(preferredMessages)
        const runtimeScore = scoreAssistantMessagesCompleteness([runtimeMessage])
        for (const index of matchingIndexes) consumedLocalIndexes.add(index)

        if (runtimeScore > preferredScore) {
          // Runtime 更完整：取完整内容，同时保留本地桌面元数据（渠道/时间等）。
          const metadataSource =
            preferredMessages.find(message => hasDesktopMessageMetadata(message))
            ?? preferredMessages[0]
            ?? runtimeMessage
          const mergedMessage = mergeRuntimeMessageWithLocalMetadata(
            runtimeMessage,
            metadataSource,
          )
          merged.push(mergedMessage)
          markAssistantMessageSeen(mergedMessage)
          const matchedCreatedAt = getMessageCreatedAt(metadataSource)
          if (matchedCreatedAt !== undefined) {
            lastMatchedLocalCreatedAt = matchedCreatedAt
          }
        } else {
          // 本地拆分至少同等完整：保留桌面投影（含流式拆条）。
          merged.push(...preferredMessages)
          for (const message of preferredMessages) markAssistantMessageSeen(message)
          const matchedCreatedAt = preferredMessages
            .map(message => getMessageCreatedAt(message))
            .filter((createdAt): createdAt is number => createdAt !== undefined)
            .reduce<number | undefined>(
              (latest, createdAt) =>
                latest === undefined ? createdAt : Math.max(latest, createdAt),
              undefined,
            )
          if (matchedCreatedAt !== undefined) {
            lastMatchedLocalCreatedAt = matchedCreatedAt
          }
        }
        continue
      }
    }

    if (isToolResultOnlyUserMessage(runtimeMessage)) {
      const runtimeToolResultIds = uniqueStrings(extractUserToolResultIds(runtimeMessage))
      if (runtimeToolResultIds.length > 0) {
        const matchingIndexes = findLocalIndexes((localMessage) => {
          if (!isToolResultOnlyUserMessage(localMessage)) return false
          return sameToolResultIdSet(
            runtimeToolResultIds,
            uniqueStrings(extractUserToolResultIds(localMessage)),
          )
        })
        if (matchingIndexes.length > 0) {
          const preferredIndex =
            matchingIndexes.find((index) =>
              hasDesktopMessageMetadata(localMessages[index]!),
            ) ?? matchingIndexes[0]!
          // 同一 tool_use_id 的本地重复 tool_result 一并消费，避免尾部再插一遍。
          for (const index of matchingIndexes) consumedLocalIndexes.add(index)
          const preferredLocal = localMessages[preferredIndex]!
          merged.push(preferredLocal)
          registerMessageToolIds(preferredLocal)
          const matchedCreatedAt = getMessageCreatedAt(preferredLocal)
          if (matchedCreatedAt !== undefined) {
            lastMatchedLocalCreatedAt = matchedCreatedAt
          }
          continue
        }
      }
    }

    // compact 也可能用新 message.id 重放历史 tool_use / tool_result。
    // 仅对「尚未匹配到本地消息」的 Runtime 条目生效。
    if (isCompactToolReplay(runtimeMessage)) {
      continue
    }

    const userText = getUserMessageText(runtimeMessage)
    if (userText) {
      const normalizedRuntimeText = normalizeRuntimeUserMessageText(userText)
      const equivalentIndexes = findLocalIndexes(
        (localMessage) => {
          const localText = getUserMessageText(localMessage)
          return Boolean(
            localText
            && areEquivalentUserMessageTexts(userText, localText),
          )
        },
      )
      if (equivalentIndexes.length > 0) {
        const chronologicalIndexes = [...equivalentIndexes].sort((a, b) => {
          const aCreatedAt = getMessageCreatedAt(localMessages[a]!)
          const bCreatedAt = getMessageCreatedAt(localMessages[b]!)
          if (aCreatedAt === undefined && bCreatedAt === undefined) return a - b
          if (aCreatedAt === undefined) return 1
          if (bCreatedAt === undefined) return -1
          return aCreatedAt - bCreatedAt || a - b
        })
        const localCreatedAtFloor = lastMatchedLocalCreatedAt
        const eligibleIndexes = localCreatedAtFloor === undefined
          ? chronologicalIndexes
          : chronologicalIndexes.filter((index) => {
              const createdAt = getMessageCreatedAt(localMessages[index]!)
              return createdAt === undefined || createdAt >= localCreatedAtFloor
            })
        let candidateIndexes =
          eligibleIndexes.length > 0 ? eligibleIndexes : chronologicalIndexes
        const alreadyMergedUserText =
          mergedTopLevelUserTexts.has(normalizedRuntimeText)
          || mergedTopLevelUserTexts.has(userText)
        // 同一原文已并入后，只允许再匹配带桌面元数据的真实二次发送。
        // 无元数据的本地副本通常是 429 重试导入，不能继续匹配成多个气泡。
        if (alreadyMergedUserText) {
          candidateIndexes = candidateIndexes.filter((index) =>
            hasDesktopMessageMetadata(localMessages[index]!),
          )
          if (candidateIndexes.length === 0) {
            for (const index of equivalentIndexes) {
              if (!hasDesktopMessageMetadata(localMessages[index]!)) {
                consumedLocalIndexes.add(index)
              }
            }
            continue
          }
        }
        const runtimeIdentity = getSDKMessageIdentity(runtimeMessage)
        const identityIndex = candidateIndexes.find(index =>
          getSDKMessageIdentity(localMessages[index]!) === runtimeIdentity,
        )
        const originalTextIndexes = candidateIndexes.filter(index =>
          getUserMessageText(localMessages[index]!) === normalizedRuntimeText,
        )
        const preferredIndex =
          originalTextIndexes.find(index =>
            hasDesktopMessageMetadata(localMessages[index]!),
          ) ?? originalTextIndexes[0]
          ?? candidateIndexes.find(index =>
            hasDesktopMessageMetadata(localMessages[index]!),
          )
          ?? identityIndex
          ?? candidateIndexes[0]!
        const enhancedPromptIndex = normalizedRuntimeText !== userText
          ? candidateIndexes.find(index =>
              getUserMessageText(localMessages[index]!) === userText,
            )
          : undefined

        // 一个 Runtime user 只消费一个 Proma 原文，避免历史中相同提问被误删。
        // 若本地还保留了 Runtime 增强 Prompt，则一并消费该副本。
        consumedLocalIndexes.add(preferredIndex)
        if (identityIndex !== undefined) {
          consumedLocalIndexes.add(identityIndex)
        }
        if (enhancedPromptIndex !== undefined) {
          consumedLocalIndexes.add(enhancedPromptIndex)
        }
        // 首次并入后，顺带消费同文案的无桌面元数据污染副本（429 重试导入）。
        for (const index of equivalentIndexes) {
          if (consumedLocalIndexes.has(index)) continue
          if (!hasDesktopMessageMetadata(localMessages[index]!)) {
            consumedLocalIndexes.add(index)
          }
        }
        const preferredLocal = localMessages[preferredIndex]!
        merged.push(preferredLocal)
        registerMessageToolIds(preferredLocal)
        const preferredText = getUserMessageText(preferredLocal)
        if (preferredText) mergedTopLevelUserTexts.add(preferredText)
        const matchedCreatedAt = getMessageCreatedAt(preferredLocal)
        if (matchedCreatedAt !== undefined) {
          lastMatchedLocalCreatedAt = matchedCreatedAt
        }
        continue
      }
    }

    // Runtime-only 重复 prompt（本地已展示过同一用户原文）：视为重试记录，不新增气泡
    if (userText) {
      const normalizedRuntimeText = normalizeRuntimeUserMessageText(userText)
      if (
        mergedTopLevelUserTexts.has(normalizedRuntimeText)
        || mergedTopLevelUserTexts.has(userText)
      ) {
        continue
      }
    }

    const identity = getSDKMessageIdentity(runtimeMessage)
    const matchingIndex = localMessages.findIndex(
      (localMessage, index) =>
        !consumedLocalIndexes.has(index)
        && getSDKMessageIdentity(localMessage) === identity,
    )
    if (matchingIndex >= 0) {
      consumedLocalIndexes.add(matchingIndex)
      const mergedMessage = mergeRuntimeMessageWithLocalMetadata(
        runtimeMessage,
        localMessages[matchingIndex]!,
      )
      merged.push(mergedMessage)
      markAssistantMessageSeen(mergedMessage)
      const matchedCreatedAt = getMessageCreatedAt(localMessages[matchingIndex]!)
      if (matchedCreatedAt !== undefined) {
        lastMatchedLocalCreatedAt = matchedCreatedAt
      }
    } else {
      merged.push(runtimeMessage)
      markAssistantMessageSeen(runtimeMessage)
      const runtimeUserText = getUserMessageText(runtimeMessage)
      if (runtimeUserText) {
        mergedTopLevelUserTexts.add(normalizeRuntimeUserMessageText(runtimeUserText))
      }
      const runtimeCreatedAt = getMessageCreatedAt(runtimeMessage)
      if (runtimeCreatedAt !== undefined) {
        lastMatchedLocalCreatedAt = runtimeCreatedAt
      }
    }
  }

  const pendingResults: SDKMessage[] = []
  localMessages.forEach((localMessage, index) => {
    if (consumedLocalIndexes.has(index)) return
    // 本地历史若已混入 CCB 中断合成 user，合并时一并剔除
    if (isCcbInterruptUserMessage(localMessage)) return
    if (isCcbCompactionContinuationUserMessage(localMessage)) return
    if (isCcbTransientApiErrorAssistantMessage(localMessage)) return
    // 未消费的无元数据同文案 user：视为 429 重试导入污染，不再插回
    const pendingUserText = getUserMessageText(localMessage)
    const pendingParent = (localMessage as { parent_tool_use_id?: unknown }).parent_tool_use_id
    if (
      localMessage.type === 'user'
      && !pendingParent
      && pendingUserText
      && !isToolResultOnlyUserMessage(localMessage)
      && (
        mergedTopLevelUserTexts.has(pendingUserText)
        || mergedTopLevelUserTexts.has(normalizeRuntimeUserMessageText(pendingUserText))
      )
      && !hasDesktopMessageMetadata(localMessage)
    ) {
      return
    }
    if (localMessage.type === 'result') {
      pendingResults.push(localMessage)
      return
    }
    const localAssistantMessageId = getAssistantMessageId(localMessage)
    if (
      localAssistantMessageId
      && seenAssistantMessageIds.has(localAssistantMessageId)
    ) {
      return
    }
    insertLocalMessageByCreatedAt(merged, localMessage)
    markAssistantMessageSeen(localMessage)
  })

  // Runtime Transcript 通常不包含 Proma 的 result 完成元数据。按同一 Turn 的
  // _createdAt 将其放回最后一条 Runtime 消息之后，不能统一追加到文件尾部。
  for (const resultMessage of pendingResults) {
    const resultCreatedAt = getMessageCreatedAt(resultMessage)
    let insertIndex = -1
    if (resultCreatedAt !== undefined) {
      for (let index = merged.length - 1; index >= 0; index--) {
        if (getMessageCreatedAt(merged[index]!) === resultCreatedAt) {
          insertIndex = index + 1
          break
        }
      }
    }

    if (insertIndex < 0) {
      merged.push(resultMessage)
    } else {
      while (
        insertIndex < merged.length
        && merged[insertIndex]?.type === 'result'
        && getMessageCreatedAt(merged[insertIndex]!) === resultCreatedAt
      ) {
        insertIndex += 1
      }
      merged.splice(insertIndex, 0, resultMessage)
    }
  }

  const filePath = getAgentSessionMessagesPath(id)
  const projection = collapseDuplicateAssistantMessageGroups(merged)
  const content = `${projection
    .map(message => serializeSDKMessageForStorage(message))
    .join('\n')}\n`
  writeTextFileAtomic(filePath, content)
  return projection
}

/**
 * convertLegacyMessage 已迁移至 @proma/session-core（本文件从该包 import 使用）。
 */

/**
 * 更新会话元数据
 */
export function updateAgentSessionMeta(
  id: string,
  updates: Partial<Pick<AgentSessionMeta, 'title' | 'draft' | 'titleSource' | 'channelId' | 'modelId' | 'runtimeId' | 'runtimeSessionId' | 'runtimeVersion' | 'runtimeArtifactCommit' | 'runtimeProtocolVersion' | 'runtimeLastSequence' | 'runtimeWorkerState' | 'workspaceId' | 'pinned' | 'starred' | 'archived' | 'attachedDirectories' | 'attachedFiles' | 'resumeAtMessageUuid' | 'stoppedByUser' | 'dispatchState' | 'lastStopDurationMs' | 'permissionMode' | 'planModeEnabled' | 'completedButUnconfirmed' | 'sourceAutomationId' | 'automationGraduated' | 'parentSessionId' | 'rootSessionId' | 'sourceDelegationId' | 'taskboardTaskId' | 'delegationRole' | 'delegationStatus' | 'delegationDepth' | 'delegationGoal' | 'registeredAgentSnapshot'>>,
): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`)
  }

  const existing = index.sessions[idx]!
  const updateKeys = Object.keys(updates)
  // 星标只是侧栏的视觉标记，不应改变会话的新鲜度或归档状态。
  const isStarredOnly = updateKeys.every((key) => key === 'starred')
  // 渠道/模型绑定属于下一轮 Runtime 配置，不代表会话产生了新内容。
  // 批量同步模型配置时必须保留 updatedAt 和归档状态，避免侧栏顺序被刷新。
  const isModelBindingOnly =
    updateKeys.length > 0
    && updateKeys.every((key) => key === 'channelId' || key === 'modelId')
  // 非手动归档操作时，若会话已归档则自动恢复为活跃（仅更新 stoppedByUser 或 starred 不触发解归档）
  const isStoppedByUserOnly = updateKeys.every((key) => key === 'stoppedByUser')
  const isRuntimePreferenceOnly =
    updateKeys.length > 0
    && updateKeys.every((key) =>
      key === 'permissionMode'
      || key === 'planModeEnabled'
    )
  // Worker 状态/序号同步不应改变侧栏新鲜度，否则空闲回收会把会话顶到前面。
  const isRuntimeWorkerTelemetryOnly =
    updateKeys.length > 0
    && updateKeys.every(
      (key) => key === 'runtimeWorkerState' || key === 'runtimeLastSequence',
    )
  const preserveFreshness =
    isStarredOnly
    || isModelBindingOnly
    || isRuntimePreferenceOnly
    || isRuntimeWorkerTelemetryOnly
  const autoUnarchive =
    existing.archived
    && !('archived' in updates)
    && !isStoppedByUserOnly
    && !preserveFreshness
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    ...(autoUnarchive ? { archived: false } : {}),
    updatedAt: preserveFreshness ? existing.updatedAt : Date.now(),
  }

  index.sessions[idx] = updated
  writeIndex(index)

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`)
  return updated
}

/**
 * 删除会话
 */
function cleanupAgentSessionProjectionFiles(id: string): void {
  // 删除消息文件
  const filePath = getAgentSessionMessagesPath(id)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.warn(`[Agent 会话] 删除消息文件失败 (${id}):`, error)
    }
  }

  // 清理 Proma 私有附件；用户项目目录永远不由会话删除逻辑处理。
  try {
    const attachmentsDir = resolveAgentSessionAttachmentsDir(id)
    if (existsSync(attachmentsDir)) {
      rmSyncWithRetry(attachmentsDir, { recursive: true, force: true })
      console.log(`[Agent 会话] 已清理 session 附件目录: ${attachmentsDir}`)
    }
  } catch (error) {
    console.warn(`[Agent 会话] 清理 session 附件目录失败 (${id}):`, error)
  }

  // 清理 Nano Banana 生图历史
  clearNanoBananaAgentHistory(id)
  void promaBuiltinMcpHttpHost.releaseSession(id)
}

export function deleteAgentSession(id: string): void {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    console.warn(`[Agent 会话] 会话不存在，跳过删除: ${id}`)
    return
  }

  const removed = index.sessions.splice(idx, 1)[0]!
  writeIndex(index)
  cleanupAgentSessionProjectionFiles(id)
  console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`)
}

/**
 * 收集会话及其全部委派子会话。
 */
function collectSessionTreeIds(sessions: AgentSessionMeta[], sessionId: string): Set<string> {
  const ids = new Set<string>([sessionId])
  let changed = true

  while (changed) {
    changed = false
    for (const session of sessions) {
      if (ids.has(session.id)) continue
      // 仅收集协作委派子会话。parent/root 负责维护树结构，sourceDelegationId 负责限定来源。
      if (!session.sourceDelegationId) continue
      if (session.parentSessionId && ids.has(session.parentSessionId)) {
        ids.add(session.id)
        changed = true
        continue
      }
      if (session.rootSessionId === sessionId) {
        ids.add(session.id)
        changed = true
      }
    }
  }

  return ids
}

/**
 * 迁移 Agent 会话到另一个工作区
 *
 * 操作步骤：
 * 1. 验证会话和目标工作区存在
 * 2. 收集目标会话及其委派子会话
 * 3. 更新元数据（workspaceId + 清空 Runtime Session 映射）
 * 5. JSONL 消息文件保持原位（全局目录）
 */
export function moveSessionToWorkspace(sessionId: string, targetWorkspaceId: string): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${sessionId}`)
  }

  const session = index.sessions[idx]!

  const targetWs = getAgentWorkspace(targetWorkspaceId)
  if (!targetWs) {
    throw new Error(`目标工作区不存在: ${targetWorkspaceId}`)
  }

  const sessionTreeIds = collectSessionTreeIds(index.sessions, sessionId)
  const sessionsToMove = index.sessions.filter((item) => sessionTreeIds.has(item.id) && item.workspaceId !== targetWorkspaceId)
  if (sessionsToMove.length === 0) return session

  const now = Date.now()
  let updatedRoot = session
  let movedCount = 0

  for (let i = 0; i < index.sessions.length; i++) {
    const current = index.sessions[i]!
    if (!sessionTreeIds.has(current.id) || current.workspaceId === targetWorkspaceId) continue

    const updated: AgentSessionMeta = {
      ...current,
      workspaceId: targetWorkspaceId,
      runtimeSessionId: undefined,
      runtimeWorkerState: 'cold',
      updatedAt: now,
    }
    index.sessions[i] = updated
    writeIndex(index)
    movedCount++
    if (current.id === sessionId) {
      updatedRoot = updated
    }
  }

  console.log(`[Agent 会话] 已迁移会话及子会话到工作区: ${updatedRoot.title}（${movedCount} 个）→ ${targetWs.name}`)
  return updatedRoot
}

/**
 * 迁移 Chat 对话记录到 Agent 会话
 *
 * 读取 Chat 对话的消息，转换为 AgentMessage 格式，
 * 追加到目标 Agent 会话的 JSONL 文件中。
 *
 * 仅迁移 user 和 assistant 角色的消息文本内容，
 * 工具活动、推理、附件等 Chat 特有字段不迁移。
 */
export function migrateChatToAgentSession(conversationId: string, agentSessionId: string): void {
  const chatMessages = getConversationMessages(conversationId)

  if (chatMessages.length === 0) {
    console.log(`[Agent 会话] Chat 对话无消息，跳过迁移 (${conversationId})`)
    return
  }

  let count = 0
  for (const cm of chatMessages) {
    // 仅迁移 user 和 assistant 消息
    if (cm.role !== 'user' && cm.role !== 'assistant') continue
    if (!cm.content.trim()) continue

    const agentMsg: AgentMessage = {
      id: randomUUID(),
      role: cm.role,
      content: cm.content,
      createdAt: cm.createdAt,
      model: cm.role === 'assistant' ? cm.model : undefined,
    }

    appendAgentMessage(agentSessionId, agentMsg)
    count++
  }

  console.log(`[Agent 会话] 已迁移 ${count} 条消息到 Agent 会话 (${conversationId} → ${agentSessionId})`)
}

/**
 * 使用 CCB Runtime 已完成分叉后，创建 Proma 侧的新会话投影。
 *
 * Runtime transcript 是执行上下文真源；这里仅复制 UI JSONL 与工作目录，
 * 并把新 Proma Session 映射到 Runtime 返回的 session ID。
 */
export async function createForkedAgentSessionProjection(
  input: ForkSessionInput,
  runtimeSessionId: string,
): Promise<AgentSessionMeta> {
  const sourceMeta = getAgentSessionMeta(input.sessionId)
  if (!sourceMeta) throw new Error(`源 Agent 会话不存在: ${input.sessionId}`)

  // 注册定义固定模型时，fork 仍属于同一注册角色，不能通过 fork 参数改写。
  const requestedForkModelId = sourceMeta.registeredAgentSnapshot?.modelId ?? input.modelId
  const forkModelId = requestedForkModelId !== undefined
    ? assertEnabledModelForChannel({
        channelId: sourceMeta.channelId,
        modelId: requestedForkModelId,
        purpose: '分叉 Agent 会话',
      })
    : sourceMeta.modelId
  const sourceDir = resolveAgentSessionAttachmentsDir(sourceMeta.id)
  const newMeta = createAgentSession(
    `${sourceMeta.title} (fork)`,
    sourceMeta.channelId,
    sourceMeta.workspaceId,
    forkModelId,
  )

  try {
    const updated = updateAgentSessionMeta(newMeta.id, {
      runtimeSessionId,
      permissionMode: sourceMeta.permissionMode,
      planModeEnabled: sourceMeta.planModeEnabled,
      parentSessionId: sourceMeta.parentSessionId,
      rootSessionId: sourceMeta.rootSessionId,
      delegationRole: sourceMeta.delegationRole,
      delegationDepth: sourceMeta.delegationDepth,
      delegationGoal: sourceMeta.delegationGoal,
      registeredAgentSnapshot: cloneRegisteredAgentRuntimeSnapshot(
        sourceMeta.registeredAgentSnapshot,
      ),
    })
    const destDir = getAgentSessionAttachmentsDir(newMeta.id)
    if (existsSync(sourceDir)) {
      copyForkWorkspaceFiles(sourceDir, destDir)
    }
    await copyForkStoredSDKMessages({
      sourceSessionId: sourceMeta.id,
      destSessionId: newMeta.id,
      upToMessageUuid: input.upToMessageUuid,
      sourceDir,
      destDir,
    })
    console.log(
      `[Agent 会话] 已创建 CCB Runtime 分叉投影: ${sourceMeta.id} → ${updated.id} (${runtimeSessionId})`,
    )
    return updated
  } catch (error) {
    try { deleteAgentSession(newMeta.id) } catch { /* 保留原始错误 */ }
    throw error
  }
}

function cloneRegisteredAgentRuntimeSnapshot(
  snapshot: RegisteredAgentRuntimeSnapshot | undefined,
): RegisteredAgentRuntimeSnapshot | undefined {
  if (!snapshot) return undefined
  return {
    ...snapshot,
    ...(snapshot.tools ? { tools: [...snapshot.tools] } : {}),
    ...(snapshot.disallowedTools ? { disallowedTools: [...snapshot.disallowedTools] } : {}),
  }
}

interface CopyForkStoredSDKMessagesInput {
  sourceSessionId: string
  destSessionId: string
  upToMessageUuid?: string
  sourceDir?: string
  destDir?: string
}

async function copyForkStoredSDKMessages({
  sourceSessionId,
  destSessionId,
  upToMessageUuid,
  sourceDir,
  destDir,
}: CopyForkStoredSDKMessagesInput): Promise<number> {
  const sourcePath = getAgentSessionMessagesPath(sourceSessionId)
  if (!existsSync(sourcePath)) return 0

  const destPath = getAgentSessionMessagesPath(destSessionId)
  const out = createWriteStream(destPath, { flags: 'a', encoding: 'utf-8' })
  let copiedCount = 0

  try {
    for await (const msg of readStoredSDKMessages(sourcePath)) {
      await writeJsonlLine(out, serializeSDKMessageForStorage(msg, sourceDir, destDir))
      copiedCount += 1

      if (upToMessageUuid && getStoredMessageUuid(msg) === upToMessageUuid) {
        break
      }
    }
    await endWriteStream(out)
  } catch (err) {
    out.destroy()
    throw err
  }

  return copiedCount
}

async function* readStoredSDKMessages(filePath: string): AsyncGenerator<SDKMessage> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if ('role' in parsed && !('type' in parsed)) {
        yield convertLegacyMessage(parsed as AgentMessage)
      } else {
        yield parsed as SDKMessage
      }
    } catch (err) {
      console.warn(`[Agent 会话] 跳过无法解析的 SDKMessage 行 (${filePath}):`, err)
    }
  }
}

function getStoredMessageUuid(msg: SDKMessage): string | undefined {
  return 'uuid' in msg ? (msg as { uuid?: string }).uuid : undefined
}

function serializeSDKMessageForStorage(
  msg: SDKMessage,
  sourceDir?: string,
  destDir?: string,
): string {
  let serialized = JSON.stringify(msg)
  if (sourceDir && destDir) {
    serialized = rewriteSourceToDest(serialized, sourceDir, destDir)
  }
  if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return serialized

  let sanitized = JSON.stringify(sanitizeOversizedMessage(msg, serialized.length))
  if (sourceDir && destDir) {
    sanitized = rewriteSourceToDest(sanitized, sourceDir, destDir)
  }
  if (sanitized.length > MAX_SDK_MESSAGE_LENGTH) {
    console.warn(`[Agent 会话] 消息截断后仍超限 (${(sanitized.length / 1024).toFixed(0)}K chars)`)
  }
  return sanitized
}

async function writeJsonlLine(stream: WriteStream, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(line + '\n', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function endWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

/**
 * 将一段字符串中所有出现的 sourceDir 替换为 destDir。
 *
 * 用于 fork 会话时把历史中嵌入的源会话绝对路径迁移到新会话目录。
 * 处理 JSON 字符串中可能出现的两种编码形式：
 * 1. 原始路径（如 /Users/a/b）
 * 2. JSON 字符串编码后的形式（路径中的 `/` JSON 标准下不会转义，所以通常与 1 一致；
 *    但保留对反斜杠的处理以兼容 Windows 路径）
 *
 * sourceDir 和 destDir 都会规范化去除末尾斜杠，避免不同形式导致漏替换。
 */
function rewriteSourceToDest(content: string, sourceDir: string, destDir: string): string {
  const normalizedSource = sourceDir.replace(/[\\/]+$/, '')
  const normalizedDest = destDir.replace(/[\\/]+$/, '')
  if (!normalizedSource || normalizedSource === normalizedDest) return content
  let rewritten = content.split(normalizedSource).join(normalizedDest)
  // Windows 路径在 JSON 中会被转义为双反斜杠，单独处理一次
  if (normalizedSource.includes('\\')) {
    const sourceEscaped = normalizedSource.replace(/\\/g, '\\\\')
    const destEscaped = normalizedDest.replace(/\\/g, '\\\\')
    rewritten = rewritten.split(sourceEscaped).join(destEscaped)
  }
  return rewritten
}

/**
 * 截断 Agent 会话的 SDK 消息到指定 UUID（inclusive）
 *
 * 保留 uuid 匹配消息及之前的所有消息，删除之后的消息。
 * 通过原子替换全量重写 JSONL 文件。
 *
 * @returns 截断后保留的消息列表
 */
export function truncateSDKMessages(id: string, upToUuidInclusive: string): SDKMessage[] {
  const filePath = getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) {
    throw new Error(`[Agent 会话] 截断失败: 会话消息文件不存在, sessionId=${id}`)
  }

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const messages = parseJsonlStrict<unknown>(lines, `截断读取 SDKMessage (${id})`).map(normalizePersistedSDKMessage)
  const cutIndex = messages.findIndex(
    (m) => 'uuid' in m && (m as { uuid?: string }).uuid === upToUuidInclusive,
  )
  if (cutIndex < 0) {
    throw new Error(`[Agent 会话] 截断失败: 未找到 uuid=${upToUuidInclusive}, sessionId=${id}`)
  }
  const kept = messages.slice(0, cutIndex + 1)

  const content = kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : '')
  writeTextFileAtomic(filePath, content)

  console.log(`[Agent 会话] 消息已截断: sessionId=${id}, 保留 ${kept.length}/${messages.length} 条`)
  return kept
}

/**
 * 删除指定 UUID 的持久化错误消息。
 *
 * 仅删除 assistant error，避免调用方误删普通回复；找不到时保持幂等。
 */
export function removeSDKErrorMessage(id: string, errorUuid: string): boolean {
  const filePath = getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) return false

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const messages = parseJsonlStrict<unknown>(lines, `删除错误消息 (${id})`).map(normalizePersistedSDKMessage)
  const targetIndex = messages.findIndex((message) =>
    message.type === 'assistant'
      && (message as { uuid?: string }).uuid === errorUuid
      && Boolean((message as { error?: unknown }).error),
  )
  if (targetIndex < 0) return false

  const kept = messages.filter((_, index) => index !== targetIndex)
  const content = kept.map((message) => JSON.stringify(message)).join('\n') + (kept.length > 0 ? '\n' : '')
  writeTextFileAtomic(filePath, content)
  console.log(`[Agent 会话] 已删除重试前错误: sessionId=${id}, uuid=${errorUuid}`)
  return true
}

/**
 * 自动归档超过指定天数未更新的 Agent 会话
 *
 * 置顶会话不会被归档。
 *
 * @param daysThreshold 天数阈值
 * @returns 本次归档的会话数量
 */
export function autoArchiveAgentSessions(daysThreshold: number): number {
  const index = readIndex()
  const threshold = Date.now() - daysThreshold * 86_400_000
  let count = 0

  for (const session of index.sessions) {
    if (!session.pinned && !session.archived && session.updatedAt < threshold) {
      session.archived = true
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 自动归档 ${count} 个会话（阈值: ${daysThreshold} 天）`)
  }

  return count
}

/**
 * 启动时收敛遗留的委派子会话状态
 *
 * 委派子会话的运行态只在主进程内存中维护，应用退出后无法续跑。
 * 若上次退出时仍有 delegationStatus 为 'running' 的子会话，本次启动需要
 * 把它们标记为 'interrupted'，避免状态永久卡在 running、父会话也无法收敛。
 *
 * @returns 被标记为中断的子会话数量
 */
export function markRunningDelegationsAsInterrupted(): number {
  const index = readIndex()
  let count = 0

  for (const session of index.sessions) {
    if (session.sourceDelegationId && session.delegationStatus === 'running') {
      session.delegationStatus = 'interrupted'
      session.updatedAt = Date.now()
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 启动收敛 ${count} 个遗留的运行中委派子会话为 interrupted`)
  }

  return count
}

/**
 * 清理所有会话中不存在的附加目录和附加文件
 * @returns 清理的条目总数
 */
export function cleanupStaleAttachedPaths(): number {
  const index = readIndex()
  let count = 0

  for (const session of index.sessions) {
    let changed = false

    if (session.attachedDirectories?.length) {
      const valid = session.attachedDirectories.filter((d) => existsSync(d))
      if (valid.length < session.attachedDirectories.length) {
        count += session.attachedDirectories.length - valid.length
        session.attachedDirectories = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (session.attachedFiles?.length) {
      const valid = session.attachedFiles.filter((f) => existsSync(f))
      if (valid.length < session.attachedFiles.length) {
        count += session.attachedFiles.length - valid.length
        session.attachedFiles = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (changed) {
      session.updatedAt = Date.now()
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 清理了 ${count} 个不存在的附加路径`)
  }

  return count
}

/**
 *
 * 按行流式读取每个会话的 JSONL 文件，命中即早退。兼容旧 AgentMessage 和新 SDKMessage 格式。
 * 每个会话最多返回 1 条匹配，总计达到 maxResults 即停止扫描后续会话。
 *
 * @param query 搜索关键词
 * @returns 匹配结果列表
 */
export async function searchAgentSessionMessages(query: string): Promise<AgentMessageSearchResult[]> {
  if (!query || query.length < 2) return []

  const index = readIndex()
  const results: AgentMessageSearchResult[] = []
  const queryLower = query.toLowerCase()
  const maxResults = 30

  for (const session of index.sessions) {
    if (results.length >= maxResults) break

    const filePath = getAgentSessionMessagesPath(session.id)
    if (!existsSync(filePath)) continue

    const hit = await findFirstMatchInAgentJsonl(filePath, queryLower, query.length)
    if (hit) {
      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: hit.messageId,
        role: hit.role,
        snippet: hit.snippet,
        matchStart: hit.matchStart,
        matchLength: query.length,
        archived: session.archived,
      })
    }
  }

  return results
}

/**
 * 在单个 Agent 会话 JSONL 中按行流式查找第一条匹配。
 *
 * Agent 消息存在两种历史格式（旧 AgentMessage 与新 SDKMessage），都要兼容。
 */
async function findFirstMatchInAgentJsonl(
  filePath: string,
  queryLower: string,
  queryLength: number
): Promise<{ messageId: string; role: AgentMessageSearchResult['role']; snippet: string; matchStart: number } | null> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let parsed: {
        role?: string
        id?: string
        uuid?: string
        content?: unknown
        message?: { role?: string; id?: string; content?: Array<{ type: string; text?: string }> }
      }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const rawRole = parsed.role ?? parsed.message?.role ?? 'assistant'
      // 收窄到 AgentMessageSearchResult.role 允许的联合类型；不在白名单的退化为 assistant
      const role: AgentMessageSearchResult['role'] =
        rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'status'
          ? rawRole
          : 'assistant'
      const messageId = parsed.id ?? parsed.uuid ?? parsed.message?.id ?? ''

      let textContent = ''
      if (typeof parsed.content === 'string') {
        textContent = parsed.content
      } else if (Array.isArray(parsed.message?.content)) {
        textContent = parsed.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n')
      }
      if (!textContent) continue

      const contentLower = textContent.toLowerCase()
      const matchIndex = contentLower.indexOf(queryLower)
      if (matchIndex === -1) continue

      const snippetStart = Math.max(0, matchIndex - 40)
      const snippetEnd = Math.min(textContent.length, matchIndex + queryLength + 40)
      const snippet = (snippetStart > 0 ? '...' : '') +
        textContent.slice(snippetStart, snippetEnd) +
        (snippetEnd < textContent.length ? '...' : '')
      const matchStart = matchIndex - snippetStart + (snippetStart > 0 ? 3 : 0)

      return { messageId, role, snippet, matchStart }
    }
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}

function extractTextFromPersistedMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const record = parsed as {
    content?: unknown
    message?: { content?: Array<{ type: string; text?: string }> }
  }

  if (typeof record.content === 'string') {
    return record.content
  }

  if (Array.isArray(record.message?.content)) {
    return record.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n')
  }

  return ''
}

function createSnippet(text: string, matchIndex: number, matchLength: number): string {
  const snippetStart = Math.max(0, matchIndex - 48)
  const snippetEnd = Math.min(text.length, matchIndex + matchLength + 48)
  return (snippetStart > 0 ? '...' : '') +
    text.slice(snippetStart, snippetEnd) +
    (snippetEnd < text.length ? '...' : '')
}

function findSessionMessageSnippet(sessionId: string, query: string): string | undefined {
  if (!query || query.length < 2) return undefined

  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  const queryLower = query.toLowerCase()
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())

    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        console.warn(`[Agent 会话] 会话引用摘要跳过无法解析的 JSONL 行 (${sessionId}):`, error)
        continue
      }
      const textContent = extractTextFromPersistedMessage(parsed)
      if (!textContent) continue

      const matchIndex = textContent.toLowerCase().indexOf(queryLower)
      if (matchIndex === -1) continue

      return createSnippet(textContent, matchIndex, query.length)
    }
  } catch {
    return undefined
  }

  return undefined
}

/**
 * 搜索当前工作区可引用的 Agent 会话。
 *
 * 仅返回当前工作区、未归档、非当前会话的结果；无关键词时返回最近更新的会话。
 */
export function searchAgentSessionReferences(input: AgentSessionReferenceSearchInput): AgentSessionReferenceSearchResult[] {
  const workspaceId = input?.workspaceId?.trim()
  if (!workspaceId) return []

  const query = (input?.query ?? '').trim()
  const queryLower = query.toLowerCase()
  const requestedLimit = Number.isFinite(input?.limit) ? input.limit! : 20
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_SESSION_REFERENCE_LIMIT)

  const candidates = listAgentSessions()
    .filter((session) => session.workspaceId === workspaceId)
    .filter((session) => !session.archived)
    .filter((session) => session.id !== input?.excludeSessionId)

  const results: AgentSessionReferenceSearchResult[] = []

  for (const session of candidates) {
    if (results.length >= limit) break

    if (!queryLower) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        matchSource: 'recent',
      })
      continue
    }

    if (session.title.toLowerCase().includes(queryLower)) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        matchSource: 'title',
      })
      continue
    }

    const snippet = findSessionMessageSnippet(session.id, query)
    if (snippet) {
      results.push({
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        snippet,
        matchSource: 'message',
      })
    }
  }

  return results
}
