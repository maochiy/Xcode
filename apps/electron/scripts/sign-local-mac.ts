#!/usr/bin/env bun
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import pkg from '../package.json' with { type: 'json' }
import {
  ensureLocalCodeSigningIdentity,
  type LocalCodeSigningIdentity,
} from './local-code-signing-identity'
import { smokeTestPromaCli } from './packaged-cli-guard'

const appDir = resolve(import.meta.dir, '..')
const defaultAppPath = join(appDir, 'out', `mac-${process.arch}`, 'Xcodes.app')
const appPath = resolve(process.argv[2] ?? defaultAppPath)
const outputDmgPath = resolve(
  process.argv[3]
    ?? join(
      appDir,
      'out',
      `Xcodes-${pkg.version}-mac-${process.arch}.dmg`,
    ),
)
const entitlementsPath = join(appDir, 'resources', 'entitlements.mac.plist')

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: appDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} 执行失败:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function collectPaths(root: string): string[] {
  const paths: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      paths.push(...collectPaths(path))
    } else if (stat.isFile()) {
      paths.push(path)
    }
  }
  return paths
}

function collectDirectories(root: string, suffix: string): string[] {
  const paths: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (!statSync(path).isDirectory()) continue
    if (name.endsWith(suffix)) paths.push(path)
    paths.push(...collectDirectories(path, suffix))
  }
  return paths.sort((left, right) => right.length - left.length)
}

function isMachO(filePath: string): boolean {
  return run('/usr/bin/file', ['-b', filePath]).includes('Mach-O')
}

function signFile(
  filePath: string,
  identity: LocalCodeSigningIdentity,
): void {
  run('/usr/bin/codesign', [
    '--force',
    '--keychain',
    identity.keychainPath,
    '--sign',
    identity.name,
    '--timestamp=none',
    filePath,
  ])
}

function signBundle(
  bundlePath: string,
  withEntitlements: boolean,
  identity: LocalCodeSigningIdentity,
): void {
  run('/usr/bin/codesign', [
    '--force',
    '--keychain',
    identity.keychainPath,
    '--sign',
    identity.name,
    '--timestamp=none',
    ...(withEntitlements
      ? ['--entitlements', entitlementsPath]
      : []),
    bundlePath,
  ])
}

function main(): void {
  if (process.platform !== 'darwin') {
    throw new Error('本地 macOS 签名脚本只能在 macOS 上运行')
  }
  if (!existsSync(appPath)) {
    throw new Error(`未找到待签名 App: ${appPath}`)
  }
  const identity = ensureLocalCodeSigningIdentity()
  console.log(`[本地签名] 使用固定身份: ${identity.name}`)

  console.log(`[本地签名] 清理扩展属性: ${appPath}`)
  run('/usr/bin/xattr', ['-cr', appPath])

  console.log('[本地签名] 签名全部 Mach-O 文件')
  for (const filePath of collectPaths(join(appPath, 'Contents'))) {
    if (isMachO(filePath)) signFile(filePath, identity)
  }

  console.log('[本地签名] 签名 Framework')
  for (const frameworkPath of collectDirectories(
    join(appPath, 'Contents'),
    '.framework',
  )) {
    signBundle(frameworkPath, false, identity)
  }

  console.log('[本地签名] 签名 Helper App')
  for (const helperPath of collectDirectories(
    join(appPath, 'Contents'),
    '.app',
  )) {
    signBundle(helperPath, true, identity)
  }

  // 主 App 必须最后签。
  console.log('[本地签名] 签名主 App')
  signBundle(appPath, true, identity)
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    appPath,
  ])

  const packagedCliPath = join(appPath, 'Contents', 'Resources', 'bin', 'proma')
  console.log(`[本地签名] smoke test proma CLI: ${packagedCliPath}`)
  smokeTestPromaCli(packagedCliPath)
  console.log('[本地签名] proma CLI smoke test 通过')

  console.log(`[本地签名] 创建 DMG: ${outputDmgPath}`)
  rmSync(outputDmgPath, { force: true })
  run('/usr/bin/hdiutil', [
    'create',
    '-volname',
    `Xcodes ${pkg.version}`,
    '-srcfolder',
    appPath,
    '-ov',
    '-format',
    'UDZO',
    outputDmgPath,
  ])
  console.log(`[本地签名] 完成: ${outputDmgPath}`)
}

main()
