import { describe, expect, test } from 'bun:test'
import type { HeadersReceivedResponse, OnHeadersReceivedListenerDetails } from 'electron'
import {
  repairBrowserDirectoryRedirectHeaders,
  resolveBrowserDirectoryRedirect,
} from './browser-navigation-policy.cjs'

const SOURCE = 'https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus'
const INTERNAL_REDIRECT = 'http://test-ai.xiujiadian.com:18081/zhuxiangwei-macmini-nexus/'

describe('内置浏览器目录重定向兼容', () => {
  test('Given 服务器补斜杠却泄露内部端口 When 处理 Location Then 保留公网 HTTPS 并补斜杠', () => {
    expect(resolveBrowserDirectoryRedirect(SOURCE, INTERNAL_REDIRECT)).toBe(`${SOURCE}/`)
  })

  test('Given 正常目录跳转、荣耀路由或跨域跳转 When 处理 Location Then 不擅自改写', () => {
    for (const [source, location] of [
      [SOURCE, `${SOURCE}/`],
      [SOURCE, `${SOURCE}/#browse/welcome`],
      [SOURCE, 'https://accounts.example.com/login'],
      [SOURCE, 'http://other.example.com:18081/zhuxiangwei-macmini-nexus/'],
      [SOURCE, 'http://test-ai.xiujiadian.com:18081/login'],
      [SOURCE, `${INTERNAL_REDIRECT}?next=other`],
      [SOURCE, 'http://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus/'],
      ['https://developer.honor.com/cn/docs/voip/reference/Overview', '/cn/notFound'],
    ]) {
      expect(resolveBrowserDirectoryRedirect(source, location)).toBeNull()
    }
  })

  test('Given 目录跳转包含查询和片段 When 修复代理地址 Then 不丢失它们', () => {
    expect(resolveBrowserDirectoryRedirect(`${SOURCE}?view=files`, `${INTERNAL_REDIRECT}?view=files#browse/welcome`))
      .toBe(`${SOURCE}/?view=files#browse/welcome`)
  })

  test('Given URL 非法或含凭据 When 检查目录兼容 Then 不应用修复', () => {
    expect(resolveBrowserDirectoryRedirect('not a URL', INTERNAL_REDIRECT)).toBeNull()
    expect(resolveBrowserDirectoryRedirect(SOURCE, 'file:///tmp/')).toBeNull()
    expect(resolveBrowserDirectoryRedirect('https://user@example.com/docs', 'http://example.com:18081/docs/')).toBeNull()
  })

  function responseFor(overrides: Partial<OnHeadersReceivedListenerDetails> = {}): HeadersReceivedResponse {
    const details = {
      url: SOURCE,
      method: 'GET',
      resourceType: 'mainFrame',
      statusCode: 301,
      responseHeaders: { Location: [INTERNAL_REDIRECT], 'X-Frame-Options': ['DENY'] },
      ...overrides,
    }
    let result: HeadersReceivedResponse | undefined
    repairBrowserDirectoryRedirectHeaders(details, (response: HeadersReceivedResponse) => { result = response })
    expect(result).toBeDefined()
    return result!
  }

  test('Given 主文档目录重定向 When 修复响应头 Then 只替换 Location 并保留安全响应头', () => {
    expect(responseFor()).toEqual({
      responseHeaders: { Location: [`${SOURCE}/`], 'X-Frame-Options': ['DENY'] },
    })
    expect(responseFor({ responseHeaders: { location: [INTERNAL_REDIRECT] } }))
      .toEqual({ responseHeaders: { location: [`${SOURCE}/`] } })
  })

  test('Given POST、子资源或非重定向响应 When 浏览器收到响应 Then 不做兼容重写', () => {
    expect(responseFor({ method: 'POST' })).toEqual({})
    expect(responseFor({ resourceType: 'xhr' })).toEqual({})
    expect(responseFor({ resourceType: 'subFrame' })).toEqual({})
    expect(responseFor({ statusCode: 200 })).toEqual({})
    expect(responseFor({ responseHeaders: {} })).toEqual({})
  })
})
