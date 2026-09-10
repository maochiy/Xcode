#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_PRODUCT_NAME = 'Xcodes'
const INSTALL_ARTIFACT_NAME = 'Xcodes'
const EXPECTED_REPOSITORY = 'maochiy/Xcode'

function fail(message) {
  throw new Error(message)
}

export function versionFromTag(tag) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    fail(`发布 tag 必须是稳定 SemVer，actual=${tag}`)
  }
  return tag.slice(1)
}

function rootYamlScalar(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*([^\\n#]+?)\\s*$`, 'm'))
  return match?.[1]?.trim()
}

function publishYamlScalar(source, key) {
  const publishBlock = source.match(/^publish:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] ?? ''
  const match = publishBlock.match(new RegExp(`^[ \\t]+${key}:\\s*([^\\n#]+?)\\s*$`, 'm'))
  return match?.[1]?.trim()
}

export function validateReleaseConfig({
  tag,
  repository,
  packageJson,
  builderConfig,
}) {
  const version = versionFromTag(tag)

  if (repository !== EXPECTED_REPOSITORY) {
    fail(`发布仓库必须是 ${EXPECTED_REPOSITORY}，actual=${repository}`)
  }
  if (packageJson.version !== version) {
    fail(`tag 与应用版本不一致，tag=${version}, package=${packageJson.version}`)
  }
  if (packageJson.productName !== EXPECTED_PRODUCT_NAME) {
    fail(`package productName 必须是 ${EXPECTED_PRODUCT_NAME}`)
  }
  if (rootYamlScalar(builderConfig, 'productName') !== EXPECTED_PRODUCT_NAME) {
    fail(`electron-builder productName 必须是 ${EXPECTED_PRODUCT_NAME}`)
  }

  const publishRepository = [
    publishYamlScalar(builderConfig, 'owner'),
    publishYamlScalar(builderConfig, 'repo'),
  ].join('/')
  if (publishRepository !== EXPECTED_REPOSITORY) {
    fail(`electron-builder 发布仓库必须是 ${EXPECTED_REPOSITORY}，actual=${publishRepository}`)
  }

  return version
}

function assetBase(version, platform, arch) {
  return `${INSTALL_ARTIFACT_NAME}-${version}-${platform}-${arch}`
}

export function buildAssetNames(tag, platform, arch) {
  const version = versionFromTag(tag)
  const base = assetBase(version, platform, arch)

  if (platform === 'mac' && (arch === 'arm64' || arch === 'x64')) {
    return [
      `${base}.dmg`,
      `${base}.dmg.blockmap`,
      `${base}.zip`,
      `${base}.zip.blockmap`,
    ]
  }
  if (platform === 'windows' && arch === 'x64') {
    return [`${base}.exe`, `${base}.exe.blockmap`]
  }
  fail(`不支持的发布目标: ${platform}/${arch}`)
}

export function expectedReleaseAssetNames(tag) {
  return [
    ...buildAssetNames(tag, 'mac', 'arm64'),
    ...buildAssetNames(tag, 'mac', 'x64'),
    ...buildAssetNames(tag, 'windows', 'x64'),
    'latest-mac.yml',
    'latest.yml',
  ].sort()
}

function assertNonEmptyFile(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    fail(`缺少发布资产: ${path}`)
  }
  if (!stat.isFile() || stat.size === 0) {
    fail(`发布资产为空或不是文件: ${path}`)
  }
}

export function stageBuildAssets({ tag, platform, arch, outDir, destination }) {
  const names = buildAssetNames(tag, platform, arch)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })

  for (const name of names) {
    const source = join(outDir, name)
    assertNonEmptyFile(source)
    copyFileSync(source, join(destination, name))
  }
  return names
}

function fileUpdateInfo(path) {
  const data = readFileSync(path)
  return {
    sha512: createHash('sha512').update(data).digest('base64'),
    size: data.byteLength,
  }
}

function updateManifest(version, files, releaseDate) {
  const primary = files[0]
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap(({ name, sha512, size }) => [
      `  - url: ${name}`,
      `    sha512: ${sha512}`,
      `    size: ${size}`,
    ]),
    `path: ${primary.name}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

function manifestFile(assetsDir, name) {
  const path = join(assetsDir, name)
  assertNonEmptyFile(path)
  return { name, ...fileUpdateInfo(path) }
}

export function prepareReleaseAssets({ tag, assetsDir, releaseDate = new Date().toISOString() }) {
  const version = versionFromTag(tag)
  const binaryNames = expectedReleaseAssetNames(tag).filter((name) => !name.endsWith('.yml'))

  for (const name of binaryNames) {
    assertNonEmptyFile(join(assetsDir, name))
  }

  const macFiles = [
    manifestFile(assetsDir, `${assetBase(version, 'mac', 'arm64')}.zip`),
    manifestFile(assetsDir, `${assetBase(version, 'mac', 'x64')}.zip`),
  ]
  const windowsFiles = [
    manifestFile(assetsDir, `${assetBase(version, 'windows', 'x64')}.exe`),
  ]

  writeFileSync(
    join(assetsDir, 'latest-mac.yml'),
    updateManifest(version, macFiles, releaseDate),
    'utf8',
  )
  writeFileSync(
    join(assetsDir, 'latest.yml'),
    updateManifest(version, windowsFiles, releaseDate),
    'utf8',
  )

  verifyAssetNames(tag, readdirSync(assetsDir))
}

export function verifyAssetNames(tag, actualNames) {
  const expected = expectedReleaseAssetNames(tag)
  const actual = actualNames
    .map((name) => basename(name.trim()))
    .filter(Boolean)
    .sort()

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      [
        '发布资产集合不匹配',
        `expected=${expected.join(',')}`,
        `actual=${actual.join(',')}`,
      ].join('\n'),
    )
  }
}

function parseArguments(argv) {
  const [command, ...tokens] = argv
  const options = {}

  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index]
    const value = tokens[index + 1]
    if (!flag?.startsWith('--') || value === undefined) {
      fail(`无效参数: ${tokens.slice(index).join(' ')}`)
    }
    options[flag.slice(2)] = value
  }

  return { command, options }
}

function required(options, name) {
  const value = options[name]
  if (!value) fail(`缺少参数 --${name}`)
  return value
}

function runCli(argv) {
  const { command, options } = parseArguments(argv)

  if (command === 'validate-config') {
    const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
    const packageJson = JSON.parse(
      readFileSync(join(root, 'apps/electron/package.json'), 'utf8'),
    )
    const builderConfig = readFileSync(
      join(root, 'apps/electron/electron-builder.yml'),
      'utf8',
    )
    const version = validateReleaseConfig({
      tag: required(options, 'tag'),
      repository: required(options, 'repository'),
      packageJson,
      builderConfig,
    })
    process.stdout.write(version)
    return
  }

  if (command === 'stage-build') {
    stageBuildAssets({
      tag: required(options, 'tag'),
      platform: required(options, 'platform'),
      arch: required(options, 'arch'),
      outDir: resolve(required(options, 'out')),
      destination: resolve(required(options, 'dest')),
    })
    return
  }

  if (command === 'prepare-release') {
    prepareReleaseAssets({
      tag: required(options, 'tag'),
      assetsDir: resolve(required(options, 'assets')),
    })
    return
  }

  if (command === 'verify-list') {
    const names = readFileSync(resolve(required(options, 'file')), 'utf8').split(/\r?\n/)
    verifyAssetNames(required(options, 'tag'), names)
    return
  }

  fail(`未知命令: ${command ?? ''}`)
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`ERROR: ${message}`)
    process.exitCode = 1
  }
}
