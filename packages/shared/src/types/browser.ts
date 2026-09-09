/**
 * Proma Browser 交互类型。
 *
 * 浏览器只把页面证据和用户评论传回 Proma，不把页面脚本能力暴露给 Renderer。
 */

export const BROWSER_IPC_CHANNELS = {
  ANNOTATION: 'proma:browser-annotation',
  ANNOTATION_CREATED: 'proma:browser-annotation-created',
  ERROR: 'proma:browser-error',
  SET_MODE: 'proma-browser:set-mode',
  SET_SCROLLBAR_VISIBLE: 'proma-browser:set-scrollbar-visible',
} as const

export type BrowserAnnotationMode = 'none' | 'element' | 'region'
export type BrowserAnnotationTarget = 'element' | 'region'

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
  scrollX?: number
  scrollY?: number
  viewportWidth?: number
  viewportHeight?: number
  devicePixelRatio?: number
}

export interface BrowserAnnotation {
  target: BrowserAnnotationTarget
  comment: string
  url: string
  pageTitle: string
  rect: BrowserAnnotationRect
  selector?: string
  tagName?: string
  accessibleName?: string
  text?: string
  domExcerpt?: string
  evidenceDataUrl?: string
  createdAt: number
}

export interface BrowserAnnotationCreatedEvent {
  annotation: BrowserAnnotation
  evidenceDataUrl?: string
}

export interface BrowserErrorEvent {
  error?: string
}

// ============================================================================
// Browser Agent 控制（内置浏览器 Agent 驱动）
// ============================================================================

/** Browser Agent IPC 通道 */
export const BROWSER_AGENT_IPC_CHANNELS = {
  /** 注册/绑定一个浏览器任务到 webview guest（Renderer → Main） */
  BIND_TASK: 'proma:browser-agent:bind-task',
  /** 解绑任务（webview 销毁/任务结束） */
  UNBIND_TASK: 'proma:browser-agent:unbind-task',
  /** 任务状态变化推送给 Renderer（Main → Renderer） */
  TASK_UPDATED: 'proma:browser-agent:task-updated',
  /** 请求 Renderer 打开某任务的浏览器页面（Main → Renderer），用于 Agent 首次导航前建 webview */
  OPEN_TASK: 'proma:browser-agent:open-task',
} as const

/**
 * 浏览器任务状态。
 * 任务状态完全由系统根据 Agent 轮次管理，模型不直接修改。
 */
export type BrowserAgentTaskStatus =
  | 'running'
  | 'waiting_user'
  | 'paused'
  | 'completed'
  | 'failed'

/** 一个 Agent 驱动的浏览器任务。 */
export interface BrowserAgentTask {
  /** 任务 ID（对应一次 Agent 浏览器操作的逻辑单元） */
  taskId: string
  /** 所属 Agent 会话 */
  sessionId: string
  /** 任务名称（同时作为悬浮面板条目名与浏览器 Tab 名） */
  title: string
  /** 当前页面 URL */
  url: string
  /** 当前页面标题 */
  pageTitle?: string
  /** 任务状态；悬浮面板展示 running / waiting_user，历史任务可在浏览器任务列表中查看。 */
  status: BrowserAgentTaskStatus
  /** 关联的 webview guest id（未绑定时为空，例如任务刚创建尚未导航） */
  guestId?: number
  /** 最近活跃时间（用于超时清理） */
  updatedAt: number
  /** 创建时间 */
  createdAt: number
}

/** Browser Agent 控制动作（主进程执行，MCP 工具调用映射到这里） */
export interface BrowserAgentActionResult {
  ok: boolean
  error?: string
  /** get_state / screenshot 等动作的返回数据 */
  data?: unknown
}

// ============================================================================
// 内置浏览器会话隔离（Electron partition）
// ============================================================================

/**
 * 内置浏览器 Electron session partition 前缀。
 *
 * 每个 Agent 会话使用独立的 partition（`persist:proma-browser-${sessionId}`），
 * 从而隔离各会话的 Cookie / localStorage / 缓存等浏览器数据，避免登录态跨会话串用。
 * 主进程（browser-webview.cjs）只接受该前缀的 partition。
 */
export const BROWSER_PARTITION_PREFIX = 'persist:proma-browser'

/** 旧版本全局唯一 partition（无会话隔离），仅用于兼容校验，不再作为新目标。 */
export const LEGACY_BROWSER_PARTITION = BROWSER_PARTITION_PREFIX

/** 生成某 Agent 会话的内置浏览器 partition。 */
export function browserPartitionForSession(sessionId: string): string {
  return `${BROWSER_PARTITION_PREFIX}-${sessionId}`
}

/** 判断 partition 是否属于 Proma 内置浏览器（含 legacy 全局 partition 与按会话的 partition）。 */
export function isBrowserSessionPartition(partition: string | undefined | null): boolean {
  return partition === LEGACY_BROWSER_PARTITION
    || (typeof partition === 'string' && partition.startsWith(`${BROWSER_PARTITION_PREFIX}-`))
}
