import { describe, expect, mock, test } from 'bun:test'
import type {
  AgentSessionMeta,
  PromaPermissionMode,
} from '@proma/shared'
import type { BuiltinMcpToolFactory } from './tool-definition'
import { isLazyBuiltinMcpServerDefinition } from './tool-definition'

let webSearchInjectCount = 0
let collaborationInjectCount = 0
let collaborationEnabled = true

mock.module('./settings', () => ({
  isBuiltinMcpUserEnabled: (id: string) => id !== 'nano-banana'
    && (id !== 'collaboration' || collaborationEnabled),
}))

mock.module('./web-search-mcp', () => ({
  injectWebSearchMcpServer: (
    factory: BuiltinMcpToolFactory,
    mcpServers: Record<string, Record<string, unknown>>,
  ) => {
    webSearchInjectCount += 1
    mcpServers.web_search = factory.createSdkMcpServer({
      name: 'web_search',
      version: '1.0.0',
      tools: [],
    })
  },
}))

mock.module('../agent-collaboration-tools', () => ({
  injectAgentCollaborationMcpServer: async (
    factory: BuiltinMcpToolFactory,
    mcpServers: Record<string, Record<string, unknown>>,
  ) => {
    collaborationInjectCount += 1
    mcpServers.collaboration = factory.createSdkMcpServer({
      name: 'collaboration',
      version: '1.0.0',
      tools: [],
    })
  },
}))

const { injectBuiltinMcpServers } = await import('./registry')

function createContext(
  mcpServers: Record<string, Record<string, unknown>>,
  permissionMode: PromaPermissionMode = 'default',
  overrides: {
    workspaceId?: string
    triggeredBy?: 'user' | 'automation' | 'delegation'
    sessionMeta?: AgentSessionMeta
  } = {},
) {
  return {
    mcpServers,
    sessionId: 'lazy-session',
    channelId: 'channel-a',
    modelId: 'model-a',
    permissionMode,
    triggeredBy: overrides.triggeredBy ?? 'user',
    workspaceId: overrides.workspaceId,
    sessionMeta: overrides.sessionMeta,
  }
}

describe('内置 MCP 惰性注册中心', () => {
  test('Given 会话初始化 When 注册内置 MCP Then 只写入轻量描述且不执行具体注入', async () => {
    webSearchInjectCount = 0
    const externalConfig = { type: 'http', url: 'http://127.0.0.1:65535/mcp' }
    const mcpServers: Record<string, Record<string, unknown>> = {
      external: externalConfig,
    }

    const result = await injectBuiltinMcpServers(createContext(mcpServers))

    expect(result.collaborationAvailable).toBe(false)
    expect(mcpServers.external).toBe(externalConfig)
    expect(Object.keys(mcpServers).sort()).toEqual([
      'automation',
      'browser',
      'external',
      'web_search',
    ])
    expect(isLazyBuiltinMcpServerDefinition(mcpServers.web_search)).toBe(true)
    expect(isLazyBuiltinMcpServerDefinition(mcpServers.browser)).toBe(true)
    expect(isLazyBuiltinMcpServerDefinition(mcpServers.automation)).toBe(true)
    expect(webSearchInjectCount).toBe(0)
  })

  test('Given 已注册的服务 When 首次 load Then 只初始化目标服务', async () => {
    webSearchInjectCount = 0
    const mcpServers: Record<string, Record<string, unknown>> = {}
    await injectBuiltinMcpServers(createContext(mcpServers))
    const webSearch = mcpServers.web_search
    if (!isLazyBuiltinMcpServerDefinition(webSearch)) {
      throw new Error('web_search 未注册为惰性定义')
    }

    const loaded = await webSearch.load()

    expect(loaded).toMatchObject({
      kind: 'proma-builtin-mcp',
      name: 'web_search',
    })
    expect(webSearchInjectCount).toBe(1)
  })

  test('Given 相同与变化的上下文 When 跨轮注册 Then revision 稳定且不依赖 load identity', async () => {
    const firstServers: Record<string, Record<string, unknown>> = {}
    const secondServers: Record<string, Record<string, unknown>> = {}
    const changedServers: Record<string, Record<string, unknown>> = {}
    await injectBuiltinMcpServers(createContext(firstServers, 'default'))
    await injectBuiltinMcpServers(createContext(secondServers, 'default'))
    await injectBuiltinMcpServers(createContext(changedServers, 'plan'))

    const first = firstServers.web_search
    const second = secondServers.web_search
    const changed = changedServers.web_search
    if (
      !isLazyBuiltinMcpServerDefinition(first)
      || !isLazyBuiltinMcpServerDefinition(second)
      || !isLazyBuiltinMcpServerDefinition(changed)
    ) {
      throw new Error('web_search 未注册为惰性定义')
    }

    expect(first.revision).toBe(second.revision)
    expect(first.load).not.toBe(second.load)
    expect(changed.revision).not.toBe(first.revision)
  })

  test('Given 协作权限门禁 When 注册与 load Then 仅合格父会话按需初始化', async () => {
    collaborationInjectCount = 0
    const delegatedServers: Record<string, Record<string, unknown>> = {}
    const nestedServers: Record<string, Record<string, unknown>> = {}
    const availableServers: Record<string, Record<string, unknown>> = {}

    const delegated = await injectBuiltinMcpServers(createContext(
      delegatedServers,
      'default',
      { workspaceId: 'workspace-a', triggeredBy: 'delegation' },
    ))
    const nested = await injectBuiltinMcpServers(createContext(
      nestedServers,
      'default',
      {
        workspaceId: 'workspace-a',
        sessionMeta: { delegationDepth: 1 } as AgentSessionMeta,
      },
    ))
    const available = await injectBuiltinMcpServers(createContext(
      availableServers,
      'plan',
      { workspaceId: 'workspace-a' },
    ))

    expect(delegated.collaborationAvailable).toBe(false)
    expect(nested.collaborationAvailable).toBe(false)
    expect(available.collaborationAvailable).toBe(true)
    expect(delegatedServers.collaboration).toBeUndefined()
    expect(nestedServers.collaboration).toBeUndefined()
    expect(collaborationInjectCount).toBe(0)

    const collaboration = availableServers.collaboration
    if (!isLazyBuiltinMcpServerDefinition(collaboration)) {
      throw new Error('collaboration 未注册为惰性定义')
    }
    await collaboration.load()
    expect(collaborationInjectCount).toBe(1)
  })

  test('Given 普通请求未重复提及子 Agent When 父会话启用协作 Then 保留工具以便全局规则决定是否委派', async () => {
    collaborationInjectCount = 0
    const servers: Record<string, Record<string, unknown>> = {}
    const result = await injectBuiltinMcpServers({
      ...createContext(servers, 'default', { workspaceId: 'workspace-a' }),
      sessionId: 'ordinary-request-with-global-rules',
    })
    expect(result.collaborationAvailable).toBe(true)
    expect(isLazyBuiltinMcpServerDefinition(servers.collaboration)).toBe(true)
    expect(collaborationInjectCount).toBe(0)
  })

  test('Given 用户关闭协作开关 When 注册工具 Then 全局规则也不能重新启用能力', async () => {
    collaborationEnabled = false
    try {
      const servers: Record<string, Record<string, unknown>> = {}
      const result = await injectBuiltinMcpServers(
        createContext(servers, 'default', { workspaceId: 'workspace-a' }),
      )
      expect(result.collaborationAvailable).toBe(false)
      expect(servers.collaboration).toBeUndefined()
    } finally {
      collaborationEnabled = true
    }
  })
})
