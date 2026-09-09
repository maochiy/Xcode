import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeModelInfo } from '@proma/shared'
import {
  findAgentRuntimeModel,
  getThinkingEffortSliderLevels,
  getThinkingEffortKeyIndex,
  snapThinkingEffortPosition,
  normalizeAgentThinkingEffortLevel,
  resolveAgentRuntimeThinkingSelection,
  resolveAgentThinkingEffortCapability,
} from './agent-thinking-effort'

function runtimeModel(
  overrides: Partial<AgentRuntimeModelInfo> = {},
): AgentRuntimeModelInfo {
  return {
    value: 'runtime-model',
    displayName: 'Runtime Model',
    description: 'CCB Runtime model',
    contextWindow: 200_000,
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
    defaultEffortLevel: 'medium',
    supportsAdaptiveThinking: false,
    supportsFastMode: false,
    supportsAutoMode: false,
    ...overrides,
  }
}

describe('Agent 模型思考等级能力', () => {
  test('Given 历史会话选择 max When 配置已迁移为四档 Then 继续选中极高而不是回落到默认档', () => {
    expect(normalizeAgentThinkingEffortLevel({
      levels: ['low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'medium',
    }, 'max')).toBe('xhigh')
  })
  test('Given 连续滑动位置 When 松开 Then 吸附最近等级且不越界', () => {
    expect(snapThinkingEffortPosition(1.49, 4)).toBe(1)
    expect(snapThinkingEffortPosition(1.5, 4)).toBe(2)
    expect(snapThinkingEffortPosition(-0.3, 4)).toBe(0)
    expect(snapThinkingEffortPosition(4.1, 4)).toBe(3)
    expect(snapThinkingEffortPosition(1, 1)).toBe(0)
  })

  test('Given 滑杆采用连续位置 When 键盘切换 Then 仍按整档移动并支持首尾', () => {
    expect(getThinkingEffortKeyIndex('ArrowRight', 1, 4)).toBe(2)
    expect(getThinkingEffortKeyIndex('ArrowLeft', 1, 4)).toBe(0)
    expect(getThinkingEffortKeyIndex('ArrowRight', 3, 4)).toBe(3)
    expect(getThinkingEffortKeyIndex('Home', 2, 4)).toBe(0)
    expect(getThinkingEffortKeyIndex('End', 1, 4)).toBe(3)
    expect(getThinkingEffortKeyIndex('Tab', 1, 4)).toBeUndefined()
  })

  test('Given 五个配置等级 When 展示输入框滑杆 Then 最高档合并为极高并保留当前 max', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
    expect(getThinkingEffortSliderLevels(levels, 'high')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(getThinkingEffortSliderLevels(levels, 'max')).toEqual(['low', 'medium', 'high', 'max'])
    expect(getThinkingEffortSliderLevels(['max'], 'max')).toEqual(['max'])
    expect(getThinkingEffortSliderLevels(['high', 'low'], 'high')).toEqual(['low', 'high'])
  })

  test('Given Runtime 声明支持 When 解析能力 Then 使用 Runtime 等级与默认值', () => {
    expect(resolveAgentThinkingEffortCapability(runtimeModel())).toEqual({
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'medium',
    })
  })

  test('Given Runtime 声明不支持 When 解析能力 Then 隐藏控件', () => {
    expect(resolveAgentThinkingEffortCapability(runtimeModel({
      supportsEffort: false,
      supportedEffortLevels: [],
      defaultEffortLevel: undefined,
    }))).toBeNull()
  })

  test('Given Runtime 返回显式子集 When 解析能力 Then 顺序和值完全一致', () => {
    expect(resolveAgentThinkingEffortCapability(runtimeModel({
      supportedEffortLevels: ['high', 'max'],
      defaultEffortLevel: 'max',
    }))).toEqual({
      levels: ['high', 'max'],
      defaultLevel: 'max',
    })
  })

  test('Given Runtime 默认值有效 When 当前值缺失 Then 使用 Runtime 默认值', () => {
    const capability = resolveAgentThinkingEffortCapability(runtimeModel({
      supportedEffortLevels: ['low', 'high'],
      defaultEffortLevel: 'high',
    }))
    expect(normalizeAgentThinkingEffortLevel(capability, undefined)).toBe('high')
  })

  test('Given 未知模型由 Runtime 声明支持 When 解析能力 Then 不依赖模型名', () => {
    expect(resolveAgentThinkingEffortCapability(runtimeModel({
      value: 'future-private-reasoner',
      supportedEffortLevels: ['xhigh'],
      defaultEffortLevel: 'xhigh',
    }))).toEqual({
      levels: ['xhigh'],
      defaultLevel: 'xhigh',
    })
  })

  test('Given Runtime 目录不可用 When 解析能力 Then 不猜测并隐藏控件', () => {
    expect(resolveAgentThinkingEffortCapability(undefined)).toBeNull()
  })

  test('Given CCB 规范化 1M 模型 ID When 查找模型 Then 回退匹配规范化 ID', () => {
    const model = runtimeModel({
      value: 'claude-sonnet-4-6',
      contextWindow: 1_000_000,
    })

    expect(findAgentRuntimeModel([model], 'claude-sonnet-4-6[1m]')).toBe(model)
  })

  test('Given Runtime 不支持 Adaptive Thinking When 构建本轮配置 Then 不透传全局 Thinking', () => {
    const model = runtimeModel({
      supportsAdaptiveThinking: false,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      defaultEffortLevel: 'high',
    })

    expect(resolveAgentRuntimeThinkingSelection(
      model,
      { type: 'adaptive' },
      'low',
    )).toEqual({
      thinkingConfig: undefined,
      effortLevel: 'low',
    })
  })

  test('Given Runtime 支持 Adaptive Thinking When 构建本轮配置 Then 透传 Thinking 与归一化 Effort', () => {
    const model = runtimeModel({
      supportsAdaptiveThinking: true,
      supportsEffort: true,
      supportedEffortLevels: ['medium', 'high'],
      defaultEffortLevel: 'medium',
    })

    expect(resolveAgentRuntimeThinkingSelection(
      model,
      { type: 'adaptive' },
      'max',
    )).toEqual({
      thinkingConfig: { type: 'adaptive' },
      effortLevel: 'medium',
    })
  })
})
