/**
 * 悬浮面板「浏览器」任务列表。
 *
 * 列出当前会话未超时清理的浏览器任务。
 * 点击条目 → 打开该任务专属的内置浏览器 Tab（tab 名 = 任务名）。
 * 用户手动打开的浏览器 Tab 不在此列出、不受影响。
 */

import * as React from 'react'
import {
  CheckCircle2,
  Globe,
  MessageCircleQuestion,
  PauseCircle,
  XCircle,
} from 'lucide-react'
import type { BrowserAgentTask } from '@proma/shared'
import { useBrowserAgentTasks } from '@/hooks/useBrowserAgentTasks'

interface BrowserTasksPanelProps {
  sessionId: string
  onOpenTask: (task: BrowserAgentTask) => void
}

function BrowserTaskStatusIcon({ status }: Pick<BrowserAgentTask, 'status'>): React.ReactElement | null {
  switch (status) {
    case 'running':
      return null
    case 'waiting_user':
      return <MessageCircleQuestion className="size-3.5 text-amber-500" aria-label="等待用户操作" />
    case 'paused':
      return <PauseCircle className="size-3.5 text-amber-500" aria-label="已暂停" />
    case 'completed':
      return <CheckCircle2 className="size-3.5 text-emerald-500" aria-label="已完成" />
    case 'failed':
      return <XCircle className="size-3.5 text-red-500" aria-label="失败" />
  }
}

export function BrowserTasksPanel({ sessionId, onOpenTask }: BrowserTasksPanelProps): React.ReactElement {
  const sessionTasks = useBrowserAgentTasks(sessionId)

  if (sessionTasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        暂无浏览器任务。Agent 调用浏览器工具后会在这里显示。
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      <div className="space-y-1.5">
        {sessionTasks.map((task) => (
          <button
            key={task.taskId}
            type="button"
            onClick={() => onOpenTask(task)}
            className="flex w-full items-start gap-2.5 rounded-lg border border-border/50 bg-background/80 px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-accent/50"
          >
            <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className={task.status === 'running'
                ? 'agent-status-shimmer truncate text-[13px] font-medium'
                : 'truncate text-[13px] font-medium text-foreground'}
              >
                {task.title}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{task.url || 'about:blank'}</div>
            </div>
            <BrowserTaskStatusIcon status={task.status} />
          </button>
        ))}
      </div>
    </div>
  )
}
