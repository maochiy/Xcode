/**
 * Proma 内置 MCP 注册中心
 *
 * Orchestrator 只调用这里的统一入口。这里仅注册轻量惰性描述，不创建工具、
 * 不启动 HTTP Host；具体服务的初始化错误会延迟到首次发现或调用时返回。
 */

import { createHash } from 'node:crypto'
import type { AgentSessionMeta, PromaPermissionMode } from '@proma/shared'
import { getBuiltinMcpById, getBuiltinMcpName } from './baseline'
import { createLazyBuiltinMcpServerDefinition } from './lazy-definition'
import { isBuiltinMcpUserEnabled } from './settings'
import {
  builtinMcpToolFactory,
  isBuiltinMcpServerDefinition,
} from './tool-definition'
import type { BuiltinMcpServerDefinition } from './tool-definition'

export interface BuiltinMcpInjectContext {
  mcpServers: Record<string, Record<string, unknown>>
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceSlug?: string
  agentCwd?: string
  permissionMode?: PromaPermissionMode
  triggeredBy?: 'user' | 'automation' | 'delegation'
  sessionMeta?: AgentSessionMeta
}

interface LazyRegistration {
  id: string
  collaborationRequested?: boolean
  inject: (mcpServers: Record<string, Record<string, unknown>>) => Promise<void>
}

function buildLazyRevision(
  ctx: BuiltinMcpInjectContext,
  registration: Pick<LazyRegistration, 'id' | 'collaborationRequested'>,
): string {
  const payload = JSON.stringify({
    version: 1,
    serverId: registration.id,
    sessionId: ctx.sessionId,
    channelId: ctx.channelId,
    modelId: ctx.modelId ?? null,
    workspaceId: ctx.workspaceId ?? null,
    workspaceSlug: ctx.workspaceSlug ?? null,
    agentCwd: ctx.agentCwd ?? null,
    permissionMode: ctx.permissionMode ?? null,
    triggeredBy: ctx.triggeredBy ?? null,
    delegationDepth: ctx.sessionMeta?.delegationDepth ?? 0,
    collaborationRequested: registration.collaborationRequested ?? null,
  })
  return `v1:${createHash('sha256').update(payload).digest('hex').slice(0, 24)}`
}

async function loadInjectedServer(
  serverName: string,
  inject: LazyRegistration['inject'],
): Promise<BuiltinMcpServerDefinition> {
  const loadedServers: Record<string, Record<string, unknown>> = {}
  await inject(loadedServers)
  const definition = loadedServers[serverName]
  if (!isBuiltinMcpServerDefinition(definition)) {
    throw new Error(
      `内置 MCP "${serverName}" 当前不可用；初始化错误已延迟到首次使用时返回`,
    )
  }
  return definition
}

function registerLazyBuiltin(
  ctx: BuiltinMcpInjectContext,
  registration: LazyRegistration,
): void {
  const manifestDefinition = getBuiltinMcpById(registration.id)
  const serverName = getBuiltinMcpName(registration.id)
  const description = manifestDefinition?.description ?? `Xcode 内置 MCP：${serverName}`

  ctx.mcpServers[serverName] = createLazyBuiltinMcpServerDefinition({
    name: serverName,
    description,
    revision: buildLazyRevision(ctx, registration),
    load: () => loadInjectedServer(serverName, registration.inject),
  })
}

export async function injectBuiltinMcpServers(
  ctx: BuiltinMcpInjectContext,
): Promise<{ collaborationAvailable: boolean }> {
  // 基础设施型能力始终登记；服务层登录态等检查延迟到工具真正执行时发生。
  registerLazyBuiltin(ctx, {
    id: 'web-search',
    inject: async (mcpServers) => {
      const { injectWebSearchMcpServer } = await import('./web-search-mcp')
      injectWebSearchMcpServer(builtinMcpToolFactory, mcpServers)
    },
  })

  registerLazyBuiltin(ctx, {
    id: 'browser',
    inject: async (mcpServers) => {
      const { injectBrowserAgentMcpServer } = await import('../browser/browser-agent-tools')
      await injectBrowserAgentMcpServer(builtinMcpToolFactory, mcpServers, {
        sessionId: ctx.sessionId,
      })
    },
  })

  if (isBuiltinMcpUserEnabled('nano-banana')) {
    registerLazyBuiltin(ctx, {
      id: 'nano-banana',
      inject: async (mcpServers) => {
        const { injectNanoBananaMcpServer } = await import('../chat-tools/nano-banana-mcp')
        await injectNanoBananaMcpServer(
          builtinMcpToolFactory,
          mcpServers,
          ctx.sessionId,
          ctx.agentCwd,
        )
      },
    })
  }

  if (isBuiltinMcpUserEnabled('automation')) {
    registerLazyBuiltin(ctx, {
      id: 'automation',
      inject: async (mcpServers) => {
        const { injectAutomationMcpServer } = await import('../automation-agent-tools')
        await injectAutomationMcpServer(builtinMcpToolFactory, mcpServers, {
          sessionId: ctx.sessionId,
          channelId: ctx.channelId,
          modelId: ctx.modelId,
          workspaceId: ctx.workspaceId,
          triggeredBy: ctx.triggeredBy,
        })
      },
    })
  }

  // 子 Agent 硬开关保持原约束：设置开启、有工作区、非委派会话、深度为 0，
  // 且当前真实用户消息明确要求多/并行子 Agent。
  let collaborationAvailable = false
  const collaborationContextAvailable = isBuiltinMcpUserEnabled('collaboration')
    && !!ctx.workspaceId
    && ctx.triggeredBy !== 'delegation'
    && (ctx.sessionMeta?.delegationDepth ?? 0) === 0

  if (collaborationContextAvailable) {
    const { userRequestedSubAgents } = await import('../agent-collaboration-tools')
    collaborationAvailable = userRequestedSubAgents(ctx.sessionId)
  }

  if (collaborationAvailable) {
    registerLazyBuiltin(ctx, {
      id: 'collaboration',
      collaborationRequested: true,
      inject: async (mcpServers) => {
        const { injectAgentCollaborationMcpServer } = await import('../agent-collaboration-tools')
        await injectAgentCollaborationMcpServer(builtinMcpToolFactory, mcpServers, {
          sessionId: ctx.sessionId,
          channelId: ctx.channelId,
          modelId: ctx.modelId,
          workspaceId: ctx.workspaceId,
          permissionMode: ctx.permissionMode,
          triggeredBy: ctx.triggeredBy,
        })
      },
    })
  }

  return { collaborationAvailable }
}
