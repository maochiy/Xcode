import * as React from 'react'
import { useAtom, useStore } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { NewApiLoginView } from './components/auth/NewApiLoginView'
import { OnboardingView } from './components/onboarding/OnboardingView'
import { TutorialBanner } from './components/tutorial/TutorialBanner'
import { EnvironmentCheckDialog } from './components/environment/EnvironmentCheckDialog'
import { MigrationImportDialog } from './components/migration/MigrationImportDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { channelsAtom, conversationsAtom, selectedModelAtom } from './atoms/chat-atoms'
import {
  agentChannelIdAtom,
  agentChannelIdsAtom,
  agentModelIdAtom,
} from './atoms/agent-atoms'
import { environmentCheckDialogOpenAtom } from './atoms/environment'
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from './atoms/tab-atoms'
import { userProfileAtom } from './atoms/user-profile'
import { newApiAuthAtom } from './atoms/new-api-auth'
import type { AppShellContextType } from './contexts/AppShellContext'
import type { NewApiAuthState, NewApiLoginResult } from '../types'

export default function App(): React.ReactElement {
  // 应用级初始化状态。

  const store = useStore()
  const [newApiAuth, setNewApiAuth] = useAtom(newApiAuthAtom)
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)

  const applyAuthenticatedState = React.useCallback(async (
    auth: NewApiAuthState,
    activateGeneratedChannel = false,
  ): Promise<void> => {
    if (auth.profile) {
      store.set(userProfileAtom, auth.profile)
    }
    if (!auth.authenticated || !auth.channelId || !activateGeneratedChannel) {
      setNewApiAuth(auth)
      return
    }

    const channels = await window.electronAPI.listChannels()
    store.set(channelsAtom, channels)
    store.set(agentChannelIdAtom, auth.channelId)
    store.set(agentChannelIdsAtom, [auth.channelId])
    store.set(agentModelIdAtom, auth.defaultModelId ?? null)
    if (auth.defaultModelId) {
      store.set(selectedModelAtom, {
        channelId: auth.channelId,
        modelId: auth.defaultModelId,
      })
    }
    setNewApiAuth(auth)
  }, [setNewApiAuth, store])

  // 初始化：先检查 New API 登录状态，再决定是否显示 Onboarding
  // macOS/Linux 上 SDK 自带 claude native binary 不依赖宿主 Node/Git；
  // Windows 上仍需 Git Bash/WSL，由 Onboarding Step 2 与聊天错误卡片引导用户安装。
  React.useEffect(() => {
    const initialize = async () => {
      try {
        const [auth, settings] = await Promise.all([
          window.electronAPI.checkNewApiAuth(),
          window.electronAPI.getSettings(),
        ])
        await applyAuthenticatedState(auth, false)
        if (!settings.onboardingCompleted) {
          setShowOnboarding(true)
        }
      } catch (error) {
        console.error('[App] 初始化失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    initialize()
  }, [applyAuthenticatedState])

  const handleLoginSuccess = React.useCallback(async (result: NewApiLoginResult): Promise<void> => {
    await applyAuthenticatedState(result.auth, true)
  }, [applyAuthenticatedState])

  // 完成 onboarding 回调：创建欢迎对话，可选打开教程 Tab
  const handleOnboardingComplete = async (openTutorial?: boolean) => {
    setShowOnboarding(false)

    if (openTutorial) {
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Xcode 使用教程' })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      return
    }

    try {
      const meta = await window.electronAPI.createWelcomeConversation()
      if (meta) {
        const conversations = store.get(conversationsAtom)
        store.set(conversationsAtom, [meta, ...conversations])

        const tabs = store.get(tabsAtom)
        const result = openTab(tabs, {
          type: 'chat',
          sessionId: meta.id,
          title: meta.title,
        })
        store.set(tabsAtom, result.tabs)
        store.set(activeTabIdAtom, result.activeTabId)
      }
    } catch (error) {
      console.error('[App] 创建欢迎对话失败:', error)
    }
  }

  // 加载中状态
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">正在初始化...</p>
        </div>
      </div>
    )
  }

  // 未登录时只显示登录页，不进入 Onboarding 或主界面。
  if (!newApiAuth.authenticated) {
    return (
      <NewApiLoginView
        onLoginSuccess={handleLoginSuccess}
        initialMessage={newApiAuth.warning}
      />
    )
  }

  // 显示 onboarding 界面
  if (showOnboarding) {
    return (
      <TooltipProvider delayDuration={200}>
        <OnboardingView onComplete={handleOnboardingComplete} />
        <MigrationImportDialog />
      </TooltipProvider>
    )
  }

  // Placeholder context value
  const contextValue: AppShellContextType = {}

  // 显示主界面
  return (
    <TooltipProvider delayDuration={200}>
      <AppShell contextValue={contextValue} />
      <TutorialBanner />
      <GlobalEnvironmentCheckDialog />
      <MigrationImportDialog />
    </TooltipProvider>
  )
}

/**
 * 全局环境检测 Dialog，由错误卡片的 recovery action 按钮打开。
 */
function GlobalEnvironmentCheckDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(environmentCheckDialogOpenAtom)
  return <EnvironmentCheckDialog open={open} onOpenChange={setOpen} />
}
