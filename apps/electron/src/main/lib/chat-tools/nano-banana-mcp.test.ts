import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { builtinMcpToolFactory, isBuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'

let enabled = true
let credentials: Record<string, string> = { apiKey: 'isolated-test-key' }

mock.module('../chat-tool-config', () => ({
  getToolState: () => ({ enabled }),
  getToolCredentials: () => credentials,
}))

mock.module('../attachment-service', () => ({
  saveAttachment: () => {
    throw new Error('禁用状态不应保存附件')
  },
  isImageAttachment: () => true,
}))

const { injectNanoBananaMcpServer } = await import('./nano-banana-mcp')

const originalFetch = globalThis.fetch
let fetchCalls = 0

beforeEach(() => {
  enabled = true
  credentials = { apiKey: 'isolated-test-key' }
  fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('禁用状态不应发起网络请求')
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Nano Banana MCP 动态可用性', () => {
  test('Given 工具定义已缓存 When Chat 工具随后禁用 Then 返回 isError 且不发起网络请求', async () => {
    const tool = await createCachedGenerateImageTool()
    enabled = false

    const result = await tool.execute({ prompt: 'should not run' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('已禁用或未配置 API Key')
    expect(fetchCalls).toBe(0)
  })

  test('Given 工具定义已缓存 When API Key 随后被移除 Then 返回 isError 且不发起网络请求', async () => {
    const tool = await createCachedGenerateImageTool()
    credentials = {}

    const result = await tool.execute({ prompt: 'should not run' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('已禁用或未配置 API Key')
    expect(fetchCalls).toBe(0)
  })
})

async function createCachedGenerateImageTool() {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  await injectNanoBananaMcpServer(
    builtinMcpToolFactory,
    mcpServers,
    'isolated-session',
  )
  const server = mcpServers.nano_banana
  if (!isBuiltinMcpServerDefinition(server)) throw new Error('nano_banana MCP 未正确注入')
  const tool = server.tools.find((candidate) => candidate.name === 'generate_image')
  if (!tool) throw new Error('缺少 generate_image 工具')
  return tool
}
