import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskboardStore } from '../taskboard/taskboard-store'

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

const memoryFiles = new Map<string, string>([
  ['MEMORY.md', '用户喜欢简洁中文。\n'],
])

mock.module('../agent-workspace-manager', () => ({
  listWorkspaceAutoMemoryFiles: () => [{
    relativePath: 'MEMORY.md',
    name: 'MEMORY.md',
    type: 'file',
  }],
  readWorkspaceAutoMemoryFile: (_slug: string, relativePath: string) => ({
    relativePath,
    isText: true,
    size: memoryFiles.get(relativePath)?.length ?? 0,
    content: memoryFiles.get(relativePath) || '',
  }),
  writeWorkspaceAutoMemoryFile: (_slug: string, relativePath: string, content: string) => {
    memoryFiles.set(relativePath, content)
  },
  readWorkspaceClaudeMd: () => ({
    relativePath: 'CLAUDE.md',
    isText: true,
    size: 20,
    content: '- 使用中文回复\n',
  }),
  getWorkspaceSkills: () => [{
    slug: 'demo',
    name: 'demo',
    description: '演示技能',
    enabled: true,
  }],
  readWorkspaceSkillContent: () => '按步骤操作浏览器',
}))

const { handlePromaCanonicalTool } = await import('./proma-canonical-tools')

describe('Proma canonical 工具', () => {
  test('Given 工作区 memory 文件 When 搜索 Then 返回命中片段', async () => {
    const result = await handlePromaCanonicalTool('proma_memory_search', { query: '简洁中文' }, { workspaceSlug: 'ws' })
    expect(result).toMatchObject({ count: 1 })
    expect(JSON.stringify(result)).toContain('MEMORY.md')
    expect(JSON.stringify(result)).toContain('简洁中文')
  })

  test('Given 写入记忆 When propose Then 追加到 MEMORY.md', async () => {
    const result = await handlePromaCanonicalTool('proma_memory_propose', { fact: '偏好表格输出' }, { workspaceSlug: 'ws' })
    expect(result).toMatchObject({ written: true, path: 'MEMORY.md' })
    const again = await handlePromaCanonicalTool('proma_memory_search', { query: '表格输出' }, { workspaceSlug: 'ws' })
    expect(JSON.stringify(again)).toContain('表格输出')
  })

  test('Given 知识检索 When 搜索 CLAUDE.md Then 命中工作区规则', async () => {
    const result = await handlePromaCanonicalTool('proma_knowledge_search', { query: '中文回复' }, { workspaceSlug: 'ws' })
    expect(JSON.stringify(result)).toContain('CLAUDE.md')
  })

  test('Given 未实现的知识写入 When 调用 Then 返回暂不支持而不是未知工具', async () => {
    const result = await handlePromaCanonicalTool('proma_knowledge_lint', {}, { workspaceSlug: 'ws' })
    expect(result).toMatchObject({ supported: false, tool: 'proma_knowledge_lint' })
  })

  test('Given 看板任务 When get/complete Then 走 taskboardStore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-canonical-board-'))
    const store = new TaskboardStore(dir)
    const task = store.createTask({ id: 't1', projectId: 'local', title: '修思考流' })
    const listed = await handlePromaCanonicalTool('proma_task_get', {}, { taskStore: store })
    expect(JSON.stringify(listed)).toContain('修思考流')
    const completed = await handlePromaCanonicalTool('proma_task_complete', {
      taskId: task.id,
      summary: '已修好 reasoning',
    }, { taskStore: store })
    expect(completed).toMatchObject({ id: task.id, status: 'done' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('Given 未知 canonical 工具 When 调用 Then 抛出明确错误', async () => {
    await expect(handlePromaCanonicalTool('proma_foo', {})).rejects.toThrow('未知的 Proma canonical 工具')
  })
})
