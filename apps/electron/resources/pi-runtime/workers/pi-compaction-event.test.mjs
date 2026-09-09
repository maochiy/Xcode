import { describe, expect, test } from 'bun:test';
import { normalizePiCompactionEvent } from './pi-compaction-event.mjs';

describe('Pi 原生压缩事件映射', () => {
  test.each(['manual', 'threshold'])('Given %s 没有可压缩区间 When Pi 返回异常 Then 转成无需压缩而非失败', (reason) => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_end', reason, aborted: false,
      errorMessage: 'Compaction failed: Nothing to compact (session too small)',
    })).toEqual({
      type: 'context.compaction.completed',
      payload: {
        trigger: reason, noop: true,
        reason: '当前上下文较少，没有需要压缩的历史内容。',
        originalContextPreserved: true,
      },
    });
  });

  test('Given 模型摘要请求失败 When 归一化 Then 不得将真实错误标成无需压缩', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_end', reason: 'threshold', aborted: false,
      errorMessage: 'Auto-compaction failed: Summarization failed: HTTP 503',
    })).toMatchObject({
      type: 'context.compaction.failed',
      payload: { error: 'Auto-compaction failed: Summarization failed: HTTP 503' },
    });
  });

  test('Given 已有压缩边界 When 再次压缩 Then 使用中文无需压缩提示', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_end', reason: 'manual',
      errorMessage: 'Compaction failed: Already compacted',
    })).toMatchObject({
      type: 'context.compaction.completed',
      payload: { noop: true, reason: '上下文已经压缩，暂时没有新增的可压缩内容。' },
    });
  });
  test('Given threshold 自动压缩 When 开始压缩 Then 标记为自动触发', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_start',
      reason: 'threshold',
    })).toEqual({
      type: 'context.compaction.started',
      payload: {
        trigger: 'threshold',
      },
    });
  });

  test('Given overflow 自动压缩 When 开始压缩 Then 标记为自动触发', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_start',
      reason: 'overflow',
    })).toEqual({
      type: 'context.compaction.started',
      payload: {
        trigger: 'overflow',
      },
    });
  });

  test('Given manual 压缩 When 开始压缩 Then 保留手动触发', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_start',
      reason: 'manual',
    })).toEqual({
      type: 'context.compaction.started',
      payload: {
        trigger: 'manual',
      },
    });
  });

  test('Given 自动压缩完成 When Pi 返回 result Then 读取 token 与摘要字段', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      result: {
        summary: '已整理当前任务上下文。',
        tokensBefore: 174_228,
        estimatedTokensAfter: 43_000,
      },
    })).toEqual({
      type: 'context.compaction.completed',
      payload: {
        trigger: 'threshold',
        tokensBefore: 174_228,
        tokensAfterEstimate: 43_000,
        summary: '已整理当前任务上下文。',
      },
    });
  });

  test('Given 压缩中止 When Pi 返回 errorMessage Then 保留取消标记而非普通失败', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_end',
      reason: 'manual',
      aborted: true,
      errorMessage: '用户已取消',
    })).toEqual({
      type: 'context.compaction.failed',
      payload: {
        trigger: 'manual',
        aborted: true,
        error: '用户已取消',
        originalContextPreserved: true,
      },
    });
  });
});
