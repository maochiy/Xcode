/**
 * 子 Agent 注册配置服务
 *
 * 每个角色保存为 agents/<id>.md：受限 YAML frontmatter 保存元数据，
 * 正文保存 prompt。读取始终重新扫描磁盘，不跟随符号链接。
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import {
  isPromaPermissionMode,
  type AgentDelegationRole,
  type AgentRegistrationConfig,
  type AgentRegistrationUpdate,
  type PromaPermissionMode,
  type RegisteredAgent,
  type ThinkingEffortLevel,
} from '@proma/shared'
import { getConfigDir } from './config-paths'

const AGENTS_DIRECTORY_NAME = 'agents'
const INSTRUCTIONS_FILE_NAME = 'AGENTS.md'

const MAX_AGENT_COUNT = 64
const MAX_AGENT_FILE_BYTES = 128 * 1024
const MAX_GLOBAL_INSTRUCTIONS_BYTES = 256 * 1024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_NAME_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_MODEL_ID_LENGTH = 256
const MAX_TOOL_COUNT = 128
const MAX_TOOL_NAME_LENGTH = 256
const MAX_TURNS = 1_000

const AGENT_KEYS = new Set([
  'id',
  'name',
  'description',
  'prompt',
  'enabled',
  'role',
  'modelId',
  'permissionMode',
  'effortLevel',
  'tools',
  'disallowedTools',
  'maxTurns',
])
const FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'enabled',
  'role',
  'modelId',
  'permissionMode',
  'effortLevel',
  'tools',
  'disallowedTools',
  'maxTurns',
])
const ARRAY_FRONTMATTER_KEYS = new Set(['tools', 'disallowedTools'])
const UPDATE_KEYS = new Set(['agents', 'globalInstructions'])
const AGENT_ROLES = new Set<AgentDelegationRole>([
  'explore',
  'research',
  'implement',
  'review',
  'custom',
])
const THINKING_EFFORT_LEVELS = new Set<ThinkingEffortLevel>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])
const DANGEROUS_AGENT_IDS = new Set(['__proto__', 'prototype', 'constructor'])
const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/
const UNSUPPORTED_PLAIN_SCALAR_PREFIX = /^[\[{&*!|>@`]/

interface AgentDirectoryScan {
  agents: RegisteredAgent[]
  managedFiles: Map<string, string>
}

interface FrontmatterEntry {
  key: string
  rawValue: string
  lineNumber: number
}

export interface AgentRegistrationService {
  getAgentRegistrationConfig: () => AgentRegistrationConfig
  saveAgentRegistrationConfig: (input: AgentRegistrationUpdate) => AgentRegistrationConfig
  listRegisteredAgents: () => RegisteredAgent[]
  getRegisteredAgent: (id: string) => RegisteredAgent
  getGlobalAgentInstructions: () => string
}

const DEFAULT_REGISTERED_AGENTS: readonly RegisteredAgent[] = [
  {
    id: 'explore',
    name: '探索',
    description: '快速浏览代码库，定位相关文件、调用链和现有实现。',
    prompt: '只读探索代码库，找出与任务相关的文件、调用链、约束和可复用实现，并用清晰证据汇报结论。',
    enabled: true,
    role: 'explore',
  },
  {
    id: 'research',
    name: '研究',
    description: '针对技术问题收集可靠资料并形成可执行结论。',
    prompt: '围绕任务进行只读研究，优先使用项目内证据和权威来源，区分事实、推断与尚未确认的信息。',
    enabled: true,
    role: 'research',
  },
  {
    id: 'review',
    name: '审查',
    description: '审查实现的正确性、回归风险和验证覆盖。',
    prompt: '只读审查已有实现，优先发现正确性、安全性、兼容性和测试覆盖问题，并给出可定位的证据。',
    enabled: true,
    role: 'review',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${path} 包含未知字段: ${key}`)
    }
  }
}

function assertString(
  value: unknown,
  path: string,
  options: {
    allowEmpty?: boolean
    maxLength: number
    rejectControlCharacters?: boolean
  },
): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${path} 必须是字符串`)
  }
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new Error(`${path} 不能为空`)
  }
  if (value.length > options.maxLength) {
    throw new Error(`${path} 超过长度上限 ${options.maxLength}`)
  }
  if (options.rejectControlCharacters && CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${path} 不能包含控制字符`)
  }
}

function assertUtf8ByteLength(value: string, path: string, maxBytes: number): void {
  const byteLength = Buffer.byteLength(value, 'utf-8')
  if (byteLength > maxBytes) {
    throw new Error(`${path} 超过 UTF-8 大小上限 ${maxBytes} 字节`)
  }
}

function lstatIfExists(filePath: string): Stats | null {
  try {
    return lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function isSafeAgentId(value: string): boolean {
  return value.length <= 64
    && AGENT_ID_PATTERN.test(value)
    && !DANGEROUS_AGENT_IDS.has(value)
}

function validateAgentId(value: unknown, path: string): asserts value is string {
  assertString(value, path, {
    maxLength: 64,
    rejectControlCharacters: true,
  })
  if (!isSafeAgentId(value)) {
    throw new Error(`${path} 不是安全的 Agent ID`)
  }
}

function validateOptionalString(
  value: unknown,
  path: string,
  maxLength: number,
): asserts value is string | undefined {
  if (value === undefined) return
  assertString(value, path, {
    maxLength,
    rejectControlCharacters: true,
  })
}

function validateToolList(
  value: unknown,
  path: string,
): asserts value is string[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    throw new Error(`${path} 必须是字符串数组`)
  }
  if (value.length > MAX_TOOL_COUNT) {
    throw new Error(`${path} 最多允许 ${MAX_TOOL_COUNT} 项`)
  }

  const seen = new Set<string>()
  for (const [index, toolName] of value.entries()) {
    assertString(toolName, `${path}[${index}]`, {
      maxLength: MAX_TOOL_NAME_LENGTH,
      rejectControlCharacters: true,
    })
    if (seen.has(toolName)) {
      throw new Error(`${path} 包含重复工具: ${toolName}`)
    }
    seen.add(toolName)
  }
}

function validateRegisteredAgent(value: unknown, path: string): RegisteredAgent {
  if (!isRecord(value)) {
    throw new Error(`${path} 必须是对象`)
  }
  assertExactKeys(value, AGENT_KEYS, path)
  validateAgentId(value.id, `${path}.id`)
  assertString(value.name, `${path}.name`, {
    maxLength: MAX_NAME_LENGTH,
    rejectControlCharacters: true,
  })
  assertString(value.description, `${path}.description`, {
    allowEmpty: true,
    maxLength: MAX_DESCRIPTION_LENGTH,
  })
  assertString(value.prompt, `${path}.prompt`, {
    maxLength: MAX_PROMPT_BYTES,
  })
  assertUtf8ByteLength(value.prompt, `${path}.prompt`, MAX_PROMPT_BYTES)
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`${path}.enabled 必须是布尔值`)
  }

  if (value.role !== undefined && (
    typeof value.role !== 'string'
    || !AGENT_ROLES.has(value.role as AgentDelegationRole)
  )) {
    throw new Error(`${path}.role 无效`)
  }
  validateOptionalString(value.modelId, `${path}.modelId`, MAX_MODEL_ID_LENGTH)
  if (value.permissionMode !== undefined && (
    typeof value.permissionMode !== 'string'
    || !isPromaPermissionMode(value.permissionMode)
  )) {
    throw new Error(`${path}.permissionMode 无效`)
  }
  if (value.effortLevel !== undefined && (
    typeof value.effortLevel !== 'string'
    || !THINKING_EFFORT_LEVELS.has(value.effortLevel as ThinkingEffortLevel)
  )) {
    throw new Error(`${path}.effortLevel 无效`)
  }
  validateToolList(value.tools, `${path}.tools`)
  validateToolList(value.disallowedTools, `${path}.disallowedTools`)

  if (value.maxTurns !== undefined && (
    !Number.isInteger(value.maxTurns)
    || (value.maxTurns as number) < 1
    || (value.maxTurns as number) > MAX_TURNS
  )) {
    throw new Error(`${path}.maxTurns 必须是 1 到 ${MAX_TURNS} 的整数`)
  }

  const tools = value.tools as string[] | undefined
  const disallowedTools = value.disallowedTools as string[] | undefined
  if (tools && disallowedTools) {
    const disallowed = new Set(disallowedTools)
    const conflict = tools.find((toolName) => disallowed.has(toolName))
    if (conflict) {
      throw new Error(`${path} 同时允许和禁止工具: ${conflict}`)
    }
  }

  return {
    id: value.id,
    name: value.name,
    description: value.description,
    prompt: value.prompt,
    enabled: value.enabled,
    ...(value.role !== undefined ? { role: value.role as AgentDelegationRole } : {}),
    ...(value.modelId !== undefined ? { modelId: value.modelId } : {}),
    ...(value.permissionMode !== undefined
      ? { permissionMode: value.permissionMode as PromaPermissionMode }
      : {}),
    ...(value.effortLevel !== undefined
      ? { effortLevel: value.effortLevel as ThinkingEffortLevel }
      : {}),
    ...(tools !== undefined ? { tools: [...tools] } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools: [...disallowedTools] } : {}),
    ...(value.maxTurns !== undefined ? { maxTurns: value.maxTurns as number } : {}),
  }
}

function validateAgentList(value: unknown, path: string): RegisteredAgent[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} 必须是数组`)
  }
  if (value.length > MAX_AGENT_COUNT) {
    throw new Error(`${path} 最多允许 ${MAX_AGENT_COUNT} 个 Agent`)
  }

  const agents = value.map((agent, index) =>
    validateRegisteredAgent(agent, `${path}[${index}]`))
  const ids = new Set<string>()
  for (const agent of agents) {
    if (ids.has(agent.id)) {
      throw new Error(`${path} 包含重复 Agent ID: ${agent.id}`)
    }
    ids.add(agent.id)
  }
  return agents
}

function validateUpdate(value: unknown): AgentRegistrationUpdate {
  if (!isRecord(value)) {
    throw new Error('子 Agent 配置必须是对象')
  }
  assertExactKeys(value, UPDATE_KEYS, '子 Agent 配置')
  if (!Object.hasOwn(value, 'agents') || !Object.hasOwn(value, 'globalInstructions')) {
    throw new Error('子 Agent 配置必须同时包含 agents 和 globalInstructions')
  }
  const agents = validateAgentList(value.agents, 'agents')
  assertString(value.globalInstructions, 'globalInstructions', {
    allowEmpty: true,
    maxLength: MAX_GLOBAL_INSTRUCTIONS_BYTES,
  })
  assertUtf8ByteLength(
    value.globalInstructions,
    'globalInstructions',
    MAX_GLOBAL_INSTRUCTIONS_BYTES,
  )
  if (value.globalInstructions.includes('\0')) {
    throw new Error('globalInstructions 不能包含空字符')
  }
  return {
    agents,
    globalInstructions: value.globalInstructions,
  }
}

function cloneAgents(agents: readonly RegisteredAgent[]): RegisteredAgent[] {
  return agents.map((agent) => ({
    ...agent,
    ...(agent.tools ? { tools: [...agent.tools] } : {}),
    ...(agent.disallowedTools ? { disallowedTools: [...agent.disallowedTools] } : {}),
  }))
}

function readUtf8FileWithLimit(filePath: string, maxBytes: number, label: string): string {
  const size = statSync(filePath).size
  if (size > maxBytes) {
    throw new Error(`${label} 超过大小上限 ${maxBytes} 字节`)
  }
  return readFileSync(filePath, 'utf-8')
}

function readRegularFileNoFollow(filePath: string): string {
  let fileDescriptor: number | undefined
  try {
    fileDescriptor = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    const stats = fstatSync(fileDescriptor)
    if (!stats.isFile()) {
      throw new Error('不是普通文件')
    }
    if (stats.size > MAX_AGENT_FILE_BYTES) {
      throw new Error(`超过大小上限 ${MAX_AGENT_FILE_BYTES} 字节`)
    }
    return readFileSync(fileDescriptor, 'utf-8')
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor)
    }
  }
}

function splitAgentMarkdown(
  content: string,
  fileName: string,
): { frontmatter: string; prompt: string } {
  const normalized = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
  const opening = normalized.match(/^---[ \t]*\r?\n/)
  if (!opening) {
    throw new Error(`${fileName} 缺少 YAML frontmatter`)
  }

  const remainder = normalized.slice(opening[0].length)
  const closing = remainder.match(/\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!closing || closing.index === undefined) {
    throw new Error(`${fileName} 的 YAML frontmatter 未闭合`)
  }
  return {
    frontmatter: remainder.slice(0, closing.index),
    prompt: remainder.slice(closing.index + closing[0].length),
  }
}

function parseQuotedString(rawValue: string, path: string): string {
  if (rawValue.startsWith('"')) {
    try {
      const parsed = JSON.parse(rawValue) as unknown
      if (typeof parsed !== 'string') {
        throw new Error('必须解析为字符串')
      }
      return parsed
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${path} 的双引号字符串无效: ${message}`)
    }
  }
  if (rawValue.startsWith("'")) {
    if (!rawValue.endsWith("'") || rawValue.length < 2) {
      throw new Error(`${path} 的单引号字符串未闭合`)
    }
    return rawValue.slice(1, -1).replaceAll("''", "'")
  }
  if (UNSUPPORTED_PLAIN_SCALAR_PREFIX.test(rawValue)) {
    throw new Error(`${path} 使用了不支持的复杂 YAML 语法`)
  }
  return rawValue
}

function parseInlineStringArray(rawValue: string, path: string): string[] {
  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('必须是 JSON 风格字符串数组')
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${path} 的行内数组无效: ${message}`)
  }
}

function parseFrontmatter(frontmatter: string, fileName: string): Record<string, unknown> {
  const lines = frontmatter.replaceAll('\r\n', '\n').split('\n')
  const metadata: Record<string, unknown> = {}

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    const lineNumber = index + 1
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    if (/^\s/.test(line)) {
      throw new Error(`${fileName} frontmatter 第 ${lineNumber} 行存在意外缩进`)
    }

    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:[ \t]*(.*))?$/)
    if (!match) {
      throw new Error(`${fileName} frontmatter 第 ${lineNumber} 行语法无效`)
    }
    const entry: FrontmatterEntry = {
      key: match[1]!,
      rawValue: match[2] ?? '',
      lineNumber,
    }
    if (!FRONTMATTER_KEYS.has(entry.key)) {
      throw new Error(`${fileName} frontmatter 包含未知字段: ${entry.key}`)
    }
    if (Object.hasOwn(metadata, entry.key)) {
      throw new Error(`${fileName} frontmatter 包含重复字段: ${entry.key}`)
    }

    if (entry.rawValue === '|') {
      if (entry.key !== 'description') {
        throw new Error(`${fileName} frontmatter.${entry.key} 不支持多行块`)
      }
      const blockLines: string[] = []
      index += 1
      while (index < lines.length) {
        const blockLine = lines[index]!
        if (blockLine !== '' && !/^[ \t]/.test(blockLine)) break
        if (blockLine === '') {
          blockLines.push('')
        } else if (blockLine.startsWith('  ')) {
          blockLines.push(blockLine.slice(2))
        } else {
          throw new Error(
            `${fileName} frontmatter 第 ${index + 1} 行多行块必须缩进两个空格`,
          )
        }
        index += 1
      }
      metadata[entry.key] = blockLines.join('\n')
      continue
    }

    if (ARRAY_FRONTMATTER_KEYS.has(entry.key)) {
      if (entry.rawValue.startsWith('[')) {
        metadata[entry.key] = parseInlineStringArray(
          entry.rawValue,
          `${fileName} frontmatter.${entry.key}`,
        )
        index += 1
        continue
      }
      if (entry.rawValue !== '') {
        throw new Error(
          `${fileName} frontmatter.${entry.key} 必须使用字符串列表或 JSON 行内数组`,
        )
      }

      const values: string[] = []
      index += 1
      while (index < lines.length) {
        const listLine = lines[index]!
        if (listLine.trim() === '') {
          index += 1
          continue
        }
        const itemMatch = listLine.match(/^[ \t]+-[ \t]+(.+)$/)
        if (!itemMatch) break
        values.push(parseQuotedString(
          itemMatch[1]!.trim(),
          `${fileName} frontmatter.${entry.key}[${values.length}]`,
        ))
        index += 1
      }
      metadata[entry.key] = values
      continue
    }

    if (entry.rawValue === '') {
      throw new Error(`${fileName} frontmatter.${entry.key} 缺少值`)
    }
    if (entry.key === 'enabled') {
      if (entry.rawValue !== 'true' && entry.rawValue !== 'false') {
        throw new Error(`${fileName} frontmatter.enabled 仅支持 true 或 false`)
      }
      metadata.enabled = entry.rawValue === 'true'
    } else if (entry.key === 'maxTurns') {
      if (!/^-?\d+$/.test(entry.rawValue)) {
        throw new Error(`${fileName} frontmatter.maxTurns 必须是十进制整数`)
      }
      metadata.maxTurns = Number(entry.rawValue)
    } else {
      metadata[entry.key] = parseQuotedString(
        entry.rawValue,
        `${fileName} frontmatter.${entry.key}`,
      )
    }
    index += 1
  }

  return metadata
}

function parseAgentMarkdown(
  filePath: string,
  id: string,
  fileName: string,
): RegisteredAgent {
  let content: string
  try {
    content = readRegularFileNoFollow(filePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法安全读取子 Agent 文件 ${fileName}: ${message}`)
  }

  const { frontmatter, prompt } = splitAgentMarkdown(content, fileName)
  const metadata = parseFrontmatter(frontmatter, fileName)
  return validateRegisteredAgent({ id, ...metadata, prompt }, fileName)
}

function scanAgentDirectory(agentsPath: string): AgentDirectoryScan {
  const directoryStats = lstatIfExists(agentsPath)
  if (!directoryStats) {
    return {
      agents: cloneAgents(DEFAULT_REGISTERED_AGENTS),
      managedFiles: new Map(),
    }
  }

  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`子 Agent 路径不是安全目录: ${agentsPath}`)
  }

  const agents: RegisteredAgent[] = []
  const managedFiles = new Map<string, string>()
  const entries = readdirSync(agentsPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue
    }
    const id = entry.name.slice(0, -3)
    if (!isSafeAgentId(id)) {
      continue
    }

    const filePath = join(agentsPath, entry.name)
    agents.push(parseAgentMarkdown(filePath, id, entry.name))
    managedFiles.set(id, filePath)
  }

  if (agents.length > MAX_AGENT_COUNT) {
    throw new Error(`agents 目录最多允许 ${MAX_AGENT_COUNT} 个 Agent`)
  }
  return { agents, managedFiles }
}

function quoteFrontmatterString(value: string): string {
  return JSON.stringify(value)
}

function serializeAgentMarkdown(agent: RegisteredAgent): string {
  const lines = [
    '---',
    `name: ${quoteFrontmatterString(agent.name)}`,
    `description: ${quoteFrontmatterString(agent.description)}`,
    `enabled: ${String(agent.enabled)}`,
  ]
  if (agent.role !== undefined) {
    lines.push(`role: ${quoteFrontmatterString(agent.role)}`)
  }
  if (agent.modelId !== undefined) {
    lines.push(`modelId: ${quoteFrontmatterString(agent.modelId)}`)
  }
  if (agent.permissionMode !== undefined) {
    lines.push(`permissionMode: ${quoteFrontmatterString(agent.permissionMode)}`)
  }
  if (agent.effortLevel !== undefined) {
    lines.push(`effortLevel: ${quoteFrontmatterString(agent.effortLevel)}`)
  }
  for (const [key, values] of [
    ['tools', agent.tools],
    ['disallowedTools', agent.disallowedTools],
  ] as const) {
    if (values === undefined) continue
    lines.push(`${key}:`)
    for (const value of values) {
      lines.push(`  - ${quoteFrontmatterString(value)}`)
    }
  }
  if (agent.maxTurns !== undefined) {
    lines.push(`maxTurns: ${agent.maxTurns}`)
  }
  lines.push('---', agent.prompt)
  const markdown = lines.join('\n')
  assertUtf8ByteLength(
    markdown,
    `${agent.id}.md`,
    MAX_AGENT_FILE_BYTES,
  )
  return markdown
}

function readInstructionsFile(instructionsPath: string): string {
  const stats = lstatIfExists(instructionsPath)
  if (!stats) {
    return ''
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`全局规则路径不是普通文件: ${instructionsPath}`)
  }
  const content = readUtf8FileWithLimit(
    instructionsPath,
    MAX_GLOBAL_INSTRUCTIONS_BYTES,
    INSTRUCTIONS_FILE_NAME,
  )
  if (content.includes('\0')) {
    throw new Error('AGENTS.md 包含无效空字符')
  }
  return content
}

function writeTextAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  let fileDescriptor: number | undefined
  try {
    fileDescriptor = openSync(tempPath, 'wx', 0o600)
    writeFileSync(fileDescriptor, content, 'utf-8')
    closeSync(fileDescriptor)
    fileDescriptor = undefined
    renameSync(tempPath, filePath)
  } catch (error) {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor)
    }
    try {
      unlinkSync(tempPath)
    } catch {
      // 临时文件可能尚未创建或已完成重命名。
    }
    throw error
  }
}

function assertWritableAgentTarget(filePath: string, id: string): void {
  const stats = lstatIfExists(filePath)
  if (!stats) return
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`不能覆盖非普通子 Agent 文件: ${id}.md`)
  }
}

function ensureDefaultAgentFiles(agentsPath: string): void {
  const directoryStats = lstatIfExists(agentsPath)
  if (directoryStats) {
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error(`子 Agent 路径不是安全目录: ${agentsPath}`)
    }
    return
  }

  mkdirSync(agentsPath, { recursive: true })
  for (const agent of DEFAULT_REGISTERED_AGENTS) {
    writeTextAtomic(
      join(agentsPath, `${agent.id}.md`),
      serializeAgentMarkdown(agent),
    )
  }
}

export function createAgentRegistrationService(
  configDir: string,
): AgentRegistrationService {
  const agentsPath = join(configDir, AGENTS_DIRECTORY_NAME)
  const instructionsPath = join(configDir, INSTRUCTIONS_FILE_NAME)

  function getAgentRegistrationConfig(): AgentRegistrationConfig {
    ensureDefaultAgentFiles(agentsPath)
    return {
      agents: scanAgentDirectory(agentsPath).agents,
      globalInstructions: readInstructionsFile(instructionsPath),
      agentsPath,
      instructionsPath,
    }
  }

  function saveAgentRegistrationConfig(
    input: AgentRegistrationUpdate,
  ): AgentRegistrationConfig {
    const validated = validateUpdate(input)

    // 任一受管文件损坏时拒绝覆盖或删除，未知文件与链接不会进入 managedFiles。
    const existing = scanAgentDirectory(agentsPath)
    if (lstatIfExists(instructionsPath)) {
      readInstructionsFile(instructionsPath)
    }

    mkdirSync(agentsPath, { recursive: true })
    const pendingWrites = validated.agents.map((agent) => {
      const filePath = join(agentsPath, `${agent.id}.md`)
      assertWritableAgentTarget(filePath, agent.id)
      return {
        filePath,
        markdown: serializeAgentMarkdown(agent),
      }
    })

    for (const pendingWrite of pendingWrites) {
      writeTextAtomic(pendingWrite.filePath, pendingWrite.markdown)
    }

    const nextIds = new Set(validated.agents.map((agent) => agent.id))
    for (const [id, filePath] of existing.managedFiles) {
      if (!nextIds.has(id)) {
        unlinkSync(filePath)
      }
    }

    writeTextAtomic(instructionsPath, validated.globalInstructions)
    return getAgentRegistrationConfig()
  }

  function listRegisteredAgents(): RegisteredAgent[] {
    ensureDefaultAgentFiles(agentsPath)
    return scanAgentDirectory(agentsPath).agents.filter((agent) => agent.enabled)
  }

  function getRegisteredAgent(id: string): RegisteredAgent {
    validateAgentId(id, 'id')
    ensureDefaultAgentFiles(agentsPath)
    const agent = scanAgentDirectory(agentsPath).agents
      .find((candidate) => candidate.id === id)
    if (!agent || !agent.enabled) {
      throw new Error(`子 Agent 不存在或已禁用: ${id}`)
    }
    return agent
  }

  function getGlobalAgentInstructions(): string {
    return readInstructionsFile(instructionsPath)
  }

  return {
    getAgentRegistrationConfig,
    saveAgentRegistrationConfig,
    listRegisteredAgents,
    getRegisteredAgent,
    getGlobalAgentInstructions,
  }
}

function createDefaultService(): AgentRegistrationService {
  return createAgentRegistrationService(getConfigDir())
}

export function getAgentRegistrationConfig(): AgentRegistrationConfig {
  return createDefaultService().getAgentRegistrationConfig()
}

export function saveAgentRegistrationConfig(
  input: AgentRegistrationUpdate,
): AgentRegistrationConfig {
  return createDefaultService().saveAgentRegistrationConfig(input)
}

export function listRegisteredAgents(): RegisteredAgent[] {
  return createDefaultService().listRegisteredAgents()
}

export function getRegisteredAgent(id: string): RegisteredAgent {
  return createDefaultService().getRegisteredAgent(id)
}

export function getGlobalAgentInstructions(): string {
  return createDefaultService().getGlobalAgentInstructions()
}
