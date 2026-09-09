import { describe, expect, test } from 'bun:test'
import { APP_DISPLAY_NAME, configureAppBranding } from './app-branding'

describe('应用显示品牌', () => {
  test('Given 正式版 productName 已改名 When 配置显示品牌 Then ready 前保留 Proma 加密身份且固定原 userData', () => {
    const calls: string[] = []
    let readyListener: (() => void) | undefined
    const userDataPath = configureAppBranding({
      isPackaged: true,
      getPath: () => '/Users/test/Library/Application Support',
      once: (event, listener) => {
        calls.push(`once:${event}`)
        readyListener = listener
      },
      setPath: (name, path) => calls.push(`setPath:${name}:${path}`),
      setName: (name) => calls.push(`setName:${name}`),
    })

    expect(userDataPath).toBe('/Users/test/Library/Application Support/Proma')
    expect(calls).toEqual([
      'setPath:userData:/Users/test/Library/Application Support/Proma',
      'setName:Proma',
      'once:ready',
    ])

    readyListener?.()
    expect(calls.at(-1)).toBe(`setName:${APP_DISPLAY_NAME}`)
  })

  test('Given 开发版启动 When 配置显示品牌 Then ready 前保留 @proma/electron 加密身份', () => {
    const names: string[] = []
    let readyListener: (() => void) | undefined
    configureAppBranding({
      isPackaged: false,
      getPath: () => '/Users/test/Library/Application Support',
      once: (_event, listener) => {
        readyListener = listener
      },
      setPath: () => undefined,
      setName: (name) => names.push(name),
    })

    expect(names).toEqual(['@proma/electron'])
    readyListener?.()
    expect(names).toEqual(['@proma/electron', APP_DISPLAY_NAME])
  })
})
