import type { PromaRuntimeApiMode, ProviderType } from '@proma/shared'

type RoutedPromaRuntimeApiMode = Exclude<PromaRuntimeApiMode, 'legacy-compat'>

const PROVIDER_API_MODES: Record<ProviderType, RoutedPromaRuntimeApiMode> = {
  anthropic: 'anthropic_messages',
  'anthropic-compatible': 'anthropic_messages',
  openai: 'openai_chat_completions',
  'openai-responses': 'openai_responses',
  deepseek: 'anthropic_messages',
  google: 'google_generative_language',
  'kimi-api': 'anthropic_messages',
  'kimi-coding': 'anthropic_messages',
  'opencode-go-openai': 'openai_chat_completions',
  zhipu: 'openai_chat_completions',
  'zhipu-coding': 'anthropic_messages',
  'zhipu-coding-team': 'anthropic_messages',
  'ark-coding-plan': 'anthropic_messages',
  minimax: 'anthropic_messages',
  doubao: 'openai_chat_completions',
  qwen: 'openai_chat_completions',
  'qwen-anthropic': 'anthropic_messages',
  'qwen-token-plan': 'anthropic_messages',
  xiaomi: 'anthropic_messages',
  'xiaomi-token-plan': 'anthropic_messages',
  'openai-codex': 'openai_responses_oauth',
  custom: 'openai_chat_completions',
}

export function isPromaProviderType(provider: string): provider is ProviderType {
  return Object.prototype.hasOwnProperty.call(PROVIDER_API_MODES, provider)
}

/**
 * 将 Proma 渠道类型映射为 Pi Runtime API 协议。
 *
 * 普通 OpenAI 兼容渠道使用 Chat Completions；只有用户明确选择
 * `openai-responses` 或 ChatGPT OAuth 时才使用 Responses 协议。
 */
export function resolvePromaRuntimeApiMode(provider: ProviderType): RoutedPromaRuntimeApiMode {
  return PROVIDER_API_MODES[provider]
}
