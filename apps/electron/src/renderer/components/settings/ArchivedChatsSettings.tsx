/**
 * ArchivedChatsSettings - 已归档的聊天管理。
 *
 * 统一管理 Chat 对话与 Agent 会话的归档内容，支持搜索、按类型/项目筛选、
 * 取消归档、单独删除和全部删除。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import {
  ArchiveRestore,
  Bot,
  FolderOpen,
  Loader2,
  MessageSquare,
  Search,
  Trash2,
} from 'lucide-react'
import type { AgentWorkspace } from '@proma/shared'
import { conversationsAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import {
  buildArchivedChatItems,
  filterArchivedChatItems,
  getArchivedChatWorkspaceOptions,
  groupArchivedChatItems,
  type ArchivedChatItem,
  type ArchivedChatKindFilter,
  type ArchivedChatWorkspaceFilter,
} from '@/lib/archived-chats'

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatArchivedDate(timestamp: number): string {
  return DATE_FORMATTER.format(timestamp)
}

function getItemKey(item: ArchivedChatItem): string {
  return `${item.kind}:${item.id}`
}

export function ArchivedChatsSettings(): React.ReactElement {
  const [conversations, setConversations] = useAtom(conversationsAtom)
  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom)
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [query, setQuery] = React.useState('')
  const [kind, setKind] = React.useState<ArchivedChatKindFilter>('all')
  const [workspaceId, setWorkspaceId] = React.useState<ArchivedChatWorkspaceFilter>('all')
  const [loading, setLoading] = React.useState(true)
  const [busyKey, setBusyKey] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<ArchivedChatItem | null>(null)
  const [deleteAllOpen, setDeleteAllOpen] = React.useState(false)
  const [deletingAll, setDeletingAll] = React.useState(false)
  const [deleteAllProgress, setDeleteAllProgress] = React.useState(0)

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextConversations, nextSessions, nextWorkspaces] = await Promise.all([
        window.electronAPI.listConversations(),
        window.electronAPI.listAgentSessions(),
        window.electronAPI.listAgentWorkspaces(),
      ])
      setConversations(nextConversations)
      setAgentSessions(nextSessions)
      setWorkspaces(nextWorkspaces)
    } catch (error) {
      console.error('[已归档聊天] 加载失败:', error)
      toast.error('加载已归档聊天失败')
    } finally {
      setLoading(false)
    }
  }, [setAgentSessions, setConversations])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const archivedItems = React.useMemo(
    () => buildArchivedChatItems(conversations, agentSessions, workspaces),
    [agentSessions, conversations, workspaces],
  )
  const filteredItems = React.useMemo(
    () => filterArchivedChatItems(archivedItems, { query, kind, workspaceId }),
    [archivedItems, kind, query, workspaceId],
  )
  const groups = React.useMemo(
    () => groupArchivedChatItems(filteredItems),
    [filteredItems],
  )
  const workspaceOptions = React.useMemo(
    () => getArchivedChatWorkspaceOptions(archivedItems),
    [archivedItems],
  )

  const handleUnarchive = React.useCallback(async (item: ArchivedChatItem): Promise<void> => {
    const itemKey = getItemKey(item)
    setBusyKey(itemKey)
    try {
      if (item.kind === 'chat') {
        const updated = await window.electronAPI.toggleArchiveConversation(item.id)
        setConversations((previous) => previous.map((conversation) => (
          conversation.id === updated.id ? updated : conversation
        )))
      } else {
        const updated = await window.electronAPI.toggleArchiveAgentSession(item.id)
        setAgentSessions((previous) => previous.map((session) => (
          session.id === updated.id ? updated : session
        )))
      }
      toast.success('已取消归档')
    } catch (error) {
      console.error('[已归档聊天] 取消归档失败:', error)
      toast.error('取消归档失败')
    } finally {
      setBusyKey(null)
    }
  }, [setAgentSessions, setConversations])

  const handleDelete = React.useCallback(async (item: ArchivedChatItem): Promise<void> => {
    const itemKey = getItemKey(item)
    setBusyKey(itemKey)
    try {
      if (item.kind === 'chat') {
        await window.electronAPI.deleteConversation(item.id)
        setConversations((previous) => previous.filter((conversation) => conversation.id !== item.id))
      } else {
        await window.electronAPI.deleteAgentSession(item.id)
        setAgentSessions((previous) => previous.filter((session) => session.id !== item.id))
      }
      toast.success('已删除归档聊天')
    } catch (error) {
      console.error('[已归档聊天] 删除失败:', error)
      toast.error('删除归档聊天失败')
    } finally {
      setBusyKey(null)
      setDeleteTarget(null)
    }
  }, [setAgentSessions, setConversations])

  const handleDeleteAll = React.useCallback(async (): Promise<void> => {
    if (archivedItems.length === 0 || deletingAll) return
    setDeletingAll(true)
    setDeleteAllProgress(0)
    toast.info(`正在删除 ${archivedItems.length} 个归档聊天...`)
    try {
      for (const [index, item] of archivedItems.entries()) {
        if (item.kind === 'chat') {
          await window.electronAPI.deleteConversation(item.id)
        } else {
          await window.electronAPI.deleteAgentSession(item.id)
        }
        setDeleteAllProgress(index + 1)
      }
      setConversations((previous) => previous.filter((conversation) => !conversation.archived))
      setAgentSessions((previous) => previous.filter((session) => !session.archived))
      toast.success(`已删除 ${archivedItems.length} 个归档聊天`)
    } catch (error) {
      console.error('[已归档聊天] 全部删除失败:', error)
      toast.error('全部删除未完成，请稍后重试')
      await refresh()
    } finally {
      setDeletingAll(false)
      setDeleteAllProgress(0)
      setDeleteAllOpen(false)
    }
  }, [archivedItems, deletingAll, refresh, setAgentSessions, setConversations])

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">已归档的聊天</h1>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              管理已归档的 Chat 对话和 Agent 会话
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-destructive/20 bg-destructive/[0.06] text-destructive hover:border-destructive/35 hover:bg-destructive/[0.12]"
            disabled={loading || archivedItems.length === 0 || deletingAll}
            onClick={() => setDeleteAllOpen(true)}
          >
            <Trash2 className="mr-1.5 size-3.5" />
            全部删除
          </Button>
        </div>

        <div className="flex flex-col gap-2.5 md:flex-row">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 text-muted-foreground shadow-xs focus-within:border-ring focus-within:bg-background focus-within:ring-4 focus-within:ring-ring/15">
            <Search className="size-4 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索已归档聊天"
              aria-label="搜索已归档聊天"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/80"
            />
          </label>
          <Select value={kind} onValueChange={(value) => setKind(value as ArchivedChatKindFilter)}>
            <SelectTrigger className="w-full md:w-[132px]">
              <SelectValue placeholder="全部聊天" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部聊天</SelectItem>
              <SelectItem value="chat">Chat 对话</SelectItem>
              <SelectItem value="agent">Agent 会话</SelectItem>
            </SelectContent>
          </Select>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger className="w-full md:w-[160px]">
              <SelectValue placeholder="所有项目" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有项目</SelectItem>
              {workspaceOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex min-h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-background/30 px-4 py-14 text-center">
            <ArchiveRestore className="mx-auto size-7 text-muted-foreground/45" />
            <p className="mt-3 text-sm font-medium text-foreground">没有匹配的归档聊天</p>
            <p className="mt-1 text-xs text-muted-foreground">归档后的聊天会显示在这里</p>
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <section key={group.workspaceId ?? 'none'} className="space-y-2.5">
                <div className="flex items-center gap-2 px-1">
                  <FolderOpen className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">{group.workspaceName}</h2>
                  <span className="ml-auto text-xs text-muted-foreground">{group.items.length} 个聊天</span>
                </div>
                <div className="overflow-hidden rounded-lg border border-border/55 bg-background/45 shadow-xs">
                  {group.items.map((item) => {
                    const itemKey = getItemKey(item)
                    const busy = busyKey === itemKey || deletingAll
                    return (
                      <div
                        key={itemKey}
                        className={cn(
                          'flex min-h-[72px] items-center gap-3 px-4 py-3',
                          'border-b border-border/40 last:border-b-0',
                          busy && 'opacity-60',
                        )}
                      >
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
                          {item.kind === 'chat' ? <MessageSquare className="size-4" /> : <Bot className="size-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[13px] font-medium text-foreground">{item.title}</p>
                            <span className="shrink-0 rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {item.kind === 'chat' ? 'Chat' : 'Agent'}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {formatArchivedDate(item.updatedAt)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleUnarchive(item)}
                          >
                            <ArchiveRestore className="size-3.5" />
                            取消归档
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:bg-destructive/[0.08] hover:text-destructive"
                            aria-label={`删除 ${item.title}`}
                            title="删除"
                            disabled={busy}
                            onClick={() => setDeleteTarget(item)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除归档聊天？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除“{deleteTarget?.title ?? ''}”及其消息内容，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteTarget ? busyKey === getItemKey(deleteTarget) : false}
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget)
              }}
            >
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteAllOpen}
        onOpenChange={(open) => {
          if (!deletingAll) setDeleteAllOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deletingAll ? '正在删除归档聊天...' : '删除全部归档聊天？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingAll
                ? `正在处理第 ${deleteAllProgress} / ${archivedItems.length} 个聊天，请不要关闭窗口。`
                : `将永久删除全部 ${archivedItems.length} 个归档聊天及其消息内容，无法恢复。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingAll}>取消</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingAll}
              onClick={() => void handleDeleteAll()}
            >
              {deletingAll && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              {deletingAll ? '删除中...' : '全部永久删除'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
