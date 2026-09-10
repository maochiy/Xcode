/** 仅启动测试 BrowserWindow，不导入应用主进程，不加载真实 preload。 */
const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const [url, output] = process.argv.slice(2)
app.setPath('userData', path.join(output, 'electron-profile'))
app.setPath('sessionData', path.join(output, 'electron-session'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function run() {
  await app.whenReady()
  const blocked = []
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const allowed = details.url.startsWith(new URL(url).origin + '/')
      || details.url.startsWith('data:') || details.url.startsWith('blob:')
      || details.url.startsWith(new URL(url).origin.replace('http:', 'ws:') + '/')
    if (!allowed) blocked.push(details.url)
    done({ cancel: !allowed })
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, done) => done(false))
  const window = new BrowserWindow({
    width: 1100, height: 850, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const consoleErrors = []
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(message)
  })
  const evaluate = source => window.webContents.executeJavaScript(source, true)
  const snapshot = () => evaluate('window.modelSwitchFixture.snapshot()')
  async function waitFor(expression) {
    for (let i = 0; i < 400; i++) {
      if (await evaluate(expression)) return
      await delay(50)
    }
    fs.writeFileSync(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    fs.writeFileSync(path.join(output, 'failure-dom.txt'), await evaluate('document.body.innerText'))
    throw new Error(`界面等待超时：${expression}\n${JSON.stringify(await snapshot())}\n${consoleErrors.join('\n')}`)
  }
  async function click(selector) {
    await waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  async function chooseModel(model) {
    await click('button[aria-label^="模型与思考等级："]')
    await click('button[aria-label^="选择模型，当前："]')
    await waitFor(`Array.from(document.querySelectorAll('button[aria-pressed]')).some(b => b.textContent === '模型 ${model}' && !b.disabled)`)
    await evaluate(`Array.from(document.querySelectorAll('button[aria-pressed]')).find(b => b.textContent === '模型 ${model}').click()`)
    await waitFor(`window.modelSwitchFixture.snapshot().selected === '${model}'`)
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`)
  }
  async function input(text) {
    await waitFor(`document.querySelector('[contenteditable="true"]')`)
    await evaluate(`document.querySelector('[contenteditable="true"]').focus()`)
    await window.webContents.insertText(text)
  }
  async function checkContext(name, windowValue, threshold) {
    await delay(200)
    await click('button[aria-label="上下文使用量与压缩设置"]')
    const field = label => `Array.from(document.querySelectorAll('span')).find(e => e.textContent === ${JSON.stringify(label)})?.nextElementSibling?.textContent`
    await waitFor(`(${field('压缩阈值')}) === ${JSON.stringify(threshold)}`)
    assert.equal(await evaluate(field('自动压缩')), '已开启')
    assert.equal(await evaluate(field('可用窗口')), windowValue)
    assert.match(await evaluate(field('上下文')), new RegExp(`/ ${windowValue.replace('.', '\\.')}$`))
    // 等 Popover 布局与进入动画绘制完成，截图不能只捕获 DOM 提交前的上一帧。
    await delay(250)
    fs.writeFileSync(path.join(output, `${name}-context.png`), (await window.webContents.capturePage()).toPNG())
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`)
  }
  async function fill(expression, value) {
    await waitFor(`!!(${expression})`)
    await evaluate(`(() => {
      const element = ${expression};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', {bubbles: true}));
      element.dispatchEvent(new Event('change', {bubbles: true}));
    })()`)
  }
  async function saveSettings() {
    const button = `Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === '保存配置')`
    await waitFor(`(${button}) && !(${button}).disabled`)
    await evaluate(`(${button}).click()`)
    await waitFor(`!Array.from(document.querySelectorAll('h3')).some(e => e.textContent === '编辑模型配置')`)
  }
  const results = []
  for (const immediate of [false, true]) {
    const name = immediate ? 'switch-then-immediate-send' : 'switch-only'
    await window.loadURL(url)
    await waitFor(`!!document.querySelector('button[aria-label^="模型与思考等级：模型 A"]')`)
    const before = await snapshot()
    assert.equal(before.stream.running, true)
    assert.equal(before.stream.model, 'A')
    fs.writeFileSync(path.join(output, `${name}-before.png`), (await window.webContents.capturePage()).toPNG())
    await checkContext(`${name}-running-A`, '128.0k', '102.4k')
    await chooseModel('B')
    const selected = await snapshot()
    assert.equal(selected.selected, 'B')
    assert.equal(selected.persisted, 'B')
    assert.deepEqual(selected.stream, before.stream)
    assert.equal(selected.calls.filter(call => call.method === 'stopAgent').length, 0)
    assert.equal(selected.calls.filter(call => call.method === 'sendAgentMessage').length, 0)
    await checkContext(`${name}-selected-B-still-A`, '128.0k', '102.4k')
    fs.writeFileSync(path.join(output, `${name}-selected.png`), (await window.webContents.capturePage()).toPNG())
    if (immediate) {
      await input('切换 B 后立即追加的指令')
      await click('button[aria-label="插入新指令（不打断工具）"]')
      await waitFor(`window.modelSwitchFixture.snapshot().calls.some(call => call.method === 'queueAgentMessage')`)
      const sent = await snapshot()
      const queued = sent.calls.filter(call => call.method === 'queueAgentMessage')
      assert.equal(queued.length, 1)
      assert.equal(queued[0].args[0].sessionId, 'isolated-model-switch')
      assert.equal(queued[0].args[0].interrupt, true)
      assert.match(queued[0].args[0].userMessage, /切换 B 后立即追加的指令/)
      assert.equal(queued[0].args[0].modelId, undefined)
      assert.deepEqual(sent.stream, before.stream)
      assert.equal(sent.pending.length, 1)
      assert.equal(sent.calls.filter(call => call.method === 'sendAgentMessage' || call.method === 'stopAgent').length, 0)
    }
    await evaluate('window.modelSwitchFixture.advance()')
    const continued = await snapshot()
    assert.equal(continued.stream.model, 'A')
    assert.match(continued.stream.content, /A 继续输出/)
    assert.equal(continued.stream.toolActivities[0].done, false)
    assert.equal(continued.stream.contextWindow, 128000)
    if (!immediate) {
      await evaluate('window.modelSwitchFixture.finish()')
      await checkContext(`${name}-idle-B`, '256.0k', '204.8k')
      await input('当前轮完成后的下一轮')
      await click('button[aria-label="发送消息"]')
      await waitFor(`window.modelSwitchFixture.snapshot().calls.some(call => call.method === 'sendAgentMessage')`)
      const completed = await snapshot()
      const newRun = completed.calls.find(call => call.method === 'sendAgentMessage')
      assert.equal(newRun.args[0].sessionId, 'isolated-model-switch')
      assert.equal(newRun.args[0].modelId, 'B')
      assert.equal(completed.stream.autoCompactThreshold, 204800)
      await checkContext(`${name}-new-run-B`, '256.0k', '204.8k')
    }
    const final = await snapshot()
    assert.deepEqual(final.errors, [])
    await delay(200)
    fs.writeFileSync(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    results.push({ scenario: name, passed: true, before, selected, snapshot: final })
  }
  // 真实 ChannelForm → 真实 channel-manager 临时文件保存/重读 → 真实目录 → AgentView。
  // AgentView 保持挂载，以覆盖“只改比例、模型元数据不变”的缓存刷新。
  await window.loadURL(`${url}?settings=1`)
  await waitFor(`!!document.querySelector('button[aria-label^="模型与思考等级：模型 A"]')`)
  await checkContext('configured-A-default', '200.0k', '160.0k')
  await click('button[aria-label="编辑隔离模型配置"]')
  const globalRatio = `Array.from(document.querySelectorAll('input[type="number"]')).find(e => e.parentElement.textContent.includes('整个供应商所有模型'))`
  await fill(globalRatio, '60')
  await saveSettings()
  await checkContext('configured-A-global-60', '200.0k', '120.0k')
  assert.equal((await snapshot()).channel.autoCompactRatio, 60)
  await chooseModel('B')
  await checkContext('configured-B-override-70', '100.0k', '70.0k')
  await click('button[aria-label="编辑隔离模型配置"]')
  await waitFor(`document.querySelectorAll('button[title="编辑模型配置"]').length === 2`)
  await evaluate(`document.querySelectorAll('button[title="编辑模型配置"]')[1].click()`)
  const modelField = label => `Array.from(document.querySelectorAll('label')).find(e => e.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('input')`
  await fill(modelField('Context Window'), '120000')
  await fill(modelField('压缩触发占比'), '50')
  await saveSettings()
  await checkContext('configured-B-window-120-ratio-50', '120.0k', '60.0k')
  // 清空全局配置恢复80%，不影响B的模型覆盖。
  await click('button[aria-label="编辑隔离模型配置"]')
  await fill(globalRatio, '')
  await saveSettings()
  assert.equal((await snapshot()).channel.autoCompactRatio, undefined)
  await checkContext('configured-B-after-clear-global', '120.0k', '60.0k')
  await chooseModel('A')
  await checkContext('configured-A-clear-global-default', '200.0k', '160.0k')
  await input('按已保存配置开始下一轮')
  await click('button[aria-label="发送消息"]')
  await waitFor(`window.modelSwitchFixture.snapshot().calls.some(call => call.method === 'sendAgentMessage')`)
  assert.equal((await snapshot()).stream.autoCompactThreshold, 160000)
  await checkContext('configured-A-new-run', '200.0k', '160.0k')
  results.push({ scenario: 'settings-save-reload-context-policy', passed: true, snapshot: await snapshot() })
  assert.deepEqual(consoleErrors, [])
  assert.deepEqual((await snapshot()).errors, [])
  assert.deepEqual(blocked, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, blocked, consoleErrors }, null, 2))
  console.log(`隔离界面验证通过：${results.length} 个场景。证据目录：${output}`)
  window.destroy()
}
run().then(() => app.exit(0)).catch(error => {
  fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error))
  console.error(error)
  app.exit(1)
})
