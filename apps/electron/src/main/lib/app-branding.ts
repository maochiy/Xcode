import { join } from 'node:path'

export const APP_DISPLAY_NAME = 'Xcode'

const LEGACY_PRODUCTION_USER_DATA_DIRECTORY = 'Proma'
const DEVELOPMENT_USER_DATA_DIRECTORY = '@proma/electron-dev'
const LEGACY_PRODUCTION_ENCRYPTION_NAME = 'Proma'
const DEVELOPMENT_ENCRYPTION_NAME = '@proma/electron'

interface AppBrandingHost {
  readonly isPackaged: boolean
  getPath(name: 'appData'): string
  once(event: 'ready', listener: () => void): void
  setName(name: string): void
  setPath(name: 'userData', path: string): void
}

/**
 * 保留改名前的 userData 与 safeStorage 身份，仅在 ready 后更新系统显示名称。
 *
 * Electron 会在 ready 前基于 app name 初始化 safeStorage。此时必须恢复旧名称，
 * 否则 macOS Keychain / Linux OSCrypt 会改用新的 service/account，导致历史密钥
 * 无法解密。ready 后再切换显示名称，不影响已经初始化的加密身份。
 */
export function configureAppBranding(app: AppBrandingHost): string {
  const userDataDirectory = app.isPackaged
    ? LEGACY_PRODUCTION_USER_DATA_DIRECTORY
    : DEVELOPMENT_USER_DATA_DIRECTORY
  const encryptionName = app.isPackaged
    ? LEGACY_PRODUCTION_ENCRYPTION_NAME
    : DEVELOPMENT_ENCRYPTION_NAME
  const userDataPath = join(app.getPath('appData'), userDataDirectory)

  app.setPath('userData', userDataPath)
  app.setName(encryptionName)
  app.once('ready', () => {
    app.setName(APP_DISPLAY_NAME)
  })

  return userDataPath
}
