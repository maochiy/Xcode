import { describe, expect, test } from 'bun:test'
import {
  assertPiRuntimeToolAllowed,
  filterPiWorkerTools,
  isPiRuntimeToolAllowed,
} from './pi-runtime-tool-policy'

describe('Pi 注册 Agent 工具限制', () => {
  test('Given 白名单使用 SDK 名称 When 检查 Pi 原生名称 Then 正确映射且黑名单优先', () => {
    const policy = { allowedTools: ['Read', 'Write'], disallowedTools: ['Write'] }
    expect(isPiRuntimeToolAllowed(policy, 'read')).toBe(true)
    expect(isPiRuntimeToolAllowed(policy, 'write')).toBe(false)
    expect(() => assertPiRuntimeToolAllowed(policy, 'bash')).toThrow('不允许使用工具')
  })

  test('Given 只允许一个 MCP 工具 When 生成 Worker 工具 Then 保留网关但不放开其它工具', () => {
    const tools = filterPiWorkerTools(
      ['read', 'bash', 'proma_mcp_discover', 'proma_mcp_call', 'AskUserQuestion'],
      { allowedTools: ['mcp__search__find'] },
    )
    expect(tools).toEqual(['proma_mcp_discover', 'proma_mcp_call'])
    expect(isPiRuntimeToolAllowed({ allowedTools: ['mcp__search__find'] }, 'mcp__search__write')).toBe(false)
  })

  test('Given 只有黑名单 When 过滤工具 Then 未禁止工具保持可用', () => {
    expect(filterPiWorkerTools(
      ['read', 'write', 'AskUserQuestion'],
      { disallowedTools: ['Write'] },
    )).toEqual(['read', 'AskUserQuestion'])
  })
})
