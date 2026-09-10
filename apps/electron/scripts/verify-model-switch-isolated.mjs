/**
 * 执行：bun run scripts/verify-model-switch-isolated.mjs
 * 独立 Chromium profile + 临时 HOME；真实界面仅接内存 IPC，无真实主进程和凭据。
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(tmpdir(), 'proma-model-switch-ui-'))
const home = join(output, 'home')
mkdirSync(home)
const configHome = join(output, 'config-home')
mkdirSync(configHome)
async function configCommand(action, input) {
  const child = spawn(process.execPath, [
    '--no-env-file', join(appRoot, 'scripts/pi-compaction-channel-fixture.mjs'), action,
  ], {
    cwd: configHome,
    env: {
      HOME: configHome, PROMA_COMPACTION_FIXTURE_HOME: configHome,
      PATH: process.env.PATH, TMPDIR: output,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(JSON.stringify(input))
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  if (code !== 0) throw new Error(`隔离配置命令失败：${stderr}\n${stdout}`)
  const prefix = 'PROMA_COMPACTION_FIXTURE_JSON='
  const line = stdout.split('\n').find(line => line.startsWith(prefix))
  if (!line) throw new Error(`隔离配置未返回结果：${stdout}`)
  return JSON.parse(line.slice(prefix.length))
}
const initialConfig = await configCommand('create', { channel: {
  name: '隔离压缩配置', provider: 'custom', baseUrl: 'http://127.0.0.1:1',
  apiKey: 'isolated-fixture-key', enabled: true, autoCompactRatio: 80,
  models: [
    { id: 'A', name: '模型 A', enabled: true, contextWindow: 200_000 },
    { id: 'B', name: '模型 B', enabled: true, contextWindow: 100_000, autoCompactRatio: 70 },
  ],
} })
const entry = join(appRoot, 'scripts/model-switch-isolation/fixture.tsx')
const server = await createServer({
  configFile: join(appRoot, 'vite.config.ts'),
  envDir: home,
  cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  plugins: [{
    name: 'isolated-model-switch-page',
    configureServer(vite) {
      vite.middlewares.use('/__compaction-config', async (request, response) => {
        try {
          let result
          if (request.method === 'POST') {
            let body = ''
            for await (const chunk of request) body += chunk
            result = await configCommand('update', {
              channelId: initialConfig.channel.id, patch: JSON.parse(body),
            })
          } else {
            result = await configCommand('inspect', { channelId: initialConfig.channel.id })
          }
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(result))
        } catch (error) {
          response.statusCode = 500
          response.end(JSON.stringify({ error: String(error) }))
        }
      })
      vite.middlewares.use('/__model-switch-test', async (_request, response, next) => {
        try {
          const html = await vite.transformIndexHtml('/__model-switch-test', `<!doctype html>
            <html><head><meta charset="UTF-8"></head><body style="margin:0">
            <div id="root" style="height:100vh;display:flex"></div>
            <script type="module" src="/@fs/${entry}"></script></body></html>`)
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        } catch (error) { next(error) }
      })
    },
  }],
})
try {
  await server.listen()
  const address = server.httpServer.address()
  const child = spawn(require('electron'), [
    join(appRoot, 'scripts/model-switch-isolation/electron.cjs'),
    `http://127.0.0.1:${address.port}/__model-switch-test`, output,
  ], {
    cwd: appRoot,
    env: { HOME: home, PATH: process.env.PATH, TMPDIR: output, LANG: 'en_US.UTF-8' },
    stdio: 'inherit',
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolveExit(code ?? 1))
  }).finally(() => clearTimeout(timer))
  process.exitCode = exitCode
} finally {
  await server.close()
  console.log(`测试产物保留于：${output}`)
}
