import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Loader2 } from 'lucide-react'
import type {
  AgentRuntimeSubagentTranscript,
  SDKContentBlock,
  SDKMessage,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@proma/shared'
import {
  extractUserText,
  groupIntoTurns,
  type AssistantTurn,
} from '@proma/session-core'
import {
  BasePathsProvider,
  MessageResponse,
} from '@/components/ai-elements/message'
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation'
import { AgentConversationScrollController, AgentConversationScrollButton } from './AgentConversationScrollController'
import {
  agentExecutionNodeTranscriptCacheAtom,
  agentSDKMessagesCacheAtom,
  agentSessionLiveMessagesAtomFamily,
  agentSessionStreamingStateAtomFamily,
} from '@/atoms/agent-atoms'
import type { SessionExecutionNode } from '@/lib/session-execution-nodes'
import { buildCursorTurnPresentation } from '@/lib/agent-cursor-turn'
import { upsertAgentLiveMessage } from '@/lib/agent-live-message'
import { buildSubagentPresentation } from '@/lib/subagent-presentation'
import {
  getGroupId,
  MessageGroupRenderer,
  type MessageGroup,
} from './SDKMessageRenderer'
import { AgentRunningIndicator } from './AgentRunningIndicator'
import { normalizeThinkTagsInContentBlocks } from './thinking-tag-parser'
import { SubagentAvatar } from './SubagentAvatar'

interface RuntimeExecutionNodePanelProps {
  cacheKey?: string
  sessionId: string
  sessionPath: string | null
  node: SessionExecutionNode
  running: boolean
}

interface TopLevelTurnBlocks {
  blocks: SDKContentBlock[]
  forcedActivityIndexes: Set<number>
}

const EMPTY_SDK_MESSAGES: SDKMessage[] = []

function collectTopLevelBlocks(turn: AssistantTurn): TopLevelTurnBlocks {
  const enriched: Array<{
    block: SDKContentBlock
    parentToolUseId?: string | null
    forcedActivity: boolean
  }> = []

  for (const message of turn.assistantMessages) {
    const blocks = message.message?.content
    if (!Array.isArray(blocks)) continue
    const forcedActivity = message.message?.stop_reason === 'tool_use'
    for (const block of blocks) {
      for (const normalized of normalizeThinkTagsInContentBlocks([block])) {
        enriched.push({
          block: normalized,
          parentToolUseId: message.parent_tool_use_id,
          forcedActivity,
        })
      }
    }
  }

  const agentToolIds = new Set<string>()
  for (const item of enriched) {
    if (item.block.type !== 'tool_use') continue
    const tool = item.block as SDKToolUseBlock
    if (tool.name === 'Agent' || tool.name === 'Task') {
      agentToolIds.add(tool.id)
    }
  }

  const blocks: SDKContentBlock[] = []
  const forcedActivityIndexes = new Set<number>()
  for (const item of enriched) {
    if (item.parentToolUseId && agentToolIds.has(item.parentToolUseId)) {
      continue
    }
    if (item.forcedActivity) forcedActivityIndexes.add(blocks.length)
    blocks.push(item.block)
  }
  return { blocks, forcedActivityIndexes }
}

function extractResultText(messages: SDKMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'result') continue
    const result = (message as unknown as Record<string, unknown>).result
    if (typeof result === 'string' && result.trim()) return result.trim()
  }
  return undefined
}

export interface RuntimeExecutionNodeDetails {
  delegatedTask: string
  finalReply?: string
}

/** 从子智能体 Transcript 提取委派任务和最终正文兜底。 */
export function buildRuntimeExecutionNodeDetails(
  messages: SDKMessage[],
  node: SessionExecutionNode,
): RuntimeExecutionNodeDetails {
  const delegatedTask = messages
    .filter((message): message is SDKUserMessage => message.type === 'user')
    .map((message) => extractUserText(message))
    .find((text) => text?.trim())
    ?.trim()
    ?? node.description

  const turns = groupIntoTurns(messages)
    .filter((group): group is AssistantTurn => group.type === 'assistant-turn')

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (!turn) continue
    const { blocks, forcedActivityIndexes } = collectTopLevelBlocks(turn)
    const presentation = buildCursorTurnPresentation({
      id: `execution-node:${node.id}:${index}`,
      turn,
      blocks,
      forcedActivityIndexes,
    })
    const answer = presentation.finalItems
      .filter((item) => item.kind === 'answer' && item.block.type === 'text')
      .map((item) => (item.block as { text: string }).text.trim())
      .filter(Boolean)
      .join('\n\n')
    if (answer) return { delegatedTask, finalReply: answer }

    const result = extractResultText(turn.turnMessages)
    if (result) return { delegatedTask, finalReply: result }
  }

  return { delegatedTask }
}

/**
 * 将已持久化 Transcript 与 Renderer 实时消息合并。
 *
 * 实时 partial/final 使用与主会话相同的 upsert 规则，避免轮询结果和 IPC
 * 增量同时存在时重复渲染同一条思考、命令或最终回答。
 */
export function mergeRuntimeExecutionTranscriptMessages(
  persistedMessages: SDKMessage[],
  liveMessages: SDKMessage[],
): SDKMessage[] {
  return liveMessages.reduce<SDKMessage[]>(
    (messages, message) => upsertAgentLiveMessage(messages, message),
    persistedMessages,
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

interface RuntimeExecutionTranscriptProps {
  messages: SDKMessage[]
  node: SessionExecutionNode
  parentSessionId: string
  running: boolean
  startedAt?: number
  sessionPath: string | null
}

/**
 * 子智能体详情复用主会话的 Turn 渲染器：
 * - 运行中按原生顺序追加思考、正文与工具；
 * - 执行结束后作为完整 Transcript 强制展开活动；
 * - 委派提示词已在上方单独展示，因此这里不重复渲染 user group。
 */
function RuntimeExecutionTranscript({
  messages,
  node,
  parentSessionId,
  running,
  startedAt,
  sessionPath,
}: RuntimeExecutionTranscriptProps): React.ReactElement {
  const groups = React.useMemo(
    () => groupIntoTurns(messages, node.model)
      .filter((group) => group.type !== 'user'),
    [messages, node.model],
  )
  const assistantGroups = groups.filter(
    (group): group is Extract<MessageGroup, { type: 'assistant-turn' }> =>
      group.type === 'assistant-turn',
  )
  const latestAssistantGroup = assistantGroups.at(-1)
  const transcriptSessionId = node.transcriptSessionId
    ?? `${parentSessionId}:execution-node:${node.id}`

  if (groups.length === 0) {
    return running ? (
      <AgentRunningIndicator
        startedAt={startedAt ?? node.startedAt}
        model={node.model}
      />
    ) : (
      <p className="text-xs text-muted-foreground">暂无可显示的执行记录。</p>
    )
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const isLatestAssistantTurn = group === latestAssistantGroup
        return (
          <MessageGroupRenderer
            key={getGroupId(group)}
            group={group}
            allMessages={messages}
            basePath={sessionPath || undefined}
            isStreaming={running && isLatestAssistantTurn}
            sessionModelId={node.model}
            sessionId={transcriptSessionId}
            fullTranscript={!running}
            hideFinalItems
            isLatestAssistantTurn={isLatestAssistantTurn}
            runningStartedAt={
              running && isLatestAssistantTurn
                ? startedAt ?? node.startedAt
                : undefined
            }
          />
        )
      })}
      {running && !latestAssistantGroup && (
        <AgentRunningIndicator
          startedAt={startedAt ?? node.startedAt}
          model={node.model}
        />
      )}
    </div>
  )
}

/**
 * 执行节点详情采用委派任务 / 状态 / 执行过程 / 最终回复结构。
 * 执行过程与主会话共用同一套时间线、活动状态和折叠规则。
 */
export function RuntimeExecutionNodePanel({
  cacheKey,
  sessionId,
  sessionPath,
  node,
  running,
}: RuntimeExecutionNodePanelProps): React.ReactElement {
  const resolvedCacheKey = cacheKey ?? `${sessionId}:${node.id}`
  const transcriptCache = useAtomValue(agentExecutionNodeTranscriptCacheAtom)
  const sdkMessagesCache = useAtomValue(agentSDKMessagesCacheAtom)
  const setTranscriptCache = useSetAtom(agentExecutionNodeTranscriptCacheAtom)
  const childSessionId = node.transcriptSessionId
  const childSessionKey = childSessionId ?? ''
  const childLiveMessages = useAtomValue(
    agentSessionLiveMessagesAtomFamily(childSessionKey),
  )
  const childStreamState = useAtomValue(
    agentSessionStreamingStateAtomFamily(childSessionKey),
  )
  const cachedSessionMessages = childSessionId
    ? sdkMessagesCache.get(childSessionId)
    : undefined
  const cachedTranscript = transcriptCache.get(resolvedCacheKey)
    ?? (cachedSessionMessages
      ? {
          executionNodeId: node.id,
          messages: cachedSessionMessages,
        }
      : undefined)
  const [transcript, setTranscript] = React.useState<
    AgentRuntimeSubagentTranscript | undefined
  >(cachedTranscript)
  const [loading, setLoading] = React.useState(cachedTranscript == null)
  const [error, setError] = React.useState<string>()
  const canQueryTranscript = (
    node.source === 'delegation'
    || node.transcriptAvailable
    || node.kind === 'subagent'
    || node.kind === 'teammate'
  )
  const requestSequenceRef = React.useRef(0)

  const loadTranscript = React.useCallback(async (
    initial: boolean,
  ): Promise<void> => {
    const requestSequence = ++requestSequenceRef.current
    if (!canQueryTranscript) {
      setLoading(false)
      return
    }
    if (initial) setLoading(true)
    try {
      const next = node.source === 'delegation' && node.transcriptSessionId
        ? {
            executionNodeId: node.id,
            messages: await window.electronAPI.getAgentSessionSDKMessages(
              node.transcriptSessionId,
            ),
          }
        : await window.electronAPI
          .getAgentRuntimeSubagentTranscript(sessionId, node.id)
      if (requestSequence !== requestSequenceRef.current) return
      setTranscript(next)
      setTranscriptCache((previous) => {
        const nextCache = new Map(previous)
        nextCache.set(resolvedCacheKey, next)
        return nextCache
      })
      setError(undefined)
    } catch (reason) {
      if (requestSequence !== requestSequenceRef.current) return
      setError(
        reason instanceof Error
          ? reason.message
          : '读取子智能体执行记录失败',
      )
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false)
    }
  }, [
    canQueryTranscript,
    node.id,
    node.source,
    node.transcriptSessionId,
    resolvedCacheKey,
    sessionId,
    setTranscriptCache,
  ])

  React.useEffect(() => {
    const cached = transcriptCache.get(resolvedCacheKey)
    setTranscript(cached)
    setError(undefined)
    void loadTranscript(cached == null)
    return () => {
      requestSequenceRef.current += 1
    }
  }, [loadTranscript, resolvedCacheKey, running])

  React.useEffect(() => {
    if (!canQueryTranscript || !running) return
    let cancelled = false
    let timer: number | undefined
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        void loadTranscript(false).finally(() => {
          if (!cancelled) schedule()
        })
      }, 1_500)
    }
    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [canQueryTranscript, loadTranscript, running])

  const effectiveRunning = running || childStreamState?.running === true
  const presentation = buildSubagentPresentation(node, effectiveRunning)
  const liveMessages = childSessionId
    ? childLiveMessages ?? EMPTY_SDK_MESSAGES
    : EMPTY_SDK_MESSAGES
  const transcriptMessages = React.useMemo(() => {
    const persistedMessages = transcript?.messages ?? []
    if (!effectiveRunning || liveMessages.length === 0) {
      return persistedMessages
    }
    return mergeRuntimeExecutionTranscriptMessages(
      persistedMessages,
      liveMessages,
    )
  }, [effectiveRunning, liveMessages, transcript?.messages])
  const hasTranscriptContent = transcriptMessages.some(
    (message) => message.type === 'assistant' || message.type === 'system',
  )
  const details = React.useMemo(
    () => buildRuntimeExecutionNodeDetails(transcriptMessages, node),
    [node, transcriptMessages],
  )
  const completionContent = details.finalReply
    ?? (!effectiveRunning ? node.summary?.trim() : undefined)
  const completionTitle = details.finalReply ? '最终回复' : '执行摘要'
  const shouldShowCompletion = (
    !effectiveRunning
    && !loading
    && !!completionContent
  )

  return (
    <BasePathsProvider basePaths={sessionPath ? [sessionPath] : []}>
      <Conversation className="h-full">
        <AgentConversationScrollController />
        <ConversationContent className="max-w-[48rem] space-y-6 px-3 py-5 sm:px-3">
          <DetailSection title="委派的任务">
            <MessageResponse className="text-[13px] leading-5 text-foreground/85">
              {details.delegatedTask}
            </MessageResponse>
          </DetailSection>

          <DetailSection title="状态">
            <div
              className="flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/40"
              title={presentation.modelTooltip}
            >
              <SubagentAvatar
                seed={presentation.avatarSeed}
                name={presentation.name}
                className="size-6 text-[10px]"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {presentation.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {presentation.statusLabel}
              </span>
            </div>
          </DetailSection>

          <DetailSection title="执行过程">
            {loading && transcriptMessages.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                正在加载执行记录…
              </div>
            ) : hasTranscriptContent || effectiveRunning ? (
              <RuntimeExecutionTranscript
                messages={transcriptMessages}
                node={node}
                parentSessionId={sessionId}
                running={effectiveRunning}
                startedAt={childStreamState?.startedAt}
                sessionPath={sessionPath}
              />
            ) : error ? (
              <p className="text-xs leading-5 text-muted-foreground">
                此子智能体在当前分支上已不可用。
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">暂无可显示的执行记录。</p>
            )}
          </DetailSection>

          {shouldShowCompletion && (
            <DetailSection title={completionTitle}>
              <MessageResponse className="text-[13px] leading-5">
                {completionContent}
              </MessageResponse>
            </DetailSection>
          )}
        </ConversationContent>
        <AgentConversationScrollButton />
      </Conversation>
    </BasePathsProvider>
  )
}
