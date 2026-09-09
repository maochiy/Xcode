import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z, type ZodObject, type ZodRawShape } from 'zod'

export interface BuiltinMcpToolDefinition {
  name: string
  description: string
  inputSchema: ZodObject<ZodRawShape>
  annotations?: ToolAnnotations
  execute(input: unknown): Promise<CallToolResult>
}

export interface BuiltinMcpServerDefinition extends Record<string, unknown> {
  kind: 'proma-builtin-mcp'
  name: string
  version: string
  tools: BuiltinMcpToolDefinition[]
}

/**
 * 内置 MCP 的轻量惰性描述。
 *
 * Registry 只把该描述交给 Runtime；首次发现或调用此服务时才执行 load。
 * revision 用于跨轮判断上下文是否变化，调用方不得用 load 函数 identity 做缓存键。
 */
export interface LazyBuiltinMcpServerDefinition extends Record<string, unknown> {
  kind: 'proma-lazy-builtin-mcp'
  name: string
  description: string
  revision?: string
  load: () => Promise<BuiltinMcpServerDefinition>
}

interface ToolOptions {
  annotations?: ToolAnnotations
}

export interface BuiltinMcpToolFactory {
  tool<Shape extends ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    handler: (args: z.infer<ZodObject<Shape>>) => CallToolResult | Promise<CallToolResult>,
    options?: ToolOptions,
  ): BuiltinMcpToolDefinition
  createSdkMcpServer(input: {
    name: string
    version: string
    tools: BuiltinMcpToolDefinition[]
  }): BuiltinMcpServerDefinition
}

export const builtinMcpToolFactory: BuiltinMcpToolFactory = {
  tool(name, description, inputSchema, handler, options) {
    const schema = z.object(inputSchema)
    return {
      name,
      description,
      inputSchema: schema as ZodObject<ZodRawShape>,
      annotations: options?.annotations,
      execute: async (input) => handler(schema.parse(input)),
    }
  },
  createSdkMcpServer(input) {
    return {
      kind: 'proma-builtin-mcp',
      ...input,
    }
  },
}

export function isBuiltinMcpServerDefinition(value: unknown): value is BuiltinMcpServerDefinition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BuiltinMcpServerDefinition>
  return candidate.kind === 'proma-builtin-mcp'
    && typeof candidate.name === 'string'
    && typeof candidate.version === 'string'
    && Array.isArray(candidate.tools)
}

export function isLazyBuiltinMcpServerDefinition(value: unknown): value is LazyBuiltinMcpServerDefinition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LazyBuiltinMcpServerDefinition>
  return candidate.kind === 'proma-lazy-builtin-mcp'
    && typeof candidate.name === 'string'
    && typeof candidate.description === 'string'
    && (candidate.revision === undefined || typeof candidate.revision === 'string')
    && typeof candidate.load === 'function'
}
