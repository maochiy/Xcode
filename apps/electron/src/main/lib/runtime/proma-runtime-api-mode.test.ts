import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@proma/shared'
import { resolvePromaRuntimeApiMode } from './proma-runtime-api-mode'

describe('Proma Runtime 渠道协议映射', () => {
  test('Given 全部 ProviderType When 映射协议 Then 每个供应商都有明确标准协议', () => {
    const providers = [
      'anthropic',
      'anthropic-compatible',
      'openai',
      'openai-responses',
      'deepseek',
      'google',
      'kimi-api',
      'kimi-coding',
      'opencode-go-openai',
      'zhipu',
      'zhipu-coding',
      'zhipu-coding-team',
      'ark-coding-plan',
      'minimax',
      'doubao',
      'qwen',
      'qwen-anthropic',
      'qwen-token-plan',
      'xiaomi',
      'xiaomi-token-plan',
      'openai-codex',
      'custom',
    ] satisfies ProviderType[]

    expect(providers.map(resolvePromaRuntimeApiMode)).toHaveLength(providers.length)
    expect(providers.every((provider) => Boolean(resolvePromaRuntimeApiMode(provider)))).toBe(true)
  })

  test('Given 普通 OpenAI 兼容渠道 When 交给 Pi Runtime Then 使用 Chat Completions 流', () => {
    expect(resolvePromaRuntimeApiMode('openai')).toBe('openai_chat_completions')
    expect(resolvePromaRuntimeApiMode('opencode-go-openai')).toBe('openai_chat_completions')
    expect(resolvePromaRuntimeApiMode('zhipu')).toBe('openai_chat_completions')
    expect(resolvePromaRuntimeApiMode('doubao')).toBe('openai_chat_completions')
    expect(resolvePromaRuntimeApiMode('qwen')).toBe('openai_chat_completions')
    expect(resolvePromaRuntimeApiMode('custom')).toBe('openai_chat_completions')
  })

  test('Given 明确选择 Responses 渠道 When 交给 Pi Runtime Then 才使用 Responses 流', () => {
    expect(resolvePromaRuntimeApiMode('openai-responses')).toBe('openai_responses')
    expect(resolvePromaRuntimeApiMode('openai-codex')).toBe('openai_responses_oauth')
  })

  test('Given Anthropic 或 Google 渠道 When 映射 Then 保留对应原生协议', () => {
    expect(resolvePromaRuntimeApiMode('anthropic')).toBe('anthropic_messages')
    expect(resolvePromaRuntimeApiMode('deepseek')).toBe('anthropic_messages')
    expect(resolvePromaRuntimeApiMode('google')).toBe('google_generative_language')
  })
})
