/**
 * 主题状态原子
 *
 * 管理应用主题模式（浅色/深色/跟随系统/特殊风格）和特殊风格。
 * - themeModeAtom: 用户选择的主题模式，持久化到 ~/.proma/settings.json
 * - themeStyleAtom: 特殊风格主题
 * - systemIsDarkAtom: 系统当前是否为深色模式
 * - resolvedThemeAtom: 派生的最终主题（light | dark）
 *
 * 使用 localStorage 作为缓存，避免页面加载时闪烁。
 */

import { atom } from 'jotai'
import {
  DEFAULT_INTERFACE_VARIANT,
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_STYLE,
  normalizeThemeSelection,
  resolveThemeAppearance,
  type InterfaceVariant,
  type ThemeMode,
  type ThemeStyle,
} from '../../types'

/** localStorage 缓存键 */
const THEME_CACHE_KEY = 'proma-theme-mode'
const THEME_STYLE_CACHE_KEY = 'proma-theme-style'
const INTERFACE_VARIANT_CACHE_KEY = 'proma-interface-variant'

/** 从 localStorage 读取并迁移缓存的主题选择。 */
function getCachedThemeSelection(): { themeMode: ThemeMode; themeStyle: ThemeStyle } {
  try {
    return normalizeThemeSelection(
      localStorage.getItem(THEME_CACHE_KEY),
      localStorage.getItem(THEME_STYLE_CACHE_KEY)
    )
  } catch {
    // localStorage 不可用时忽略
  }
  return {
    themeMode: DEFAULT_THEME_MODE,
    themeStyle: DEFAULT_THEME_STYLE,
  }
}

/**
 * 从 localStorage 读取缓存的界面风格
 */
function getCachedInterfaceVariant(): InterfaceVariant {
  try {
    const cached = localStorage.getItem(INTERFACE_VARIANT_CACHE_KEY)
    if (cached === 'classic' || cached === 'modern') {
      return cached
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return DEFAULT_INTERFACE_VARIANT
}

/**
 * 缓存主题模式到 localStorage
 */
function cacheThemeSelection(mode: ThemeMode, style: ThemeStyle): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, mode)
    localStorage.setItem(THEME_STYLE_CACHE_KEY, style)
  } catch {
    // localStorage 不可用时忽略
  }
}

/**
 * 缓存界面风格到 localStorage
 */
function cacheInterfaceVariant(variant: InterfaceVariant): void {
  try {
    localStorage.setItem(INTERFACE_VARIANT_CACHE_KEY, variant)
  } catch {
    // localStorage 不可用时忽略
  }
}

const cachedThemeSelection = getCachedThemeSelection()

/** 用户选择的主题模式 */
export const themeModeAtom = atom<ThemeMode>(cachedThemeSelection.themeMode)

/** 用户选择的特殊风格 */
export const themeStyleAtom = atom<ThemeStyle>(cachedThemeSelection.themeStyle)

/** 用户选择的界面风格 */
export const interfaceVariantAtom = atom<InterfaceVariant>(getCachedInterfaceVariant())

/** 系统当前是否为深色模式 */
export const systemIsDarkAtom = atom<boolean>(true)

/** 派生：最终解析的主题（light | dark） */
export const resolvedThemeAtom = atom<'light' | 'dark'>((get) => {
  return resolveThemeAppearance(
    get(themeModeAtom),
    get(themeStyleAtom),
    get(systemIsDarkAtom)
  )
})

/**
 * 应用主题到 DOM
 *
 * 在 <html> 元素上切换 dark 类名和特殊风格类名。
 *
 * 幂等实现：先计算目标 class 状态，与当前 DOM 对比，一致时直接 return，
 * 不触发任何 classList mutation。避免与 vibrancy 合成层叠加
 * 导致 Chromium 重建合成层造成的全屏闪烁。
 */
export function applyThemeToDOM(
  themeMode: ThemeMode,
  themeStyle: ThemeStyle = DEFAULT_THEME_STYLE,
  systemIsDark: boolean = true
): void {
  const html = document.documentElement
  const selection = normalizeThemeSelection(themeMode, themeStyle)

  // 计算目标状态
  const targetStyleClass = selection.themeMode === 'special'
    ? `theme-${selection.themeStyle}`
    : null
  const targetIsDark = resolveThemeAppearance(
    selection.themeMode,
    selection.themeStyle,
    systemIsDark
  ) === 'dark'

  // 读取当前状态
  const currentIsDark = html.classList.contains('dark')
  const currentStyleClasses = Array.from(html.classList)
    .filter((className) => className.startsWith('theme-'))
  const styleClassesMatch = targetStyleClass === null
    ? currentStyleClasses.length === 0
    : currentStyleClasses.length === 1 && currentStyleClasses[0] === targetStyleClass

  // 与目标一致 → 直接跳过，避免触发 CSS 重新级联
  if (currentIsDark === targetIsDark && styleClassesMatch) {
    return
  }

  if (!styleClassesMatch) {
    for (const className of currentStyleClasses) {
      if (className !== targetStyleClass) {
        html.classList.remove(className)
      }
    }
    if (targetStyleClass && !html.classList.contains(targetStyleClass)) {
      html.classList.add(targetStyleClass)
    }
  }
  if (currentIsDark !== targetIsDark) {
    html.classList.toggle('dark', targetIsDark)
  }
}

/**
 * 应用界面风格到 DOM
 */
export function applyInterfaceVariantToDOM(variant: InterfaceVariant = DEFAULT_INTERFACE_VARIANT): void {
  const html = document.documentElement
  const targetClass = variant === 'classic' ? 'ui-classic' : 'ui-modern'
  const currentClass = html.classList.contains('ui-classic')
    ? 'ui-classic'
    : html.classList.contains('ui-modern')
      ? 'ui-modern'
      : null

  if (currentClass === targetClass) {
    return
  }

  if (currentClass) {
    html.classList.remove(currentClass)
  }
  html.classList.add(targetClass)
}

/**
 * 初始化主题系统
 *
 * 从主进程加载设置，监听系统主题变化。
 * 返回清理函数。
 */
export async function initializeTheme(
  setThemeMode: (mode: ThemeMode) => void,
  setSystemIsDark: (isDark: boolean) => void,
  setThemeStyle?: (style: ThemeStyle) => void,
  setInterfaceVariant?: (variant: InterfaceVariant) => void,
): Promise<() => void> {
  // 从主进程加载持久化设置
  const settings = await window.electronAPI.getSettings()
  const themeSelection = normalizeThemeSelection(settings.themeMode, settings.themeStyle)
  setThemeMode(themeSelection.themeMode)
  if (setThemeStyle) {
    setThemeStyle(themeSelection.themeStyle)
  }
  cacheThemeSelection(themeSelection.themeMode, themeSelection.themeStyle)

  const interfaceVariant = settings.interfaceVariant || DEFAULT_INTERFACE_VARIANT
  if (setInterfaceVariant) {
    setInterfaceVariant(interfaceVariant)
  }
  cacheInterfaceVariant(interfaceVariant)

  // 获取系统主题
  const isDark = await window.electronAPI.getSystemTheme()
  setSystemIsDark(isDark)

  // 监听系统主题变化
  const cleanupSystem = window.electronAPI.onSystemThemeChanged((newIsDark) => {
    setSystemIsDark(newIsDark)
  })

  // 监听用户手动切换主题（跨窗口同步，如 Quick Task 面板）
  const cleanupThemeSettings = window.electronAPI.onThemeSettingsChanged((payload) => {
    const selection = normalizeThemeSelection(payload.themeMode, payload.themeStyle)
    const variant = (payload.interfaceVariant || DEFAULT_INTERFACE_VARIANT) as InterfaceVariant
    setThemeMode(selection.themeMode)
    if (setThemeStyle) {
      setThemeStyle(selection.themeStyle)
    }
    cacheThemeSelection(selection.themeMode, selection.themeStyle)
    if (setInterfaceVariant) {
      setInterfaceVariant(variant)
      cacheInterfaceVariant(variant)
    }
  })

  return () => {
    cleanupSystem()
    cleanupThemeSettings()
  }
}

/**
 * 原子更新主题选择并持久化。
 *
 * 仅在主进程写入成功后更新 localStorage，失败时由调用方回滚 atoms / DOM。
 */
export async function updateThemeSelection(
  mode: ThemeMode,
  style: ThemeStyle
): Promise<void> {
  const updated = await window.electronAPI.updateSettings({
    themeMode: mode,
    themeStyle: style,
  })
  const selection = normalizeThemeSelection(updated.themeMode, updated.themeStyle)
  cacheThemeSelection(selection.themeMode, selection.themeStyle)
}

/**
 * 更新主题模式并持久化。
 *
 * @deprecated 请优先使用 updateThemeSelection，避免跨窗口收到中间状态。
 */
export async function updateThemeMode(mode: ThemeMode): Promise<void> {
  const updated = await window.electronAPI.updateSettings({ themeMode: mode })
  const selection = normalizeThemeSelection(updated.themeMode, updated.themeStyle)
  cacheThemeSelection(selection.themeMode, selection.themeStyle)
}

/**
 * 更新特殊风格并持久化。
 *
 * @deprecated 请优先使用 updateThemeSelection，避免跨窗口收到中间状态。
 */
export async function updateThemeStyle(style: ThemeStyle): Promise<void> {
  const updated = await window.electronAPI.updateSettings({ themeStyle: style })
  const selection = normalizeThemeSelection(updated.themeMode, updated.themeStyle)
  cacheThemeSelection(selection.themeMode, selection.themeStyle)
}

/**
 * 更新界面风格并持久化
 */
export async function updateInterfaceVariant(variant: InterfaceVariant): Promise<void> {
  cacheInterfaceVariant(variant)
  await window.electronAPI.updateSettings({ interfaceVariant: variant })
}
