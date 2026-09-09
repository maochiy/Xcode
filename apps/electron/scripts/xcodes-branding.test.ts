import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolvePackagedCliPath } from './packaged-cli-guard'
import { resolvePackagedResourcesRoot } from './packaged-runtime-guard'

const appDirectory = resolve(import.meta.dir, '..')
const resources = resolve(appDirectory, 'resources')

function readPngSize(buffer: Buffer): [number, number] {
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)]
}

describe('Xcode 品牌交付', () => {
  test('Given 应用改名 When 定位 macOS 内核与 CLI Then 使用独立 Bundle 且保留 CLI 协议名', () => {
    const root = resolve('/output', 'Xcode-Desktop.app', 'Contents', 'Resources')
    expect(resolvePackagedResourcesRoot('/output', 'darwin')).toBe(root)
    expect(resolvePackagedCliPath('/output', 'darwin')).toBe(resolve(root, 'bin/proma'))
    const config = readFileSync(resolve(appDirectory, 'electron-builder.yml'), 'utf8')
    expect(config).toContain('productName: Xcode')
    expect(config).toContain('appId: com.proma.app')
    expect(config).toContain('ext: proma-backup')
    expect(config).toContain('ext: proma-share')
    const pkg = JSON.parse(readFileSync(resolve(appDirectory, 'package.json'), 'utf8')) as {
      productName: string
      name: string
    }
    expect(pkg.productName).toBe('Xcode')
    expect(pkg.name).toBe('@proma/electron')
  })

  test('Given 不同显示密度 When 使用应用和托盘图标 Then 提供真实 PNG 与各倍率资源', () => {
    expect(readPngSize(readFileSync(resolve(resources, 'icon.png')))).toEqual([1024, 1024])
    for (const scale of [1, 2, 3]) {
      const suffix = scale === 1 ? '' : `@${scale}x`
      const png = readFileSync(resolve(resources, `proma-logos/iconTemplate${suffix}.png`))
      expect(readPngSize(png)).toEqual([22 * scale, 22 * scale])
    }
  })

  test('Given 用户已有配色偏好 When 切换图标或下载品牌素材 Then 两个入口提供同一新版图标', () => {
    const files = readdirSync(resolve(resources, 'proma-logos'))
      .filter((name) => name.startsWith('proma-') && name.endsWith('.png'))
    expect(files).toHaveLength(14)
    for (const file of files) {
      const bundled = readFileSync(resolve(resources, 'proma-logos', file))
      const preview = readFileSync(resolve(appDirectory, 'src/renderer/assets/bots/proma-logos', file))
      expect(readPngSize(bundled)).toEqual([1024, 1024])
      expect(bundled.equals(preview)).toBe(true)
    }
  })

  test('Given 用户确认石墨黑圆润交叉 When 使用默认图标 Then 保留确认稿造型与配色且反白版独立', () => {
    const icon = readFileSync(resolve(resources, 'icon.png'))
    const black = readFileSync(resolve(resources, 'proma-logos/proma-black.png'))
    const white = readFileSync(resolve(resources, 'proma-logos/proma-white.png'))
    const source = readFileSync(resolve(resources, 'icon.svg'), 'utf8')
    expect(source).toContain('fill="#2D2E2B"')
    expect(source).toContain('stroke="#F0EEE7"')
    expect(source).toContain('stroke-linecap="round"')
    expect(source).toContain('M172 169C213 199 227 225 256 256S305 317 340 343M340 169C299 199 285 225 256 256S207 317 172 343')
    expect(source).not.toContain('#C86A4C')
    expect(source).not.toContain('#3D5AFE')
    expect(icon.equals(black)).toBe(true)
    expect(white.equals(black)).toBe(false)
  })

  test('Given 应用与网页分别加载图标 When 读取品牌素材 Then 使用同一母版且托盘不带方形背景', () => {
    const source = readFileSync(resolve(resources, 'icon.svg'), 'utf8')
    const renderer = readFileSync(resolve(appDirectory, 'src/renderer/assets/xcodes-icon.svg'), 'utf8')
    expect(renderer).toBe(source)
    const tray = readFileSync(resolve(resources, 'proma-logos/icon.svg'), 'utf8')
    expect(tray).not.toContain('<rect')
    expect(tray).toContain('stroke="#000000"')
    expect(tray).toContain('stroke-linecap="round"')
  })

  test('Given Windows 安装图标 When 读取 ICO Then 各尺寸嵌入可解码 PNG 且偏移正确', () => {
    const ico = readFileSync(resolve(resources, 'icon.ico'))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBe(7)
    const sizes: number[] = []
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16
      const size = ico[entry] || 256
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(offset + length).toBeLessThanOrEqual(ico.length)
      expect(readPngSize(ico.subarray(offset, offset + length))).toEqual([size, size])
      sizes.push(size)
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256])
  })

  test('Given macOS 安装图标 When 读取 ICNS Then 包含完整尺寸和 Retina 图像', () => {
    const icns = readFileSync(resolve(resources, 'icon.icns'))
    expect(icns.subarray(0, 4).toString()).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const types: string[] = []
    for (let offset = 8; offset < icns.length;) {
      const length = icns.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThanOrEqual(8)
      types.push(icns.subarray(offset, offset + 4).toString())
      offset += length
      expect(offset).toBeLessThanOrEqual(icns.length)
    }
    expect(types).toContain('ic10')
    expect(types).toContain('ic07')
  })
})
