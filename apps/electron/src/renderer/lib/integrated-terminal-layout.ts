const MIN_TERMINAL_LAYOUT_SIZE = 20
export const INTEGRATED_TERMINAL_FOCUS_RETRY_DELAYS_MS = [0, 80, 160, 320] as const

export interface IntegratedTerminalLayoutAction {
  shouldFit: boolean
  shouldFocus: boolean
}

export function isIntegratedTerminalFocused(
  host: { contains(node: Node | null): boolean } | null | undefined,
  active: Node | null = typeof document === 'undefined' ? null : document.activeElement,
): boolean {
  return Boolean(host && active && host.contains(active))
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
