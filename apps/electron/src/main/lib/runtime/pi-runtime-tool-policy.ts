import type { AgentRuntimeToolPolicy } from '@proma/shared'

const PI_NATIVE_TOOL_ALIASES: Record<string, string> = {
  read: 'Read',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  glob: 'Glob',
  ls: 'LS',
}

function canonicalToolName(name: string): string {
  const trimmed = name.trim()
  return PI_NATIVE_TOOL_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

function normalizedNames(names: string[] | undefined): Set<string> | undefined {
  if (!names) return undefined
  return new Set(names.map(canonicalToolName).filter(Boolean))
}

/** 黑名单始终优先；存在白名单时只能使用明确列出的真实工具。 */
export function isPiRuntimeToolAllowed(
  policy: AgentRuntimeToolPolicy | undefined,
  toolName: string,
): boolean {
  if (!policy) return true
  const canonical = canonicalToolName(toolName)
  if (normalizedNames(policy.disallowedTools)?.has(canonical)) return false
  const allowed = normalizedNames(policy.allowedTools)
  return allowed ? allowed.has(canonical) : true
}

/** Worker 仅注册允许的原生/Proma 工具；MCP 网关自身保留，真实调用仍按目标工具二次校验。 */
export function filterPiWorkerTools(
  toolNames: string[],
  policy: AgentRuntimeToolPolicy | undefined,
): string[] {
  if (!policy) return [...toolNames]
  const hasAllowedMcpTool = policy.allowedTools?.some((name) =>
    name.trim().startsWith('mcp__'),
  ) ?? false
  return toolNames.filter((name) => {
    if (name === 'proma_mcp_discover' || name === 'proma_mcp_call') {
      return isPiRuntimeGatewayAllowed(policy, name, hasAllowedMcpTool)
    }
    return isPiRuntimeToolAllowed(policy, name)
  })
}

export function isPiRuntimeGatewayAllowed(
  policy: AgentRuntimeToolPolicy | undefined,
  gatewayName: string,
  knownAllowedMcpTool = policy?.allowedTools?.some((name) => name.trim().startsWith('mcp__')) ?? false,
): boolean {
  if (!policy) return true
  if (normalizedNames(policy.disallowedTools)?.has(gatewayName)) return false
  return policy.allowedTools === undefined
    || knownAllowedMcpTool
    || normalizedNames(policy.allowedTools)?.has(gatewayName) === true
}

export function assertPiRuntimeToolAllowed(
  policy: AgentRuntimeToolPolicy | undefined,
  toolName: string,
): void {
  if (!isPiRuntimeToolAllowed(policy, toolName)) {
    throw new Error(`注册 Agent 不允许使用工具：${toolName}`)
  }
}
