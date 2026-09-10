import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { settingsTabAtom } from '@/atoms/settings-tab'

// 设置页依赖 Vite 注入的构建版本；测试只补齐该常量，不连接 Electron 服务。
Reflect.set(globalThis, '__APP_VERSION__', '0.0.0-test')
const { SettingsPanel } = await import('./SettingsPanel')
Reflect.deleteProperty(globalThis, '__APP_VERSION__')

describe('设置页面导航', () => {
  test('Given 打开设置 When 查看品牌入口 Then 使用 Xcodes 精确命名', () => {
    const store = createStore()
    store.set(settingsTabAtom, 'general')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SettingsPanel />
      </Provider>,
    )

    expect(html).toContain('Xcodes 教程')
    expect(html).toContain('>Xcodes</div>')
    expect(html).not.toContain('Xcode 教程')
  })

  test('Given 打开设置 When 查看导航 Then 外观设置紧跟通用设置且只出现一次', () => {
    const store = createStore()
    store.set(settingsTabAtom, 'general')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SettingsPanel />
      </Provider>,
    )
    const labels = Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g))
      .map((match) => match[1]!.replace(/<[^>]*>/g, '').trim())
    const generalIndex = labels.indexOf('通用设置')

    expect(generalIndex).toBeGreaterThanOrEqual(0)
    expect(labels[generalIndex + 1]).toBe('外观设置')
    expect(labels.filter((label) => label === '外观设置')).toHaveLength(1)
  })

  test('Given 选择外观设置 When 展示页面 Then 保留外观选项且不显示应用图标选择器', () => {
    const store = createStore()
    store.set(settingsTabAtom, 'appearance')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SettingsPanel />
      </Provider>,
    )

    for (const label of ['主题模式', '界面风格', '界面缩放', 'Markdown 字号', 'Agent 预览展开方式']) {
      expect(html).toContain(label)
    }
    expect(html).not.toContain('应用图标')
    expect(html).not.toContain('自定义 Dock')
  })

  test('Given 使用内置 Pi 内核 When 打开设置 Then 不再显示 Runtime 中心且保留模型配置', () => {
    const store = createStore()
    store.set(settingsTabAtom, 'general')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SettingsPanel />
      </Provider>,
    )

    expect(html).not.toContain('Runtime 中心')
    expect(html).toContain('模型配置')
    expect(html).toContain('代理设置')
    expect(html).toContain('OpenSwitch 账号')
  })
})
