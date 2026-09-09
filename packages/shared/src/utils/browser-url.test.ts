import { describe, expect, test } from 'bun:test'
import { normalizeBrowserNavigationUrl } from './browser-url'

describe('normalizeBrowserNavigationUrl', () => {
  test('Given 路径无末尾斜杠 When 规范化 Then 不猜测它是目录而改写路径', () => {
    expect(normalizeBrowserNavigationUrl('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus'))
      .toBe('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus')
    expect(normalizeBrowserNavigationUrl('https://developer.honor.com/cn/docs/voip/reference/Overview'))
      .toBe('https://developer.honor.com/cn/docs/voip/reference/Overview')
  })

  test('Given 显式目录斜杠或站点 hash When 规范化 Then 均按输入原样保留', () => {
    expect(normalizeBrowserNavigationUrl('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus/'))
      .toBe('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus/')
    expect(normalizeBrowserNavigationUrl('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus#browse/welcome'))
      .toBe('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus#browse/welcome')
    expect(normalizeBrowserNavigationUrl('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus/#browse/welcome'))
      .toBe('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus/#browse/welcome')
  })

  test('Given 查询参数或文件路径 When 规范化 Then 不补斜杠', () => {
    expect(normalizeBrowserNavigationUrl('https://www.google.com/search?q=asdasda'))
      .toBe('https://www.google.com/search?q=asdasda')
    expect(normalizeBrowserNavigationUrl('https://developer.honor.com/cn/search?val=voip&_t=1788925681171'))
      .toBe('https://developer.honor.com/cn/search?val=voip&_t=1788925681171')
    expect(normalizeBrowserNavigationUrl('https://example.com/index.html'))
      .toBe('https://example.com/index.html')
    expect(normalizeBrowserNavigationUrl('https://example.com/assets/app.js'))
      .toBe('https://example.com/assets/app.js')
  })

  test('Given 省略协议或站点根路径 When 规范化 Then 补 https 且根路径保持斜杠', () => {
    expect(normalizeBrowserNavigationUrl('example.com/foo')).toBe('https://example.com/foo')
    expect(normalizeBrowserNavigationUrl('https://www.google.com')).toBe('https://www.google.com/')
  })

  test('Given 非法地址 When 规范化 Then 返回空', () => {
    expect(normalizeBrowserNavigationUrl('')).toBeNull()
    expect(normalizeBrowserNavigationUrl('ftp://example.com/foo')).toBeNull()
    expect(normalizeBrowserNavigationUrl('about:blank')).toBeNull()
  })
})
