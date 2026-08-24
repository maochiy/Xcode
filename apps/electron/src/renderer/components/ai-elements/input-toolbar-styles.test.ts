import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  inputAreaFadeClass,
  inputCardClass,
} from './input-toolbar-styles'

const globalsCss = readFileSync(
  new URL('../../styles/globals.css', import.meta.url),
  'utf8',
)

describe('输入框容器样式', () => {
  test('应强制保留 Codex 风格的 20px 大圆角', () => {
    expect(inputCardClass).toContain('!rounded-[20px]')
  })

  test('输入卡片应显式使用输入区表面色，不依赖 DOM 子元素顺序', () => {
    expect(inputCardClass).toContain('input-surface-card')
    expect(inputCardClass).toContain('bg-[hsl(var(--input-surface))]')
    expect(inputCardClass).not.toContain('bg-background')
  })

  test('输入区上方遮罩应与聊天内容区同色，避免深色主题出现横向色带', () => {
    expect(inputAreaFadeClass).toContain('before:from-content-area')
    expect(inputAreaFadeClass).toContain('before:via-content-area/85')
    expect(inputAreaFadeClass).not.toContain('before:from-background')
  })

  test('主题覆盖应定位真实输入卡片，不应依赖第一个子元素', () => {
    expect(globalsCss).not.toContain('[data-input-mode] > div:first-child')
    expect(globalsCss).toContain('.ui-classic .input-surface-card')
    expect(globalsCss).toContain('.theme-terminal-dark .input-surface-card')
  })
})
