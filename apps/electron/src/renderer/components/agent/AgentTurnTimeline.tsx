import * as React from 'react'
import type { SDKContentBlock } from '@proma/shared'
import type { CursorTurnPresentation } from '@/lib/agent-cursor-turn'
import type { AgentActivityItem } from '@/lib/agent-turn-presentation'
import { AgentActivityTimeline, ThinkingActivity } from './AgentActivityTimeline'
import { AgentTurnStatusLine } from './AgentTurnStatusLine'

interface AgentTurnTimelineProps {
  presentation: CursorTurnPresentation
  sessionId?: string
  model?: string
  fullTranscript?: boolean
  hideFinalItems?: boolean
  hideStatus?: boolean
  revealTools?: boolean
  failedToolIds?: ReadonlySet<string>
  renderActivity: (item: AgentActivityItem) => React.ReactNode
  renderFinal: (block: SDKContentBlock, index: number) => React.ReactNode
}

/**
 * 整轮的唯一展示入口：
 * 原生活动始终按时间顺序展示，思考与工具仅折叠各自详情。
 * 最终正文位于活动之后，完成、停止和失败元信息固定放在整轮末尾。
 */
export function AgentTurnTimeline({
  presentation, sessionId, model, fullTranscript, hideFinalItems, hideStatus,
  revealTools, failedToolIds, renderActivity, renderFinal,
}: AgentTurnTimelineProps): React.ReactElement {
  const stateKey = `${sessionId ?? ''}/${presentation.id}`
  const hasActivity = presentation.activities.length > 0

  return (
    <div className="space-y-3" data-agent-turn-timeline={presentation.status}>
      {hasActivity && (
        <AgentActivityTimeline
          items={presentation.activities}
          stateKey={stateKey}
          fullTranscript={fullTranscript}
          revealTools={revealTools || presentation.status === 'stopped' || presentation.status === 'failed'}
          failedToolIds={failedToolIds}
          renderItem={renderActivity}
        />
      )}
      {presentation.showThinkingPlaceholder && <ThinkingActivity content="" running />}
      {presentation.showWaitingPlaceholder && (
        <div role="status" className="py-1 text-[14px] leading-[22px] text-muted-foreground" data-agent-activity="waiting">
          <span className="agent-status-shimmer">正在准备下一步</span>
        </div>
      )}
      {!hideFinalItems && presentation.finalItems.length > 0 && (
        <div className="min-w-0 space-y-2" data-agent-final-answer>
          {presentation.finalItems.map((item) => (
            <React.Fragment key={item.index}>{renderFinal(item.block, item.index)}</React.Fragment>
          ))}
        </div>
      )}
      {!hideStatus && presentation.status !== 'running' && (
        <AgentTurnStatusLine
          compact
          model={presentation.model ?? model}
          status={presentation.status}
          durationMs={presentation.durationMs}
          usage={presentation.usage}
        />
      )}
    </div>
  )
}
