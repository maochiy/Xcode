/**
 * useAvailableOpenApps — 某个文件可用的打开应用列表。
 *
 * 组合：系统为该文件登记的应用 + 本机已安装编辑器。
 * 打开瞬间先用缓存 / 记住的应用占位，避免先闪默认应用再切过去。
 */

import * as React from 'react'
import type { DefaultAppInfo, EditorApp, FileAccessOptions } from '@proma/shared'
import {
  getStoredPreferredOpenApp,
  hydrateOpenAppIcons,
  mergeOpenAppOptions,
  placeholderAppInfo,
  resolvePreferredOpenApp,
  resolveSystemOpenAppName,
  saveStoredPreferredOpenApp,
  type OpenAppOption,
} from '@/lib/open-app-preference'

const appsCache = new Map<string, DefaultAppInfo[]>()
const appIconCache = new Map<string, string>()
let editorsCache: EditorApp[] | undefined
let editorsPromise: Promise<EditorApp[]> | null = null

function extKeyOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : filePath
}

function toAppInfo(editor: EditorApp): DefaultAppInfo {
  return { name: editor.name, appPath: editor.path, iconDataUrl: '' }
}

function mergeAppInfos(groups: Array<DefaultAppInfo | null | undefined>): DefaultAppInfo[] {
  const apps: DefaultAppInfo[] = []
  const seen = new Set<string>()
  for (const app of groups) {
    if (!app?.name) continue
    const key = app.name.trim().toLowerCase()
    if (seen.has(key)) {
      const existing = apps.find((item) => item.name.toLowerCase() === key)
      if (existing) {
        if (!existing.appPath && app.appPath) existing.appPath = app.appPath
        if (!existing.iconDataUrl && app.iconDataUrl) existing.iconDataUrl = app.iconDataUrl
      }
      continue
    }
    seen.add(key)
    apps.push({ ...app })
  }
  return hydrateOpenAppIcons(apps, appIconCache)
}

function snapshotForFile(filePath: string): DefaultAppInfo[] {
  const cached = appsCache.get(extKeyOf(filePath))
  const preferred = getStoredPreferredOpenApp(filePath)
  const editors = (editorsCache ?? []).map(toAppInfo)

  // 记住的应用必须在第一帧就排在最前，否则会先画出系统默认应用再跳到偏好。
  if (cached && cached.length > 0) {
    return mergeAppInfos([
      preferred ? placeholderAppInfo(preferred) : null,
      ...cached,
      ...editors,
    ])
  }
  if (preferred) return mergeAppInfos([placeholderAppInfo(preferred), ...editors])

  // 没有缓存也没有偏好时保持空白，等完整列表回来再显示，避免先闪 VS Code。
  return []
}

function loadEditors(): Promise<EditorApp[]> {
  if (editorsCache) return Promise.resolve(editorsCache)
  if (!editorsPromise) {
    editorsPromise = (
      typeof window.electronAPI.scanEditors === 'function'
        ? window.electronAPI.scanEditors()
        : Promise.resolve([] as EditorApp[])
    )
      .then((list) => {
        editorsCache = list
        return list
      })
      .catch((err) => {
        console.warn('[useAvailableOpenApps] 扫描编辑器失败:', err)
        editorsPromise = null
        return []
      })
  }
  return editorsPromise
}

async function loadAppsForFile(
  filePath: string,
  access?: FileAccessOptions,
): Promise<DefaultAppInfo[]> {
  const api = window.electronAPI
  const [fileApps, defaultApp, editors] = await Promise.all([
    typeof api.getAppsForFile === 'function'
      ? api.getAppsForFile(filePath, access).catch((err) => {
          console.warn('[useAvailableOpenApps] getAppsForFile 失败:', err)
          return [] as DefaultAppInfo[]
        })
      : Promise.resolve([] as DefaultAppInfo[]),
    typeof api.getDefaultAppForFile === 'function'
      ? api.getDefaultAppForFile(filePath, access).catch(() => null)
      : Promise.resolve(null),
    loadEditors(),
  ])
  const preferred = getStoredPreferredOpenApp(filePath)
  return mergeAppInfos([
    preferred ? placeholderAppInfo(preferred) : null,
    defaultApp,
    ...fileApps,
    ...editors.map(toAppInfo),
  ])
}

function sameAppList(a: DefaultAppInfo[], b: DefaultAppInfo[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => {
    const other = b[index]
    if (!other) return false
    return item.name === other.name
      && item.appPath === other.appPath
      && item.iconDataUrl === other.iconDataUrl
  })
}

interface AppsState {
  path: string
  apps: DefaultAppInfo[]
}

export function useAvailableOpenApps(
  filePath: string | null | undefined,
  access?: FileAccessOptions,
): {
  options: OpenAppOption[]
  selected: OpenAppOption | null
  selectApp: (option: OpenAppOption) => void
  openWith: (option: OpenAppOption) => void
} {
  const path = filePath ?? ''
  const [appsState, setAppsState] = React.useState<AppsState>(() => ({
    path,
    apps: filePath ? snapshotForFile(filePath) : [],
  }))
  const accessRef = React.useRef(access)
  accessRef.current = access

  if (appsState.path !== path) {
    setAppsState({
      path,
      apps: filePath ? snapshotForFile(filePath) : [],
    })
  }

  const apps = appsState.path === path ? appsState.apps : (filePath ? snapshotForFile(filePath) : [])
  const preferredName = filePath ? getStoredPreferredOpenApp(filePath) : null
  const [, bumpPreferred] = React.useState(0)

  React.useEffect(() => {
    if (!filePath) return
    let cancelled = false
    const key = extKeyOf(filePath)

    loadAppsForFile(filePath, accessRef.current)
      .then((result) => {
        if (cancelled) return
        const hydrated = hydrateOpenAppIcons(result, appIconCache)
        appsCache.set(key, hydrated)
        setAppsState((prev) => {
          if (prev.path !== filePath) return prev
          if (sameAppList(prev.apps, hydrated)) return prev
          return { path: filePath, apps: hydrated }
        })
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[useAvailableOpenApps] 查询可打开应用失败:', err)
      })

    return () => {
      cancelled = true
    }
  }, [filePath])

  const options = React.useMemo(
    () => (apps.length > 0 ? mergeOpenAppOptions(apps) : []),
    [apps],
  )
  const selected = React.useMemo(
    () => resolvePreferredOpenApp(options, preferredName),
    [options, preferredName],
  )

  const selectApp = React.useCallback((option: OpenAppOption) => {
    if (!filePath) return
    saveStoredPreferredOpenApp(filePath, option.name)
    bumpPreferred((value) => value + 1)
  }, [filePath])

  const openWith = React.useCallback((option: OpenAppOption) => {
    if (!filePath) return
    selectApp(option)
    const appName = resolveSystemOpenAppName(option)
    window.electronAPI.systemOpenFile(filePath, appName, accessRef.current).catch((err) => {
      console.error('[useAvailableOpenApps] 打开文件失败:', err)
    })
  }, [filePath, selectApp])

  return { options, selected, selectApp, openWith }
}
