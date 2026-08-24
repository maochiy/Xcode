import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createPiBridgePool } from './pi-bridge.mjs';

function createClock() {
  let current = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) {
      const id = ++sequence;
      timers.set(id, { at: current + delay, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const target = current + ms;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        current = next[1].at;
        next[1].callback();
        await Promise.resolve();
      }
      current = target;
      await Promise.resolve();
    },
  };
}

function createFakeBridgeFactory() {
  const created = [];
  const disposedSessions = [];
  const closedBuilds = [];
  const factory = ({ runtimeBinding, toolHandler }) => {
    const emitter = new EventEmitter();
    const bridge = {
      runtimeBinding,
      toolHandler,
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      inspect: async () => ({ ready: true }),
      startRun: async (payload) => ({
        sessionId: payload.sessionId,
        sessionFile: `/tmp/${payload.sessionId}.jsonl`,
      }),
      steer: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      compact: async () => ({ ok: true }),
      disposeSession: async (sessionId) => {
        disposedSessions.push(sessionId);
        return { ok: true };
      },
      close: async () => {
        closedBuilds.push(runtimeBinding.runtimeBuildId);
      },
      exit(error = new Error('worker exited')) {
        emitter.emit('exit', error);
      },
      complete(runId, output = '') {
        emitter.emit('event', {
          type: 'event',
          runId,
          event: { type: 'run.completed', payload: { output, reasoning: '' } },
        });
      },
    };
    created.push(bridge);
    return bridge;
  };
  return { factory, created, disposedSessions, closedBuilds };
}

function binding(runtimeBuildId = 'pi-build-1') {
  return {
    runtimeBuildId,
    runtimeVersion: '0.80.9',
    runtimeDir: '/tmp/pi',
    adapterProtocolVersion: 1,
  };
}

describe('Pi Bridge Pool 生命周期', () => {
  test('Given 20 个 Session 使用同一 Runtime Build When 启动 Then 只创建一个 Worker', async () => {
    const fake = createFakeBridgeFactory();
    const pool = createPiBridgePool({ bridgeFactory: fake.factory });

    for (let index = 0; index < 20; index += 1) {
      await pool.startRun({
        runId: `run-${index}`,
        sessionId: `session-${index}`,
        runtimeBinding: binding(),
      });
    }

    expect(fake.created).toHaveLength(1);
    expect(pool.bridgeCount()).toBe(1);
    expect(pool.sessionCount()).toBe(20);
    await pool.close();
  });

  test('Given 不同 Runtime Build When 启动 Session Then 每个 Build 各一个 Worker', async () => {
    const fake = createFakeBridgeFactory();
    const pool = createPiBridgePool({ bridgeFactory: fake.factory });

    await pool.startRun({ runId: 'run-1', sessionId: 'session-1', runtimeBinding: binding('build-1') });
    await pool.startRun({ runId: 'run-2', sessionId: 'session-2', runtimeBinding: binding('build-2') });

    expect(pool.bridgeCount()).toBe(2);
    await pool.close();
  });

  test('Given 共享 Worker 中有多个 Session When 关闭一个 Session Then 其他 Session 仍可继续使用', async () => {
    const fake = createFakeBridgeFactory();
    const pool = createPiBridgePool({ bridgeFactory: fake.factory });
    await pool.startRun({ runId: 'run-1', sessionId: 'session-1', runtimeBinding: binding() });
    await pool.startRun({ runId: 'run-2', sessionId: 'session-2', runtimeBinding: binding() });

    await pool.disposeSession('session-1');
    expect(pool.bridgeCount()).toBe(1);
    expect(pool.sessionCount()).toBe(1);
    await expect(pool.steer('session-2', '继续')).resolves.toEqual({ ok: true });
    await pool.close();
  });

  test('Given 工具请求携带不同 sessionId When 共享 Worker 转发 Then 宿主按原 Session 上下文处理', async () => {
    const fake = createFakeBridgeFactory();
    const seen = [];
    const pool = createPiBridgePool({
      bridgeFactory: fake.factory,
      toolHandler: async (_name, _params, context) => {
        seen.push(context.sessionId);
        return { ok: true };
      },
    });
    await pool.startRun({ runId: 'run-1', sessionId: 'session-1', runtimeBinding: binding() });
    await pool.startRun({ runId: 'run-2', sessionId: 'session-2', runtimeBinding: binding() });

    await fake.created[0].toolHandler('proma_task_get', {}, { sessionId: 'session-1' });
    await fake.created[0].toolHandler('proma_task_get', {}, { sessionId: 'session-2' });

    expect(seen).toEqual(['session-1', 'session-2']);
    await pool.close();
  });

  test('Given 同一 Build 超过 8 个空闲 Session When 运行结束 Then 按 LRU 回收最早 Session', async () => {
    const clock = createClock();
    const fake = createFakeBridgeFactory();
    const pool = createPiBridgePool({
      bridgeFactory: fake.factory,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    for (let index = 0; index < 10; index += 1) {
      const runId = `run-${index}`;
      await pool.startRun({ runId, sessionId: `session-${index}`, runtimeBinding: binding() });
      fake.created[0].complete(runId);
      await clock.advance(1);
    }

    expect(fake.disposedSessions.slice(0, 2)).toEqual(['session-0', 'session-1']);
    expect(pool.sessionCount()).toBe(8);
    await pool.close();
  });

  test('Given Session 已空闲 When 达到 15 分钟 Then 回收 Session 并在 60 秒后关闭空 Worker', async () => {
    const clock = createClock();
    const fake = createFakeBridgeFactory();
    const pool = createPiBridgePool({
      bridgeFactory: fake.factory,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await pool.startRun({ runId: 'run-1', sessionId: 'session-1', runtimeBinding: binding() });
    fake.created[0].complete('run-1');
    await clock.advance(15 * 60 * 1000 - 1);
    expect(fake.disposedSessions).toEqual([]);

    await clock.advance(1);
    expect(fake.disposedSessions).toEqual(['session-1']);
    expect(pool.bridgeCount()).toBe(1);

    await clock.advance(60 * 1000);
    expect(fake.closedBuilds).toEqual(['pi-build-1']);
    expect(pool.bridgeCount()).toBe(0);
    await pool.close();
  });

  test('Given Session 仍在运行 When 时间超过 TTL Then 活跃 Session 永不回收', async () => {
    const clock = createClock();
    const fake = createFakeBridgeFactory();
    const pool = createPiBridgePool({
      bridgeFactory: fake.factory,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await pool.startRun({ runId: 'run-active', sessionId: 'session-active', runtimeBinding: binding() });
    await clock.advance(60 * 60 * 1000);

    expect(fake.disposedSessions).toEqual([]);
    expect(pool.sessionCount()).toBe(1);
    await pool.close();
  });

  test('Given 共享 Worker 异常退出 When 清理 Build Then 回收全部 Session 上下文', async () => {
    const fake = createFakeBridgeFactory();
    const disposed = [];
    const pool = createPiBridgePool({ bridgeFactory: fake.factory });
    pool.on('sessionDisposed', ({ sessionId }) => disposed.push(sessionId));

    await pool.startRun({ runId: 'run-1', sessionId: 'session-1', runtimeBinding: binding() });
    await pool.startRun({ runId: 'run-2', sessionId: 'session-2', runtimeBinding: binding() });
    fake.created[0].exit();

    expect(pool.bridgeCount()).toBe(0);
    expect(pool.sessionCount()).toBe(0);
    expect(disposed.sort()).toEqual(['session-1', 'session-2']);
    await pool.close();
  });

  test('Given 旧 Session 正在异步回收 When 同 ID Session 已重建 Then 不清理新 Session 上下文', async () => {
    const emitter = new EventEmitter();
    let resolveDispose;
    const disposed = [];
    const bridge = {
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      startRun: async (payload) => ({ sessionId: payload.sessionId }),
      steer: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      compact: async () => ({ ok: true }),
      disposeSession: async () => new Promise((resolve) => {
        resolveDispose = resolve;
      }),
      close: async () => {},
    };
    const pool = createPiBridgePool({ bridgeFactory: () => bridge });
    pool.on('sessionDisposed', ({ sessionId }) => disposed.push(sessionId));

    await pool.startRun({ runId: 'run-old', sessionId: 'session-1', runtimeBinding: binding() });
    bridge.complete = (runId) => emitter.emit('event', {
      runId,
      event: { type: 'run.completed', payload: { output: '', reasoning: '' } },
    });
    bridge.complete('run-old');
    const disposal = pool.disposeSession('session-1');
    await pool.startRun({ runId: 'run-new', sessionId: 'session-1', runtimeBinding: binding() });
    resolveDispose({ ok: true });
    await disposal;

    expect(pool.sessionCount()).toBe(1);
    expect(disposed).toEqual([]);
    await pool.close();
  });
});
