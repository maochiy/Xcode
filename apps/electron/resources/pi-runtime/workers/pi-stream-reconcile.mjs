/**
 * 根据已经转发给宿主的内容与 Pi 最终事件快照，计算可安全追加的缺失后缀。
 *
 * 最终快照与已流内容不一致时不做猜测性拼接，由宿主 Adapter 用最终快照覆盖 partial。
 */
export function missingStreamSuffix(streamed, complete) {
  const current = String(streamed || '');
  const full = String(complete || '');
  if (!full) return { delta: '', consistent: true };
  if (!current) return { delta: full, consistent: true };
  if (full.startsWith(current)) {
    return { delta: full.slice(current.length), consistent: true };
  }
  return { delta: '', consistent: false };
}

/** 累计同一 run 中多条 assistant 消息的终态快照（例如工具调用前后的两段回复）。 */
export function appendAssistantSnapshot(snapshot, message) {
  return {
    output: `${String(snapshot?.output || '')}${String(message?.output || '')}`,
    reasoning: `${String(snapshot?.reasoning || '')}${String(message?.reasoning || '')}`,
  };
}
