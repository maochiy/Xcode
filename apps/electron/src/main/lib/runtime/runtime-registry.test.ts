import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALL_RUNTIME_IDS,
  detectRuntime,
  listRuntimes,
  migrateRuntimeConfig,
  resolveDefaultRuntimeHome,
  scanManagedRuntimePackages,
} from './runtime-registry'
import { getRuntimeHomeDir } from '../config-paths'

describe('Proma Runtime Registry 契约', () => {
  test('Given 历史 Runtime 类型仍可读取 When 枚举可执行运行时 Then 只注册 Pi', () => {
    expect(ALL_RUNTIME_IDS).toEqual(['pi'])
    expect(detectRuntime('hermes')).toBeNull()
    expect(detectRuntime('codex')).toBeNull()
    expect(detectRuntime('claude')).toBeNull()
  })

  test('Given Proma Runtime Home 中混有旧内核托管包 When 扫描当前平台 Then 只返回 Pi', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-runtime-'))
    try {
      const piDir = join(root, 'packages', 'pi', '0.83.0', 'darwin-arm64')
      const codexDir = join(root, 'packages', 'codex', '0.146.0', 'darwin-arm64')
      const claudeDir = join(root, 'packages', 'claude', '2.1.220', 'darwin-arm64')
      mkdirSync(join(piDir, 'node_modules', '@earendil-works', 'pi-coding-agent'), { recursive: true })
      mkdirSync(join(codexDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
      mkdirSync(join(claudeDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'), { recursive: true })
      writeFileSync(join(piDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), '{}')
      writeFileSync(join(codexDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '')
      writeFileSync(join(claudeDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude'), '')
      writeFileSync(join(piDir, 'runtime-manifest.json'), JSON.stringify({
        runtimeVersion: '0.83.0',
        runtimeBuildId: 'pi-managed-test',
        installationState: 'installed',
        verificationState: 'verified',
      }))

      const pi = scanManagedRuntimePackages(root, 'pi', 'darwin-arm64')
      const codex = scanManagedRuntimePackages(root, 'codex', 'darwin-arm64')
      const claude = scanManagedRuntimePackages(root, 'claude', 'darwin-arm64')

      expect(pi[0]?.runtimeBuildId).toBe('pi-managed-test')
      expect(pi[0]?.runtimeDir).toBe(piDir)
      expect(codex).toEqual([])
      expect(claude).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 旧多内核运行时配置 When 迁移 Then 执行字段全部收敛到 Pi', () => {
    const migrated = migrateRuntimeConfig({
      runtimeHome: '/tmp/runtime',
      runtimeSourceHome: null,
      runtimeApiBaseUrl: null,
      defaultRuntimeId: 'claude',
      defaultHarnessId: 'codex',
      enabledRuntimeIds: ['hermes', 'codex', 'claude'],
      routedHarnesses: ['codex', 'claude'],
      updatedAt: 123,
    }, 456)
    expect(migrated.defaultRuntimeId).toBe('pi')
    expect(migrated.defaultHarnessId).toBe('pi')
    expect(migrated.enabledRuntimeIds).toEqual(['pi'])
    expect(migrated.routedHarnesses).toEqual([])
    expect(migrated.runtimeHome).toBe('/tmp/runtime')
  })

  test('Given 新用户未显式配置 Runtime Home When 生成默认路径 Then 使用配置目录 runtime 子目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'xcodes-runtime-home-'))
    try {
      const configDir = join(root, 'xcodes')
      expect(resolveDefaultRuntimeHome({}, () => getRuntimeHomeDir(configDir)))
        .toBe(join(configDir, 'runtime'))
      expect(resolveDefaultRuntimeHome(
        { PROMA_RUNTIME_HOME: join(root, '.proma-runtime-explicit') },
        () => getRuntimeHomeDir(configDir),
      )).toBe(join(root, '.proma-runtime-explicit'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('内置 Runtime 安装包绑定', () => {
  test('Given 仓库内置 Pi When 枚举 Runtime Then 仅返回 bundled Pi 且不使用系统 PATH', () => {
    const runtimes = listRuntimes()
    expect(runtimes.map((runtime) => runtime.id)).toEqual(['pi'])
    expect(runtimes[0]?.installation.source).toBe('bundled')
    expect(runtimes[0]?.installation.status).toBe('ready')
    expect(runtimes[0]?.installation.executablePath).toBeTruthy()
    expect(runtimes[0]?.installation.source).not.toBe('system')
  })
})
