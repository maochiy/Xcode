import * as React from 'react'
import type { AgentActivityItem } from '@/lib/agent-turn-presentation'
import { getAgentActivityItemKey } from './AgentTurnActivityList'

interface AgentToolCallShelfParts {
  history: AgentActivityItem[]
  latest?: AgentActivityItem
}

export function splitAgentToolCallShelf(
  items: AgentActivityItem[],
): AgentToolCallShelfParts {
  if (items.length === 0) return { history: [] }
  return {
    history: items.slice(0, -1),
    latest: items.at(-1),
  }
}

interface AgentToolCallShelfProps {
  items: AgentActivityItem[]
  renderItem: (
    item: AgentActivityItem,
    placement: 'history' | 'latest',
    historyNodes?: React.ReactNode,
  ) => React.ReactNode
}

/**
 * Cursor 风格工具调用：
 * - 表面永远是最新工具，不显示额外的「工具调用」占位标题；
 * - 更早工具作为 latest 工具自身的折叠内容传入；
 * - 新工具到达时，原 latest 自然进入历史，新项原位替换。
 */
export function AgentToolCallShelf({
  items,
  renderItem,
}: AgentToolCallShelfProps): React.ReactElement | null {
  const { history, latest } = splitAgentToolCallShelf(items)

  if (!latest) return null

  const historyNodes = history.length > 0
    ? (
        <div className="space-y-1" data-agent-tool-history="true">
          {history.map((item) => (
            <React.Fragment key={getAgentActivityItemKey(item)}>
              {renderItem(item, 'history')}
            </React.Fragment>
          ))}
        </div>
      )
    : undefined

  return (
    <div className="ml-7" data-agent-tool-shelf="true">
      <div
        data-agent-tool-latest="true"
        data-agent-tool-running={latest.running}
        data-agent-tool-history-count={history.length}
      >
        {renderItem(latest, 'latest', historyNodes)}
      </div>
    </div>
  )
}
