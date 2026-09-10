/**
 * 隔离界面夹具：渲染真实 AgentView，只替换 Electron IPC 边界。
 * 不连接主进程或模型服务；真实 Pi 执行由 pi-native-session.integration.test.mjs 验证。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import type { AgentRuntimeModelCatalog, Channel, ChannelUpdateInput, SDKMessage } from '@proma/shared'
import * as atoms from '../../src/renderer/atoms/agent-atoms'
import { channelsAtom, channelsLoadedAtom } from '../../src/renderer/atoms/chat-atoms'
import { TooltipProvider } from '../../src/renderer/components/ui/tooltip'
import '../../src/renderer/styles/globals.css'

const settingsMode = new URLSearchParams(location.search).has('settings')
interface ConfigSnapshot {
  channel: Channel
  catalog: AgentRuntimeModelCatalog
}
async function loadConfig(): Promise<ConfigSnapshot> {
  const response = await fetch('/__compaction-config')
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}
const savedConfig = settingsMode ? await loadConfig() : undefined
const sessionId = 'isolated-model-switch'
const store = createStore()
const calls: Array<{ method: string; args: unknown[] }> = []
const errors: string[] = []
let channel: Channel = savedConfig?.channel ?? {
  id: 'isolated-channel', name: '隔离模型接口', provider: 'custom',
  baseUrl: 'http://127.0.0.1:1', apiKey: '', enabled: true, createdAt: 1, updatedAt: 1,
  models: ['A', 'B'].map(id => ({ id, name: `模型 ${id}`, enabled: true })),
}
const catalog: AgentRuntimeModelCatalog = savedConfig?.catalog ?? {
  channelId: channel.id, defaultModel: 'A',
  models: ['A', 'B'].map(value => ({
    value, displayName: `模型 ${value}`, description: '隔离验证模型',
    contextWindow: value === 'A' ? 128_000 : 256_000,
    supportsEffort: false, supportedEffortLevels: [],
    supportsAdaptiveThinking: false, supportsFastMode: false, supportsAutoMode: false,
  })),
  contextPolicy: {
    autoCompactEnabled: true,
    models: ['A', 'B'].map(model => ({
      model, contextWindow: model === 'A' ? 128_000 : 256_000,
      effectiveContextWindow: model === 'A' ? 128_000 : 256_000,
      autoCompactThreshold: model === 'A' ? 102_400 : 204_800,
    })),
  },
}
let session = {
  id: sessionId, title: '隔离验证：A 运行中切换 B', channelId: channel.id,
  modelId: 'A', createdAt: 1, updatedAt: 1,
}
const initialState: atoms.AgentStreamState = {
  running: !settingsMode, model: 'A', content: '模型 A 正在执行，尚未结束。',
  startedAt: Date.now(), contextWindow: 128_000, inputTokens: 1_000, outputTokens: 200,
  autoCompactEnabled: true, autoCompactThreshold: 102_400, effectiveContextWindow: 128_000,
  toolActivities: [{
    toolUseId: 'isolated-tool', toolName: 'Read',
    input: { file_path: '/isolated/fixture.txt' }, done: false,
  }],
}
const userMessage = {
  type: 'user', uuid: 'isolated-first-message', parent_tool_use_id: null,
  _createdAt: initialState.startedAt,
  message: { role: 'user', content: [{ type: 'text', text: '使用模型 A 开始执行' }] },
}
// 与实际流式监听器一样保留 assistant/tool_use 投影，不能只伪造 streamState。
const assistantMessage = {
  type: 'assistant', uuid: 'isolated-assistant', parent_tool_use_id: null,
  _createdAt: initialState.startedAt! + 1,
  message: {
    role: 'assistant', model: 'A',
    content: [
      { type: 'text', text: initialState.content },
      { type: 'tool_use', id: 'isolated-tool', name: 'Read', input: { file_path: '/isolated/fixture.txt' } },
    ],
  },
} as SDKMessage
let persisted = [userMessage] as SDKMessage[]
store.set(channelsAtom, [channel])
store.set(channelsLoadedAtom, true)
store.set(atoms.agentSessionsAtom, [session])
store.set(atoms.agentChannelIdAtom, channel.id)
store.set(atoms.agentModelIdAtom, 'A')
store.set(atoms.agentStreamingStatesAtom, new Map([[sessionId, initialState]]))
store.set(atoms.liveMessagesMapAtom, new Map([[sessionId, [assistantMessage]]]))
store.set(atoms.agentFloatingPanelEnabledAtom, false)

const methods: Record<string, (...args: unknown[]) => unknown> = {
  listChannels: async () => [channel],
  getAgentRuntimeModelCatalog: async () => settingsMode ? (await loadConfig()).catalog : catalog,
  getAgentRuntimeModelCatalogDraft: async () => settingsMode ? (await loadConfig()).catalog : catalog,
  decryptApiKey: async () => 'isolated-fixture-key',
  updateChannel: async (_id, rawPatch) => {
    const patch = rawPatch as ChannelUpdateInput
    const response = await fetch('/__compaction-config', {
      method: 'POST',
      body: JSON.stringify({
        ...patch,
        // JSON 不保留 undefined，显式传 null 对应 IPC 中的清除字段。
        ...('autoCompactRatio' in patch && patch.autoCompactRatio === undefined
          ? { autoCompactRatio: null } : {}),
      }),
    })
    if (!response.ok) throw new Error(await response.text())
    const result: ConfigSnapshot = await response.json()
    channel = result.channel
    store.set(channelsAtom, [channel])
    return channel
  },
  getChannelPlanQuota: async () => ({ supported: false, windows: [] }),
  getAgentSessionSDKMessages: async () => persisted,
  getAgentRuntimeExecutionGraph: async () => ({ nodes: [], todos: [], updatedAt: 1 }),
  getAgentSessionPath: async () => null,
  getSettings: async () => ({}),
  updateSettings: async () => ({}),
  updateAgentSessionModel: async (_id, channelId, modelId) => {
    session = { ...session, channelId: String(channelId), modelId: String(modelId) }
    return session
  },
  // 与当前 RuntimeAdapterRouter 一致：没有模型热切换实现。
  updateAgentRuntimeConfig: async () => false,
  // 故意不确认消费，用于检查等待期间不停止工具、不替换当前轮。
  queueAgentMessage: () => new Promise<void>(() => {}),
  sendAgentMessage: async () => undefined,
  stopAgent: async () => undefined,
}
window.electronAPI = new Proxy({}, {
  get(_target, key) {
    const method = String(key)
    if (method.startsWith('on')) return () => () => {}
    return (...args: unknown[]) => {
      calls.push({ method, args })
      const handler = methods[method]
      if (handler) return handler(...args)
      const error = `隔离夹具未实现 IPC：${method}`
      errors.push(error)
      throw new Error(error)
    }
  },
}) as typeof window.electronAPI
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))

const fixture = {
  snapshot: () => ({
    selected: store.get(atoms.agentSessionsAtom)[0]?.modelId,
    persisted: session.modelId,
    stream: store.get(atoms.agentStreamingStatesAtom).get(sessionId),
    pending: store.get(atoms.agentImmediateUserMessagesAtom).get(sessionId) ?? [],
    channel,
    catalogs: [...store.get(atoms.agentRuntimeModelCatalogsAtom).values()],
    calls, errors,
  }),
  advance: () => store.set(atoms.agentStreamingStatesAtom, previous => {
    const current = previous.get(sessionId)!
    return new Map(previous).set(sessionId, { ...current, content: `${current.content} A 继续输出。` })
  }),
  finish: () => {
    persisted = [userMessage, assistantMessage] as SDKMessage[]
    store.set(atoms.agentStreamingStatesAtom, previous => {
      const current = previous.get(sessionId)!
      return new Map(previous).set(sessionId, {
        ...current, running: false,
        toolActivities: current.toolActivities.map(tool => ({ ...tool, done: true })),
      })
    })
    store.set(atoms.agentMessageRefreshAtom, previous => new Map(previous).set(sessionId, 1))
  },
}
Object.assign(window, { modelSwitchFixture: fixture })
const { AgentView } = await import('../../src/renderer/components/agent/AgentView')
const { ChannelForm } = await import('../../src/renderer/components/settings/ChannelForm')
function FixtureApp(): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  return <>
    <AgentView sessionId={sessionId} />
    {settingsMode && <button
      aria-label="编辑隔离模型配置"
      style={{ position: 'fixed', top: 8, right: 8, zIndex: 40 }}
      onClick={() => setEditing(true)}
    >编辑配置</button>}
    {editing && <div style={{
      position: 'fixed', inset: 0, overflow: 'auto', zIndex: 50,
      background: 'white', padding: 24,
    }}>
      <ChannelForm channel={channel} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
    </div>}
  </>
}
createRoot(document.getElementById('root')!).render(
  <Provider store={store}><TooltipProvider><FixtureApp /></TooltipProvider></Provider>,
)
