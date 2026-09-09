import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentRunningIndicator } from './AgentRunningIndicator'

describe('AgentRunningIndicator 执行中模型图标', () => {
  test('Given 会话正在使用明确模型 When 首帧尚未到达 Then 只显示准备状态不推测思考', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentRunningIndicator
          startedAt={Date.now() - 2_000}
          model="claude-sonnet-4"
        />
      </Provider>,
    )

    expect(html).toContain('title="使用 claude-sonnet-4"')
    expect(html).toContain('data-agent-activity="waiting"')
    expect(html).not.toContain('正在思考')
    expect(html.match(/正在准备下一步/g)).toHaveLength(1)
    expect(html.match(/agent-status-shimmer/g)).toHaveLength(1)
    expect(html).toContain('agent-activity-fade-in')
    expect(html).not.toContain('alt="模型"')
    expect(html).not.toContain('data-agent-status-divider="true"')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('animate-spin')
  })

  test('Given 执行节点未返回模型 When 渲染执行中状态 Then 仍只显示单行准备状态', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentRunningIndicator />
      </Provider>,
    )

    expect(html).not.toContain('正在思考')
    expect(html).toContain('data-agent-activity="waiting"')
    expect(html).toContain('agent-status-shimmer')
    expect(html.match(/正在准备下一步/g)).toHaveLength(1)
    expect(html).not.toContain('data-agent-status-divider="true"')
  })
})
