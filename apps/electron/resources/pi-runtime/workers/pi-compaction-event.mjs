function finiteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function compactionTrigger(event) {
  if (event.reason === 'manual' || event.reason === 'threshold' || event.reason === 'overflow') {
    return event.reason;
  }
  return event.type === 'auto_compaction_start' || event.type === 'auto_compaction_end'
    ? 'threshold'
    : 'manual';
}

/**
 * 将 Pi AgentSessionEvent 的压缩协议归一化为 Proma Runtime 事件。
 * 新版 Pi 用 reason 区分手动/自动，并把 token 与摘要放在 compaction_end.result。
 */
export function normalizePiCompactionEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  const isStart = event.type === 'compaction_start' || event.type === 'auto_compaction_start';
  const isEnd = event.type === 'compaction_end' || event.type === 'auto_compaction_end';
  if (!isStart && !isEnd) return undefined;

  const trigger = compactionTrigger(event);
  if (isStart) {
    const tokensBefore = finiteNonNegativeNumber(event.tokensBefore)
      ?? finiteNonNegativeNumber(event.usage?.totalTokens);
    return {
      type: 'context.compaction.started',
      payload: {
        trigger,
        ...(tokensBefore != null ? { tokensBefore } : {}),
      },
    };
  }

  const result = event.result && typeof event.result === 'object' ? event.result : {};
  const tokensBefore = finiteNonNegativeNumber(result.tokensBefore)
    ?? finiteNonNegativeNumber(event.tokensBefore);
  const tokensAfterEstimate = finiteNonNegativeNumber(result.estimatedTokensAfter)
    ?? finiteNonNegativeNumber(event.tokensAfter)
    ?? finiteNonNegativeNumber(event.usage?.totalTokens);
  const summary = nonEmptyString(result.summary);
  const error = nonEmptyString(event.errorMessage) ?? nonEmptyString(event.error);
  const failed = event.aborted === true || error != null;

  return {
    type: failed ? 'context.compaction.failed' : 'context.compaction.completed',
    payload: {
      trigger,
      ...(tokensBefore != null ? { tokensBefore } : {}),
      ...(tokensAfterEstimate != null ? { tokensAfterEstimate } : {}),
      ...(summary != null ? { summary } : {}),
      ...(failed ? {
        error: error || '上下文压缩已中止。',
        originalContextPreserved: true,
      } : {}),
    },
  };
}
