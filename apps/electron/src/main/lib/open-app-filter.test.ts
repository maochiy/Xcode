import { describe, expect, test } from 'bun:test'
import { isEditorLikeApp, rankOpenApps } from './open-app-filter'

describe('isEditorLikeApp', () => {
  test('Given 应用改名为 Xcode When 判断打开方式 Then 排除应用自身并保留 Xcode 编辑器', () => {
    expect(isEditorLikeApp('Xcode', '/Applications/Xcode-Desktop.app')).toBe(false)
    expect(isEditorLikeApp('Xcode', '/Applications/xcodes.app')).toBe(false)
    expect(isEditorLikeApp('Xcodes', '/Applications/Xcodes.app')).toBe(false)
    expect(isEditorLikeApp('xcodes', '')).toBe(false)
    expect(isEditorLikeApp('Proma', '/Applications/Proma.app')).toBe(false)
    expect(isEditorLikeApp('Xcode', '/Applications/Xcode.app')).toBe(true)
  })

  test('given 已知编辑器 when 判断候选项 then 保留', () => {
    expect(isEditorLikeApp('Visual Studio Code', '/Applications/Visual Studio Code.app')).toBe(true)
    expect(isEditorLikeApp('Xcode', '/Applications/Xcode.app')).toBe(true)
    expect(isEditorLikeApp('TextEdit', '/System/Applications/TextEdit.app')).toBe(true)
  })

  test('given 能打开文本的非编辑器 when 判断候选项 then 过滤', () => {
    expect(isEditorLikeApp('Google Chrome', '/Applications/Google Chrome.app')).toBe(false)
    expect(isEditorLikeApp('Microsoft Excel', '/Applications/Microsoft Excel.app')).toBe(false)
    expect(isEditorLikeApp('Notes', '/System/Applications/Notes.app')).toBe(false)
    expect(isEditorLikeApp('Quark', '/Applications/Quark.app')).toBe(false)
  })
})

describe('rankOpenApps', () => {
  test('given 系统默认应用和已知编辑器 when 排序 then 默认应用优先', () => {
    expect(rankOpenApps([
      { name: 'Visual Studio Code', appPath: '/Applications/Visual Studio Code.app' },
      { name: 'Xcode', appPath: '/Applications/Xcode.app' },
    ], '/Applications/Xcode.app').map((item) => item.name)).toEqual([
      'Xcode',
      'Visual Studio Code',
    ])
  })
})
