import * as React from 'react'
import type { AgentTurnStatus } from '@/lib/agent-turn-status'
import { getAgentTurnStatusLabel } from '@/lib/agent-turn-status'
import { cn } from '@/lib/utils'

interface AgentRunningIndicatorProps {
  startedAt?: number
  model?: string
  status?: AgentTurnStatus
  className?: string
}

/** 首个模型事件之前立即展示单行占位，不重复堆叠状态栏和思考面板。 */
export function AgentRunningIndicator({
  model, status, className,
}: AgentRunningIndicatorProps): React.ReactElement {
  return (
    <div role="status" title={model ? `使用 ${model}` : undefined}
      data-agent-activity={status === 'thinking' ? 'thinking' : 'waiting'}
      className={cn('agent-activity-fade-in py-1 text-[14px] leading-[22px] text-muted-foreground', className)}
    >
      <span className="agent-status-shimmer">
        {status ? getAgentTurnStatusLabel(status) : '正在准备下一步'}
      </span>
    </div>
  )
}
