/**
 * 旧 CCB Desktop Runtime 外部进程入口已停用。
 *
 * 保留该错误工厂是为了让尚未迁移的兼容 API 明确失败，避免静默回退并再次
 * 启动 runtime-client utilityProcess。
 */
export function createLegacyCcbUnsupportedError(feature: string): Error {
  return new Error(`旧 CCB ${feature} 已停用；Xcode 仅支持 Pi Runtime`)
}
