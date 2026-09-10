/** 宿主目录、执行路由与 Worker 共用边界规则，避免 0%/100% 展示值与实际阈值不同。 */
export function resolvePiCompactionPolicy(contextWindow, compaction = {}) {
  const window = Number.isFinite(contextWindow) && contextWindow >= 4
    ? Math.floor(contextWindow)
    : 128_000;
  const configuredThreshold = Number(compaction.threshold);
  // 摘要输出预算是 reserveTokens 的比例，至少预留两个 token，避免被取整为零。
  const threshold = Math.min(window - 2, Math.max(1,
    Number.isFinite(configuredThreshold) && configuredThreshold > 0
      ? Math.floor(configuredThreshold)
      : Math.floor(window * 0.8),
  ));
  return { enabled: compaction.enabled !== false, contextWindow: window, threshold };
}

/** 保留 Pi 的压缩算法，只按实际窗口调整预算，避免小窗口仍保留 20k 历史。 */
export function piCompactionSettings(contextWindow, compaction = {}) {
  const policy = resolvePiCompactionPolicy(contextWindow, compaction);
  return {
    enabled: policy.enabled,
    reserveTokens: policy.contextWindow - policy.threshold,
    // 压缩后需要为摘要和下一轮输入留空间；大窗口保持 Pi 默认近期预算。
    keepRecentTokens: Math.min(20_000, Math.max(1, Math.floor(policy.threshold / 2))),
  };
}
