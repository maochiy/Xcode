import { BrowserWindow, nativeTheme } from 'electron'
import { resolveOverlayColors } from '../../types'
import { getSettings } from './settings-service'

export { resolveOverlayColors } from '../../types'

export function updateWindowTitleBarOverlay(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  if (win.isDestroyed()) return

  try {
    const settings = getSettings()
    const { color, symbolColor, height } = resolveOverlayColors(
      settings.themeMode,
      settings.themeStyle,
      nativeTheme.shouldUseDarkColors
    )
    win.setTitleBarOverlay({ color, symbolColor, height })
  } catch {
    // frameless 窗口（如 quick-task）不支持 setTitleBarOverlay，静默忽略
  }
}
