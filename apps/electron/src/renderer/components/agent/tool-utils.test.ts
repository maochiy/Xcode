import { describe, expect, test } from 'bun:test'
import { normalizeToolPresentation } from './tool-utils'

describe('Pi 工具展示归一化', () => {
  test('Given Pi 文件工具的小写原生名和参数 When 生成展示信息 Then 复用现有文件工具名称与参数', () => {
    const readInput = { path: '/project/read.ts', offset: 2 }
    const editInput = {
      path: '/project/edit.ts',
      oldText: '旧内容',
      newText: '新内容',
    }
    const writeInput = { path: '/project/write.ts', content: '文件内容' }

    expect(normalizeToolPresentation('read', readInput)).toEqual({
      name: 'Read',
      input: {
        path: '/project/read.ts',
        file_path: '/project/read.ts',
        offset: 2,
      },
    })
    expect(normalizeToolPresentation('edit', editInput)).toEqual({
      name: 'Edit',
      input: {
        path: '/project/edit.ts',
        file_path: '/project/edit.ts',
        oldText: '旧内容',
        old_string: '旧内容',
        newText: '新内容',
        new_string: '新内容',
      },
    })
    expect(normalizeToolPresentation('write', writeInput)).toEqual({
      name: 'Write',
      input: {
        path: '/project/write.ts',
        file_path: '/project/write.ts',
        content: '文件内容',
      },
    })
  })

  test('Given Pi 可兼容现有展示器的工具 When 生成展示信息 Then 仅映射明确支持的小写名称', () => {
    expect(normalizeToolPresentation('bash', { command: 'ls -la' }).name).toBe('Bash')
    expect(normalizeToolPresentation('grep', { pattern: 'TODO', path: 'src' }).name).toBe('Grep')
    expect(normalizeToolPresentation('find', {
      pattern: '**/*.ts',
      path: 'src',
      limit: 20,
    })).toEqual({
      name: 'Glob',
      input: {
        pattern: '**/*.ts',
        path: 'src',
        limit: 20,
      },
    })
    expect(normalizeToolPresentation('ls', { path: 'src' }).name).toBe('ls')
    expect(normalizeToolPresentation('Bash', { command: 'pwd' }).name).toBe('Bash')
  })

  test('Given 原始 Pi 输入 When 生成展示副本 Then 不修改或复用原对象', () => {
    const input = {
      path: '/project/file.ts',
      oldText: '旧内容',
      newText: '新内容',
    }
    const originalSnapshot = { ...input }

    const presentation = normalizeToolPresentation('edit', input)

    expect(input).toEqual(originalSnapshot)
    expect(presentation.input).not.toBe(input)
  })
})
