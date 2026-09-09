import { describe, expect, test } from 'bun:test'
import {
  INTEGRATED_TERMINAL_FOCUS_RETRY_DELAYS_MS,
  IntegratedTerminalLayoutCoordinator,
  isIntegratedTerminalFocused,
} from './integrated-terminal-layout'

function createHostWithTextarea(): { host: { contains(node: Node | null): boolean }; textarea: Node } {
  const textarea = {} as Node
  const host = {
    contains(node: Node | null): boolean {
      return node === textarea
    },
  }
  return { host, textarea }
}

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

  test('Given xterm helper textarea 已获得焦点 When 判断终端是否可输入 Then 识别为已聚焦', () => {
    const { host, textarea } = createHostWithTextarea()

    expect(isIntegratedTerminalFocused(host, textarea)).toBe(true)
    expect(isIntegratedTerminalFocused(host, {} as Node)).toBe(false)
    expect(isIntegratedTerminalFocused(null, textarea)).toBe(false)
  })

  test('Given 打开终端后还有布局收尾 When 安排聚焦重试 Then 覆盖 composer autofocus 和面板动画', () => {
    expect(INTEGRATED_TERMINAL_FOCUS_RETRY_DELAYS_MS).toEqual([0, 80, 160, 320])
    expect(INTEGRATED_TERMINAL_FOCUS_RETRY_DELAYS_MS.at(-1)).toBeGreaterThan(300)
  })
})
