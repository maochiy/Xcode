import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings } from '../../types'

const RESULT_PREFIX = '__PROMA_SETTINGS_RESULT__'

let tempHome: string
let settingsPath: string

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'proma-settings-service-'))
  settingsPath = join(tempHome, '.proma-dev', 'settings.json')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma-dev'), { recursive: true, force: true })
  mkdirSync(join(tempHome, '.proma-dev'), { recursive: true })
})

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

function runSettingsService(expression: string): AppSettings {
  const serviceUrl = pathToFileURL(join(import.meta.dir, 'settings-service.ts')).href
  const script = `
    import * as service from ${JSON.stringify(serviceUrl)}
    const result = ${expression}
    console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(result))
  `
  const result = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      HOME: tempHome,
      PROMA_DEV: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `设置服务子进程退出码: ${result.exitCode}`)
  }

  const resultLine = result.stdout.toString()
    .split('\n')
    .find((line) => line.startsWith(RESULT_PREFIX))
  if (!resultLine) {
    throw new Error(`设置服务子进程未返回结果: ${result.stdout.toString()}`)
  }
  return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as AppSettings
}

describe('应用主题设置持久化', () => {
  test('Given 配置文件不存在 When 读取 Then 返回 Cursor Dark 默认配置', () => {
    expect(runSettingsService('service.getSettings()')).toMatchObject({
      themeMode: 'dark',
      themeStyle: 'default',
    })
  })

  test('Given 旧版浅色特殊主题 When 读取 Then 迁移并保留其他配置', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'special',
      themeStyle: 'forest-light',
      notificationsEnabled: false,
      marker: 'preserved',
    }), 'utf-8')

    expect(runSettingsService('service.getSettings()')).toMatchObject({
      themeMode: 'light',
      themeStyle: 'default',
      notificationsEnabled: false,
    })
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject({
      themeMode: 'light',
      themeStyle: 'default',
      marker: 'preserved',
    })
  })

  test('Given 非法特殊主题 When 读取 Then 迁移并持久化为 Cursor Dark', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'special',
      themeStyle: 'unknown-light',
    }), 'utf-8')

    expect(runSettingsService('service.getSettings()')).toMatchObject({
      themeMode: 'dark',
      themeStyle: 'default',
    })
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject({
      themeMode: 'dark',
      themeStyle: 'default',
    })
  })

  test('Given 合法 Cursor 特殊主题 When 读取 Then 保持原配置', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'special',
      themeStyle: 'cursor-high-contrast-dark',
    }), 'utf-8')

    expect(runSettingsService('service.getSettings()')).toMatchObject({
      themeMode: 'special',
      themeStyle: 'cursor-high-contrast-dark',
    })
  })

  test('Given 一次提交 mode 和 style When 更新 Then 原子持久化完整选择', () => {
    writeFileSync(settingsPath, JSON.stringify({
      themeMode: 'dark',
      themeStyle: 'default',
    }), 'utf-8')

    const updated = runSettingsService(`service.updateSettings({
      themeMode: 'special',
      themeStyle: 'cursor-midnight-dark',
    })`)

    expect(updated).toMatchObject({
      themeMode: 'special',
      themeStyle: 'cursor-midnight-dark',
    })
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject({
      themeMode: 'special',
      themeStyle: 'cursor-midnight-dark',
    })
  })
})
