import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRegistrationUpdate, RegisteredAgent } from '@proma/shared'
import {
  createAgentRegistrationService,
  type AgentRegistrationService,
} from './agent-registration-service'

let tempRoot: string
let configDir: string
let agentsPath: string
let instructionsPath: string
let service: AgentRegistrationService

const CUSTOM_AGENT: RegisteredAgent = {
  id: 'implementation-helper',
  name: '实现: "助手"',
  description: '负责局部实现。\n支持多行说明。',
  prompt: '严格按方案实现并验证。',
  enabled: true,
  role: 'implement',
  modelId: 'test:model',
  permissionMode: 'default',
  effortLevel: 'high',
  tools: ['Read', 'Edit:File'],
  disallowedTools: ['WebSearch'],
  maxTurns: 20,
}

function writeAgentMarkdown(id: string, frontmatter: string, prompt: string): string {
  mkdirSync(agentsPath, { recursive: true })
  const filePath = join(agentsPath, `${id}.md`)
  writeFileSync(filePath, `---\n${frontmatter.trim()}\n---\n${prompt}`, 'utf-8')
  return filePath
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'proma-agent-registration-'))
})

beforeEach(() => {
  configDir = join(tempRoot, crypto.randomUUID())
  agentsPath = join(configDir, 'agents')
  instructionsPath = join(configDir, 'AGENTS.md')
  service = createAgentRegistrationService(configDir)
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('子 Agent Markdown 默认值', () => {
  test('Given agents 目录不存在 When 读取配置 Then 生成三个可编辑的默认角色文件但不创建全局规则', () => {
    const config = service.getAgentRegistrationConfig()

    expect(config.agents.map((agent) => agent.id)).toEqual([
      'explore',
      'research',
      'review',
    ])
    expect(config.globalInstructions).toBe('')
    expect(config.agentsPath).toBe(agentsPath)
    expect(config.instructionsPath).toBe(instructionsPath)
    expect(existsSync(join(agentsPath, 'explore.md'))).toBe(true)
    expect(existsSync(join(agentsPath, 'research.md'))).toBe(true)
    expect(existsSync(join(agentsPath, 'review.md'))).toBe(true)
    expect(existsSync(instructionsPath)).toBe(false)
  })

  test('Given 仅读取全局规则 When 文件不存在 Then 不触发默认角色或规则文件创建', () => {
    expect(service.getGlobalAgentInstructions()).toBe('')
    expect(existsSync(configDir)).toBe(false)
  })
})

describe('子 Agent Markdown 持久化', () => {
  test('Given 完整合法配置 When 保存并读取 Then 元数据特殊字符与正文 prompt 往返一致', () => {
    const input: AgentRegistrationUpdate = {
      agents: [CUSTOM_AGENT],
      globalInstructions: '# 全局规则\n\n优先复用现有实现。',
    }

    expect(service.saveAgentRegistrationConfig(input)).toEqual({
      agents: [CUSTOM_AGENT],
      globalInstructions: input.globalInstructions,
      agentsPath,
      instructionsPath,
    })
    const markdown = readFileSync(
      join(agentsPath, `${CUSTOM_AGENT.id}.md`),
      'utf-8',
    )
    expect(markdown).toContain('name: "实现: \\"助手\\""')
    expect(markdown).toContain('description: "负责局部实现。\\n支持多行说明。"')
    expect(markdown).toContain('tools:\n  - "Read"\n  - "Edit:File"')
    expect(markdown.endsWith(CUSTOM_AGENT.prompt)).toBe(true)
    expect(readFileSync(instructionsPath, 'utf-8')).toBe(input.globalInstructions)
    expect(
      Array.from(new Bun.Glob('*.tmp').scanSync({ cwd: agentsPath })),
    ).toEqual([])
  })

  test('Given 服务已读取 When 用户手工编辑 Markdown Then 下一次读取使用磁盘最新内容', () => {
    service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT],
      globalInstructions: '',
    })
    writeAgentMarkdown(
      CUSTOM_AGENT.id,
      `
name: '手工: 审查'
description: |
  第一行说明
  第二行: 含冒号
enabled: true
role: custom
tools:
  - Read
  - "Edit:File"
`,
      '这是手工修改后的 prompt。',
    )

    expect(service.getRegisteredAgent(CUSTOM_AGENT.id)).toMatchObject({
      id: CUSTOM_AGENT.id,
      name: '手工: 审查',
      description: '第一行说明\n第二行: 含冒号',
      prompt: '这是手工修改后的 prompt。',
      role: 'custom',
      tools: ['Read', 'Edit:File'],
    })
  })

  test('Given 用户手工新增合法 Markdown When 重新扫描 Then 自动注册新角色', () => {
    writeAgentMarkdown(
      'manual-reviewer',
      `
name: 手工审查
description: 从磁盘手工注册
enabled: true
role: review
effortLevel: xhigh
maxTurns: 12
`,
      '检查本次改动并报告问题。',
    )

    expect(service.listRegisteredAgents()).toEqual([{
      id: 'manual-reviewer',
      name: '手工审查',
      description: '从磁盘手工注册',
      prompt: '检查本次改动并报告问题。',
      enabled: true,
      role: 'review',
      effortLevel: 'xhigh',
      maxTurns: 12,
    }])
  })
})

describe('子 Agent 文件损坏与路径安全', () => {
  test('Given 合法 ID 文件使用未知复杂语法 When 读取或保存 Then 明确报错且不覆盖原文件', () => {
    const filePath = writeAgentMarkdown(
      'broken-agent',
      'name: { nested: value }\ndescription: 损坏\nenabled: true',
      '不会被覆盖',
    )
    const original = readFileSync(filePath, 'utf-8')

    expect(() => service.getAgentRegistrationConfig()).toThrow(/不支持的复杂 YAML 语法/)
    expect(() => service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT],
      globalInstructions: '',
    })).toThrow(/不支持的复杂 YAML 语法/)
    expect(readFileSync(filePath, 'utf-8')).toBe(original)
  })

  test('Given 重复或未知 frontmatter 字段 When 读取 Then 明确报错', () => {
    writeAgentMarkdown(
      'duplicate-agent',
      'name: 第一\nname: 第二\ndescription: 重复\nenabled: true',
      'prompt',
    )
    expect(() => service.getAgentRegistrationConfig()).toThrow(/重复字段/)

    rmSync(agentsPath, { recursive: true, force: true })
    writeAgentMarkdown(
      'unknown-field-agent',
      'name: 未知\ndescription: 未知字段\nenabled: true\nsecret: value',
      'prompt',
    )
    expect(() => service.getAgentRegistrationConfig()).toThrow(/未知字段/)
  })

  test('Given 非法文件名和指向目录外的符号链接 When 扫描 Then 忽略且不读取链接目标', () => {
    mkdirSync(agentsPath, { recursive: true })
    writeFileSync(join(agentsPath, 'Bad Agent.md'), '不是角色文件', 'utf-8')
    const outsideFile = join(configDir, 'outside.md')
    writeFileSync(
      outsideFile,
      '---\nname: 外部\ndescription: 不应读取\nenabled: true\n---\n外部 prompt',
      'utf-8',
    )
    symlinkSync(outsideFile, join(agentsPath, 'linked-agent.md'))
    writeAgentMarkdown(
      'safe-agent',
      'name: 安全\ndescription: 普通文件\nenabled: true',
      '安全 prompt',
    )

    expect(service.listRegisteredAgents().map((agent) => agent.id)).toEqual([
      'safe-agent',
    ])
  })

  test('Given agents 路径本身是符号链接 When 扫描 Then 拒绝跟随目录链接', () => {
    const outsideDirectory = join(tempRoot, `outside-${crypto.randomUUID()}`)
    mkdirSync(outsideDirectory, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    symlinkSync(outsideDirectory, agentsPath)

    expect(() => service.getAgentRegistrationConfig()).toThrow(/不是安全目录/)
  })
})

describe('保存时无损管理角色文件', () => {
  test('Given 受管旧角色和未知内容并存 When 保存新列表 Then 仅删除受管旧角色', () => {
    const stalePath = writeAgentMarkdown(
      'stale-agent',
      'name: 旧角色\ndescription: 将被删除\nenabled: true',
      '旧 prompt',
    )
    const unknownTextPath = join(agentsPath, 'notes.txt')
    const invalidMarkdownPath = join(agentsPath, 'Invalid Name.md')
    writeFileSync(unknownTextPath, '用户说明', 'utf-8')
    writeFileSync(invalidMarkdownPath, '用户自定义内容', 'utf-8')

    service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT],
      globalInstructions: '',
    })

    expect(existsSync(stalePath)).toBe(false)
    expect(readFileSync(unknownTextPath, 'utf-8')).toBe('用户说明')
    expect(readFileSync(invalidMarkdownPath, 'utf-8')).toBe('用户自定义内容')
    expect(existsSync(join(agentsPath, `${CUSTOM_AGENT.id}.md`))).toBe(true)
  })

  test('Given 目标 ID 已被符号链接占用 When 保存 Then 拒绝替换链接', () => {
    mkdirSync(agentsPath, { recursive: true })
    const outsideFile = join(configDir, 'outside-target.md')
    writeFileSync(outsideFile, '外部内容', 'utf-8')
    symlinkSync(outsideFile, join(agentsPath, `${CUSTOM_AGENT.id}.md`))

    expect(() => service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT],
      globalInstructions: '',
    })).toThrow(/不能覆盖非普通子 Agent 文件/)
    expect(readFileSync(outsideFile, 'utf-8')).toBe('外部内容')
  })

  test('Given 目标 ID 被 dangling symlink 占用 When 保存 Then 仍拒绝替换用户链接', () => {
    mkdirSync(agentsPath, { recursive: true })
    const linkPath = join(agentsPath, `${CUSTOM_AGENT.id}.md`)
    symlinkSync(join(configDir, 'missing-target.md'), linkPath)

    expect(() => service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT],
      globalInstructions: '',
    })).toThrow(/不能覆盖非普通子 Agent 文件/)
    expect(existsSync(linkPath)).toBe(false)
  })

  test('Given 后续角色目标是链接 When 保存前置检查失败 Then 前面角色不发生部分写入', () => {
    const firstPath = writeAgentMarkdown(
      CUSTOM_AGENT.id,
      'name: 原始角色\ndescription: 原始内容\nenabled: true',
      '原始 prompt',
    )
    const original = readFileSync(firstPath, 'utf-8')
    const outsideFile = join(configDir, 'outside-second.md')
    writeFileSync(outsideFile, '外部内容', 'utf-8')
    symlinkSync(outsideFile, join(agentsPath, 'linked-second.md'))

    expect(() => service.saveAgentRegistrationConfig({
      agents: [
        CUSTOM_AGENT,
        {
          ...CUSTOM_AGENT,
          id: 'linked-second',
          name: '第二角色',
        },
      ],
      globalInstructions: '',
    })).toThrow(/不能覆盖非普通子 Agent 文件/)
    expect(readFileSync(firstPath, 'utf-8')).toBe(original)
  })
})

describe('子 Agent 输入严格校验与启用过滤', () => {
  test('Given 未知字段、重复或危险 ID When 保存 Then 拒绝输入', () => {
    expect(() => service.saveAgentRegistrationConfig({
      agents: [{ ...CUSTOM_AGENT, unexpected: true } as RegisteredAgent],
      globalInstructions: '',
    })).toThrow(/未知字段/)
    expect(() => service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT, { ...CUSTOM_AGENT }],
      globalInstructions: '',
    })).toThrow(/重复 Agent ID/)
    expect(() => service.saveAgentRegistrationConfig({
      agents: [{ ...CUSTOM_AGENT, id: '../escape' }],
      globalInstructions: '',
    })).toThrow(/安全的 Agent ID/)
  })

  test('Given 无效权限、effort、maxTurns 或超长内容 When 保存 Then 拒绝输入', () => {
    expect(() => service.saveAgentRegistrationConfig({
      agents: [{
        ...CUSTOM_AGENT,
        permissionMode: 'unsafe' as RegisteredAgent['permissionMode'],
      }],
      globalInstructions: '',
    })).toThrow(/permissionMode 无效/)
    expect(() => service.saveAgentRegistrationConfig({
      agents: [{
        ...CUSTOM_AGENT,
        effortLevel: 'extreme' as RegisteredAgent['effortLevel'],
      }],
      globalInstructions: '',
    })).toThrow(/effortLevel 无效/)
    expect(() => service.saveAgentRegistrationConfig({
      agents: [{ ...CUSTOM_AGENT, maxTurns: 0 }],
      globalInstructions: '',
    })).toThrow(/maxTurns/)
    expect(() => service.saveAgentRegistrationConfig({
      agents: [{ ...CUSTOM_AGENT, prompt: 'a'.repeat(64 * 1024 + 1) }],
      globalInstructions: '',
    })).toThrow(/prompt 超过长度上限/)
    expect(() => service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT],
      globalInstructions: 'a'.repeat(256 * 1024 + 1),
    })).toThrow(/globalInstructions 超过长度上限/)
  })

  test('Given 中文内容字符数未超限但 UTF-8 字节超限 When 保存 Then 写入前拒绝', () => {
    expect(() => service.saveAgentRegistrationConfig({
      agents: [{
        ...CUSTOM_AGENT,
        prompt: '中'.repeat(Math.floor(64 * 1024 / 3) + 1),
      }],
      globalInstructions: '',
    })).toThrow(/prompt 超过 UTF-8 大小上限/)

    expect(() => service.saveAgentRegistrationConfig({
      agents: [CUSTOM_AGENT],
      globalInstructions: '中'.repeat(Math.floor(256 * 1024 / 3) + 1),
    })).toThrow(/globalInstructions 超过 UTF-8 大小上限/)
    expect(existsSync(configDir)).toBe(false)
  })

  test('Given 同时存在启用和禁用 Agent When 列表或按 ID 获取 Then 禁用项不可使用', () => {
    service.saveAgentRegistrationConfig({
      agents: [
        CUSTOM_AGENT,
        {
          ...CUSTOM_AGENT,
          id: 'disabled-reviewer',
          name: '禁用审查',
          enabled: false,
        },
      ],
      globalInstructions: '共享规则',
    })

    expect(service.listRegisteredAgents().map((agent) => agent.id)).toEqual([
      CUSTOM_AGENT.id,
    ])
    expect(service.getRegisteredAgent(CUSTOM_AGENT.id)).toEqual(CUSTOM_AGENT)
    expect(() => service.getRegisteredAgent('disabled-reviewer')).toThrow(/不存在或已禁用/)
    expect(() => service.getRegisteredAgent('unknown-agent')).toThrow(/不存在或已禁用/)
    expect(service.getGlobalAgentInstructions()).toBe('共享规则')
  })

  test('Given agents 目录内文件损坏 When 单独读取全局规则 Then 不受角色文件影响', () => {
    writeAgentMarkdown(
      'broken-agent',
      'name: { nested: value }\ndescription: 损坏\nenabled: true',
      '损坏',
    )
    writeFileSync(instructionsPath, '正常会话仍可读取', 'utf-8')

    expect(service.getGlobalAgentInstructions()).toBe('正常会话仍可读取')
  })
})
