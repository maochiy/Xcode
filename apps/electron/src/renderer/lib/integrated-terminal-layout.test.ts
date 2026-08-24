import { describe, expect, test } from 'bun:test'
import { IntegratedTerminalLayoutCoordinator } from './integrated-terminal-layout'

describe('集成终端布局协调器', () => {
  test('Given 终端容器首次打开时没有有效尺寸 When 面板展开为可见 Then 首次有效布局执行 fit 并聚焦', () => {
    const coordinator = new IntegratedTerminalLayoutCoordinator()

    expect(coordinator.update(0, 480)).toEqual({
      shouldFit: false,
      shouldFocus: false,
    })
    expect(coordinator.update(360, 480)).toEqual({
      shouldFit: true,
      shouldFocus: true,
    })
  })

  test('Given 终端已经在首次有效布局聚焦 When 面板继续调整尺寸 Then 只执行 fit 不重复抢焦点', () => {
    const coordinator = new IntegratedTerminalLayoutCoordinator()

    coordinator.update(360, 480)

    expect(coordinator.update(420, 480)).toEqual({
      shouldFit: true,
      shouldFocus: false,
    })
  })
})
