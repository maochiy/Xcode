import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserPanel } from './BrowserPanel'

function renderBrowser(initialUrl: string): string {
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <BrowserPanel sessionId="browser-navigation-test" initialUrl={initialUrl} />
    </Provider>,
  )
}

describe('BrowserPanel 网页导航', () => {
  test('Given 荣耀文档地址 When 创建浏览器 Then 不添加导致页面不存在的末尾斜杠', () => {
    const url = 'https://developer.honor.com/cn/docs/voip/reference/Overview'
    const html = renderBrowser(url)
    expect(html).toContain(`src="${url}"`)
    expect(html).not.toContain(`src="${url}/"`)
  })

  test('Given 网页通过新窗口打开链接 When 创建 webview Then 允许请求交由主进程安全处理', () => {
    const html = renderBrowser('https://developer.honor.com/cn/search?val=voip')
    const webview = html.match(/<webview\b[^>]*>/)?.[0]
    expect(webview).toBeDefined()
    expect(webview).toMatch(/\sallowpopups(?:="(?:true)?")?(?:\s|>)/)
    expect(webview).toContain('partition="persist:proma-browser-browser-navigation-test"')
  })
})
