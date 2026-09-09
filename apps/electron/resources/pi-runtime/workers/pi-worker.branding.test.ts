import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runtimeDir = join(here, '..')

function readRuntime(relativePath: string): string {
  return readFileSync(join(runtimeDir, relativePath), 'utf8')
}

describe('Proma Pi Runtime 模型可见品牌', () => {
  test('Given Proma 不支持 Gemini Code Assist When 打包 Pi Worker Then 不包含其接口与 CLI 伪装', () => {
    const source = readRuntime('workers/pi-worker.mjs')
    expect(source).not.toContain('gemini-code-assist')
    expect(source).not.toContain('cloudcode-pa.googleapis.com')
    expect(source).not.toContain('GeminiCLI/')
    expect(source).not.toContain('Gemini Code Assist')
  })

  test('Given Pi Worker 系统提示词 When 发给模型 Then 身份是 Proma Agent 而不是 Frakio Work', () => {
    const source = readRuntime('workers/pi-worker.mjs')
    expect(source).toContain('a Proma Agent')
    expect(source).toContain('You are ${agentName}, a Proma Agent.')
    expect(source).not.toContain('Frakio Work')
    expect(source).not.toContain('a Frakio Work Agent')
    expect(source).not.toContain('frakio_')
    expect(source).toContain('proma_memory_search')
    expect(source).toContain("name: message.model.providerName || 'Proma'")
    expect(source).toContain('## 当前运行身份（系统权威信息）')
    expect(source).toContain('message.model.modelId')
    expect(source).toContain('message.model.providerId')
    expect(source).toContain('message.model.apiMode')
    expect(source).toContain('直接返回当前请求对应的实际模型 ID、Provider 和 Runtime')
    expect(source).toContain('不要改写、替换或补充成其他模型名称')
    expect(source).not.toContain('Claude Opus 4.6')
    // 完整快照校正由 Adapter 按 assistant 分段处理，Worker 只转发增量，
    // 避免 steering 后旧 assistant 的缺失尾部被追加到新 assistant。
    expect(source).not.toContain('reconcileEndContent')
    expect(source).toContain('reasoning: finalReasoning')
    expect(source).toContain("'reasoning.delta'")
    expect(source).not.toContain("'reasoning.summary'")
    expect(source).toContain('holder.routeKey !== nextRouteKey')
    expect(source).toContain('sessionId: message.sessionId')
    expect(source).toContain('if (message.compactOnly) {')
    expect(source).toContain('unsubscribe();')
    expect(source).toContain('userName: String(rawProfile.userName || rawProfile.name || \'\')')
    expect(source).toContain('usage.cached_tokens')
  })

  test('Given Bridge fork Worker When 注入 Runtime Binding Then 优先写入 PROMA_PI_*', () => {
    const source = readRuntime('pi-bridge.mjs')
    expect(source).toContain('PROMA_PI_RUNTIME_ROOT')
    expect(source).toContain('PROMA_PI_RUNTIME_VERSION')
    expect(source).toContain('PROMA_PI_RUNTIME_BUILD_ID')
    expect(source).toContain('PROMA_PI_HOST_PROTOCOL_VERSION')
    expect(source).toContain('runtimeBindingEnv(runtimeBinding)')
    expect(source).not.toContain('Frakio Work')
  })

  test('Given Pi 原生消息边界 When 转发事件 Then 使用稳定身份的 transcript 而非累计整轮分段', () => {
    const source = readRuntime('workers/pi-worker.mjs')
    const transcript = readRuntime('workers/pi-transcript.mjs')
    expect(source).toContain('transcript.handle(event)')
    expect(source).toContain("type: 'transcript.message'")
    expect(transcript).toContain('session.agent.steer(message)')
    expect(transcript).toContain('_promaMessageUuid')
    expect(source).not.toContain("type: 'run.turn.started'")
  })

  test('Given 模型只结束 reasoning When 尚无最终正文 Then 使用隐藏消息有限续写', () => {
    const source = readRuntime('workers/pi-worker.mjs')
    expect(source).toContain('reasoningOnlyContinuationDecision')
    expect(source).toContain("customType: 'proma_internal_continuation'")
    expect(source).toContain('display: false')
    expect(source).toContain("{ deliverAs: 'followUp' }")
    expect(source).not.toContain('{ triggerTurn: true }')
    expect(source).toContain("'run.reasoning_only_continuation'")
    expect(source).toContain("reasoningOnlyDecision.action === 'fail' && !publishedArtifact")
  })

  test('Given Context Packet V2 When 写入 receipt Then deliveryMode 为 proma_full', () => {
    const source = readRuntime('thread-context-v2.mjs')
    expect(source).toContain("deliveryMode: 'proma_full'")
    expect(source).not.toContain("deliveryMode: 'frakio_full'")
  })
})
