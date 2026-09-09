/**
 * 从唯一 SVG 母版生成 Xcode 的桌面、托盘和品牌素材。
 * 使用项目已有 Electron 渲染，无需安装 ImageMagick / librsvg。
 * 旧资源路径和颜色 ID 保留，兼容已有用户的图标偏好。
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const resources = resolve(__dirname, '../resources')
const logoDirectory = join(resources, 'proma-logos')
const rendererDirectory = resolve(__dirname, '../src/renderer/assets/bots/proma-logos')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'xcodes-icons-'))
// 保留原生对象强引用至退出，避免旧版 Electron 在关闭时提前 GC。
let renderWindow
let renderContents

// 图标构建使用独立空白 profile，绝不加载用户应用数据。
app.setPath('userData', join(temporaryDirectory, 'profile'))
app.disableHardwareAcceleration()

/** @param {Array<{ size: number, png: Buffer }>} images */
function createIco(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(({ png }) => png)])
}

async function generate() {
  renderWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  renderContents = renderWindow.webContents
  renderContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
    callback({ cancel: true })
  })
  await renderWindow.loadURL('data:text/html,<html><body></body></html>')

  /** @param {string} svg @param {number} size */
  async function render(svg, size) {
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    const pngUrl = await renderContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(dataUrl)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png');
    })()`)
    return Buffer.from(pngUrl.split(',')[1], 'base64')
  }

  const source = readFileSync(join(resources, 'icon.svg'), 'utf8')
  mkdirSync(logoDirectory, { recursive: true })
  mkdirSync(rendererDirectory, { recursive: true })
  writeFileSync(join(resources, 'icon.png'), await render(source, 1024))
  writeFileSync(resolve(rendererDirectory, '../../xcodes-icon.svg'), source)
  const mark = source
    .replace(/^[ \t]*<rect id="tile"[^>]*\/>\r?\n/m, '')
    .replace(/viewBox="[^"]+"/, 'viewBox="112 112 288 288"')
  writeFileSync(resolve(rendererDirectory, '../../xcodes-mark.svg'), mark
    .replace('#F0EEE7', '#2D2E2B'))

  // 托盘仅保留纯黑轮廓，交由 macOS Template 图标自动适配深浅色。
  const tray = mark.replace('#F0EEE7', '#000000')
  writeFileSync(join(logoDirectory, 'icon.svg'), tray)
  for (const scale of [1, 2, 3]) {
    const suffix = scale === 1 ? '' : `@${scale}x`
    writeFileSync(join(logoDirectory, `iconTemplate${suffix}.png`), await render(tray, 22 * scale))
  }

  const variants = [
    ['black', '#2D2E2B', '#F0EEE7'],
    ['white', '#F0EEE7', '#2D2E2B'],
    ['blue', '#687D90', '#F0EEE7'],
    ['purple', '#675080', '#F0EEE7'],
    ['gradient', 'url(#blend)', '#F0EEE7'],
    ['transparent', 'none', '#2D2E2B'],
    ['coral', '#F4729C', '#F0EEE7'],
    ['veri-peri', '#6667AB', '#F0EEE7'],
    ['viva-magenta', '#BB2649', '#F0EEE7'],
    ['mocha-mousse', '#A47764', '#F0EEE7'],
    ['emerald', '#009473', '#F0EEE7'],
    ['8bit', '#8A8174', '#F0EEE7'],
    ['cyberpunk', '#261C38', '#FCA7CE'],
    ['futuristic', '#44515B', '#D5F4F1'],
  ]
  for (const [id, background, foreground] of variants) {
    const svg = source
      .replace(/(<rect id="tile"[^>]*fill=")[^"]+/, `$1${background}`)
      .replace(/(<path id="mark"[^>]*stroke=")[^"]+/, `$1${foreground}`)
      .replace('</svg>', '<defs><linearGradient id="blend" x2="1" y2="1"><stop stop-color="#2D2E2B"/><stop offset="1" stop-color="#797B70"/></linearGradient></defs></svg>')
    const png = await render(svg, 1024)
    for (const directory of [logoDirectory, rendererDirectory]) {
      writeFileSync(join(directory, `proma-${id}.png`), png)
    }
  }

  const icoImages = []
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    icoImages.push({ size, png: await render(source, size) })
  }
  writeFileSync(join(resources, 'icon.ico'), createIco(icoImages))

  if (process.platform === 'darwin') {
    const iconset = join(temporaryDirectory, 'icon.iconset')
    mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const suffix = scale === 1 ? '' : '@2x'
        writeFileSync(join(iconset, `icon_${size}x${size}${suffix}.png`), await render(source, size * scale))
      }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')])
  } else {
    console.warn('[图标] ICNS 需要在 macOS 上重新生成。')
  }
  console.log('[图标] Xcode 应用、托盘及 14 款配色素材生成完成。')
}

app.whenReady().then(generate).then(() => setImmediate(() => app.quit())).catch((error) => {
  console.error('[图标] 生成失败：', error)
  app.exit(1)
})
app.on('quit', () => rmSync(temporaryDirectory, { recursive: true, force: true }))
