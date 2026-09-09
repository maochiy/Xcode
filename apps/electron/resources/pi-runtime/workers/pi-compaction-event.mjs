function finiteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Pi 用异常表示没有可压缩区间；这不是模型失败，也不能写入压缩边界。 */
export function piCompactionNoopReason(error) {
  const message = String(error?.message ?? error ?? '')
    .replace(/^(?:Auto-compaction failed|Compaction failed):\s*/i, '')
    .trim();
  if (message === 'Nothing to compact (session too small)') {
    return '当前上下文较少，没有需要压缩的历史内容。';
  }
  if (message === 'Already compacted') {
    return '上下文已经压缩，暂时没有新增的可压缩内容。';
  }
  return undefined;
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
  const noopReason = event.aborted === true ? undefined : piCompactionNoopReason(error);
  if (noopReason) {
    return {
      type: 'context.compaction.completed',
      payload: { trigger, noop: true, reason: noopReason, originalContextPreserved: true },
    };
  }
  const failed = event.aborted === true || error != null;

  return {
    type: failed ? 'context.compaction.failed' : 'context.compaction.completed',
    payload: {
      trigger,
      ...(tokensBefore != null ? { tokensBefore } : {}),
      ...(tokensAfterEstimate != null ? { tokensAfterEstimate } : {}),
      ...(summary != null ? { summary } : {}),
      ...(failed ? {
        ...(event.aborted === true ? { aborted: true } : {}),
        error: error || '上下文压缩已中止。',
        originalContextPreserved: true,
      } : {}),
    },
  };
}
