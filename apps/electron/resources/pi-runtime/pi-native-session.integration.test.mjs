import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createPiBridge } from './pi-bridge.mjs';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(runtimeDir, '../../../..');
const workerPath = path.join(runtimeDir, 'workers', 'pi-worker.mjs');
const workerRequirePath = path.resolve(runtimeDir, '../pi-worker-compat.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`等待超时：${description}`);
}

function createEventRecorder(bridge) {
  const events = [];
  bridge.on('event', (message) => events.push(message));
  return {
    events,
    transcript(runId) {
      return events
        .filter((message) =>
          message.runId === runId
          && message.event?.type === 'transcript.message')
        .map((message) => message.event.payload.message);
    },
    async terminal(runId, expectedType = 'run.completed') {
      const message = await waitFor(
        () => events.find((event) =>
          event.runId === runId
          && ['run.completed', 'run.failed', 'run.cancelled'].includes(event.event?.type)),
        `${runId} 结束`,
      );
      assert.equal(
        message.event.type,
        expectedType,
        `Pi 运行结束类型不符：${JSON.stringify(message.event.payload)}`,
      );
      return message;
    },
  };
}

function openAiText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' || block?.type === 'input_text')
    .map((block) => String(block.text || ''))
    .join('');
}

function nativeText(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('');
}

function projectedText(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('');
}

function writeChunk(response, requestIndex, delta, finishReason = null, usage) {
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-local-${requestIndex}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'proma-pi-integration',
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  })}\n\n`);
}

function finishStream(response, requestIndex, finishReason, usage = {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
  }) {
  writeChunk(response, requestIndex, {}, finishReason, usage);
  response.end('data: [DONE]\n\n');
}

async function writeTextResponse(response, requestIndex, text, gate) {
  const splitAt = Math.max(1, Math.floor(text.length / 2));
  writeChunk(response, requestIndex, { content: text.slice(0, splitAt) });
  if (gate) await gate;
  writeChunk(response, requestIndex, { content: text.slice(splitAt) });
  finishStream(response, requestIndex, 'stop');
}

function writeReadToolResponse(response, requestIndex, filePath, usage) {
  writeChunk(response, requestIndex, {
    tool_calls: [{
      index: 0,
      id: 'call-read-fixture',
      type: 'function',
      function: {
        name: 'read',
        arguments: JSON.stringify({ path: filePath }),
      },
    }],
  });
  finishStream(response, requestIndex, 'tool_calls', usage);
}

async function startOpenAiServer(responsePlans) {
  const requests = [];
  const failures = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const index = requests.length;
      requests.push({
        body,
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        remoteAddress: request.socket.remoteAddress,
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      const plan = responsePlans[index];
      if (!plan) throw new Error(`收到非预期的第 ${index + 1} 次模型请求`);
      await plan(response, index);
    })().catch((error) => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    failures,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startLocalOpenAiServer({ fixturePath, firstResponseGate, firstChunkSent }) {
  return startOpenAiServer([
    async (response, index) => {
      writeChunk(response, index, { content: '旧' });
      firstChunkSent.resolve();
      await firstResponseGate.promise;
      writeChunk(response, index, { content: '回答' });
      finishStream(response, index, 'stop');
    },
    async (response, index) => writeTextResponse(response, index, '第一条同文回复'),
    async (response, index) => writeReadToolResponse(response, index, fixturePath),
    async (response, index) => writeTextResponse(response, index, '读取完成'),
    async (response, index) => writeTextResponse(response, index, '跟进完成'),
    async (response, index) => writeTextResponse(response, index, '续聊完成'),
  ]);
}

async function startAbortQueueOpenAiServer({ firstResponseGate, firstChunkSent }) {
  return startOpenAiServer([
    async (response, index) => {
      const connectionClosed = deferred();
      response.once('close', connectionClosed.resolve);
      writeChunk(response, index, { content: '取消前' });
      firstChunkSent.resolve();
      await Promise.race([firstResponseGate.promise, connectionClosed.promise]);
      if (response.destroyed || response.writableEnded) return;
      writeChunk(response, index, { content: '不应完成' });
      finishStream(response, index, 'stop');
    },
    async (response, index) => writeTextResponse(response, index, '干净下一轮'),
    async (response, index) => writeTextResponse(response, index, '不应出现的泄漏回复'),
  ]);
}

function isolatedWorkerEnv(root) {
  const home = path.join(root, 'home');
  const temporary = path.join(root, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GOOGLE_API_KEY: '',
    GEMINI_API_KEY: '',
    PROMA_PI_WORKER_REQUIRE_PATH: workerRequirePath,
  };
}

function runPayload({
  baseUrl,
  cwd,
  agentDir,
  sessionRoot,
  sessionFile,
  historyMessages,
  runId,
  sessionId,
  prompt,
}) {
  return {
    runId,
    sessionId,
    routeRevision: 'integration-route-1',
    credentialRevision: 'integration-credential-1',
    apiMode: 'openai_chat_completions',
    modelId: 'proma-pi-integration',
    runtimeBinding: {
      runtimeId: 'pi',
      runtimeVersion: '0.80.9',
      runtimeBuildId: 'pi-native-session-integration',
      runtimeDir: repositoryRoot,
      adapterProtocolVersion: 1,
    },
    threadId: sessionId,
    cwd,
    agentDir,
    sessionRoot,
    ...(sessionFile ? { sessionFile } : {}),
    ...(historyMessages ? { historyMessages } : {}),
    prompt,
    thinkingLevel: 'off',
    externalTools: [],
    profileSnapshot: {
      name: 'Proma Integration',
      role: '验证真实 Pi 原生会话',
      soul: '只执行测试服务器定义的本地步骤。',
      scope: '只读取测试临时目录。',
    },
    contextPacket: {
      memory: [],
      personalKnowledge: [],
      projectRules: [],
      projectKnowledge: [],
      skills: [],
      dispatchPolicy: { instruction: '仅执行本地集成测试。' },
    },
    model: {
      providerId: 'local-openai',
      providerName: 'Local OpenAI Test',
      modelId: 'proma-pi-integration',
      modelName: 'Proma Pi Integration',
      apiMode: 'openai_chat_completions',
      baseUrl,
      apiKey: 'local-test-key',
      reasoning: false,
      contextWindow: 32_000,
      maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compaction: { enabled: false },
    },
  };
}

test('Given 短会话 When 手动压缩 Then 返回无需压缩且不调用模型或改写上下文', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-compact-noop-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const server = await startOpenAiServer([
    async (response, index) => writeTextResponse(response, index, '简短回答'),
  ]);
  const payload = runPayload({
    baseUrl: server.baseUrl, cwd, agentDir: path.join(root, 'agent'),
    sessionRoot: path.join(root, 'sessions'),
    runId: 'short-history', sessionId: 'short-session', prompt: '简短问题',
  });
  const bridge = createPiBridge({
    workerPath, env: isolatedWorkerEnv(root), runtimeBinding: payload.runtimeBinding,
    toolHandler: async () => { throw new Error('无需压缩测试禁止工具调用'); },
  });
  try {
    const recorder = createEventRecorder(bridge);
    const accepted = await bridge.startRun(payload);
    await recorder.terminal(payload.runId);
    const before = readFileSync(accepted.sessionFile, 'utf8');
    const eventStart = recorder.events.length;
    const result = await bridge.compact(payload.sessionId, { completeRun: true });
    assert.equal(result.result.noop, true);
    const events = recorder.events.slice(eventStart);
    assert.deepEqual(events.map(({ event }) => event.type), [
      'context.compaction.started', 'context.compaction.completed', 'run.completed',
    ]);
    assert.equal(events[1].event.payload.noop, true);
    assert.equal(events[1].event.payload.reason, '当前上下文较少，没有需要压缩的历史内容。');
    assert.equal(readFileSync(accepted.sessionFile, 'utf8'), before);
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.failures, []);
  } finally {
    await bridge.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given Pi 手动压缩正在等待模型 When 停止后重试 Then 保留原上下文且每次仅一个原生压缩终态', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-compact-stop-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const summaryStarted = deferred();
  const summaryClosed = deferred();
  const server = await startOpenAiServer([
    async (response, index) => writeTextResponse(response, index, '历史已接收'),
    async (response, index) => writeTextResponse(response, index, '新一轮已完成'),
    async (response, index) => {
      response.once('close', summaryClosed.resolve);
      writeChunk(response, index, { content: '未完成摘要' });
      summaryStarted.resolve();
      await summaryClosed.promise;
    },
    async (response, index) => writeTextResponse(response, index, '已整理：这是隔离测试的合成上下文。'),
  ]);
  const sessionId = 'manual-compaction-stop';
  const payload = (runId, prompt) => runPayload({
    baseUrl: server.baseUrl, cwd, agentDir: path.join(root, 'agent'),
    sessionRoot: path.join(root, 'sessions'), runId, sessionId, prompt,
  });
  const bridge = createPiBridge({
    workerPath,
    env: isolatedWorkerEnv(root),
    runtimeBinding: payload('unused', '').runtimeBinding,
    toolHandler: async () => { throw new Error('压缩验收禁止工具调用'); },
  });
  try {
    const recorder = createEventRecorder(bridge);
    const accepted = await bridge.startRun(payload('history', '本地合成历史，不含用户数据。'.repeat(12_000)));
    await recorder.terminal('history');
    await bridge.startRun(payload('latest', '本地合成的近期内容。'.repeat(12_000)));
    await recorder.terminal('latest');
    const before = readFileSync(accepted.sessionFile, 'utf8');
    let earlyError;
    const compactResult = bridge.compact(sessionId, { completeRun: true })
      .then(() => undefined, (error) => { earlyError = error; return error; });
    await waitFor(() => {
      if (earlyError) throw earlyError;
      return server.requests.length === 3;
    }, '压缩摘要模型请求');
    await summaryStarted.promise;
    await assert.rejects(bridge.compact(sessionId), /上下文正在压缩/);
    await bridge.cancel(sessionId);
    const error = await compactResult;
    assert.ok(error instanceof Error, '取消压缩不能返回成功');
    await summaryClosed.promise;
    const compactions = recorder.events.filter(({ event }) => event.type.startsWith('context.compaction.'));
    assert.deepEqual(compactions.map(({ event }) => event.type), [
      'context.compaction.started', 'context.compaction.failed',
    ]);
    assert.equal(compactions.at(-1).event.payload.aborted, true);
    assert.equal(recorder.events.at(-1).event.type, 'run.cancelled');
    assert.equal(readFileSync(accepted.sessionFile, 'utf8'), before, '停止不得写入未完成摘要或删除原历史');
    const retryStart = recorder.events.length;
    await bridge.compact(sessionId, { completeRun: true });
    const retryEvents = recorder.events.slice(retryStart).map(({ event }) => event.type);
    assert.deepEqual(retryEvents, [
      'context.compaction.started', 'context.compaction.completed', 'run.completed',
    ]);
    const entries = readFileSync(accepted.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const summaries = entries.filter((entry) => entry.type === 'compaction');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].summary, '已整理：这是隔离测试的合成上下文。');
    const after = readFileSync(accepted.sessionFile, 'utf8');
    const repeated = await bridge.compact(sessionId, { completeRun: true });
    assert.equal(repeated.result.noop, true, '紧接成功压缩再次操作不应报 Already compacted');
    assert.equal(readFileSync(accepted.sessionFile, 'utf8'), after);
    assert.equal(server.requests.length, 4);
    assert.deepEqual(server.failures, []);
  } finally {
    await bridge.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given 小窗口同轮工具结果超过阈值 When 模型尚未继续 Then 自动压缩并保留工具结果继续执行', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-small-window-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const fixturePath = path.join(cwd, 'fixture.txt');
  writeFileSync(fixturePath, 'ISOLATED_TOOL_RESULT\n'.repeat(200));
  const summaryStarted = deferred();
  const summaryGate = deferred();
  const server = await startOpenAiServer([
    async (response, index) => writeTextResponse(response, index, '历史已记录'),
    async (response, index) => writeReadToolResponse(response, index, fixturePath, {
      prompt_tokens: 2_500, completion_tokens: 2, total_tokens: 2_502,
    }),
    async (response, index) => {
      summaryStarted.resolve();
      await summaryGate.promise;
      await writeTextResponse(response, index, '已记录读取文件的目标，继续处理工具结果。');
    },
    async (response, index) => writeTextResponse(response, index, '小窗口压缩后继续完成'),
  ]);
  const payload = runPayload({
    baseUrl: server.baseUrl, cwd, agentDir: path.join(root, 'agent'),
    sessionRoot: path.join(root, 'sessions'), runId: 'small-window-run',
    sessionId: 'small-window-session', prompt: '读取隔离文件并回答。历史背景。'.repeat(300),
  });
  payload.model.contextWindow = 8_000;
  payload.model.compaction = { enabled: true, threshold: 3_000 };
  const bridge = createPiBridge({
    workerPath, env: isolatedWorkerEnv(root), runtimeBinding: payload.runtimeBinding,
    toolHandler: async (name) => {
      assert.equal(name, 'proma_permission_check');
      return { behavior: 'allow' };
    },
  });
  try {
    const recorder = createEventRecorder(bridge);
    const accepted = await bridge.startRun({
      ...payload, runId: 'small-window-history', prompt: '可压缩的历史背景。'.repeat(700),
    });
    await recorder.terminal('small-window-history');
    await bridge.startRun(payload);
    await waitFor(() => server.requests.length === 3, '同一轮工具之后的摘要请求');
    await summaryStarted.promise;
    const started = await waitFor(
      () => recorder.events.find(({ event }) => event.type === 'context.compaction.started'),
      '工具后自动压缩开始事件',
    );
    assert.ok(started, '工具后的请求必须是自动压缩，而不是直接继续原上下文');
    assert.equal(started.event.payload.trigger, 'threshold');
    assert.equal(recorder.events.some((item) =>
      item.runId === payload.runId && item.event.type === 'run.completed'), false);
    await assert.rejects(bridge.compact(payload.sessionId), /上下文正在压缩/);
    summaryGate.resolve();
    const terminal = await recorder.terminal(payload.runId);
    assert.equal(terminal.event.payload.output, '小窗口压缩后继续完成');
    const completed = recorder.events.filter(({ event }) => event.type === 'context.compaction.completed');
    assert.equal(completed.length, 1, '同一个工具结束点只能压缩一次');
    assert.ok(completed[0].event.payload.tokensAfterEstimate > 0);
    assert.equal(recorder.events.some(({ event }) => event.type === 'context.compaction.failed'), false);
    assert.ok(JSON.stringify(server.requests[3].body.messages).includes('ISOLATED_TOOL_RESULT'));
    const entries = readFileSync(accepted.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1);
    assert.equal(server.requests.length, 4);
    assert.deepEqual(server.failures, []);
  } finally {
    summaryGate.resolve();
    await bridge.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given 隔离历史超过原生自动压缩阈值 When 压缩响应延迟 Then 运行等待压缩完成并继续输出有效 usage', {
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-auto-compact-'));
  const cwd = path.join(root, 'workspace');
  const fixturePath = path.join(cwd, 'auto-compaction-fixture.txt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    fixturePath,
    'AUTO_COMPACTION_ISOLATED_FIXTURE\n'.repeat(4_000),
    'utf8',
  );
  const fixtureBody = readFileSync(fixturePath, 'utf8');

  const summaryStarted = deferred();
  const summaryResponseGate = deferred();
  const server = await startOpenAiServer([
    async (response, index) => writeTextResponse(response, index, '第一段隔离历史已记录'),
    async (response, index) => writeTextResponse(response, index, '第二段隔离历史已记录'),
    async (response, index) => {
      writeChunk(response, index, { content: '近期历史已记录' });
      writeChunk(response, index, {}, 'stop', {
        prompt_tokens: 800,
        completion_tokens: 2,
        total_tokens: 802,
      });
      response.end('data: [DONE]\n\n');
    },
    async (response, index) => {
      writeChunk(response, index, { content: '隔离压缩摘要：' });
      summaryStarted.resolve();
      await summaryResponseGate.promise;
      writeChunk(response, index, { content: '保留继续执行所需上下文。' });
      finishStream(response, index, 'stop');
    },
    async (response, index) => writeTextResponse(response, index, '压缩后继续完成'),
  ]);
  const sessionId = 'native-auto-compaction-integration';
  const runId = 'native-auto-compaction-run';
  const basePayload = runPayload({
    baseUrl: server.baseUrl,
    cwd,
    agentDir: path.join(root, 'agent'),
    sessionRoot: path.join(root, 'sessions'),
    runId: 'native-auto-compaction-history-1',
    sessionId,
    prompt: `${fixtureBody}\n第一段隔离历史`,
  });

  let bridge;
  try {
    bridge = createPiBridge({
      workerPath,
      env: isolatedWorkerEnv(root),
      runtimeBinding: basePayload.runtimeBinding,
      toolHandler: async (name) => {
        throw new Error(`自动压缩集成测试禁止执行工具：${name}`);
      },
    });
    const recorder = createEventRecorder(bridge);
    const accepted = await bridge.startRun(basePayload);
    await recorder.terminal(basePayload.runId);
    await bridge.startRun({
      ...basePayload,
      runId: 'native-auto-compaction-history-2',
      sessionFile: accepted.sessionFile,
      prompt: `${fixtureBody}\n第二段隔离历史`,
    });
    await recorder.terminal('native-auto-compaction-history-2');
    await bridge.startRun({
      ...basePayload,
      runId: 'native-auto-compaction-history-3',
      sessionFile: accepted.sessionFile,
      prompt: '近期隔离历史',
    });
    await recorder.terminal('native-auto-compaction-history-3');

    const payload = {
      ...basePayload,
      routeRevision: 'integration-route-auto-compaction',
      runId,
      sessionFile: accepted.sessionFile,
      prompt: '压缩后继续当前隔离问题。',
      model: {
        ...basePayload.model,
        contextWindow: 2_048,
        compaction: {
          enabled: true,
          threshold: 256,
        },
      },
    };
    await bridge.startRun(payload);

    await summaryStarted.promise;
    const compactionStarted = await waitFor(
      () => recorder.events.find((message) =>
        message.runId === runId
        && message.event?.type === 'context.compaction.started'),
      '原生自动压缩开始事件',
    );
    assert.equal(compactionStarted.event.payload.trigger, 'threshold');
    assert.equal(compactionStarted.event.payload.strategy, 'native');
    assert.equal(
      recorder.events.some((message) =>
        message.runId === runId
        && ['context.compaction.completed', 'run.completed'].includes(message.event?.type)),
      false,
      '压缩响应仍被阻塞时不得提前结束压缩或运行',
    );
    assert.equal(server.requests.length, 4, '压缩未完成前不得发起后续模型请求');

    summaryResponseGate.resolve();
    const terminal = await recorder.terminal(runId);
    assert.equal(terminal.event.payload.output, '压缩后继续完成');

    const runEvents = recorder.events.filter((message) => message.runId === runId);
    const eventTypes = runEvents.map((message) => message.event?.type);
    const startedIndex = eventTypes.indexOf('context.compaction.started');
    const completedIndex = eventTypes.indexOf('context.compaction.completed');
    const runCompletedIndex = eventTypes.indexOf('run.completed');
    assert.ok(startedIndex >= 0);
    assert.ok(completedIndex > startedIndex);
    assert.ok(runCompletedIndex > completedIndex);

    const completed = runEvents[completedIndex];
    assert.equal(completed.event.payload.trigger, 'threshold');
    assert.ok(
      completed.event.payload.tokensAfterEstimate > 0,
      `压缩后 token 估算必须大于 0：${JSON.stringify(completed.event.payload)}`,
    );
    const finalOutputIndex = runEvents.findIndex((message) =>
      message.event?.type === 'transcript.message'
      && message.event.payload.message?.type === 'assistant'
      && projectedText(message.event.payload.message).includes('压缩后继续完成'));
    assert.ok(finalOutputIndex > completedIndex, '模型正文必须在自动压缩完成后继续输出');

    const usageAfterCompaction = runEvents
      .slice(completedIndex + 1)
      .find((message) => message.event?.type === 'context.usage.updated');
    assert.ok(usageAfterCompaction, '压缩完成后的后续模型响应必须继续上报 usage');
    assert.ok(usageAfterCompaction.event.payload.totalTokens > 0);
    assert.ok(usageAfterCompaction.event.payload.inputTokens > 0);

    assert.deepEqual(server.failures, []);
    assert.equal(server.requests.length, 5);
    assert.ok(server.requests.every((request) => request.method === 'POST'));
    assert.ok(server.requests.every((request) => request.url === '/v1/chat/completions'));
    assert.ok(server.requests.every((request) => request.authorization === 'Bearer local-test-key'));
    assert.ok(server.requests.every((request) => request.remoteAddress === '127.0.0.1'));
    assert.ok(
      JSON.stringify(server.requests[3].body).includes('AUTO_COMPACTION_ISOLATED_FIXTURE'),
      '原生摘要请求必须来自隔离 fixture 触发的上下文',
    );
    assert.ok(
      JSON.stringify(server.requests[4].body).includes('隔离压缩摘要'),
      '压缩后的后续模型请求必须使用原生摘要继续执行',
    );
  } finally {
    summaryResponseGate.resolve();
    await bridge?.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given 内置 Pi 0.80.9 Worker 与本地 OpenAI SSE When steer、工具、followup、重启续聊 Then 原生 transcript 和 session 文件保持严格消息边界', {
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-native-session-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const sessionRoot = path.join(root, 'sessions');
  const fixturePath = path.join(cwd, 'fixture.txt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(fixturePath, 'PI_NATIVE_READ_BOUNDARY\n', 'utf8');

  const packageManifest = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
    'utf8',
  ));
  assert.equal(packageManifest.version, '0.80.9');

  const firstResponseGate = deferred();
  const firstChunkSent = deferred();
  const localServer = await startLocalOpenAiServer({
    fixturePath,
    firstResponseGate,
    firstChunkSent,
  });
  const workerEnv = isolatedWorkerEnv(root);
  const permissionChecks = [];
  const unexpectedTools = [];
  const sessionId = 'native-session-integration';
  const historyMessages = [
    { role: 'user', content: '迁移历史标记' },
    { role: 'assistant', content: '迁移历史回答' },
  ];
  const toolHandler = async (name, params, context) => {
    if (name !== 'proma_permission_check') {
      unexpectedTools.push({ name, params, context });
      throw new Error(`集成测试禁止执行非权限桥工具：${name}`);
    }
    permissionChecks.push({ params, context });
    const inputPath = path.resolve(String(params.input?.path || ''));
    if (params.toolName !== 'read' || inputPath !== fixturePath) {
      return { behavior: 'deny', message: '只允许读取测试临时文件。' };
    }
    return {
      behavior: 'allow',
      updatedInput: { path: fixturePath },
    };
  };

  let firstBridge;
  let secondBridge;
  try {
    firstBridge = createPiBridge({
      workerPath,
      env: workerEnv,
      runtimeBinding: runPayload({
        baseUrl: localServer.baseUrl,
        cwd,
        agentDir,
        sessionRoot,
        runId: 'unused',
        sessionId,
        prompt: '',
      }).runtimeBinding,
      toolHandler,
    });
    const firstRecorder = createEventRecorder(firstBridge);
    const firstRunId = 'native-run-1';
    const accepted = await firstBridge.startRun(runPayload({
      baseUrl: localServer.baseUrl,
      cwd,
      agentDir,
      sessionRoot,
      runId: firstRunId,
      sessionId,
      historyMessages,
      prompt: '初始问题',
    }));
    assert.ok(accepted.sessionFile);
    assert.ok(path.resolve(accepted.sessionFile).startsWith(path.resolve(sessionRoot)));

    await firstChunkSent.promise;
    await waitFor(
      () => firstRecorder.transcript(firstRunId).find((message) =>
        message.type === 'assistant'
        && message._partial === true
        && projectedText(message) === '旧'),
      '初次 assistant 已输出 partial',
    );

    await firstBridge.steer(sessionId, '相同队列文本', {
      uuid: 'queued-same-a',
      rawText: '相同队列文本-A',
      interrupt: true,
    });
    await firstBridge.steer(sessionId, '相同队列文本', {
      uuid: 'queued-same-b',
      rawText: '相同队列文本-B',
      interrupt: true,
    });
    await firstBridge.steer(sessionId, '等待式跟进', {
      uuid: 'queued-followup',
      rawText: '等待式跟进',
      interrupt: false,
    });
    firstResponseGate.resolve();
    await firstRecorder.terminal(firstRunId);

    const projected = firstRecorder.transcript(firstRunId);
    const finalProjected = projected.filter((message) => message._partial !== true);
    assert.deepEqual(
      finalProjected.map((message) => {
        if (message.type === 'assistant') {
          const tool = message.message.content.find((block) => block.type === 'tool_use');
          return tool ? `assistant:tool:${tool.name}` : `assistant:${projectedText(message)}`;
        }
        const toolResult = message.message.content.find((block) => block.type === 'tool_result');
        return toolResult
          ? `user:tool_result:${toolResult.tool_use_id}`
          : `user:${projectedText(message)}`;
      }),
      [
        'assistant:旧回答',
        'user:相同队列文本-A',
        'assistant:第一条同文回复',
        'user:相同队列文本-B',
        'assistant:tool:read',
        'user:tool_result:call-read-fixture',
        'assistant:读取完成',
        'user:等待式跟进',
        'assistant:跟进完成',
      ],
    );
    assert.deepEqual(
      finalProjected
        .filter((message) => message._promaQueuedDuringStreaming)
        .map((message) => message.uuid),
      ['queued-same-a', 'queued-same-b', 'queued-followup'],
    );
    assert.ok(projected.every((message) =>
      !projectedText(message).includes('迁移历史标记')
      && !projectedText(message).includes('迁移历史回答')),
    '隐藏迁移历史不得投影为可见 user/assistant 事件');
    const toolResult = finalProjected.find((message) =>
      message.type === 'user'
      && message.message.content.some((block) => block.type === 'tool_result'));
    assert.ok(JSON.stringify(toolResult).includes('PI_NATIVE_READ_BOUNDARY'));

    const assistantMessages = projected.filter((message) => message.type === 'assistant');
    const finalAssistantMessages = assistantMessages.filter((message) => message._partial !== true);
    assert.equal(
      new Set(finalAssistantMessages.map((message) => message.uuid)).size,
      finalAssistantMessages.length,
      '每个原生 assistant 只能投影一个 final UUID',
    );
    for (const finalMessage of finalAssistantMessages) {
      const sameMessage = assistantMessages.filter((message) => message.uuid === finalMessage.uuid);
      assert.ok(sameMessage.some((message) => message._partial === true));
      assert.equal(sameMessage.filter((message) => message._partial !== true).length, 1);
      assert.ok(sameMessage.every((message) => message.message.id === finalMessage.uuid));
    }

    assert.equal(permissionChecks.length, 1);
    assert.equal(permissionChecks[0].params.toolName, 'read');
    assert.equal(path.resolve(permissionChecks[0].params.input.path), fixturePath);
    assert.equal(permissionChecks[0].context.sessionId, sessionId);
    assert.equal(permissionChecks[0].context.runId, firstRunId);
    assert.deepEqual(unexpectedTools, []);

    await firstBridge.close();
    firstBridge = null;

    secondBridge = createPiBridge({
      workerPath,
      env: workerEnv,
      runtimeBinding: runPayload({
        baseUrl: localServer.baseUrl,
        cwd,
        agentDir,
        sessionRoot,
        runId: 'unused',
        sessionId,
        prompt: '',
      }).runtimeBinding,
      toolHandler,
    });
    const secondRecorder = createEventRecorder(secondBridge);
    const secondRunId = 'native-run-2';
    const resumed = await secondBridge.startRun(runPayload({
      baseUrl: localServer.baseUrl,
      cwd,
      agentDir,
      sessionRoot,
      sessionFile: accepted.sessionFile,
      runId: secondRunId,
      sessionId,
      historyMessages,
      prompt: '重新启动后的续聊',
    }));
    assert.equal(path.resolve(resumed.sessionFile), path.resolve(accepted.sessionFile));
    await secondRecorder.terminal(secondRunId);
    const resumedTranscript = secondRecorder
      .transcript(secondRunId)
      .filter((message) => message._partial !== true);
    assert.deepEqual(
      resumedTranscript.map((message) => `${message.type}:${projectedText(message)}`),
      ['assistant:续聊完成'],
      '重新打开原生 session 时不得重放旧 transcript',
    );
    assert.ok(resumedTranscript.every((message) =>
      !projectedText(message).includes('迁移历史标记')
      && !projectedText(message).includes('迁移历史回答')),
    '重启时重复传入迁移历史也不得投影为可见事件');

    assert.equal(localServer.failures.length, 0);
    assert.equal(localServer.requests.length, 6);
    assert.ok(localServer.requests.every((request) => request.method === 'POST'));
    assert.ok(localServer.requests.every((request) => request.url === '/v1/chat/completions'));
    assert.ok(localServer.requests.every((request) => request.authorization === 'Bearer local-test-key'));
    assert.ok(localServer.requests.every((request) => request.remoteAddress === '127.0.0.1'));

    const modelRequests = localServer.requests.map((request) => request.body);
    const firstModelContext = JSON.stringify(modelRequests[0].messages);
    assert.ok(firstModelContext.includes('迁移历史标记'));
    assert.ok(firstModelContext.includes('迁移历史回答'));
    assert.equal(
      modelRequests[0].messages.filter((message) =>
        message.role === 'user' && openAiText(message) === '初始问题').length,
      1,
    );
    assert.equal(
      modelRequests[2].messages.filter((message) =>
        message.role === 'user' && openAiText(message).endsWith('\n\n相同队列文本')).length,
      2,
    );
    const steeredContext = modelRequests[1].messages.at(-1);
    assert.equal(steeredContext.role, 'user');
    assert.ok(openAiText(steeredContext).includes('答完即结束，不自行恢复、补完或汇报旧任务'),
      '真实 Pi 模型请求必须传达当前任务更新，不能只把新问题当作旧任务中的插话');
    assert.ok(openAiText(steeredContext).endsWith('\n\n相同队列文本'));
    assert.ok(modelRequests[3].messages.some((message) =>
      message.role === 'tool'
      && message.tool_call_id === 'call-read-fixture'
      && String(message.content).includes('PI_NATIVE_READ_BOUNDARY')));
    assert.equal(
      modelRequests[4].messages.filter((message) =>
        message.role === 'user' && openAiText(message) === '等待式跟进').length,
      1,
    );
    assert.equal(
      modelRequests[5].messages.filter((message) =>
        message.role === 'user' && openAiText(message) === '重新启动后的续聊').length,
      1,
    );
    assert.equal(
      modelRequests[5].messages.filter((message) =>
        message.role === 'user' && openAiText(message).endsWith('\n\n相同队列文本')).length,
      2,
      '续聊请求应从原生 session 文件恢复两条同文 steering，且不得重复',
    );

    const sessionEntries = readFileSync(accepted.sessionFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const sessionMessages = sessionEntries
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message);
    assert.equal(
      new Set(sessionEntries.map((entry) => entry.id).filter(Boolean)).size,
      sessionEntries.filter((entry) => entry.id).length,
      '原生 session entry ID 不得重复',
    );
    const historyBootstrapEntries = sessionEntries.filter((entry) =>
      entry.type === 'custom_message'
      && entry.customType === 'proma_history_bootstrap');
    assert.equal(
      historyBootstrapEntries.length,
      1,
      '重复 startRun 传入相同 historyMessages 不得复制原生历史 bootstrap',
    );
    assert.equal(historyBootstrapEntries[0].display, false);
    assert.ok(JSON.stringify(historyBootstrapEntries[0].content).includes('迁移历史标记'));
    assert.ok(JSON.stringify(historyBootstrapEntries[0].content).includes('迁移历史回答'));
    assert.equal(
      sessionMessages.filter((message) =>
        message.role === 'user' && nativeText(message).endsWith('\n\n相同队列文本')).length,
      2,
    );
    assert.equal(
      sessionMessages.filter((message) =>
        message.role === 'user' && nativeText(message) === '重新启动后的续聊').length,
      1,
    );
    assert.equal(
      sessionMessages.filter((message) => message._promaMessageUuid === 'queued-same-a').length,
      1,
    );
    assert.equal(
      sessionMessages.filter((message) => message._promaMessageUuid === 'queued-same-b').length,
      1,
    );
    assert.equal(
      sessionMessages.filter((message) => message._promaMessageUuid === 'queued-followup').length,
      1,
    );
    assert.equal(
      sessionMessages.filter((message) =>
        message.role === 'toolResult'
        && message.toolCallId === 'call-read-fixture'
        && nativeText(message).includes('PI_NATIVE_READ_BOUNDARY')).length,
      1,
    );
  } finally {
    firstResponseGate.resolve();
    await secondBridge?.close().catch(() => {});
    await firstBridge?.close().catch(() => {});
    await localServer.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given 流式输出期间存在未消费 followup When abort 后开始下一轮 Then Pi 原生队列不会偷偷重放', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-abort-queue-'));
  const cwd = path.join(root, 'workspace');
  const agentDir = path.join(root, 'agent');
  const sessionRoot = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });

  const firstResponseGate = deferred();
  const firstChunkSent = deferred();
  const localServer = await startAbortQueueOpenAiServer({
    firstResponseGate,
    firstChunkSent,
  });
  const workerEnv = isolatedWorkerEnv(root);
  const sessionId = 'native-abort-queue-integration';
  let bridge;
  try {
    bridge = createPiBridge({
      workerPath,
      env: workerEnv,
      runtimeBinding: runPayload({
        baseUrl: localServer.baseUrl,
        cwd,
        agentDir,
        sessionRoot,
        runId: 'unused',
        sessionId,
        prompt: '',
      }).runtimeBinding,
      toolHandler: async (name) => {
        throw new Error(`abort 队列测试禁止执行工具：${name}`);
      },
    });
    const recorder = createEventRecorder(bridge);
    const abortedRunId = 'native-abort-run-1';
    const accepted = await bridge.startRun(runPayload({
      baseUrl: localServer.baseUrl,
      cwd,
      agentDir,
      sessionRoot,
      runId: abortedRunId,
      sessionId,
      prompt: '取消前问题',
    }));

    await firstChunkSent.promise;
    await waitFor(
      () => recorder.transcript(abortedRunId).find((message) =>
        message.type === 'assistant'
        && message._partial === true
        && projectedText(message) === '取消前'),
      'abort 前 assistant 已输出 partial',
    );
    await bridge.steer(sessionId, '不应进入下一轮的消息', {
      uuid: 'abort-restored-followup',
      rawText: '不应进入下一轮的消息',
      interrupt: false,
    });
    await bridge.cancel(sessionId);
    await recorder.terminal(abortedRunId, 'run.cancelled');

    const nextRunId = 'native-abort-run-2';
    const resumed = await bridge.startRun(runPayload({
      baseUrl: localServer.baseUrl,
      cwd,
      agentDir,
      sessionRoot,
      sessionFile: accepted.sessionFile,
      runId: nextRunId,
      sessionId,
      prompt: '取消后的新问题',
    }));
    assert.equal(path.resolve(resumed.sessionFile), path.resolve(accepted.sessionFile));
    await recorder.terminal(nextRunId);

    const nextTranscript = recorder
      .transcript(nextRunId)
      .filter((message) => message._partial !== true);
    assert.deepEqual(
      nextTranscript.map((message) => `${message.type}:${projectedText(message)}`),
      ['assistant:干净下一轮'],
    );
    assert.ok(nextTranscript.every((message) =>
      message.uuid !== 'abort-restored-followup'
      && message._promaMessageUuid !== 'abort-restored-followup'
      && projectedText(message) !== '不应进入下一轮的消息'));

    assert.equal(localServer.failures.length, 0);
    assert.equal(localServer.requests.length, 2, '未消费 followup 不得触发下一轮额外模型请求');
    assert.ok(localServer.requests.every((request) => request.method === 'POST'));
    assert.ok(localServer.requests.every((request) => request.url === '/v1/chat/completions'));
    assert.ok(localServer.requests.every((request) => request.authorization === 'Bearer local-test-key'));
    assert.ok(localServer.requests.every((request) => request.remoteAddress === '127.0.0.1'));
    assert.ok(localServer.requests[1].body.messages.some((message) =>
      message.role === 'user' && openAiText(message) === '取消后的新问题'));
    assert.ok(localServer.requests.slice(1).every((request) =>
      request.body.messages.every((message) =>
        openAiText(message) !== '不应进入下一轮的消息')));

    const sessionEntries = readFileSync(accepted.sessionFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const sessionMessages = sessionEntries
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message);
    assert.equal(
      sessionMessages.filter((message) =>
        message._promaMessageUuid === 'abort-restored-followup'
        || nativeText(message) === '不应进入下一轮的消息').length,
      0,
      'abort 前未消费的原生 followup 不得写入 session 文件',
    );
    assert.equal(
      sessionMessages.filter((message) =>
        message.role === 'user' && nativeText(message) === '取消后的新问题').length,
      1,
    );
  } finally {
    firstResponseGate.resolve();
    await bridge?.close().catch(() => {});
    await localServer.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

function writeNamedToolResponse(response, requestIndex, name, args) {
  writeChunk(response, requestIndex, {
    tool_calls: [{ index: 0, id: `lazy-call-${requestIndex}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  finishStream(response, requestIndex, 'tool_calls');
}

test('Given Pi 模型需要用户登录 When 调用 AskUserQuestion Then 工具真实暴露并等待宿主回答后继续', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-ask-user-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const askRequested = deferred();
  const answerGate = deferred();
  const questions = [{
    question: '请完成网页登录后继续',
    header: '需要登录',
    options: [{ label: '已完成', description: '已在内置浏览器完成登录' }],
    multiSelect: false,
  }];
  const server = await startOpenAiServer([
    async (response, index) => writeNamedToolResponse(
      response,
      index,
      'AskUserQuestion',
      { questions },
    ),
    async (response, index) => writeTextResponse(response, index, '已收到用户回答并继续执行'),
  ]);
  const payload = runPayload({
    baseUrl: server.baseUrl,
    cwd,
    agentDir: path.join(root, 'agent'),
    sessionRoot: path.join(root, 'sessions'),
    runId: 'ask-user-run',
    sessionId: 'ask-user-session',
    prompt: '需要用户登录后继续。',
  });
  const permissionChecks = [];
  const bridge = createPiBridge({
    workerPath,
    env: isolatedWorkerEnv(root),
    runtimeBinding: payload.runtimeBinding,
    toolHandler: async (name, params, context) => {
      assert.equal(name, 'proma_permission_check');
      assert.equal(context.sessionId, payload.sessionId);
      assert.equal(params.toolName, 'AskUserQuestion');
      assert.deepEqual(params.input, { questions });
      permissionChecks.push(params);
      askRequested.resolve();
      await answerGate.promise;
      return {
        behavior: 'allow',
        updatedInput: {
          ...params.input,
          answers: { '请完成网页登录后继续': '已完成' },
        },
      };
    },
  });

  try {
    const recorder = createEventRecorder(bridge);
    await bridge.startRun(payload);
    await askRequested.promise;

    const exposedTool = server.requests[0].body.tools.find((tool) =>
      tool?.function?.name === 'AskUserQuestion');
    assert.ok(exposedTool, 'Pi 首次模型请求必须真实暴露 AskUserQuestion');
    assert.deepEqual(exposedTool.function.parameters.required, ['questions']);
    assert.equal(server.requests.length, 1, '用户回答前不得继续下一次模型请求');
    assert.equal(
      recorder.events.some(({ event }) =>
        ['run.completed', 'run.failed', 'run.cancelled'].includes(event?.type)),
      false,
      '等待用户期间运行不得提前结束',
    );

    answerGate.resolve();
    const terminal = await recorder.terminal(payload.runId);
    assert.equal(terminal.event.payload.output, '已收到用户回答并继续执行');
    assert.equal(permissionChecks.length, 1);
    assert.equal(server.requests.length, 2);
    assert.ok(
      JSON.stringify(server.requests[1].body.messages)
        .includes('请完成网页登录后继续'),
      '回答后续模型请求必须包含 AskUserQuestion 工具结果',
    );
    assert.ok(
      JSON.stringify(server.requests[1].body.messages).includes('已完成'),
      'AskUserQuestion 工具结果必须包含用户答案',
    );
    assert.deepEqual(server.failures, []);
  } finally {
    answerGate.resolve();
    await bridge.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given Pi 正在等待用户回答 When 取消运行且宿主尚未返回 Then 立即结束等待且迟到回答不重启运行', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-ask-user-cancel-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const askRequested = deferred();
  const answerGate = deferred();
  const server = await startOpenAiServer([
    async (response, index) => writeNamedToolResponse(response, index, 'AskUserQuestion', {
      questions: [{ question: '请完成登录', options: [{ label: '已完成' }] }],
    }),
  ]);
  const payload = runPayload({
    baseUrl: server.baseUrl,
    cwd,
    agentDir: path.join(root, 'agent'),
    sessionRoot: path.join(root, 'sessions'),
    runId: 'ask-user-cancel-run',
    sessionId: 'ask-user-cancel-session',
    prompt: '等待用户登录。',
  });
  const bridge = createPiBridge({
    workerPath,
    env: isolatedWorkerEnv(root),
    runtimeBinding: payload.runtimeBinding,
    toolHandler: async () => {
      askRequested.resolve();
      await answerGate.promise;
      return { behavior: 'allow', updatedInput: { answers: { 请完成登录: '已完成' } } };
    },
  });

  try {
    const recorder = createEventRecorder(bridge);
    await bridge.startRun(payload);
    await askRequested.promise;
    let cancelled = false;
    let cancelError;
    void bridge.cancel(payload.sessionId)
      .then(() => { cancelled = true })
      .catch((error) => { cancelError = error; cancelled = true });
    await waitFor(() => cancelled, '取消用户等待不依赖宿主回答', 3_000);
    assert.equal(cancelError, undefined);
    await recorder.terminal(payload.runId, 'run.cancelled');

    answerGate.resolve();
    await sleep(150);
    assert.equal(server.requests.length, 1, '取消后迟到的回答不得继续请求模型');
    assert.equal(recorder.events.filter(({ event }) => event?.type === 'run.completed').length, 0);
    assert.deepEqual(server.failures, []);
  } finally {
    answerGate.resolve();
    await bridge.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given 已发现 WebFetch When Pi 直接调用 Then 使用真实 schema 和网关审批执行且配置失效后撤销', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-mcp-alias-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const toolName = 'mcp__web_search__WebFetch';
  const group = {
    server: 'web_search',
    tools: [{
      name: toolName, description: 'ALIAS_SCHEMA_AFTER_DISCOVERY',
      parameters: {
        type: 'object', properties: { url: { type: 'string' } }, required: ['url'],
      },
    }],
  };
  const calls = [];
  const approvals = [];
  const server = await startOpenAiServer([
    async (response, index) => writeNamedToolResponse(response, index, 'proma_mcp_discover', { server: 'web_search' }),
    async (response, index) => {
      // 复现同一模型回复中直接使用发现结果的名称；包含拒绝及无效参数，不能绕过审批。
      writeChunk(response, index, {
        tool_calls: [
          { url: 'https://example.test/first' },
          { url: 'https://example.test/denied' },
          {},
        ].map((args, callIndex) => ({
          index: callIndex, id: `direct-${callIndex}`, type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        })),
      });
      finishStream(response, index, 'tool_calls');
    },
    async (response, index) => writeTextResponse(response, index, '兼容调用完成'),
    async (response, index) => writeNamedToolResponse(response, index, toolName, { url: 'https://example.test/continued' }),
    async (response, index) => writeTextResponse(response, index, '续聊调用完成'),
    async (response, index) => writeNamedToolResponse(response, index, toolName, { url: 'https://example.test/stale' }),
    async (response, index) => writeTextResponse(response, index, '失效工具未执行'),
  ]);
  const payload = runPayload({
    baseUrl: server.baseUrl, cwd, agentDir: path.join(root, 'agent'),
    sessionRoot: path.join(root, 'sessions'), runId: 'alias-first',
    sessionId: 'alias-session', prompt: '验证网页工具调用；只能执行隔离模拟工具。',
  });
  payload.mcpCatalog = [{ server: 'web_search', description: '隔离网页工具' }];
  payload.externalTools = [
    { name: 'proma_mcp_discover', parameters: { type: 'object', properties: { server: { type: 'string' } } } },
    { name: 'proma_mcp_call', parameters: {
      type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } },
      required: ['server', 'tool', 'arguments'],
    } },
  ];
  const bridge = createPiBridge({
    workerPath, env: isolatedWorkerEnv(root), runtimeBinding: payload.runtimeBinding,
    toolHandler: async (name, params, context) => {
      assert.equal(context.sessionId, payload.sessionId);
      if (name === 'proma_permission_check') {
        approvals.push(params);
        if (params.toolName === 'proma_mcp_discover') return { behavior: 'allow' };
        assert.equal(params.toolName, 'proma_mcp_call', '别名不能绕过真实 MCP 审批路径');
        assert.equal(params.input.tool, toolName);
        assert.equal(params.input.server, 'web_search');
        if (params.input.arguments.url.endsWith('/denied')) {
          return { behavior: 'deny', message: '隔离审批拒绝' };
        }
        return { behavior: 'allow', updatedInput: {
          ...params.input, arguments: { url: `${params.input.arguments.url}/approved` },
        } };
      }
      if (name === 'proma_mcp_discover') return { ...group, instructions: '优先使用 proma_mcp_call。' };
      assert.equal(name, 'proma_mcp_call');
      assert.equal(params.server, group.server);
      assert.equal(params.tool, toolName);
      assert.ok(params.arguments.url.endsWith('/approved'));
      calls.push({ ...params, runId: context.runId });
      return { content: [{ type: 'text', text: 'ISOLATED_FETCH_OK' }] };
    },
  });
  try {
    const recorder = createEventRecorder(bridge);
    await bridge.startRun(payload);
    await recorder.terminal(payload.runId);
    const toolNames = (index) => server.requests[index].body.tools.map((tool) => tool.function.name);
    assert.equal(toolNames(0).includes(toolName), false, '发现前不得提前注入 MCP schema');
    assert.ok(toolNames(1).includes(toolName), '发现后下一次请求必须能实际调用返回的名称');
    const results = recorder.transcript(payload.runId)
      .flatMap((message) => message.message?.content || [])
      .filter((block) => block.type === 'tool_result');
    assert.ok(results.some((result) => result.tool_use_id === 'direct-0' && !result.is_error));
    assert.ok(results.some((result) => result.tool_use_id === 'direct-1' && result.is_error));
    assert.ok(results.some((result) => result.tool_use_id === 'direct-2' && result.is_error));
    assert.equal(JSON.stringify(results).includes(`Tool ${toolName} not found`), false);
    assert.equal(calls.length, 1);
    assert.equal(approvals.length, 3, '无效参数须在 Pi 校验阶段拒绝，不能进入宿主执行');
    await bridge.startRun({ ...payload, runId: 'alias-continued', mcpDiscoveredTools: [group] });
    await recorder.terminal('alias-continued');
    assert.ok(toolNames(3).includes(toolName));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].runId, 'alias-continued', '别名不能持有上一轮 runId');
    await bridge.startRun({ ...payload, runId: 'alias-revoked', mcpDiscoveredTools: [] });
    await recorder.terminal('alias-revoked');
    assert.equal(toolNames(5).includes(toolName), false);
    assert.equal(calls.length, 2, '配置失效后不能执行历史别名');
    assert.equal(server.requests.length, 7);
    assert.deepEqual(server.failures, []);
  } finally {
    await bridge.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('Given Skills与MCP能力目录 When 普通聊天后按需读取和发现调用 Then 首轮无正文且真实Pi工具循环正确加载', { timeout: 45_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proma-pi-lazy-'));
  const cwd = path.join(root, 'workspace');
  const skillFile = path.join(cwd, 'skills', 'writing', 'SKILL.md');
  mkdirSync(path.dirname(skillFile), { recursive: true });
  const skillBody = 'LAZY_SKILL_BODY_ONLY_AFTER_READ\n调用搜索服务完成测试。';
  writeFileSync(skillFile, skillBody);
  const server = await startOpenAiServer([
    async (response, index) => writeTextResponse(response, index, '你好'),
    async (response, index) => writeReadToolResponse(response, index, skillFile),
    async (response, index) => writeNamedToolResponse(response, index, 'proma_mcp_discover', { server: 'search' }),
    async (response, index) => writeNamedToolResponse(response, index, 'proma_mcp_call', { server: 'search', tool: 'mcp__search__find', arguments: { query: 'pi' } }),
    async (response, index) => writeTextResponse(response, index, '按需加载完成'),
  ]);
  let loads = 0;
  let calls = 0;
  const permissionChecks = [];
  let bridge;
  try {
    const payload = runPayload({
      baseUrl: server.baseUrl, cwd, agentDir: path.join(root, 'agent'), sessionRoot: path.join(root, 'sessions'),
      runId: 'lazy-first', sessionId: 'lazy-session', prompt: '你好',
    });
    payload.contextPacket.skills = [{ name: 'writing', description: '写作时使用', path: skillFile, content: skillBody }];
    payload.mcpCatalog = [{ server: 'search', description: '按需搜索' }];
    payload.externalTools = [
      { name: 'proma_mcp_discover', description: '按需发现服务', parameters: { type: 'object', properties: { server: { type: 'string' } } } },
      { name: 'proma_mcp_call', description: '调用已发现工具', parameters: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['server', 'tool', 'arguments'] } },
    ];
    bridge = createPiBridge({
      workerPath, env: isolatedWorkerEnv(root), runtimeBinding: payload.runtimeBinding,
      toolHandler: async (name, params, context) => {
        assert.equal(context.sessionId, 'lazy-session');
        assert.equal(context.runId, 'lazy-second');
        if (name === 'proma_permission_check') {
          permissionChecks.push(params.toolName);
          if (params.toolName === 'read') assert.equal(params.input.path, skillFile);
          else assert(['proma_mcp_discover', 'proma_mcp_call'].includes(params.toolName));
          return { behavior: 'allow', updatedInput: params.input };
        }
        if (name === 'proma_mcp_discover') {
          assert.equal(params.server, 'search');
          loads++;
          return {
            server: 'search', instructions: '使用 proma_mcp_call 调用。',
            tools: [{ name: 'mcp__search__find', description: 'LAZY_TOOL_SCHEMA_ONLY_AFTER_DISCOVERY', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
          };
        }
        assert.equal(name, 'proma_mcp_call');
        assert.equal(loads, 1);
        assert.deepEqual(params, { server: 'search', tool: 'mcp__search__find', arguments: { query: 'pi' } });
        calls++;
        return 'LAZY_MCP_RESULT';
      },
    });
    const recorder = createEventRecorder(bridge);
    await bridge.startRun(payload);
    await recorder.terminal('lazy-first');
    assert.equal(loads, 0);
    assert.equal(calls, 0);
    assert.equal(permissionChecks.length, 0);
    const firstRequest = JSON.stringify(server.requests[0].body);
    assert(!firstRequest.includes(skillBody));
    assert(!firstRequest.includes('LAZY_TOOL_SCHEMA_ONLY_AFTER_DISCOVERY'));
    assert(firstRequest.includes(skillFile));
    assert(firstRequest.includes('proma_mcp_discover'));
    await bridge.startRun({ ...payload, runId: 'lazy-second', prompt: '现在使用写作技能和搜索' });
    await recorder.terminal('lazy-second');
    assert.equal(loads, 1);
    assert.equal(calls, 1);
    assert.deepEqual(permissionChecks, ['read', 'proma_mcp_discover', 'proma_mcp_call']);
    assert(JSON.stringify(server.requests[2].body).includes('LAZY_SKILL_BODY_ONLY_AFTER_READ'));
    assert(JSON.stringify(server.requests[3].body).includes('LAZY_TOOL_SCHEMA_ONLY_AFTER_DISCOVERY'));
    assert(JSON.stringify(server.requests[4].body).includes('LAZY_MCP_RESULT'));
    assert.equal(server.failures.length, 0);
  } finally {
    await bridge?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
