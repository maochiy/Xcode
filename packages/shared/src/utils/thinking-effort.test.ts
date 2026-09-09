import { describe, expect, test } from 'bun:test'
import { DEFAULT_THINKING_EFFORT_LEVELS } from '../types/agent'
import { normalizeConfiguredThinkingEffortLevels } from './thinking-effort'

describe('思考等级配置规范化', () => {
  test('Given 新配置未声明等级 When 规范化 Then 使用统一的四档顺序', () => {
    expect(DEFAULT_THINKING_EFFORT_LEVELS).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(normalizeConfiguredThinkingEffortLevels()).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  test('Given 旧配置混有 max、重复项和乱序 When 规范化 Then max 归并为 xhigh 并排序去重', () => {
    expect(normalizeConfiguredThinkingEffortLevels([
      'max',
      'medium',
      'xhigh',
      'low',
      'medium',
    ])).toEqual([
      'low',
      'medium',
      'xhigh',
    ])
  })

  test('Given 用户显式取消全部等级 When 规范化 Then 保留空子集而不补默认值', () => {
    expect(normalizeConfiguredThinkingEffortLevels([])).toEqual([])
  })

  test('Given 用户只启用部分等级 When 规范化 Then 保留子集语义并使用统一顺序', () => {
    expect(normalizeConfiguredThinkingEffortLevels([
      'high',
      'low',
      'high',
    ])).toEqual([
      'low',
      'high',
    ])
  })
})
