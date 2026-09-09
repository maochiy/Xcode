import type { PermissionResult } from './agent-permission-service'

/** Chrome DevTools 的已审查只读能力；不按 list/get 等名称前缀猜测副作用。 */
const READ_ONLY_CHROME_TOOLS = new Set([
  'mcp__chrome_devtools__list_pages',
  'mcp__chrome_devtools__take_snapshot',
  'mcp__chrome_devtools__take_screenshot',
  'mcp__chrome_devtools__list_network_requests',
  'mcp__chrome_devtools__performance_stop_trace',
])

/** 标记只能来自宿主内置工具定义，不能使用模型参数或外部 MCP 的自报 hint 授权。 */
export function planMcpPermission(
  name: string,
  input: Record<string, unknown>,
  trustedReadOnly: boolean | undefined,
): PermissionResult {
  const readOnly = name.startsWith('mcp__chrome_devtools__')
    ? READ_ONLY_CHROME_TOOLS.has(name)
    : trustedReadOnly === true
  return readOnly
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: '计划模式下不允许执行写操作或未经确认的 MCP 操作，请在计划审批通过后再执行' }
}
