import { describe, expect, test } from 'bun:test';
import { piCompactionSettings } from './pi-compaction-settings.mjs';

describe('Pi 上下文窗口与压缩预算', () => {
  test('Given 小窗口 When 使用默认阈值 Then 近期保留预算低于触发阈值而非固定 20k', () => {
    expect(piCompactionSettings(8_000)).toEqual({
      enabled: true, reserveTokens: 1_600, keepRecentTokens: 3_200,
    });
  });

  test('Given 自定义较低阈值 When 创建 session Then 同步缩小近期保留预算', () => {
    expect(piCompactionSettings(32_000, { threshold: 4_000 })).toEqual({
      enabled: true, reserveTokens: 28_000, keepRecentTokens: 2_000,
    });
  });

  test('Given 常规大窗口 When 创建 session Then 保留 Pi 的近期 20k 预算', () => {
    expect(piCompactionSettings(128_000, { threshold: 102_400, enabled: false })).toEqual({
      enabled: false, reserveTokens: 25_600, keepRecentTokens: 20_000,
    });
  });

  test('Given 阈值不低于窗口 When 创建 session Then 摘要预算不会变成零', () => {
    expect(piCompactionSettings(8_000, { threshold: 8_000 }).reserveTokens).toBe(2);
  });
});
