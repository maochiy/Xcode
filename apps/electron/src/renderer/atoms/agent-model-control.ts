import { atom } from 'jotai'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  agentSessionsAtom,
  agentStreamingStatesAtom,
} from './agent-atoms'

/** Agent 错误卡片发出的选模请求；不与侧栏 Chat 的模型弹层共享状态。 */
export const agentModelSelectorOpenAtom = atom(false)

interface AgentModelSelection {
  sessionId: string
  channelId: string
  modelId: string
}

/** 一次写入完成会话和默认模型切换，订阅者不会看到渠道/模型不一致的中间状态。 */
export const selectAgentModelAtom = atom(null, (get, set, selection: AgentModelSelection) => {
  const { sessionId, channelId, modelId } = selection
  const channels = get(agentSessionChannelMapAtom)
  const models = get(agentSessionModelMapAtom)
  const sessions = get(agentSessionsAtom)
  const session = sessions.find(item => item.id === sessionId)
  const previousChannel = session?.channelId ?? channels.get(sessionId) ?? get(agentChannelIdAtom)
  const previousModel = session?.modelId ?? models.get(sessionId) ?? get(agentModelIdAtom)
  if (previousChannel === channelId && previousModel === modelId) return false

  if (channels.get(sessionId) !== channelId) {
    set(agentSessionChannelMapAtom, new Map(channels).set(sessionId, channelId))
  }
  if (models.get(sessionId) !== modelId) {
    set(agentSessionModelMapAtom, new Map(models).set(sessionId, modelId))
  }
  if (session) {
    set(agentSessionsAtom, sessions.map(item => item === session ? { ...item, channelId, modelId } : item))
  }
  const states = get(agentStreamingStatesAtom)
  const state = states.get(sessionId)
  if (state?.contextWindow !== undefined) {
    set(agentStreamingStatesAtom, new Map(states).set(sessionId, { ...state, contextWindow: undefined }))
  }
  set(agentChannelIdAtom, channelId)
  set(agentModelIdAtom, modelId)
  return true
})
