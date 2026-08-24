import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, AgentWorkspace, ConversationMeta } from '@proma/shared'
import {
  buildArchivedChatItems,
  filterArchivedChatItems,
  groupArchivedChatItems,
} from './archived-chats'

function makeConversation(id: string, extra: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

function makeSession(id: string, extra: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

function makeWorkspace(id: string, name: string): AgentWorkspace {
  return {
    id,
    name,
    slug: id,
    path: `/tmp/${id}`,
    canonicalPath: `/tmp/${id}`,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('archived chat list', () => {
  test('Given Chat 和 Agent 中都有归档内容 When 构建列表 Then 只保留已归档的非草稿项', () => {
    const items = buildArchivedChatItems(
      [
        makeConversation('chat-archived', { archived: true, updatedAt: 30 }),
        makeConversation('chat-active', { archived: false }),
      ],
      [
        makeSession('agent-archived', { archived: true, workspaceId: 'workspace-1', updatedAt: 20 }),
        makeSession('agent-draft', { archived: true, draft: true }),
      ],
      [makeWorkspace('workspace-1', 'Proma')],
    )

    expect(items.map((item) => item.id)).toEqual(['chat-archived', 'agent-archived'])
    expect(items[1]?.workspaceName).toBe('Proma')
  })

  test('Given 多个项目的归档聊天 When 按项目分组 Then 无项目排在最前面且组内按更新时间倒序', () => {
    const items = buildArchivedChatItems(
      [
        makeConversation('no-project-old', { archived: true, updatedAt: 10 }),
        makeConversation('no-project-new', { archived: true, updatedAt: 30 }),
      ],
      [
        makeSession('z-project', { archived: true, workspaceId: 'z', updatedAt: 20 }),
        makeSession('a-project', { archived: true, workspaceId: 'a', updatedAt: 40 }),
      ],
      [makeWorkspace('z', 'Z 项目'), makeWorkspace('a', 'A 项目')],
    )

    const groups = groupArchivedChatItems(items)
    expect(groups.map((group) => group.workspaceName)).toEqual(['无项目', 'A 项目', 'Z 项目'])
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['no-project-new', 'no-project-old'])
  })

  test('Given 已归档聊天 When 输入关键词并选择项目 Then 只返回匹配的项目聊天', () => {
    const items = buildArchivedChatItems(
      [makeConversation('无项目聊天', { archived: true })],
      [makeSession('发布修复', { archived: true, workspaceId: 'workspace-1' })],
      [makeWorkspace('workspace-1', '客户端')],
    )

    const result = filterArchivedChatItems(items, {
      query: '发布',
      kind: 'agent',
      workspaceId: 'workspace-1',
    })

    expect(result.map((item) => item.id)).toEqual(['发布修复'])
  })
})
