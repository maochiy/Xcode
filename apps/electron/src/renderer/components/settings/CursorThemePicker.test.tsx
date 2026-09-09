import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CursorThemePicker, CURSOR_THEME_OPTIONS } from './CursorThemePicker'

describe('Cursor 主题选择', () => {
  test('Given 用户打开外观设置 When 展示配色 Then 只提供五套 Cursor 主题', () => {
    const html = renderToStaticMarkup(<CursorThemePicker selectedStyle="cursor-dark" onSelect={() => {}} />)
    expect(CURSOR_THEME_OPTIONS).toHaveLength(5)
    expect(html.match(/aria-label="Cursor (?:Dark|Light)[^"]*"/g)).toHaveLength(5)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).not.toMatch(/ocean|forest|slate|terminal|云朵舞者|特殊风格/)
  })

  test('Given 选择任意 Cursor 主题 When 渲染预览 Then 使用对应真实主题 token 并正确标记选中项', () => {
    for (const theme of CURSOR_THEME_OPTIONS) {
      const html = renderToStaticMarkup(<CursorThemePicker selectedStyle={theme.id} onSelect={() => {}} />)
      expect(html).toContain(`aria-pressed="true" aria-label="${theme.name}"`)
      expect(html).toContain(`theme-${theme.id}`)
      expect(html).toContain('var(--content-area)')
      expect(html).not.toContain('<img')
    }
  })

  test('Given 配色正在保存 When 展示主题 Then 禁用重复提交且保留键盘焦点样式', () => {
    const html = renderToStaticMarkup(<CursorThemePicker selectedStyle="cursor-light" disabled onSelect={() => {}} />)
    expect(html.match(/disabled=""/g)).toHaveLength(5)
    expect(html).toContain('focus-visible:ring-2')
    expect(html).toContain('focus-visible:ring-offset-2')
  })
})
