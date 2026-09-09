/**
 * Shared configuration for proma
 */

// Placeholder - will be expanded as needed
export const APP_NAME = 'Proma'

/** Xcode 当前与旧版配置目录名称。 */
export const CONFIG_DIRECTORY_NAMES = {
  production: 'xcodes',
  development: 'xcodes-dev',
  legacyProduction: '.proma',
  legacyDevelopment: '.proma-dev',
} as const

/** 根据运行模式返回当前配置目录名称。 */
export function getConfigDirectoryName(development: boolean): string {
  return development
    ? CONFIG_DIRECTORY_NAMES.development
    : CONFIG_DIRECTORY_NAMES.production
}

/** 根据运行模式返回旧版兼容配置目录名称。 */
export function getLegacyConfigDirectoryName(development: boolean): string {
  return development
    ? CONFIG_DIRECTORY_NAMES.legacyDevelopment
    : CONFIG_DIRECTORY_NAMES.legacyProduction
}

/** XCODE_DEV 为新名称，PROMA_DEV 继续兼容旧启动方式。 */
export function isDevelopmentConfigRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.XCODE_DEV === '1' || env.PROMA_DEV === '1'
}
