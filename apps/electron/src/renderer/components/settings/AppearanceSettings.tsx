/**
 * AppearanceSettings - 外观设置页
 *
 * Cursor 主题选择 + 跟随系统。
 * 通过 Jotai atom 管理状态，持久化到 ~/.proma/settings.json。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
} from './primitives'
import {
  themeModeAtom,
  themeStyleAtom,
  interfaceVariantAtom,
  systemIsDarkAtom,
  updateThemeSelection,
  updateInterfaceVariant,
  applyThemeToDOM,
  applyInterfaceVariantToDOM,
} from '@/atoms/theme'
import {
  markdownFontSizeAtom,
  updateMarkdownFontSize,
} from '@/atoms/markdown-font-size'
import { previewModePreferenceAtom, type PreviewModePreference } from '@/atoms/preview-atoms'
import { CursorThemePicker } from './CursorThemePicker'
import type { InterfaceVariant, ThemeMode, ThemeStyle, MarkdownFontSize } from '../../../types'

/** 配色跟随方式；手动主题由下方卡片选择。 */
const THEME_OPTIONS = [
  { value: 'manual', label: '手动选择' },
  { value: 'system', label: '跟随系统' },
]

/** 界面风格选项 */
const INTERFACE_VARIANT_OPTIONS: { value: InterfaceVariant; label: string }[] = [
  { value: 'classic', label: '经典' },
  { value: 'modern', label: '现代' },
]

/** Markdown 字号选项 */
const MARKDOWN_FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

/** 预览默认展开方式 */
const PREVIEW_MODE_OPTIONS: { value: PreviewModePreference; label: string }[] = [
  { value: 'tab', label: '标签页' },
  { value: 'split', label: '侧边分屏' },
]

/** 根据平台返回缩放快捷键提示 */
const isMac = navigator.userAgent.includes('Mac')
const ZOOM_HINT = isMac
  ? '使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小'
  : '使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小'

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const [themeStyle, setThemeStyle] = useAtom(themeStyleAtom)
  const [interfaceVariant, setInterfaceVariant] = useAtom(interfaceVariantAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)
  const [previewModePref, setPreviewModePref] = useAtom(previewModePreferenceAtom)

  const [isSavingTheme, setIsSavingTheme] = React.useState(false)
  const selectedStyle: ThemeStyle = themeMode === 'special' && themeStyle !== 'default'
    ? themeStyle
    : (themeMode === 'dark' || (themeMode === 'system' && systemIsDark))
      ? 'cursor-dark'
      : 'cursor-light'

  /** 模式和配色一次持久化，避免其他窗口短暂收到不完整的主题。 */
  const handleThemeSelect = async (mode: ThemeMode, style: ThemeStyle): Promise<void> => {
    if (isSavingTheme) return
    setIsSavingTheme(true)
    setThemeMode(mode)
    setThemeStyle(style)
    applyThemeToDOM(mode, style, systemIsDark)
    try {
      await updateThemeSelection(mode, style)
    } catch {
      setThemeMode(themeMode)
      setThemeStyle(themeStyle)
      applyThemeToDOM(themeMode, themeStyle, systemIsDark)
      toast.error('主题保存失败，请重试')
    } finally {
      setIsSavingTheme(false)
    }
  }

  /** 切换界面风格 */
  const handleInterfaceVariantChange = React.useCallback((value: string) => {
    const variant = value as InterfaceVariant
    setInterfaceVariant(variant)
    updateInterfaceVariant(variant)
    applyInterfaceVariantToDOM(variant)
  }, [setInterfaceVariant])

  /** 切换 Markdown 字号 */
  const handleMarkdownFontSizeChange = React.useCallback((value: string) => {
    const size = value as MarkdownFontSize
    setMarkdownFontSize(size)
    updateMarkdownFontSize(size)
  }, [setMarkdownFontSize])

  return (
    <div className="space-y-6">
      <SettingsSection
        title="外观设置"
        description="自定义应用的视觉风格"
      >
        <SettingsCard>
          {/* 主题模式 - 最上面 */}
          <SettingsSegmentedControl
            label="主题模式"
            description="使用 Cursor 配色，或根据系统外观自动切换"
            value={themeMode === 'system' ? 'system' : 'manual'}
            disabled={isSavingTheme}
            onValueChange={(value) => void handleThemeSelect(
              value === 'system' ? 'system' : 'special',
              value === 'system' ? 'default' : selectedStyle,
            )}
            options={THEME_OPTIONS}
          />

          <SettingsSegmentedControl
            label="界面风格"
            description="经典风保留旧版视觉；现代风使用更小圆角、更清晰分割线达成更统一干净的质感"
            value={interfaceVariant}
            onValueChange={handleInterfaceVariantChange}
            options={INTERFACE_VARIANT_OPTIONS}
          />

          <CursorThemePicker
            selectedStyle={selectedStyle}
            disabled={isSavingTheme}
            onSelect={(style) => void handleThemeSelect('special', style)}
          />

          <SettingsRow
            label="界面缩放"
            description={ZOOM_HINT}
          />

          <SettingsSegmentedControl
            label="Markdown 字号"
            description="调整 AI 回复与 Markdown 编辑器的正文字号"
            value={markdownFontSize}
            onValueChange={handleMarkdownFontSizeChange}
            options={MARKDOWN_FONT_SIZE_OPTIONS}
          />

          <SettingsSegmentedControl
            label="Agent 预览展开方式"
            description="点击文件、工具结果「预览」按钮时的默认展开位置；拖拽预览 Tab 出标签栏可即时切换为侧边分屏"
            value={previewModePref}
            onValueChange={(v) => setPreviewModePref(v as PreviewModePreference)}
            options={PREVIEW_MODE_OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
