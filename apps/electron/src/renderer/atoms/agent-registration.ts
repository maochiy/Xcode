import { atom } from 'jotai'
import type {
  AgentRegistrationConfig,
  AgentRegistrationUpdate,
} from '@proma/shared'

export const agentRegistrationConfigAtom = atom<AgentRegistrationConfig | null>(null)
export const agentRegistrationDraftAtom = atom<AgentRegistrationUpdate | null>(null)
export const agentRegistrationLoadingAtom = atom(false)
export const agentRegistrationSavingAtom = atom(false)
export const agentRegistrationErrorAtom = atom<string | null>(null)

export const agentRegistrationDirtyAtom = atom((get) => {
  const config = get(agentRegistrationConfigAtom)
  const draft = get(agentRegistrationDraftAtom)
  if (!config || !draft) return false
  return JSON.stringify({
    agents: config.agents,
    globalInstructions: config.globalInstructions,
  }) !== JSON.stringify(draft)
})

export const loadAgentRegistrationAtom = atom(null, async (get, set) => {
  if (get(agentRegistrationLoadingAtom)) return
  set(agentRegistrationLoadingAtom, true)
  set(agentRegistrationErrorAtom, null)
  try {
    const config = await window.electronAPI.getAgentRegistrationConfig()
    set(agentRegistrationConfigAtom, config)
    set(agentRegistrationDraftAtom, {
      agents: config.agents,
      globalInstructions: config.globalInstructions,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '加载子 Agent 注册配置失败'
    console.error('[子 Agent 注册] 加载失败:', error)
    set(agentRegistrationErrorAtom, message)
  } finally {
    set(agentRegistrationLoadingAtom, false)
  }
})

export const saveAgentRegistrationAtom = atom(
  null,
  async (_get, set, input: AgentRegistrationUpdate): Promise<AgentRegistrationConfig> => {
    set(agentRegistrationSavingAtom, true)
    set(agentRegistrationErrorAtom, null)
    try {
      const config = await window.electronAPI.saveAgentRegistrationConfig(input)
      set(agentRegistrationConfigAtom, config)
      set(agentRegistrationDraftAtom, {
        agents: config.agents,
        globalInstructions: config.globalInstructions,
      })
      return config
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存子 Agent 注册配置失败'
      console.error('[子 Agent 注册] 保存失败:', error)
      set(agentRegistrationErrorAtom, message)
      throw error
    } finally {
      set(agentRegistrationSavingAtom, false)
    }
  },
)
