/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import {
  DEFAULT_INTERFACE_VARIANT,
  normalizeThemeSelection,
} from '../../types'
import type { AppSettings } from '../../types'

interface LegacySettingsFields {
  experimentalAgentRuntimeSwitchEnabled?: boolean
  agentEffort?: unknown
  appIconVariant?: unknown
}

function createDefaultSettings(): AppSettings {
  return {
    ...normalizeThemeSelection(undefined, undefined),
    interfaceVariant: DEFAULT_INTERFACE_VARIANT,
    onboardingCompleted: false,
    environmentCheckSkipped: false,
    notificationsEnabled: true,
    longTextPasteAsAttachmentEnabled: false,
    richTextRenderingEnabled: false,
    feishuSessionMirror: { mode: 'off' },
    builtinMcpDisabledIds: [],
    windowsShellPreference: 'auto',
    agentThinking: { type: 'adaptive' },
    gitAttributionEnabled: true,
  }
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function persistSettingsMigration(
  filePath: string,
  data: Record<string, unknown>,
  themeMode: AppSettings['themeMode'],
  themeStyle: NonNullable<AppSettings['themeStyle']>
): void {
  if (data.themeMode === themeMode && data.themeStyle === themeStyle && !('appIconVariant' in data)) {
    return
  }

  try {
    const { appIconVariant: _legacyIcon, ...settings } = data
    writeFileSync(filePath, JSON.stringify({
      ...settings,
      themeMode,
      themeStyle,
    }, null, 2), 'utf-8')
    console.log(`[设置] 已迁移配置: ${themeMode}/${themeStyle}`)
  } catch (error) {
    // 迁移落盘失败不应阻塞启动；当前进程仍使用规范化后的安全值。
    console.error('[设置] 配置迁移写入失败:', error)
  }
}

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return createDefaultSettings()
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!isSettingsRecord(parsed)) {
      throw new Error('设置文件内容不是对象')
    }
    const data = parsed as Record<string, unknown> & Partial<AppSettings> & LegacySettingsFields
    const themeSelection = normalizeThemeSelection(data.themeMode, data.themeStyle)
    persistSettingsMigration(
      filePath,
      data,
      themeSelection.themeMode,
      themeSelection.themeStyle
    )

    // 清理已移除的图标配色、旧 Runtime Selector 与独立 effort 设置。
    const {
      experimentalAgentRuntimeSwitchEnabled: _legacyRuntimeSwitch,
      agentEffort: _legacyAgentEffort,
      appIconVariant: _legacyIcon,
      ...settings
    } = data
    return {
      ...settings,
      ...themeSelection,
      interfaceVariant: data.interfaceVariant || DEFAULT_INTERFACE_VARIANT,
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      longTextPasteAsAttachmentEnabled: data.longTextPasteAsAttachmentEnabled ?? false,
      richTextRenderingEnabled: data.richTextRenderingEnabled ?? false,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      builtinMcpDisabledIds: settings.builtinMcpDisabledIds ?? [],
      windowsShellPreference: settings.windowsShellPreference ?? 'auto',
      agentThinking: settings.agentThinking ?? { type: 'adaptive' },
      // 缺省 true：老配置文件未写该字段时保持推广默认开启
      gitAttributionEnabled: settings.gitAttributionEnabled ?? true,
    }
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return createDefaultSettings()
  }
}

/**
 * 更新应用设置
 *
 * 合并更新字段并写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  // 旧客户端或导入数据也不能重新写入已移除的图标配色。
  const { appIconVariant: _legacyIcon, ...normalizedUpdates } = updates as Partial<AppSettings> & LegacySettingsFields

  if (updates.themeMode !== undefined || updates.themeStyle !== undefined) {
    const themeSelection = normalizeThemeSelection(
      updates.themeMode ?? current.themeMode,
      updates.themeStyle ?? current.themeStyle
    )
    normalizedUpdates.themeMode = themeSelection.themeMode
    normalizedUpdates.themeStyle = themeSelection.themeStyle
  }

  const updated: AppSettings = {
    ...current,
    ...normalizedUpdates,
  }
  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log('[设置] 已更新 keys:', Object.keys(normalizedUpdates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}
