import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentSessionManager = typeof import('./agent-session-manager')
type AgentSessionContextPrompt = typeof import('./agent-session-context-prompt')

let manager: AgentSessionManager
let contextPrompt: AgentSessionContextPrompt
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalResourcesPath = process.resourcesPath

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function jsonl(rows: string[]): string {
  return rows.join('\n') + '\n'
}

function writeAgentSessionJsonl(sessionId: string, rows: string[]): void {
  const dir = join(tempHome, '.proma', 'agent-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(rows), 'utf-8')
}

function writeAgentSessionsIndex(sessions: Array<{
  id: string
  title: string
  workspaceId: string
  createdAt: number
  updatedAt: number
  runtimeSessionId?: string
  titleSource?: 'runtime' | 'generated' | 'user'
  channelId?: string
  modelId?: string
  pinned?: boolean
  archived?: boolean
  starred?: boolean
  permissionMode?: 'default' | 'bypassPermissions' | 'plan'
  planModeEnabled?: boolean
  draft?: boolean
}>): void {
  const dir = join(tempHome, '.proma')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version: 2, sessions }), 'utf-8')
}

function createIndexedSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `会话 ${index}`,
    workspaceId: 'workspace-a',
    createdAt: index,
    updatedAt: index,
  }))
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-agent-session-manager-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: tempHome,
  })
  delete process.env.CLAUDE_CONFIG_DIR
  manager = await import('./agent-session-manager')
  contextPrompt = await import('./agent-session-context-prompt')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: originalResourcesPath,
  })
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Agent 会话 JSONL 读取', () => {
  test('Given 立即发送导致旧 assistant 晚于新 user 追加 When 读取 JSONL Then 按创建时间恢复消息顺序', () => {
    writeAgentSessionJsonl('session-steering-order', [
      JSON.stringify({
        type: 'user',
        uuid: 'old-user',
        message: { content: [{ type: 'text', text: '旧问题' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'new-user',
        message: { content: [{ type: 'text', text: '立即补充' }] },
        parent_tool_use_id: null,
        _createdAt: 300,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'old-assistant',
        message: {
          id: 'old-assistant-model-message',
          content: [{ type: 'text', text: '旧问题的完整回答' }],
        },
        parent_tool_use_id: null,
        _createdAt: 200,
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages('session-steering-order')

    expect(messages.map((message) => (
      (message as { uuid?: string }).uuid
    ))).toEqual(['old-user', 'old-assistant', 'new-user'])
  })

  test('Given 会话 JSONL 混入损坏行 When 读取 SDKMessage Then 跳过坏行并保留其它消息', () => {
    writeAgentSessionJsonl('session-with-bad-line', [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '你好' }] }, parent_tool_use_id: null }),
      '{ 这不是合法 JSON',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '仍然可读' }] }, parent_tool_use_id: null }),
    ])

    const messages = manager.getAgentSessionSDKMessages('session-with-bad-line')

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  test('Given 历史消息包含 CCB 非法 thinking 正文块 When 读取 Then 恢复为标准 text 块', () => {
    writeAgentSessionJsonl('session-with-malformed-thinking-text', [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'thinking',
            thinking: '',
            signature: '',
            text: '历史正文',
          }],
        },
        parent_tool_use_id: null,
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages(
      'session-with-malformed-thinking-text',
    )

    expect(messages[0]).toMatchObject({
      message: {
        content: [{ type: 'text', text: '历史正文' }],
      },
    })
  })

  test('Given CCB 自动重试原始错误已同步到本地 When 读取 Then 不展示为未知错误', () => {
    writeAgentSessionJsonl('session-with-runtime-retry-error', [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'API Error: 429 The engine is currently overloaded' }],
        },
        error: {
          status: 429,
          error: {
            message: 'The engine is currently overloaded',
            type: 'EngineOverloadedError',
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '重试后执行成功' }],
        },
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages(
      'session-with-runtime-retry-error',
    )

    expect(messages).toHaveLength(1)
    expect(
      (messages[0] as unknown as {
        message: { content: Array<{ text?: string }> }
      }).message.content[0]?.text,
    ).toBe('重试后执行成功')
  })

  test('Given 会话 JSONL 存在损坏行 When 截断 SDKMessage Then 抛错避免重写不完整历史', () => {
    writeAgentSessionJsonl('session-truncate-bad-line', [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: '完成' }] } }),
      '{ 这不是合法 JSON',
    ])

    expect(() => manager.truncateSDKMessages('session-truncate-bad-line', 'assistant-1'))
      .toThrow('JSONL 第 2 行解析失败')
  })
})

describe('Agent 会话元数据', () => {
  test('Given 新建空白任务 When 标记为 draft Then 会话保持临时状态直到首条消息', () => {
    const session = manager.createAgentSession(
      '空白任务',
      undefined,
      'workspace-a',
      undefined,
      true,
    )

    expect(session.draft).toBe(true)
    expect(manager.getAgentSessionMeta(session.id)?.draft).toBe(true)

    const activated = manager.updateAgentSessionMeta(session.id, { draft: false })
    expect(activated.draft).toBe(false)
  })

  test('Given 会话切换审批与计划模式 When 更新元数据 Then 不刷新侧边栏顺序', () => {
    const session = manager.createAgentSession('计划设置')
    const originalUpdatedAt = session.updatedAt

    const updated = manager.updateAgentSessionMeta(session.id, {
      permissionMode: 'default',
      planModeEnabled: true,
    })

    expect(updated).toMatchObject({
      permissionMode: 'default',
      planModeEnabled: true,
      updatedAt: originalUpdatedAt,
    })
  })

  test('Given 历史会话把 plan 存在审批字段 When 读取索引 Then 拆分为请求批准与独立计划模式', () => {
    writeAgentSessionsIndex([
      {
        id: 'legacy-plan-session',
        title: '历史计划会话',
        workspaceId: 'workspace-a',
        permissionMode: 'plan',
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    expect(manager.getAgentSessionMeta('legacy-plan-session')).toMatchObject({
      permissionMode: 'default',
      planModeEnabled: true,
    })
  })

  test('Given a session When star state is updated Then it persists without changing freshness or archive state', () => {
    const session = manager.createAgentSession('星标会话')
    const archived = manager.updateAgentSessionMeta(session.id, { archived: true })

    const updated = manager.updateAgentSessionMeta(session.id, { starred: true })

    expect(updated).toMatchObject({ starred: true, archived: true })
    expect(updated.updatedAt).toBe(archived.updatedAt)
    expect(manager.getAgentSessionMeta(session.id)).toMatchObject({ starred: true, archived: true })
  })

  test('Given 会话按最近活动排序 When 批量切换渠道和模型 Then 保留顺序与归档状态', () => {
    writeAgentSessionsIndex([
      {
        id: 'recent-session',
        title: '最近会话',
        workspaceId: 'workspace-a',
        channelId: 'channel-old',
        modelId: 'model-old',
        archived: true,
        createdAt: 10,
        updatedAt: 200,
      },
      {
        id: 'older-session',
        title: '较早会话',
        workspaceId: 'workspace-a',
        channelId: 'channel-old',
        modelId: 'model-old',
        createdAt: 5,
        updatedAt: 100,
      },
    ])

    const updated = manager.updateAgentSessionMeta('recent-session', {
      channelId: 'channel-new',
      modelId: 'model-new',
    })

    expect(updated).toMatchObject({
      channelId: 'channel-new',
      modelId: 'model-new',
      archived: true,
      updatedAt: 200,
    })
    expect(manager.listAgentSessions().map(session => session.id)).toEqual([
      'recent-session',
      'older-session',
    ])
  })

  test('Given CCB 会话目录 When 同步 UI 投影 Then 导入 Runtime 会话并保留 Proma 桌面字段与排序时间', () => {
    writeAgentSessionsIndex([
      {
        id: 'proma-session',
        runtimeSessionId: 'ccb-session',
        title: 'Proma 本地标题',
        workspaceId: 'workspace-old',
        channelId: 'channel-1',
        modelId: 'model-1',
        pinned: true,
        archived: true,
        starred: true,
        createdAt: 10,
        updatedAt: 20,
      },
      {
        id: 'ccb-imported-session',
        runtimeSessionId: 'ccb-imported-session',
        title: 'CCB 旧标题',
        workspaceId: 'workspace-old',
        createdAt: 5,
        updatedAt: 15,
      },
    ])

    manager.syncRuntimeSessionCatalog('workspace-new', [
      {
        runtimeSessionId: 'ccb-session',
        title: 'CCB 新标题',
        summary: 'CCB 摘要',
        cwd: '/tmp/project',
        createdAt: 1,
        updatedAt: 100,
      },
      {
        runtimeSessionId: 'ccb-imported-session',
        title: 'CCB 更新标题',
        summary: 'CCB 更新摘要',
        cwd: '/tmp/project',
        createdAt: 5,
        updatedAt: 80,
      },
      {
        runtimeSessionId: 'ccb-new-session',
        title: 'CCB 新会话',
        summary: '新会话摘要',
        cwd: '/tmp/project',
        createdAt: 50,
        updatedAt: 60,
      },
    ])

    expect(manager.getAgentSessionMeta('proma-session')).toMatchObject({
      runtimeSessionId: 'ccb-session',
      title: 'Proma 本地标题',
      workspaceId: 'workspace-new',
      channelId: 'channel-1',
      modelId: 'model-1',
      pinned: true,
      archived: true,
      starred: true,
      createdAt: 10,
      updatedAt: 20,
    })
    expect(manager.getAgentSessionMeta('ccb-imported-session')).toMatchObject({
      title: 'CCB 更新标题',
      titleSource: 'runtime',
      workspaceId: 'workspace-new',
      updatedAt: 80,
    })
    expect(manager.listAgentSessions()).toContainEqual(
      expect.objectContaining({
        id: 'ccb-new-session',
        runtimeSessionId: 'ccb-new-session',
        workspaceId: 'workspace-new',
        runtimeWorkerState: 'cold',
      }),
    )
  })

  test('Given CCB 导入会话已手动改名 When 再次同步目录 Then 保留用户标题', () => {
    writeAgentSessionsIndex([
      {
        id: 'ccb-session',
        runtimeSessionId: 'ccb-session',
        title: '用户自定义标题',
        titleSource: 'user',
        workspaceId: 'workspace-a',
        createdAt: 10,
        updatedAt: 20,
      },
    ])

    manager.syncRuntimeSessionCatalog('workspace-a', [{
      runtimeSessionId: 'ccb-session',
      title: 'CCB Transcript 标题',
      summary: 'CCB Transcript 标题',
      cwd: '/tmp/project',
      createdAt: 10,
      updatedAt: 30,
    }])

    expect(manager.getAgentSessionMeta('ccb-session')).toMatchObject({
      title: '用户自定义标题',
      titleSource: 'user',
      updatedAt: 30,
    })
  })

  test('Given Proma 创建的会话已绑定 CCB Runtime When 后台同步 Catalog Then 保持本地侧栏时间顺序', () => {
    writeAgentSessionsIndex([
      {
        id: 'proma-session',
        runtimeSessionId: 'ccb-runtime-session',
        title: 'Proma 本地会话',
        titleSource: 'generated',
        workspaceId: 'workspace-a',
        createdAt: 10,
        updatedAt: 200,
      },
    ])

    manager.syncRuntimeSessionCatalog('workspace-a', [{
      runtimeSessionId: 'ccb-runtime-session',
      title: 'CCB Transcript 标题',
      summary: 'CCB Transcript 标题',
      cwd: '/tmp/project',
      createdAt: 10,
      updatedAt: 50,
    }])

    expect(manager.getAgentSessionMeta('proma-session')).toMatchObject({
      title: 'Proma 本地会话',
      titleSource: 'generated',
      updatedAt: 200,
    })
  })

  test('Given CCB Catalog 暂时为空 When 同步会话目录 Then 不得删除 Proma 本地会话', () => {
    writeAgentSessionsIndex([
      {
        id: 'proma-session',
        runtimeSessionId: 'ccb-session',
        title: '不能消失的会话',
        workspaceId: 'workspace-a',
        createdAt: 10,
        updatedAt: 20,
      },
    ])
    writeAgentSessionJsonl('proma-session', [
      JSON.stringify({
        type: 'user',
        uuid: 'local-user',
        message: { content: [{ type: 'text', text: '本地消息' }] },
        parent_tool_use_id: null,
      }),
    ])

    manager.syncRuntimeSessionCatalog('workspace-a', [])

    expect(manager.getAgentSessionMeta('proma-session')).toBeDefined()
    expect(manager.getAgentSessionSDKMessages('proma-session')).toHaveLength(1)
  })
})

describe('Agent Transcript 增量合并', () => {
  test('Given Runtime Transcript 包含 CCB 非法 thinking 正文块 When 合并 Then 转换为标准 text 块', () => {
    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-malformed-thinking-text',
      [{
        type: 'assistant',
        message: {
          content: [{
            type: 'thinking',
            thinking: '',
            signature: '',
            text: 'Runtime 正文',
          }],
        },
        parent_tool_use_id: null,
        uuid: 'assistant-malformed',
      } as never],
    )

    expect(merged[0]).toMatchObject({
      message: {
        content: [{ type: 'text', text: 'Runtime 正文' }],
      },
    })
  })

  test('Given Runtime Transcript 包含自动重试原始错误 When 最终成功 Then 不合并未知错误卡片', () => {
    writeAgentSessionJsonl('merge-runtime-retry-error', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '执行测试' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-runtime-retry-error',
      [
        {
          type: 'user',
          message: { role: 'user', content: '执行测试' },
          parent_tool_use_id: null,
          uuid: 'runtime-user',
        } as never,
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'API Error: 429 The engine is currently overloaded' }],
          },
          error: {
            status: 429,
            error: {
              message: 'The engine is currently overloaded',
              type: 'EngineOverloadedError',
            },
          },
        } as never,
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '任务执行成功' }],
          },
          parent_tool_use_id: null,
          uuid: 'assistant-success',
        } as never,
      ],
    )

    expect(merged.some(message =>
      Boolean((message as unknown as { error?: unknown }).error),
    )).toBe(false)
    expect(merged.map(message => message.type)).toEqual(['user', 'assistant'])
  })

  test('Given CCB Transcript 尚未落盘 When 返回空 Transcript Then 保留本地用户消息', () => {
    writeAgentSessionJsonl('lagging-transcript', [
      JSON.stringify({
        type: 'user',
        uuid: 'local-user',
        message: { content: [{ type: 'text', text: '刚发送的消息' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'lagging-transcript',
      [],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual(['local-user'])
    expect(manager.getAgentSessionSDKMessages('lagging-transcript'))
      .toHaveLength(1)
  })

  test('Given Runtime Transcript 比本地投影滞后 When 合并 Then 补齐 Runtime 消息且不覆盖本地尾部消息', () => {
    writeAgentSessionJsonl('merge-transcript', [
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: { content: [{ type: 'text', text: '本地旧内容' }] },
        parent_tool_use_id: null,
        _channelModelId: 'model-a',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'local-user-2',
        message: { content: [{ type: 'text', text: '尚未落盘的新消息' }] },
        parent_tool_use_id: null,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-transcript',
      [
        {
          type: 'assistant',
          uuid: 'assistant-1',
          message: { content: [{ type: 'text', text: 'Runtime 完整内容' }] },
          parent_tool_use_id: null,
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual(['assistant-1', 'local-user-2'])
    expect(
      (merged[0] as unknown as { _channelModelId?: string })._channelModelId,
    ).toBe('model-a')
    expect(
      (merged[0] as unknown as {
        message: { content: Array<{ text?: string }> }
      }).message.content[0]?.text,
    ).toBe('Runtime 完整内容')
  })

  test('Given Runtime 与 Proma 都保存了同一条用户消息 When 合并 Then 只保留 Proma 本地投影', () => {
    writeAgentSessionJsonl('dedupe-user-transcript', [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '同一条消息' },
        uuid: 'runtime-user',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '同一条消息' }] },
        uuid: 'proma-user',
        _createdAt: 100,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'dedupe-user-transcript',
      [
        {
          type: 'user',
          message: { role: 'user', content: '同一条消息' },
          uuid: 'runtime-user',
        } as never,
      ],
    )

    expect(merged).toHaveLength(1)
    expect(
      (merged[0] as unknown as { uuid?: string }).uuid,
    ).toBe('proma-user')
  })

  test('Given Runtime 用户消息包含工具引用上下文 When 同步完成 Then 用户原文仍位于对应回复之前', () => {
    writeAgentSessionJsonl('merge-mentioned-tools-prompt', [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<mentioned_tools>\n- Skill: open-computer-use\n</mentioned_tools>\n\n请检查审核结果',
        },
        uuid: 'runtime-user',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-final',
        message: {
          id: 'assistant-message',
          content: [{ type: 'text', text: '审核结果如下' }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'text', text: '请检查审核结果' }],
        },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'result',
        uuid: 'result-1',
        subtype: 'success',
        result: '审核结果如下',
        _createdAt: 200,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-mentioned-tools-prompt',
      [
        {
          type: 'user',
          message: {
            role: 'user',
            content: '<mentioned_tools>\n- Skill: open-computer-use\n</mentioned_tools>\n\n请检查审核结果',
          },
          uuid: 'runtime-user',
        } as never,
        {
          type: 'assistant',
          uuid: 'assistant-final',
          message: {
            id: 'assistant-message',
            content: [{ type: 'text', text: '审核结果如下' }],
          },
          _createdAt: 200,
        } as never,
      ],
    )

    expect(merged.map(message => message.type))
      .toEqual(['user', 'assistant', 'result'])
    expect(
      (merged[0] as unknown as {
        message: { content: Array<{ text?: string }> }
      }).message.content[0]?.text,
    ).toBe('请检查审核结果')
  })

  test('Given 两轮用户输入内容相同 When 合并增强 Prompt Then 按 Runtime 顺序各保留一次', () => {
    writeAgentSessionJsonl('merge-repeated-user-prompt', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '继续' }] },
        uuid: 'proma-user-1',
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'assistant-message-1',
          content: [{ type: 'text', text: '第一轮' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '继续' }] },
        uuid: 'proma-user-2',
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-2',
        message: {
          id: 'assistant-message-2',
          content: [{ type: 'text', text: '第二轮' }],
        },
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-repeated-user-prompt',
      [
        {
          type: 'user',
          uuid: 'runtime-user-1',
          message: {
            role: 'user',
            content: '<mentioned_tools>\n- Skill: example\n</mentioned_tools>\n\n继续',
          },
        } as never,
        {
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            id: 'assistant-message-1',
            content: [{ type: 'text', text: '第一轮' }],
          },
        } as never,
        {
          type: 'user',
          uuid: 'runtime-user-2',
          message: {
            role: 'user',
            content: '<mentioned_tools>\n- Skill: example\n</mentioned_tools>\n\n继续',
          },
        } as never,
        {
          type: 'assistant',
          uuid: 'assistant-2',
          message: {
            id: 'assistant-message-2',
            content: [{ type: 'text', text: '第二轮' }],
          },
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'proma-user-1',
      'assistant-1',
      'proma-user-2',
      'assistant-2',
    ])
  })

  test('Given 相同文本曾在运行中重复发送 When 后续再次正常发送 Then 不得把旧重复消息匹配到新 Turn', () => {
    writeAgentSessionJsonl('merge-repeated-prompt-with-rejected-send', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '计划审批测试' }] },
        uuid: 'proma-user-1',
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '计划审批测试' }] },
        uuid: 'rejected-duplicate-user',
        _createdAt: 110,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'assistant-message-1',
          content: [{ type: 'text', text: '第一次计划被拒绝后的回复' }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'result',
        uuid: 'result-1',
        subtype: 'success',
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '计划审批测试' }] },
        uuid: 'proma-user-2',
        _createdAt: 500,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-2',
        message: {
          id: 'assistant-message-2',
          content: [{ type: 'text', text: '第二次计划回复' }],
        },
        _createdAt: 600,
      }),
      JSON.stringify({
        type: 'result',
        uuid: 'result-2',
        subtype: 'success',
        _createdAt: 600,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-repeated-prompt-with-rejected-send',
      [
        {
          type: 'user',
          uuid: 'runtime-user-1',
          timestamp: new Date(120).toISOString(),
          message: { role: 'user', content: '计划审批测试' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-1',
          message: {
            id: 'assistant-message-1',
            content: [{ type: 'text', text: '第一次计划被拒绝后的回复' }],
          },
        } as never,
        {
          type: 'user',
          uuid: 'runtime-user-2',
          timestamp: new Date(520).toISOString(),
          message: { role: 'user', content: '计划审批测试' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-2',
          message: {
            id: 'assistant-message-2',
            content: [{ type: 'text', text: '第二次计划回复' }],
          },
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'proma-user-1',
      'rejected-duplicate-user',
      'assistant-1',
      'result-1',
      'proma-user-2',
      'assistant-2',
      'result-2',
    ])
  })

  test('Given 本地完成元数据已被旧同步打乱 When 再次合并 Then 按 Turn 时间恢复消息顺序', () => {
    writeAgentSessionJsonl('merge-out-of-order-results', [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '第一轮' }] },
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'assistant-message-1',
          content: [{ type: 'text', text: '第一轮回复' }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-2',
        message: { content: [{ type: 'text', text: '第二轮' }] },
        _createdAt: 300,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-2',
        message: {
          id: 'assistant-message-2',
          content: [{ type: 'text', text: '第二轮回复' }],
        },
        _createdAt: 400,
      }),
      JSON.stringify({
        type: 'result',
        uuid: 'result-2',
        subtype: 'success',
        _createdAt: 400,
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'context_compaction_config',
        uuid: 'context-config-1',
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'result',
        uuid: 'result-1',
        subtype: 'success',
        _createdAt: 200,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-out-of-order-results',
      [
        {
          type: 'user',
          uuid: 'runtime-user-1',
          message: { role: 'user', content: '第一轮' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-1',
          message: {
            id: 'assistant-message-1',
            content: [{ type: 'text', text: '第一轮回复' }],
          },
        } as never,
        {
          type: 'user',
          uuid: 'runtime-user-2',
          message: { role: 'user', content: '第二轮' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-2',
          message: {
            id: 'assistant-message-2',
            content: [{ type: 'text', text: '第二轮回复' }],
          },
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'user-1',
      'assistant-1',
      'context-config-1',
      'result-1',
      'user-2',
      'assistant-2',
      'result-2',
    ])
  })

  test('Given Runtime Assistant 与桌面拆分消息使用同一 message id When 合并 Then 只保留桌面拆分消息', () => {
    writeAgentSessionJsonl('dedupe-assistant-transcript', [
      JSON.stringify({
        type: 'assistant',
        uuid: 'runtime-assistant',
        message: {
          id: 'message-1',
          content: [
            { type: 'thinking', thinking: '思考' },
            { type: 'text', text: '回答' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'desktop-thinking',
        message: {
          id: 'message-1',
          content: [{ type: 'thinking', thinking: '思考' }],
        },
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'desktop-text',
        message: {
          id: 'message-1',
          content: [{ type: 'text', text: '回答' }],
        },
        _createdAt: 100,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'dedupe-assistant-transcript',
      [
        {
          type: 'assistant',
          uuid: 'runtime-assistant',
          message: {
            id: 'message-1',
            content: [
              { type: 'thinking', thinking: '思考' },
              { type: 'text', text: '回答' },
            ],
          },
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual(['desktop-thinking', 'desktop-text'])
  })


  test('Given 本地仅有带元数据的残缺 partial 而 Runtime 含完整 THINK+TEXT+TOOL When 合并 Then 采用 Runtime 完整内容并保留本地元数据', () => {
    // 复现 34c8ea67：停止后本地只剩 thinking/单段 text partial，Runtime Transcript 有完整正文与 tool_use。
    writeAgentSessionJsonl('merge-incomplete-desktop-partials', [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '分析下登录流程' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'local-msg-1',
        message: {
          id: 'msg_8b48352a44934a74b0ceb536',
          content: [{ type: 'thinking', thinking: '先找登录相关代码' }],
        },
        parent_tool_use_id: null,
        _partialBlockIndex: 0,
        _channelModelId: 'deepseek-v4-flash',
        _channelProvider: 'openai',
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-1',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_c70844e4c7c3478',
            content: 'found login files',
          }],
        },
        _createdAt: 210,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'local-msg-3',
        message: {
          id: 'msg_57bd0f64ba134c939a08efcf',
          content: [{
            type: 'text',
            text: '让我先读取核心的登录状态机和控制器文件，理解整体架构',
          }],
        },
        parent_tool_use_id: null,
        _partialBlockIndex: 0,
        _channelModelId: 'deepseek-v4-flash',
        _channelProvider: 'openai',
        _createdAt: 220,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-2',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_71cf07f08b15464',
            content: 'state machine',
          }],
        },
        _createdAt: 230,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'local-msg-4',
        message: {
          id: 'msg_d59b357d5b0d49a3a8885f6e',
          content: [{ type: 'thinking', thinking: '继续读启动与 API' }],
        },
        parent_tool_use_id: null,
        _partialBlockIndex: 0,
        _channelModelId: 'deepseek-v4-flash',
        _channelProvider: 'openai',
        _createdAt: 240,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-incomplete-desktop-partials',
      [
        {
          type: 'user',
          uuid: 'runtime-user',
          message: { role: 'user', content: '分析下登录流程' },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-msg-1',
          message: {
            id: 'msg_8b48352a44934a74b0ceb536',
            content: [
              { type: 'thinking', thinking: '先找登录相关代码' },
              {
                type: 'text',
                text: '我来分析一下这个 Flutter 项目的登录流程。先找到登录相关的代码。',
              },
              {
                type: 'tool_use',
                id: 'call_c70844e4c7c3478',
                name: 'Bash',
                input: { command: 'rg login' },
              },
            ],
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'runtime-tool-result-1',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call_c70844e4c7c3478',
              content: 'found login files',
            }],
          },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-msg-3',
          message: {
            id: 'msg_57bd0f64ba134c939a08efcf',
            content: [
              {
                type: 'text',
                text: '让我先读取核心的登录状态机和控制器文件，理解整体架构',
              },
              {
                type: 'tool_use',
                id: 'call_71cf07f08b15464',
                name: 'Read',
                input: { path: 'login_state.dart' },
              },
              {
                type: 'tool_use',
                id: 'call_140dbcaaf6544c5',
                name: 'Read',
                input: { path: 'login_controller.dart' },
              },
            ],
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'runtime-tool-result-2',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call_71cf07f08b15464',
              content: 'state machine',
            }],
          },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-msg-4',
          message: {
            id: 'msg_d59b357d5b0d49a3a8885f6e',
            content: [
              { type: 'thinking', thinking: '继续读启动与 API' },
              {
                type: 'text',
                text: '让我读取启动协调器、登录页面 UI 和 API 层，理解完整链路。',
              },
              {
                type: 'tool_use',
                id: 'call_9f0e4ebdddc0457',
                name: 'Read',
                input: { path: 'bootstrap.dart' },
              },
            ],
          },
          parent_tool_use_id: null,
        } as never,
      ],
    )

    const assistantTexts = merged
      .filter(message => message.type === 'assistant')
      .map((message) => {
        const content = (message as {
          message?: { content?: Array<{ type?: string; text?: string }> }
        }).message?.content
        if (!Array.isArray(content)) return []
        return content
          .filter(block => block?.type === 'text')
          .map(block => block.text ?? '')
      })
      .flat()

    expect(assistantTexts).toEqual([
      '我来分析一下这个 Flutter 项目的登录流程。先找到登录相关的代码。',
      '让我先读取核心的登录状态机和控制器文件，理解整体架构',
      '让我读取启动协调器、登录页面 UI 和 API 层，理解完整链路。',
    ])

    const firstAssistant = merged.find(message => message.type === 'assistant') as {
      uuid?: string
      _channelModelId?: string
      _createdAt?: number
      _partialBlockIndex?: number
      message?: { content?: Array<{ type?: string; id?: string }> }
    }
    expect(firstAssistant?._channelModelId).toBe('deepseek-v4-flash')
    expect(firstAssistant?._createdAt).toBe(200)
    expect(firstAssistant?._partialBlockIndex).toBeUndefined()
    expect(
      firstAssistant?.message?.content?.some(
        block => block.type === 'tool_use' && block.id === 'call_c70844e4c7c3478',
      ),
    ).toBe(true)

    // 不应继续保留残缺 local partial 作为独立条
    expect(
      merged.map(message => (message as { uuid?: string }).uuid),
    ).not.toContain('local-msg-1')
  })

  test('Given Runtime Transcript 在 compact 后重复历史 assistant When 合并 Then 不把旧回复追加到最新一轮之后', () => {
    writeAgentSessionJsonl('merge-compact-duplicate-assistant', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '旧问题' }] },
        uuid: 'user-old',
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-old-thinking',
        message: {
          id: 'message-old',
          content: [{ type: 'thinking', thinking: '旧思考' }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-old-text',
        message: {
          id: 'message-old',
          content: [{ type: 'text', text: '旧回复' }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '新问题' }] },
        uuid: 'user-new',
        _createdAt: 300,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-new',
        message: {
          id: 'message-new',
          content: [{ type: 'text', text: '新回复' }],
        },
        _createdAt: 400,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-compact-duplicate-assistant',
      [
        {
          type: 'user',
          uuid: 'runtime-user-old',
          message: { role: 'user', content: '旧问题' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-old',
          message: {
            id: 'message-old',
            content: [
              { type: 'thinking', thinking: '旧思考' },
              { type: 'text', text: '旧回复' },
            ],
          },
        } as never,
        {
          type: 'user',
          uuid: 'runtime-user-new',
          message: { role: 'user', content: '新问题' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-new',
          message: {
            id: 'message-new',
            content: [{ type: 'text', text: '新回复' }],
          },
        } as never,
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'compact-1',
        } as never,
        // compact 后 Transcript 再次给出历史完整消息
        {
          type: 'assistant',
          uuid: 'runtime-assistant-old-replay',
          message: {
            id: 'message-old',
            content: [
              { type: 'thinking', thinking: '旧思考' },
              { type: 'text', text: '旧回复' },
            ],
          },
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'user-old',
      'assistant-old-thinking',
      'assistant-old-text',
      'user-new',
      'assistant-new',
      'compact-1',
    ])
    expect(merged.at(-1)).toMatchObject({ subtype: 'compact_boundary' })
    expect(
      manager.getAgentSessionSDKMessages('merge-compact-duplicate-assistant')
        .map(message => (message as unknown as { uuid?: string }).uuid),
    ).toEqual([
      'user-old',
      'assistant-old-thinking',
      'assistant-old-text',
      'user-new',
      'assistant-new',
      'compact-1',
    ])
  })

  test('Given JSONL 尾部已存在历史 assistant 重复快照 When 读取 Then 丢弃非连续重复并保留最新一轮', () => {
    writeAgentSessionJsonl('read-collapse-duplicate-assistant', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '旧问题' }] },
        uuid: 'user-history',
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-history-thinking',
        message: {
          id: 'message-history',
          content: [{ type: 'thinking', thinking: '旧思考' }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-history-text',
        message: {
          id: 'message-history',
          content: [{ type: 'text', text: '旧的 NOTICE 讨论' }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '设备重新插拔了' }] },
        uuid: 'user-latest',
        _createdAt: 500,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-latest',
        message: {
          id: 'message-latest',
          content: [{ type: 'text', text: '仍未识别到设备' }],
        },
        _createdAt: 600,
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-tail',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-history-replay',
        message: {
          id: 'message-history',
          content: [
            { type: 'thinking', thinking: '旧思考' },
            { type: 'text', text: '旧的 NOTICE 讨论' },
          ],
        },
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages(
      'read-collapse-duplicate-assistant',
    )

    expect(
      messages.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'user-history',
      'assistant-history-thinking',
      'assistant-history-text',
      'user-latest',
      'assistant-latest',
      'compact-tail',
    ])
  })

  test('Given compact 用新 message.id 重放历史 tool_use When 读取 Then 丢弃尾部重放并保留最新一轮', () => {
    writeAgentSessionJsonl('read-collapse-tool-replay', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '请修 event_id' }] },
        uuid: 'user-old',
        _createdAt: 100,
      }),
      // 原始 tool_use 必须保留在历史中；仅 tool_result 不能当作“已见 tool_use”，
      // 否则残缺同步会把真正的 Agent/工具调用整段丢掉。
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-old',
        message: {
          id: 'message-old',
          content: [
            { type: 'text', text: '我先修 event_id 去重' },
            {
              type: 'tool_use',
              id: 'call-old-1',
              name: 'Edit',
              input: { path: 'a.ts' },
            },
          ],
        },
        _createdAt: 150,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-old',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call-old-1',
            content: 'patched',
          }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '现在问题在哪' }] },
        uuid: 'user-new',
        _createdAt: 300,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-new',
        message: {
          id: 'message-new',
          content: [{ type: 'text', text: '问题在离线投递路径' }],
        },
        _createdAt: 400,
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-1',
      }),
      // compact 后用新 message.id 重放历史工具调用
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-old-replay',
        message: {
          id: 'message-old-replay',
          content: [
            { type: 'text', text: '我先修 event_id 去重' },
            {
              type: 'tool_use',
              id: 'call-old-1',
              name: 'Edit',
              input: { path: 'a.ts' },
            },
          ],
        },
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages('read-collapse-tool-replay')
    expect(
      messages.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'user-old',
      'assistant-old',
      'tool-result-old',
      'user-new',
      'assistant-new',
      'compact-1',
    ])
  })

  test('Given compact 用新 message.id 重放历史 tool_use When 合并 Then 不把旧工具调用追加到最新一轮之后', () => {
    writeAgentSessionJsonl('merge-compact-tool-replay', [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '请修 event_id' }] },
        uuid: 'user-old',
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-old',
        message: {
          id: 'message-old',
          content: [
            { type: 'text', text: '我先修 event_id 去重' },
            {
              type: 'tool_use',
              id: 'call-old-1',
              name: 'Edit',
              input: { path: 'a.ts' },
            },
          ],
        },
        _createdAt: 150,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'tool-result-old',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call-old-1',
            content: 'patched',
          }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '现在问题在哪' }] },
        uuid: 'user-new',
        _createdAt: 300,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-new',
        message: {
          id: 'message-new',
          content: [{ type: 'text', text: '问题在离线投递路径' }],
        },
        _createdAt: 400,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-compact-tool-replay',
      [
        {
          type: 'user',
          uuid: 'runtime-user-old',
          message: { role: 'user', content: '请修 event_id' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-old',
          message: {
            id: 'message-old',
            content: [
              { type: 'text', text: '我先修 event_id 去重' },
              {
                type: 'tool_use',
                id: 'call-old-1',
                name: 'Edit',
                input: { path: 'a.ts' },
              },
            ],
          },
        } as never,
        {
          type: 'user',
          uuid: 'runtime-tool-result-old',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call-old-1',
              content: 'patched',
            }],
          },
        } as never,
        {
          type: 'user',
          uuid: 'runtime-user-new',
          message: { role: 'user', content: '现在问题在哪' },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-new',
          message: {
            id: 'message-new',
            content: [{ type: 'text', text: '问题在离线投递路径' }],
          },
        } as never,
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'compact-1',
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant-old-replay',
          message: {
            id: 'message-old-replay',
            content: [
              { type: 'text', text: '我先修 event_id 去重' },
              {
                type: 'tool_use',
                id: 'call-old-1',
                name: 'Edit',
                input: { path: 'a.ts' },
              },
            ],
          },
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'user-old',
      'assistant-old',
      'tool-result-old',
      'user-new',
      'assistant-new',
      'compact-1',
    ])
  })

  test('Given 本地完整 assistant 聚成一团而 Runtime 交错 tool_result When 合并 Then 采用 Runtime 顺序并保留全部过程正文', () => {
    // 复现 ce56ba0e：停止后本地把完整 assistant 先落盘，tool_result 堆在后面；
    // Runtime Transcript 是正确的 assistant ↔ tool_result 交错顺序。
    writeAgentSessionJsonl('merge-clustered-assistants-runtime-interleaved', [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '分析下登录流程呢，不用子agent的方式' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'local-asst-1',
        message: {
          id: 'msg_cf9891b53f7f43d98d1aed1e',
          content: [
            { type: 'thinking', thinking: '先定位登录代码' },
            { type: 'text', text: '我来直接分析登录流程，先定位登录相关代码。' },
            {
              type: 'tool_use',
              id: 'call_19520ce',
              name: 'Bash',
              input: { command: 'rg login' },
            },
          ],
        },
        parent_tool_use_id: null,
        _channelModelId: 'deepseek-v4-flash',
        _channelProvider: 'openai',
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'local-asst-2',
        message: {
          id: 'msg_6afe95983e8e4f3e84c71598',
          content: [
            { type: 'text', text: '登录在 features/auth。我先看整体结构。' },
            {
              type: 'tool_use',
              id: 'call_35e2a7a',
              name: 'Bash',
              input: { command: 'ls features/auth' },
            },
          ],
        },
        parent_tool_use_id: null,
        _channelModelId: 'deepseek-v4-flash',
        _channelProvider: 'openai',
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'local-asst-3',
        message: {
          id: 'msg_ae63378b96a443df9e881b6f',
          content: [
            { type: 'thinking', thinking: '看登录页' },
            { type: 'text', text: '启动协调器已经清楚了。现在看登录页和核心登录控制器。' },
            {
              type: 'tool_use',
              id: 'call_57c5381',
              name: 'Read',
              input: { path: 'login_page.dart' },
            },
          ],
        },
        parent_tool_use_id: null,
        _channelModelId: 'deepseek-v4-flash',
        _channelProvider: 'openai',
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'local-tool-1',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_19520ce',
            content: 'login files',
          }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'local-tool-2',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_35e2a7a',
            content: 'auth structure',
          }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'local-tool-3',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_57c5381',
            content: 'login page',
          }],
        },
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'result',
        uuid: 'local-result',
        subtype: 'interrupted',
        _createdAt: 200,
        _stoppedByUser: true,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-clustered-assistants-runtime-interleaved',
      [
        {
          type: 'user',
          uuid: 'runtime-user',
          message: {
            role: 'user',
            content: '分析下登录流程呢，不用子agent的方式',
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-asst-1',
          message: {
            id: 'msg_cf9891b53f7f43d98d1aed1e',
            content: [
              { type: 'thinking', thinking: '先定位登录代码' },
              { type: 'text', text: '我来直接分析登录流程，先定位登录相关代码。' },
              {
                type: 'tool_use',
                id: 'call_19520ce',
                name: 'Bash',
                input: { command: 'rg login' },
              },
            ],
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'runtime-tool-1',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call_19520ce',
              content: 'login files',
            }],
          },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-asst-2',
          message: {
            id: 'msg_6afe95983e8e4f3e84c71598',
            content: [
              { type: 'text', text: '登录在 features/auth。我先看整体结构。' },
              {
                type: 'tool_use',
                id: 'call_35e2a7a',
                name: 'Bash',
                input: { command: 'ls features/auth' },
              },
            ],
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'runtime-tool-2',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call_35e2a7a',
              content: 'auth structure',
            }],
          },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-asst-3',
          message: {
            id: 'msg_ae63378b96a443df9e881b6f',
            content: [
              { type: 'thinking', thinking: '看登录页' },
              { type: 'text', text: '启动协调器已经清楚了。现在看登录页和核心登录控制器。' },
              {
                type: 'tool_use',
                id: 'call_57c5381',
                name: 'Read',
                input: { path: 'login_page.dart' },
              },
            ],
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'runtime-tool-3',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: 'call_57c5381',
              content: 'login page',
            }],
          },
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-abort',
          message: {
            id: 'a94bfc81-93ed-4b18-b76a-3d2c45b7f486',
            content: [{ type: 'text', text: 'API Error: Request was aborted.' }],
          },
          parent_tool_use_id: null,
        } as never,
      ],
    )

    expect(
      merged.map(message =>
        (message as unknown as { uuid?: string }).uuid,
      ),
    ).toEqual([
      'user-1',
      'local-asst-1',
      'local-tool-1',
      'local-asst-2',
      'local-tool-2',
      'local-asst-3',
      'local-tool-3',
      'local-result',
    ])

    const processTexts = merged.flatMap((message) => {
      if (message.type !== 'assistant') return []
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (!Array.isArray(content)) return []
      return content
        .filter((block): block is { type: 'text'; text: string } =>
          Boolean(
            block
            && typeof block === 'object'
            && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string',
          ),
        )
        .map(block => block.text)
    })
    expect(processTexts).toEqual([
      '我来直接分析登录流程，先定位登录相关代码。',
      '登录在 features/auth。我先看整体结构。',
      '启动协调器已经清楚了。现在看登录页和核心登录控制器。',
    ])
  })

  test('Given Runtime Transcript 含 CCB 中断合成 user When 合并 Then 不写入投影且不保留本地副本', () => {
    writeAgentSessionJsonl('merge-interrupt-user', [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '分析登录流程' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: '我先看项目结构' }],
        },
        parent_tool_use_id: null,
        _createdAt: 200,
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'interrupted',
        _createdAt: 200,
        _durationMs: 12_000,
        _stoppedByUser: true,
      }),
      // 历史错误投影：本地已混入 CCB 中断合成 user
      JSON.stringify({
        type: 'user',
        uuid: 'local-interrupt',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
        parent_tool_use_id: null,
        timestamp: '2026-08-06T09:05:48.348Z',
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-interrupt-user',
      [
        {
          type: 'user',
          uuid: 'runtime-user',
          message: { role: 'user', content: '分析登录流程' },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'assistant',
          uuid: 'runtime-assistant',
          message: {
            id: 'msg-1',
            content: [{ type: 'text', text: '我先看项目结构' }],
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'runtime-interrupt',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }],
          },
          parent_tool_use_id: null,
          session_id: 'ccb-session',
          timestamp: '2026-08-06T09:05:48.348Z',
        } as never,
        {
          type: 'user',
          uuid: 'runtime-interrupt-tool',
          message: {
            role: 'user',
            content: [{
              type: 'text',
              text: '[Request interrupted by user for tool use]',
            }],
          },
          parent_tool_use_id: null,
        } as never,
      ],
    )

    const userTexts = merged
      .filter((message) => message.type === 'user')
      .map((message) => {
        const content = (message as {
          message?: { content?: Array<{ type?: string; text?: string }> | string }
        }).message?.content
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return ''
        return content
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
      })

    expect(userTexts).toEqual(['分析登录流程'])
    expect(
      merged.some((message) =>
        JSON.stringify(message).includes('[Request interrupted by user]'),
      ),
    ).toBe(false)
    // 本地 result 元数据应保留
    expect(merged.some((message) => message.type === 'result')).toBe(true)
  })

  test('Given Runtime 429 重试重复同一 user prompt When 合并 Then 只保留一个用户气泡', () => {
    writeAgentSessionJsonl('merge-429-user-retries', [
      JSON.stringify({
        type: 'user',
        uuid: 'local-user-1',
        message: { content: [{ type: 'text', text: '分析下登录流程呢,用子智能体的方式呢' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
    ])

    const prompt = '分析下登录流程呢,用子智能体的方式呢'
    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-429-user-retries',
      [
        {
          type: 'user',
          uuid: 'rt-user-1',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'assistant',
          uuid: 'rt-err-1',
          message: {
            id: 'msg-err-1',
            content: [{ type: 'text', text: 'API Error: 429 You exceeded your current quota' }],
          },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'rt-user-2',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'rt-user-3',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'rt-user-4',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'user',
          uuid: 'rt-user-5',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
        } as never,
        {
          type: 'assistant',
          uuid: 'rt-assistant',
          message: {
            id: 'msg-ok',
            content: [
              { type: 'text', text: '我先启动子智能体' },
              { type: 'tool_use', id: 'call_agent_1', name: 'Agent', input: {} },
            ],
          },
          parent_tool_use_id: null,
        } as never,
      ],
    )

    const userTexts = merged
      .filter((message) => message.type === 'user')
      .map((message) => {
        const content = (message as {
          message?: { content?: Array<{ type?: string; text?: string }> | string }
        }).message?.content
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return ''
        return content
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
      })
      .filter(Boolean)

    expect(userTexts).toEqual([prompt])
    expect(
      merged.some((message) => {
        const content = (message as { message?: { content?: unknown } }).message?.content
        return Array.isArray(content)
          && content.some((block) =>
            Boolean(block && typeof block === 'object' && (block as { name?: string }).name === 'Agent'),
          )
      }),
    ).toBe(true)
  })

  test('Given 本地已污染多条无元数据同文案 user When 再与 Runtime 合并 Then 仍只保留一条真实发送', () => {
    const prompt = '分析下登录流程呢,用子智能体的方式呢'
    writeAgentSessionJsonl('merge-polluted-duplicate-users', [
      JSON.stringify({
        type: 'user',
        uuid: 'local-user-1',
        message: { content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'polluted-1',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'polluted-2',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'polluted-3',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-polluted-duplicate-users',
      [
        { type: 'user', uuid: 'rt-1', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as never,
        { type: 'user', uuid: 'rt-2', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as never,
        { type: 'user', uuid: 'rt-3', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as never,
        { type: 'user', uuid: 'rt-4', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as never,
        { type: 'user', uuid: 'rt-5', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as never,
      ],
    )

    const userCount = merged.filter((message) => {
      if (message.type !== 'user') return false
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') return content === prompt
      if (!Array.isArray(content)) return false
      return content.some((block) =>
        Boolean(block && typeof block === 'object' && (block as { text?: string }).text === prompt),
      )
    }).length

    expect(userCount).toBe(1)
    expect(merged[0]).toMatchObject({ uuid: 'local-user-1', _createdAt: 100 })
  })

  test('Given 用户故意连发两次相同文本 When 合并 Then 仍保留两个用户气泡', () => {
    const prompt = '继续'
    writeAgentSessionJsonl('merge-intentional-same-text', [
      JSON.stringify({
        type: 'user',
        uuid: 'local-1',
        message: { content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'asst-1',
        message: { id: 'msg-1', content: [{ type: 'text', text: '好的' }] },
        parent_tool_use_id: null,
        _createdAt: 150,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'local-2',
        message: { content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
        _createdAt: 200,
      }),
    ])

    const merged = manager.mergeAgentSessionSDKMessages(
      'merge-intentional-same-text',
      [
        { type: 'user', uuid: 'rt-1', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as never,
        {
          type: 'assistant',
          uuid: 'rt-a1',
          message: { id: 'msg-1', content: [{ type: 'text', text: '好的' }] },
          parent_tool_use_id: null,
        } as never,
        { type: 'user', uuid: 'rt-2', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as never,
        {
          type: 'assistant',
          uuid: 'rt-a2',
          message: { id: 'msg-2', content: [{ type: 'text', text: '继续处理' }] },
          parent_tool_use_id: null,
        } as never,
      ],
    )

    const userTexts = merged
      .filter((message) => message.type === 'user')
      .map((message) => {
        const content = (message as {
          message?: { content?: Array<{ type?: string; text?: string }> | string }
        }).message?.content
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return ''
        return content
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
      })

    expect(userTexts).toEqual([prompt, prompt])
  })

  test('Given tool_result 先于对应 tool_use 出现 When 折叠 Then 保留真正的 tool_use', () => {
    writeAgentSessionJsonl('collapse-result-before-use', [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '用子智能体分析' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      // 停止/同步残缺：先有 tool_result，后有完整 Agent tool_use
      JSON.stringify({
        type: 'user',
        uuid: 'result-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_agent_1', content: 'done' }],
        },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'agent-use',
        message: {
          id: 'msg-agent',
          content: [
            { type: 'text', text: '我来启动子智能体' },
            { type: 'tool_use', id: 'call_agent_1', name: 'Agent', input: { prompt: 'explore login' } },
          ],
        },
        parent_tool_use_id: null,
        _createdAt: 120,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'summary',
        message: {
          id: 'msg-summary',
          content: [{ type: 'text', text: '分析完成' }],
        },
        parent_tool_use_id: null,
        _createdAt: 200,
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages('collapse-result-before-use')
    const agentTool = messages.find((message) => {
      if (message.type !== 'assistant') return false
      const content = (message as { message?: { content?: Array<{ type?: string; name?: string; id?: string }> } }).message?.content
      return Array.isArray(content)
        && content.some((block) => block?.type === 'tool_use' && block.name === 'Agent' && block.id === 'call_agent_1')
    })
    expect(agentTool).toBeTruthy()
    expect(JSON.stringify(messages)).toContain('我来启动子智能体')
  })

  test('Given 本地含压缩续写合成 user When 读取 Then 不展示为用户气泡', () => {
    writeAgentSessionJsonl('read-compaction-continuation-user', [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: 'hi' }] },
        parent_tool_use_id: null,
        _createdAt: 100,
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-1',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'continuation',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers...',
        },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'reply',
        message: { id: 'msg-1', content: [{ type: 'text', text: '你好' }] },
        parent_tool_use_id: null,
        _createdAt: 200,
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages('read-compaction-continuation-user')
    const userTexts = messages
      .filter((message) => message.type === 'user')
      .map((message) => {
        const content = (message as {
          message?: { content?: Array<{ type?: string; text?: string }> | string }
        }).message?.content
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return ''
        return content
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
      })

    expect(userTexts).toEqual(['hi'])
    expect(JSON.stringify(messages)).not.toContain('This session is being continued')
  })

  test('Given 历史 JSONL 已含中断合成 user When 读取会话 Then 读取路径直接过滤', () => {
    writeAgentSessionJsonl('read-interrupt-user', [
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        message: { content: [{ type: 'text', text: '继续' }] },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'interrupt-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
        parent_tool_use_id: null,
      }),
    ])

    const messages = manager.getAgentSessionSDKMessages('read-interrupt-user')
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain('[Request interrupted by user]')
  })
})

describe('Agent 会话引用搜索', () => {
  test('Given 工作区有超过 20 个会话 When 请求最近 200 条 Then 按更新时间返回 200 条', () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 200,
    })

    expect(results).toHaveLength(200)
    expect(results[0]?.sessionId).toBe('session-219')
    expect(results.at(-1)?.sessionId).toBe('session-20')
    expect(results.every((result) => result.matchSource === 'recent')).toBe(true)
  })

  test('Given 请求数量超过性能上限 When 搜索可引用会话 Then 最多返回 200 条', () => {
    writeAgentSessionsIndex(createIndexedSessions(220))

    const results = manager.searchAgentSessionReferences({
      workspaceId: 'workspace-a',
      limit: 500,
    })

    expect(results).toHaveLength(200)
  })
})

describe('Agent 会话 ID 引用', () => {
  test('Given 用户复制了其他项目的已归档会话 ID When 新会话明确引用 Then 仍注入本地历史读取信息', () => {
    writeAgentSessionsIndex([
      {
        id: 'current-session',
        title: '当前会话',
        workspaceId: 'workspace-a',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'archived-cross-workspace-session',
        title: '其他项目的历史会话',
        workspaceId: 'workspace-b',
        createdAt: 2,
        updatedAt: 2,
        archived: true,
      },
    ])

    const prompt = contextPrompt.buildReferencedSessionsPrompt(
      'current-session',
      ['archived-cross-workspace-session'],
      'workspace-a',
    )

    expect(prompt).toContain('id="archived-cross-workspace-session"')
    expect(prompt).toContain('其他项目的历史会话')
    expect(prompt).toContain('CLI target: archived-cross-workspace-session')
  })
})
