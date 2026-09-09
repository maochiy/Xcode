import { describe, expect, test } from 'bun:test';
import { installInRunAutoCompaction } from './pi-auto-compaction.mjs';

function createSession() {
  const calls = [];
  const session = {
    agent: {
      prepareNextTurnWithContext: async (turn) => {
        calls.push(['refresh', turn.message]);
        return {
          context: {
            systemPrompt: '刷新后的系统提示词',
            messages: turn.context.messages,
            tools: ['旧工具'],
          },
          model: '旧模型',
          thinkingLevel: 'low',
        };
      },
      state: {
        systemPrompt: '当前系统提示词',
        messages: ['当前消息'],
        tools: ['当前工具'],
        model: '当前模型',
        thinkingLevel: 'high',
      },
    },
    async _checkCompaction(message) {
      calls.push(['compact', message]);
      if (message.usage?.input === 0) {
        this.agent.state.messages = ['压缩后的消息'];
      }
    },
    calls,
  };
  return session;
}

describe('Pi 执行中自动压缩桥接', () => {
  test('Given turn 已结束 When 检查上下文 Then 复用 AgentSession 自动压缩并返回新 transcript', async () => {
    const session = createSession();
    installInRunAutoCompaction(session);

    const message = { role: 'assistant', stopReason: 'stop' };
    const result = await session.agent.prepareNextTurnWithContext({
      message,
      toolResults: [],
      context: {
        systemPrompt: '旧系统提示词',
        messages: ['旧消息'],
        tools: ['旧工具'],
      },
      newMessages: [message],
    });

    expect(session.calls.map(([name]) => name)).toEqual(['refresh', 'compact', 'compact']);
    expect(result.context.messages).toEqual(['压缩后的消息']);
    expect(result.context.systemPrompt).toBe('当前系统提示词');
    expect(result.context.tools).toEqual(['当前工具']);
    expect(result.model).toBe('当前模型');
    expect(result.thinkingLevel).toBe('high');
  });

  test('Given Pi 已有 prepareNextTurnWithContext When 安装压缩桥接 Then 保留原有刷新逻辑', async () => {
    const session = createSession();
    installInRunAutoCompaction(session);

    const result = await session.agent.prepareNextTurnWithContext({
      message: { role: 'assistant' },
      toolResults: [],
      context: {
        systemPrompt: '旧系统提示词',
        messages: ['旧消息'],
        tools: ['旧工具'],
      },
      newMessages: [],
    });

    expect(result.context).toEqual({
      systemPrompt: '当前系统提示词',
      messages: ['压缩后的消息'],
      tools: ['当前工具'],
    });
  });
});
