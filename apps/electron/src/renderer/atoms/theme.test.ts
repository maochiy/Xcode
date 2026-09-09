import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AppSettings } from '../../types'
import {
  applyThemeToDOM,
  initializeTheme,
  updateThemeSelection,
} from './theme'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class FakeClassList implements Iterable<string> {
  private readonly classes = new Set<string>()
  mutationCount = 0

  constructor(initialClasses: readonly string[] = []) {
    for (const className of initialClasses) {
      this.classes.add(className)
    }
  }

  add(...tokens: string[]): void {
    for (const token of tokens) {
      if (!this.classes.has(token)) {
        this.classes.add(token)
        this.mutationCount += 1
      }
    }
  }

  contains(token: string): boolean {
    return this.classes.has(token)
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      if (this.classes.delete(token)) {
        this.mutationCount += 1
      }
    }
  }

  toggle(token: string, force?: boolean): boolean {
    const shouldAdd = force ?? !this.classes.has(token)
    if (shouldAdd) {
      this.add(token)
    } else {
      this.remove(token)
    }
    return shouldAdd
  }

  [Symbol.iterator](): Iterator<string> {
    return this.classes.values()
  }
}

const originalDocument = globalThis.document
const originalLocalStorage = globalThis.localStorage
const originalWindow = globalThis.window

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
})

afterAll(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: originalLocalStorage,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})

function installDocument(classList: FakeClassList): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { classList },
    } as unknown as Document,
  })
}

function installElectronApi(electronAPI: Partial<Window['electronAPI']>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI,
    } as unknown as Window & typeof globalThis,
  })
}

describe('主题 DOM 应用', () => {
  test('Given DOM 含旧版和重复主题 class When 应用 Cursor 主题 Then 幂等清理遗留 class', () => {
    const classList = new FakeClassList([
      'dark',
      'theme-ocean-dark',
      'theme-cursor-light',
      'proma-main-window',
    ])
    installDocument(classList)

    applyThemeToDOM('special', 'cursor-colorblind-light', true)

    expect(Array.from(classList)).toEqual([
      'proma-main-window',
      'theme-cursor-colorblind-light',
    ])
    const mutationCount = classList.mutationCount

    applyThemeToDOM('special', 'cursor-colorblind-light', false)

    expect(classList.mutationCount).toBe(mutationCount)
  })
})

describe('主题缓存与跨窗口同步', () => {
  test('Given 主进程写入成功 When 原子更新主题 Then 再提交 localStorage 缓存', async () => {
    let cacheDuringPersistence: string | null = null
    installElectronApi({
      updateSettings: async (updates) => {
        cacheDuringPersistence = storage.getItem('proma-theme-mode')
        return {
          themeMode: updates.themeMode,
          themeStyle: updates.themeStyle,
        } as AppSettings
      },
    })

    await updateThemeSelection('special', 'cursor-midnight-dark')

    expect(cacheDuringPersistence).toBeNull()
    expect(storage.getItem('proma-theme-mode')).toBe('special')
    expect(storage.getItem('proma-theme-style')).toBe('cursor-midnight-dark')
  })

  test('Given 主进程写入失败 When 更新主题 Then 不污染 localStorage 缓存', async () => {
    storage.setItem('proma-theme-mode', 'light')
    storage.setItem('proma-theme-style', 'default')
    installElectronApi({
      updateSettings: async () => {
        throw new Error('write failed')
      },
    })

    await expect(updateThemeSelection('special', 'cursor-dark')).rejects.toThrow('write failed')
    expect(storage.getItem('proma-theme-mode')).toBe('light')
    expect(storage.getItem('proma-theme-style')).toBe('default')
  })

  test('Given 其他窗口广播主题 When 收到事件 Then atoms 回调与缓存使用同一规范化选择', async () => {
    let themeListener: ((payload: {
      themeMode: string
      themeStyle: string
      interfaceVariant?: string
    }) => void) | undefined
    let systemCleanupCount = 0
    let themeCleanupCount = 0
    const modes: string[] = []
    const styles: string[] = []

    installElectronApi({
      getSettings: async () => ({
        themeMode: 'special',
        themeStyle: 'cursor-light',
      }) as AppSettings,
      getSystemTheme: async () => false,
      onSystemThemeChanged: () => () => {
        systemCleanupCount += 1
      },
      onThemeSettingsChanged: (callback) => {
        themeListener = callback
        return () => {
          themeCleanupCount += 1
        }
      },
    })

    const cleanup = await initializeTheme(
      (mode) => modes.push(mode),
      () => undefined,
      (style) => styles.push(style)
    )
    themeListener?.({
      themeMode: 'special',
      themeStyle: 'cursor-high-contrast-dark',
    })

    expect(modes).toEqual(['special', 'special'])
    expect(styles).toEqual(['cursor-light', 'cursor-high-contrast-dark'])
    expect(storage.getItem('proma-theme-mode')).toBe('special')
    expect(storage.getItem('proma-theme-style')).toBe('cursor-high-contrast-dark')

    cleanup()
    expect(systemCleanupCount).toBe(1)
    expect(themeCleanupCount).toBe(1)
  })
})
