import { describe, expect, test } from 'bun:test'
import { planMcpPermission } from './agent-plan-mcp-policy'

describe('计划模式 MCP 授权', () => {
  test('Given 未知或写操作 When 参数声称只读 Then 仍拒绝', () => {
    for (const name of ['mcp__files__delete', 'mcp__unknown__get_everything', 'mcp__nano_banana__generate_image']) {
      expect(planMcpPermission(name, { readOnlyHint: true, mcpReadOnly: true }, undefined).behavior).toBe('deny')
    }
  })

  test('Given 宿主内置只读定义 When 查询 Then 允许且保留参数', () => {
    const input = { taskId: 'owned-task' }
    expect(planMcpPermission('mcp__browser__browser_get_state', input, true))
      .toEqual({ behavior: 'allow', updatedInput: input })
  })

  test('Given Chrome DevTools When 查询或操作页面 Then 只允许精确白名单', () => {
    expect(planMcpPermission('mcp__chrome_devtools__take_snapshot', {}, false).behavior).toBe('allow')
    expect(planMcpPermission('mcp__chrome_devtools__click', {}, true).behavior).toBe('deny')
    expect(planMcpPermission('mcp__chrome_devtools__evaluate_script', {}, false).behavior).toBe('deny')
  })
})
