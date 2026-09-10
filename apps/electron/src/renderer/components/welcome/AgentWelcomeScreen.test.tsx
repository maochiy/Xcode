import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentWelcomeScreen } from './AgentWelcomeScreen'

describe('AgentWelcomeScreen Agent 新首屏', () => {
  test('Given 用户打开首屏 When 渲染品牌 Then 使用带石墨背景的确认版图标以兼容深浅主题', () => {
    const html = renderToStaticMarkup(<AgentWelcomeScreen />)
    expect(html).toContain('alt="Xcodes"')
    expect(html).toContain('xcodes-icon.svg')
    expect(html).not.toContain('xcodes-mark.svg')
  })

  test('Given 已选择项目 When 渲染首屏 Then 标题显示可换行的项目名', () => {
    const html = renderToStaticMarkup(
      <AgentWelcomeScreen projectName="Proma" onSelectPrompt={() => undefined} />,
    )

    expect(html).toContain('你想让我们在')
    expect(html).toContain('Proma</span>')
    expect(html).toContain('中构建什么？')
    expect(html).toContain('break-all underline')
  })

  test('Given 未选择项目 When 渲染首屏 Then 标题不保留项目占位', () => {
    const html = renderToStaticMarkup(
      <AgentWelcomeScreen projectName={null} onSelectPrompt={() => undefined} />,
    )

    expect(html).toContain('你想让我们构建什么？')
    expect(html).not.toContain('你想让我们在')
  })

  test('Given 提供任务选择回调 When 渲染任务卡片 Then 四个按钮都有可访问名称且保持可用', () => {
    const html = renderToStaticMarkup(
      <AgentWelcomeScreen onSelectPrompt={() => undefined} />,
    )
    const labels = [
      '探索并理解代码',
      '构建新功能、应用或工具',
      '审查代码并提出修改建议',
      '修复问题和失败',
    ]

    expect(html.match(/<button/g)).toHaveLength(4)
    expect(html).not.toContain('disabled=""')
    for (const label of labels) {
      expect(html).toContain(`aria-label="${label}"`)
      expect(html).toContain(`>${label}</span>`)
    }
  })

  test('Given 未提供任务选择回调 When 渲染任务卡片 Then 四个按钮全部禁用', () => {
    const html = renderToStaticMarkup(<AgentWelcomeScreen />)

    expect(html.match(/<button/g)).toHaveLength(4)
    expect(html.match(/disabled=""/g)).toHaveLength(4)
  })
})
