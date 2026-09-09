import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

describe('集成终端交互区域', () => {
  test('Given Windows 使用自定义标题栏 When 渲染右侧终端 Then 仅顶部可拖动且终端输入树保持 no-drag', () => {
    const sidePanelSource = readSource('./SidePanel.tsx')
    const stylesSource = readSource('../../styles/globals.css')

    expect(sidePanelSource).toContain(
      "'relative z-0 h-full flex-shrink-0 overflow-hidden bg-content-area'",
    )
    expect(sidePanelSource).not.toContain(
      "'relative z-0 h-full flex-shrink-0 overflow-hidden titlebar-drag-region bg-content-area'",
    )
    expect(stylesSource).toContain('.integrated-terminal-surface .xterm-helper-textarea')
    expect(stylesSource).toContain('-webkit-app-region: no-drag')
  })

  test('Given 从加号菜单新建终端 When 菜单关闭 Then 不抢回焦点并在挂载完成后重试聚焦', () => {
    const tabBarSource = readSource('../diff/DiffPanelTabBar.tsx')
    const terminalSource = readSource('./IntegratedTerminalPanel.tsx')
    const composerSource = readSource('../ai-elements/rich-text-input.tsx')
    const appShellSource = readSource('../app-shell/AppShell.tsx')

    expect(tabBarSource).toContain("preventAddMenuFocusRestoreRef.current = tab === 'terminal'")
    expect(tabBarSource).toContain('if (!preventAddMenuFocusRestoreRef.current) return')
    expect(tabBarSource).toContain('event.preventDefault()')
    expect(tabBarSource).toContain('data-side-panel-add-menu')
    expect(terminalSource).toContain('scheduleFocusRetries()')
    expect(terminalSource).toContain('INTEGRATED_TERMINAL_FOCUS_RETRY_DELAYS_MS')
    expect(terminalSource).toContain('.ProseMirror, [contenteditable="true"]')
    expect(terminalSource).toContain("host.addEventListener('pointerdown', focusTerminal, true)")
    expect(composerSource).toContain("active.closest('[data-codex-terminal]')")
    expect(appShellSource).toContain('clampedRightPanelWidth + (isPanelOpen ? RIGHT_PANEL_RESIZE_HANDLE_WIDTH : 0)')
  })
})
