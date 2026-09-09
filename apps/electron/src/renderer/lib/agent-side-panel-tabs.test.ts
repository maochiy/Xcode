import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  AGENT_SIDE_PANEL_DEFAULT_WIDTH,
  agentDiffPanelTabAtom,
  agentFocusedExecutionNodeAtom,
  agentSidePanelLauncherAtom,
  agentSidePanelOpenAtom,
  agentSidePanelTabsAtom,
  agentSidePanelWidthAtom,
  agentTerminalTabSnapshotsAtom,
  closeAgentSidePanelAtom,
  closeAgentSidePanelTabAtom,
  createAgentExecutionNodeTab,
  createAgentTerminalTab,
  getAgentExecutionNodeId,
  getAgentTerminalSessionId,
  isAgentExecutionNodeTab,
  isAgentTerminalTab,
  openAgentSidePanelLauncherAtom,
  openAgentSidePanelTabAtom,
  reorderAgentSidePanelTabsAtom,
} from '@/atoms/agent-atoms'
import { getAvailableAgentSidePanelTabs } from './agent-side-panel-tabs'

const SESSION_ID = 'dynamic-side-panel-test'

describe('右侧动态功能区状态', () => {
  test('Given 手动打开功能区 When 初始化 Then 显示启动页且没有固定 Tabs', () => {
    const store = createStore()

    store.set(openAgentSidePanelLauncherAtom, SESSION_ID)

    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentSidePanelLauncherAtom).get(SESSION_ID)).toBe(true)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toBeUndefined()
  })

  test('Given 启动页 When 点击入口 Then 创建并激活唯一动态 Tab', () => {
    const store = createStore()

    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })

    expect(store.get(agentSidePanelLauncherAtom).get(SESSION_ID)).toBe(false)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['changes'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('changes')
  })

  test('Given 多个动态 Tabs When 关闭最后一个 Then 返回启动页', () => {
    const store = createStore()
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'session' })
    store.set(openAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: 'execution',
      focusedExecutionNodeId: 'node-1',
    })

    store.set(closeAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'execution' })
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('session')
    expect(store.get(agentFocusedExecutionNodeAtom).has(SESSION_ID)).toBe(false)

    store.set(closeAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'session' })
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([])
    expect(store.get(agentSidePanelLauncherAtom).get(SESSION_ID)).toBe(true)
  })

  test('Given 已打开 Tabs When 拖动排序 Then 保存新的顺序', () => {
    const store = createStore()
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'session' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'workspace' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })

    store.set(reorderAgentSidePanelTabsAtom, {
      sessionId: SESSION_ID,
      source: 'changes',
      target: 'session',
    })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([
      'changes',
      'session',
      'workspace',
    ])
  })

  test('Given 点击不同执行节点 When 打开动态 Tabs Then 每个节点拥有独立且可还原的 Tab', () => {
    const store = createStore()
    const firstNodeTab = createAgentExecutionNodeTab('node-1')
    const secondNodeTab = createAgentExecutionNodeTab('node-2')

    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: secondNodeTab })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([
      firstNodeTab,
      secondNodeTab,
    ])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe(firstNodeTab)
    expect(isAgentExecutionNodeTab(firstNodeTab)).toBe(true)
    expect(getAgentExecutionNodeId(secondNodeTab)).toBe('node-2')
  })

  test('Given 不同 Runtime 复用了节点 ID When 创建节点 Tabs Then 两个详情 Tab 身份互不冲突', () => {
    const firstRuntimeTab = createAgentExecutionNodeTab('node-1', 'runtime-a')
    const secondRuntimeTab = createAgentExecutionNodeTab('node-1', 'runtime-b')

    expect(firstRuntimeTab).not.toBe(secondRuntimeTab)
    expect(getAgentExecutionNodeId(firstRuntimeTab)).toBe('node-1')
    expect(getAgentExecutionNodeId(secondRuntimeTab)).toBe('node-1')
  })

  test('Given 已打开多个执行节点 Tabs When 关闭其中一个 Then 保留其他节点 Tab', () => {
    const store = createStore()
    const firstNodeTab = createAgentExecutionNodeTab('node-1')
    const secondNodeTab = createAgentExecutionNodeTab('node-2')

    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: secondNodeTab })
    store.set(closeAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([secondNodeTab])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe(secondNodeTab)
  })

  test('Given 创建两个终端会话 When 打开动态 Tabs Then 每个 PTY 使用独立 Tab 和快照', () => {
    const store = createStore()
    const firstTab = createAgentTerminalTab('terminal-1')
    const secondTab = createAgentTerminalTab('terminal-2')
    const createSnapshot = (id: string, cwd: string) => ({
      id,
      conversationId: SESSION_ID,
      cwd,
      shellName: 'zsh',
      shellKind: 'zsh' as const,
      cols: 80,
      rows: 24,
      output: '',
      outputSequence: 0,
      truncated: false,
      alternateScreen: false,
    })

    store.set(openAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: firstTab,
      terminalSnapshot: createSnapshot('terminal-1', '/tmp/project-a'),
    })
    store.set(openAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: secondTab,
      terminalSnapshot: createSnapshot('terminal-2', '/tmp/project-b'),
    })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([
      firstTab,
      secondTab,
    ])
    expect(isAgentTerminalTab(firstTab)).toBe(true)
    expect(getAgentTerminalSessionId(secondTab)).toBe('terminal-2')
    expect(
      store.get(agentTerminalTabSnapshotsAtom).get(SESSION_ID)?.get(firstTab)?.cwd,
    ).toBe('/tmp/project-a')

    store.set(closeAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: firstTab,
    })
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([secondTab])
    expect(
      store.get(agentTerminalTabSnapshotsAtom).get(SESSION_ID)?.has(firstTab),
    ).toBe(false)
  })

  test('Given 已打开 Tabs When 收起并再次打开功能区 Then 恢复原 Tabs 和激活项', () => {
    const store = createStore()
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'workspace' })

    store.set(closeAgentSidePanelAtom, SESSION_ID)
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['changes', 'workspace'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('workspace')

    store.set(openAgentSidePanelLauncherAtom, SESSION_ID)
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentSidePanelLauncherAtom).get(SESSION_ID)).toBe(false)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['changes', 'workspace'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('workspace')
  })

  test('Given 功能区已收起且宽度较小 When 再次打开 Then 使用默认宽度', () => {
    const store = createStore()
    store.set(agentSidePanelWidthAtom, 360)
    store.set(closeAgentSidePanelAtom, SESSION_ID)

    store.set(openAgentSidePanelLauncherAtom, SESSION_ID)

    expect(store.get(agentSidePanelWidthAtom)).toBe(AGENT_SIDE_PANEL_DEFAULT_WIDTH)
  })

  test('Given 当前会话没有 Tabs When 打开功能区 Then 仍显示默认启动页', () => {
    const store = createStore()
    store.set(closeAgentSidePanelAtom, SESSION_ID)

    store.set(openAgentSidePanelLauncherAtom, SESSION_ID)

    expect(store.get(agentSidePanelLauncherAtom).get(SESSION_ID)).toBe(true)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toBeUndefined()
  })
})

describe('右侧功能区加号菜单', () => {
  test('Given 部分功能已打开 When 生成可选项 Then 只返回尚未打开且当前可用的功能', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: ['session', 'changes'],
      hasExecutionGraph: true,
      hasPlan: true,
      hasSideChat: true,
    })).toEqual(['browser', 'workspace', 'plan', 'execution', 'chat', 'terminal'])
  })

  test('Given 没有执行图和侧边问答 When 生成可选项 Then 不显示执行与问答', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: [],
      hasExecutionGraph: false,
      hasPlan: false,
      hasSideChat: false,
    })).toEqual(['browser', 'session', 'workspace', 'changes', 'terminal'])
  })

  test('Given 执行节点动态 Tab 已打开 When 生成加号菜单 Then 不影响静态功能候选项', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: [createAgentExecutionNodeTab('node-1')],
      hasExecutionGraph: true,
      hasPlan: false,
      hasSideChat: false,
    })).toEqual(['browser', 'session', 'workspace', 'changes', 'execution', 'terminal'])
  })

  test('Given 当前存在计划 When 子智能体不存在 Then 加号菜单仍可单独打开计划', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: [],
      hasExecutionGraph: false,
      hasPlan: true,
      hasSideChat: false,
    })).toEqual(['browser', 'session', 'workspace', 'changes', 'plan', 'terminal'])
  })
})
