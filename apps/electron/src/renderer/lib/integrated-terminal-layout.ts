const MIN_TERMINAL_LAYOUT_SIZE = 20

export interface IntegratedTerminalLayoutAction {
  shouldFit: boolean
  shouldFocus: boolean
}

/**
 * 协调终端首次可见与后续尺寸变化：
 * - 容器尺寸无效时不执行 fit；
 * - 首次获得有效尺寸时聚焦一次，避免等待 Shell 输出回放后才能输入；
 * - 后续 resize 只 fit，不抢夺用户焦点。
 */
export class IntegratedTerminalLayoutCoordinator {
  private hasFocused = false

  update(width: number, height: number): IntegratedTerminalLayoutAction {
    if (
      !Number.isFinite(width)
      || !Number.isFinite(height)
      || width < MIN_TERMINAL_LAYOUT_SIZE
      || height < MIN_TERMINAL_LAYOUT_SIZE
    ) {
      return { shouldFit: false, shouldFocus: false }
    }

    const shouldFocus = !this.hasFocused
    this.hasFocused = true
    return { shouldFit: true, shouldFocus }
  }
}
