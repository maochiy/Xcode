import { describe, expect, test } from 'bun:test'
import {
  getConfigDirectoryName,
  getLegacyConfigDirectoryName,
  isDevelopmentConfigRequested,
} from './index'

describe('Xcode 配置目录命名', () => {
  test('Given 正式与开发模式 When 解析当前目录 Then 使用无点且带 s 的 xcodes 名称', () => {
    expect(getConfigDirectoryName(false)).toBe('xcodes')
    expect(getConfigDirectoryName(true)).toBe('xcodes-dev')
  })

  test('Given 正式与开发模式 When 解析旧目录 Then 仅用于 .proma 兼容迁移', () => {
    expect(getLegacyConfigDirectoryName(false)).toBe('.proma')
    expect(getLegacyConfigDirectoryName(true)).toBe('.proma-dev')
  })

  test('Given 新旧开发环境变量 When 判断开发目录 Then 两种启动方式都兼容', () => {
    expect(isDevelopmentConfigRequested({ XCODE_DEV: '1' })).toBe(true)
    expect(isDevelopmentConfigRequested({ PROMA_DEV: '1' })).toBe(true)
    expect(isDevelopmentConfigRequested({ XCODE_DEV: '0', PROMA_DEV: '0' })).toBe(false)
  })
})
