import * as React from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { channelsAtom } from '@/atoms/chat-atoms'
import { cn } from '@/lib/utils'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import type { AgentEventUsage } from '@proma/shared'
import {
  formatTurnDuration,
  getAgentTurnStatusLabel,
  type AgentTurnStatus,
} from '@/lib/agent-turn-status'

interface AgentModelLogoProps {
  model?: string
  className?: string
}

export function AgentModelLogo({
  model,
  className,
}: AgentModelLogoProps): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (!model) {
    return (
      <span className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10',
        className,
      )}>
        <Bot className="size-3 text-primary" />
      </span>
    )
  }
  return (
    <img
      src={getModelLogo(model, resolveModelProvider(model, channels))}
      alt="模型"
      title={`使用 ${model}`}
      className={cn('size-5 shrink-0 rounded-md object-cover', className)}
    />
  )
}

function buildTooltip(model: string | undefined, durationMs: number | undefined, usage: AgentEventUsage | undefined): string {
  const lines: string[] = []
  if (model) lines.push(`使用 ${model}`)
  if (durationMs != null) lines.push(`耗时：${formatTurnDuration(durationMs)}`)
  if (usage?.inputTokens) {
    const directInput = Math.max(
      0,
      usage.inputTokens
        - (usage.cacheReadTokens ?? 0)
        - (usage.cacheCreationTokens ?? 0),
    )
    if (directInput > 0) lines.push(`输入：${directInput.toLocaleString()} tokens`)
  }
  if (usage?.outputTokens) lines.push(`输出：${usage.outputTokens.toLocaleString()} tokens`)
  if (usage?.cacheCreationTokens) {
    lines.push(`缓存写入：${usage.cacheCreationTokens.toLocaleString()} tokens`)
  }
  if (usage?.cacheReadTokens) {
    lines.push(`缓存读取：${usage.cacheReadTokens.toLocaleString()} tokens`)
  }
  if (usage?.costUsd) lines.push(`费用：$${usage.costUsd.toFixed(4)}`)
  if (usage?.contextWindow) {
    lines.push(`上下文窗口：${usage.contextWindow.toLocaleString()} tokens`)
  }
  return lines.join('\n')
}

export interface AgentTurnStatusLineProps {
  model?: string
  status: AgentTurnStatus
  durationMs?: number
  usage?: AgentEventUsage
  messageCount?: number
  collapsible?: boolean
  expanded?: boolean
  onToggle?: () => void
  /** 运行中的状态文字使用流动高光；完成/失败/停止保持静态。 */
  running?: boolean
  labelOverride?: string
  /**
   * 状态行下方细分隔线。
   * 默认：已处理 / 停止 / 运行中占位显示；失败等不强制显示。
   */
  showDivider?: boolean
  /** 时间线使用无 Logo、无分隔线的紧凑摘要。 */
  compact?: boolean
  contentId?: string
  className?: string
}

export function AgentTurnStatusLine({
  model,
  status,
  durationMs,
  usage,
  messageCount = 0,
  collapsible = false,
  expanded = false,
  onToggle,
  running = false,
  labelOverride,
  showDivider,
  compact = false,
  contentId,
  className,
}: AgentTurnStatusLineProps): React.ReactElement {
  // 整轮折叠/状态标题按规则优先「已处理 / 你在 N 秒后停止了」；
  // 「已完成」只用于单项活动摘要，不是整轮折叠按钮固定文案。
  const label = labelOverride ?? (status === 'stopped'
    ? durationMs != null && durationMs >= 0
      ? `你在 ${formatTurnDuration(durationMs)} 后停止了`
      : messageCount > 0
        ? `上 ${messageCount} 条消息`
        : '已停止'
    : status === 'completed' || status === 'activity-completed'
      ? durationMs != null && durationMs >= 0
        ? `已处理 ${formatTurnDuration(durationMs)}`
        : messageCount > 0
          ? `上 ${messageCount} 条消息`
          : '已处理'
      : status === 'failed'
        ? '执行失败'
        : getAgentTurnStatusLabel(status))
  const tooltip = buildTooltip(model, durationMs, usage)
  const isThinkingLabel = label.startsWith('正在思考')
  // 规则：处理中/已处理/停止标题后跟一条细分隔线
  const shouldShowDivider = showDivider ?? (
    running
    || status === 'completed'
    || status === 'activity-completed'
    || status === 'stopped'
    || status === 'thinking'
  )
  // 折叠箭头放右侧：Logo + 文案 + 箭头
  const content = (
    <>
      {!compact && <AgentModelLogo model={model} />}
      <span className={cn(
        // 短状态文案完整显示；箭头紧跟文案，不拉大间距
        'min-w-0 text-muted-foreground whitespace-nowrap',
        compact ? 'text-[13px]' : 'text-[14px]',
        label.length > 24 && 'truncate',
        running && 'agent-status-shimmer',
        running && isThinkingLabel && 'agent-thinking-status-shimmer',
      )}>
        {label}
      </span>
      {collapsible && (
        <ChevronRight className={cn(
          'size-3 shrink-0 text-muted-foreground/55 transition-transform duration-300',
          expanded && 'rotate-90',
        )} />
      )}
    </>
  )

  const line = collapsible ? (
    <button
      type="button"
      className={cn(
        'inline-flex min-h-7 max-w-full items-center gap-1 rounded-md text-left outline-none hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring/45',
        className,
      )}
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={contentId}
    >
      {content}
    </button>
  ) : (
    <div className={cn('inline-flex min-h-7 max-w-full items-center gap-1', className)}>
      {content}
    </div>
  )

  return (
    <div className="space-y-2" title={tooltip || undefined}>
      {line}
      {!compact && shouldShowDivider && (
        <div className="ml-7 h-px bg-border/45" aria-hidden="true" data-agent-status-divider="true" />
      )}
    </div>
  )
}
