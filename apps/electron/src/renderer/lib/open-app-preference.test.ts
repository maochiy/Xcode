import { describe, expect, test } from 'bun:test'
import type { DefaultAppInfo } from '@proma/shared'
import {
  fileExtKey,
  hydrateOpenAppIcons,
  mergeOpenAppOptions,
  placeholderAppInfo,
  resolvePreferredOpenApp,
  sameOpenApp,
  resolveSystemOpenAppName,
  SYSTEM_DEFAULT_OPEN_APP_NAME,
} from './open-app-preference'

const vsCode: DefaultAppInfo = {
  name: 'Visual Studio Code',
  appPath: '/Applications/Visual Studio Code.app',
  iconDataUrl: 'data:image/png;base64,vscode',
}

const cursor: DefaultAppInfo = {
  name: 'Cursor',
  appPath: '/Applications/Cursor.app',
  iconDataUrl: 'data:image/png;base64,cursor',
}

const preview: DefaultAppInfo = {
  name: 'Preview',
  appPath: '/System/Applications/Preview.app',
  iconDataUrl: 'data:image/png;base64,preview',
}

describe('fileExtKey', () => {
  test('given 带后缀路径 when 取缓存键 then 返回小写后缀', () => {
    expect(fileExtKey('/tmp/next-env.d.ts')).toBe('.ts')
    expect(fileExtKey('C:\\repo\\README.MD')).toBe('.md')
  })

  test('given 无后缀文件 when 取缓存键 then 回退到文件名', () => {
    expect(fileExtKey('/tmp/Makefile')).toBe('Makefile')
  })
})

describe('mergeOpenAppOptions', () => {
  test('Given 系统返回改名前后的应用自身 When 合并打开方式 Then 均被过滤', () => {
    expect(mergeOpenAppOptions([
      { name: 'Xcode', appPath: '/Applications/Xcode-Desktop.app', iconDataUrl: '' },
      { name: 'Proma', appPath: '/Applications/Proma.app', iconDataUrl: '' },
    ])).toEqual([])
  })

  test('given 没有可用应用 when 合并选项 then 不插入系统默认占位', () => {
    expect(mergeOpenAppOptions([])).toEqual([])
  })

  test('given 系统把浏览器和办公软件登记为打开方式 when 合并选项 then 只保留编辑器', () => {
    expect(mergeOpenAppOptions([
      vsCode,
      { name: SYSTEM_DEFAULT_OPEN_APP_NAME, appPath: '', iconDataUrl: '' },
      { name: 'Google Chrome', appPath: '/Applications/Google Chrome.app', iconDataUrl: '' },
      { name: 'Microsoft Excel', appPath: '/Applications/Microsoft Excel.app', iconDataUrl: '' },
      { name: 'Xcode', appPath: '/Applications/Xcode.app', iconDataUrl: 'data:image/png;base64,xcode' },
    ]).map((item) => item.name)).toEqual(['Visual Studio Code', 'Xcode'])
  })

  test('given 跨文件记住的应用图标 when 补齐图标 then 缺失项复用同一套图标', () => {
    const knownIcons = new Map<string, string>([
      ['/applications/xcode.app', 'data:image/png;base64,xcode'],
    ])
    expect(hydrateOpenAppIcons([
      vsCode,
      { name: 'Xcode', appPath: '/Applications/Xcode.app', iconDataUrl: '' },
    ], knownIcons)).toEqual([
      vsCode,
      {
        name: 'Xcode',
        appPath: '/Applications/Xcode.app',
        iconDataUrl: 'data:image/png;base64,xcode',
      },
    ])
  })

  test('given 同一应用只有一条有图标 when 合并选项 then 复用该图标', () => {
    expect(mergeOpenAppOptions([
      vsCode,
      { name: 'Visual Studio Code', appPath: '/Applications/Visual Studio Code.app', iconDataUrl: '' },
      { name: 'Xcode', appPath: '/Applications/Xcode.app', iconDataUrl: '' },
      { name: 'Xcode', appPath: '/Applications/Xcode.app', iconDataUrl: 'data:image/png;base64,xcode' },
    ])).toEqual([
      {
        name: 'Visual Studio Code',
        source: 'app',
        appPath: '/Applications/Visual Studio Code.app',
        iconDataUrl: 'data:image/png;base64,vscode',
      },
      {
        name: 'Xcode',
        source: 'app',
        appPath: '/Applications/Xcode.app',
        iconDataUrl: 'data:image/png;base64,xcode',
      },
    ])
  })

  test('given 记住的应用占位项随后补上真实路径 when 合并选项 then 仍只保留一项', () => {
    expect(mergeOpenAppOptions([
      placeholderAppInfo('Xcode'),
      { name: 'Xcode', appPath: '/Applications/Xcode.app', iconDataUrl: 'data:image/png;base64,xcode' },
      vsCode,
    ])).toEqual([
      {
        name: 'Xcode',
        source: 'app',
        appPath: '/Applications/Xcode.app',
        iconDataUrl: 'data:image/png;base64,xcode',
      },
      {
        name: 'Visual Studio Code',
        source: 'app',
        appPath: '/Applications/Visual Studio Code.app',
        iconDataUrl: 'data:image/png;base64,vscode',
      },
    ])
  })

  test('given 同一应用路径重复 when 合并选项 then 按路径去重', () => {
    expect(mergeOpenAppOptions([vsCode, vsCode, cursor])).toEqual([
      {
        name: 'Visual Studio Code',
        source: 'app',
        appPath: '/Applications/Visual Studio Code.app',
        iconDataUrl: 'data:image/png;base64,vscode',
      },
      {
        name: 'Cursor',
        source: 'app',
        appPath: '/Applications/Cursor.app',
        iconDataUrl: 'data:image/png;base64,cursor',
      },
    ])
  })
})

describe('resolvePreferredOpenApp', () => {
  const options = mergeOpenAppOptions([vsCode, cursor, preview])

  test('given 记住的应用仍可用 when 解析偏好 then 选中该应用', () => {
    expect(resolvePreferredOpenApp(options, 'Cursor')?.name).toBe('Cursor')
  })

  test('given 记住的应用已卸载 when 解析偏好 then 回退到第一项', () => {
    expect(resolvePreferredOpenApp(options, 'Zed')?.name).toBe('Visual Studio Code')
  })

  test('given 没有偏好 when 解析偏好 then 使用第一项', () => {
    expect(resolvePreferredOpenApp(options, null)?.name).toBe('Visual Studio Code')
  })

  test('given 记住的应用尚未进入完整列表 when 解析偏好 then 仍能命中占位项', () => {
    const snapshot = mergeOpenAppOptions([
      placeholderAppInfo('Xcode'),
      vsCode,
    ])
    expect(resolvePreferredOpenApp(snapshot, 'Xcode')?.name).toBe('Xcode')
  })
})

describe('sameOpenApp', () => {
  test('given 同一应用路径 when 比较 then 视为同一项', () => {
    expect(sameOpenApp(
      { name: 'Xcode', appPath: '/Applications/Xcode.app', source: 'app' },
      { name: 'Xcode', appPath: '/Applications/Xcode.app', source: 'app', iconDataUrl: 'data:image/png;base64,xcode' },
    )).toBe(true)
  })
})

describe('resolveSystemOpenAppName', () => {
  const options = mergeOpenAppOptions([vsCode, cursor])
  const defaultOption = options[0]!
  const cursorOption = options[1]!

  test('given 打开探测到的应用 when 解析 IPC 参数 then 传入应用路径', () => {
    expect(resolveSystemOpenAppName(defaultOption)).toBe('/Applications/Visual Studio Code.app')
    expect(resolveSystemOpenAppName(cursorOption)).toBe('/Applications/Cursor.app')
  })

  test('given 系统默认入口 when 解析 IPC 参数 then 不传 appName', () => {
    expect(resolveSystemOpenAppName({
      name: SYSTEM_DEFAULT_OPEN_APP_NAME,
      source: 'system',
    })).toBeUndefined()
  })
})
