import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const tempHome = mkdtempSync(join(os.tmpdir(), 'xcodes-attachment-migration-'))
const originalHome = process.env.HOME
const originalXcodeDev = process.env.XCODE_DEV
const originalPromaDev = process.env.PROMA_DEV

process.env.HOME = tempHome
process.env.XCODE_DEV = '0'
process.env.PROMA_DEV = '0'

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

mock.module('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))

let readAttachmentAsBase64: typeof import('./attachment-service').readAttachmentAsBase64
let getConfigDir: typeof import('./config-paths').getConfigDir

beforeAll(async () => {
  const attachmentService = await import('./attachment-service')
  const configPaths = await import('./config-paths')
  readAttachmentAsBase64 = attachmentService.readAttachmentAsBase64
  getConfigDir = configPaths.getConfigDir
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalXcodeDev === undefined) delete process.env.XCODE_DEV
  else process.env.XCODE_DEV = originalXcodeDev
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSync(tempHome, { recursive: true, force: true })
})

describe('历史绝对附件路径兼容', () => {
  test('Given 旧目录附件已迁移 When 读取历史绝对路径 Then 新副本优先且缺失时回退旧原件', () => {
    const relativePath = join('attachments', 'agent', 'session-1', 'image.png')
    const legacyPath = join(tempHome, '.proma', relativePath)
    mkdirSync(join(legacyPath, '..'), { recursive: true })
    writeFileSync(legacyPath, 'legacy')

    const configDir = getConfigDir()
    const migratedPath = join(configDir, relativePath)
    expect(existsSync(migratedPath)).toBe(true)

    writeFileSync(migratedPath, 'migrated')
    expect(Buffer.from(readAttachmentAsBase64(legacyPath), 'base64').toString()).toBe('migrated')

    unlinkSync(migratedPath)
    expect(Buffer.from(readAttachmentAsBase64(legacyPath), 'base64').toString()).toBe('legacy')
  })

  test('Given 相似旧目录前缀 When 读取绝对路径 Then 拒绝越过配置根边界', () => {
    const unsafePath = join(tempHome, '.proma-other', 'attachments', 'secret.txt')
    mkdirSync(join(unsafePath, '..'), { recursive: true })
    writeFileSync(unsafePath, 'secret')

    expect(() => readAttachmentAsBase64(unsafePath)).toThrow('附件路径不在安全目录内')
  })
})
