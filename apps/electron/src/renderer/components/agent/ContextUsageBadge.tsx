/**
 * ContextUsageBadge — 上下文使用量指示器
 *
 * 输入框工具栏上的一个 36×36 按钮：
 * - 内部为 16px 圆环，按 displayTokens / displayWindow 比例渲染
 * - hover / click 弹出 Popover，内含 token 明细 + 手动压缩按钮
 * - 压缩中时按钮位置显示 Loader2 旋转图标
 * - 占用接近 CCB 回传的动态压缩阈值时圆环变琥珀色
 * - 无数据时不显示
 */

import * as React from 'react'
import { Loader2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { cn } from '@/lib/utils'
import {
  type ChannelPlanQuotaResult,
  type ChannelPlanQuotaWindow,
} from '@proma/shared'
import { fetchChannelPlanQuota } from '@/lib/channel-plan-quota'

/** 显示警告的阈值（压缩阈值的 80%） */
const WARNING_RATIO = 0.80
/** Popover hover 关闭延迟（ms），与 AgentThinkingPopover 一致 */
const HOVER_CLOSE_DELAY = 150
const UNSUPPORTED_PLAN_QUOTA_MESSAGE = '当前渠道不支持订阅 Plan 额度查询'

interface ContextUsageBadgeProps {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** 会话累计净输入 tokens（不含缓存），用于计算缓存命中率 */
  cumulativeInputTokens?: number
  /** 会话累计缓存读取 tokens，用于计算缓存命中率 */
  cumulativeCacheReadTokens?: number
  /** 会话累计缓存写入 tokens */
  cumulativeCacheCreationTokens?: number
  costUsd?: number
  contextWindow?: number
  /** 当前上下文 token 是否为 CCB 压缩后的估算值 */
  isEstimated: boolean
  autoCompactEnabled?: boolean
  autoCompactThreshold?: number
  effectiveContextWindow?: number
  isCompacting: boolean
  isProcessing: boolean
  onCompact: () => void
  /**
   * 当前会话 ID，用于在切换会话时清空 stableRef，
   * 避免新会话尚未发消息时仍显示上一个会话的 token 数。
   */
  sessionId?: string
  /** 当前 Agent 渠道 ID，用于 hover 时查询订阅 Plan 剩余额度 */
  channelId?: string | null
  /** 渠道保存时间；凭据变更后用于使旧额度缓存失效。 */
  channelUpdatedAt?: number
}

/**
 * 会话累计缓存命中率（对齐 opencode 口径）：
 * 命中率 = cacheRead / (净输入 + cacheRead)，分母不含 cacheWrite。
 * 无累计数据时返回 undefined（不展示）。
 */
export function computeCacheHitRate(
  cumulativeInputTokens: number | undefined,
  cumulativeCacheReadTokens: number | undefined,
): number | undefined {
  if (cumulativeInputTokens == null || cumulativeCacheReadTokens == null) return undefined
  const denominator = cumulativeInputTokens + cumulativeCacheReadTokens
  if (denominator <= 0) return undefined
  return Math.round((cumulativeCacheReadTokens / denominator) * 100)
}

/** 格式化 token 数为可读字符串（如 1234 → "1.2k"） */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${tokens}`
}

/** 圆环进度指示器 — 16×16 SVG，描边 2px */
interface UsageRingProps {
  ratio: number
  isWarning: boolean
}
function UsageRing({ ratio, isWarning }: UsageRingProps): React.ReactElement {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, ratio))
  const dashOffset = circumference * (1 - clamped)

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      className={cn(
        'shrink-0 transition-colors',
        isWarning ? 'text-amber-500 dark:text-amber-400' : 'text-foreground/70',
      )}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 10 10)"
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  )
}

/** Popover 里的一行 key/value */
interface DetailRowProps {
  label: string
  value: string
  emphasized?: boolean
}
function DetailRow({ label, value, emphasized }: DetailRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-foreground/70">{label}</span>
      <span className={cn('tabular-nums', emphasized ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {value}
      </span>
    </div>
  )
}

function formatResetTime(timestamp?: number): string | undefined {
  if (!timestamp) return undefined
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function PlanQuotaRow({ quotaWindow }: { quotaWindow: ChannelPlanQuotaWindow }): React.ReactElement {
  const resetText = formatResetTime(quotaWindow.resetAt)
  const value = `${quotaWindow.remainingLabel ?? `${quotaWindow.remainingPercent}%`} 剩余${resetText ? ` · ${resetText}` : ''}`
  return (
    <div className="space-y-1">
      <DetailRow
        label={quotaWindow.label}
        value={value}
        emphasized={quotaWindow.remainingPercent <= 20}
      />
      {quotaWindow.showProgress !== false ? (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              'h-full rounded-full',
              quotaWindow.remainingPercent <= 20 ? 'bg-amber-500' : 'bg-foreground/60',
            )}
            style={{ width: `${Math.max(0, Math.min(100, quotaWindow.remainingPercent))}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export function ContextUsageBadge({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  cumulativeInputTokens,
  cumulativeCacheReadTokens,
  cumulativeCacheCreationTokens,
  contextWindow,
  isEstimated,
  autoCompactEnabled,
  autoCompactThreshold,
  effectiveContextWindow,
  isCompacting,
  isProcessing,
  onCompact,
  sessionId,
  channelId,
  channelUpdatedAt,
}: ContextUsageBadgeProps): React.ReactElement | null {
  // 保留最近一次有效的 token 值，避免切换会话时闪烁消失
  const stableRef = React.useRef<{
    inputTokens: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    cumulativeInputTokens?: number
    cumulativeCacheReadTokens?: number
    cumulativeCacheCreationTokens?: number
    contextWindow?: number
  } | null>(null)
  // 会话切换时清空陈旧值，避免新会话尚未上报 usage 时显示上个会话的数字
  const lastSessionRef = React.useRef<string | undefined>(sessionId)
  React.useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      stableRef.current = null
      lastSessionRef.current = sessionId
    }
  }, [sessionId])
  if (inputTokens && inputTokens > 0) {
    stableRef.current = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cumulativeInputTokens,
      cumulativeCacheReadTokens,
      cumulativeCacheCreationTokens,
      contextWindow,
    }
  }

  const [open, setOpen] = React.useState(false)
  const closeTimerRef = React.useRef<number | null>(null)
  // 保留上次成功/失败结果；悬浮刷新期间继续展示旧值，直到新结果到达后原位替换。
  const [quota, setQuota] = React.useState<ChannelPlanQuotaResult | null>(null)

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [cancelClose])

  React.useEffect(() => cancelClose, [cancelClose])

  React.useEffect(() => {
    if (!open || !channelId) return

    let cancelled = false

    fetchChannelPlanQuota(channelId, channelUpdatedAt)
      .then((result) => {
        if (!cancelled) setQuota(result)
      })

    return () => {
      cancelled = true
    }
  }, [open, channelId, channelUpdatedAt])

  // 压缩中 → 按钮位置显示 spinner
  if (isCompacting) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(inputToolbarButtonClass, 'text-muted-foreground cursor-default')}
        disabled
      >
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  // 使用稳定值：优先当前数据，回退到上次有效数据
  const stable = stableRef.current
  const hasCurrent = inputTokens != null && inputTokens > 0
  const displayTokens = hasCurrent ? inputTokens : stable?.inputTokens
  // contextWindow 本身就要参与展示：新 Runtime 首次模型调用前可能只有
  // 上下文窗口/压缩策略而没有 usage，此时入口仍然要显示（圆环按 0% 渲染）。
  const displayWindow = effectiveContextWindow ?? contextWindow ?? stable?.contextWindow
  const displayOutput = hasCurrent ? outputTokens : stable?.outputTokens

  // 会话累计缓存命中率（对齐 opencode：命中率 = cacheRead / (净输入 + cacheRead)，
  // 分母不含 cacheWrite）
  const displayCumulativeInput = cumulativeInputTokens ?? stable?.cumulativeInputTokens
  const displayCumulativeRead = cumulativeCacheReadTokens ?? stable?.cumulativeCacheReadTokens
  const displayHitRate = computeCacheHitRate(displayCumulativeInput, displayCumulativeRead)

  // 新 Runtime 首次模型调用前可能只有上下文窗口/压缩策略，没有 usage。
  // 仍然保留入口，保证用户可以查看策略并触发手动压缩。
  const hasContextMetadata = Boolean(
    displayWindow
    || autoCompactEnabled !== undefined
    || autoCompactThreshold !== undefined
    || effectiveContextWindow !== undefined,
  )
  if ((!displayTokens || displayTokens <= 0) && !hasContextMetadata) return null
  const visibleTokens = displayTokens ?? 0

  // 仅使用 CCB Runtime 回传的真实阈值；未拿到配置时不自行猜测。
  const compactThreshold = autoCompactEnabled === false
    ? undefined
    : autoCompactThreshold
  const isWarning = compactThreshold && compactThreshold > 0
    ? visibleTokens / compactThreshold >= WARNING_RATIO
    : false
  const ratio = displayWindow ? visibleTokens / displayWindow : 0

  const percent = displayWindow
    ? Math.round((visibleTokens / displayWindow) * 100)
    : undefined

  const handleCompactClick = (): void => {
    if (isProcessing) return
    onCompact()
    setOpen(false)
  }

  const shouldShowPlanQuota = quota != null && (
    quota.supported
    || quota.windows.length > 0
    || quota.message !== UNSUPPORTED_PLAN_QUOTA_MESSAGE
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          aria-label="上下文使用量与压缩设置"
          variant="ghost"
          size="icon"
          className={cn(
            inputToolbarButtonClass,
            isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/60 hover:text-foreground',
          )}
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
        >
          <UsageRing ratio={ratio} isWarning={isWarning} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-auto min-w-[220px] p-2.5"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-1.5">
          {displayOutput ? <DetailRow label="输出" value={displayOutput.toLocaleString()} /> : null}
          {displayHitRate != null ? <DetailRow label="缓存命中率" value={`${displayHitRate}%`} emphasized={displayHitRate >= 80} /> : null}

          {displayWindow ? (
            <>
              <DetailRow
                label={isEstimated ? '上下文（估算）' : '上下文'}
                value={`${formatTokens(visibleTokens)} / ${formatTokens(displayWindow)}`}
                emphasized
              />
              {percent != null && (
                <DetailRow
                  label="占用"
                  value={`${percent}%`}
                  emphasized={isWarning}
                />
              )}
            </>
          ) : (
            <DetailRow
              label={isEstimated ? '上下文（估算）' : '上下文'}
              value={`${formatTokens(visibleTokens)} tokens`}
              emphasized
            />
          )}
          <DetailRow
            label="自动压缩"
            value={typeof autoCompactEnabled === 'boolean'
              ? autoCompactEnabled ? '已开启' : '已关闭'
              : '待同步'}
          />
          <DetailRow
            label="压缩阈值"
            value={autoCompactEnabled === false
              ? '未启用'
              : compactThreshold && compactThreshold > 0
                ? formatTokens(compactThreshold)
                : '待同步'}
            emphasized={isWarning}
          />
          <DetailRow
            label="可用窗口"
            value={effectiveContextWindow && effectiveContextWindow > 0
              ? formatTokens(effectiveContextWindow)
              : '待同步'}
          />

          {shouldShowPlanQuota ? (
            <>
              <div className="h-px bg-border my-0.5" />
              <div className="text-[11px] font-medium text-foreground/70">
                订阅额度{quota?.planName ? ` · ${quota.planName}` : ''}
              </div>
              {quota?.supported && quota.windows.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {quota.windows.map((quotaWindow) => (
                    <PlanQuotaRow key={`${quotaWindow.type}-${quotaWindow.label}`} quotaWindow={quotaWindow} />
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-foreground/50">
                  {quota?.message ?? '订阅额度查询失败'}
                </div>
              )}
            </>
          ) : null}

          <div className="h-px bg-border my-0.5" />
          <Button
            type="button"
            variant={isWarning ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'h-7 text-xs gap-1.5',
              isWarning && 'bg-amber-500 hover:bg-amber-600 text-white',
            )}
            onClick={handleCompactClick}
            disabled={isProcessing}
          >
            <Minimize2 className="size-3.5" />
            {isProcessing ? '对话进行中' : '手动压缩'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
