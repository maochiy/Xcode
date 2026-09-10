/**
 * GeneralSettings - 通用设置页
 *
 * 账号登录状态、通知、归档、输入偏好等通用配置。
 * 用户姓名与头像在「个人资料」页只读展示，本页不再编辑。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { LogOut, Server, Volume2 } from 'lucide-react'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from './primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { userProfileAtom } from '@/atoms/user-profile'
import { newApiAuthAtom } from '@/atoms/new-api-auth'
import {
  notificationsEnabledAtom,
  notificationSoundEnabledAtom,
  notificationSoundsAtom,
  updateNotificationsEnabled,
  updateNotificationSoundEnabled,
  updateNotificationSound,
  playNotificationSound,
  NOTIFICATION_SOUNDS,
  DEFAULT_NOTIFICATION_SOUNDS,
} from '@/atoms/notifications'
import {
  longTextPasteAsAttachmentEnabledAtom,
  richTextRenderingEnabledAtom,
  stickyUserMessageEnabledAtom,
  updateLongTextPasteAsAttachmentEnabled,
  updateRichTextRenderingEnabled,
  updateStickyUserMessageEnabled,
} from '@/atoms/ui-preferences'
import { Button } from '../ui/button'
import type { NotificationSoundId, NotificationSoundType, NotificationSoundSettings } from '@/types/settings'

export function GeneralSettings(): React.ReactElement {
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const [newApiAuth, setNewApiAuth] = useAtom(newApiAuthAtom)
  const [notificationsEnabled, setNotificationsEnabled] = useAtom(notificationsEnabledAtom)
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useAtom(notificationSoundEnabledAtom)
  const [notificationSounds, setNotificationSounds] = useAtom(notificationSoundsAtom)
  const [stickyUserMessageEnabled, setStickyUserMessageEnabled] = useAtom(stickyUserMessageEnabledAtom)
  const [longTextPasteAsAttachmentEnabled, setLongTextPasteAsAttachmentEnabled] = useAtom(longTextPasteAsAttachmentEnabledAtom)
  const [richTextRenderingEnabled, setRichTextRenderingEnabled] = useAtom(richTextRenderingEnabledAtom)
  const [archiveAfterDays, setArchiveAfterDays] = React.useState<number>(7)
  /** Git/PR 推广标识：默认开启 */
  const [gitAttributionEnabled, setGitAttributionEnabled] = React.useState(true)
  const [loggingOut, setLoggingOut] = React.useState(false)

  // 加载归档天数与 Git/PR 标识设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setArchiveAfterDays(settings.archiveAfterDays ?? 7)
      setGitAttributionEnabled(settings.gitAttributionEnabled ?? true)
    }).catch(console.error)
  }, [])

  /** 更新 Git/PR 推广标识开关 */
  const handleGitAttributionChange = async (checked: boolean): Promise<void> => {
    setGitAttributionEnabled(checked)
    try {
      await window.electronAPI.updateSettings({ gitAttributionEnabled: checked })
    } catch (error) {
      console.error('[通用设置] 更新 Git/PR 标识失败:', error)
      setGitAttributionEnabled(!checked)
    }
  }

  /** 更新归档天数 */
  const handleArchiveDaysChange = async (value: string): Promise<void> => {
    const days = parseInt(value, 10)
    setArchiveAfterDays(days)
    try {
      await window.electronAPI.updateSettings({ archiveAfterDays: days })
    } catch (error) {
      console.error('[通用设置] 更新归档天数失败:', error)
    }
  }

  /** 退出 New API 登录，并清理自动生成的渠道配置。 */
  const handleLogout = async (): Promise<void> => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      const auth = await window.electronAPI.logoutNewApi()
      const restoredProfile = await window.electronAPI.getUserProfile()
      setNewApiAuth(auth)
      setUserProfile(restoredProfile)
    } catch (error) {
      console.error('[通用设置] 退出 New API 登录失败:', error)
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="OpenSwitch 账号"
        description="管理当前 OpenSwitch 登录状态"
      >
        <SettingsCard>
          <div className="flex items-center gap-4 px-4 py-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Server className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-foreground">
                  {newApiAuth.authenticated ? '已连接 OpenSwitch' : '未登录'}
                </p>
                {newApiAuth.method && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    {newApiAuth.method === 'password' ? '账号登录' : 'API Key'}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {userProfile.userName}
              </p>
            </div>
            {newApiAuth.authenticated && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="shrink-0 text-destructive hover:text-destructive"
              >
                <LogOut className="mr-1.5 size-4" />
                {loggingOut ? '退出中...' : '退出登录'}
              </Button>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 通用设置 */}
      <SettingsSection
        title="通用设置"
        description="应用的基本配置"
      >
        <SettingsCard>
          <SettingsRow
            label="语言"
            description="更多语言支持即将推出"
          >
            <span className="text-[13px] text-foreground/40">简体中文</span>
          </SettingsRow>
          <SettingsToggle
            label="桌面通知"
            description="Agent 完成任务或需要操作时发送通知"
            checked={notificationsEnabled}
            onCheckedChange={(checked) => {
              setNotificationsEnabled(checked)
              updateNotificationsEnabled(checked)
            }}
          />
          <SettingsToggle
            label="通知提示音"
            description="阻塞操作（权限确认、问题回答、计划审批）触发时播放提示音"
            checked={notificationSoundEnabled}
            disabled={!notificationsEnabled}
            onCheckedChange={(checked) => {
              setNotificationSoundEnabled(checked)
              updateNotificationSoundEnabled(checked)
            }}
          />
          <SoundPicker
            label="任务完成音效"
            type="taskComplete"
            sounds={notificationSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
          />
          <SoundPicker
            label="权限审批音效"
            type="permissionRequest"
            sounds={notificationSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
          />
          <SoundPicker
            label="计划审批音效"
            type="exitPlanMode"
            sounds={notificationSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
          />
          <SettingsRow
            label="自动归档"
            description="超过指定天数未更新的对话将自动归档（置顶对话除外）"
          >
            <Select value={String(archiveAfterDays)} onValueChange={handleArchiveDaysChange}>
              <SelectTrigger className="w-[120px] h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">禁用</SelectItem>
                <SelectItem value="7">7 天</SelectItem>
                <SelectItem value="14">14 天</SelectItem>
                <SelectItem value="30">30 天</SelectItem>
                <SelectItem value="60">60 天</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsToggle
            label="消息悬浮置顶条"
            description="滚动浏览对话时，在顶部显示最近的用户消息摘要"
            checked={stickyUserMessageEnabled}
            onCheckedChange={(checked) => {
              setStickyUserMessageEnabled(checked)
              updateStickyUserMessageEnabled(checked)
            }}
          />
          <SettingsToggle
            label="长文本粘贴转附件"
            description="开启后，输入框粘贴超过 2000 字的文本会自动生成可预览编辑的附件"
            checked={longTextPasteAsAttachmentEnabled}
            onCheckedChange={(checked) => {
              setLongTextPasteAsAttachmentEnabled(checked)
              updateLongTextPasteAsAttachmentEnabled(checked)
            }}
          />
          <SettingsToggle
            label="输入框 Markdown 渲染"
            description="开启后，输入框中的 Markdown 语法（如 **粗体**、# 标题）会实时渲染为富文本；关闭后为纯文本模式，保留 @ 引用等功能"
            checked={richTextRenderingEnabled}
            onCheckedChange={(checked) => {
              setRichTextRenderingEnabled(checked)
              updateRichTextRenderingEnabled(checked)
            }}
          />
          <SettingsToggle
            label="Git/PR 标识"
            description="Agent 代你提交 commit 或创建 PR 时，附加 Made-with: Xcodes 与项目仓库链接，便于推广；可随时关闭"
            checked={gitAttributionEnabled}
            onCheckedChange={(checked) => {
              void handleGitAttributionChange(checked)
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

// ===== SoundPicker 内部组件 =====

interface SoundPickerProps {
  label: string
  type: NotificationSoundType
  sounds: NotificationSoundSettings
  disabled: boolean
  onSoundChange: (type: NotificationSoundType, soundId: NotificationSoundId) => void
}

/** 单个场景的通知音选择器（下拉 + 试听按钮） */
function SoundPicker({ label, type, sounds, disabled, onSoundChange }: SoundPickerProps): React.ReactElement {
  const currentId = sounds[type] ?? DEFAULT_NOTIFICATION_SOUNDS[type]

  return (
    <SettingsRow label={label}>
      <div className="flex items-center gap-1.5">
        <Select
          value={currentId}
          onValueChange={(value) => onSoundChange(type, value as NotificationSoundId)}
          disabled={disabled}
        >
          <SelectTrigger className="w-[130px] h-8 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NOTIFICATION_SOUNDS.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
            ))}
            <SelectItem value="none">无</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled || currentId === 'none'}
          onClick={() => { void playNotificationSound(currentId) }}
          title="试听"
        >
          <Volume2 size={14} />
        </Button>
      </div>
    </SettingsRow>
  )
}
