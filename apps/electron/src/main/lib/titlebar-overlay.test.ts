import { describe, expect, test } from 'bun:test'
import { resolveOverlayColors } from '../../types/theme-overlay'

describe('Windows titlebar Cursor 配色', () => {
  test('Given 普通和系统模式 When 解析 Then 使用 Cursor Light/Dark 官方颜色', () => {
    expect(resolveOverlayColors('light', 'default', true)).toEqual({
      color: '#F3F3F3',
      symbolColor: '#141414',
      height: 40,
    })
    expect(resolveOverlayColors('dark', 'default', false)).toEqual({
      color: '#141414',
      symbolColor: '#F0F0F0',
      height: 40,
    })
    expect(resolveOverlayColors('system', 'default', false).color).toBe('#F3F3F3')
    expect(resolveOverlayColors('system', 'default', true).color).toBe('#141414')
  })

  test('Given Cursor 特殊主题 When 解析 Then 与 TabBar token 保持一致', () => {
    expect(resolveOverlayColors('special', 'cursor-midnight-dark', false)).toEqual({
      color: '#191c22',
      symbolColor: '#7b88a1',
      height: 40,
    })
    expect(resolveOverlayColors('special', 'cursor-high-contrast-dark', false)).toEqual({
      color: '#0A0A0A',
      symbolColor: '#F0F0F0',
      height: 40,
    })
    expect(resolveOverlayColors('special', 'cursor-colorblind-light', true)).toEqual({
      color: '#F3F3F3',
      symbolColor: '#141414',
      height: 40,
    })
  })
})
