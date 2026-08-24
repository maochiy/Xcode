/**
 * Agent 系统 Prompt 构建器
 *
 * 负责构建 Agent 的完整系统提示词和每条消息的动态上下文。
 *
 * 设计策略：
 * - 静态 system prompt（buildSystemPrompt）：追加到 Runtime 基础提示词之后的 Proma 策略
 * - 动态 per-message 上下文（buildDynamicContext）：注入到用户消息前，每次实时读取磁盘
 */

import type { AgentDispatchContext, PromaPermissionMode, RuntimeId } from '@proma/shared'
import { buildGitAttributionPromptSection, isGitAttributionEnabled } from './agent-git-attribution'
import { getSettings } from './settings-service'
import { dispatchForRequest } from './runtime/dispatch-policy'
import type { DispatchDecision } from './runtime/dispatch-policy'
import { getEffectiveSystemPrompt } from './system-prompt-manager'

/** buildSystemPrompt 所需的上下文 */
interface SystemPromptContext {
  userMessage?: string
  workspaceName?: string
  workspaceSlug?: string
  workspacePath?: string
  sessionId: string
  permissionMode: PromaPermissionMode
  /** 当前会话是否已注入 Proma collaboration 工具 */
  collaborationAvailable?: boolean
  dispatch?: DispatchDecision
  dispatchContext?: AgentDispatchContext
}

function buildBrowserToolRoutingPrompt(): string {
  return `## Proma 内置浏览器

所有网页导航、页面正文读取、网页截图、网页元素点击、网页输入和网页滚动，必须使用 Proma 内置 \`browser\` MCP：
- \`mcp__browser__browser_navigate\`
- \`mcp__browser__browser_get_state\`
- \`mcp__browser__browser_click\`
- \`mcp__browser__browser_type\`
- \`mcp__browser__browser_scroll\`
- \`mcp__browser__browser_screenshot\`

网页操作先调用 \`browser_get_state\`，后续点击和输入优先使用其返回的 \`elements.ref\`。
新一轮继续网页任务时，先调用 \`mcp__browser__browser_list_tasks\`，优先恢复同一目标已有任务并复用其原始 \`taskId\`。
浏览器工具失败时保留并重试同一 \`taskId\`，禁止通过更换 \`taskId\` 重复创建相同网页任务。
禁止使用 Runtime 原生 \`mcp__computer-use__*\`、Claude in Chrome、Playwright、Selenium、系统浏览器或桌面坐标点击来操作网页。
Runtime 原生 Computer Use 只可用于用户明确要求操作的非网页桌面应用，不能作为网页操作的替代方案。`
}

/**
 * 构建 Proma Desktop Host 的最小追加提示词。
 *
 * Tools、Commands、Skills、MCP、Subagent、CLAUDE.md、Memory 和 cwd 由
 * Proma Context Packet 与 Runtime Adapter 共同提供，避免各 Runtime 重复建立上下文。
 */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const dispatch = ctx.dispatch ?? dispatchForRequest({ message: ctx.userMessage, ...ctx.dispatchContext })
  const configuredPrompt = getEffectiveSystemPrompt()
  const sections = [
    configuredPrompt ? `## Proma 系统提示词\n\n${configuredPrompt}` : '',
    dispatch.systemPrompt,
    `# Proma Desktop Host

你运行在 Proma 桌面应用中。Pi 是默认基础内核；Hermes、Codex 和 Claude Code 只能由系统 Dispatch Policy 在明确阶段调度，不能由用户通过 Runtime 名称直接切换。当前本轮由 ${dispatch.runtimeId} 处理，原因：${dispatch.dispatchReason}。继续遵循当前 Runtime 适配器提供的工具、命令、Skills、MCP、Session 与权限语义；Proma 负责桌面交互、策略边界和状态展示。

- Proma Session ID: ${ctx.sessionId}
- 当前项目: ${ctx.workspaceName ?? '默认工作区'}
- 当前 cwd: ${ctx.workspacePath ?? '由 Proma Runtime 提供'}
- 权限、AskUserQuestion 和 Plan 审批必须等待 Proma UI 的用户响应。
- 并行工具批次采用 fail-fast：任一工具报错会取消同批其余工具。仅并行执行预期成功且彼此独立的调用；探测命令允许“无匹配”时应显式归一化退出码（如 \`grep ... || true\`），并在 zsh 中引用含 \`*\`、\`?\` 的参数，否则改为串行执行。
- 默认使用中文简洁回复，保留必要技术术语。`,
  ]

  sections.push(`## 联网搜索

你可以使用 Proma 内置 MCP \`web_search\` 提供的联网能力（OpenSwitch 搜索 + 本地网页抓取）：
- 工具名：\`mcp__web_search__WebSearch\` / \`mcp__web_search__WebFetch\`
- 遇到时事新闻、最新数据、你不确定或可能过时的信息时，主动调用 WebSearch 搜索
- 需要阅读网页完整内容时，用 WebFetch 抓取 URL 正文
- 禁止使用 Runtime 原生的 WebSearch/WebFetch；必须走上述 Proma 内置工具`)

  sections.push(buildBrowserToolRoutingPrompt())

  if (ctx.collaborationAvailable) {
    sections.push(`## Proma 协作会话

仅当任务确实需要独立、长期且可在 Proma 侧栏继续交互的会话时使用 \`collaboration\`；短期并行继续使用当前 Runtime 的原生能力。`)
  }

  if (ctx.permissionMode === 'plan') {
    sections.push(`## 计划模式

当前处于 Proma 计划模式。完成调研后先展示计划摘要并等待用户批准，再通过 ExitPlanMode 请求切换；批准前不得执行写操作。`)
  }

  const gitAttributionEnabled = isGitAttributionEnabled(getSettings().gitAttributionEnabled)
  sections.push(buildGitAttributionPromptSection(gitAttributionEnabled))

  return sections.join('\n\n')
}

/**
 * 构建由 Hermes 任务使用的 Runtime 系统提示词。
 *
 * 任务级 Harness 不应重新走用户意图识别，但必须继承 Proma 的系统提示词、
 * Runtime 职责和权限边界。
 */
export function buildRuntimeTaskSystemPrompt(
  runtimeId: RuntimeId,
  intent: string,
): string {
  const configuredPrompt = getEffectiveSystemPrompt()
  const role = runtimeId === 'pi'
    ? 'Pi 基础内核，负责需求澄清、普通对话和最终汇总。'
    : runtimeId === 'hermes'
      ? 'Hermes 调度内核，负责识别依赖、生成和推进动态任务图。'
      : runtimeId === 'codex'
        ? 'Codex Harness，负责计划、复杂分析和代码审查。'
        : 'Claude Code Harness，只能执行已批准的实施任务。'
  return [
    configuredPrompt ? `## Proma 系统提示词\n\n${configuredPrompt}` : '',
    `## Proma Runtime 任务职责\n\n当前 Runtime：${runtimeId}\n职责：${role}\n调度意图：${intent}`,
    '不得通过用户文本、Runtime 名称或 mention 绕过 Hermes 策略、需求确认、计划批准和权限审批。',
    buildBrowserToolRoutingPrompt(),
  ].filter(Boolean).join('\n\n')
}

// ===== 动态 Per-Message 上下文 =====

/** buildDynamicContext 所需的上下文 */
interface DynamicContext {
  workspaceName?: string
  workspaceSlug?: string
  agentCwd?: string
}

/**
 * 构建每条消息的动态上下文
 *
 * 包含当前时间、工作区实时状态（MCP 服务器 + Skills）和工作目录。
 * 每次调用都从磁盘实时读取，确保配置变更后下一条消息即可感知。
 */
export function formatAgentUserClock(now = new Date()): string {
  return now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  })
}

export function buildDynamicContext(ctx: DynamicContext): string {
  void ctx
  return ''
}

/** Pi 用户消息只带当天时刻，避免把到分钟的时间写进 system 前缀。 */
export function buildPiUserClockLine(now = new Date()): string {
  return `当前时间: ${formatAgentUserClock(now)}`
}
