import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapPiHistory } from './pi-history-bootstrap.mjs';

test('Given 旧会话尚无 Pi 原生上下文 When 首次继续 Then 历史只导入一次且不触发额外回合', async () => {
  const calls = [];
  const session = {
    messages: [],
    async sendCustomMessage(message, options) {
      calls.push({ message, options });
      this.messages.push({ role: 'custom', ...message });
    },
  };
  const history = [{ role: 'user', content: '记住项目代号' }, { role: 'assistant', content: '已记录' }];
  await bootstrapPiHistory(session, history);
  await bootstrapPiHistory(session, history);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.display, false);
  assert.equal(calls[0].options.triggerTurn, false);
  assert.ok(calls[0].message.content[0].text.includes('记住项目代号'));
});

test('Given 已恢复 Pi 原生会话或无历史 When 初始化 Then 不添加迁移消息', async () => {
  const session = {
    messages: [{ role: 'user', content: [{ type: 'text', text: '原生记录' }] }],
    async sendCustomMessage() { assert.fail('不应重复导入'); },
  };
  await bootstrapPiHistory(session, [{ role: 'user', content: '旧记录' }]);
  session.messages = [];
  await bootstrapPiHistory(session, []);
  await bootstrapPiHistory(session, [{ role: 'system', content: '非会话记录' }]);
});
