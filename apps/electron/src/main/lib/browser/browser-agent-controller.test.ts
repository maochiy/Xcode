import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { WebContents } from 'electron'

interface FakeFrame {
  name: string
  url: string
  origin: string
  parent: FakeFrame | null
  isDestroyed(): boolean
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>
}

interface FakeWebContents {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  executeJavaScript?(script: string, userGesture?: boolean): Promise<unknown>
  mainFrame: {
    framesInSubtree: FakeFrame[]
  }
}

let activeWebContents: FakeWebContents | null = null

const controller = await import('./browser-agent-controller')

describe('Browser Agent 任务生命周期', () => {
  beforeEach(() => {
    activeWebContents = null
    controller.resetBrowserAgentTasksForTest()
    controller.setBrowserAgentWebContentsResolverForTest(
      () => activeWebContents as unknown as WebContents | null,
    )
  })

  afterEach(() => {
    controller.setBrowserAgentWebContentsResolverForTest()
  })

  test('Given 新任务 When upsert Then 创建为 running 并可按会话列出', () => {
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: '读文档', url: 'https://a.com' })
    const tasks = controller.listBrowserAgentTasks('s1')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.status).toBe('running')
    expect(tasks[0]?.title).toBe('读文档')
  })

  test('Given 不同会话使用相同 taskId When 新会话开始任务 Then 不会抢走旧会话任务', () => {
    controller.upsertBrowserAgentTask({ taskId: 'browser-task', sessionId: 's1', title: '会话一' })

    const task = controller.upsertOrReuseBrowserAgentTask({
      taskId: 'browser-task',
      sessionId: 's2',
      title: '会话二',
      url: 'https://example.com/two',
    })

    expect(task.taskId).toBe('s2:browser-task')
    expect(controller.getBrowserAgentTask('browser-task')?.sessionId).toBe('s1')
    expect(controller.listBrowserAgentTasks('s1')).toHaveLength(1)
    expect(controller.listBrowserAgentTasks('s2')).toHaveLength(1)
  })

  test('Given 模型运行报错 When 结算为 failed Then 仅该会话 running 任务标 failed', () => {
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: 'A' })
    controller.upsertBrowserAgentTask({ taskId: 't2', sessionId: 's2', title: 'B' })
    const changed = controller.settleSessionBrowserTasks('s1', 'failed')
    expect(changed).toBe(1)
    expect(controller.getBrowserAgentTask('t1')?.status).toBe('failed')
    expect(controller.getBrowserAgentTask('t2')?.status).toBe('running')
  })

  test('Given 本轮存在浏览器任务 When Agent 正常结束 Then 任务收敛为 completed', () => {
    controller.prepareSessionBrowserTasksForRun('s1')
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: 'A' })

    const changed = controller.completeSessionBrowserTasks('s1')

    expect(changed).toBe(1)
    expect(controller.getBrowserAgentTask('t1')?.status).toBe('completed')
  })

  test('Given 本轮浏览器任务存在真实 AskUser pending When 等待用户 Then 仅本轮任务进入 waiting_user', () => {
    controller.upsertBrowserAgentTask({ taskId: 'old', sessionId: 's1', title: '旧任务' })
    controller.prepareSessionBrowserTasksForRun('s1')
    controller.upsertBrowserAgentTask({ taskId: 'current', sessionId: 's1', title: '当前任务' })

    const changed = controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-1')

    expect(changed).toBe(1)
    expect(controller.getBrowserAgentTask('old')?.status).toBe('paused')
    expect(controller.getBrowserAgentTask('current')?.status).toBe('waiting_user')
  })

  test('Given 本轮没有操作浏览器 When 普通 AskUser pending Then 不把旧浏览器任务变成长等待', () => {
    controller.upsertBrowserAgentTask({ taskId: 'old', sessionId: 's1', title: '旧任务' })
    controller.prepareSessionBrowserTasksForRun('s1')

    const waitingChanged = controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-unrelated')
    const completedChanged = controller.completeSessionBrowserTasks('s1')

    expect(waitingChanged).toBe(0)
    expect(completedChanged).toBe(1)
    expect(controller.getBrowserAgentTask('old')?.status).toBe('paused')
    expect(controller.resolveSessionBrowserTasksWaitingForUser('s1', 'ask-unrelated', true)).toBe(0)
  })

  test('Given 浏览器任务正在等待用户 When 对应 AskUser 被回答 Then 只恢复对应任务', () => {
    controller.prepareSessionBrowserTasksForRun('s1')
    controller.upsertBrowserAgentTask({ taskId: 'current', sessionId: 's1', title: '当前任务' })
    controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-current')
    controller.upsertBrowserAgentTask({ taskId: 'other', sessionId: 's2', title: '其他会话' })
    controller.setBrowserAgentTaskStatus('other', 'waiting_user')

    const changed = controller.resolveSessionBrowserTasksWaitingForUser(
      's1',
      'ask-current',
      true,
    )

    expect(changed).toBe(1)
    expect(controller.getBrowserAgentTask('current')?.status).toBe('running')
    expect(controller.getBrowserAgentTask('other')?.status).toBe('waiting_user')
  })

  test('Given 浏览器任务正在等待用户 When 用户停止或运行异常 Then waiting_user 一并收敛', () => {
    controller.prepareSessionBrowserTasksForRun('s1')
    controller.upsertBrowserAgentTask({ taskId: 'waiting', sessionId: 's1', title: '等待任务' })
    controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-stop')

    const changed = controller.settleSessionBrowserTasks('s1', 'paused')

    expect(changed).toBe(1)
    expect(controller.getBrowserAgentTask('waiting')?.status).toBe('paused')
    expect(controller.resolveSessionBrowserTasksWaitingForUser('s1', 'ask-stop', true)).toBe(0)
  })

  test('Given 问答请求未能送达或被取消 When 移除最后一个等待请求 Then 正常收尾也不残留幽灵等待', () => {
    controller.prepareSessionBrowserTasksForRun('s1')
    controller.upsertBrowserAgentTask({ taskId: 'waiting', sessionId: 's1', title: '等待任务' })
    controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-cancelled')

    expect(controller.resolveSessionBrowserTasksWaitingForUser('s1', 'ask-cancelled', false)).toBe(1)
    controller.completeSessionBrowserTasks('s1')

    expect(controller.getBrowserAgentTask('waiting')?.status).toBe('paused')
    expect(controller.resolveSessionBrowserTasksWaitingForUser('s1', 'ask-cancelled', true)).toBe(0)
  })

  test('Given 两个问答共同等待同一任务 When 只回答其中一个 Then 直到全部回答才恢复', () => {
    controller.prepareSessionBrowserTasksForRun('s1')
    controller.upsertBrowserAgentTask({ taskId: 'waiting', sessionId: 's1', title: '等待任务' })
    controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-first')
    controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-second')

    expect(controller.resolveSessionBrowserTasksWaitingForUser('s1', 'ask-first', true)).toBe(0)
    expect(controller.getBrowserAgentTask('waiting')?.status).toBe('waiting_user')
    expect(controller.resolveSessionBrowserTasksWaitingForUser('s1', 'ask-second', true)).toBe(1)
    expect(controller.getBrowserAgentTask('waiting')?.status).toBe('running')
  })

  test('Given 浏览器任务正在等待用户 When Agent 完成钩子被调用 Then 保持 waiting_user', () => {
    controller.prepareSessionBrowserTasksForRun('s1')
    controller.upsertBrowserAgentTask({ taskId: 'waiting', sessionId: 's1', title: '等待任务' })
    controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-1')

    const changed = controller.completeSessionBrowserTasks('s1')

    expect(changed).toBe(0)
    expect(controller.getBrowserAgentTask('waiting')?.status).toBe('waiting_user')
  })

  test('Given 上一轮任务仍为 running When 同一会话开始新一轮 Then 先保留任务等待关联性判定', () => {
    controller.upsertBrowserAgentTask({ taskId: 'old', sessionId: 's1', title: '旧任务' })
    controller.upsertBrowserAgentTask({ taskId: 'other', sessionId: 's2', title: '其他会话任务' })

    const pending = controller.prepareSessionBrowserTasksForRun('s1')

    expect(pending).toBe(1)
    expect(controller.getBrowserAgentTask('old')?.status).toBe('running')
    expect(controller.getBrowserAgentTask('other')?.status).toBe('running')
  })

  test('Given 新一轮与旧浏览器任务无关 When 出现非浏览器动作 Then 隐藏旧任务', () => {
    controller.upsertBrowserAgentTask({ taskId: 'old', sessionId: 's1', title: '旧任务' })
    controller.upsertBrowserAgentTask({ taskId: 'other', sessionId: 's2', title: '其他会话任务' })
    controller.prepareSessionBrowserTasksForRun('s1')

    const changed = controller.hideUnrelatedSessionBrowserTasksForRun('s1')

    expect(changed).toBe(1)
    expect(controller.getBrowserAgentTask('old')?.status).toBe('paused')
    expect(controller.getBrowserAgentTask('other')?.status).toBe('running')
  })

  test('Given 新一轮创建不同浏览器任务 When 新任务开始 Then 立即隐藏未复用的旧任务', () => {
    controller.upsertBrowserAgentTask({ taskId: 'old', sessionId: 's1', title: '旧任务' })
    controller.prepareSessionBrowserTasksForRun('s1')

    controller.upsertBrowserAgentTask({ taskId: 'new', sessionId: 's1', title: '新任务' })

    expect(controller.getBrowserAgentTask('old')?.status).toBe('paused')
    expect(controller.getBrowserAgentTask('new')?.status).toBe('running')
  })

  test('Given 新一轮待判定旧任务 When 本轮复用相同 taskId Then 任务继续显示', () => {
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: '旧标题' })
    controller.prepareSessionBrowserTasksForRun('s1')

    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: '继续处理' })
    const changed = controller.hideUnrelatedSessionBrowserTasksForRun('s1')

    expect(changed).toBe(0)
    expect(controller.getBrowserAgentTask('t1')?.status).toBe('running')
    expect(controller.getBrowserAgentTask('t1')?.title).toBe('继续处理')
  })

  test('Given 已有同 URL 的暂停任务 When 模型换了 taskId 重试 Then 复用旧任务且不创建重复条目', () => {
    controller.upsertBrowserAgentTask({
      taskId: 'review-progress',
      sessionId: 's1',
      title: '查看审核进度',
      url: 'https://appstoreconnect.apple.com/',
    })
    controller.prepareSessionBrowserTasksForRun('s1')

    const task = controller.upsertOrReuseBrowserAgentTask({
      taskId: 'review-progress-2',
      sessionId: 's1',
      title: '查看审核进度',
      url: 'https://appstoreconnect.apple.com',
    })

    expect(task.taskId).toBe('review-progress')
    expect(task.status).toBe('running')
    expect(controller.listBrowserAgentTasks('s1')).toHaveLength(1)
  })

  test('Given 已有跳转后的同名任务 When 新一轮请求原始 URL Then 按标题恢复旧任务', () => {
    controller.upsertBrowserAgentTask({
      taskId: 'review-progress',
      sessionId: 's1',
      title: 'App Store Connect 审核进度',
      url: 'https://appstoreconnect.apple.com/login',
    })
    controller.prepareSessionBrowserTasksForRun('s1')

    const task = controller.upsertOrReuseBrowserAgentTask({
      taskId: 'asc-review-3',
      sessionId: 's1',
      title: 'App Store Connect 审核进度',
      url: 'https://appstoreconnect.apple.com',
    })

    expect(task.taskId).toBe('review-progress')
    expect(controller.listBrowserAgentTasks('s1')).toHaveLength(1)
  })

  test('Given 暂停任务 When 新一轮直接读取页面 Then 恢复为 running', async () => {
    activeWebContents = {
      loadURL: async () => undefined,
      getURL: () => 'https://example.com',
      getTitle: () => 'Example',
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [] },
    }
    controller.upsertBrowserAgentTask({
      taskId: 't1',
      sessionId: 's1',
      title: 'Example',
      url: 'https://example.com',
    })
    controller.bindBrowserAgentTaskGuest('t1', 105)
    controller.prepareSessionBrowserTasksForRun('s1')

    await controller.browserAgentGetState('t1')

    expect(controller.getBrowserAgentTask('t1')?.status).toBe('running')
  })

  test('Given 新一轮复用旧元素引用 When 点击后请求用户操作 Then 旧任务进入 waiting_user', async () => {
    controller.upsertBrowserAgentTask({
      taskId: 't1',
      sessionId: 's1',
      title: 'Example',
      url: 'https://example.com',
    })
    controller.prepareSessionBrowserTasksForRun('s1')

    await controller.browserAgentClick('t1', { ref: 'expired-ref' })
    const changed = controller.markSessionBrowserTasksWaitingForUser('s1', 'ask-after-click')

    expect(changed).toBe(1)
    expect(controller.getBrowserAgentTask('t1')?.status).toBe('waiting_user')
  })

  test('Given 已结束任务超时 When prune Then 自动清理；running 和 waiting_user 不清理', () => {
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: 'A' })
    controller.setBrowserAgentTaskStatus('t1', 'failed')
    controller.upsertBrowserAgentTask({ taskId: 't2', sessionId: 's1', title: 'B' })
    controller.upsertBrowserAgentTask({ taskId: 't3', sessionId: 's1', title: 'C' })
    controller.setBrowserAgentTaskStatus('t3', 'waiting_user')
    // 模拟 11 分钟后
    const future = Date.now() + 11 * 60 * 1000
    const removed = controller.pruneStaleBrowserAgentTasks(future)
    expect(removed).toBe(1)
    expect(controller.getBrowserAgentTask('t1')).toBeUndefined()
    expect(controller.getBrowserAgentTask('t2')?.status).toBe('running')
    expect(controller.getBrowserAgentTask('t3')?.status).toBe('waiting_user')
  })

  test('Given 任务未绑定 guest When navigate Then 触发打开请求并等待绑定', async () => {
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: 'A' })
    let openRequested = ''
    const off = controller.onBrowserAgentOpenTask((task) => { openRequested = task.taskId })
    // navigate 不 await（它会等待绑定），随后模拟渲染层绑定 guest
    const navPromise = controller.browserAgentNavigate('t1', 'https://a.com')
    // 等待 ensureGuestReady 发出打开请求
    await new Promise((r) => setTimeout(r, 50))
    expect(openRequested).toBe('t1')
    // 模拟 webview 绑定（guestId 不存在 → 最终 loadURL 会失败，但绑定流程被验证）
    controller.bindBrowserAgentTaskGuest('t1', 999)
    const result = await navPromise
    off()
    // guestId 999 无真实 webContents → getGuest 返回 null → 返回失败而非挂起
    expect(result.ok).toBe(false)
  })

  test('Given 任务绑定 guest When unbind Then 解除映射', () => {
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: 'A' })
    controller.bindBrowserAgentTaskGuest('t1', 123, 'https://a.com')
    expect(controller.getBrowserAgentTask('t1')?.guestId).toBe(123)
    controller.unbindBrowserAgentTaskGuest(123)
    expect(controller.getBrowserAgentTask('t1')?.guestId).toBeUndefined()
  })

  test('Given loadURL 因重定向返回 ERR_ABORTED When 实际已进入目标站点 Then 导航按成功处理', async () => {
    let currentUrl = 'about:blank'
    activeWebContents = {
      async loadURL() {
        currentUrl = 'https://appstoreconnect.apple.com/login'
        throw Object.assign(new Error("ERR_ABORTED (-3) loading 'https://appstoreconnect.apple.com/'"), {
          code: 'ERR_ABORTED',
          errno: -3,
        })
      },
      getURL: () => currentUrl,
      getTitle: () => 'App Store Connect',
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [] },
    }
    controller.upsertBrowserAgentTask({ taskId: 'apple', sessionId: 's1', title: 'App Store Connect' })
    controller.bindBrowserAgentTaskGuest('apple', 101)

    const result = await controller.browserAgentNavigate('apple', 'https://appstoreconnect.apple.com/')

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      url: 'https://appstoreconnect.apple.com/login',
      title: 'App Store Connect',
      redirected: true,
    })
    expect(controller.getBrowserAgentTask('apple')?.url).toBe('https://appstoreconnect.apple.com/login')
  })

  test('Given 目录路径无末尾斜杠 When navigate Then 保持用户原始路径', async () => {
    let loadedUrl = ''
    activeWebContents = {
      async loadURL(url) {
        loadedUrl = url
      },
      getURL: () => loadedUrl,
      getTitle: () => 'Nexus',
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [] },
    }
    controller.upsertBrowserAgentTask({ taskId: 'nexus', sessionId: 's1', title: 'Nexus' })
    controller.bindBrowserAgentTaskGuest('nexus', 102)

    const result = await controller.browserAgentNavigate(
      'nexus',
      'https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus',
    )

    expect(loadedUrl).toBe('https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus')
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      url: 'https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus',
      title: 'Nexus',
    })
  })

  test('Given 荣耀 Overview 路径 When navigate Then 不追加斜杠避免路由到 notFound', async () => {
    let loadedUrl = ''
    activeWebContents = {
      async loadURL(url) {
        loadedUrl = url
      },
      getURL: () => loadedUrl,
      getTitle: () => '荣耀概览',
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [] },
    }
    controller.upsertBrowserAgentTask({ taskId: 'honor', sessionId: 's1', title: '荣耀概览' })
    controller.bindBrowserAgentTaskGuest('honor', 107)

    const result = await controller.browserAgentNavigate('honor', 'https://www.honor.com/cn/Overview')

    expect(loadedUrl).toBe('https://www.honor.com/cn/Overview')
    expect(result.ok).toBe(true)
  })

  test('Given 登录表单位于跨域 iframe When 获取页面状态 Then 返回正文和可操作元素引用', async () => {
    const mainFrame: FakeFrame = {
      name: '',
      url: 'https://appstoreconnect.apple.com/login',
      origin: 'https://appstoreconnect.apple.com',
      parent: null,
      isDestroyed: () => false,
      executeJavaScript: async () => ({
        title: 'App Store Connect',
        text: 'Apple.com 服务条款 隐私政策',
        elements: [],
      }),
    }
    const loginFrame: FakeFrame = {
      name: 'aid-auth-widget',
      url: 'https://idmsa.apple.com/appleauth/auth/signin',
      origin: 'https://idmsa.apple.com',
      parent: mainFrame,
      isDestroyed: () => false,
      executeJavaScript: async () => ({
        title: '',
        text: '登录 App Store Connect',
        elements: [{
          ref: 'f1e1',
          role: 'textbox',
          name: 'Apple 账户',
          tag: 'input',
          type: 'text',
          editable: true,
        }],
      }),
    }
    activeWebContents = {
      loadURL: async () => undefined,
      getURL: () => mainFrame.url,
      getTitle: () => 'App Store Connect',
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [mainFrame, loginFrame] },
    }
    controller.upsertBrowserAgentTask({ taskId: 'apple', sessionId: 's1', title: 'App Store Connect' })
    controller.bindBrowserAgentTaskGuest('apple', 102)

    const result = await controller.browserAgentGetState('apple')
    const data = result.data as {
      frames?: Array<{ frameUrl?: string; text?: string }>
      elements?: Array<{ ref?: string; name?: string }>
    } | undefined

    expect(result.ok).toBe(true)
    expect(data?.frames).toHaveLength(2)
    expect(data?.frames?.[1]).toMatchObject({
      frameUrl: 'https://idmsa.apple.com/appleauth/auth/signin',
      text: '登录 App Store Connect',
    })
    expect(data?.elements).toContainEqual(expect.objectContaining({
      ref: 'f1e1',
      name: 'Apple 账户',
    }))
  })

  test('Given 已读取元素引用 When 使用 ref 输入 Then 在所属跨域 iframe 操作', async () => {
    const mainFrame: FakeFrame = {
      name: '',
      url: 'https://appstoreconnect.apple.com/login',
      origin: 'https://appstoreconnect.apple.com',
      parent: null,
      isDestroyed: () => false,
      executeJavaScript: async () => ({
        title: 'App Store Connect',
        text: 'Apple.com',
        elements: [],
      }),
    }
    const executedScripts: string[] = []
    const loginFrame: FakeFrame = {
      name: 'aid-auth-widget',
      url: 'https://idmsa.apple.com/appleauth/auth/signin',
      origin: 'https://idmsa.apple.com',
      parent: mainFrame,
      isDestroyed: () => false,
      executeJavaScript: async (script) => {
        executedScripts.push(script)
        if (script.includes('__promaBrowserElementsV1') && script.includes('nextValue')) {
          return { ok: true }
        }
        return {
          title: '',
          text: '登录 App Store Connect',
          elements: [{
            ref: 'f1e1',
            role: 'textbox',
            name: 'Apple 账户',
            tag: 'input',
            type: 'text',
            editable: true,
          }],
        }
      },
    }
    activeWebContents = {
      loadURL: async () => undefined,
      getURL: () => mainFrame.url,
      getTitle: () => 'App Store Connect',
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [mainFrame, loginFrame] },
    }
    controller.upsertBrowserAgentTask({ taskId: 'apple', sessionId: 's1', title: 'App Store Connect' })
    controller.bindBrowserAgentTaskGuest('apple', 103)
    await controller.browserAgentGetState('apple')

    const result = await controller.browserAgentType('apple', { ref: 'f1e1' }, 'user@example.com')

    expect(result.ok).toBe(true)
    expect(executedScripts.some((script) => script.includes('user@example.com'))).toBe(true)
  })

  test('Given 页面变化后引用不存在 When 使用旧 ref Then 提示重新读取页面', async () => {
    activeWebContents = {
      loadURL: async () => undefined,
      getURL: () => 'https://example.com',
      getTitle: () => 'Example',
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [] },
    }
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: 'Example' })
    controller.bindBrowserAgentTaskGuest('t1', 104)

    const result = await controller.browserAgentClick('t1', { ref: 'f0e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('browser_get_state')
  })

  test('Given Agent 向下滚动页面 When 执行 Then 显示滚动轨迹后再滚动', async () => {
    let script = ''
    activeWebContents = {
      loadURL: async () => undefined,
      getURL: () => 'https://example.com',
      getTitle: () => 'Example',
      isDestroyed: () => false,
      executeJavaScript: async (value) => {
        script = value
        return true
      },
      mainFrame: { framesInSubtree: [] },
    }
    controller.upsertBrowserAgentTask({ taskId: 't1', sessionId: 's1', title: 'Example' })
    controller.bindBrowserAgentTaskGuest('t1', 106)

    const result = await controller.browserAgentScroll('t1', 'down', 600)

    expect(result.ok).toBe(true)
    expect(script).toContain('data-proma-agent-pointer')
    expect(script).toMatch(/await pointer\.scroll\(["']down["']\)/)
    expect(script.indexOf('await pointer.scroll')).toBeLessThan(script.indexOf('window.scrollBy'))
  })
})
