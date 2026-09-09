/**
 * electron-builder afterSign Hook。
 *
 * 正式签名完成后再次 smoke test proma CLI。
 * 若签名链路改坏了嵌套二进制，在 CI 打包阶段失败，而不是发布后 Agent 会话里 exit 137。
 *
 * 注意：此处不再 adhoc 重签——正式签名已完成，只能校验可执行性。
 */
import { smokeTestPromaCli, resolvePackagedCliPath } from './packaged-cli-guard'
import { existsSync } from 'node:fs'

interface ElectronBuilderAfterSignContext {
  appOutDir: string
  electronPlatformName: string
  packager: {
    appInfo: {
      productFilename: string
    }
  }
}

export function smokePackagedCliAfterSign(
  context: ElectronBuilderAfterSignContext,
): string {
  const cliPath = resolvePackagedCliPath(
    context.appOutDir,
    context.electronPlatformName,
    { productName: context.packager.appInfo.productFilename },
  )
  if (!existsSync(cliPath)) {
    throw new Error(`afterSign: 打包产物缺少 proma CLI: ${cliPath}`)
  }

  // macOS 正式签名后不应再 --force adhoc，只验证能跑
  smokeTestPromaCli(cliPath)
  console.log(`[proma CLI] afterSign smoke test 通过: ${cliPath}`)
  return cliPath
}

export default function afterSign(context: ElectronBuilderAfterSignContext): void {
  smokePackagedCliAfterSign(context)
}
