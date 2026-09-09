import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigDir } from './paths'

const originalXcodeDev = process.env.XCODE_DEV
const originalPromaDev = process.env.PROMA_DEV

afterEach(() => {
  if (originalXcodeDev === undefined) delete process.env.XCODE_DEV
  else process.env.XCODE_DEV = originalXcodeDev
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
})

describe('CLI 配置目录解析', () => {
  test('Given 无覆盖参数 When 解析目录 Then 默认使用 ~/xcodes', () => {
    delete process.env.XCODE_DEV
    delete process.env.PROMA_DEV

    expect(resolveConfigDir()).toBe(join(homedir(), 'xcodes'))
  })

  test('Given --dev 或新旧开发变量 When 解析目录 Then 使用 ~/xcodes-dev', () => {
    expect(resolveConfigDir({ dev: true })).toBe(join(homedir(), 'xcodes-dev'))

    process.env.XCODE_DEV = '1'
    expect(resolveConfigDir()).toBe(join(homedir(), 'xcodes-dev'))
    delete process.env.XCODE_DEV

    process.env.PROMA_DEV = '1'
    expect(resolveConfigDir()).toBe(join(homedir(), 'xcodes-dev'))
  })

  test('Given 显式 --config-dir When 解析目录 Then 保持最高优先级', () => {
    process.env.XCODE_DEV = '1'
    expect(resolveConfigDir({ configDir: '/tmp/custom-xcodes' })).toBe('/tmp/custom-xcodes')
  })
})
