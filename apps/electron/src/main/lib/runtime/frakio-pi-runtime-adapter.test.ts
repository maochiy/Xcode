import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compactionSystemMessage,
  contextCompactionConfigMessage,
  createPiAssistantMessageStream,
  piWorkerModelReasoning,
  piWorkerSessionIdentity,
  resolvePiModelRoute,
  resolvePiWorkerRuntimeBinding,
  resultMessage,
  usageSystemMessage,
} from './frakio-pi-runtime-adapter'

describe('Proma Pi 协议来源', () => {
  test('Given 模型中心明确选择 openai When 解析 Pi 路由 Then 严格使用 Chat Completions', () => {
    const route = resolvePiModelRoute({
      sessionId: 'session-1',
      prompt: 'hello',
      modelRoute: {
        routeRevision: 'route-1',
        runtimeId: 'pi',
        channelId: 'channel-1',
        modelId: 'gpt-test',
        provider: 'openai',
        baseUrl: 'https://gateway.test/v1',
        apiMode: 'openai_chat_completions',
        credentialRevision: 'credential-1',
        capabilities: {},
        source: 'proma-channel',
      },
    }, {})

    expect(route).toEqual({
      provider: 'openai',
      apiMode: 'openai_chat_completions',
      routeRevision: 'route-1',
      credentialRevision: 'credential-1',
    })
  })

  test('Given 旧数据没有 modelRoute 但环境明确 provider When 解析 Then 只按明确 provider 兼容', () => {
    const route = resolvePiModelRoute({
      sessionId: 'session-1',
      prompt: 'hello',
      model: 'legacy-model',
    }, {
      PROMA_RUNTIME_MODEL_PROVIDER: 'openai-responses',
      OPENAI_BASE_URL: 'https://gateway.test/v1',
    })

    expect(route.apiMode).toBe('openai_responses')
  })

  test('Given 缺少 modelRoute 且没有明确 provider When 解析 Then 返回 PI_MODEL_PROTOCOL_MISSING', () => {
    expect(() => resolvePiModelRoute({
      sessionId: 'session-1',
      prompt: 'hello',
      model: 'gpt-looking-name',
    }, {
      OPENAI_BASE_URL: 'https://gateway.test/v1',
      OPENAI_API_KEY: 'secret',
    })).toThrow('Pi 缺少模型中心明确供应商协议')

    try {
      resolvePiModelRoute({ sessionId: 'session-1', prompt: 'hello' }, {})
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('PI_MODEL_PROTOCOL_MISSING')
    }
  })

  test('Given modelRoute 的 provider 与 apiMode 不一致 When 解析 Then 明确拒绝错误路由', () => {
    expect(() => resolvePiModelRoute({
      sessionId: 'session-1',
      prompt: 'hello',
      modelRoute: {
        routeRevision: 'route-1',
        runtimeId: 'pi',
        channelId: 'channel-1',
        modelId: 'gpt-test',
        provider: 'openai',
        baseUrl: 'https://gateway.test/v1',
        apiMode: 'openai_responses',
        credentialRevision: 'credential-1',
        capabilities: {},
        source: 'proma-channel',
      },
    }, {})).toThrow('PI_MODEL_PROTOCOL_MISMATCH')
  })
})

describe('Proma Pi 压缩事件转换', () => {
  test.each(['manual', 'threshold'])('Given %s 无需压缩 When 转换 Then 保留 noop 状态且不创建压缩边界或零 usage', (trigger) => {
    const message = compactionSystemMessage('session-1', 'context.compaction.completed', {
      trigger, noop: true, reason: '当前上下文较少，没有需要压缩的历史内容。',
    })
    expect(message).toMatchObject({
      type: 'system', subtype: 'status', compact_result: 'noop',
      compact_error: '当前上下文较少，没有需要压缩的历史内容。',
    })
    expect(message).not.toHaveProperty('compact_metadata')
    expect(message).not.toHaveProperty('compactionEstimatedTokensAfter')
  })
  test.each(['manual', 'threshold'])('Given %s 压缩被用户停止 When 转换终态 Then 持久化 stopped 而非 failed 或成功边界', (trigger) => {
    expect(compactionSystemMessage('session-1', 'context.compaction.failed', {
      trigger, aborted: true, error: '用户已取消',
    })).toMatchObject({
      type: 'system', subtype: 'status', compact_result: 'stopped', compact_error: '用户已取消',
    })
  })

  test('Given Pi 开始压缩 When 收到 compaction.started Then 转换为 compacting system 消息', () => {
    const message = compactionSystemMessage('session-1', 'context.compaction.started', {
      trigger: 'threshold',
      tokensBefore: 168_000,
    })
    expect(message).toMatchObject({
      type: 'system',
      subtype: 'compacting',
      session_id: 'session-1',
      compactTrigger: 'auto',
      compactPreTokens: 168_000,
    })
  })

  test('Given Pi 手动压缩开始 When 收到 compaction.started Then trigger 为 manual', () => {
    const message = compactionSystemMessage('session-1', 'context.compaction.started', {
      trigger: 'manual',
    })
    expect(message).toMatchObject({
      subtype: 'compacting',
      compactTrigger: 'manual',
    })
  })

  test('Given Pi overflow 自动压缩 When 收到 compaction.started Then trigger 为 auto', () => {
    const message = compactionSystemMessage('session-1', 'context.compaction.started', {
      trigger: 'overflow',
    })
    expect(message).toMatchObject({
      subtype: 'compacting',
      compactTrigger: 'auto',
    })
  })

  test('Given Pi 压缩成功 When 收到 compaction.completed Then 转换为 compact_boundary 并携带元数据', () => {
    const message = compactionSystemMessage('session-1', 'context.compaction.completed', {
      trigger: 'threshold',
      tokensBefore: 168_000,
      tokensAfterEstimate: 24_000,
      summary: '已整理当前任务上下文。',
    })
    expect(message).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      compactTrigger: 'auto',
      compactPreTokens: 168_000,
      compactionEstimatedTokensAfter: 24_000,
      summary: '已整理当前任务上下文。',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 168_000,
        post_tokens: 24_000,
        summary: '已整理当前任务上下文。',
      },
    })
  })

  test('Given Pi 压缩失败 When 收到 compaction.failed Then 转换为 status 并保留错误详情', () => {
    const message = compactionSystemMessage('session-1', 'context.compaction.failed', {
      trigger: 'manual',
      error: '模型调用超时',
    })
    expect(message).toMatchObject({
      type: 'system',
      subtype: 'status',
      compact_result: 'failed',
      compact_error: '模型调用超时',
    })
  })

  test('Given Pi 压缩失败且无错误信息 When 转换 Then 使用兜底文案', () => {
    const message = compactionSystemMessage('session-1', 'context.compaction.failed', {})
    expect(message).toMatchObject({
      compact_result: 'failed',
      compact_error: '上下文压缩失败',
    })
  })
})

describe('Proma Pi Assistant 流分段', () => {
  test('Given 工具调用前已有过程正文 When 工具开始后继续输出最终正文 Then 前后使用不同 assistant 身份', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const processPartial = stream.appendText('先检查项目。')
    const processFinal = stream.flush()
    const finalPartial = stream.appendText('这是最终结论。')

    expect(processFinal?.message.id).toBe(processPartial.message.id)
    expect(finalPartial.message.id).not.toBe(processPartial.message.id)
    expect(stream.output).toBe('先检查项目。这是最终结论。')
  })

  test('Given 助手正文已流式输出 When 自动压缩开始 Then 先固化正文再写压缩边界', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const partial = stream.appendText('最终答复')
    const final = stream.flush()
    const boundary = compactionSystemMessage('session-1', 'context.compaction.started', {
      trigger: 'threshold',
    })

    expect(partial).toMatchObject({
      type: 'assistant',
      _partial: true,
      message: {
        content: [{ type: 'text', text: '最终答复' }],
      },
    })
    expect(final).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '最终答复' }],
      },
    })
    expect((final as { _partial?: boolean })._partial).toBeUndefined()
    expect([final?.type, boundary.type]).toEqual(['assistant', 'system'])
  })

  test('Given 压缩后继续生成 When 新增正文 Then 使用新消息身份且 result 保留完整正文', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const beforeCompaction = stream.appendText('压缩前')
    const firstFinal = stream.flush()
    const afterCompaction = stream.appendText('压缩后')

    expect(firstFinal?.uuid).toBe(beforeCompaction.uuid)
    expect(afterCompaction.uuid).not.toBe(beforeCompaction.uuid)
    expect(stream.output).toBe('压缩前压缩后')
  })

  test('Given 当前回复正在输出 When steering 新消息 Then 新回复使用新的 assistant 身份且总输出不丢失', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const beforeSteering = stream.appendText('旧回复')
    const firstFinal = stream.flush()
    const afterSteering = stream.appendText('新消息的回复')
    const secondFinal = stream.flush()

    expect(firstFinal?.message.id).toBe(beforeSteering.message.id)
    expect(secondFinal?.message.id).toBe(afterSteering.message.id)
    expect(secondFinal?.message.id).not.toBe(firstFinal?.message.id)
    expect(stream.output).toBe('旧回复新消息的回复')
  })

  test('Given steering 后旧 assistant 的最终快照晚到 When 校正整轮正文 Then 缺失尾部回写旧分段而不是新分段', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const oldPartial = stream.appendText('旧回复前半')
    const oldFinal = stream.flush()
    const newPartial = stream.appendText('新消息回复')

    const corrections = stream.reconcileCumulativeText('旧回复前半和后半新消息回复')

    expect(corrections).toHaveLength(1)
    expect(corrections[0]?.uuid).toBe(oldFinal?.uuid)
    expect(corrections[0]?.message.id).toBe(oldPartial.message.id)
    expect(corrections[0]?.message.content).toEqual([
      { type: 'text', text: '旧回复前半和后半' },
    ])
    expect(newPartial.message.content).toEqual([
      { type: 'text', text: '新消息回复' },
    ])
    expect(stream.output).toBe('旧回复前半和后半新消息回复')
  })

  test('Given 流式正文结束 When flush 带 usage Then 终态 assistant 携带 cache 字段', () => {
    const stream = createPiAssistantMessageStream('session-1')
    stream.appendReasoning('先想一步')
    stream.appendText('最终答复')
    const final = stream.flush({
      input_tokens: 400,
      output_tokens: 20,
      cache_read_input_tokens: 12_000,
    })
    expect(final).toMatchObject({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 400,
          output_tokens: 20,
          cache_read_input_tokens: 12_000,
        },
      },
    })
  })

  test('Given 没有正文 delta When completed 携带完整正文 Then 最终快照补齐正文', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const corrected = stream.reconcileText('最终完整正文')
    const final = stream.flush()

    expect(corrected).toMatchObject({
      _partial: true,
      message: { content: [{ type: 'text', text: '最终完整正文' }] },
    })
    expect(final?.uuid).toBe(corrected?.uuid)
    expect(stream.output).toBe('最终完整正文')
  })

  test('Given 正文 delta 只到一半 When completed 携带全文 Then 只形成一个完整 assistant', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const partial = stream.appendText('最终')
    const corrected = stream.reconcileText('最终完整正文')

    expect(corrected?.uuid).toBe(partial.uuid)
    expect(corrected).toMatchObject({
      message: { content: [{ type: 'text', text: '最终完整正文' }] },
    })
    expect(stream.output).toBe('最终完整正文')
  })

  test('Given 正文 delta 与最终快照不一致 When completed Then 相同 UUID 覆盖 partial 而不是拼接', () => {
    const stream = createPiAssistantMessageStream('session-1')
    const partial = stream.appendText('错误的 partial')
    const corrected = stream.reconcileText('最终快照')

    expect(corrected?.uuid).toBe(partial.uuid)
    expect(corrected).toMatchObject({
      message: { content: [{ type: 'text', text: '最终快照' }] },
    })
    expect(stream.output).toBe('最终快照')
  })

  test('Given 正文与思考分别缺失 When completed 携带两个快照 Then 独立校正且不互相覆盖', () => {
    const stream = createPiAssistantMessageStream('session-1')
    stream.appendReasoning('思考前半')
    stream.appendText('正文前半')
    stream.reconcileReasoning('思考前半与后半')
    const corrected = stream.reconcileText('正文最终')

    expect(corrected).toMatchObject({
      message: {
        content: [
          { type: 'thinking', thinking: '思考前半与后半' },
          { type: 'text', text: '正文最终' },
        ],
      },
    })
    expect(stream.reasoning).toBe('思考前半与后半')
    expect(stream.output).toBe('正文最终')
  })
})

describe('Proma Pi usage 事件转换', () => {
  test('Given Pi 上报 usage 与上下文窗口 When 转换 Then 透传 context_window', () => {
    const message = usageSystemMessage('session-1', {
      inputTokens: 12_000,
      outputTokens: 3_000,
      contextWindow: 200_000,
    })
    expect(message).toMatchObject({
      type: 'assistant',
      session_id: 'session-1',
      message: {
        content: [],
        usage: {
          input_tokens: 12_000,
          output_tokens: 3_000,
          context_window: 200_000,
        },
      },
    })
  })

  test('Given Pi 上报无上下文窗口 When 转换 Then usage 不含 context_window', () => {
    const message = usageSystemMessage('session-1', {
      inputTokens: 100,
      outputTokens: 50,
    })
    const usage = (message as { message: { usage: Record<string, unknown> } }).message.usage
    expect(usage.input_tokens).toBe(100)
    expect(usage.output_tokens).toBe(50)
    expect(usage.context_window).toBeUndefined()
  })

  test('Given Pi 上报缓存字段 When 转换 Then 透传 cache_read/cache_creation', () => {
    const message = usageSystemMessage('session-1', {
      inputTokens: 12_000,
      outputTokens: 3_000,
      cacheReadTokens: 88_000,
      cacheWriteTokens: 2_000,
      contextWindow: 200_000,
    })
    expect(message).toMatchObject({
      type: 'assistant',
      session_id: 'session-1',
      message: {
        content: [],
        usage: {
          input_tokens: 12_000,
          output_tokens: 3_000,
          cache_read_input_tokens: 88_000,
          cache_creation_input_tokens: 2_000,
          context_window: 200_000,
        },
      },
    })
  })

  test('Given OpenAI cached_tokens 别名 When 转换 Then 映射为 cache_read', () => {
    const message = usageSystemMessage('session-1', {
      inputTokens: 200,
      outputTokens: 10,
      cached_tokens: 80_000,
    })
    expect(message).toMatchObject({
      message: {
        usage: {
          input_tokens: 200,
          cache_read_input_tokens: 80_000,
        },
      },
    })
  })

  test('Given result 带真实 usage When 结束一轮 Then 不再写死 0', () => {
    const message = resultMessage('session-1', '最终答复', '', {
      input_tokens: 1_200,
      output_tokens: 80,
      cache_read_input_tokens: 90_000,
    })
    expect(message).toMatchObject({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 1_200,
        output_tokens: 80,
        cache_read_input_tokens: 90_000,
      },
    })
  })
})

describe('Proma Pi context_compaction_config 消息', () => {
  test('Given 压缩策略齐全 When 转换 Then 生成可持久化的 config system 消息', () => {
    const message = contextCompactionConfigMessage({
      enabled: true,
      threshold: 160_000,
      contextWindow: 200_000,
    }, 'session-1')
    expect(message).toMatchObject({
      type: 'system',
      subtype: 'context_compaction_config',
      session_id: 'session-1',
      autoCompactEnabled: true,
      autoCompactThreshold: 160_000,
      effectiveContextWindow: 200_000,
    })
  })

  test('Given 压缩未启用 When 转换 Then 返回 undefined', () => {
    expect(contextCompactionConfigMessage({
      enabled: false,
      threshold: 160_000,
      contextWindow: 200_000,
    }, 'session-1')).toBeUndefined()
  })

  test('Given 缺少阈值或窗口 When 转换 Then 返回 undefined', () => {
    expect(contextCompactionConfigMessage({ enabled: true, threshold: 160_000 }, 'session-1')).toBeUndefined()
    expect(contextCompactionConfigMessage({ enabled: true, contextWindow: 200_000 }, 'session-1')).toBeUndefined()
  })
})

describe('Proma Pi Worker 身份', () => {
  test('Given Context Packet 带有用户名 When 构建 Worker 身份 Then 模型可见名称固定为 Proma', () => {
    const identity = piWorkerSessionIdentity({
      contextPacket: { packetId: 'context-1' },
      systemPrompt: '你运行在 Proma 桌面应用中。',
    })
    expect(identity.profileSnapshot).toMatchObject({
      name: 'Proma',
      role: 'Proma Pi 基础内核',
      revision: 'proma',
    })
    expect(identity.profileSnapshot.name).not.toBe('wanglang')
    expect(identity.hostSystemPrompt).toContain('你运行在 Proma 桌面应用中。')
  })

  test('Given 没有 Context Packet When 构建 Worker 身份 Then 仍使用 Proma 作为默认身份', () => {
    const identity = piWorkerSessionIdentity({
      systemPrompt: 'Proma host prompt',
    })
    expect(identity.profileSnapshot.name).toBe('Proma')
    expect(identity.profileSnapshot.revision).toBe('proma')
    expect(identity.hostSystemPrompt).toBe('Proma host prompt')
  })
})

describe('Proma Pi 模型 reasoning',
  () => {
    test('Given 思考档位 high When 注册模型 Then reasoning 为 true', () => {
      expect(piWorkerModelReasoning('high')).toBe(true)
    })

    test('Given 思考档位 off When 注册模型 Then reasoning 为 false', () => {
      expect(piWorkerModelReasoning('off')).toBe(false)
    })

    test('Given 未传档位 When 注册模型 Then 按 medium 打开 reasoning', () => {
      expect(piWorkerModelReasoning(undefined)).toBe(true)
    })
  })


describe('Proma Pi Worker Runtime Binding', () => {
  test('Given PATH/active 声称 0.82.0 When 解析 Worker Binding Then expected 仍来自即将加载的内置 package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-pi-binding-'))
    const packageDir = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '0.80.9',
    }))
    const previousRoot = process.env.PROMA_PI_DEPENDENCY_ROOT
    const previousFrakio = process.env.FRAKIO_PI_RUNTIME_VERSION
    const previousProma = process.env.PROMA_PI_RUNTIME_VERSION
    process.env.PROMA_PI_DEPENDENCY_ROOT = root
    process.env.FRAKIO_PI_RUNTIME_VERSION = '0.82.0'
    process.env.PROMA_PI_RUNTIME_VERSION = '0.82.0'
    try {
      const binding = resolvePiWorkerRuntimeBinding()
      expect(binding.runtimeDir).toBe(root)
      expect(binding.runtimeVersion).toBe('0.80.9')
      expect(binding.runtimeBuildId).toBe('pi-bundled-0.80.9')
    } finally {
      if (previousRoot === undefined) delete process.env.PROMA_PI_DEPENDENCY_ROOT
      else process.env.PROMA_PI_DEPENDENCY_ROOT = previousRoot
      if (previousFrakio === undefined) delete process.env.FRAKIO_PI_RUNTIME_VERSION
      else process.env.FRAKIO_PI_RUNTIME_VERSION = previousFrakio
      if (previousProma === undefined) delete process.env.PROMA_PI_RUNTIME_VERSION
      else process.env.PROMA_PI_RUNTIME_VERSION = previousProma
      rmSync(root, { recursive: true, force: true })
    }
  })
})
