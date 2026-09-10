import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expectedReleaseAssetNames,
  prepareReleaseAssets,
  validateReleaseConfig,
  verifyAssetNames,
} from './release-flow.mjs'

const builderConfig = `productName: Xcodes
publish:
  provider: github
  owner: maochiy
  repo: Xcode
`

describe('release flow', () => {
  test('校验 tag、应用名和目标仓库', () => {
    expect(
      validateReleaseConfig({
        tag: 'v0.0.1',
        repository: 'maochiy/Xcode',
        packageJson: { version: '0.0.1', productName: 'Xcodes' },
        builderConfig,
      }),
    ).toBe('0.0.1')

    expect(() =>
      validateReleaseConfig({
        tag: 'v0.0.2',
        repository: 'maochiy/Xcode',
        packageJson: { version: '0.0.1', productName: 'Xcodes' },
        builderConfig,
      }),
    ).toThrow('tag 与应用版本不一致')
  })

  test('生成双架构 macOS 与 Windows 更新清单', () => {
    const assetsDir = mkdtempSync(join(tmpdir(), 'xcode-release-'))
    const binaryNames = expectedReleaseAssetNames('v0.0.1').filter(
      (name) => !name.endsWith('.yml'),
    )

    for (const name of binaryNames) {
      writeFileSync(join(assetsDir, name), `asset:${name}`)
    }

    prepareReleaseAssets({
      tag: 'v0.0.1',
      assetsDir,
      releaseDate: '2026-09-09T00:00:00.000Z',
    })

    const macManifest = readFileSync(join(assetsDir, 'latest-mac.yml'), 'utf8')
    expect(macManifest).toContain('version: 0.0.1')
    expect(macManifest).toContain('Xcodes-0.0.1-mac-arm64.zip')
    expect(macManifest).toContain('Xcodes-0.0.1-mac-x64.zip')

    const windowsManifest = readFileSync(join(assetsDir, 'latest.yml'), 'utf8')
    expect(windowsManifest).toContain('Xcodes-0.0.1-windows-x64.exe')
  })

  test('拒绝缺失或多余的远端资产', () => {
    const expected = expectedReleaseAssetNames('v0.0.1')
    expect(() => verifyAssetNames('v0.0.1', expected)).not.toThrow()
    expect(() => verifyAssetNames('v0.0.1', expected.slice(1))).toThrow(
      '发布资产集合不匹配',
    )
  })

  test('workflow 不再依赖 CCB Runtime，且构建成功后才发布 Draft', () => {
    const workflow = readFileSync(
      join(import.meta.dir, '../workflows/release.yml'),
      'utf8',
    )

    expect(workflow).not.toContain('CCB_RUNTIME')
    expect(workflow).not.toContain('sync:ccb-runtime')
    expect(workflow).toContain('bun run typecheck')
    expect(workflow).toContain('bun test ./.github/scripts/release-flow.test.ts')
    expect(workflow).toContain('--publish never')
    expect(workflow).not.toContain('--config.artifactName=')
    expect(workflow).toContain(
      'needs: [validate-release, quality-check, build-macos, build-windows]',
    )
    expect(workflow).toContain('--draft')
    expect(workflow).toContain('--title "Xcodes ${TAG}"')
    expect(workflow).toContain('-F "name=Xcodes ${TAG}"')
    expect(workflow.indexOf('gh release create')).toBeLessThan(
      workflow.indexOf('gh release upload'),
    )
    expect(workflow.indexOf('gh release upload')).toBeLessThan(
      workflow.indexOf('-F draft=false'),
    )
  })
})
