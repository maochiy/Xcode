import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMigratedConfigDirectory } from './config-directory-migration'

const temporaryHomes: string[] = []

function createHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'xcodes-config-migration-'))
  temporaryHomes.push(home)
  return home
}

function migrationArtifacts(home: string): string[] {
  return readdirSync(home).filter((name) => name.startsWith('.xcodes-migration-'))
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('Xcode 配置目录迁移', () => {
  test('Given 新用户没有旧目录 When 准备正式目录 Then 只创建 ~/xcodes', () => {
    const home = createHome()
    const result = ensureMigratedConfigDirectory({
      legacyDirectory: join(home, '.proma'),
      targetDirectory: join(home, 'xcodes'),
    })

    expect(result).toEqual({
      directory: join(home, 'xcodes'),
      status: 'fresh',
    })
    expect(lstatSync(result.directory).isDirectory()).toBe(true)
    expect(migrationArtifacts(home)).toEqual([])
  })

  test('Given 旧目录包含历史附件工作区和原生记录 When 迁移 Then 原样复制并保留旧目录', () => {
    const home = createHome()
    const legacy = join(home, '.proma')
    const target = join(home, 'xcodes')
    const jsonl = '{"path":"~/.proma/attachments/agent/s-1/a.png"}\n'
    mkdirSync(join(legacy, 'agent-sessions'), { recursive: true })
    mkdirSync(join(legacy, 'attachments', 'agent', 's-1'), { recursive: true })
    mkdirSync(join(legacy, 'agent-workspaces', 'default'), { recursive: true })
    mkdirSync(join(legacy, 'runtime-sessions', 'native'), { recursive: true })
    writeFileSync(join(legacy, 'agent-sessions', 's-1.jsonl'), jsonl)
    writeFileSync(join(legacy, 'attachments', 'agent', 's-1', 'a.png'), 'binary')
    writeFileSync(join(legacy, 'agent-workspaces', 'default', 'mcp.json'), '{}')
    writeFileSync(
      join(legacy, 'runtime-sessions', 'native', 'session-files.json'),
      JSON.stringify({ history: join(legacy, 'agent-sessions', 's-1.jsonl') }),
    )

    const result = ensureMigratedConfigDirectory({
      legacyDirectory: legacy,
      targetDirectory: target,
    })

    expect(result.status).toBe('migrated')
    expect(readFileSync(join(target, 'agent-sessions', 's-1.jsonl'), 'utf8')).toBe(jsonl)
    expect(readFileSync(join(legacy, 'agent-sessions', 's-1.jsonl'), 'utf8')).toBe(jsonl)
    expect(readFileSync(join(target, 'attachments', 'agent', 's-1', 'a.png'), 'utf8')).toBe('binary')
    expect(readFileSync(join(target, 'agent-workspaces', 'default', 'mcp.json'), 'utf8')).toBe('{}')
    expect(readFileSync(
      join(target, 'runtime-sessions', 'native', 'session-files.json'),
      'utf8',
    )).toContain(legacy)
    expect(migrationArtifacts(home)).toEqual([])
  })

  test('Given ~/xcodes 已存在 When 准备目录 Then 不覆盖也不合并旧数据', () => {
    const home = createHome()
    const legacy = join(home, '.proma')
    const target = join(home, 'xcodes')
    mkdirSync(legacy)
    mkdirSync(target)
    writeFileSync(join(legacy, 'marker'), 'legacy')
    writeFileSync(join(target, 'marker'), 'current')

    const result = ensureMigratedConfigDirectory({
      legacyDirectory: legacy,
      targetDirectory: target,
    })

    expect(result.status).toBe('target-exists')
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('current')
    expect(readFileSync(join(legacy, 'marker'), 'utf8')).toBe('legacy')
  })

  test('Given 正式和开发旧目录并存 When 分别迁移 Then 数据隔离到 xcodes 与 xcodes-dev', () => {
    const home = createHome()
    mkdirSync(join(home, '.proma'))
    mkdirSync(join(home, '.proma-dev'))
    writeFileSync(join(home, '.proma', 'mode'), 'production')
    writeFileSync(join(home, '.proma-dev', 'mode'), 'development')

    ensureMigratedConfigDirectory({
      legacyDirectory: join(home, '.proma'),
      targetDirectory: join(home, 'xcodes'),
    })
    ensureMigratedConfigDirectory({
      legacyDirectory: join(home, '.proma-dev'),
      targetDirectory: join(home, 'xcodes-dev'),
    })

    expect(readFileSync(join(home, 'xcodes', 'mode'), 'utf8')).toBe('production')
    expect(readFileSync(join(home, 'xcodes-dev', 'mode'), 'utf8')).toBe('development')
  })

  test('Given 隔离复制失败 When 准备目录 Then 不发布半成品且继续使用原旧目录', () => {
    const home = createHome()
    const legacy = join(home, '.proma')
    const target = join(home, 'xcodes')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'marker'), 'preserved')

    const result = ensureMigratedConfigDirectory({
      legacyDirectory: legacy,
      targetDirectory: target,
      copyDirectory: (_source, stagedTarget) => {
        mkdirSync(stagedTarget)
        writeFileSync(join(stagedTarget, 'partial'), 'partial')
        throw new Error('模拟复制失败')
      },
    })

    expect(result).toEqual({
      directory: legacy,
      status: 'legacy-fallback',
      failureCategory: 'copy-failed',
    })
    expect(readFileSync(join(legacy, 'marker'), 'utf8')).toBe('preserved')
    expect(() => lstatSync(target)).toThrow()
    expect(migrationArtifacts(home)).toEqual([])
  })

  test('Given 隔离副本仍在复制 When 检查最终目标 Then 原子发布前目标始终不可见', () => {
    const home = createHome()
    const legacy = join(home, '.proma')
    const target = join(home, 'xcodes')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'marker'), 'complete')

    const result = ensureMigratedConfigDirectory({
      legacyDirectory: legacy,
      targetDirectory: target,
      copyDirectory: (_source, stagedTarget) => {
        expect(() => lstatSync(target)).toThrow()
        mkdirSync(stagedTarget)
        writeFileSync(join(stagedTarget, 'marker'), 'complete')
        expect(() => lstatSync(target)).toThrow()
      },
    })

    expect(result.status).toBe('migrated')
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('complete')
  })

  test('Given 旧目录含指向外部的内部符号链接 When 迁移 Then 复制链接本身且不遍历目标', () => {
    const home = createHome()
    const legacy = join(home, '.proma')
    const target = join(home, 'xcodes')
    const outside = join(home, 'outside')
    mkdirSync(legacy)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 'do-not-copy')
    symlinkSync(outside, join(legacy, 'linked-outside'), 'dir')

    const result = ensureMigratedConfigDirectory({
      legacyDirectory: legacy,
      targetDirectory: target,
    })

    expect(result.status).toBe('migrated')
    expect(lstatSync(join(legacy, 'linked-outside')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(target, 'linked-outside')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(target, 'linked-outside'))).toBe(outside)
    expect(migrationArtifacts(home)).toEqual([])
  })

  test('Given 旧配置根目录本身是符号链接 When 迁移 Then 拒绝复制并明确安全回退', () => {
    const home = createHome()
    const realLegacy = join(home, 'legacy-real')
    const legacy = join(home, '.proma')
    mkdirSync(realLegacy)
    writeFileSync(join(realLegacy, 'marker'), 'preserved')
    symlinkSync(realLegacy, legacy, 'dir')

    const result = ensureMigratedConfigDirectory({
      legacyDirectory: legacy,
      targetDirectory: join(home, 'xcodes'),
    })

    expect(result).toEqual({
      directory: legacy,
      status: 'legacy-fallback',
      failureCategory: 'unsafe-legacy-root',
    })
    expect(readFileSync(join(legacy, 'marker'), 'utf8')).toBe('preserved')
  })

  test('Given 目标路径是普通文件或符号链接 When 准备目录 Then 不接受也不覆盖错误目标', () => {
    for (const targetKind of ['file', 'symlink'] as const) {
      const home = createHome()
      const legacy = join(home, '.proma')
      const target = join(home, 'xcodes')
      mkdirSync(legacy)
      writeFileSync(join(legacy, 'marker'), targetKind)

      if (targetKind === 'file') {
        writeFileSync(target, 'occupied')
      } else {
        const elsewhere = join(home, 'elsewhere')
        mkdirSync(elsewhere)
        symlinkSync(elsewhere, target, 'dir')
      }

      const result = ensureMigratedConfigDirectory({
        legacyDirectory: legacy,
        targetDirectory: target,
      })

      expect(result).toEqual({
        directory: legacy,
        status: 'legacy-fallback',
        failureCategory: 'invalid-target',
      })
      expect(readFileSync(join(legacy, 'marker'), 'utf8')).toBe(targetKind)
    }
  })

  test('Given 新用户目标路径已被普通文件占用 When 准备目录 Then 明确失败而不覆盖文件', () => {
    const home = createHome()
    const target = join(home, 'xcodes')
    writeFileSync(target, 'occupied')

    expect(() => ensureMigratedConfigDirectory({
      legacyDirectory: join(home, '.proma'),
      targetDirectory: target,
    })).toThrow('配置目录迁移失败 [invalid-target]')
    expect(readFileSync(target, 'utf8')).toBe('occupied')
  })
})
