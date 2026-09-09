import { describe, expect, test } from 'bun:test'
import { piApprovedToolInput, piPermissionTool } from './pi-tool-permission'

describe('Pi 内置工具复用 Proma 权限', () => {
  test('Given Pi edit When权限校验 Then复用Edit路径和修改参数并可还原执行输入', () => {
    const input = { path: '/project/file.ts', oldText: '旧', newText: '新' }
    const permission = piPermissionTool('edit', input)
    expect(permission).toMatchObject({ name: 'Edit', input: { file_path: input.path, old_string: '旧', new_string: '新' } })
    expect(piApprovedToolInput(permission.input)).toEqual(input)
  })
  test('Given Pi bash When请求执行 Then必须经过现有Bash审批和plan只读规则', () => {
    expect(piPermissionTool('bash', { command: 'echo test' })).toEqual({ name: 'Bash', input: { command: 'echo test' } })
  })
  test('Given 外部MCP工具 When校验 Then不改变工具名称和参数', () => {
    expect(piPermissionTool('mcp__tool', { query: 'test' })).toEqual({ name: 'mcp__tool', input: { query: 'test' } })
  })
})
