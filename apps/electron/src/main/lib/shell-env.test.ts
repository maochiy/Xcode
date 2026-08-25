import { afterAll, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

const { getShellEnv, runShellEnvCommand } = await import('./shell-env')

const temporaryDirectories: string[] = []

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('macOS Shell 环境采集', () => {
  test('Given 登录 Shell 正常输出 When 加载环境 Then 解析标记后的变量', async () => {
    const env = await getShellEnv('/bin/sh', { timeoutMs: 2_000 })

    expect(env.HOME).toBe(process.env.HOME)
    expect(env.SHELL).toBe('/bin/sh')
    expect(env.SHLVL).toBeUndefined()
  })

  test('Given Shell 后代忽略 SIGTERM 并持有管道 When 超时 Then 终止整个进程组且不会永久阻塞', async () => {
    const directory = makeTempDir('proma-shell-env-')
    const shell = join(directory, 'blocking-shell.sh')
    writeFileSync(
      shell,
      [
        '#!/bin/sh',
        "trap '' TERM",
        "(trap '' TERM; while :; do sleep 1; done) &",
        'while :; do sleep 1; done',
      ].join('\n'),
    )
    chmodSync(shell, 0o755)

    const startedAt = Date.now()
    await expect(runShellEnvCommand(shell, 'env', 50)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    })
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  })
})
