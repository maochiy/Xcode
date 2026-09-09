/**
 * 主题配置与兼容迁移
 *
 * `default` 仅作为普通 light / dark / system 模式的内部哨兵值；
 * Cursor 特殊主题使用各自明确的 style。
 */

/** 主题模式 */
export type ThemeMode = 'light' | 'dark' | 'system' | 'special'

/** 所有合法主题风格值 */
export const THEME_STYLES = [
  'default',
  'cursor-dark',
  'cursor-light',
  'cursor-midnight-dark',
  'cursor-high-contrast-dark',
  'cursor-colorblind-light',
] as const

/** 主题风格 */
export type ThemeStyle = (typeof THEME_STYLES)[number]

/** 默认主题模式 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

/** 默认主题风格 */
export const DEFAULT_THEME_STYLE: ThemeStyle = 'default'

/** 旧版特殊主题，用于配置与 DOM class 迁移。 */
export const LEGACY_THEME_STYLES = [
  'ocean-light',
  'ocean-dark',
  'forest-light',
  'forest-dark',
  'slate-light',
  'slate-dark',
  'terminal-dark',
] as const

type LegacyThemeStyle = (typeof LEGACY_THEME_STYLES)[number]

const THEME_MODE_SET: ReadonlySet<string> = new Set([
  'light',
  'dark',
  'system',
  'special',
])

const THEME_STYLE_SET: ReadonlySet<string> = new Set(THEME_STYLES)
const LEGACY_LIGHT_THEME_STYLE_SET: ReadonlySet<string> = new Set(
  LEGACY_THEME_STYLES.filter((style) => style.endsWith('-light'))
)

export interface ThemeSelection {
  themeMode: ThemeMode
  themeStyle: ThemeStyle
}

/** 判断运行时值是否为合法主题模式。 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODE_SET.has(value)
}

/** 判断运行时值是否为合法主题风格。 */
export function isThemeStyle(value: unknown): value is ThemeStyle {
  return typeof value === 'string' && THEME_STYLE_SET.has(value)
}

/** 判断运行时值是否为旧版浅色特殊主题。 */
function isLegacyLightThemeStyle(value: unknown): value is LegacyThemeStyle {
  return typeof value === 'string' && LEGACY_LIGHT_THEME_STYLE_SET.has(value)
}

/**
 * 规范化主题选择。
 *
 * - 普通模式始终使用内部 `default` style。
 * - 合法 Cursor 特殊主题保持不变。
 * - 旧版浅色特殊主题迁移到 Cursor Light。
 * - 其余旧版或非法特殊主题迁移到 Cursor Dark。
 */
export function normalizeThemeSelection(
  themeMode: unknown,
  themeStyle: unknown
): ThemeSelection {
  if (!isThemeMode(themeMode)) {
    return {
      themeMode: DEFAULT_THEME_MODE,
      themeStyle: DEFAULT_THEME_STYLE,
    }
  }

  if (themeMode !== 'special') {
    return {
      themeMode,
      themeStyle: DEFAULT_THEME_STYLE,
    }
  }

  if (isThemeStyle(themeStyle) && themeStyle !== DEFAULT_THEME_STYLE) {
    return {
      themeMode,
      themeStyle,
    }
  }

  if (isLegacyLightThemeStyle(themeStyle)) {
    return {
      themeMode: 'light',
      themeStyle: DEFAULT_THEME_STYLE,
    }
  }

  return {
    themeMode: 'dark',
    themeStyle: DEFAULT_THEME_STYLE,
  }
}

/** 解析最终应使用的浅色或深色基调。 */
export function resolveThemeAppearance(
  themeMode: ThemeMode,
  themeStyle: ThemeStyle,
  systemIsDark: boolean
): 'light' | 'dark' {
  if (themeMode === 'system') {
    return systemIsDark ? 'dark' : 'light'
  }
  if (themeMode === 'special') {
    return themeStyle.endsWith('-light') ? 'light' : 'dark'
  }
  return themeMode
}
