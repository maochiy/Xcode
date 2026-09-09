import { describe, expect, test } from 'bun:test';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  MAX_REASONING_ONLY_CONTINUATIONS,
  REASONING_ONLY_CONTINUATION_PROMPT,
  reasoningOnlyContinuationDecision,
} from './pi-reasoning-continuation.mjs';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function assistantMessage(content) {
  return {
    role: 'assistant',
    content,
    api: 'fake',
    provider: 'fake',
    model: 'fake',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function completedStream(message) {
  const stream = (async function* completedEvents() {
    yield { type: 'done', reason: 'stop', usage: EMPTY_USAGE };
  }());
  stream.result = async () => message;
  return stream;
}

describe('Pi reasoning-only 回复续写', () => {
  test('Given 当前 assistant 只有 reasoning When 尚未达到续写上限 Then 继续生成最终正文', () => {
    expect(reasoningOnlyContinuationDecision({
      output: '',
      reasoning: '正在分析问题。',
      stopReason: 'stop',
      attempts: 0,
    })).toEqual({ action: 'continue' });
  });

  test('Given 内部续写已经生成正文 When 判断运行结果 Then 正常完成且不再续写', () => {
    expect(reasoningOnlyContinuationDecision({
      output: '这是最终正文。',
      reasoning: '已经完成分析。',
      stopReason: 'stop',
      attempts: 1,
    })).toEqual({ action: 'complete' });
  });

  test('Given 连续多轮只有 reasoning When 达到续写上限 Then 返回可重试的明确错误', () => {
    expect(reasoningOnlyContinuationDecision({
      output: '',
      reasoning: '仍然只有推理。',
      stopReason: 'stop',
      attempts: MAX_REASONING_ONLY_CONTINUATIONS,
    })).toEqual({
      action: 'fail',
      code: 'PI_REASONING_ONLY_RESPONSE',
      error: '模型已完成推理，但未生成最终正文，请重试。',
    });
  });

  test('Given 响应既没有正文也没有 reasoning When 判断运行结果 Then 保留普通空响应处理', () => {
    expect(reasoningOnlyContinuationDecision({
      output: '',
      reasoning: '',
      stopReason: 'stop',
      attempts: 0,
    })).toEqual({ action: 'complete' });
  });

  test('Given assistant 在 message_end 只有 reasoning When 投递 follow-up Then Pi 在同一个 Agent run 内继续采样正文', async () => {
    let requestCount = 0;
    let agentStartCount = 0;
    let agentEndCount = 0;
    let secondRequestLastMessage = null;
    const agent = new Agent({
      initialState: {
        systemPrompt: '',
        model: {
          id: 'fake',
          name: 'fake',
          api: 'fake',
          provider: 'fake',
          baseUrl: '',
          reasoning: true,
          input: ['text'],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 1000,
          maxTokens: 1000,
        },
        thinkingLevel: 'high',
        tools: [],
        messages: [],
      },
      convertToLlm: (messages) => messages.map((message) => (
        message.role === 'custom'
          ? { role: 'user', content: message.content, timestamp: message.timestamp }
          : message
      )),
      streamFn: async (_model, context) => {
        requestCount += 1;
        if (requestCount === 2) secondRequestLastMessage = context.messages.at(-1);
        return completedStream(requestCount === 1
          ? assistantMessage([{ type: 'thinking', thinking: '分析中。' }])
          : assistantMessage([{ type: 'text', text: '最终正文。' }]));
      },
    });
    agent.subscribe((event) => {
      if (event.type === 'agent_start') agentStartCount += 1;
      if (event.type === 'agent_end') agentEndCount += 1;
      if (
        event.type === 'message_end'
        && event.message?.role === 'assistant'
        && requestCount === 1
      ) {
        agent.followUp({
          role: 'custom',
          customType: 'proma_internal_continuation',
          content: [{ type: 'text', text: REASONING_ONLY_CONTINUATION_PROMPT }],
          display: false,
          timestamp: Date.now(),
        });
      }
    });

    await agent.prompt('处理任务');

    expect(requestCount).toBe(2);
    expect(agentStartCount).toBe(1);
    expect(agentEndCount).toBe(1);
    expect(secondRequestLastMessage).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: REASONING_ONLY_CONTINUATION_PROMPT }],
    });
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '最终正文。' }],
    });
  });
});
