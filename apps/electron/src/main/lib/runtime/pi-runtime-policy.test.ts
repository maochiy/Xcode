import { describe, expect, test } from 'bun:test'
import {
  EXECUTABLE_RUNTIME_ID,
  isExecutableRuntimeId,
  normalizeExecutableRuntimeId,
} from './pi-runtime-policy'

describe('Pi-only Runtime 执行策略', () => {
  test('Given 历史 RuntimeId When 进入执行边界 Then 全部迁移为 Pi', () => {
    expect(['pi', 'hermes', 'codex', 'claude', undefined].map(normalizeExecutableRuntimeId))
      .toEqual(['pi', 'pi', 'pi', 'pi', 'pi'])
  })

  test('Given Runtime 注册标识 When 判断是否可执行 Then 仅 Pi 可执行', () => {
    expect(EXECUTABLE_RUNTIME_ID).toBe('pi')
    expect(isExecutableRuntimeId('pi')).toBe(true)
    expect(isExecutableRuntimeId('hermes')).toBe(false)
    expect(isExecutableRuntimeId('codex')).toBe(false)
    expect(isExecutableRuntimeId('claude')).toBe(false)
  })
})
