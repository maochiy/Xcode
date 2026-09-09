/**
 * 内置浏览器 Agent 控制器。
 *
 * 管理 Agent 驱动的浏览器任务（注册表 + 控制动作 + 状态推送）。
 * 与 open-computer-use 系统级方案不同：这里操作的是 Proma 内置 webview，
 * 通过 webContents.fromId(guestId) 直接驱动，信息（截图/页面文本/标注）直接进入 Proma。
 *
 * 设计原则（极简）：
 * - 模型调用浏览器工具 → running；明确等待用户操作 → waiting_user
 * - 新一轮先观察模型是否继续操作旧任务：继续则保留，不相关则在新任务开始或轮次结束时隐藏
 * - 轮次正常结束时，本轮运行中的浏览器任务收敛为 completed
 * - 模型完全不碰任务状态，只负责操作浏览器完成任务
 * - 超时（10 分钟）未活跃的条目自动清理
 * - 用户手动打开的 Tab 不受影响
 */

import * as electron from 'electron'
import type { WebContents, WebFrameMain } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  type BrowserAgentActionResult,
  type BrowserAgentTask,
  type BrowserAgentTaskStatus,
} from '@proma/shared'
import { browserAgentPointerExpression } from './browser-agent-pointer'
import { clickBrowserElement, readBrowserPage, typeBrowserElement } from './browser-page-reader'

/** 条目超时清理阈值（10 分钟） */
const STALE_TASK_TTL_MS = 10 * 60 * 1000

/** 任务状态变化回调（推送给 Renderer 悬浮面板） */
type TaskUpdatedListener = (task: BrowserAgentTask) => void

type BrowserAgentTaskRecord = BrowserAgentTask
type WebContentsResolver = (guestId: number) => WebContents | null

const defaultWebContentsResolver: WebContentsResolver = (guestId) => (
  electron.webContents?.fromId(guestId) ?? null
)
let resolveWebContents = defaultWebContentsResolver

/** 请求渲染层打开任务浏览器页面（Main → Renderer） */
type OpenTaskListener = (task: BrowserAgentTask) => void
const openTaskListeners = new Set<OpenTaskListener>()
export function onBrowserAgentOpenTask(listener: OpenTaskListener): () => void {
  openTaskListeners.add(listener)
  return () => openTaskListeners.delete(listener)
}
function emitOpenTask(task: BrowserAgentTaskRecord): void {
  for (const listener of openTaskListeners) listener({ ...task })
}

/** 等待某任务完成 guest 绑定的 pending  Promise 集合 */
const bindWaiters = new Map<string, Array<(guestId: number) => void>>()

const tasks = new Map<string, BrowserAgentTaskRecord>()
/** 新一轮开始后待判定是否仍相关的旧任务（sessionId → taskId 集合） */
const pendingPreviousTaskIds = new Map<string, Set<string>>()
/** 当前轮次实际操作过的任务（sessionId → taskId 集合） */
const currentRunTaskIds = new Map<string, Set<string>>()
/** AskUser 请求对应的等待任务，确保回答只恢复本次等待关联的任务。 */
const waitingRequestTaskIds = new Map<string, Set<string>>()
/** guestId → taskId 反查，用于 webview 事件归位 */
const guestToTask = new Map<number, string>()
/** 最近一次页面读取生成的元素引用：taskId → ref → frame */
const taskElementFrames = new Map<string, Map<string, WebFrameMain>>()
const listeners = new Set<TaskUpdatedListener>()

function now(): number {
  return Date.now()
}

function emitUpdated(task: BrowserAgentTaskRecord): void {
  for (const listener of listeners) listener({ ...task })
}

export function onBrowserAgentTaskUpdated(listener: TaskUpdatedListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 列出全部浏览器任务（含已结束，供悬浮面板过滤） */
export function listBrowserAgentTasks(sessionId?: string): BrowserAgentTask[] {
  const all = Array.from(tasks.values())
  const filtered = sessionId ? all.filter((t) => t.sessionId === sessionId) : all
  return filtered.map((t) => ({ ...t })).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getBrowserAgentTask(taskId: string): BrowserAgentTask | undefined {
  const task = tasks.get(taskId)
  return task ? { ...task } : undefined
}

/** 标记任务被本轮浏览器工具继续使用，避免随后被当作旧任务隐藏。 */
function markBrowserAgentTaskTouched(taskId: string): void {
  const task = tasks.get(taskId)
  if (!task) return
  const currentRun = currentRunTaskIds.get(task.sessionId)
  currentRun?.add(taskId)
  const pending = pendingPreviousTaskIds.get(task.sessionId)
  if (!pending?.delete(taskId)) return
  if (pending.size === 0) pendingPreviousTaskIds.delete(task.sessionId)
}

function removeTaskFromWaitingRequests(taskId: string): void {
  for (const [requestId, taskIds] of waitingRequestTaskIds) {
    taskIds.delete(taskId)
    if (taskIds.size === 0) waitingRequestTaskIds.delete(requestId)
  }
}

function clearSessionWaitingRequests(sessionId: string): void {
  for (const [requestId, taskIds] of waitingRequestTaskIds) {
    for (const taskId of Array.from(taskIds)) {
      if (tasks.get(taskId)?.sessionId === sessionId) taskIds.delete(taskId)
    }
    if (taskIds.size === 0) waitingRequestTaskIds.delete(requestId)
  }
}

/** 创建或恢复一个浏览器任务（Agent 开始一次浏览器操作时调用） */
export function upsertBrowserAgentTask(input: {
  taskId: string
  sessionId: string
  title: string
  url?: string
}): BrowserAgentTask {
  const conflictingTask = tasks.get(input.taskId)
  const effectiveTaskId = conflictingTask && conflictingTask.sessionId !== input.sessionId
    ? `${input.sessionId}:${input.taskId}`
    : input.taskId
  if (effectiveTaskId !== input.taskId) {
    console.warn(
      `[内置浏览器 Agent] taskId 跨会话冲突，改用会话隔离 ID: requested=${input.taskId}, actual=${effectiveTaskId}`,
    )
  }
  const existing = tasks.get(effectiveTaskId)
  const timestamp = now()
  if (existing) {
    markBrowserAgentTaskTouched(existing.taskId)
    removeTaskFromWaitingRequests(existing.taskId)
    existing.title = input.title || existing.title
    existing.status = 'running'
    existing.updatedAt = timestamp
    emitUpdated(existing)
    return { ...existing }
  }
  // 本轮创建了全新任务，说明上一轮待判定任务并未被继续使用，立即隐藏旧条目。
  hideUnrelatedSessionBrowserTasksForRun(input.sessionId)
  const task: BrowserAgentTaskRecord = {
    taskId: effectiveTaskId,
    sessionId: input.sessionId,
    title: input.title || '浏览器任务',
    url: input.url
      ? (normalizeBrowserNavigationUrl(input.url) ?? input.url)
      : 'about:blank',
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  tasks.set(task.taskId, task)
  markBrowserAgentTaskTouched(task.taskId)
  emitUpdated(task)
  return { ...task }
}

function normalizeComparableTitle(title: string): string {
  return title.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

/**
 * 创建或恢复浏览器任务。
 *
 * 模型偶尔会在重试时生成新的 taskId。若同一会话中已经存在相同页面或相同名称的任务，
 * 自动复用最近任务，避免一个网页操作不断创建重复 Tab。
 */
export function upsertOrReuseBrowserAgentTask(input: {
  taskId: string
  sessionId: string
  title: string
  url: string
}): BrowserAgentTask {
  const exactTask = tasks.get(input.taskId)
  if (exactTask?.sessionId === input.sessionId) {
    return upsertBrowserAgentTask(input)
  }

  const requestedUrl = normalizeComparableUrl(input.url)
  const requestedTitle = normalizeComparableTitle(input.title)
  const reusableTask = Array.from(tasks.values())
    .filter((task) => task.sessionId === input.sessionId)
    .map((task) => {
      const sameUrl = normalizeComparableUrl(task.url) === requestedUrl
      const sameTitle = normalizeComparableTitle(task.title) === requestedTitle
      const score = sameUrl ? 2 : sameTitle ? 1 : 0
      return { task, score }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.task.updatedAt - left.task.updatedAt)[0]?.task

  if (!reusableTask) return upsertBrowserAgentTask(input)

  markBrowserAgentTaskTouched(reusableTask.taskId)
  removeTaskFromWaitingRequests(reusableTask.taskId)
  reusableTask.title = input.title || reusableTask.title
  reusableTask.status = 'running'
  reusableTask.updatedAt = now()
  emitUpdated(reusableTask)
  console.info(
    `[内置浏览器 Agent] 复用任务: requested=${input.taskId}, actual=${reusableTask.taskId}, session=${input.sessionId}`,
  )
  return { ...reusableTask }
}

/** 更新任务状态（Agent 运行状态驱动；failed 仅来自模型运行报错） */
export function setBrowserAgentTaskStatus(
  taskId: string,
  status: BrowserAgentTaskStatus,
): void {
  const task = tasks.get(taskId)
  if (!task) return
  if (status === 'running') markBrowserAgentTaskTouched(taskId)
  if (status !== 'waiting_user') removeTaskFromWaitingRequests(taskId)
  task.status = status
  task.updatedAt = now()
  emitUpdated(task)
}

/** 绑定 webview guest 到任务（Renderer 创建 webview 后调用） */
export function bindBrowserAgentTaskGuest(taskId: string, guestId: number, url?: string): void {
  const task = tasks.get(taskId)
  if (!task) return
  // 解绑旧 guest（webcontents 重建场景）
  if (task.guestId != null && task.guestId !== guestId) guestToTask.delete(task.guestId)
  task.guestId = guestId
  taskElementFrames.delete(taskId)
  if (url) task.url = url
  task.updatedAt = now()
  guestToTask.set(guestId, taskId)
  emitUpdated(task)
  // 唤醒等待绑定的导航请求
  const waiters = bindWaiters.get(taskId)
  if (waiters) {
    bindWaiters.delete(taskId)
    for (const resolve of waiters) resolve(guestId)
  }
}

/** 解绑（webview 销毁时） */
export function unbindBrowserAgentTaskGuest(guestId: number): void {
  const taskId = guestToTask.get(guestId)
  guestToTask.delete(guestId)
  if (!taskId) return
  const task = tasks.get(taskId)
  if (task && task.guestId === guestId) {
    delete task.guestId
    taskElementFrames.delete(taskId)
    emitUpdated(task)
  }
}

/** 等待任务完成 guest 绑定（渲染层创建 webview 后回调） */
function waitForGuestBound(taskId: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const list = bindWaiters.get(taskId)
      if (list) {
        bindWaiters.set(taskId, list.filter((r) => r !== onBound))
      }
      resolve(null)
    }, timeoutMs)
    const onBound = (guestId: number): void => {
      clearTimeout(timer)
      resolve(guestId)
    }
    const list = bindWaiters.get(taskId) ?? []
    list.push(onBound)
    bindWaiters.set(taskId, list)
  })
}

/**
 * 确保任务已绑定可用 guest。未绑定时请求渲染层打开任务浏览器页面并等待绑定。
 * 返回 true 表示已有可用 guest。
 */
async function ensureGuestReady(taskId: string): Promise<boolean> {
  const task = tasks.get(taskId)
  if (!task) return false
  markBrowserAgentTaskTouched(taskId)
  if (task.status !== 'running') {
    task.status = 'running'
    task.updatedAt = now()
    emitUpdated(task)
  }
  if (getGuest(taskId)) return true
  const bound = waitForGuestBound(taskId)
  // 请求渲染层打开该任务的浏览器页面（创建 webview 并绑定 guest）
  console.info(`[内置浏览器 Agent] 请求打开任务页面: task=${taskId}, session=${task.sessionId}`)
  emitOpenTask(task)
  const guestId = await bound
  const ready = guestId != null && getGuest(taskId) != null
  if (!ready) {
    console.warn(`[内置浏览器 Agent] 等待页面绑定超时: task=${taskId}`)
  }
  return ready
}

function getGuest(taskId: string): WebContents | null {
  const task = tasks.get(taskId)
  if (!task || task.guestId == null) return null
  const contents = resolveWebContents(task.guestId)
  return contents && !contents.isDestroyed() ? contents : null
}

function ok(data?: unknown): BrowserAgentActionResult {
  return { ok: true, ...(data !== undefined ? { data } : {}) }
}

function fail(error: string): BrowserAgentActionResult {
  return { ok: false, error }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function normalizeComparableUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    if (parsed.pathname === '/') parsed.pathname = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

function isAbortedNavigation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { code?: unknown; errno?: unknown; message?: unknown }
  return record.code === 'ERR_ABORTED'
    || record.errno === -3
    || (typeof record.message === 'string' && record.message.includes('ERR_ABORTED'))
}

function updateTaskPageState(taskId: string, contents: WebContents): void {
  const task = tasks.get(taskId)
  if (!task) return
  task.url = contents.getURL()
  task.pageTitle = contents.getTitle()
  task.updatedAt = now()
  emitUpdated(task)
}

/** 导航到指定 URL */
export async function browserAgentNavigate(taskId: string, url: string): Promise<BrowserAgentActionResult> {
  // 未打开页面时先请求渲染层创建任务浏览器并等待绑定，再导航。
  const ready = await ensureGuestReady(taskId)
  const contents = ready ? getGuest(taskId) : null
  if (!contents) {
    setBrowserAgentTaskStatus(taskId, 'failed')
    return fail('浏览器页面尚未打开或已关闭')
  }
  const previousUrl = contents.getURL()
  const targetUrl = normalizeBrowserNavigationUrl(url) ?? url
  taskElementFrames.delete(taskId)
  try {
    await contents.loadURL(targetUrl)
    updateTaskPageState(taskId, contents)
    return ok({ url: contents.getURL(), title: contents.getTitle() })
  } catch (error) {
    const currentUrl = contents.getURL()
    const reachedRequestedUrl = normalizeComparableUrl(currentUrl) === normalizeComparableUrl(targetUrl)
    const redirectedToNewPage = currentUrl !== previousUrl && isHttpUrl(currentUrl)
    // Chromium 在服务端/脚本重定向时可能用 ERR_ABORTED 结束原 loadURL Promise，
    // 但目标页其实已经成功打开。此时应按实际页面状态返回成功，避免模型反复重试。
    if (isAbortedNavigation(error) && isHttpUrl(currentUrl) && (reachedRequestedUrl || redirectedToNewPage)) {
      updateTaskPageState(taskId, contents)
      return ok({ url: currentUrl, title: contents.getTitle(), redirected: !reachedRequestedUrl })
    }
    setBrowserAgentTaskStatus(taskId, 'failed')
    return fail(error instanceof Error ? error.message : '导航失败')
  }
}

/** 在页面里执行 JS（DOM 操作/状态采集的底层通道） */
async function evaluate<T>(taskId: string, script: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  await ensureGuestReady(taskId)
  const contents = getGuest(taskId)
  if (!contents) return { ok: false, error: '浏览器页面尚未打开或已关闭' }
  try {
    const value = (await contents.executeJavaScript(script, true)) as T
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '页面脚本执行失败' }
  }
}

interface FrameEvaluation<T> {
  frame: WebFrameMain
  value: T
}

/** 依次在主文档和 iframe 中执行脚本，支持跨域 iframe。 */
async function evaluateFrames<T>(
  taskId: string,
  script: string,
  stopWhen?: (value: T) => boolean,
): Promise<{
  ok: true
  values: FrameEvaluation<T>[]
} | {
  ok: false
  error: string
}> {
  await ensureGuestReady(taskId)
  const contents = getGuest(taskId)
  if (!contents) return { ok: false, error: '浏览器页面尚未打开或已关闭' }

  const values: FrameEvaluation<T>[] = []
  const errors: string[] = []
  const frames = contents.mainFrame.framesInSubtree
  for (const frame of frames) {
    if (frame.isDestroyed()) continue
    try {
      values.push({
        frame,
        value: await frame.executeJavaScript(script, true) as T,
      })
      if (stopWhen?.(values.at(-1)!.value)) break
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'iframe 脚本执行失败')
    }
  }
  if (values.length > 0) return { ok: true, values }
  return { ok: false, error: errors[0] ?? '页面脚本执行失败' }
}

async function actOnElementRef(
  taskId: string,
  ref: string,
  action: 'click' | 'type',
  text = '',
): Promise<BrowserAgentActionResult> {
  const frame = taskElementFrames.get(taskId)?.get(ref)
  if (!frame || frame.isDestroyed()) {
    return fail(`元素引用 ${ref} 不存在或已过期，请先调用 browser_get_state 刷新页面元素`)
  }
  try {
    const result = action === 'click'
      ? await clickBrowserElement(frame, ref)
      : await typeBrowserElement(frame, ref, text)
    if (result.ok) return ok({ ref })
    if (result.reason === 'disabled') return fail(`元素 ${ref} 当前不可用`)
    return fail(`元素引用 ${ref} 已失效，请重新调用 browser_get_state`)
  } catch (error) {
    return fail(error instanceof Error ? error.message : `操作元素 ${ref} 失败`)
  }
}

/** 点击元素。优先使用 browser_get_state 返回的 ref，selector 仅用于兼容旧调用。 */
export async function browserAgentClick(
  taskId: string,
  target: { ref?: string; selector?: string },
): Promise<BrowserAgentActionResult> {
  const task = tasks.get(taskId)
  markBrowserAgentTaskTouched(taskId)
  if (task && task.status !== 'running') {
    removeTaskFromWaitingRequests(taskId)
    task.status = 'running'
    task.updatedAt = now()
    emitUpdated(task)
  }
  if (target.ref) return actOnElementRef(taskId, target.ref, 'click')
  const selector = target.selector
  if (!selector) return fail('缺少元素 ref')
  const result = await evaluateFrames<boolean>(taskId, `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const pointer = ${browserAgentPointerExpression()};
    await pointer.click(el.getBoundingClientRect());
    el.focus();
    el.click();
    return true;
  })()`, Boolean)
  if (!result.ok) return fail(result.error)
  return result.values.some(({ value }) => value) ? ok() : fail(`未找到元素：${selector}`)
}

/** 输入文本。优先使用 browser_get_state 返回的 ref，selector 仅用于兼容旧调用。 */
export async function browserAgentType(
  taskId: string,
  target: { ref?: string; selector?: string },
  text: string,
): Promise<BrowserAgentActionResult> {
  const task = tasks.get(taskId)
  markBrowserAgentTaskTouched(taskId)
  if (task && task.status !== 'running') {
    removeTaskFromWaitingRequests(taskId)
    task.status = 'running'
    task.updatedAt = now()
    emitUpdated(task)
  }
  if (target.ref) return actOnElementRef(taskId, target.ref, 'type', text)
  const selector = target.selector
  if (!selector) return fail('缺少元素 ref')
  const result = await evaluateFrames<boolean>(taskId, `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const pointer = ${browserAgentPointerExpression()};
    await pointer.type(el.getBoundingClientRect());
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, Boolean)
  if (!result.ok) return fail(result.error)
  return result.values.some(({ value }) => value) ? ok() : fail(`未找到输入元素：${selector}`)
}

/** 滚动页面 */
export async function browserAgentScroll(taskId: string, direction: 'up' | 'down', amount = 600): Promise<BrowserAgentActionResult> {
  const delta = direction === 'up' ? -amount : amount
  const result = await evaluate<boolean>(taskId, `(async () => {
    const pointer = ${browserAgentPointerExpression()};
    await pointer.scroll(${JSON.stringify(direction)});
    window.scrollBy({ top: ${delta}, behavior: 'smooth' });
    return true;
  })()`)
  return result.ok ? ok() : fail(result.error)
}

/** 截图（返回 dataURL） */
export async function browserAgentScreenshot(taskId: string): Promise<BrowserAgentActionResult> {
  await ensureGuestReady(taskId)
  const contents = getGuest(taskId)
  if (!contents) return fail('浏览器页面尚未打开或已关闭')
  try {
    const image = await contents.capturePage()
    if (image.isEmpty()) return fail('截图失败')
    return ok({ dataUrl: image.toDataURL() })
  } catch (error) {
    return fail(error instanceof Error ? error.message : '截图失败')
  }
}

/** 读取内置浏览器页面，并生成可直接操作的元素引用。 */
export async function browserAgentGetState(taskId: string): Promise<BrowserAgentActionResult> {
  await ensureGuestReady(taskId)
  const contents = getGuest(taskId)
  if (!contents) return fail('浏览器页面尚未打开或已关闭')
  try {
    const result = await readBrowserPage(contents)
    taskElementFrames.set(taskId, result.elementFrames)
    updateTaskPageState(taskId, contents)
    return ok({
      ...result.snapshot,
      // 兼容旧模型读取字段；新调用统一使用 elements.ref。
      interactive: result.snapshot.elements,
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : '读取页面失败')
  }
}

/** Agent 运行状态联动：结算同一会话仍在执行或等待用户的浏览器任务。 */
export function settleSessionBrowserTasks(
  sessionId: string,
  outcome: 'paused' | 'completed' | 'failed',
): number {
  let changed = 0
  for (const task of tasks.values()) {
    if (
      task.sessionId !== sessionId
      || (task.status !== 'running' && task.status !== 'waiting_user')
    ) continue
    task.status = outcome
    task.updatedAt = now()
    emitUpdated(task)
    changed += 1
  }
  pendingPreviousTaskIds.delete(sessionId)
  currentRunTaskIds.delete(sessionId)
  clearSessionWaitingRequests(sessionId)
  return changed
}

/**
 * 新一轮开始时先记录同会话遗留任务，不立即隐藏。
 *
 * 模型随后继续调用同一 taskId 时会把它从待判定集合移除；如果开始了新的浏览器任务，
 * 或整轮结束仍未继续旧任务，则隐藏剩余旧条目。
 */
export function prepareSessionBrowserTasksForRun(sessionId: string): number {
  currentRunTaskIds.set(sessionId, new Set())
  const taskIds = Array.from(tasks.values())
    .filter((task) => task.sessionId === sessionId && task.status === 'running')
    .map((task) => task.taskId)
  if (taskIds.length === 0) {
    pendingPreviousTaskIds.delete(sessionId)
    return 0
  }
  pendingPreviousTaskIds.set(sessionId, new Set(taskIds))
  return taskIds.length
}

/**
 * 将本轮实际操作过的浏览器任务标记为等待用户。
 *
 * 只关联真实 pending 的 AskUser 请求，不从模型文本猜测，也不触碰本轮未复用的旧任务。
 */
export function markSessionBrowserTasksWaitingForUser(
  sessionId: string,
  requestId: string,
): number {
  const currentTaskIds = currentRunTaskIds.get(sessionId)
  if (!currentTaskIds || currentTaskIds.size === 0) return 0

  const waitingTaskIds = new Set<string>()
  let changed = 0
  for (const taskId of currentTaskIds) {
    const task = tasks.get(taskId)
    if (
      !task
      || task.sessionId !== sessionId
      || (task.status !== 'running' && task.status !== 'waiting_user')
    ) continue
    waitingTaskIds.add(taskId)
    if (task.status === 'waiting_user') continue
    task.status = 'waiting_user'
    task.updatedAt = now()
    emitUpdated(task)
    changed += 1
  }
  if (waitingTaskIds.size > 0) waitingRequestTaskIds.set(requestId, waitingTaskIds)
  return changed
}

/**
 * 结束指定 AskUser 请求的等待状态。
 *
 * 用户回答时恢复为 running；中止/清理时暂停，不能留下没有 pending 请求的等待任务。
 * 多个并发请求关联同一任务时，必须等全部请求都回答后才恢复。
 */
export function resolveSessionBrowserTasksWaitingForUser(
  sessionId: string,
  requestId: string,
  resume: boolean,
): number {
  const taskIds = waitingRequestTaskIds.get(requestId)
  if (!taskIds) return 0
  waitingRequestTaskIds.delete(requestId)
  let changed = 0
  for (const taskId of taskIds) {
    const task = tasks.get(taskId)
    if (!task || task.sessionId !== sessionId || task.status !== 'waiting_user') continue
    const stillWaiting = Array.from(waitingRequestTaskIds.values())
      .some((otherTaskIds) => otherTaskIds.has(taskId))
    if (stillWaiting) continue
    task.status = resume ? 'running' : 'paused'
    task.updatedAt = now()
    emitUpdated(task)
    changed += 1
  }
  return changed
}

/** 隐藏新一轮未继续操作的旧浏览器任务。 */
export function hideUnrelatedSessionBrowserTasksForRun(sessionId: string): number {
  const pending = pendingPreviousTaskIds.get(sessionId)
  if (!pending) return 0
  pendingPreviousTaskIds.delete(sessionId)
  let changed = 0
  for (const taskId of pending) {
    const task = tasks.get(taskId)
    if (!task || task.sessionId !== sessionId || task.status !== 'running') continue
    task.status = 'paused'
    task.updatedAt = now()
    emitUpdated(task)
    changed += 1
  }
  return changed
}

/**
 * 正常完成当前轮次：
 * - 隐藏本轮未继续操作的旧任务；
 * - 本轮运行中的任务收敛为 completed；
 * - 真实 AskUser pending 对应的 waiting_user 保持可操作。
 */
export function completeSessionBrowserTasks(sessionId: string): number {
  let changed = hideUnrelatedSessionBrowserTasksForRun(sessionId)
  for (const task of tasks.values()) {
    if (task.sessionId !== sessionId || task.status !== 'running') continue
    task.status = 'completed'
    task.updatedAt = now()
    emitUpdated(task)
    changed += 1
  }
  currentRunTaskIds.delete(sessionId)
  return changed
}

/** 清理超时未活跃的已结束/暂停任务（10 分钟） */
export function pruneStaleBrowserAgentTasks(referenceTime = now()): number {
  let removed = 0
  for (const [taskId, task] of Array.from(tasks.entries())) {
    if (task.status === 'running' || task.status === 'waiting_user') continue
    if (referenceTime - task.updatedAt < STALE_TASK_TTL_MS) continue
    if (task.guestId != null) guestToTask.delete(task.guestId)
    taskElementFrames.delete(taskId)
    removeTaskFromWaitingRequests(taskId)
    tasks.delete(taskId)
    removed += 1
  }
  return removed
}

/** 测试辅助：清空全部任务 */
export function resetBrowserAgentTasksForTest(): void {
  tasks.clear()
  pendingPreviousTaskIds.clear()
  currentRunTaskIds.clear()
  waitingRequestTaskIds.clear()
  guestToTask.clear()
  bindWaiters.clear()
  taskElementFrames.clear()
}

/** 测试辅助：隔离 Electron webContents 全局对象。 */
export function setBrowserAgentWebContentsResolverForTest(
  resolver?: WebContentsResolver,
): void {
  resolveWebContents = resolver ?? defaultWebContentsResolver
}
