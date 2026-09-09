import type { SDKToolUseBlock } from '@proma/shared'
import type { AgentActivityItem } from './agent-turn-presentation'

export interface AgentTimelineEntry {
  id: string
  kind: 'text' | 'thinking' | 'tools' | 'other'
  items: AgentActivityItem[]
}

type ToolCategory = 'file' | 'command' | 'search' | 'other'

const FILE_TOOLS = new Set([
  'read',
  'read_file',
  'notebookread',
])

const COMMAND_TOOLS = new Set([
  'bash',
  'execute',
  'shell',
  'terminal',
  'run_command',
])

const SEARCH_TOOLS = new Set([
  'grep',
  'glob',
  'search',
  'filesearch',
  'search_files',
  'find',
  'ls',
  'listdir',
])

function getTimelineKind(item: AgentActivityItem): AgentTimelineEntry['kind'] {
  switch (item.block.type) {
    case 'text':
      return 'text'
    case 'thinking':
      return 'thinking'
    case 'tool_use':
      return 'tools'
    default:
      return 'other'
  }
}

function getTimelineEntryId(item: AgentActivityItem): string {
  if (item.block.type === 'tool_use') {
    const tool = item.block as SDKToolUseBlock
    if (tool.id) return `tool:${tool.id}`
  }
  return `${item.block.type}:${item.index}`
}

function getToolCategory(item: AgentActivityItem): ToolCategory {
  if (item.block.type !== 'tool_use') return 'other'

  const toolName = (item.block as SDKToolUseBlock).name.toLowerCase()
  if (FILE_TOOLS.has(toolName)) return 'file'
  if (COMMAND_TOOLS.has(toolName)) return 'command'
  if (SEARCH_TOOLS.has(toolName)) return 'search'
  return 'other'
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined
}

function getRunningToolLabel(tools: AgentActivityItem[]): string | undefined {
  const current = tools.findLast(item => item.running)
  if (!current || current.block.type !== 'tool_use') return undefined

  const tool = current.block as SDKToolUseBlock
  const category = getToolCategory(current)

  if (category === 'file') {
    const path = nonEmptyString(tool.input.file_path)
      ?? nonEmptyString(tool.input.path)
    return path ? `正在查看 ${path}` : undefined
  }

  if (category === 'command') {
    const description = nonEmptyString(tool.input.description)
      ?? nonEmptyString(tool.input.title)
    return description ? `正在运行 ${description}` : undefined
  }

  const name = nonEmptyString(tool.name)
  if (!name) return undefined
  return category === 'search'
    ? `正在搜索 ${name}`
    : `正在调用 ${name}`
}

/**
 * 按原生顺序展示；工具之间已结束的思考归入同组，正文和实时思考仍独立可见。
 */
export function buildAgentActivityTimeline(
  items: AgentActivityItem[],
): AgentTimelineEntry[] {
  const entries: AgentTimelineEntry[] = []

  for (let position = 0; position < items.length; position += 1) {
    const item = items[position]!
    const kind = getTimelineKind(item)
    const previous = entries.at(-1)

    if (previous?.kind === 'tools' && kind === 'thinking' && !item.running) {
      let nextToolPosition = position
      while (items[nextToolPosition]?.block.type === 'thinking' && !items[nextToolPosition]?.running) {
        nextToolPosition += 1
      }
      if (items[nextToolPosition]?.block.type === 'tool_use') {
        previous.items.push(...items.slice(position, nextToolPosition + 1))
        position = nextToolPosition
        continue
      }
    }

    if ((kind === 'tools' || kind === 'thinking') && previous?.kind === kind) {
      previous.items.push(item)
      continue
    }

    entries.push({
      id: getTimelineEntryId(item),
      kind,
      items: [item],
    })
  }

  return entries
}

/**
 * 为工具组生成摘要；中间思考保留在明细中，但不计入工具数量。
 */
export function getToolGroupLabel(items: AgentActivityItem[]): string {
  const tools = items.filter(item => item.block.type === 'tool_use')
  const count = tools.length
  const running = tools.some((item) => item.running)
  const runningLabel = running ? getRunningToolLabel(tools) : undefined
  if (runningLabel) return runningLabel

  const categories = new Set(tools.map(getToolCategory))
  const category = categories.size === 1
    ? categories.values().next().value
    : 'other'

  switch (category) {
    case 'file':
      return `${running ? '正在查看' : '已查看'} ${count} 个文件`
    case 'command':
      return `${running ? '正在运行' : '已运行'} ${count} 条命令`
    case 'search':
      return `${running ? '正在搜索' : '已搜索'} ${count} 项`
    case 'other':
    default:
      return `${running ? '正在调用' : '已调用'} ${count} 个工具`
  }
}
