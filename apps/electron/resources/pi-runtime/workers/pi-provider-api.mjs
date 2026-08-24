/** 将 Proma 模型中心协议转换为 pi-ai 的标准 API 标识。 */
export function providerApi(apiMode) {
  if (apiMode === 'anthropic_messages') return 'anthropic-messages';
  if (apiMode === 'google_generative_language') return 'google-generative-ai';
  if (apiMode === 'openai_responses' || apiMode === 'openai_responses_oauth') return 'openai-responses';
  if (apiMode === 'openai_chat_completions') return 'openai-completions';
  throw Object.assign(new Error(`Unsupported Pi model protocol: ${String(apiMode || 'missing')}`), {
    code: 'PI_MODEL_PROTOCOL_MISSING',
  });
}
