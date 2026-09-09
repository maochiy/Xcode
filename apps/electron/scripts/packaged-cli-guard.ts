/**
 * 打包产物中 proma CLI 的签名修复与 smoke test。
 *
 * 背景：
 * bun build --compile 产出的二进制自带 adhoc/linker-signed 签名。
 * electron-builder 复制 extraResources 后，该签名经常变成 invalid /
 * “code object is not signed at all”。在 Apple Silicon 上，macOS 会对
 * 无效签名的 arm64 可执行文件直接 SIGKILL（exit 137），导致 Agent 会话里
 * `proma session ...` 全部失败。
 *
 * 本模块在 afterPack / build:cli / 本地签名后统一：
 * 1. macOS：校验签名，无效则 remove + adhoc 重签
 * 2. 所有平台：跑一次轻量 smoke（session list）
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

export type ElectronBuilderPlatform = 'darwin' | 'linux' | 'win32' | string

export interface PackagedCliPathOptions {
  /** electron-builder macOS 应用包文件名（不含 .app），默认 xcodes */
  productName?: string
}

export interface RunCommandOptions {
  command: string
  args: string[]
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export type RunCommand = (options: RunCommandOptions) => SpawnSyncReturns<string>

export interface EnsureMacCliCodeSignatureOptions {
  run?: RunCommand
  /** 强制重签（即使 verify 通过） */
  force?: boolean
  platform?: NodeJS.Platform
}

export interface SmokeTestPromaCliOptions {
  run?: RunCommand
  timeoutMs?: number
  /** 隔离配置目录，避免依赖本机 ~/xcodes */
  configDir?: string
}

const DEFAULT_SMOKE_TIMEOUT_MS = 30_000
const MAX_SMOKE_ATTEMPTS = 2

function defaultRun(options: RunCommandOptions): SpawnSyncReturns<string> {
  return spawnSync(options.command, options.args, {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 解析 electron-builder afterPack 产物中的 proma CLI 路径。
 *
 * - macOS: <appOutDir>/xcodes.app/Contents/Resources/bin/proma
 * - Windows: <appOutDir>/resources/bin/proma.exe
 * - Linux: <appOutDir>/resources/bin/proma
 */
export function resolvePackagedCliPath(
  appOutDir: string,
  electronPlatformName: ElectronBuilderPlatform,
  options: PackagedCliPathOptions = {},
): string {
  const productName = options.productName ?? 'xcodes'
  const binName = electronPlatformName === 'win32' ? 'proma.exe' : 'proma'

  if (electronPlatformName === 'darwin') {
    return join(appOutDir, `${productName}.app`, 'Contents', 'Resources', 'bin', binName)
  }

  return join(appOutDir, 'resources', 'bin', binName)
}

/**
 * 检查 macOS 可执行文件 codesign 是否通过严格校验。
 */
export function isMacCodeSignatureValid(
  filePath: string,
  run: RunCommand = defaultRun,
): boolean {
  const result = run({
    command: '/usr/bin/codesign',
    args: ['--verify', '--verbose=2', filePath],
    timeoutMs: 15_000,
  })
  return result.status === 0
}

/**
 * 确保 macOS 上的 proma CLI 具有可执行的 adhoc 签名。
 *
 * 无效签名会先 remove-signature，再 `codesign --force -s -`。
 * 非 darwin 平台直接 no-op。
 */
export function ensureMacCliCodeSignature(
  cliPath: string,
  options: EnsureMacCliCodeSignatureOptions = {},
): { repaired: boolean } {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return { repaired: false }

  if (!existsSync(cliPath)) {
    throw new Error(`proma CLI 不存在，无法签名: ${cliPath}`)
  }

  const run = options.run ?? defaultRun
  if (!options.force && isMacCodeSignatureValid(cliPath, run)) {
    return { repaired: false }
  }

  // remove 失败可忽略：有些损坏签名仍可通过 force 覆盖
  run({
    command: '/usr/bin/codesign',
    args: ['--remove-signature', cliPath],
    timeoutMs: 15_000,
  })

  const sign = run({
    command: '/usr/bin/codesign',
    args: [
      '--force',
      '-s',
      '-',
      '--timestamp=none',
      '--identifier',
      'com.proma.cli',
      cliPath,
    ],
    timeoutMs: 30_000,
  })

  if (sign.status !== 0) {
    const detail = `${sign.stdout ?? ''}${sign.stderr ?? ''}`.trim()
    throw new Error(
      `proma CLI adhoc 签名失败 (${cliPath}): ${detail || `exit ${sign.status}`}`,
    )
  }

  if (!isMacCodeSignatureValid(cliPath, run)) {
    throw new Error(`proma CLI 重签后 codesign --verify 仍失败: ${cliPath}`)
  }

  return { repaired: true }
}

function formatSpawnFailure(result: SpawnSyncReturns<string>): string {
  if (result.error) return result.error.message
  if (result.signal) return `killed by signal ${result.signal}`
  if (result.status === 137) return 'exit 137 (SIGKILL，常见于无效代码签名)'
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  const output = [stdout, stderr].filter(Boolean).join('\n')
  return output || `exit ${result.status ?? 'null'}`
}

function isSpawnTimeout(result: SpawnSyncReturns<string>): boolean {
  const error = result.error as NodeJS.ErrnoException | undefined
  return error?.code === 'ETIMEDOUT'
}

/**
 * 对 proma CLI 做轻量 smoke：session list --limit 1 --json。
 * 使用临时 --config-dir，不依赖本机真实会话数据。
 * macOS 新复制的大体积 Bun 单文件首次执行可能受代码签名校验和磁盘压力影响；
 * 仅在首次超时时重试一次，真实异常仍会中断打包。
 */
export function smokeTestPromaCli(
  cliPath: string,
  options: SmokeTestPromaCliOptions = {},
): void {
  if (!existsSync(cliPath)) {
    throw new Error(`proma CLI 不存在，无法 smoke test: ${cliPath}`)
  }

  const run = options.run ?? defaultRun
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS
  const tempConfigDir =
    options.configDir
    ?? mkdtempSync(join(tmpdir(), 'proma-cli-smoke-'))
  const shouldCleanupConfigDir = !options.configDir

  try {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.XCODE_DEV
    delete env.PROMA_DEV

    let result: SpawnSyncReturns<string> | undefined
    for (let attempt = 1; attempt <= MAX_SMOKE_ATTEMPTS; attempt += 1) {
      result = run({
        command: cliPath,
        args: [
          'session',
          'list',
          '--limit',
          '1',
          '--json',
          '--config-dir',
          tempConfigDir,
        ],
        timeoutMs,
        env,
      })
      if (!isSpawnTimeout(result) || attempt === MAX_SMOKE_ATTEMPTS) break
      console.warn(`[proma CLI] smoke test 首次启动超时，重试一次: ${cliPath}`)
    }

    if (!result || result.status !== 0) {
      throw new Error(
        `proma CLI smoke test 失败 (${cliPath}): ${
          result ? formatSpawnFailure(result) : '未执行'
        }`,
      )
    }

    const stdout = (result.stdout ?? '').trim()
    // list --json 在空目录下输出 []
    if (!stdout.includes('[')) {
      throw new Error(
        `proma CLI smoke test 输出异常 (${cliPath}): ${stdout || '(empty stdout)'}`,
      )
    }
  } finally {
    if (shouldCleanupConfigDir) {
      try {
        rmSync(tempConfigDir, { recursive: true, force: true })
      } catch {
        // 清理失败不阻断打包
      }
    }
  }
}

/**
 * afterPack 入口：修复 mac 签名 + 全平台 smoke。
 * @returns CLI 绝对路径
 */
export function ensurePackagedPromaCli(
  appOutDir: string,
  electronPlatformName: ElectronBuilderPlatform,
  options: PackagedCliPathOptions & EnsureMacCliCodeSignatureOptions & SmokeTestPromaCliOptions = {},
): string {
  const cliPath = resolvePackagedCliPath(appOutDir, electronPlatformName, options)
  if (!existsSync(cliPath)) {
    throw new Error(
      `打包产物缺少 proma CLI: ${cliPath}\n` +
      `请确认 build:cli 已产出 resources/bin，并写入 electron-builder extraResources。`,
    )
  }

  if (electronPlatformName === 'darwin') {
    const { repaired } = ensureMacCliCodeSignature(cliPath, options)
    console.log(
      repaired
        ? `[proma CLI] 已修复 macOS 代码签名: ${cliPath}`
        : `[proma CLI] macOS 代码签名校验通过: ${cliPath}`,
    )
  }

  smokeTestPromaCli(cliPath, options)
  console.log(`[proma CLI] smoke test 通过: ${cliPath}`)
  return cliPath
}
