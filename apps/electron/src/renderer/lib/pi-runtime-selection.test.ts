import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, RuntimeDefinition } from '@proma/shared'
import {
  DEFAULT_AGENT_HARNESS_ID,
  DEFAULT_AGENT_RUNTIME_ID,
  normalizeAgentSessionRuntime,
  normalizeRoleRuntimeBinding,
  selectExecutableRuntimeDefinitions,
} from './pi-runtime-selection'

function runtime(id: RuntimeDefinition['id']): RuntimeDefinition {
  return {
    id,
    role: id === 'pi' || id === 'hermes' ? 'kernel' : 'routed-harness',
    name: id,
    description: `${id} runtime`,
    command: null,
    bundled: true,
    capabilities: [],
    installation: {
      runtimeId: id,
      status: 'ready',
      version: '1.0.0',
      executablePath: null,
      source: 'bundled',
      detail: null,
      checkedAt: 1,
    },
  }
}

function session(runtimeId?: AgentSessionMeta['runtimeId']): AgentSessionMeta {
  return {
    id: 'session-1',
    title: '会话',
    runtimeId,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Renderer Pi-only Runtime 约束', () => {
  test('Given Runtime 注册表仍含 legacy 内核 When 构建可选项 Then 仅展示 Pi', () => {
    const runtimes = (['pi', 'hermes', 'codex', 'claude'] as const).map(runtime)

    expect(selectExecutableRuntimeDefinitions(runtimes).map((item) => item.id))
      .toEqual(['pi'])
  })

  test('Given 新旧会话未绑定或绑定 legacy Runtime When 进入 Renderer Then 默认内核统一为 Pi', () => {
    expect(normalizeAgentSessionRuntime(session()).runtimeId).toBe('pi')
    expect(normalizeAgentSessionRuntime(session('claude')).runtimeId).toBe('pi')
    expect(normalizeAgentSessionRuntime(session('codex')).runtimeId).toBe('pi')
  })

  test('Given 角色名称和 legacy 执行配置 When 归一化 Then 保留角色信息且 runtime/harness 全部为 Pi', () => {
    const role = normalizeRoleRuntimeBinding({
      id: 'reviewer',
      name: '代码审查',
      runtimeId: 'codex' as const,
      harnessId: 'claude' as const,
    })

    expect(role).toEqual({
      id: 'reviewer',
      name: '代码审查',
      runtimeId: 'pi',
      harnessId: 'pi',
    })
    expect(DEFAULT_AGENT_RUNTIME_ID).toBe('pi')
    expect(DEFAULT_AGENT_HARNESS_ID).toBe('pi')
  })
})
