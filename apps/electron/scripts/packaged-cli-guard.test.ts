import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ensureMacCliCodeSignature,
  ensurePackagedPromaCli,
  resolvePackagedCliPath,
  smokeTestPromaCli,
  type RunCommand,
} from './packaged-cli-guard'

const temporaryDirectories: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolvePackagedCliPath', () => {
  test('Given darwin When 解析路径 Then 指向 App Bundle Resources/bin/proma', () => {
    expect(resolvePackagedCliPath('/out/mac-arm64', 'darwin')).toBe(
      join('/out/mac-arm64', 'Xcode-Desktop.app', 'Contents', 'Resources', 'bin', 'proma'),
    )
  })

  test('Given win32 When 解析路径 Then 指向 resources/bin/proma.exe', () => {
    expect(resolvePackagedCliPath('/out/win-x64', 'win32')).toBe(
      join('/out/win-x64', 'resources', 'bin', 'proma.exe'),
    )
  })

  test('Given linux When 解析路径 Then 指向 resources/bin/proma', () => {
    expect(resolvePackagedCliPath('/out/linux-x64', 'linux')).toBe(
      join('/out/linux-x64', 'resources', 'bin', 'proma'),
    )
  })
})

describe('ensureMacCliCodeSignature', () => {
  test('Given 非 darwin When 调用 Then 跳过', () => {
    const result = ensureMacCliCodeSignature('/unused', {
      platform: 'linux',
      run: () => {
        throw new Error('不应调用 codesign')
      },
    })
    expect(result).toEqual({ repaired: false })
  })

  test('Given 签名已有效 When 调用 Then 不重签', () => {
    const calls: string[][] = []
    const run: RunCommand = ({ args }) => {
      calls.push(args)
      return {
        status: 0,
        signal: null,
        output: ['', '', ''],
        pid: 1,
        stdout: '',
        stderr: '',
      }
    }

    const dir = makeTempDir('proma-cli-sign-')
    const cliPath = join(dir, 'proma')
    writeFileSync(cliPath, 'fake')

    const result = ensureMacCliCodeSignature(cliPath, { platform: 'darwin', run })
    expect(result).toEqual({ repaired: false })
    expect(calls).toEqual([['--verify', '--verbose=2', cliPath]])
  })

  test('Given 签名无效 When 调用 Then remove + adhoc 重签', () => {
    const calls: string[][] = []
    let verifyCount = 0
    const run: RunCommand = ({ args }) => {
      calls.push(args)
      if (args[0] === '--verify') {
        verifyCount += 1
        // 第一次失败触发修复，重签后第二次通过
        return {
          status: verifyCount === 1 ? 1 : 0,
          signal: null,
          output: ['', '', ''],
          pid: 1,
          stdout: '',
          stderr: verifyCount === 1 ? 'invalid signature' : '',
        }
      }
      return {
        status: 0,
        signal: null,
        output: ['', '', ''],
        pid: 1,
        stdout: '',
        stderr: '',
      }
    }

    const dir = makeTempDir('proma-cli-sign-')
    const cliPath = join(dir, 'proma')
    writeFileSync(cliPath, 'fake')

    const result = ensureMacCliCodeSignature(cliPath, { platform: 'darwin', run })
    expect(result).toEqual({ repaired: true })
    expect(calls[0]).toEqual(['--verify', '--verbose=2', cliPath])
    expect(calls[1]).toEqual(['--remove-signature', cliPath])
    expect(calls[2]?.slice(0, 4)).toEqual(['--force', '-s', '-', '--timestamp=none'])
    expect(calls[3]).toEqual(['--verify', '--verbose=2', cliPath])
  })
})

describe('smokeTestPromaCli', () => {
  test('Given CLI 返回合法 JSON 数组 When smoke Then 通过', () => {
    const run: RunCommand = ({ command, args }) => {
      expect(command).toContain('proma')
      expect(args).toContain('session')
      expect(args).toContain('list')
      expect(args).toContain('--json')
      expect(args).toContain('--config-dir')
      return {
        status: 0,
        signal: null,
        output: ['', '[]\n', ''],
        pid: 1,
        stdout: '[]\n',
        stderr: '',
      }
    }

    const dir = makeTempDir('proma-cli-smoke-')
    const cliPath = join(dir, 'proma')
    writeFileSync(cliPath, 'fake')
    smokeTestPromaCli(cliPath, { run, configDir: join(dir, 'cfg') })
  })

  test('Given exit 137 When smoke Then 抛出可读错误', () => {
    const run: RunCommand = () => ({
      status: 137,
      signal: 'SIGKILL',
      output: ['', '', ''],
      pid: 1,
      stdout: '',
      stderr: '',
    })

    const dir = makeTempDir('proma-cli-smoke-')
    const cliPath = join(dir, 'proma')
    writeFileSync(cliPath, 'fake')

    expect(() => smokeTestPromaCli(cliPath, { run, configDir: join(dir, 'cfg') })).toThrow(
      /137|SIGKILL/,
    )
  })

  test('Given 新复制 CLI 首次启动超时 When smoke Then 重试一次并通过', () => {
    let attempts = 0
    const run: RunCommand = () => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('spawnSync ETIMEDOUT') as NodeJS.ErrnoException
        error.code = 'ETIMEDOUT'
        return {
          status: null,
          signal: 'SIGTERM',
          error,
          output: ['', '', ''],
          pid: 1,
          stdout: '',
          stderr: '',
        }
      }
      return {
        status: 0,
        signal: null,
        output: ['', '[]\n', ''],
        pid: 2,
        stdout: '[]\n',
        stderr: '',
      }
    }

    const dir = makeTempDir('proma-cli-smoke-')
    const cliPath = join(dir, 'proma')
    writeFileSync(cliPath, 'fake')

    smokeTestPromaCli(cliPath, { run, configDir: join(dir, 'cfg') })
    expect(attempts).toBe(2)
  })

  test('Given CLI 返回普通失败 When smoke Then 不重试', () => {
    let attempts = 0
    const run: RunCommand = () => {
      attempts += 1
      return {
        status: 1,
        signal: null,
        output: ['', '', 'invalid command'],
        pid: 1,
        stdout: '',
        stderr: 'invalid command',
      }
    }

    const dir = makeTempDir('proma-cli-smoke-')
    const cliPath = join(dir, 'proma')
    writeFileSync(cliPath, 'fake')

    expect(() => smokeTestPromaCli(cliPath, { run, configDir: join(dir, 'cfg') })).toThrow(
      /invalid command/,
    )
    expect(attempts).toBe(1)
  })
})

describe('ensurePackagedPromaCli', () => {
  test('Given 打包产物缺少 CLI When 调用 Then 抛错', () => {
    const appOutDir = makeTempDir('proma-pack-missing-')
    expect(() => ensurePackagedPromaCli(appOutDir, 'linux')).toThrow(/缺少 proma CLI/)
  })

  test('Given 真实编译产物存在 When smoke 真机二进制 Then 通过', () => {
    const realCli = resolve(import.meta.dir, '../resources/bin/proma')
    if (!existsSync(realCli) || process.platform === 'win32') {
      // 未先 build:cli 时跳过集成断言
      return
    }

    // 不修改 resources 原件：复制到临时目录再校验（可能触发重签）
    const dir = makeTempDir('proma-cli-real-')
    const copyPath = join(dir, 'proma')
    copyFileSync(realCli, copyPath)
    chmodSync(copyPath, 0o755)

    if (process.platform === 'darwin') {
      ensureMacCliCodeSignature(copyPath)
    }
    smokeTestPromaCli(copyPath)
  }, 70_000)

  test('Given darwin 产物布局 When ensurePackagedPromaCli Then 走 App Bundle 路径', () => {
    const appOutDir = makeTempDir('proma-pack-darwin-')
    const cliPath = resolvePackagedCliPath(appOutDir, 'darwin')
    mkdirSync(join(cliPath, '..'), { recursive: true })
    writeFileSync(cliPath, 'fake')

    const run: RunCommand = ({ args, command }) => {
      if (command === '/usr/bin/codesign') {
        // 假装签名始终有效
        return {
          status: args[0] === '--verify' ? 0 : 0,
          signal: null,
          output: ['', '', ''],
          pid: 1,
          stdout: '',
          stderr: '',
        }
      }
      return {
        status: 0,
        signal: null,
        output: ['', '[]\n', ''],
        pid: 1,
        stdout: '[]\n',
        stderr: '',
      }
    }

    const result = ensurePackagedPromaCli(appOutDir, 'darwin', {
      platform: 'darwin',
      run,
      configDir: join(appOutDir, 'cfg'),
    })
    expect(result).toBe(cliPath)
  })
})
