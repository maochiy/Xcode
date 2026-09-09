import { describe, expect, test } from 'bun:test'
import {
  getAgentSkillsSearchPlaceholder,
  shouldConfirmAgentRegistrationTabLeave,
} from './active-view'

describe('Agent 技能子页导航', () => {
  test('Given Agents 子页 When 展示筛选框 Then 使用 Agent 专属占位文案', () => {
    expect(getAgentSkillsSearchPlaceholder('agents')).toBe('搜索注册 Agent...')
    expect(getAgentSkillsSearchPlaceholder('agents')).not.toContain('记忆')
  })

  test('Given 全局规则有未保存修改 When 离开 Agents 子页 Then 请求离开确认', () => {
    expect(shouldConfirmAgentRegistrationTabLeave('agents', 'skills', true)).toBe(true)
    expect(shouldConfirmAgentRegistrationTabLeave('agents', 'agents', true)).toBe(false)
    expect(shouldConfirmAgentRegistrationTabLeave('agents', 'mcp', false)).toBe(false)
  })
})
