import { describe, expect, test } from 'bun:test'
import type { RegisteredAgent } from '@proma/shared'
import {
  createEmptyAgentRegistrationForm,
  registeredAgentToForm,
  utf8ByteLength,
  validateAgentRegistration,
  validateGlobalAgentInstructions,
} from './agent-registration'

describe('子 Agent 注册表单', () => {
  test('Given 合法字段 When 校验 Then 生成继承父会话配置的注册 Agent', () => {
    const result = validateAgentRegistration({
      ...createEmptyAgentRegistrationForm(),
      id: 'fix-executor',
      name: '修复执行',
      description: '实施明确的修复方案',
      prompt: '只修改授权文件。',
      role: 'implement',
    }, [])

    expect(result.errors).toEqual({})
    expect(result.agent).toEqual({
      id: 'fix-executor',
      name: '修复执行',
      description: '实施明确的修复方案',
      prompt: '只修改授权文件。',
      enabled: true,
      role: 'implement',
    })
  })

  test('Given 显式选择不允许工具 When 校验 Then 保存空 tools 数组', () => {
    const result = validateAgentRegistration({
      ...createEmptyAgentRegistrationForm(),
      id: 'reader',
      name: '只读检查',
      description: '只分析输入',
      prompt: '不要调用工具。',
      toolPolicy: 'none',
    }, [])

    expect(result.agent?.tools).toEqual([])
  })

  test('Given 重复或非法 ID 与非正轮数 When 校验 Then 返回字段错误', () => {
    const existing: RegisteredAgent[] = [{
      id: 'reviewer',
      name: '审查',
      description: '审查实现',
      prompt: '检查代码。',
      enabled: true,
    }]
    const result = validateAgentRegistration({
      ...createEmptyAgentRegistrationForm(),
      id: 'reviewer',
      name: '另一个审查',
      description: '说明',
      prompt: '提示词',
      maxTurns: '0',
    }, existing)

    expect(result.errors.id).toContain('已被')
    expect(result.errors.maxTurns).toContain('1 到 1000')
  })

  test('Given 已保存空 tools 数组 When 编辑 Then 保留“不允许任何工具”语义', () => {
    const form = registeredAgentToForm({
      id: 'safe-reader',
      name: '安全读取',
      description: '不调用工具',
      prompt: '仅根据上下文回答。',
      enabled: true,
      tools: [],
    })

    expect(form.toolPolicy).toBe('none')
  })

  test('Given 最大轮数超过服务上限 When 校验 Then 阻止保存', () => {
    const result = validateAgentRegistration({
      ...createEmptyAgentRegistrationForm(),
      id: 'long-runner',
      name: '长任务',
      description: '处理长任务',
      prompt: '持续完成任务。',
      maxTurns: '1001',
    }, [])

    expect(result.agent).toBeUndefined()
    expect(result.errors.maxTurns).toContain('1000')
  })

  test('Given 尾连字符、双连字符或保留 ID When 校验 Then 与服务一致地拒绝', () => {
    for (const id of ['agent-', 'agent--review', 'constructor', 'prototype']) {
      const result = validateAgentRegistration({
        ...createEmptyAgentRegistrationForm(),
        id,
        name: '角色',
        description: '',
        prompt: '执行任务。',
      }, [])
      expect(result.errors.id).toBeTruthy()
    }
  })

  test('Given 全局规则超过 256 KiB 或包含空字符 When 校验 Then 阻止保存', () => {
    expect(validateGlobalAgentInstructions('a'.repeat(256 * 1024 + 1))).toContain('256 KiB')
    expect(validateGlobalAgentInstructions('valid\u0000invalid')).toContain('空字符')
    expect(validateGlobalAgentInstructions('# 合法规则')).toBeNull()
  })

  test('Given 中文提示词字符数未超限但 UTF-8 字节超过 64 KiB When 校验 Then 阻止保存', () => {
    const prompt = '中'.repeat(Math.floor((64 * 1024) / 3) + 1)
    expect(prompt.length).toBeLessThan(64 * 1024)
    expect(utf8ByteLength(prompt)).toBeGreaterThan(64 * 1024)

    const result = validateAgentRegistration({
      ...createEmptyAgentRegistrationForm(),
      id: 'utf8-prompt',
      name: '中文提示词',
      prompt,
    }, [])

    expect(result.agent).toBeUndefined()
    expect(result.errors.prompt).toContain('64 KiB')
    expect(result.errors.prompt).toContain('UTF-8')
  })

  test('Given 中文全局规则字符数未超限但 UTF-8 字节超过 256 KiB When 校验 Then 阻止保存', () => {
    const instructions = '中'.repeat(Math.floor((256 * 1024) / 3) + 1)
    expect(instructions.length).toBeLessThan(256 * 1024)
    expect(utf8ByteLength(instructions)).toBeGreaterThan(256 * 1024)
    expect(validateGlobalAgentInstructions(instructions)).toContain('UTF-8')
  })

  test('Given 工具名大小写不同 When 校验 Then 保留原名并按精确名称检测冲突', () => {
    const result = validateAgentRegistration({
      ...createEmptyAgentRegistrationForm(),
      id: 'tool-agent',
      name: '工具角色',
      description: '',
      prompt: '使用指定工具。',
      toolPolicy: 'custom',
      toolsText: 'read\nWebSearch',
      disallowedToolsText: 'Read',
    }, [])

    expect(result.errors).toEqual({})
    expect(result.agent?.tools).toEqual(['read', 'WebSearch'])
    expect(result.agent?.disallowedTools).toEqual(['Read'])
  })
})
