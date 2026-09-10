import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { RefreshCw } from 'lucide-react'
import type {
  AgentRuntimeExecutionGraph,
  AgentRuntimeExecutionNode,
} from '@proma/shared'
import {
  agentRuntimeExecutionGraphAtomFamily,
  mergeAgentRuntimeExecutionGraphAtom,
  agentSessionsAtom,
  agentSessionStreamingStateAtomFamily,
  agentSidePanelRuntimeHistoryAtom,
  agentStreamingStatesAtom,
} from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  buildSessionExecutionNodes,
  isSubagentExecutionNode,
  isSessionExecutionNodeActivelyRunning,
} from '@/lib/session-execution-nodes'
import type { SessionExecutionNode } from '@/lib/session-execution-nodes'
import { RuntimeExecutionNodeList } from './RuntimeExecutionNodeList'

interface RuntimeExecutionPanelProps {
  sessionId: string
  onOpenNode: (node: SessionExecutionNode, runtimeSessionId?: string) => void
}

export function RuntimeExecutionPanel({
  sessionId,
  onOpenNode,
}: RuntimeExecutionPanelProps): React.ReactElement {
  const graph = useAtomValue(agentRuntimeExecutionGraphAtomFamily(sessionId))
  const mergeGraph = useSetAtom(mergeAgentRuntimeExecutionGraphAtom)
  const history = useAtomValue(agentSidePanelRuntimeHistoryAtom).get(sessionId)
  const sessions = useAtomValue(agentSessionsAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const effectiveGraph = React.useMemo<AgentRuntimeExecutionGraph>(() => {
    const nodes = new Map<string, AgentRuntimeExecutionNode>(
      (history?.nodes ?? []).map((node) => [node.id, node]),
    )
    for (const node of graph?.nodes ?? []) nodes.set(node.id, node)
    return {
      runtimeSessionId: graph?.runtimeSessionId,
      nodes: Array.from(nodes.values()),
      todos: graph?.todos.length ? graph.todos : (history?.todos ?? []),
      updatedAt: Math.max(graph?.updatedAt ?? 0, history?.updatedAt ?? 0),
    }
  }, [graph, history])
  const nodes = React.useMemo(
    () => buildSessionExecutionNodes({
      sessionId,
      runtimeGraph: effectiveGraph,
      sessions,
      liveRuntimeNodeIds: new Set(
        (graph?.nodes ?? []).map((node) => node.id),
      ),
    }).filter(isSubagentExecutionNode),
    [effectiveGraph, graph?.nodes, sessionId, sessions],
  )
  const sessionRunning = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))?.running === true
  const [refreshing, setRefreshing] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    const baseRuntimeSessionId = graph?.runtimeSessionId ?? null
    try {
      const next = await window.electronAPI.getAgentRuntimeExecutionGraph(sessionId)
      mergeGraph({
        sessionId,
        graph: next,
        baseRuntimeSessionId,
      })
    } catch {
      // Session 未打开或已挂起时保留最后一次由 CCB 事件推送的执行图。
    } finally {
      setRefreshing(false)
    }
  }, [graph?.runtimeSessionId, mergeGraph, sessionId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div
      className="scrollbar-none flex h-full min-h-0 flex-col overflow-y-auto p-3"
      data-runtime-subagent-panel
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold">子智能体</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            由 Pi 执行的 Xcodes 协作任务
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        </Button>
      </div>

      {nodes.length > 0 ? (
        <RuntimeExecutionNodeList
          nodes={nodes}
          isNodeRunning={(node) => (
            isSessionExecutionNodeActivelyRunning(
              node,
              sessionRunning,
              node.transcriptSessionId
                ? streamingStates.get(node.transcriptSessionId)?.running
                : undefined,
            )
          )}
          onOpenNode={(node) => onOpenNode(
            node,
            node.source === 'delegation'
              ? node.transcriptSessionId
              : effectiveGraph.runtimeSessionId,
          )}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          当前没有子智能体数据。
        </div>
      )}
    </div>
  )
}
