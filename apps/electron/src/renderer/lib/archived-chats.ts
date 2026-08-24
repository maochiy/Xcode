import type { AgentSessionMeta, AgentWorkspace, ConversationMeta } from '@proma/shared'

export type ArchivedChatKind = 'chat' | 'agent'
export type ArchivedChatKindFilter = 'all' | ArchivedChatKind
export type ArchivedChatWorkspaceFilter = 'all' | 'none' | string

export interface ArchivedChatItem {
  id: string
  title: string
  kind: ArchivedChatKind
  workspaceId?: string
  workspaceName: string
  createdAt: number
  updatedAt: number
}

export interface ArchivedChatGroup {
  workspaceId?: string
  workspaceName: string
  items: ArchivedChatItem[]
}

export interface ArchivedChatFilters {
  query: string
  kind: ArchivedChatKindFilter
  workspaceId: ArchivedChatWorkspaceFilter
}

const NO_WORKSPACE_NAME = '无项目'

function resolveWorkspaceName(
  workspaceId: string | undefined,
  workspaceNames: Map<string, string>,
): string {
  if (!workspaceId) return NO_WORKSPACE_NAME
  return workspaceNames.get(workspaceId) ?? '未知项目'
}

/**
 * 将 Chat 对话与 Agent 会话统一成设置页使用的归档聊天条目。
 */
export function buildArchivedChatItems(
  conversations: ConversationMeta[],
  sessions: AgentSessionMeta[],
  workspaces: AgentWorkspace[],
): ArchivedChatItem[] {
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const chatItems = conversations
    .filter((conversation) => conversation.archived)
    .map((conversation): ArchivedChatItem => ({
      id: conversation.id,
      title: conversation.title,
      kind: 'chat',
      workspaceName: NO_WORKSPACE_NAME,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    }))
  const agentItems = sessions
    .filter((session) => session.archived && !session.draft)
    .map((session): ArchivedChatItem => ({
      id: session.id,
      title: session.title,
      kind: 'agent',
      workspaceId: session.workspaceId,
      workspaceName: resolveWorkspaceName(session.workspaceId, workspaceNames),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }))

  return [...chatItems, ...agentItems].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 应用搜索、类型和项目筛选。
 */
export function filterArchivedChatItems(
  items: ArchivedChatItem[],
  filters: ArchivedChatFilters,
): ArchivedChatItem[] {
  const query = filters.query.trim().toLocaleLowerCase()

  return items.filter((item) => {
    if (filters.kind !== 'all' && item.kind !== filters.kind) return false
    if (filters.workspaceId === 'none' && item.workspaceId) return false
    if (
      filters.workspaceId !== 'all'
      && filters.workspaceId !== 'none'
      && item.workspaceId !== filters.workspaceId
    ) {
      return false
    }
    if (!query) return true

    return [item.title, item.workspaceName, item.kind === 'chat' ? 'chat' : 'agent']
      .some((value) => value.toLocaleLowerCase().includes(query))
  })
}

/**
 * 按项目分组，未关联项目的聊天始终排在最前面。
 */
export function groupArchivedChatItems(items: ArchivedChatItem[]): ArchivedChatGroup[] {
  const groups = new Map<string, ArchivedChatGroup>()

  for (const item of items) {
    const key = item.workspaceId ?? 'none'
    const existing = groups.get(key)
    if (existing) {
      existing.items.push(item)
      continue
    }
    groups.set(key, {
      workspaceId: item.workspaceId,
      workspaceName: item.workspaceName,
      items: [item],
    })
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => {
      if (!a.workspaceId) return -1
      if (!b.workspaceId) return 1
      return a.workspaceName.localeCompare(b.workspaceName, 'zh-CN')
    })
}

export function getArchivedChatWorkspaceOptions(
  items: ArchivedChatItem[],
): Array<{ id: ArchivedChatWorkspaceFilter; label: string }> {
  const options = new Map<string, { id: ArchivedChatWorkspaceFilter; label: string }>()
  for (const item of items) {
    const id = item.workspaceId ?? 'none'
    if (!options.has(id)) {
      options.set(id, { id, label: item.workspaceName })
    }
  }

  return [...options.values()].sort((a, b) => {
    if (a.id === 'none') return -1
    if (b.id === 'none') return 1
    return a.label.localeCompare(b.label, 'zh-CN')
  })
}
