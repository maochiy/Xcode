import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

describe('右侧面板拖拽与横向滚动', () => {
  test('Given 内置浏览器覆盖右侧面板 When 拖动手柄 Then 捕获指针并暂时关闭 webview 命中', () => {
    const appShellSource = readSource('./AppShell.tsx')
    const sidePanelSource = readSource('../agent/SidePanel.tsx')

    expect(appShellSource).toContain('onPointerDown={handleMouseDown}')
    expect(appShellSource).toContain("handle.setPointerCapture(e.pointerId)")
    expect(appShellSource).toContain("document.querySelectorAll('webview, iframe')")
    expect(appShellSource).toContain("el.style.pointerEvents = 'none'")
    expect(appShellSource).toContain('relative z-[80] w-2 flex-shrink-0 self-stretch cursor-col-resize')
    expect(appShellSource).not.toContain("-translate-x-1/2 cursor-col-resize")
    expect(appShellSource).toContain('MIN_MAIN_AREA_WIDTH')
    expect(appShellSource).toContain('rightPanelMaxWidth')
    expect(appShellSource).not.toContain('AGENT_SIDE_PANEL_MAX_WIDTH')
    expect(sidePanelSource).not.toContain("isActiveBrowserTab && 'left-2'")
    expect(sidePanelSource).toContain('!launcherVisible && isActiveBrowserTab')
    expect(sidePanelSource).toContain("active ? 'block' : 'hidden'")
  })

  test('Given 工作区文件和文件改动列表过长 When 鼠标移入 Then 显示横向滚动条', () => {
    const stylesSource = readSource('../../styles/globals.css')
    const sidePanelSource = readSource('../agent/SidePanel.tsx')
    const fileBrowserSource = readSource('../file-browser/FileBrowser.tsx')
    const changesSource = readSource('../diff/DiffChangesList.tsx')
    const browserPreloadSource = readFileSync(new URL('../../../../resources/browser/browser-preload.cjs', import.meta.url), 'utf8')

    expect(stylesSource).toContain('body .hover-scrollbar-xy::-webkit-scrollbar')
    expect(stylesSource).toContain('scrollbar-color: transparent transparent !important')
    expect(stylesSource).toContain('body .hover-scrollbar-xy:hover::-webkit-scrollbar-thumb')
    expect(stylesSource).toContain('height: 8px !important')
    expect(sidePanelSource).toContain('hover-scrollbar-xy min-h-0 min-w-0 flex-1')
    expect(fileBrowserSource).toContain('file-tree-guide-scope inline-block min-w-full py-1')
    expect(fileBrowserSource).toContain('shrink-0 whitespace-nowrap text-xs')
    expect(changesSource).toContain('hover-scrollbar-xy min-h-0 min-w-0 flex-1')
    expect(changesSource).toContain('whitespace-nowrap')
    expect(browserPreloadSource).toContain('proma-hover-h-scrollbar')
    expect(browserPreloadSource).toContain('min-width: 1100px !important')
    expect(browserPreloadSource).toContain('proma-show-scrollbars')
    expect(browserPreloadSource).toContain('scrollbar-width: none !important')
    expect(browserPreloadSource).toContain("ipcRenderer.on('proma-browser:set-scrollbar-visible'")
    expect(browserPreloadSource).toContain('setDocumentScrollbarsVisible(visible === true)')
    expect(browserPreloadSource).not.toContain("window.addEventListener('pointermove', showDocumentScrollbars")
    expect(browserPreloadSource).not.toContain("window.addEventListener('pointerleave', hideDocumentScrollbarsSoon")
    expect(browserPreloadSource).not.toContain('*:not(html):not(body)')
    expect(sidePanelSource).toContain('hover-scrollbar-xy min-h-0 min-w-0 flex-1')
    const browserPanelSource = readSource('../agent/BrowserPanel.tsx')
    expect(browserPanelSource).toContain('BROWSER_IPC_CHANNELS.SET_SCROLLBAR_VISIBLE')
    expect(browserPanelSource).toContain("guest.addEventListener('pointerenter', handlePointerEnter)")
    expect(browserPanelSource).toContain("guest.addEventListener('pointerleave', handlePointerLeave)")
  })
})
