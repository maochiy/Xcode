import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createLazyBuiltinMcpServerDefinition } from './lazy-definition'
import {
  builtinMcpToolFactory,
  isLazyBuiltinMcpServerDefinition,
} from './tool-definition'

function createTestServer(name = 'test_server') {
  return builtinMcpToolFactory.createSdkMcpServer({
    name,
    version: '1.0.0',
    tools: [
      builtinMcpToolFactory.tool(
        'echo',
        '返回输入',
        { text: z.string() },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      ),
    ],
  })
}

describe('惰性内置 MCP 定义', () => {
  test('Given 轻量描述 When 校验 Then 可识别且不要求立即创建工具', () => {
    const definition = createLazyBuiltinMcpServerDefinition({
      name: 'test_server',
      description: '测试服务',
      revision: 'v1:test',
      load: async () => createTestServer(),
    })

    expect(isLazyBuiltinMcpServerDefinition(definition)).toBe(true)
    expect(definition).toMatchObject({
      kind: 'proma-lazy-builtin-mcp',
      name: 'test_server',
      description: '测试服务',
      revision: 'v1:test',
    })
  })

  test('Given 并发发现与调用 When 同时 load Then 只初始化一次并复用结果', async () => {
    let loadCount = 0
    let finishLoad: (() => void) | undefined
    const loadBarrier = new Promise<void>((resolve) => {
      finishLoad = resolve
    })
    const definition = createLazyBuiltinMcpServerDefinition({
      name: 'test_server',
      description: '测试服务',
      load: async () => {
        loadCount += 1
        await loadBarrier
        return createTestServer()
      },
    })

    const first = definition.load()
    const second = definition.load()
    expect(loadCount).toBe(1)
    finishLoad?.()

    const [firstResult, secondResult] = await Promise.all([first, second])
    const thirdResult = await definition.load()
    expect(firstResult).toBe(secondResult)
    expect(thirdResult).toBe(firstResult)
    expect(loadCount).toBe(1)
  })

  test('Given 首次初始化失败 When 再次 load Then 不吞错且允许重试', async () => {
    let loadCount = 0
    const definition = createLazyBuiltinMcpServerDefinition({
      name: 'test_server',
      description: '测试服务',
      load: async () => {
        loadCount += 1
        if (loadCount === 1) throw new Error('临时初始化失败')
        return createTestServer()
      },
    })

    await expect(definition.load()).rejects.toThrow('临时初始化失败')
    await expect(definition.load()).resolves.toMatchObject({
      kind: 'proma-builtin-mcp',
      name: 'test_server',
    })
    expect(loadCount).toBe(2)
  })
})
