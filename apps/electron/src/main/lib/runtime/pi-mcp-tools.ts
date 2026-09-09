/** Pi 只常驻两个 MCP 入口，完整工具参数在发现目标服务后才进入上下文。 */
export const PI_MCP_DISCOVER_TOOL = 'proma_mcp_discover'
export const PI_MCP_CALL_TOOL = 'proma_mcp_call'

export interface PiExternalTool {
  name: string
  label?: string
  description?: string
  promptSnippet?: string
  parameters?: Record<string, unknown>
}

export interface PiMcpDiscoveryResult {
  server: string
  tools: PiExternalTool[]
  instructions: string
}

/** 指定服务发现完成后返回给 Pi 的网关调用引导。 */
export function formatPiMcpDiscoveryResult(
  server: string,
  tools: PiExternalTool[],
): PiMcpDiscoveryResult {
  return {
    server,
    tools,
    instructions: `已发现 MCP 服务 ${JSON.stringify(server)} 的工具定义。推荐通过网关调用：proma_mcp_call({server: ${JSON.stringify(server)}, tool: "<从 tools[].name 选择真实工具标识>", arguments: {/* 严格遵循该工具 parameters */}})。Worker 可以按需为这些已发现工具注册兼容别名，但不能据此认为所有 MCP 工具均已注册；无论别名是否可用，都应保留发现结果中的 server、tool 和 arguments。`,
  }
}

export const PI_MCP_GATEWAY_TOOLS: PiExternalTool[] = [
  {
    name: PI_MCP_DISCOVER_TOOL,
    label: '发现 MCP 工具',
    description: '不传 server 时列出可用 MCP 服务目录，不连接服务。需要某项能力时传入目录中的 server，仅初始化该服务并返回工具名称及完整参数定义。必须先发现，再调用；不要猜测工具参数。',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: '目录中的精确服务名称；留空只看目录。' } },
      additionalProperties: false,
    },
  },
  {
    name: PI_MCP_CALL_TOOL,
    label: '调用 MCP 工具',
    description: '调用已通过 proma_mcp_discover 发现的工具。server 与 tool 使用发现结果的原值，arguments 严格遵循返回的参数定义。宿主仍按真实工具检查权限，不得借此绕过审批。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
      },
      required: ['server', 'tool', 'arguments'],
      additionalProperties: false,
    },
  },
]

export interface PiMcpCallInput {
  server: string
  tool: string
  arguments: Record<string, unknown>
}

export function parsePiMcpCall(input: Record<string, unknown>): PiMcpCallInput {
  if (typeof input.server !== 'string' || !input.server
    || typeof input.tool !== 'string' || !input.tool
    || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    throw new Error('MCP 调用需要 server、tool 和 arguments 对象，请先发现目标工具。')
  }
  return { server: input.server, tool: input.tool, arguments: input.arguments as Record<string, unknown> }
}
