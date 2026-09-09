/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: 对话视图（Chat/Agent 模式内容）
 * - automations: 定时任务列表视图
 * - agent-skills: Agent 技能（Skills/MCP/记忆/Agents）全屏管理视图
 */

import { atom } from 'jotai'

export type ActiveView = 'conversations' | 'automations' | 'agent-skills' | 'taskboard' | 'settings'
export type AgentSkillsCapabilityTab = 'skills' | 'mcp' | 'memory' | 'agents'

const AGENT_SKILLS_SEARCH_PLACEHOLDERS: Record<AgentSkillsCapabilityTab, string> = {
  skills: '搜索 Skills...',
  mcp: '搜索 MCP 服务器...',
  memory: '搜索记忆文件...',
  agents: '搜索注册 Agent...',
}

export function getAgentSkillsSearchPlaceholder(tab: AgentSkillsCapabilityTab): string {
  return AGENT_SKILLS_SEARCH_PLACEHOLDERS[tab]
}

export function shouldConfirmAgentRegistrationTabLeave(
  currentTab: AgentSkillsCapabilityTab,
  nextTab: AgentSkillsCapabilityTab,
  dirty: boolean,
): boolean {
  return dirty && currentTab === 'agents' && nextTab !== 'agents'
}

/** 当前活跃视图（不持久化，每次启动默认显示对话） */
export const activeViewAtom = atom<ActiveView>('conversations')

/** Agent 技能视图当前子页，用于外部入口直达 MCP 管理 */
export const agentSkillsTabAtom = atom<AgentSkillsCapabilityTab>('skills')
