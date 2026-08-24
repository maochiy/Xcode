import { afterEach, describe, expect, test } from 'bun:test';
import { stream as streamChatCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { missingStreamSuffix } from './pi-stream-reconcile.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function model(api) {
  return {
    id: 'proma-test-model',
    name: 'Proma Test Model',
    api,
    provider: 'proma-test',
    baseUrl: 'https://proma.test/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

function context() {
  return {
    messages: [{
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    }],
  };
}

function sseResponse(events) {
  const body = `${events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')}`;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
    },
  });
}

async function collectEvents(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('Pi 标准 OpenAI 协议流', () => {
  test('Given openai Chat Completions When Pi 发起请求 Then 使用 /chat/completions 且正文和思考在完成前持续增量', async () => {
    let requestPath = '';
    globalThis.fetch = async (input) => {
      requestPath = new URL(input instanceof Request ? input.url : String(input)).pathname;
      return sseResponse([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'proma-test-model',
          choices: [{ index: 0, delta: { reasoning_content: '思' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'proma-test-model',
          choices: [{ index: 0, delta: { reasoning_content: '考' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'proma-test-model',
          choices: [{ index: 0, delta: { content: '正' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'proma-test-model',
          choices: [{ index: 0, delta: { content: '文' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'proma-test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        '[DONE]',
      ]);
    };

    const events = await collectEvents(streamChatCompletions(
      model('openai-completions'),
      context(),
      { apiKey: 'test-key', maxRetries: 0 },
    ));
    const doneIndex = events.findIndex((event) => event.type === 'done');

    expect(requestPath).toBe('/v1/chat/completions');
    expect(events.filter((event) => event.type === 'thinking_delta').map((event) => event.delta)).toEqual(['思', '考']);
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.delta)).toEqual(['正', '文']);
    expect(events.findLastIndex((event) => event.type === 'text_delta')).toBeLessThan(doneIndex);
    expect(events.findLastIndex((event) => event.type === 'thinking_delta')).toBeLessThan(doneIndex);
  });

  test('Given openai Responses When Pi 发起请求 Then 使用 /responses 且标准事件持续增量', async () => {
    let requestPath = '';
    globalThis.fetch = async (input) => {
      requestPath = new URL(input instanceof Request ? input.url : String(input)).pathname;
      return sseResponse([
        { type: 'response.created', response: { id: 'resp-1' } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'reason-1', type: 'reasoning', summary: [], status: 'in_progress' },
        },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'reason-1', summary_index: 0, delta: '思' },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'reason-1', summary_index: 0, delta: '考' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'reason-1',
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: '思考' }],
            status: 'completed',
          },
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { id: 'message-1', type: 'message', role: 'assistant', content: [], status: 'in_progress' },
        },
        { type: 'response.output_text.delta', output_index: 1, item_id: 'message-1', content_index: 0, delta: '正' },
        { type: 'response.output_text.delta', output_index: 1, item_id: 'message-1', content_index: 0, delta: '文' },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '正文', annotations: [] }],
            status: 'completed',
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-1',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 4,
              output_tokens_details: { reasoning_tokens: 2 },
              total_tokens: 5,
            },
          },
        },
      ]);
    };

    const events = await collectEvents(streamResponses(
      model('openai-responses'),
      context(),
      { apiKey: 'test-key', maxRetries: 0 },
    ));
    const doneIndex = events.findIndex((event) => event.type === 'done');

    expect(requestPath).toBe('/v1/responses');
    expect(events.filter((event) => event.type === 'thinking_delta').map((event) => event.delta)).toEqual(['思', '考']);
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.delta)).toEqual(['正', '文']);
    expect(events.findLastIndex((event) => event.type === 'text_delta')).toBeLessThan(doneIndex);
    expect(events.findLastIndex((event) => event.type === 'thinking_delta')).toBeLessThan(doneIndex);
  });

  test('Given Responses 缺少早期 slot 事件 When 终态携带完整正文 Then 最终快照可完整补齐且不重复', async () => {
    globalThis.fetch = async () => sseResponse([
      { type: 'response.created', response: { id: 'resp-2' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'message-2', content_index: 0, delta: '被丢弃的早期增量' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'message-2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '最终完整正文', annotations: [] }],
          status: 'completed',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp-2',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 5,
          },
        },
      },
    ]);

    const events = await collectEvents(streamResponses(
      model('openai-responses'),
      context(),
      { apiKey: 'test-key', maxRetries: 0 },
    ));
    const textDeltas = events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join('');
    const finalText = events
      .filter((event) => event.type === 'text_end')
      .map((event) => event.content)
      .join('');

    expect(textDeltas).toBe('');
    expect(finalText).toBe('最终完整正文');
    expect(missingStreamSuffix(textDeltas, finalText)).toEqual({
      delta: '最终完整正文',
      consistent: true,
    });
  });
});
