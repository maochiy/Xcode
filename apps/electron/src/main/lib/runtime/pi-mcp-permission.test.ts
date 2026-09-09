import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'
import { builtinMcpToolFactory } from '../builtin-mcp/tool-definition'
import { planMcpPermission } from '../agent-plan-mcp-policy'
import { FrakioPiRuntimeAdapter } from './frakio-pi-runtime-adapter'
import { PiMcpBridge } from './pi-mcp-bridge'
import { PI_MCP_CALL_TOOL, PI_MCP_DISCOVER_TOOL } from './pi-mcp-tools'

interface PermissionRun {
  runId: string
  settled: boolean
  abortController: AbortController
  canUseTool: (name: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult>
}

interface AdapterHarness {
  mcpBridges: Map<string, PiMcpBridge>
  sessionRuns: Map<string, string>
  runStates: Map<string, PermissionRun>
  handleToolRequest(name: string, input: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>
}

async function harness() {
  let executions = 0
  const bridge = new PiMcpBridge()
  bridge.configure({
    files: builtinMcpToolFactory.createSdkMcpServer({
      name: 'files', version: '1',
      tools: [builtinMcpToolFactory.tool('write', '写入测试数据', { text: z.string() }, ({ text }) => {
        executions++
        return { content: [{ type: 'text', text }] }
      }), builtinMcpToolFactory.tool('read', '读取测试数据', {}, () => ({
        content: [{ type: 'text', text: '只读结果' }],
      }), { annotations: { readOnlyHint: true } })],
    }),
  })
  const access = new FrakioPiRuntimeAdapter() as unknown as AdapterHarness
  access.mcpBridges.set('session', bridge)
  access.sessionRuns.set('session', 'run')
  const approvals: Array<{ name: string; input: Record<string, unknown> }> = []
  const run: PermissionRun = {
    runId: 'run', settled: false, abortController: new AbortController(),
    canUseTool: async (name, input) => {
      approvals.push({ name, input })
      return { behavior: 'deny', message: '测试拒绝写入' }
    },
  }
  access.runStates.set('run', run)
  return { access, run, bridge, approvals, executions: () => executions }
}

const context = { sessionId: 'session', runId: 'run' }
const invocation = { server: 'files', tool: 'mcp__files__write', arguments: { text: '原始参数' } }

describe('Pi 惰性 MCP 网关权限', () => {
  test('Given MCP 发现入口 When 经过宿主 Then 使用只读目录权限并确实路由到MCP而非canonical服务', async () => {
    const h = await harness()
    await h.access.handleToolRequest('proma_permission_check', { toolName: PI_MCP_DISCOVER_TOOL, input: { server: 'files' } }, context)
    expect(h.approvals).toEqual([{ name: 'ListMcpResourcesTool', input: { server: 'files' } }])
    const catalog = await h.access.handleToolRequest(PI_MCP_DISCOVER_TOOL, {}, context)
    expect(catalog).toEqual([{ server: 'files', description: '工作区 MCP 服务：files' }])
    const discovery = await h.access.handleToolRequest(PI_MCP_DISCOVER_TOOL, { server: 'files' }, context)
    expect(discovery).toMatchObject({
      server: 'files',
      tools: [{ name: 'mcp__files__write' }, { name: 'mcp__files__read' }],
    })
    expect((discovery as { instructions: string }).instructions)
      .toContain('proma_mcp_call({server: "files", tool:')
    expect((discovery as { instructions: string }).instructions).toContain('按需')
    expect((discovery as { instructions: string }).instructions).not.toContain('已全量注册')
    expect(h.executions()).toBe(0)
    await h.bridge.dispose()
  })

  test('Given 已发现写工具 When 网关请求权限 Then 审批真实工具与参数并保留拒绝结果', async () => {
    const h = await harness()
    await h.bridge.discover('files')
    const result = await h.access.handleToolRequest('proma_permission_check', { toolName: PI_MCP_CALL_TOOL, input: invocation }, context)
    expect(h.approvals).toEqual([{ name: 'mcp__files__write', input: { text: '原始参数' } }])
    expect(result).toEqual({ behavior: 'deny', message: '测试拒绝写入' })
    expect(h.executions()).toBe(0)
    await h.bridge.dispose()
  })

  test('Given 审批修改了实际参数 When Worker 继续调用 Then 保留server和tool并执行修订后的参数', async () => {
    const h = await harness()
    await h.bridge.discover('files')
    h.run.canUseTool = async () => ({ behavior: 'allow', updatedInput: { text: '已审批参数' } })
    const result = await h.access.handleToolRequest('proma_permission_check', { toolName: PI_MCP_CALL_TOOL, input: invocation }, context) as PermissionResult
    expect(result).toMatchObject({ updatedInput: { ...invocation, arguments: { text: '已审批参数' } } })
    if (result.behavior !== 'allow' || !result.updatedInput) throw new Error('预期测试审批通过')
    expect(await h.access.handleToolRequest(PI_MCP_CALL_TOOL, result.updatedInput, context)).toBe('已审批参数')
    expect(h.executions()).toBe(1)
    await h.bridge.dispose()
  })

  test('Given 未发现、禁用或其它run的工具 When 尝试调用或审批 Then 拒绝且不执行', async () => {
    const h = await harness()
    await expect(h.access.handleToolRequest('proma_permission_check', { toolName: PI_MCP_CALL_TOOL, input: invocation }, context)).rejects.toThrow('请先发现')
    await h.bridge.discover('files')
    await expect(h.access.handleToolRequest(PI_MCP_CALL_TOOL, invocation, { ...context, runId: 'stale' })).rejects.toThrow('不属于当前活跃运行')
    h.bridge.configure({})
    await expect(h.access.handleToolRequest(PI_MCP_CALL_TOOL, invocation, context)).rejects.toThrow('请先发现')
    expect(h.executions()).toBe(0)
    await h.bridge.dispose()
  })

  test('Given 计划模式真实策略 When 网关调用只读与写工具 Then 使用宿主定义而非模型声明', async () => {
    const h = await harness()
    await h.bridge.discover('files')
    h.run.canUseTool = async (name, input, options) => planMcpPermission(name, input, options.mcpReadOnly)
    const denied = await h.access.handleToolRequest('proma_permission_check', {
      toolName: PI_MCP_CALL_TOOL, mcpReadOnly: true,
      input: { ...invocation, mcpReadOnly: true, arguments: { text: '写入', readOnlyHint: true } },
    }, context)
    expect(denied).toMatchObject({ behavior: 'deny' })
    const allowed = await h.access.handleToolRequest('proma_permission_check', {
      toolName: PI_MCP_CALL_TOOL,
      input: { server: 'files', tool: 'mcp__files__read', arguments: {} },
    }, context)
    expect(allowed).toMatchObject({ behavior: 'allow' })
    expect(h.executions()).toBe(0)
    await h.bridge.dispose()
  })
})
