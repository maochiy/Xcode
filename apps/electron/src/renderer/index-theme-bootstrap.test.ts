import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

class BootstrapStorage {
  private readonly values = new Map<string, string>()

  constructor(initialValues: Record<string, string>) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value)
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class BootstrapClassList implements Iterable<string> {
  private readonly classes = new Set<string>()

  constructor(initialClasses: readonly string[]) {
    for (const className of initialClasses) {
      this.classes.add(className)
    }
  }

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.classes.add(token)
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.classes.delete(token)
    }
  }

  [Symbol.iterator](): Iterator<string> {
    return this.classes.values()
  }
}

const html = readFileSync(join(import.meta.dir, 'index.html'), 'utf-8')
function extractBootstrapScript(): string {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) {
    throw new Error('未找到主题启动脚本')
  }
  return script
}
const bootstrapScript = extractBootstrapScript()

function runBootstrap(options: {
  mode: string
  style: string
  initialClasses: readonly string[]
  systemIsDark?: boolean
}): {
  storage: BootstrapStorage
  classes: string[]
} {
  const storage = new BootstrapStorage({
    'proma-theme-mode': options.mode,
    'proma-theme-style': options.style,
  })
  const classList = new BootstrapClassList(options.initialClasses)
  const run = new Function('localStorage', 'document', 'window', bootstrapScript)

  run(
    storage,
    { documentElement: { classList } },
    {
      matchMedia: () => ({
        matches: options.systemIsDark ?? false,
      }),
    }
  )

  return {
    storage,
    classes: Array.from(classList),
  }
}

describe('主题启动防闪脚本', () => {
  test('Given 旧版浅色缓存和遗留 class When React 加载前执行 Then 迁移为 Cursor Light 并清理 class', () => {
    const result = runBootstrap({
      mode: 'special',
      style: 'ocean-light',
      initialClasses: ['dark', 'theme-ocean-dark', 'proma-main-window'],
    })

    expect(result.storage.getItem('proma-theme-mode')).toBe('light')
    expect(result.storage.getItem('proma-theme-style')).toBe('default')
    expect(result.classes).toEqual(['proma-main-window'])
  })

  test('Given Cursor Midnight 缓存 When React 加载前执行 Then 同步特殊主题与 dark class', () => {
    const result = runBootstrap({
      mode: 'special',
      style: 'cursor-midnight-dark',
      initialClasses: ['theme-slate-light'],
    })

    expect(result.classes).toEqual([
      'theme-cursor-midnight-dark',
      'dark',
    ])
  })

  test('Given 跟随系统缓存 When 系统为深色 Then 仅应用 Cursor Dark 基调', () => {
    const result = runBootstrap({
      mode: 'system',
      style: 'cursor-light',
      initialClasses: ['theme-cursor-light'],
      systemIsDark: true,
    })

    expect(result.storage.getItem('proma-theme-style')).toBe('default')
    expect(result.classes).toEqual(['dark'])
  })
})
