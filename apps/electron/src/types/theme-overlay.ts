import {
  normalizeThemeSelection,
  resolveThemeAppearance,
  type ThemeMode,
  type ThemeStyle,
} from './theme'

export interface ThemeOverlayColors {
  color: string
  symbolColor: string
  height: number
}

interface ThemeOverlayPalette {
  color: string
  symbolColor: string
}

const OVERLAY_HEIGHT = 40

// 与 Cursor 官方主题的 tab.inactiveBackground / foreground 保持一致。
const CURSOR_LIGHT_OVERLAY: ThemeOverlayPalette = {
  color: '#F3F3F3',
  symbolColor: '#141414',
}

const CURSOR_DARK_OVERLAY: ThemeOverlayPalette = {
  color: '#141414',
  symbolColor: '#F0F0F0',
}

const SPECIAL_THEME_COLORS: Partial<Record<ThemeStyle, ThemeOverlayPalette>> = {
  'cursor-light': CURSOR_LIGHT_OVERLAY,
  'cursor-dark': CURSOR_DARK_OVERLAY,
  'cursor-midnight-dark': {
    color: '#191c22',
    symbolColor: '#7b88a1',
  },
  'cursor-high-contrast-dark': {
    color: '#0A0A0A',
    symbolColor: '#F0F0F0',
  },
  'cursor-colorblind-light': CURSOR_LIGHT_OVERLAY,
}

export function resolveOverlayColors(
  themeMode: ThemeMode,
  themeStyle: ThemeStyle | undefined,
  systemIsDark: boolean
): ThemeOverlayColors {
  const selection = normalizeThemeSelection(themeMode, themeStyle)
  let colors: ThemeOverlayPalette | undefined

  if (selection.themeMode === 'special') {
    colors = SPECIAL_THEME_COLORS[selection.themeStyle]
  }

  colors ??= resolveThemeAppearance(
    selection.themeMode,
    selection.themeStyle,
    systemIsDark
  ) === 'dark'
    ? CURSOR_DARK_OVERLAY
    : CURSOR_LIGHT_OVERLAY

  return {
    color: colors.color,
    symbolColor: colors.symbolColor,
    height: OVERLAY_HEIGHT,
  }
}
