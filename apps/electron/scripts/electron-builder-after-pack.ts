import { ensurePackagedPromaCli } from './packaged-cli-guard'
import { ensurePackagedBundledRuntimes } from './packaged-runtime-guard'

interface ElectronBuilderAfterPackContext {
  appOutDir: string
  electronPlatformName: string
}

/**
 * 修复打包进 extraResources 的 proma CLI：
 * - macOS：纠正被 electron-builder 复制损坏的代码签名，避免 arm64 SIGKILL(137)
 * - 全平台：smoke test `session list`，失败则中断打包
 */
export function ensurePackagedCli(context: ElectronBuilderAfterPackContext): string {
  return ensurePackagedPromaCli(context.appOutDir, context.electronPlatformName)
}

/**
 * electron-builder afterPack 入口。
 * 任一校验失败应抛错，使打包失败而不是产出不可用的安装包。
 */
export default function afterPack(context: ElectronBuilderAfterPackContext): void {
  ensurePackagedCli(context)
  ensurePackagedBundledRuntimes(context.appOutDir, context.electronPlatformName)
}
