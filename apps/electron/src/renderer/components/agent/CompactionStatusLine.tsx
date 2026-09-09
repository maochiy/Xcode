import * as React from 'react'

export type CompactionStatusLineStatus = 'running' | 'success' | 'noop' | 'failed' | 'stopped'

export interface CompactionStatusLineProps {
  status: CompactionStatusLineStatus
  trigger?: 'manual' | 'auto'
  detail?: string
  preTokens?: number
  postTokens?: number
}

const STATUS_LABELS: Record<CompactionStatusLineStatus, string> = {
  running: '正在压缩上下文',
  success: '上下文已压缩',
  noop: '当前上下文无需压缩',
  failed: '上下文压缩失败',
  stopped: '上下文压缩已停止',
}

function formatTokens(tokens: number | undefined): string | undefined {
  if (!tokens || tokens <= 0) return undefined
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function getStatusTitle({
  trigger,
  detail,
  preTokens,
  postTokens,
}: Omit<CompactionStatusLineProps, 'status'>): string | undefined {
  const parts: string[] = []
  if (trigger === 'auto') parts.push('自动触发。')
  if (trigger === 'manual') parts.push('手动触发。')

  const pre = formatTokens(preTokens)
  const post = formatTokens(postTokens)
  if (pre && post) parts.push(`上下文约 ${pre} → ${post} tokens。`)
  if (detail?.trim()) parts.push(detail.trim())

  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * Cursor 风格的上下文压缩状态行。
 *
 * 运行与终态共用同一结构；来源、token 变化及错误原因只放在原生 tooltip，
 * 避免状态行扩张成卡片、分隔线或第二个运行指示器。
 */
export function CompactionStatusLine({
  status,
  trigger,
  detail,
  preTokens,
  postTokens,
}: CompactionStatusLineProps): React.ReactElement {
  return (
    <div
      className="px-4 py-1 text-[13px] leading-5 text-muted-foreground"
      data-agent-compaction-bubble-id="summarization"
      data-agent-compaction-status={status}
      role="status"
      title={getStatusTitle({ trigger, detail, preTokens, postTokens })}
    >
      {STATUS_LABELS[status]}
    </div>
  )
}
