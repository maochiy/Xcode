import { afterAll, describe, expect, test, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const originalHome = process.env.HOME
const temporaryHome = mkdtempSync(join(os.tmpdir(), 'proma-context-packet-'))
process.env.HOME = temporaryHome

mock.module('node:os', () => ({
  ...os,
  homedir: () => temporaryHome,
}))

// context-packet-compiler 的传递依赖链（config-paths 等）在顶层 import
// electron 的 BrowserWindow，bun test 环境无法加载真实 electron 模块，
// 这里 mock 掉，让编译器纯函数可以在单测中运行。
mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'proma' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf-8'),
  },
  BrowserWindow: class {},
  clipboard: {},
  ipcMain: { handle: () => {}, on: () => {} },
  webContents: { fromId: () => null },
  shell: { openPath: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))

import type { ContextPacket, DispatchRun, RuntimeTaskGraph } from '@proma/shared'
import { contextPacketText } from './context-packet-text'

// context-packet-compiler 的传递依赖链包含顶层 import electron 的模块
// （channel-manager 的 safeStorage 等），bun test 环境无法加载真实 electron。
// 静态 import 会被提升到 mock 之前执行，因此这里用动态 import。
const { compileContextPacket, contextPacketFromRun } = await import('./context-packet-compiler')
const { getWorkspaceSkillsDir } = await import('../config-paths')

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  rmSync(temporaryHome, { recursive: true, force: true })
})

function packetFixture(): ContextPacket {
  const taskGraph: RuntimeTaskGraph = {
    id: 'graph-1',
    rootTaskId: 'task-1',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    tasks: [{
      id: 'task-1',
      title: '执行实现',
      kind: 'implementation',
      runtimeId: 'claude',
      harnessId: 'claude',
      status: 'running',
      dependsOn: [],
      inputArtifactIds: [],
      outputArtifactIds: [],
      requiresUserApproval: true,
      approvalState: 'approved',
      retryCount: 0,
      maxRetries: 1,
      timeoutMs: null,
      prompt: '实现设置页',
      result: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      startedAt: 1,
      completedAt: null,
    }],
  }

  return {
    schemaVersion: 1,
    packetId: 'packet-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    compiledAt: 1,
    profile: { userName: '测试用户', avatar: '' },
    conversation: {
      recentMessages: [{ role: 'user', content: '实现登录页' }],
      messageCount: 1,
    },
    workspace: {
      name: 'Proma',
      slug: 'proma',
      path: '/tmp/proma',
      rules: ['使用中文'],
      attachedDirectories: ['/tmp/shared'],
      attachedFiles: ['/tmp/requirements.md'],
    },
    memory: {
      claudeMd: '不要修改 README',
      autoMemoryFiles: ['/tmp/memory.md'],
    },
    skills: [{ name: 'code-review', description: '代码审查', path: '/tmp/skill' }],
    mcp: {
      enabledServers: ['web_search'],
      builtinServers: ['memory'],
    },
    attachments: ['/tmp/requirements.md'],
    browserAnnotations: [{
      target: 'element',
      comment: '按钮需要改成主色',
      url: 'https://example.com',
      pageTitle: '设置页',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      text: '保存',
      createdAt: 1,
    }],
    taskGraph,
    artifacts: [{
      id: 'artifact-1',
      taskId: 'task-0',
      kind: 'plan',
      content: '先修改组件，再补测试',
      createdAt: 1,
    }],
    runtime: {
      runtimeId: 'claude',
      capabilities: { tools: 'supported', approvals: 'supported' },
    },
    model: {
      modelId: 'model-1',
      provider: 'anthropic',
      routeRevision: 'route-1',
    },
    dispatchPolicy: {
      strategyId: 'proma.hermes.dynamic.v1',
      instruction: '只执行已批准任务',
    },
  }
}

describe('Proma Context Packet', () => {
  test('Given Profile、Memory、Skills、MCP 和浏览器标注 When 编译文本 Then 所有上下文进入统一 Packet', () => {
    const text = contextPacketText(packetFixture())

    expect(text).toContain('测试用户')
    expect(text).toContain('不要修改 README')
    expect(text).toContain('code-review')
    expect(text).toContain('web_search')
    expect(text).toContain('按钮需要改成主色')
    expect(text).toContain('/tmp/requirements.md')
    expect(text).toContain('memory')
  })

  test('Given Hermes 任务图和前序产物 When 投影到 Harness Then 保留任务状态和产物内容', () => {
    const text = contextPacketText(packetFixture())

    expect(text).toContain('Hermes 任务图')
    expect(text).toContain('task-1 执行实现 [running]')
    expect(text).toContain('先修改组件，再补测试')
    expect(text).toContain('模型路由：anthropic/model-1')
    expect(text).toContain('proma.hermes.dynamic.v1')
  })

  test('Given Runtime 原生 Session 已保存历史且系统提示词已注入 Skill When 构建本轮消息 Then 可省略重复内容', () => {
    const packet = packetFixture()
    packet.skills = [{
      name: 'computer-use',
      description: '操作内置浏览器',
      content: '这里是很长的 Skill 操作说明',
    }]

    const text = contextPacketText(packet, {
      includeRecentMessages: false,
      includeSkillContent: false,
    })

    expect(text).toContain('computer-use：操作内置浏览器')
    expect(text).not.toContain('这里是很长的 Skill 操作说明')
    expect(text).not.toContain('实现登录页')
  })

  test('Given 工作区存在多个 Skills When 默认编译 Context Packet Then 只包含目录元数据而不注入正文', () => {
    const workspaceSlug = 'metadata-only'
    const skillsDir = getWorkspaceSkillsDir(workspaceSlug)
    const alphaDir = join(skillsDir, 'alpha')
    const betaDir = join(skillsDir, 'beta')
    mkdirSync(alphaDir, { recursive: true })
    mkdirSync(betaDir, { recursive: true })
    writeFileSync(
      join(alphaDir, 'SKILL.md'),
      '---\nname: Alpha\ndescription: Alpha 描述\n---\nALPHA-BODY-SENTINEL',
      'utf-8',
    )
    writeFileSync(
      join(betaDir, 'SKILL.md'),
      '---\nname: Beta\ndescription: Beta 描述\n---\nBETA-BODY-SENTINEL',
      'utf-8',
    )

    const packet = compileContextPacket({
      sessionId: 'session-metadata-only',
      workspace: {
        id: 'workspace-metadata-only',
        name: 'Metadata Only',
        slug: workspaceSlug,
        path: join(temporaryHome, 'project'),
        canonicalPath: join(temporaryHome, 'project'),
        createdAt: 1,
        updatedAt: 1,
      },
      modelRoute: {
        modelId: 'model-1',
        provider: 'openai',
        routeRevision: 'route-1',
        runtimeId: 'pi',
        channelId: 'channel-1',
        baseUrl: '',
        apiMode: 'openai_responses',
        credentialRevision: 'r1',
        capabilities: {},
        source: 'legacy-compat',
      },
      runtimeId: 'pi',
      strategyId: 'proma.pi.clarification.v1',
      strategyInstruction: '普通对话',
      recentMessageLimit: 0,
    })

    expect([...packet.skills].sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      {
        name: 'Alpha',
        description: 'Alpha 描述',
        path: join(alphaDir, 'SKILL.md'),
      },
      {
        name: 'Beta',
        description: 'Beta 描述',
        path: join(betaDir, 'SKILL.md'),
      },
    ])
    expect(packet.skills.every((skill) => skill.content === undefined)).toBe(true)
    expect(JSON.stringify(packet)).not.toContain('ALPHA-BODY-SENTINEL')
    expect(JSON.stringify(packet)).not.toContain('BETA-BODY-SENTINEL')
  })

  test('Given Hermes 子任务 When 投影 Context Packet Then 只带依赖链产物且不复制整段会话历史', () => {
    const run = {
      id: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      status: 'running',
      plan: {
        intent: 'implementation',
        prompt: '实现登录页',
        graph: {
          id: 'graph-1',
          rootTaskId: 'task-1',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          tasks: [{
            id: 'task-1',
            title: '执行实现',
            kind: 'implementation',
            runtimeId: 'claude',
            harnessId: 'claude',
            status: 'running',
            dependsOn: [],
            inputArtifactIds: ['artifact-1'],
            outputArtifactIds: ['artifact-2'],
            requiresUserApproval: false,
            approvalState: 'approved',
            retryCount: 0,
            maxRetries: 1,
            timeoutMs: null,
            prompt: '实现设置页',
            result: null,
            error: null,
            createdAt: 1,
            updatedAt: 1,
            startedAt: 1,
            completedAt: null,
          }],
        },
      },
      artifacts: [
        { id: 'artifact-1', taskId: 'task-0', kind: 'plan', content: '前置计划', createdAt: 1 },
        { id: 'artifact-2', taskId: 'task-1', kind: 'diff', content: '实现补丁', createdAt: 2 },
      ],
      approvedTaskIds: ['task-1'],
      currentTaskId: 'task-1',
      error: null,
      createdAt: 1,
      updatedAt: 2,
      completedAt: null,
    } as unknown as DispatchRun

    const packet = contextPacketFromRun({
      sessionId: 'session-1',
      modelRoute: {
        modelId: 'model-1',
        provider: 'anthropic',
        routeRevision: 'route-1',
        runtimeId: 'claude',
        channelId: 'channel-1',
        baseUrl: '',
        apiMode: 'anthropic_messages',
        credentialRevision: 'r1',
        capabilities: {},
        source: 'legacy-compat',
      },
      runtimeId: 'claude',
      strategyId: 'proma.hermes.dynamic.v1',
      strategyInstruction: '只执行已批准任务',
      // 子任务不再把整段 Proma 会话历史复制进来
      recentMessageLimit: 0,
      // 只带依赖链产物
      artifacts: [run.artifacts[0]!],
    }, run)

    expect(packet.conversation.recentMessages).toEqual([])
    expect(packet.artifacts).toHaveLength(1)
    expect(packet.artifacts[0]?.id).toBe('artifact-1')
    expect(packet.artifacts[0]?.content).toBe('前置计划')
    // 任务图本身仍完整投影，模型能看到当前执行节点
    expect(packet.taskGraph?.tasks[0]?.id).toBe('task-1')
  })

  test('Given 同一会话连续编译 When 生成 packetId Then 使用稳定的 session 前缀', () => {
    const input = {
      sessionId: 'session-stable',
      modelRoute: {
        modelId: 'model-1',
        provider: 'anthropic',
        routeRevision: 'route-1',
        runtimeId: 'pi' as const,
        channelId: 'channel-1',
        baseUrl: '',
        apiMode: 'openai_responses' as const,
        credentialRevision: 'r1',
        capabilities: {},
        source: 'legacy-compat' as const,
      },
      runtimeId: 'pi' as const,
      strategyId: 'proma.pi.clarification.v1',
      strategyInstruction: '普通对话',
      recentMessageLimit: 0,
    }
    const first = compileContextPacket(input)
    const second = compileContextPacket(input)
    expect(first.packetId).toBe('context-session-stable')
    expect(second.packetId).toBe(first.packetId)
  })
})
