/**
 * SettingsPanel - 设置面板
 *
 * 顶部 Header（标题 + 关闭按钮）+ 下方（左侧导航 + 右侧 ScrollArea 内容区域）。
 * 使用 Jotai atom 管理当前标签页状态。
 */

import * as React from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { cn } from "@/lib/utils";
import {
  Settings,
  CircleUser,
  ArrowLeft,
  Radio,
  Palette,
  Info,
  Globe,
  BookOpen,
  Wrench,
  Bot,
  GraduationCap,
  Keyboard,
  Mic,
  HardDriveDownload,
  HardDrive,
  Archive,
  Search,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { settingsTabAtom, channelFormDirtyAtom, settingsCloseRequestedAtom, settingsOpenAtom } from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { activeViewAtom } from "@/atoms/active-view";
import { automationFormAtom } from "@/atoms/automation-atoms";
import { hasUpdateAtom } from "@/atoms/updater";
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from "@/atoms/tab-atoms";
import { hasEnvironmentIssuesAtom } from "@/atoms/environment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ProfileSettings } from "./ProfileSettings";
import { ProxySettings } from "./ProxySettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { PromptSettings } from "./PromptSettings";
import { ToolSettings } from "./ToolSettings";
import { BotHubSettings } from "./BotHubSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { MigrationSettings } from "./MigrationSettings";
import { StorageSettings } from "./StorageSettings";
import { ArchivedChatsSettings } from "./ArchivedChatsSettings";

/** 设置 Tab 定义 */
interface TabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

interface TabGroup {
  label: string;
  tabs: TabItem[];
}

/** 基础 Tabs（所有模式都有） */
const BASE_TABS: TabItem[] = [
  { id: "profile", label: "个人资料", icon: <CircleUser size={16} /> },
  { id: "general", label: "通用设置", icon: <Settings size={16} /> },
  { id: "appearance", label: "外观设置", icon: <Palette size={16} /> },
  { id: "channels", label: "模型配置", icon: <Radio size={16} /> },
  { id: "prompts", label: "提示词管理", icon: <BookOpen size={16} /> },
  { id: "proxy", label: "代理设置", icon: <Globe size={16} /> },
];

const TOOLS_TAB: TabItem = {
  id: "tools",
  label: "Chat 工具",
  icon: <Wrench size={16} />,
};
const BOTS_TAB: TabItem = {
  id: "bots",
  label: "远程连接",
  icon: <Bot size={16} />,
};
const TUTORIAL_TAB: TabItem = {
  id: "tutorial",
  label: "Xcode 教程",
  icon: <GraduationCap size={16} />,
};
const SHORTCUTS_TAB: TabItem = {
  id: "shortcuts",
  label: "快捷键管理",
  icon: <Keyboard size={16} />,
};
const VOICE_INPUT_TAB: TabItem = {
  id: "voice-input",
  label: "语音输入",
  icon: <Mic size={16} />,
};

/** 尾部 Tabs */
const TAIL_TABS: TabItem[] = [
  { id: "migration", label: "数据迁移", icon: <HardDriveDownload size={16} /> },
  { id: "storage", label: "磁盘管理", icon: <HardDrive size={16} /> },
  { id: "archived-chats", label: "已归档的聊天", icon: <Archive size={16} /> },
  { id: "about", label: "关于/更新", icon: <Info size={16} /> },
];

const TAB_GROUPS: TabGroup[] = [
  {
    label: "Xcode",
    tabs: BASE_TABS,
  },
  {
    label: "工作与交互",
    tabs: [
      TOOLS_TAB,
      VOICE_INPUT_TAB,
      BOTS_TAB,
      TUTORIAL_TAB,
      SHORTCUTS_TAB,
    ],
  },
  {
    label: "桌面应用",
    tabs: TAIL_TABS,
  },
];

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case "profile":
      return <ProfileSettings />;
    case "general":
      return <GeneralSettings />;
    case "channels":
      return <ChannelSettings />;
    case "prompts":
      return <PromptSettings />;
    case "proxy":
      return <ProxySettings />;
    case "tools":
      return <ToolSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "about":
      return <AboutSettings />;
    case "bots":
      return <BotHubSettings />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "voice-input":
      return <VoiceInputSettings />;
    case "migration":
      return <MigrationSettings />;
    case "storage":
      return <StorageSettings />;
    case "archived-chats":
      return <ArchivedChatsSettings />;
    default:
      // tutorial 等特殊 tab 由 handleTabChange 拦截打开主区 Tab，不会在此渲染
      return <GeneralSettings />;
  }
}

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const channelFormDirty = useAtomValue(channelFormDirtyAtom);
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setAutomationForm = useSetAtom(automationFormAtom);
  const hasUpdate = useAtomValue(hasUpdateAtom);
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom);
  const [mainTabs, setMainTabs] = useAtom(tabsAtom);
  const setMainActiveTabId = useSetAtom(activeTabIdAtom);
  const [searchQuery, setSearchQuery] = React.useState("");

  /** 统一的退出拦截对话框状态 */
  type PendingAction = { type: 'tab'; tabId: SettingsTab } | { type: 'close' } | null
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const showNavDialog = pendingAction !== null

  /** 执行待处理的操作 */
  const executePendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'tab') {
      setActiveTab(pendingAction.tabId)
    } else {
      onClose?.()
    }
    setPendingAction(null)
  }

  /** 取消待处理的操作 */
  const cancelPendingAction = (): void => {
    setPendingAction(null)
  }

  /** 切换标签页时检测是否有未保存内容，tutorial 特殊处理：打开 New Tab 并关闭设置 */
  const handleTabChange = (tabId: SettingsTab): void => {
    if (tabId === 'tutorial') {
      const result = openTab(mainTabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Xcode 使用教程' })
      setMainTabs(result.tabs)
      setMainActiveTabId(result.activeTabId)
      // Skills/Automations 会全屏覆盖 TabContent；打开教程时先清理表单并回到会话视图。
      setAutomationForm({ open: false, draft: null })
      setActiveView('conversations')
      setSettingsOpen(false)
      return
    }
    if (tabId === activeTab) return
    if (activeTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'tab', tabId })
      return
    }
    setActiveTab(tabId)
  }

  /** 关闭设置面板时检测是否有未保存内容 */
  const handleClose = (): void => {
    if (activeTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'close' })
      return
    }
    onClose?.()
  }

  // Cmd+W 等外部关闭请求：弹出确认对话框
  React.useEffect(() => {
    if (closeRequested && activeTab === 'channels') {
      setPendingAction({ type: 'close' })
      setCloseRequested(false)
    }
  }, [closeRequested, activeTab, setCloseRequested])

  const filteredGroups = React.useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return TAB_GROUPS;
    return TAB_GROUPS
      .map((group) => ({
        ...group,
        tabs: group.tabs.filter((tab) => tab.label.toLocaleLowerCase().includes(query)),
      }))
      .filter((group) => group.tabs.length > 0);
  }, [searchQuery]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <aside className="flex w-[212px] flex-shrink-0 flex-col bg-transparent">
        <div className="flex items-center px-2 pb-1 pt-[52px]">
          {onClose && (
            <button
              type="button"
              onClick={handleClose}
              className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <ArrowLeft size={15} />
              <span>返回对话</span>
            </button>
          )}
        </div>
        <div className="px-2 pb-2 pt-2">
          <div className="flex h-8 items-center gap-2 rounded-lg border border-border/55 bg-background/65 px-2.5 text-muted-foreground shadow-xs backdrop-blur-sm focus-within:border-foreground/20">
            <Search size={14} className="shrink-0" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="搜索设置"
              placeholder="搜索设置"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <nav aria-label="设置页面" className="space-y-4 px-2 pb-4 pt-1">
            {filteredGroups.map((group) => (
              <section key={group.label}>
                <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground/70">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      aria-current={activeTab === tab.id ? "page" : undefined}
                      onClick={() => handleTabChange(tab.id)}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
                        activeTab === tab.id
                          ? "bg-foreground/[0.08] font-medium text-foreground"
                          : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
                      )}
                    >
                      <span className="flex size-4 items-center justify-center [&>svg]:size-[15px]">
                        {tab.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                      {tab.id === "about" && (hasUpdate || hasEnvironmentIssues) && (
                        <span className="size-1.5 rounded-full bg-red-500" />
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {filteredGroups.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                没有匹配的设置
              </div>
            )}
          </nav>
        </ScrollArea>
      </aside>

      <section className="flex min-w-0 flex-1 overflow-hidden border-l border-border/50 bg-card/90">
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          {/* 顶部需避开 52px 的 titlebar 拖拽区（WebkitAppRegion:'drag'），
              否则落在这个区间内的按钮（如「添加配置」）点击会被当作窗口拖动吞掉。
              与左侧 aside 的返回按钮保持一致的顶部避让。 */}
          <div className="mx-auto w-full max-w-[1060px] px-7 pb-7 pt-[60px]">
            {renderTabContent(activeTab)}
          </div>
        </ScrollArea>
      </section>

      {/* 退出拦截弹窗（设置导航 / 返回对话 / Cmd+W） */}
      <AlertDialog open={showNavDialog} onOpenChange={(open) => { if (!open) cancelPendingAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前渠道配置尚未保存，确定要离开吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPendingAction}>留在当前页</AlertDialogCancel>
            <AlertDialogAction onClick={executePendingAction}>放弃并离开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
