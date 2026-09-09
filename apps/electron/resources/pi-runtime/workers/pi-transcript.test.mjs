import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiTranscript } from './pi-transcript.mjs';

function setup() {
  const messages = [];
  let sequence = 0;
  const transcript = createPiTranscript('session-1', (message) => messages.push(message), () => `native-${++sequence}`);
  const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
  transcript.handle({ type: 'message_end', message: user('初始上下文') });
  return { transcript, messages, user };
}

test('Given Pi 同一消息 partial/final When 内容校正 Then 原位替换且保留原生消息边界', () => {
  const { transcript, messages } = setup();
  transcript.handle({ type: 'message_start', message: { role: 'assistant' } });
  transcript.handle({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '未完成' }] } });
  const final = { role: 'assistant', content: [{ type: 'text', text: '已校正的完整消息' }] };
  transcript.handle({ type: 'message_end', message: final });
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((message) => message._promaActivityPhase), ['waiting', 'text', 'idle']);
  assert.equal(messages[0].message.content.length, 0);
  assert.equal(messages[0].uuid, messages[1].uuid);
  assert.equal(messages[1].uuid, messages[2].uuid);
  assert.equal(messages[0].message.id, messages[2].message.id);
  assert.equal(messages[2]._partial, undefined);
  assert.equal(messages[2].message.content[0].text, '已校正的完整消息');
  assert.equal(final._promaMessageUuid, messages[2].uuid);
});

test('Given Pi 原生block事件交错推进 When 投影实时快照 Then 严格按当前事件标记阶段且共享UUID', () => {
  const { transcript, messages } = setup();
  const thinking = [{ type: 'thinking', thinking: '分析' }];
  const text = [...thinking, { type: 'text', text: '回答' }];
  const tool = [...text, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'file.ts' } }];

  transcript.handle({ type: 'message_start', message: { role: 'assistant', content: thinking } });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
    assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: thinking },
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '分析' },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: [...thinking, { type: 'text', text: '' }] },
    assistantMessageEvent: { type: 'text_start', contentIndex: 1 },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: [...thinking, { type: 'text', text: '' }] },
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '分析' },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: text },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '回答' },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: [...text, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} }] },
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2 },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: [...text, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} }] },
    assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: '回答' },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: tool },
    assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"file.ts"}' },
  });
  transcript.handle({
    type: 'message_update',
    message: { role: 'assistant', content: tool },
    assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: tool[2] },
  });
  transcript.handle({ type: 'message_end', message: { role: 'assistant', content: tool } });

  assert.deepEqual(messages.map((message) => message._promaActivityPhase), [
    'waiting',
    'thinking',
    'thinking',
    'text',
    'idle',
    'text',
    'tool',
    'idle',
    'tool',
    'idle',
    'idle',
  ]);
  assert.equal(messages[0].message.content.length, 0);
  assert.equal(new Set(messages.map((message) => message.uuid)).size, 1);
  assert.ok(messages.slice(0, -1).every((message) => message._partial === true));
  assert.equal(messages.at(-1)._partial, undefined);
});

test('Given 立即发送在旧回答生成中 When Pi 尚未消费 Then 不提前展示新用户，消费后严格跟随旧回答', async () => {
  const { transcript, messages, user } = setup();
  const queued = [];
  await transcript.enqueue({ agent: { steer: (message) => queued.push(message) } }, '注入后的问题', { uuid: 'queued-1', rawText: '原始问题' });
  assert.deepEqual(messages, []);
  transcript.handle({ type: 'message_start', message: { role: 'assistant' } });
  transcript.handle({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } });
  transcript.handle({ type: 'message_end', message: queued[0] });
  transcript.handle({ type: 'message_start', message: { role: 'assistant' } });
  transcript.handle({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '新回答' }] } });
  assert.deepEqual(
    messages.flatMap((message) => message.message.content[0]?.text || []),
    ['旧回答', '原始问题', '新回答'],
  );
  assert.equal(messages[2].uuid, 'queued-1');
  assert.equal(messages[2]._promaQueuedDuringStreaming, true);
  assert.notEqual(messages[0].uuid, messages[3].uuid);
});

test('Given 连续提交相同内容 When UUID不同 Then 每条真实消息保留，重试同UUID不重复入队', async () => {
  const { transcript, messages, user } = setup();
  const queued = [];
  const session = { agent: { steer: (message) => queued.push(message) } };
  await transcript.enqueue(session, '继续', { uuid: 'first' });
  await transcript.enqueue(session, '继续', { uuid: 'first' });
  await transcript.enqueue(session, '继续', { uuid: 'second' });
  transcript.handle({ type: 'message_end', message: queued[0] });
  transcript.handle({ type: 'message_end', message: queued[1] });
  assert.equal(queued.length, 2);
  assert.deepEqual(messages.map((message) => message.uuid), ['first', 'second']);
});

test('Given 普通等待输入 When 非立即发送 Then 使用 Pi followUp 队列', async () => {
  const { transcript } = setup();
  const delivered = [];
  await transcript.enqueue({ agent: {
    steer: () => assert.fail('不能提前 steering'),
    followUp: (message) => delivered.push(message.content[0].text),
  } }, '后续任务', { interrupt: false });
  assert.deepEqual(delivered, ['后续任务']);
});

test('Given 旧任务尚未完成 When 立即发送新问题 Then 更新模型目标但显示原文，不取消工具或重启会话', async () => {
  const { transcript, messages } = setup();
  let delivered;
  await transcript.enqueue({ agent: {
    steer: (message) => { delivered = message; },
    followUp: () => assert.fail('立即发送不能变为完成旧任务后再跟进'),
    abort: () => assert.fail('不能中断运行中的工具'),
  } }, '你是什么模型', { interrupt: true, uuid: 'new-question' });
  assert.ok(delivered.content[0].text.includes('答完即结束，不自行恢复、补完或汇报旧任务'));
  assert.ok(delivered.content[0].text.endsWith('\n\n你是什么模型'));
  transcript.handle({ type: 'message_end', message: delivered });
  assert.equal(messages[0].message.content[0].text, '你是什么模型');
});

test('Given 用户要求继续原任务 When 立即发送 Then 保留继续任务的明确意图和增强上下文，不污染显示', async () => {
  const { transcript, messages } = setup();
  let delivered;
  await transcript.enqueue({ agent: { steer: (message) => { delivered = message; } } },
    '引用上下文\n继续分析登录流程，只看验证码部分', {
      uuid: 'continue-task',
      interrupt: true,
      rawText: '继续分析登录流程，只看验证码部分',
    });
  assert.ok(delivered.content[0].text.includes('如果新指令明确要求继续、补充或调整原任务，则按新的要求继续'));
  assert.ok(delivered.content[0].text.endsWith('引用上下文\n继续分析登录流程，只看验证码部分'));
  transcript.handle({ type: 'message_end', message: delivered });
  assert.equal(messages[0].message.content[0].text, '继续分析登录流程，只看验证码部分');
});

test('Given 工具调用与完整结果 When Pi结束消息 Then 不额外制造工具气泡或截断结果', () => {
  const { transcript, messages } = setup();
  transcript.handle({ type: 'message_start', message: { role: 'assistant' } });
  transcript.handle({ type: 'message_end', message: { role: 'assistant', content: [
    { type: 'text', text: '开始检查' },
    { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'file.ts' } },
  ] } });
  const output = '完整工具结果'.repeat(1000);
  transcript.handle({ type: 'message_end', message: {
    role: 'toolResult', toolCallId: 'tool-1', content: [{ type: 'text', text: output }],
  } });
  assert.equal(messages.length, 3);
  assert.equal(messages[1].message.content[1].id, messages[2].message.content[0].tool_use_id);
  assert.equal(messages[2].message.content[0].content[0].text, output);
});
