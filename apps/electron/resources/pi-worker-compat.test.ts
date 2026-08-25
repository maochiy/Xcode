import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const shimPath = join(import.meta.dir, 'pi-worker-compat.cjs')

function verifyCompatShim(
  parentFilename: string,
  expectedType = 'function',
): ReturnType<typeof spawnSync> {
  const script = `
    const Module = require('node:module')
    const originalLoad = Module._load
    Module._load = function(request) {
      if (request === 'signal-exit') return { onExit() {} }
      return originalLoad.apply(this, arguments)
    }
    require(${JSON.stringify(shimPath)})
    const loaded = Module._load('signal-exit', {
      filename: ${JSON.stringify(parentFilename)},
    }, false)
    if (typeof loaded !== ${JSON.stringify(expectedType)}) {
      console.error('signal-exit 导出类型不符合预期:', typeof loaded)
      process.exit(1)
    }
  `
  return spawnSync('node', ['-e', script], { encoding: 'utf8' })
}

describe('Pi Worker proper-lockfile 兼容补丁', () => {
  test('Given Windows 反斜杠模块路径 When 加载 signal-exit Then 应返回兼容函数', () => {
    const result = verifyCompatShim(
      'C:\\Program Files\\Proma\\resources\\app.asar.unpacked\\node_modules\\proper-lockfile\\lib\\lockfile.js',
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('Given POSIX 模块路径 When 加载 signal-exit Then 继续返回兼容函数', () => {
    const result = verifyCompatShim(
      '/Applications/Proma.app/Contents/Resources/app.asar.unpacked/node_modules/proper-lockfile/lib/lockfile.js',
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('Given 非 proper-lockfile 调用方 When 加载 signal-exit Then 不改变原始对象导出', () => {
    const result = verifyCompatShim(
      'C:\\Program Files\\Proma\\resources\\app.asar.unpacked\\node_modules\\other-package\\index.js',
      'object',
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })
})
