/**
 * ContentBlock — 单个 SDKAssistantMessage 内容块渲染
 *
 * 支持三种内容块类型：
 * - text: 通过 MessageResponse 渲染 Markdown
 * - tool_use: 语义化短语行（如 "读取 foo.ts 第 10-60 行"），展开显示结构化结果
 * - thinking: 按时间顺序显示的轻量可展开思考行
 */

import * as React from 'react'
import {
  ChevronRight,
  XCircle,
  Bot,
} from 'lucide-react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { createTimelineExpansionAtom } from '@/atoms/agent-timeline-atoms'
import {
  agentChildDelegationSessionsAtomFamily,
  agentRuntimeExecutionNodeByToolUseIdAtomFamily,
  createAgentExecutionNodeTab,
  createRuntimeExecutionNodeToolKey,
  openAgentSidePanelTabAtom,
} from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import {
  buildSessionExecutionNodes,
  extractDelegationReferences,
  extractDelegationTitles,
  isSessionExecutionNodeActivelyRunning,
  summarizeCollaborationDelegations,
  type SessionExecutionNode,
} from '@/lib/session-execution-nodes'
import { MessageResponse } from '@/components/ai-elements/message'
import { getToolIcon, extractFilePath, normalizeToolPresentation } from './tool-utils'
import { getToolPhrase } from './tool-phrase'
import { ToolResultRenderer } from './tool-result-renderers'
import { PreviewOpenButton } from './tool-result-renderers/preview-open-button'
import { getTaskGetStatusLabel, parseTaskGetResult, type ParsedTaskGetResult } from './tool-result-renderers/task-get-result'
import { parseTaskListResult, type ParsedTaskListItem } from './tool-result-renderers/task-list-result'
import { SubagentAvatar } from './SubagentAvatar'
import {
  buildSubagentPresentation,
  normalizeSubagentName,
} from '@/lib/subagent-presentation'
import { isParallelToolCallCancellation } from './tool-result-status'
import { AgentModelLogo } from './AgentTurnStatusLine'
import {
  getAgentTurnStatusLabel,
  resolveRunningTurnStatus,
} from '@/lib/agent-turn-status'
import { ThinkingActivity } from './AgentActivityTimeline'
import { useSmoothStream } from '@proma/ui'
import type {
  SDKContentBlock,
  SDKMessage,
  SDKTextBlock,
  SDKToolUseBlock,
  SDKThinkingBlock,
  SDKUserMessage,
  SDKToolResultBlock,
} from '@proma/shared'

// ===== useToolResult Hook =====

interface ToolResultData {
  result?: string
  isError?: boolean
}

/** 在 allMessages 中查找匹配 toolUseId 的工具结果 */
function useToolResult(toolUseId: string, allMessages: SDKMessage[]): ToolResultData | null {
  return React.useMemo(() => {
    for (const msg of allMessages) {
      if (msg.type !== 'user') continue
      const userMsg = msg as SDKUserMessage
      const contentBlocks = userMsg.message?.content
      if (!Array.isArray(contentBlocks)) continue

      for (const block of contentBlocks) {
        if (block.type === 'tool_result') {
          const resultBlock = block as SDKToolResultBlock
          if (resultBlock.tool_use_id === toolUseId) {
            let result: string | undefined
            if (typeof resultBlock.content === 'string') {
              result = resultBlock.content
            } else if (Array.isArray(resultBlock.content)) {
              result = (resultBlock.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === 'text' && typeof c.text === 'string')
                .map((c) => c.text)
                .join('\n')
            }
            return { result, isError: resultBlock.is_error }
          }
        }
      }
    }
    return null
  }, [toolUseId, allMessages])
}

// ===== ContentBlock Props =====

export interface ContentBlockProps {
  /** 内容块数据 */
  block: SDKContentBlock
  /** 所有消息（用于查找工具结果） */
  allMessages: SDKMessage[]
  /** 相对路径解析基准（文件链接用） */
  basePath?: string
  /** 多个可解析相对路径的基准目录 */
  basePaths?: string[]
  /** 是否启用入场动画 */
  animate?: boolean
  /** 在父级中的索引（用于动画延迟） */
  index?: number
  /** 当 turn 中已有主要内容（text）时，非主要块（tool/thinking）颜色变淡 */
  dimmed?: boolean
  /** 子代理的内容块（Agent/Task 工具调用的嵌套子块） */
  childBlocks?: SDKContentBlock[]
  /** 是否正在流式输出中（仅流式中的未完成工具调用才显示 spinner） */
  isStreaming?: boolean
  /** Proma 会话 ID，用于读取 CCB 执行图和子 Agent Transcript。 */
  sessionId?: string
  /** 当前顶层活动直接使用模型 Logo，不再额外增加独立状态行。 */
  leadingModel?: string
  /** 当前 item 是否仍处于 item/completed 之前。 */
  activityRunning?: boolean
  /** 顶层 text 是否属于工作活动而不是最终回答。 */
  activityItem?: boolean
  /** 最新工具展开时附带的历史工具节点。 */
  priorActivityNodes?: React.ReactNode
}

// ===== 工具短语 diff 着色 =====

function TaskGetCollapsedSummary({ task }: { task: ParsedTaskGetResult }): React.ReactElement {
  const blockPreview = task.blocks.length > 0
    ? `${task.blocks[0]}${task.blocks.length > 1 ? ` +${task.blocks.length - 1}` : ''}`
    : undefined

  return (
    <>
      {task.subject && (
        <>
          <span className="shrink-0 text-muted-foreground/35">·</span>
          <span className="min-w-0 truncate text-[14px] font-medium text-foreground/75">
            {task.subject}
          </span>
        </>
      )}
      {task.description && (
        <span className="hidden min-w-0 truncate text-[13px] text-muted-foreground/60 sm:inline">
          {task.description}
        </span>
      )}
      {task.status && (
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          {getTaskGetStatusLabel(task.status)}
        </span>
      )}
      {blockPreview && (
        <span className="shrink-0 rounded-sm bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground/70">
          关联 {blockPreview}
        </span>
      )}
    </>
  )
}

function TaskListCollapsedSummary({ tasks }: { tasks: ParsedTaskListItem[] }): React.ReactElement {
  const completedCount = tasks.filter((task) => task.status === 'completed').length
  const activeCount = tasks.filter((task) => task.status === 'in_progress').length
  const pendingCount = tasks.filter((task) => task.status === 'pending').length

  return (
    <>
      <span className="shrink-0 text-muted-foreground/35">·</span>
      <span className="shrink-0 rounded-full bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/75">
        {completedCount}/{tasks.length} 已完成
      </span>
      {activeCount > 0 && (
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          {activeCount} 进行中
        </span>
      )}
      {pendingCount > 0 && (
        <span className="hidden shrink-0 rounded-full bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground/65 sm:inline">
          {pendingCount} 待处理
        </span>
      )}
    </>
  )
}

const COLLABORATION_DELEGATION_TOOLS = new Set([
  'mcp__collaboration__delegate_agent',
  'mcp__collaboration__delegate_agents',
])

const COLLABORATION_COMPACT_RESULT_TOOLS = new Set([
  ...COLLABORATION_DELEGATION_TOOLS,
  'mcp__collaboration__wait_for_delegations',
  'mcp__collaboration__list_delegations',
  'mcp__collaboration__get_delegation_results',
])

// ===== 工具调用块 =====

interface ToolUseBlockProps {
  block: SDKToolUseBlock
  allMessages: SDKMessage[]
  animate?: boolean
  index?: number
  dimmed?: boolean
  childBlocks?: SDKContentBlock[]
  basePath?: string
  /** 是否正在流式输出中 */
  isStreaming?: boolean
  sessionId?: string
  /** 当前顶层活动直接以模型 Logo 起头，避免额外再渲染一行 Turn 状态。 */
  leadingModel?: string
  /** item/completed 之前的当前活动。 */
  activityRunning?: boolean
  /** 展开时附带的更早工具调用（多工具波次历史） */
  priorActivityNodes?: React.ReactNode
}

function ToolUseBlock(props: ToolUseBlockProps): React.ReactElement {
  // collaboration 委派工具需要 sessions 列表；拆分子组件避免上千个普通 tool 块订阅全局 sessions。
  if (COLLABORATION_DELEGATION_TOOLS.has(props.block.name)) {
    return <CollaborationToolUseBlock {...props} />
  }
  // 只规范展示参数，原生消息及工具关联 ID 保持不变。
  const presentation = normalizeToolPresentation(props.block.name, props.block.input)
  return <RegularToolUseBlock {...props} block={{ ...props.block, ...presentation }} />
}

/** Proma collaboration 委派工具块：仅订阅父会话下的 child delegation sessions。 */
function CollaborationToolUseBlock({
  block,
  allMessages,
  animate = false,
  index = 0,
  basePath,
  isStreaming,
  sessionId,
  leadingModel,
  activityRunning,
  priorActivityNodes,
}: ToolUseBlockProps): React.ReactElement {
  const [manualExpanded, setExpanded] = useAtom(React.useMemo(
    () => createTimelineExpansionAtom(`${sessionId ?? ''}/tool-result/${block.id}`),
    [sessionId, block.id],
  ))
  const expanded = manualExpanded ?? false
  // 委派节点只依赖子会话元数据；不订阅整图/全局 sessions，避免大会话重渲染。
  const childSessions = useAtomValue(agentChildDelegationSessionsAtomFamily(sessionId ?? ''))
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  const toolResult = useToolResult(block.id, allMessages)
  const resultText = toolResult?.result
  const isError = toolResult?.isError === true
  const isCancelled = isParallelToolCallCancellation(resultText, isError)
  const isActualError = isError && !isCancelled
  const shouldShowResult = !!resultText
  const collaborationResultSummary = React.useMemo(() => {
    if (isError || !COLLABORATION_COMPACT_RESULT_TOOLS.has(block.name)) return undefined
    return summarizeCollaborationDelegations(resultText)
  }, [block.name, isError, resultText])
  const canExpandResult = shouldShowResult && !collaborationResultSummary
  const canToggleHistory = priorActivityNodes != null
  const canToggle = canExpandResult || canToggleHistory
  const collaborationNodes = React.useMemo(() => {
    if (!sessionId) return []
    const allDelegationNodes = buildSessionExecutionNodes({
      sessionId,
      sessions: childSessions,
    }).filter((node) => node.source === 'delegation')
    const references = extractDelegationReferences(resultText)
    if (references.delegationIds.size > 0 || references.childSessionIds.size > 0) {
      return allDelegationNodes.filter((node) => (
        (node.delegationId && references.delegationIds.has(node.delegationId))
        || (node.transcriptSessionId && references.childSessionIds.has(node.transcriptSessionId))
      ))
    }
    const requestedTitles = extractDelegationTitles(block.input)
    if (requestedTitles.size > 0) {
      return allDelegationNodes.filter((node) => (
        !!node.name && requestedTitles.has(node.name)
      ))
    }
    return allDelegationNodes
  }, [
    block.input,
    childSessions,
    resultText,
    sessionId,
  ])

  const phrase = getToolPhrase(block.name, block.input)
  const isCompleted = toolResult !== null
  const running = activityRunning ?? (!isCompleted && isStreaming === true)
  const displayLabel = running
    ? leadingModel
      ? getAgentTurnStatusLabel(resolveRunningTurnStatus([block]))
      : phrase.loadingLabel
    : phrase.label
  const resolvedDisplayLabel = isCancelled
    ? getCancelledLabel(block.name)
    : displayLabel
  const delay = animate && index < 10 ? `${index * 30}ms` : '0ms'

  return (
    <div
      className={cn(animate && 'animate-in fade-in duration-500 fill-mode-both')}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-1 py-0.5 text-left transition-opacity hover:opacity-70"
        disabled={!canToggle}
        aria-expanded={canToggle ? expanded : undefined}
        onClick={() => {
          if (!canToggle) return
          setExpanded(!expanded)
        }}
      >
        {leadingModel ? (
          <AgentModelLogo model={leadingModel} />
        ) : isActualError ? (
          <XCircle className="size-3.5 shrink-0 text-destructive/70 dark:text-red-400" />
        ) : isCancelled ? (
          <XCircle className="size-3.5 shrink-0 text-muted-foreground/45" />
        ) : (
          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className={cn(
          'min-w-0 max-w-[min(100%,36rem)] truncate text-[14px] text-muted-foreground',
          running && 'agent-status-shimmer',
        )}>
          {resolvedDisplayLabel}
        </span>
        {collaborationNodes.length > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground/65">
            执行节点 · {collaborationNodes.length}
          </span>
        )}
        {canToggle && (
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
            data-collapse-chevron="right"
          />
        )}
      </button>

      {expanded && canToggleHistory && priorActivityNodes ? (
        <div className="ml-5.5 mt-1 space-y-1 border-l border-border/35 pl-3">
          {priorActivityNodes}
        </div>
      ) : null}

      {collaborationResultSummary && (
        <p className="ml-5.5 mt-1 text-[11px] text-muted-foreground/65">
          {collaborationResultSummary}
        </p>
      )}

      {collaborationNodes.length > 0 && (
        <div className="ml-5.5 mt-1.5 flex flex-wrap gap-1.5 border-l-2 border-primary/15 pl-3">
          {collaborationNodes.slice(0, 3).map((node) => {
            const presentation = buildSubagentPresentation(
              node,
              isSessionExecutionNodeActivelyRunning(node, !!isStreaming),
            )
            return (
              <button
                key={node.id}
                type="button"
                className="flex max-w-[220px] items-center gap-1.5 rounded-full bg-muted/55 px-1.5 py-1 text-left transition-colors hover:bg-accent"
                title={presentation.modelTooltip}
                onClick={() => {
                  if (!sessionId) return
                  openSidePanelTab({
                    sessionId,
                    tab: createAgentExecutionNodeTab(node.id, node.transcriptSessionId),
                    executionNodeSnapshot: {
                      node,
                      runtimeSessionId: node.transcriptSessionId,
                    },
                  })
                }}
              >
                <SubagentAvatar
                  seed={presentation.avatarSeed}
                  name={presentation.name}
                  className="size-5 text-[9px]"
                />
                <span className="min-w-0 truncate text-[11px] font-medium">
                  {presentation.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {presentation.statusLabel}
                </span>
              </button>
            )
          })}
          {collaborationNodes.length > 3 && (
            <span className="flex items-center rounded-full bg-muted/40 px-2 text-[11px] text-muted-foreground">
              及其他 {collaborationNodes.length - 3} 个子智能体
            </span>
          )}
        </div>
      )}

      {expanded && canExpandResult && resultText && (
        <div className="ml-5.5 mt-1 border-l-2 border-border/30 pl-3">
          <ToolResultRenderer
            toolName={block.name}
            input={block.input}
            result={resultText}
            isError={isActualError}
            basePath={basePath}
          />
        </div>
      )}
    </div>
  )
}

/** 普通 / Agent / Task 工具块：按 toolUseId 订阅单个 runtime 节点，不订阅整图/全局 sessions。 */
function RegularToolUseBlock({
  block,
  allMessages,
  animate = false,
  index = 0,
  dimmed = false,
  basePath,
  isStreaming,
  sessionId,
  leadingModel,
  activityRunning,
  priorActivityNodes,
}: ToolUseBlockProps): React.ReactElement {
  const [manualExpanded, setExpanded] = useAtom(React.useMemo(
    () => createTimelineExpansionAtom(`${sessionId ?? ''}/tool-result/${block.id}`),
    [sessionId, block.id],
  ))
  const expanded = manualExpanded ?? false
  const openSidePanelTab = useSetAtom(openAgentSidePanelTabAtom)
  // 仅订阅本 tool 对应 runtime 节点；无匹配节点时保持 undefined，图更新也不会误伤重渲染。
  const runtimeNode = useAtomValue(
    agentRuntimeExecutionNodeByToolUseIdAtomFamily(
      sessionId
        ? createRuntimeExecutionNodeToolKey(sessionId, block.id)
        : createRuntimeExecutionNodeToolKey('', ''),
    ),
  )
  const toolResult = useToolResult(block.id, allMessages)
  const resultText = toolResult?.result
  const isError = toolResult?.isError === true
  const isCancelled = isParallelToolCallCancellation(resultText, isError)
  const isActualError = isError && !isCancelled
  const shouldShowResult = !!resultText
  const taskGetSummary = React.useMemo(() => {
    if (block.name !== 'TaskGet' || !resultText || isError) return null
    return parseTaskGetResult(resultText)
  }, [block.name, resultText, isError])
  const taskListSummary = React.useMemo(() => {
    if (block.name !== 'TaskList' || !resultText || isError) return null
    return parseTaskListResult(resultText)
  }, [block.name, resultText, isError])
  const isAgentTool = block.name === 'Agent' || block.name === 'Task'
  const executionNode: SessionExecutionNode | undefined = runtimeNode
    ? {
        ...runtimeNode,
        source: 'runtime' as const,
        liveRuntimeNode: true,
      }
    : undefined
  const collaborationResultSummary = React.useMemo(() => {
    if (isError || !COLLABORATION_COMPACT_RESULT_TOOLS.has(block.name)) return undefined
    return summarizeCollaborationDelegations(resultText)
  }, [block.name, isError, resultText])
  const canExpandResult = shouldShowResult && !collaborationResultSummary
  const canToggleHistory = priorActivityNodes != null
  const canToggle = canExpandResult || canToggleHistory

  const phrase = getToolPhrase(block.name, block.input)
  const ToolIcon = getToolIcon(block.name)

  const isCompleted = toolResult !== null
  const running = activityRunning ?? (!isCompleted && isStreaming === true)

  // 运行中显示进行时短语，完成或非流式（已终止）显示完成态短语
  const displayLabel = running
    ? leadingModel
      ? getAgentTurnStatusLabel(resolveRunningTurnStatus([block]))
      : phrase.loadingLabel
    : phrase.label
  const filePath = extractFilePath(block.input)
  const isPreviewable = !isCancelled && (
    (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') &&
    isCompleted &&
    filePath
  )
  const resolvedDisplayLabel = isCancelled
    ? getCancelledLabel(block.name)
    : displayLabel

  const delay = animate && index < 10 ? `${index * 30}ms` : '0ms'

  // ===== Agent/Task 工具：特殊渲染 =====
  if (isAgentTool) {
    const presentation = executionNode
      ? buildSubagentPresentation(executionNode, running)
      : undefined
    const subagentName = presentation?.name
      ?? normalizeSubagentName(
        typeof block.input.name === 'string'
          ? block.input.name
          : typeof block.input.agent === 'string'
            ? block.input.agent
            : undefined,
      )
    const creationRunning = running && !executionNode
    const creationLabel = isActualError
      ? '创建子智能体失败'
      : isCancelled
        ? '已取消'
        : executionNode
          ? '已创建子智能体'
          : creationRunning
            ? '正在创建子智能体'
            : '已创建子智能体'

    return (
      <div
        className={cn(
          animate && 'animate-in fade-in duration-500 fill-mode-both',
        )}
        style={animate ? { animationDelay: delay } : undefined}
      >
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 py-0.5 text-left',
            canToggleHistory && 'transition-opacity hover:opacity-70',
          )}
          disabled={!canToggleHistory}
          aria-expanded={canToggleHistory ? expanded : undefined}
          onClick={() => {
            if (canToggleHistory) setExpanded(!expanded)
          }}
        >
          {creationRunning && leadingModel ? (
            <AgentModelLogo model={leadingModel} />
          ) : isActualError ? (
            <XCircle className="size-3.5 shrink-0 text-destructive/70 dark:text-red-400" />
          ) : isCancelled ? (
            <XCircle className="size-3.5 shrink-0 text-muted-foreground/45" />
          ) : (
            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className={cn(
            'min-w-0 flex-1 truncate text-[14px]',
            dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground',
            creationRunning && 'agent-status-shimmer',
          )}>
            {creationLabel}
          </span>
          {!executionNode && subagentName !== '智能体' && (
            <span className="max-w-[180px] truncate text-[11px] text-muted-foreground/65">
              {subagentName}
            </span>
          )}
          {canToggleHistory && (
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150',
                expanded && 'rotate-90',
              )}
              data-collapse-chevron="right"
            />
          )}
        </button>

        {expanded && canToggleHistory && priorActivityNodes ? (
          <div className="ml-5.5 mt-1 space-y-1 border-l border-border/35 pl-3">
            {priorActivityNodes}
          </div>
        ) : null}

        {executionNode && presentation && (
          <button
            type="button"
            className="ml-5.5 mt-1 flex max-w-[320px] items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/55"
            title={presentation.modelTooltip}
            onClick={() => {
              if (!sessionId) return
              openSidePanelTab({
                sessionId,
                tab: createAgentExecutionNodeTab(executionNode.id),
                executionNodeSnapshot: {
                  node: executionNode,
                  runtimeSessionId: undefined,
                },
              })
            }}
          >
            <SubagentAvatar
              seed={presentation.avatarSeed}
              name={presentation.name}
              className="size-5 text-[9px]"
            />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/75">
              {presentation.name}
            </span>
            <span className={cn(
              'shrink-0 text-[11px] text-muted-foreground',
              presentation.status === 'running' && 'agent-status-shimmer',
            )}>
              {presentation.statusLabel}
            </span>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/45" />
          </button>
        )}
      </div>
    )
  }

  // ===== 普通工具：语义化短语 + 结构化结果 =====
  return (
    <div
      className={cn(
        animate && 'animate-in fade-in duration-500 fill-mode-both',
      )}
      style={animate ? { animationDelay: delay } : undefined}
      data-agent-activity="tool"
    >
      <button
        type="button"
        className={cn(
          // 纯淡入入场，不做 max-height 动画，避免阶段行挂载时“跳一下”
          'agent-activity-fade-in inline-flex max-w-full items-center gap-1 py-0.5 text-left transition-opacity group',
          'hover:opacity-70',
        )}
        disabled={!canToggle}
        aria-expanded={canToggle ? expanded : undefined}
        onClick={() => {
          if (!canToggle) return
          setExpanded(!expanded)
        }}
      >
        {leadingModel ? (
          <AgentModelLogo model={leadingModel} />
        ) : isActualError ? (
          <XCircle className="size-3.5 text-destructive/70 dark:text-red-400 shrink-0" />
        ) : isCancelled ? (
          <XCircle className="size-3.5 text-muted-foreground/45 shrink-0" />
        ) : null}

        {!leadingModel && (
          <ToolIcon className={cn('size-3.5 shrink-0', dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground')} />
        )}

        <span className={cn(
          'min-w-0 max-w-[min(100%,36rem)] truncate text-[14px]',
          taskGetSummary || taskListSummary ? 'shrink-0' : '',
          dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground',
          running && 'agent-status-shimmer',
        )}>{resolvedDisplayLabel}</span>

        {phrase.diffStats && (isCompleted || !isStreaming) && (
          <span className="shrink-0 text-[14px] tabular-nums">
            {phrase.diffStats.additions > 0 && (
              <span className="text-green-500">+{phrase.diffStats.additions}</span>
            )}
            {phrase.diffStats.additions > 0 && phrase.diffStats.deletions > 0 && ' '}
            {phrase.diffStats.deletions > 0 && (
              <span className="text-red-500">-{phrase.diffStats.deletions}</span>
            )}
          </span>
        )}

        {taskGetSummary && (
          <span className="flex min-w-0 items-center gap-1.5">
            <TaskGetCollapsedSummary task={taskGetSummary} />
          </span>
        )}

        {taskListSummary && (
          <span className="flex min-w-0 items-center gap-1.5">
            <TaskListCollapsedSummary tasks={taskListSummary} />
          </span>
        )}

        {collaborationResultSummary && (
          <>
            <span className="shrink-0 text-muted-foreground/35">·</span>
            <span className="min-w-0 truncate text-[13px] text-muted-foreground/65">
              {collaborationResultSummary}
            </span>
          </>
        )}

        {canToggle && (
          <ChevronRight
            className={cn(
              'shrink-0 size-3 text-muted-foreground/45 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
            data-collapse-chevron="right"
          />
        )}

        {isPreviewable && (
          <PreviewOpenButton filePath={filePath} />
        )}
      </button>

      {expanded && canToggleHistory && priorActivityNodes ? (
        <div className="ml-5.5 mt-1 space-y-1 border-l border-border/35 pl-3">
          {priorActivityNodes}
        </div>
      ) : null}

      {canExpandResult && resultText && expanded && (
        <div className={cn(
          'ml-5.5 mt-1 mb-2 pl-3 border-l-2 border-border/30',
          animate && 'animate-in fade-in slide-in-from-top-1 duration-500',
        )}>
          <ToolResultRenderer
            toolName={block.name}
            input={block.input}
            result={resultText}
            isError={isActualError}
            basePath={basePath}
          />
        </div>
      )}
    </div>
  )
}

/**
 * 根据工具名生成取消态文案。
 * 规则文档要求命令被停止时显示"已停止命令"，
 * 其他工具使用"已取消"后缀。
 */
function getCancelledLabel(toolName: string): string {
  const COMMAND_TOOLS = /^(Bash|Shell|Execute|Terminal|run_command)$/i
  if (COMMAND_TOOLS.test(toolName)) return '已停止命令'
  return '已取消'
}

// ===== 思考块 =====

interface ThinkingBlockProps {
  block: SDKThinkingBlock
  dimmed?: boolean
  running?: boolean
}

function ThinkingBlock({
  block,
  dimmed = false,
  running = false,
}: ThinkingBlockProps): React.ReactElement {
  return (
    <div className={dimmed ? 'opacity-80' : undefined}>
      <ThinkingActivity
        content={block.thinking ?? ''}
        running={running}
      />
    </div>
  )
}

function ProcessTextActivity({
  block,
  basePath,
  basePaths,
  running,
  leadingModel,
}: {
  block: SDKTextBlock
  basePath?: string
  basePaths?: string[]
  running: boolean
  leadingModel?: string
}): React.ReactElement {
  // 过程正文：固定外露、换行追加，不进「正在思考」折叠；
  // 新正文单独占一行（agent-activity-fade-in 纯淡入入场，不做高度动画，避免“跳一下”），
  // 绝不 latest-only 顶替旧正文。
  // text 无思考图标。
  return (
    <div
      className="agent-activity-fade-in py-0.5 text-foreground"
      data-agent-activity="process-text"
    >
      <div className={cn(
        'min-w-0',
        leadingModel && 'grid grid-cols-[20px_minmax(0,1fr)] gap-x-2',
      )}>
        {leadingModel ? <AgentModelLogo model={leadingModel} className="mt-0.5" /> : null}
        <SmoothAgentMessageResponse
          content={block.text}
          isStreaming={running}
          basePath={basePath}
          basePaths={basePaths}
          className="text-[14px] leading-6 text-foreground prose-p:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      </div>
    </div>
  )
}

interface SmoothAgentMessageResponseProps {
  content: string
  isStreaming: boolean
  basePath?: string
  basePaths?: string[]
  className?: string
}

/** 将累计 SSE 快照转换为按字素逐帧追加的打字效果。 */
function SmoothAgentMessageResponse({
  content,
  isStreaming,
  basePath,
  basePaths,
  className,
}: SmoothAgentMessageResponseProps): React.ReactElement {
  const { displayedContent } = useSmoothStream({
    content,
    isStreaming,
    minDelay: 10,
    maxCharsPerFrame: 1,
  })

  return (
    <MessageResponse
      basePath={basePath}
      basePaths={basePaths}
      className={className}
    >
      {displayedContent}
    </MessageResponse>
  )
}

// ===== ContentBlock 主组件 =====

export function ContentBlock({
  block,
  allMessages,
  basePath,
  basePaths,
  animate = false,
  index = 0,
  dimmed = false,
  childBlocks,
  isStreaming,
  sessionId,
  leadingModel,
  activityRunning,
  activityItem = false,
  priorActivityNodes,
}: ContentBlockProps): React.ReactElement | null {
  // text 块 — 主要内容，不受 dimmed 影响
  if (block.type === 'text') {
    const textBlock = block as SDKTextBlock
    if (!textBlock.text) return null
    if (activityItem) {
      return (
        <ProcessTextActivity
          block={textBlock}
          basePath={basePath}
          basePaths={basePaths}
          running={activityRunning === true}
          leadingModel={leadingModel}
        />
      )
    }
    if (leadingModel) {
      return (
        <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2">
          <AgentModelLogo model={leadingModel} className="mt-0.5" />
          <SmoothAgentMessageResponse
            content={textBlock.text}
            isStreaming={isStreaming === true}
            basePath={basePath}
            basePaths={basePaths}
          />
        </div>
      )
    }
    return (
      <SmoothAgentMessageResponse
        content={textBlock.text}
        isStreaming={isStreaming === true}
        basePath={basePath}
        basePaths={basePaths}
      />
    )
  }

  // tool_use 块
  if (block.type === 'tool_use') {
    const toolBlock = block as SDKToolUseBlock
    return (
      <ToolUseBlock
        block={toolBlock}
        allMessages={allMessages}
        animate={animate}
        index={index}
        dimmed={dimmed}
        childBlocks={childBlocks}
        basePath={basePath}
        isStreaming={isStreaming}
        sessionId={sessionId}
        leadingModel={leadingModel}
        activityRunning={activityRunning}
        priorActivityNodes={priorActivityNodes}
      />
    )
  }

  // thinking 块（允许空正文：流式开局占位「正在思考」，无折叠箭头）
  if (block.type === 'thinking') {
    const thinkingBlock = block as SDKThinkingBlock
    const hasText = Boolean(thinkingBlock.thinking?.trim())
    // 非活动占位且无正文时不渲染；活动行即使空也要显示「正在思考」
    if (!hasText && !activityItem && activityRunning !== true) return null
    return (
      <ThinkingBlock
        block={thinkingBlock}
        dimmed={dimmed}
        running={activityRunning === true}
      />
    )
  }

  return null
}
