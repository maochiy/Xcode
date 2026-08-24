import { describe, expect, test } from 'bun:test';
import { providerApi } from './pi-provider-api.mjs';

describe('Pi Worker 标准协议注册', () => {
  test('Given 模型中心选择普通 openai When 注册 Pi provider Then 使用 Chat Completions API', () => {
    expect(providerApi('openai_chat_completions')).toBe('openai-completions');
  });

  test('Given 模型中心明确选择 Responses When 注册 Pi provider Then 使用 Responses API', () => {
    expect(providerApi('openai_responses')).toBe('openai-responses');
    expect(providerApi('openai_responses_oauth')).toBe('openai-responses');
  });

  test('Given Anthropic 或 Google 标准协议 When 注册 Pi provider Then 保留对应原生 API', () => {
    expect(providerApi('anthropic_messages')).toBe('anthropic-messages');
    expect(providerApi('google_generative_language')).toBe('google-generative-ai');
  });

  test('Given 缺少明确协议 When 注册 Pi provider Then 拒绝默认猜成 OpenAI', () => {
    expect(() => providerApi('')).toThrow('Unsupported Pi model protocol');
    try {
      providerApi('');
    } catch (error) {
      expect(error.code).toBe('PI_MODEL_PROTOCOL_MISSING');
    }
  });
});
