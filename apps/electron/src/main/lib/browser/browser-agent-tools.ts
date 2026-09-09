/**
 * Browser Agent 内置 MCP 工具。
 *
 * 把内置浏览器控制能力暴露给 Agent：navigate / click / type / scroll /
 * screenshot / get_state / list_tasks。Agent 调用这些工具驱动 Proma 内置
 * webview，信息（截图、页面文本、标注）直接进入 Proma，无需系统级浏览器。
 *
 * 任务即悬浮面板「浏览器」Tab 里的条目，tab 名称 = 任务名称。
 */

import type { BuiltinMcpToolFactory } from '../builtin-mcp/tool-definition'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  upsertOrReuseBrowserAgentTask,
  listBrowserAgentTasks,
  browserAgentNavigate,
  browserAgentClick,
  browserAgentType,
  browserAgentScroll,
  browserAgentScreenshot,
  browserAgentGetState,
} from './browser-agent-controller'

interface BrowserToolContext {
  sessionId: string
}

type ZodModule = typeof import('zod')

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

export function browserErrorResult(text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  }
}

export function createBrowserScreenshotResult(dataUrl: string): CallToolResult {
  const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/)
  if (!match) return browserErrorResult('截图失败：截图数据格式无效')
  return {
    content: [
      { type: 'text', text: '已截图，可直接查看图片内容。' },
      { type: 'image', mimeType: match[1]!, data: match[2]! },
    ],
  }
}

function rejectUnownedBrowserTask(
  sessionId: string,
  taskId: string,
  allowCreate: boolean,
): CallToolResult | undefined {
  const owned = listBrowserAgentTasks(sessionId).some((task) => task.taskId === taskId)
  if (owned) return undefined

  const existsInAnotherSession = listBrowserAgentTasks().some((task) => task.taskId === taskId)
  if (allowCreate && !existsInAnotherSession) return undefined

  return browserErrorResult(`浏览器任务不属于当前会话: ${taskId}`)
}

export async function injectBrowserAgentMcpServer(
  sdk: BuiltinMcpToolFactory,
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: BrowserToolContext,
): Promise<void> {
  const { z }: ZodModule = await import('zod')
  const nonBlank = z.string().trim().min(1)

  const server = sdk.createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'browser_navigate',
        '在内置浏览器中打开指定 URL，开始或恢复一个浏览器任务。新一轮继续同一网页目标时必须复用 browser_list_tasks 返回的 taskId；title 作为悬浮面板与 Tab 名称。',
        { taskId: nonBlank.describe('浏览器任务 ID，后续 click/type/scroll 等操作复用'), title: nonBlank.describe('任务名称，作为悬浮面板条目与 Tab 名'), url: nonBlank.describe('要打开的 http/https 地址') },
        async ({ taskId, title, url }) => {
          const rejected = rejectUnownedBrowserTask(ctx.sessionId, taskId, true)
          if (rejected) return rejected
          const task = upsertOrReuseBrowserAgentTask({
            taskId,
            sessionId: ctx.sessionId,
            title,
            url,
          })
          const result = await browserAgentNavigate(task.taskId, url)
          const actualUrl = (result.data as { url?: string } | undefined)?.url ?? url
          return result.ok
            ? textResult(`已打开：${actualUrl}\n实际 taskId：${task.taskId}`)
            : browserErrorResult(
              `打开失败：${result.error ?? '未知错误'}。请继续使用 taskId=${task.taskId} 重试，不要创建新的浏览器任务。`,
            )
        },
      ),
      sdk.tool(
        'browser_click',
        '点击内置浏览器页面元素。优先传 browser_get_state 返回的 ref；selector 仅兼容旧调用。',
        {
          taskId: nonBlank,
          ref: z.string().trim().optional().describe('browser_get_state 返回的元素引用，如 f0e2'),
          selector: z.string().trim().optional().describe('兼容旧调用的 CSS 选择器，不建议使用'),
        },
        async ({ taskId, ref, selector }) => {
          const rejected = rejectUnownedBrowserTask(ctx.sessionId, taskId, false)
          if (rejected) return rejected
          const result = await browserAgentClick(taskId, { ref, selector })
          const target = ref || selector || '未知元素'
          return result.ok ? textResult(`已点击：${target}`) : browserErrorResult(`点击失败：${result.error ?? '未知错误'}`)
        },
      ),
      sdk.tool(
        'browser_type',
        '向内置浏览器页面输入文本。优先传 browser_get_state 返回的 ref；selector 仅兼容旧调用。',
        {
          taskId: nonBlank,
          ref: z.string().trim().optional().describe('browser_get_state 返回的输入元素引用，如 f1e1'),
          selector: z.string().trim().optional().describe('兼容旧调用的 CSS 选择器，不建议使用'),
          text: z.string().describe('要填入的文本'),
        },
        async ({ taskId, ref, selector, text }) => {
          const rejected = rejectUnownedBrowserTask(ctx.sessionId, taskId, false)
          if (rejected) return rejected
          const result = await browserAgentType(taskId, { ref, selector }, text)
          const target = ref || selector || '未知元素'
          return result.ok ? textResult(`已输入到：${target}`) : browserErrorResult(`输入失败：${result.error ?? '未知错误'}`)
        },
      ),
      sdk.tool(
        'browser_scroll',
        '滚动内置浏览器当前页面。',
        { taskId: nonBlank, direction: z.enum(['up', 'down']), amount: z.number().optional() },
        async ({ taskId, direction, amount }) => {
          const rejected = rejectUnownedBrowserTask(ctx.sessionId, taskId, false)
          if (rejected) return rejected
          const result = await browserAgentScroll(taskId, direction, amount)
          return result.ok ? textResult(`已滚动：${direction}`) : browserErrorResult(`滚动失败：${result.error ?? '未知错误'}`)
        },
      ),
      sdk.tool(
        'browser_screenshot',
        '对内置浏览器当前页面截图，并把图片直接返回给模型查看。',
        { taskId: nonBlank },
        async ({ taskId }) => {
          const rejected = rejectUnownedBrowserTask(ctx.sessionId, taskId, false)
          if (rejected) return rejected
          const result = await browserAgentScreenshot(taskId)
          if (!result.ok) return browserErrorResult(`截图失败：${result.error ?? '未知错误'}`)
          const dataUrl = (result.data as { dataUrl?: string } | undefined)?.dataUrl ?? ''
          return createBrowserScreenshotResult(dataUrl)
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'browser_get_state',
        '直接读取 Proma 内置浏览器当前页面，包括主文档、跨域 iframe、正文和可交互元素。返回的 elements.ref 可直接用于 browser_click/browser_type。',
        { taskId: nonBlank },
        async ({ taskId }) => {
          const rejected = rejectUnownedBrowserTask(ctx.sessionId, taskId, false)
          if (rejected) return rejected
          const result = await browserAgentGetState(taskId)
          return result.ok
            ? textResult(JSON.stringify(result.data, null, 2))
            : browserErrorResult(`获取页面状态失败：${result.error ?? '未知错误'}`)
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'browser_list_tasks',
        '列出当前会话的浏览器任务。',
        {},
        async () => textResult(JSON.stringify(listBrowserAgentTasks(ctx.sessionId), null, 2)),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  })
  mcpServers.browser = server as unknown as Record<string, unknown>
}
