import type {
  AgentDelegationRole,
  AgentRegistrationUpdate,
  PromaPermissionMode,
  RegisteredAgent,
  ThinkingEffortLevel,
} from '@proma/shared'

export type AgentToolPolicy = 'inherit' | 'none' | 'custom'

export interface AgentRegistrationFormValue {
  id: string
  name: string
  description: string
  prompt: string
  enabled: boolean
  role: AgentDelegationRole | ''
  modelId: string
  permissionMode: PromaPermissionMode | ''
  effortLevel: ThinkingEffortLevel | ''
  toolPolicy: AgentToolPolicy
  toolsText: string
  disallowedToolsText: string
  maxTurns: string
}

export interface AgentRegistrationValidationResult {
  errors: Partial<Record<keyof AgentRegistrationFormValue, string>>
  agent?: RegisteredAgent
}

export const MAX_REGISTERED_AGENT_COUNT = 64
export const MAX_GLOBAL_AGENT_INSTRUCTIONS_UTF8_BYTES = 256 * 1024
export const MAX_AGENT_PROMPT_UTF8_BYTES = 64 * 1024

const MAX_AGENT_ID_LENGTH = 64
const MAX_AGENT_NAME_LENGTH = 100
const MAX_AGENT_DESCRIPTION_LENGTH = 2_000
const MAX_AGENT_MODEL_ID_LENGTH = 256
const MAX_AGENT_TOOL_COUNT = 128
const MAX_AGENT_TOOL_NAME_LENGTH = 256
const MAX_AGENT_TURNS = 1_000
const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const DANGEROUS_AGENT_IDS = new Set(['constructor', 'prototype'])
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/

function parseToolList(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ))
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function createEmptyAgentRegistrationForm(): AgentRegistrationFormValue {
  return {
    id: '',
    name: '',
    description: '',
    prompt: '',
    enabled: true,
    role: '',
    modelId: '',
    permissionMode: '',
    effortLevel: '',
    toolPolicy: 'inherit',
    toolsText: '',
    disallowedToolsText: '',
    maxTurns: '',
  }
}

export function registeredAgentToForm(agent: RegisteredAgent): AgentRegistrationFormValue {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    enabled: agent.enabled,
    role: agent.role ?? '',
    modelId: agent.modelId ?? '',
    permissionMode: agent.permissionMode ?? '',
    effortLevel: agent.effortLevel ?? '',
    toolPolicy: agent.tools === undefined
      ? 'inherit'
      : agent.tools.length === 0
        ? 'none'
        : 'custom',
    toolsText: agent.tools?.join('\n') ?? '',
    disallowedToolsText: agent.disallowedTools?.join('\n') ?? '',
    maxTurns: agent.maxTurns?.toString() ?? '',
  }
}

export function validateAgentRegistration(
  value: AgentRegistrationFormValue,
  existingAgents: readonly RegisteredAgent[],
  originalId?: string,
): AgentRegistrationValidationResult {
  const errors: AgentRegistrationValidationResult['errors'] = {}
  const id = value.id.trim()
  const name = value.name.trim()
  const description = value.description.trim()
  const prompt = value.prompt

  if (!name) errors.name = '请输入 Agent 名称'
  else if (name.length > MAX_AGENT_NAME_LENGTH) errors.name = `名称不能超过 ${MAX_AGENT_NAME_LENGTH} 个字符`
  else if (CONTROL_CHARACTER_PATTERN.test(name)) errors.name = '名称不能包含控制字符'
  if (!id) {
    errors.id = '请输入稳定 ID'
  } else if (id.length > MAX_AGENT_ID_LENGTH) {
    errors.id = `ID 不能超过 ${MAX_AGENT_ID_LENGTH} 个字符`
  } else if (!AGENT_ID_PATTERN.test(id)) {
    errors.id = 'ID 需以小写字母开头，连字符只能分隔非空的小写字母或数字片段'
  } else if (DANGEROUS_AGENT_IDS.has(id)) {
    errors.id = '该 ID 属于保留名称，请更换'
  } else if (existingAgents.some((agent) => agent.id === id && agent.id !== originalId)) {
    errors.id = '该 ID 已被其他 Agent 使用'
  }
  if (description.length > MAX_AGENT_DESCRIPTION_LENGTH) {
    errors.description = `说明不能超过 ${MAX_AGENT_DESCRIPTION_LENGTH} 个字符`
  }
  if (!prompt.trim()) errors.prompt = '请输入系统提示词'
  else if (utf8ByteLength(prompt) > MAX_AGENT_PROMPT_UTF8_BYTES) {
    errors.prompt = '系统提示词不能超过 64 KiB（按 UTF-8 字节计算）'
  }

  const modelId = value.modelId.trim()
  if (modelId.length > MAX_AGENT_MODEL_ID_LENGTH) {
    errors.modelId = `模型 ID 不能超过 ${MAX_AGENT_MODEL_ID_LENGTH} 个字符`
  } else if (modelId && CONTROL_CHARACTER_PATTERN.test(modelId)) {
    errors.modelId = '模型 ID 不能包含控制字符'
  }

  let maxTurns: number | undefined
  const maxTurnsText = value.maxTurns.trim()
  if (maxTurnsText) {
    maxTurns = Number(maxTurnsText)
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_AGENT_TURNS) {
      errors.maxTurns = `最大轮数必须是 1 到 ${MAX_AGENT_TURNS} 的整数`
    }
  }

  const tools = value.toolPolicy === 'inherit'
    ? undefined
    : value.toolPolicy === 'none'
      ? []
      : parseToolList(value.toolsText)
  if (value.toolPolicy === 'custom' && tools?.length === 0) {
    errors.toolsText = '请至少填写一个允许的工具，或选择“不允许任何工具”'
  }

  const disallowedTools = parseToolList(value.disallowedToolsText)
  if (tools && tools.length > MAX_AGENT_TOOL_COUNT) {
    errors.toolsText = `允许工具最多 ${MAX_AGENT_TOOL_COUNT} 项`
  } else if (tools?.some((tool) => tool.length > MAX_AGENT_TOOL_NAME_LENGTH)) {
    errors.toolsText = `工具名不能超过 ${MAX_AGENT_TOOL_NAME_LENGTH} 个字符`
  } else if (tools?.some((tool) => CONTROL_CHARACTER_PATTERN.test(tool))) {
    errors.toolsText = '工具名不能包含控制字符'
  }
  if (disallowedTools.length > MAX_AGENT_TOOL_COUNT) {
    errors.disallowedToolsText = `禁用工具最多 ${MAX_AGENT_TOOL_COUNT} 项`
  } else if (disallowedTools.some((tool) => tool.length > MAX_AGENT_TOOL_NAME_LENGTH)) {
    errors.disallowedToolsText = `工具名不能超过 ${MAX_AGENT_TOOL_NAME_LENGTH} 个字符`
  } else if (disallowedTools.some((tool) => CONTROL_CHARACTER_PATTERN.test(tool))) {
    errors.disallowedToolsText = '工具名不能包含控制字符'
  }
  const disallowed = new Set(disallowedTools)
  const conflict = tools?.find((tool) => disallowed.has(tool))
  if (conflict) {
    errors.disallowedToolsText = `工具「${conflict}」不能同时出现在允许和禁用列表`
  }

  if (Object.keys(errors).length > 0) return { errors }

  const agent: RegisteredAgent = {
    id,
    name,
    description,
    prompt,
    enabled: value.enabled,
    ...(value.role ? { role: value.role } : {}),
    ...(modelId ? { modelId } : {}),
    ...(value.permissionMode ? { permissionMode: value.permissionMode } : {}),
    ...(value.effortLevel ? { effortLevel: value.effortLevel } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  }

  return { errors, agent }
}

export function validateGlobalAgentInstructions(value: string): string | null {
  if (utf8ByteLength(value) > MAX_GLOBAL_AGENT_INSTRUCTIONS_UTF8_BYTES) {
    return '全局规则不能超过 256 KiB（按 UTF-8 字节计算）'
  }
  if (value.includes('\0')) return '全局规则不能包含空字符'
  return null
}

export function createAgentRegistrationUpdate(
  agents: readonly RegisteredAgent[],
  globalInstructions: string,
): AgentRegistrationUpdate {
  return {
    agents: agents.map((agent) => ({
      ...agent,
      ...(agent.tools ? { tools: [...agent.tools] } : {}),
      ...(agent.disallowedTools ? { disallowedTools: [...agent.disallowedTools] } : {}),
    })),
    globalInstructions,
  }
}
