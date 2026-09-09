import { describe, expect, test } from 'bun:test'
import {
  normalizeThemeSelection,
  resolveThemeAppearance,
} from './theme'

describe('Cursor 主题配置迁移', () => {
  test('Given 合法 Cursor 特殊主题 When 规范化 Then 保留选择', () => {
    expect(normalizeThemeSelection('special', 'cursor-midnight-dark')).toEqual({
      themeMode: 'special',
      themeStyle: 'cursor-midnight-dark',
    })
    expect(normalizeThemeSelection('special', 'cursor-colorblind-light')).toEqual({
      themeMode: 'special',
      themeStyle: 'cursor-colorblind-light',
    })
  })

  test('Given 旧版浅色特殊主题 When 规范化 Then 迁移到 Cursor Light 默认模式', () => {
    for (const style of ['ocean-light', 'forest-light', 'slate-light']) {
      expect(normalizeThemeSelection('special', style)).toEqual({
        themeMode: 'light',
        themeStyle: 'default',
      })
    }
  })

  test('Given 旧版深色或非法特殊主题 When 规范化 Then 迁移到 Cursor Dark 默认模式', () => {
    for (const style of ['ocean-dark', 'terminal-dark', 'unknown-light', undefined]) {
      expect(normalizeThemeSelection('special', style)).toEqual({
        themeMode: 'dark',
        themeStyle: 'default',
      })
    }
  })

  test('Given 普通模式携带遗留 style When 规范化 Then 使用 default 哨兵', () => {
    expect(normalizeThemeSelection('system', 'ocean-dark')).toEqual({
      themeMode: 'system',
      themeStyle: 'default',
    })
  })
})

describe('Cursor 主题明暗解析', () => {
  test('Given 跟随系统 When 系统变化 Then 映射 Cursor Light 或 Dark 基调', () => {
    expect(resolveThemeAppearance('system', 'default', false)).toBe('light')
    expect(resolveThemeAppearance('system', 'default', true)).toBe('dark')
  })

  test('Given Cursor 特殊主题 When 解析 Then 按后缀识别明暗', () => {
    expect(resolveThemeAppearance('special', 'cursor-light', true)).toBe('light')
    expect(resolveThemeAppearance('special', 'cursor-colorblind-light', true)).toBe('light')
    expect(resolveThemeAppearance('special', 'cursor-dark', false)).toBe('dark')
    expect(resolveThemeAppearance('special', 'cursor-midnight-dark', false)).toBe('dark')
  })
})
