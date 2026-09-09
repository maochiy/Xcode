/**
 * 文件「用哪个应用打开」的选项合并与偏好记忆。
 *
 * 候选项来自系统为该文件类型登记的可打开应用；用户选过的应用按后缀记住。
 */

import type { DefaultAppInfo } from '@proma/shared'

export type OpenAppSource = 'app' | 'system'

export interface OpenAppOption {
  name: string
  appPath?: string
  iconDataUrl?: string
  source: OpenAppSource
}

export const SYSTEM_DEFAULT_OPEN_APP_NAME = '系统默认应用'
const STORAGE_KEY = 'proma.open-app-preference'
const IGNORED_OPEN_APP_NAMES = new Set([
  SYSTEM_DEFAULT_OPEN_APP_NAME,
  'Finder',
  'Proma',
  'Xcodes',
  'Xcode-Desktop',
  'Google Chrome',
  'Safari',
  'Firefox',
  'Microsoft Edge',
  'Quark',
  'Microsoft Excel',
  'Microsoft Word',
  'Microsoft PowerPoint',
  'Numbers',
  'Pages',
  'Keynote',
  'Notes',
  'Instruments',
  'LibreOffice',
  'LibreOfficeDev',
])

export function fileExtKey(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : base
}

function iconKey(appPath?: string, name?: string): string {
  return (appPath || name || '').trim().toLowerCase()
}

/** 同一应用在不同文件里应显示同一套图标；有图标的记录会补到缺失项上。 */
export function hydrateOpenAppIcons(
  apps: DefaultAppInfo[],
  knownIcons: Map<string, string> = new Map(),
): DefaultAppInfo[] {
  for (const app of apps) {
    if (!app.iconDataUrl) continue
    knownIcons.set(iconKey(app.appPath, app.name), app.iconDataUrl)
    if (app.name) knownIcons.set(iconKey(undefined, app.name), app.iconDataUrl)
  }
  return apps.map((app) => {
    if (app.iconDataUrl) return app
    const icon = knownIcons.get(iconKey(app.appPath, app.name)) || knownIcons.get(iconKey(undefined, app.name))
    return icon ? { ...app, iconDataUrl: icon } : app
  })
}

export function placeholderAppInfo(name: string): DefaultAppInfo {
  return { name, appPath: '', iconDataUrl: '' }
}

export function mergeOpenAppOptions(apps: DefaultAppInfo[]): OpenAppOption[] {
  const options: OpenAppOption[] = []
  const seen = new Set<string>()
  const hydrated = hydrateOpenAppIcons(apps)

  const add = (name: string, source: OpenAppSource, appPath?: string, iconDataUrl?: string): void => {
    const key = name.trim().toLowerCase()
    if (!key) return
    const existing = options.find((item) => item.name.toLowerCase() === key)
    if (existing) {
      if (!existing.appPath && appPath) existing.appPath = appPath
      if (!existing.iconDataUrl && iconDataUrl) existing.iconDataUrl = iconDataUrl
      return
    }
    seen.add(key)
    options.push({
      name,
      source,
      ...(appPath ? { appPath } : {}),
      ...(iconDataUrl ? { iconDataUrl } : {}),
    })
  }

  for (const app of hydrated) {
    if (!app.name || IGNORED_OPEN_APP_NAMES.has(app.name)) continue
    if (/(?:^|[\\/])Xcode-Desktop\.app(?:[\\/]|$)/i.test(app.appPath)) continue
    add(app.name, 'app', app.appPath, app.iconDataUrl)
  }

  return options
}

export function sameOpenApp(a: OpenAppOption | null | undefined, b: OpenAppOption | null | undefined): boolean {
  if (!a || !b) return false
  if (a.appPath && b.appPath) return a.appPath.toLowerCase() === b.appPath.toLowerCase()
  return a.name.toLowerCase() === b.name.toLowerCase()
}

export function resolvePreferredOpenApp(
  options: OpenAppOption[],
  preferredName: string | null | undefined,
): OpenAppOption | null {
  if (options.length === 0) return null
  if (preferredName) {
    const needle = preferredName.trim().toLowerCase()
    const matched = options.find((item) => (
      item.name.toLowerCase() === needle || item.appPath?.toLowerCase() === needle
    ))
    if (matched) return matched
  }
  return options[0] ?? null
}

function readPreferenceMap(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

export function getStoredPreferredOpenApp(filePath: string): string | null {
  const value = readPreferenceMap()[fileExtKey(filePath)]
  if (!value || IGNORED_OPEN_APP_NAMES.has(value)) return null
  return value
}

export function saveStoredPreferredOpenApp(filePath: string, appName: string): void {
  if (typeof localStorage === 'undefined' || !appName || IGNORED_OPEN_APP_NAMES.has(appName)) return
  const next = {
    ...readPreferenceMap(),
    [fileExtKey(filePath)]: appName,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式或配额满时忽略，不影响本次打开
  }
}

/** 指定应用时优先传路径，让主进程按路径打开；系统入口不传 appName。 */
export function resolveSystemOpenAppName(option: OpenAppOption): string | undefined {
  if (option.source !== 'app') return undefined
  return option.appPath || option.name
}
