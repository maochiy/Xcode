import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smokePackagedCliAfterSign } from './electron-builder-after-sign'

describe('afterSign 入口', () => {
  test('Given context 提供实际 Bundle 名 When 定位 CLI Then 动态使用该名称', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-after-sign-context-'))
    try {
      expect(() =>
        smokePackagedCliAfterSign({
          appOutDir,
          electronPlatformName: 'darwin',
          packager: {
            appInfo: {
              productFilename: 'context-name',
            },
          },
        }),
      ).toThrow(/context-name\.app/)
    } finally {
      rmSync(appOutDir, { recursive: true, force: true })
    }
  })
})
