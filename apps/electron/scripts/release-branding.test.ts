import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APP_DISPLAY_NAME } from '../src/main/lib/app-branding'

const appDirectory = resolve(import.meta.dir, '..')
const repositoryUrl = 'https://github.com/maochiy/Xcode'

describe('Xcodes 发布入口', () => {
  test('Given 用户确认名称为 Xcodes When 读取应用与打包元数据 Then 显示名与安装产物大小写一致', () => {
    const metadata = JSON.parse(readFileSync(resolve(appDirectory, 'package.json'), 'utf8')) as {
      productName: string
      homepage: string
      repository: { url: string }
    }
    expect(APP_DISPLAY_NAME).toBe('Xcodes')
    expect(metadata.productName).toBe(APP_DISPLAY_NAME)
    expect(metadata.homepage).toBe(repositoryUrl)
    expect(metadata.repository.url).toBe(`${repositoryUrl}.git`)
    const builder = readFileSync(resolve(appDirectory, 'electron-builder.yml'), 'utf8')
    expect(builder).toContain('productName: Xcodes')
    expect(builder).toContain('executableName: Xcodes')
    expect(builder).toContain('artifactName: Xcodes-${version}-mac-${arch}.${ext}')
    expect(builder).toContain('artifactName: Xcodes-${version}-windows-${arch}.${ext}')
    expect(builder).toContain('owner: maochiy')
    expect(builder).toContain('repo: Xcode')
  })

  test('Given 发布仓库已迁移 When 用户查看版本与项目链接 Then 不再访问旧发布仓库', () => {
    const about = readFileSync(resolve(appDirectory, 'src/renderer/components/settings/AboutSettings.tsx'), 'utf8')
    const releases = readFileSync(resolve(appDirectory, 'src/main/lib/github-release-service.ts'), 'utf8')
    expect(about).toContain(`${repositoryUrl}/releases`)
    expect(about).not.toContain('maochiy/Proma')
    expect(releases).toContain("owner: 'maochiy'")
    expect(releases).toContain("repo: 'Xcode'")
  })
})
