import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runtimeBindingEnv(runtimeBinding) {
  if (!runtimeBinding) return {};
  const root = runtimeBinding.runtimeDir || '';
  const version = runtimeBinding.runtimeVersion || '';
  const buildId = runtimeBinding.runtimeBuildId || '';
  const protocol = String(runtimeBinding.adapterProtocolVersion || 1);
  return {
    PROMA_PI_RUNTIME_ROOT: root,
    PROMA_PI_RUNTIME_VERSION: version,
    PROMA_PI_RUNTIME_BUILD_ID: buildId,
    PROMA_PI_HOST_PROTOCOL_VERSION: protocol,
    // 兼容旧 Worker：同时写入 FRAKIO_PI_*。
    FRAKIO_PI_RUNTIME_ROOT: root,
    FRAKIO_PI_RUNTIME_VERSION: version,
    FRAKIO_PI_RUNTIME_BUILD_ID: buildId,
    FRAKIO_PI_HOST_PROTOCOL_VERSION: protocol,
  };
}

function piWorkerStartupError(message, code = 'PI_WORKER_STARTUP_FAILED') {
  return Object.assign(new Error(message), { code });
}

export function piWorkerStartupTimeoutMs(platform = process.platform) {
  return platform === 'win32' ? 60_000 : 20_000;
}

export function createPiBridge({
  workerPath = path.join(__dirname, 'workers', 'pi-worker.mjs'),
  env = {},
  runtimeBinding = null,
  toolHandler,
  forkProcess = fork,
  startupTimeoutMs = piWorkerStartupTimeoutMs(),
}) {
  const emitter = new EventEmitter();
  const pending = new Map();
  let child = null;
  let sequence = 0;
  let readyPromise = null;
  let readyInfo = null;

  function failPending(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function handleMessage(message) {
    if (message?.type === 'ready') {
      readyInfo = message;
      emitter.emit('ready', message);
      return;
    }
    if (message?.type === 'event') {
      emitter.emit('event', message);
      return;
    }
    if (message?.type === 'tool.request') {
      Promise.resolve(toolHandler?.(message.name, message.params || {}, message.context || {}))
        .then((result) => child?.send({ type: 'tool.response', requestId: message.requestId, result }))
        .catch((error) => child?.send({ type: 'tool.response', requestId: message.requestId, error: error.message || String(error) }));
      return;
    }
    const item = pending.get(message?.requestId);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.requestId);
    if (message.error) item.reject(new Error(message.error));
    else item.resolve(message);
  }

  async function ensureStarted() {
    if (readyPromise) return readyPromise;
    if (child?.connected && readyInfo) return child;
    readyPromise = new Promise((resolve, reject) => {
      const workerRequirePath = String(env.PROMA_PI_WORKER_REQUIRE_PATH || '').trim();
      const next = forkProcess(workerPath, [], {
        env: {
          ...process.env,
          ...env,
          ...runtimeBindingEnv(runtimeBinding),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
        ...(workerRequirePath
          ? { execArgv: [...process.execArgv, '--require', workerRequirePath] }
          : {}),
      });
      child = next;
      const stderr = [];
      next.stderr?.on('data', (chunk) => {
        stderr.push(String(chunk));
        if (stderr.length > 20) stderr.shift();
      });
      let startupFailure = null;
      const timer = setTimeout(() => {
        startupFailure = piWorkerStartupError(
          `Pi Worker startup timed out after ${startupTimeoutMs}ms.${stderr.length ? ` ${stderr.join('').slice(-1000)}` : ''}`,
          'PI_WORKER_STARTUP_TIMEOUT',
        );
        reject(startupFailure);
        next.kill('SIGTERM');
      }, startupTimeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        emitter.off('ready', onReady);
        resolve(next);
      };
      emitter.on('ready', onReady);
      next.on('message', handleMessage);
      next.once('error', (error) => {
        clearTimeout(timer);
        emitter.off('ready', onReady);
        startupFailure = piWorkerStartupError(error.message || String(error));
        reject(startupFailure);
      });
      next.once('exit', (code, signal) => {
        clearTimeout(timer);
        emitter.off('ready', onReady);
        const wasReady = readyInfo !== null;
        const error = startupFailure || piWorkerStartupError(
          `Pi Worker exited code=${code ?? ''} signal=${signal ?? ''}.${stderr.length ? ` ${stderr.join('').slice(-1000)}` : ''}`,
        );
        if (!wasReady) reject(error);
        failPending(error);
        child = null;
        readyPromise = null;
        readyInfo = null;
        emitter.emit('exit', error);
      });
    }).finally(() => {
      if (!child?.connected) readyPromise = null;
    });
    return readyPromise;
  }

  async function request(type, payload = {}, timeoutMs = 30000) {
    const processHandle = await ensureStarted();
    const requestId = `pi_bridge_${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Pi Worker request timed out: ${type}`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      processHandle.send({ type, requestId, ...payload });
    });
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    ensureStarted,
    async inspect() {
      await ensureStarted();
      return readyInfo;
    },
    async startRun(payload) {
      return request('run.start', payload, 120000);
    },
    async steer(sessionId, message, options = {}) {
      return request('run.steer', { sessionId, message, options });
    },
    async cancel(sessionId) {
      return request('run.cancel', { sessionId });
    },
    async compact(sessionId, input = {}) {
      return request('session.compact', {
        sessionId,
        instructions: input.instructions || '',
        completeRun: input.completeRun === true,
      }, 120000);
    },
    async disposeSession(sessionId) {
      return request('session.dispose', { sessionId });
    },
    async close() {
      if (!child) return;
      const current = child;
      child = null;
      readyPromise = null;
      readyInfo = null;
      current.disconnect();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          current.kill('SIGTERM');
          resolve();
        }, 1500);
        current.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export function createPiBridgePool({
  bindingResolver,
  bridgeFactory = createPiBridge,
  env = {},
  toolHandler,
  sessionIdleTtlMs = 15 * 60 * 1000,
  maxIdleSessionsPerBuild = 8,
  workerIdleTtlMs = 60 * 1000,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const emitter = new EventEmitter();
  const bridges = new Map();
  const sessions = new Map();
  const runBuilds = new Map();
  const runSessions = new Map();
  const runEventSequences = new Map();
  let closed = false;

  async function resolveBinding(input = {}) {
    return input.runtimeBinding || bindingResolver?.(input) || null;
  }

  function clearSessionTimer(entry) {
    if (!entry?.idleTimer) return;
    clearTimer(entry.idleTimer);
    entry.idleTimer = null;
  }

  function clearWorkerTimer(entry) {
    if (!entry?.idleTimer) return;
    clearTimer(entry.idleTimer);
    entry.idleTimer = null;
  }

  function scheduleWorkerClose(buildId) {
    const entry = bridges.get(buildId);
    if (!entry || entry.sessions.size > 0 || entry.idleTimer || closed) return;
    entry.idleTimer = setTimer(() => {
      entry.idleTimer = null;
      if (entry.sessions.size > 0 || bridges.get(buildId) !== entry) return;
      bridges.delete(buildId);
      void entry.bridge.close().catch(() => {});
    }, workerIdleTtlMs);
  }

  async function disposeSessionInternal(sessionId) {
    const key = String(sessionId || '');
    const entry = sessions.get(key);
    if (!entry) return;
    clearSessionTimer(entry);
    sessions.delete(key);
    const bridgeEntry = bridges.get(entry.buildId);
    bridgeEntry?.sessions.delete(key);
    await bridgeEntry?.bridge.disposeSession(key).catch(() => {});
    // 回收请求等待 Worker 响应期间，同 ID Session 可能已经重新建立。
    // 仅当当前仍无该 Session 时通知宿主清理 MCP 上下文，避免 ABA 误删新会话。
    if (!sessions.has(key)) {
      emitter.emit('sessionDisposed', { sessionId: key, runtimeBinding: bridgeEntry?.binding || null });
    }
    scheduleWorkerClose(entry.buildId);
  }

  function enforceIdleLimit(buildId) {
    const idle = Array.from(sessions.entries())
      .filter(([, entry]) => entry.buildId === buildId && entry.activeRuns.size === 0 && entry.idleSince != null)
      .sort((left, right) => left[1].idleSince - right[1].idleSince);
    for (const [sessionId] of idle.slice(0, Math.max(0, idle.length - maxIdleSessionsPerBuild))) {
      void disposeSessionInternal(sessionId);
    }
  }

  function markSessionIdle(sessionId, runId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    entry.activeRuns.delete(runId);
    if (entry.activeRuns.size > 0) return;
    entry.idleSince = now();
    clearSessionTimer(entry);
    entry.idleTimer = setTimer(() => {
      const current = sessions.get(sessionId);
      if (!current || current.activeRuns.size > 0) return;
      void disposeSessionInternal(sessionId);
    }, sessionIdleTtlMs);
    enforceIdleLimit(entry.buildId);
  }

  function bridgeFor(binding) {
    const buildId = String(binding?.runtimeBuildId || 'bundled');
    let entry = bridges.get(buildId);
    if (entry) {
      clearWorkerTimer(entry);
      return entry.bridge;
    }
    const bridge = bridgeFactory({ runtimeBinding: binding, env, toolHandler });
    entry = { bridge, binding, sessions: new Set(), idleTimer: null };
    bridge.on('event', (message) => {
      const runId = String(message?.runId || '');
      const nativeSequence = Number(runEventSequences.get(runId) || 0) + 1;
      runEventSequences.set(runId, nativeSequence);
      emitter.emit('event', {
        ...message,
        event: { ...(message.event || {}), nativeSequence, nativeEventKey: `pi:${binding.runtimeBuildId}:${runId}:${nativeSequence}` },
        runtimeBinding: binding,
      });
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(message?.event?.type)) {
        runEventSequences.delete(runId);
        const sessionId = runSessions.get(runId);
        if (sessionId) markSessionIdle(sessionId, runId);
        runSessions.delete(runId);
        runBuilds.delete(runId);
      }
    });
    bridge.on('exit', (error) => {
      const current = bridges.get(buildId);
      if (current?.bridge === bridge) {
        clearWorkerTimer(current);
        bridges.delete(buildId);
        for (const sessionId of current.sessions) {
          const session = sessions.get(sessionId);
          if (session?.buildId === buildId) {
            clearSessionTimer(session);
            sessions.delete(sessionId);
            emitter.emit('sessionDisposed', { sessionId, runtimeBinding: binding });
          }
        }
        for (const [runId, runBuildId] of runBuilds) {
          if (runBuildId !== buildId) continue;
          runBuilds.delete(runId);
          runSessions.delete(runId);
          runEventSequences.delete(runId);
        }
      }
      emitter.emit('exit', { error, runtimeBinding: binding });
    });
    bridges.set(buildId, entry);
    return bridge;
  }

  async function bridgeForSession(sessionId) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) return null;
    return bridges.get(session.buildId)?.bridge || null;
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    async probe(input = {}) {
      const binding = await resolveBinding(input);
      if (!binding) return { status: 'unsupported', capability: 'probe' };
      const ready = await bridgeFor(binding).inspect();
      scheduleWorkerClose(String(binding.runtimeBuildId || 'bundled'));
      return { status: 'ready', ...ready, runtimeBinding: binding };
    },
    async startRun(payload) {
      if (closed) throw new Error('Pi Bridge Pool 已关闭。');
      const binding = await resolveBinding(payload);
      if (!binding) throw new Error('Pi Runtime binding is unavailable.');
      const sessionId = String(payload.sessionId || '');
      const runId = String(payload.runId || '');
      const buildId = String(binding.runtimeBuildId || 'bundled');
      const previous = sessions.get(sessionId);
      if (previous && previous.buildId !== buildId) {
        await disposeSessionInternal(sessionId);
      }
      const bridge = bridgeFor(binding);
      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          buildId,
          activeRuns: new Set(),
          idleSince: null,
          idleTimer: null,
        };
        sessions.set(sessionId, session);
        bridges.get(buildId)?.sessions.add(sessionId);
      }
      clearSessionTimer(session);
      session.idleSince = null;
      session.activeRuns.add(runId);
      runBuilds.set(runId, buildId);
      runSessions.set(runId, sessionId);
      try {
        const accepted = await bridge.startRun({ ...payload, runtimeBinding: binding });
        return { ...accepted, runtimeVersion: binding.runtimeVersion, runtimeBuildId: binding.runtimeBuildId };
      } catch (error) {
        runBuilds.delete(runId);
        runSessions.delete(runId);
        await disposeSessionInternal(sessionId);
        throw error;
      }
    },
    async steer(sessionId, message, options = {}) {
      const bridge = await bridgeForSession(sessionId);
      if (!bridge) throw new Error('Pi session binding is unavailable.');
      return bridge.steer(sessionId, message, options);
    },
    async cancel(sessionId) {
      const bridge = await bridgeForSession(sessionId);
      if (!bridge) return { ok: false };
      return bridge.cancel(sessionId);
    },
    async compact(sessionId, input = {}) {
      const bridge = await bridgeForSession(sessionId);
      if (!bridge) return { status: 'unsupported', capability: 'compact' };
      return bridge.compact(sessionId, input);
    },
    async resolveApproval() {
      return { status: 'unsupported', capability: 'resolveApproval' };
    },
    async disposeSession(sessionId) {
      const key = String(sessionId || '');
      await disposeSessionInternal(key);
      return { ok: true };
    },
    async inspect(input = {}) {
      return this.probe(input);
    },
    async close() {
      closed = true;
      for (const session of sessions.values()) clearSessionTimer(session);
      for (const entry of bridges.values()) clearWorkerTimer(entry);
      await Promise.all(Array.from(bridges.values(), (entry) => entry.bridge.close().catch(() => {})));
      bridges.clear();
      sessions.clear();
      runBuilds.clear();
      runSessions.clear();
      runEventSequences.clear();
    },
    bridgeCount() { return bridges.size; },
    sessionCount() { return sessions.size; },
  };
}
