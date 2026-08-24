import { describe, expect, test } from 'bun:test';
import { normalizePiCompactionEvent } from './pi-compaction-event.mjs';

describe('Pi 原生压缩事件映射', () => {
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

  test('Given 压缩中止 When Pi 返回 errorMessage Then 转换为失败事件', () => {
    expect(normalizePiCompactionEvent({
      type: 'compaction_end',
      reason: 'manual',
      aborted: true,
      errorMessage: '用户已取消',
    })).toEqual({
      type: 'context.compaction.failed',
      payload: {
        trigger: 'manual',
        error: '用户已取消',
        originalContextPreserved: true,
      },
    });
  });
});
