/**
 * 文件「用哪个应用打开」的候选项过滤。
 *
 * macOS LaunchServices 会把任意能打开 public.text 的应用都塞进来，
 * 例如 Chrome / Excel / 备忘录。打开源码文件时只保留编辑器，
 * 避免不同后缀列表长短差一截。
 */

export const KNOWN_EDITORS = [
  'Visual Studio Code', 'Cursor', 'Sublime Text', 'Windsurf',
  'Zed', 'CotEditor', 'IntelliJ IDEA', 'Xcode', 'TextEdit',
  'Typora', 'BBEdit', 'Nova', 'WebStorm', 'PyCharm',
] as const

export const IGNORED_OPEN_APP_NAMES = new Set([
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

const EDITOR_NAME_HINTS = [
  'code',
  'cursor',
  'xcode',
  'sublime',
  'zed',
  'vim',
  'nvim',
  'emacs',
  'nova',
  'bbedit',
  'coteditor',
  'typora',
  'textedit',
  'notepad',
  'idea',
  'webstorm',
  'pycharm',
  'goland',
  'rider',
  'android studio',
  'windsurf',
]

const EDITOR_PATH_HINTS = [
  '/applications/visual studio code.app',
  '/applications/cursor.app',
  '/applications/xcode.app',
  '/system/applications/textedit.app',
  '/applications/sublime text.app',
  '/applications/zed.app',
  '/applications/typora.app',
]

export function isKnownEditorName(name: string): boolean {
  const needle = name.trim().toLowerCase()
  return KNOWN_EDITORS.some((item) => item.toLowerCase() === needle)
}

export function isIgnoredOpenAppName(name: string): boolean {
  return IGNORED_OPEN_APP_NAMES.has(name)
}

export function isEditorLikeApp(name: string, appPath?: string): boolean {
  const normalizedName = name.trim().toLowerCase()
  if (!normalizedName) return false
  if (isIgnoredOpenAppName(name)) return false
  // 显示名相同，按独立 Bundle 路径区分本应用与 Apple Xcode。
  if (/(?:^|[\\/])Xcode-Desktop\.app(?:[\\/]|$)/i.test(appPath ?? '')) return false
  if (isKnownEditorName(name)) return true
  if (EDITOR_NAME_HINTS.some((hint) => normalizedName.includes(hint))) return true
  const normalizedPath = (appPath ?? '').trim().toLowerCase()
  return EDITOR_PATH_HINTS.some((hint) => normalizedPath.includes(hint))
}

export function rankOpenApps<T extends { name: string; appPath: string }>(
  apps: T[],
  defaultAppPath?: string,
): T[] {
  const knownIndex = new Map(KNOWN_EDITORS.map((name, index) => [name.toLowerCase(), index]))
  const defaultKey = defaultAppPath?.toLowerCase()
  return [...apps].sort((a, b) => {
    const aDefault = defaultKey && a.appPath.toLowerCase() === defaultKey ? 0 : 1
    const bDefault = defaultKey && b.appPath.toLowerCase() === defaultKey ? 0 : 1
    if (aDefault !== bDefault) return aDefault - bDefault
    const aKnown = knownIndex.get(a.name.toLowerCase()) ?? KNOWN_EDITORS.length
    const bKnown = knownIndex.get(b.name.toLowerCase()) ?? KNOWN_EDITORS.length
    if (aKnown !== bKnown) return aKnown - bKnown
    return a.name.localeCompare(b.name)
  })
}
