import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensurePackagedBundledRuntimes, resolvePackagedResourcesRoot } from './packaged-runtime-guard'

function writeRuntimeFiles(resourcesRoot: string): void {
  const files = [
    'pi-runtime/workers/pi-worker.mjs',
    'app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent/package.json',
  ]
  for (const file of files) {
    const fullPath = join(resourcesRoot, file)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, file.endsWith('package.json') ? '{"version":"0.0.0"}' : 'export {}\n')
  }
}

describe('打包产物内置 Runtime 守卫', () => {
  test('Given darwin 产物缺少 Pi 内核 When 校验 Then 中断打包', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-runtime-guard-'))
    try {
      expect(() => ensurePackagedBundledRuntimes(appOutDir, 'darwin')).toThrow(/缺少内置 Runtime/)
    } finally {
      rmSync(appOutDir, { recursive: true, force: true })
    }
  })

  test('Given darwin 产物包含 Pi 内核 When 校验 Then 通过', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-runtime-guard-ok-'))
    try {
      const resourcesRoot = resolvePackagedResourcesRoot(appOutDir, 'darwin')
      writeRuntimeFiles(resourcesRoot)
      expect(ensurePackagedBundledRuntimes(appOutDir, 'darwin')).toEqual([
        'Pi Worker',
        '@earendil-works/pi-coding-agent',
      ])
    } finally {
      rmSync(appOutDir, { recursive: true, force: true })
    }
  })
})
