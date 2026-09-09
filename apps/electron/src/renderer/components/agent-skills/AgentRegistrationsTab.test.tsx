import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentRegistrationConfigAtom,
  agentRegistrationDraftAtom,
} from '@/atoms/agent-registration'
import { AgentRegistrationsTab } from './AgentRegistrationsTab'

describe('Agents 全局注册页', () => {
  test('Given 后端返回实际目录 When 渲染 Then 展示角色 Markdown 与全局规则的真实路径', () => {
    const store = createStore()
    store.set(agentRegistrationConfigAtom, {
      agents: [{
        id: 'review',
        name: '审查',
        description: '审查实现',
        prompt: '只读审查。',
        enabled: true,
        role: 'review',
      }],
      globalInstructions: '# 全局规则',
      agentsPath: '/isolated/xcodes/agents',
      instructionsPath: '/isolated/xcodes/AGENTS.md',
    })
    store.set(agentRegistrationDraftAtom, {
      agents: [{
        id: 'review',
        name: '审查',
        description: '审查实现',
        prompt: '只读审查。',
        enabled: true,
        role: 'review',
      }],
      globalInstructions: '# 全局规则',
    })

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentRegistrationsTab search="" />
      </Provider>,
    )

    expect(html).toContain('/isolated/xcodes/agents')
    expect(html).toContain('/isolated/xcodes/agents/review.md')
    expect(html).toContain('/isolated/xcodes/AGENTS.md')
    expect(html).toContain('角色文件')
    expect(html).toContain('YAML frontmatter')
    expect(html).toContain('正文作为系统提示词')
    expect(html).not.toContain('agents.json')
  })

  test('Given 搜索词不匹配 When 渲染 Then 显示 Agent 专属筛选空态', () => {
    const store = createStore()
    store.set(agentRegistrationConfigAtom, {
      agents: [{
        id: 'review',
        name: '审查',
        description: '审查实现',
        prompt: '只读审查。',
        enabled: true,
      }],
      globalInstructions: '',
      agentsPath: '/isolated/xcodes/agents',
      instructionsPath: '/isolated/xcodes/AGENTS.md',
    })
    store.set(agentRegistrationDraftAtom, {
      agents: [{
        id: 'review',
        name: '审查',
        description: '审查实现',
        prompt: '只读审查。',
        enabled: true,
      }],
      globalInstructions: '',
    })

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentRegistrationsTab search="implement" />
      </Provider>,
    )

    expect(html).toContain('没有匹配的 Agent')
    expect(html).not.toContain('搜索记忆')
  })
})
