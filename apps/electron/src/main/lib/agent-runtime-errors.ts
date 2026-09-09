import type { ErrorCode, TypedError } from '@proma/shared'
import {
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isThinkingSignatureError as matchesThinkingSignatureError,
} from '@proma/shared'
import { TRANSIENT_NETWORK_PATTERN, isMalformedResponseError } from './error-patterns'

const FRIENDLY_ERROR_MESSAGES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /not logged in|please run \/login/i,
    message: '请检查是否选择了正确的 Xcode 供应渠道和模型',
  },
  {
    pattern: /validation error/i,
    message: 'API 请求格式校验失败，请重试或开启新会话',
  },
]

const MAX_ERROR_MESSAGE_LENGTH = 5000

export function friendlyErrorMessage(raw: string): string {
  const isLong = raw.length > MAX_ERROR_MESSAGE_LENGTH
  const sample = isLong ? raw.slice(0, MAX_ERROR_MESSAGE_LENGTH) : raw
  for (const { pattern, message } of FRIENDLY_ERROR_MESSAGES) {
    if (pattern.test(sample)) return message
  }
  return isLong
    ? sample + `\n\n[错误详情过长 (${(raw.length / 1024).toFixed(0)}KB)，已截断]`
    : raw
}

const CONTINUABLE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'aborted_streaming',
  'aborted_tools',
  'tool_deferred',
  'hook_stopped',
  'stop_hook_prevented',
])

export function shouldKeepChannelOpen(terminalReason: string | undefined): boolean {
  return terminalReason != null && CONTINUABLE_TERMINAL_REASONS.has(terminalReason)
}

const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'prompt_too_long',
  'input is too long',
  'context_length_exceeded',
  'maximum context length',
  'token limit',
  'exceeds the model',
] as const

export function isPromptTooLongError(...messages: string[]): boolean {
  const combined = messages.join(' ').toLowerCase()
  return PROMPT_TOO_LONG_PATTERNS.some((pattern) => combined.includes(pattern))
}

export function isThinkingSignatureError(...messages: string[]): boolean {
  return matchesThinkingSignatureError(...messages)
}

function extractHttpStatusFromErrorText(...messages: string[]): number | null {
  const combined = messages.filter(Boolean).join('\n')
  const patterns = [
    /API Error:\s*(\d{3})/i,
    /API error[^:]*:\s+(\d{3})/i,
    /\b(?:HTTP|status|statusCode|status[_ ]?code)\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+\{[^}]*"error"/is,
  ]

  for (const pattern of patterns) {
    const match = combined.match(pattern)
    const statusCode = match?.[1] ? parseInt(match[1], 10) : Number.NaN
    if (statusCode >= 400 && statusCode < 600) return statusCode
  }

  return null
}

/**
 * 从 Runtime/API 文本中提取真正的上游错误。
 *
 * 不同版本的 CCB 可能分别返回：
 * - `API Error: 400 {"error":{"message":"..."}}`
 * - `status_code=400, ...`
 * - 已经被网关展开的普通文本。
 * 统一处理后，用户在会话里能看到具体原因，而不是只有泛化的执行失败。
 */
function parseProviderErrorText(text: string): string {
  const normalized = text.trim()
  if (!normalized) return '未知错误'

  const jsonStart = normalized.indexOf('{')
  const jsonEnd = normalized.lastIndexOf('}')
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const payload = JSON.parse(normalized.slice(jsonStart, jsonEnd + 1)) as {
        error?: { message?: unknown }
        message?: unknown
      }
      if (typeof payload.error?.message === 'string' && payload.error.message.trim()) {
        return payload.error.message.trim()
      }
      if (typeof payload.message === 'string' && payload.message.trim()) {
        return payload.message.trim()
      }
    } catch {
      // 响应体不是完整 JSON 时，继续使用下方的文本规则。
    }
  }

  const statusCodeMessage = normalized.match(
    /\bstatus[_ ]?code\s*[:=]\s*\d{3}\s*[,：:\-]?\s*(.+)$/is,
  )
  if (statusCodeMessage?.[1]?.trim()) return statusCodeMessage[1].trim()

  return normalized
}

export function mapSDKErrorToTypedError(
  errorCode: string,
  detailedMessage: string,
  originalError: string,
): TypedError {
  if (isThinkingSignatureError(detailedMessage, originalError)) {
    return {
      code: 'thinking_signature_invalid',
      title: THINKING_SIGNATURE_ERROR_TITLE,
      message: THINKING_SIGNATURE_ERROR_MESSAGE,
      actions: [
        { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  const errorMap: Record<string, { code: ErrorCode; title: string; message: string; canRetry: boolean }> = {
    authentication_failed: {
      code: 'invalid_api_key',
      title: '认证失败',
      message: '无法通过 API 认证，API Key 可能无效或已过期',
      canRetry: true,
    },
    billing_error: {
      code: 'billing_error',
      title: '账单错误',
      message: '您的账户存在账单问题',
      canRetry: false,
    },
    model_not_found: {
      code: 'invalid_model',
      title: '模型不可用',
      message: '当前渠道无法使用所选模型，请检查模型名称或切换模型',
      canRetry: false,
    },
    invalid_request: {
      code: 'invalid_request',
      title: '请求无效',
      message: 'API 请求参数无效，请检查当前渠道与模型配置',
      canRetry: false,
    },
    rate_limit: {
      code: 'rate_limited',
      title: '请求频率限制',
      message: '请求过于频繁，请稍后再试',
      canRetry: true,
    },
    rate_limited: {
      code: 'rate_limited',
      title: '请求频率限制',
      message: '请求过于频繁，请稍后再试',
      canRetry: true,
    },
    overloaded: {
      code: 'provider_error',
      title: '服务繁忙',
      message: 'API 服务当前过载，请稍后再试',
      canRetry: true,
    },
    provider_error: {
      code: 'provider_error',
      title: '服务繁忙',
      message: 'API 服务当前过载或暂时异常，请稍后再试',
      canRetry: true,
    },
    service_error: {
      code: 'service_error',
      title: '服务错误',
      message: 'API 服务暂时异常，请稍后再试',
      canRetry: true,
    },
    api_error: {
      code: 'service_error',
      title: '服务错误',
      message: 'API 服务暂时异常，请稍后再试',
      canRetry: true,
    },
    service_unavailable: {
      code: 'service_unavailable',
      title: '服务暂时不可用',
      message: 'API 服务暂时不可用，请稍后再试',
      canRetry: true,
    },
    server_error: {
      code: 'service_error',
      title: '服务错误',
      message: 'API 服务暂时异常，请稍后再试',
      canRetry: true,
    },
    prompt_too_long: {
      code: 'prompt_too_long',
      title: '上下文过长',
      message: '当前对话的上下文已超出模型限制，请压缩上下文或开启新会话',
      canRetry: false,
    },
  }

  const looksLikeNetwork = !errorMap[errorCode]
    && (TRANSIENT_NETWORK_PATTERN.test(detailedMessage) || TRANSIENT_NETWORK_PATTERN.test(originalError))
  if (looksLikeNetwork) {
    return {
      code: 'network_error',
      title: '网络异常',
      message: detailedMessage || '上游 API 连接中断',
      actions: [
        { key: 's', label: '设置', action: 'settings' },
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  if (!errorMap[errorCode] && isMalformedResponseError(detailedMessage, originalError)) {
    return {
      code: 'service_error',
      title: '响应解析失败',
      message: '上游返回了无法解析的响应，通常为网关瞬时异常，正在重试',
      actions: [
        { key: 's', label: '设置', action: 'settings' },
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  const httpStatus = extractHttpStatusFromErrorText(detailedMessage, originalError)
  // 4xx（除认证类状态码外）是请求协议/参数或模型配置问题，不应进入自动重试。
  // 例如 OpenAI 兼容网关返回的：
  // `status_code=400, Input required: specify "prompt" or "messages"`。
  if (httpStatus != null && httpStatus >= 400 && httpStatus < 500) {
    const isAuthenticationError = httpStatus === 401 || httpStatus === 403
    return {
      code: isAuthenticationError ? 'invalid_api_key' : 'invalid_request',
      title: isAuthenticationError ? '认证失败' : '请求无效',
      message: detailedMessage || `API 请求被拒绝 (${httpStatus})`,
      actions: [
        {
          key: isAuthenticationError ? 's' : 'm',
          label: isAuthenticationError ? '打开渠道设置' : '重新选择模型',
          action: isAuthenticationError ? 'settings' : 'select_model',
        },
      ],
      canRetry: false,
      originalError,
    }
  }

  if (httpStatus != null && (httpStatus === 429 || httpStatus >= 500)) {
    const isRateLimited = httpStatus === 429
    const isUnavailable = httpStatus === 503
    const isOverloaded = httpStatus === 529
    const isBadGateway = httpStatus === 502
    return {
      code: isRateLimited
        ? 'rate_limited'
        : (isOverloaded ? 'provider_error' : (isUnavailable ? 'service_unavailable' : 'service_error')),
      title: isRateLimited
        ? '请求频率限制'
        : (isOverloaded ? '服务繁忙' : (isUnavailable ? '服务暂时不可用' : (isBadGateway ? '网关异常' : '服务错误'))),
      message: detailedMessage || (
        isRateLimited
          ? '请求过于频繁，请稍后再试'
          : isOverloaded
            ? 'API 服务当前过载 (529)，通常很快恢复'
            : isBadGateway
              ? 'API 网关暂时异常 (502)，通常很快恢复'
              : `API 服务暂时异常 (${httpStatus})，请稍后再试`
      ),
      actions: [
        { key: 's', label: '设置', action: 'settings' },
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  const mapped = errorMap[errorCode] ?? {
    code: 'unknown_error' as ErrorCode,
    title: '',
    message: detailedMessage || errorCode,
    canRetry: false,
  }
  const isInvalidChannelOrModel = /请检查是否选择了正确的 Xcode 供应渠道和模型/.test(mapped.message)

  return {
    code: mapped.code,
    title: mapped.title,
    message: detailedMessage || mapped.message,
    actions: [
      isInvalidChannelOrModel
        ? { key: 'm', label: '重新选择模型', action: 'select_model' }
        : { key: 's', label: '设置', action: 'settings' },
      ...(mapped.canRetry ? [{ key: 'r', label: '重试', action: 'retry' }] : []),
      ...(mapped.code === 'prompt_too_long' ? [{ key: 'c', label: '压缩上下文', action: 'compact' }] : []),
    ],
    canRetry: mapped.canRetry,
    retryDelayMs: mapped.canRetry ? 1000 : undefined,
    originalError,
  }
}

export function extractErrorDetails(msg: {
  error?: { message: string }
  message?: { content?: Array<Record<string, unknown>> }
}): { detailedMessage: string; originalError: string } {
  let originalError = msg.error?.message ?? '未知错误'
  let detailedMessage = parseProviderErrorText(originalError)

  try {
    const content = msg.message?.content
    if (Array.isArray(content) && content.length > 0) {
      const textBlock = content.find((block) => block.type === 'text')
      if (textBlock && 'text' in textBlock && typeof textBlock.text === 'string') {
        const fullText = textBlock.text
        originalError = fullText
        detailedMessage = parseProviderErrorText(fullText)
      }
    }
  } catch {
    // 提取失败时保留原始错误字段。
  }

  return { detailedMessage, originalError }
}
