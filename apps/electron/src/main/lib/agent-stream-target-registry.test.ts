import { describe, expect, test } from 'bun:test'
import { AgentStreamTargetRegistry } from './agent-stream-target-registry'

interface FakeStreamTarget {
  name: string
}

describe('Agent 实时事件目标注册', () => {
  test('Given 新回合已覆盖同会话注册 When 旧回合收尾 Then 不删除新回合目标', () => {
    const registry = new AgentStreamTargetRegistry<FakeStreamTarget>()
    const oldTarget = { name: '旧回合窗口' }
    const newTarget = { name: '新回合窗口' }

    const oldRegistrationId = registry.register('session-1', oldTarget)
    registry.register('session-1', newTarget)

    expect(registry.deleteIfCurrent('session-1', oldRegistrationId)).toBe(false)
    expect(registry.get('session-1')).toBe(newTarget)
  })

  test('Given 当前回合结束且注册未被覆盖 When 清理 Then 删除当前目标', () => {
    const registry = new AgentStreamTargetRegistry<FakeStreamTarget>()
    const target = { name: '当前窗口' }

    const registrationId = registry.register('session-1', target)

    expect(registry.deleteIfCurrent('session-1', registrationId)).toBe(true)
    expect(registry.get('session-1')).toBeUndefined()
  })

  test('Given 窗口被销毁 When 按目标清理 Then 删除该窗口关联的全部会话', () => {
    const registry = new AgentStreamTargetRegistry<FakeStreamTarget>()
    const destroyedTarget = { name: '已销毁窗口' }
    const activeTarget = { name: '其他窗口' }
    registry.register('session-1', destroyedTarget)
    registry.register('session-2', destroyedTarget)
    registry.register('session-3', activeTarget)

    registry.deleteTarget(destroyedTarget)

    expect(registry.get('session-1')).toBeUndefined()
    expect(registry.get('session-2')).toBeUndefined()
    expect(registry.get('session-3')).toBe(activeTarget)
  })
})
