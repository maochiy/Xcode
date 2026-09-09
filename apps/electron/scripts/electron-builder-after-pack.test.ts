import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import afterPack from './electron-builder-after-pack'
import { resolvePackagedCliPath } from './packaged-cli-guard'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('afterPack 入口（proma CLI 与 Pi Runtime 守卫）', () => {
  test('Given darwin 产物缺少 proma CLI When afterPack Then 抛错中断打包', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-after-pack-cli-'))
    temporaryDirectories.push(appOutDir)

    expect(() =>
      afterPack({
        appOutDir,
        electronPlatformName: 'darwin',
        packager: {
          appInfo: {
            productFilename: 'xcodes',
          },
        },
      }),
    ).toThrow(/缺少 proma CLI/)
  })

  test('Given darwin 目标 When 解析 CLI 路径 Then 使用应用资源目录', () => {
    expect(resolvePackagedCliPath('/out', 'darwin')).toContain('xcodes.app')
  })

  test('Given context 提供实际 Bundle 名 When afterPack Then 动态使用该名称', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-after-pack-context-'))
    temporaryDirectories.push(appOutDir)

    expect(() =>
      afterPack({
        appOutDir,
        electronPlatformName: 'darwin',
        packager: {
          appInfo: {
            productFilename: 'context-name',
          },
        },
      }),
    ).toThrow(/context-name\.app/)
  })
})
