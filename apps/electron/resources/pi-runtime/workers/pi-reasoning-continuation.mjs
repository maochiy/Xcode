export const MAX_REASONING_ONLY_CONTINUATIONS = 2;

export const REASONING_ONLY_CONTINUATION_PROMPT = [
  '<proma_internal_continuation>',
  '当前回复只有推理过程，尚未生成面向用户的最终正文。',
  '请继续完成当前任务，只输出最终正文；不要复述、总结或泄露隐藏推理。',
  '</proma_internal_continuation>',
].join('\n');

/**
 * reasoning-only 并不等于空响应：部分兼容模型会先以一条 assistant
 * 结束推理，再由后续轮次生成正文。这里只决定是否需要内部续写，
 * 不把隐藏推理降级成用户可见正文。
 */
export function reasoningOnlyContinuationDecision({
  output,
  reasoning,
  stopReason,
  attempts,
}) {
  if (String(output || '').trim() || !String(reasoning || '').trim() || stopReason !== 'stop') {
    return { action: 'complete' };
  }
  if (attempts < MAX_REASONING_ONLY_CONTINUATIONS) {
    return { action: 'continue' };
  }
  return {
    action: 'fail',
    code: 'PI_REASONING_ONLY_RESPONSE',
    error: '模型已完成推理，但未生成最终正文，请重试。',
  };
}
