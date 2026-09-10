import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clipboard,
  ExternalLink,
  Globe,
  Home,
  MessageSquare,
  MousePointer2,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { BROWSER_IPC_CHANNELS, browserPartitionForSession, normalizeBrowserNavigationUrl } from '@proma/shared'
import type { BrowserAnnotationMode } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  browserAnnotationKey,
  browserAnnotationsAtomFamily,
  browserSelectedAnnotationIdsAtomFamily,
} from '@/atoms/browser-atoms'

const DEFAULT_URL = 'https://www.google.com'

type BrowserGuest = HTMLElement & {
  getWebContentsId: () => number
  getURL?: () => string
  goBack: () => void
  goForward: () => void
  reload: () => void
  send: (channel: string, ...args: unknown[]) => void
}

function initialNavigationUrl(value?: string): string {
  const raw = value?.trim()
  if (!raw) return DEFAULT_URL
  if (raw === 'about:blank') return raw
  return normalizeBrowserNavigationUrl(raw) || DEFAULT_URL
}

function annotationLabel(annotation: {
  target: 'element' | 'region'
  accessibleName?: string
  text?: string
}): string {
  if (annotation.target === 'region') return '区域标注'
  return annotation.accessibleName || annotation.text || '元素标注'
}

export function BrowserPanel({ sessionId, taskId, initialUrl }: { sessionId: string; taskId?: string; initialUrl?: string }): React.ReactElement {
  const webviewRef = React.useRef<BrowserGuest | null>(null)
  // 按会话隔离的 Electron partition（每个会话独立 Cookie/localStorage/缓存）
  const partition = React.useMemo(() => browserPartitionForSession(sessionId), [sessionId])
  // 使用 useRef 保持上一次的 sessionId 和 URL，避免会话切换时重新加载
  const prevSessionIdRef = React.useRef<string>(sessionId)
  const startUrl = initialNavigationUrl(initialUrl)
  const prevUrlRef = React.useRef<string>(startUrl)
  // committedSrc 只在用户/Agent 主动导航时更新；页面自己的跳转只改地址栏，避免 src 回写把当前加载 abort 掉。
  const [committedSrc, setCommittedSrc] = React.useState(startUrl)
  const [displayUrl, setDisplayUrl] = React.useState(startUrl)
  const [inputUrl, setInputUrl] = React.useState(startUrl)
  const isWebviewHoveredRef = React.useRef(false)

  const setBrowserScrollbarVisible = React.useCallback((visible: boolean): void => {
    isWebviewHoveredRef.current = visible
    webviewRef.current?.send(BROWSER_IPC_CHANNELS.SET_SCROLLBAR_VISIBLE, visible)
  }, [])

  // 当 sessionId 变化时，保持 webview 状态，不重新加载
  React.useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      // 会话切换了，恢复之前的 URL，不重新加载
      setCommittedSrc(prevUrlRef.current)
      setDisplayUrl(prevUrlRef.current)
      setInputUrl(prevUrlRef.current)
      prevSessionIdRef.current = sessionId
    }
  }, [sessionId])








  const [isLoading, setIsLoading] = React.useState(false)
  const [browserError, setBrowserError] = React.useState('')
  const [annotationMode, setAnnotationMode] = React.useState<BrowserAnnotationMode>('none')
  const [annotations, setAnnotations] = useAtom(browserAnnotationsAtomFamily(sessionId))
  const [selectedIds, setSelectedIds] = useAtom(browserSelectedAnnotationIdsAtomFamily(sessionId))
  const allAnnotations = useAtomValue(browserAnnotationsAtomFamily(sessionId))

  const navigate = React.useCallback((value: string): void => {
    const normalized = normalizeBrowserNavigationUrl(value)
    if (!normalized) {
      setBrowserError('请输入 http 或 https 网页地址。')
      return
    }
    setBrowserError('')
    setCommittedSrc(normalized)
    setDisplayUrl(normalized)
    setInputUrl(normalized)
    prevUrlRef.current = normalized
  }, [])

  const updateAnnotationMode = React.useCallback((mode: BrowserAnnotationMode): void => {
    const nextMode = annotationMode === mode ? 'none' : mode
    setAnnotationMode(nextMode)
    webviewRef.current?.send(BROWSER_IPC_CHANNELS.SET_MODE, nextMode)
  }, [annotationMode])

  // Browser Agent：有 taskId 时，webview 挂载后把 guestId 上报主进程绑定到任务，
  // 卸载时解绑。用户手动浏览（无 taskId）不参与。
  React.useEffect(() => {
    if (!taskId) return
    const guest = webviewRef.current
    if (!guest) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryCount = 0
    const bind = async (): Promise<void> => {
      if (cancelled) return
      try {
        const guestId = guest.getWebContentsId()
        if (!Number.isInteger(guestId) || guestId <= 0) throw new Error('webview 尚未 attach')
        const currentUrl = guest.getURL?.() || guest.getAttribute('src') || undefined
        await window.electronAPI.bindBrowserAgentTask({ taskId, guestId, url: currentUrl })
        console.info(`[内置浏览器 Agent] 页面已绑定: task=${taskId}, guest=${guestId}`)
      } catch {
        retryCount += 1
        if (retryCount < 80) {
          retryTimer = setTimeout(() => void bind(), 100)
        } else {
          console.warn(`[内置浏览器 Agent] 页面绑定失败: task=${taskId}`)
        }
      }
    }
    const handleDomReady = (): void => {
      retryCount = 0
      void bind()
    }
    guest.addEventListener('dom-ready', handleDomReady)
    void bind()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      guest.removeEventListener('dom-ready', handleDomReady)
      try {
        const guestId = guest.getWebContentsId?.()
        if (typeof guestId === 'number') void window.electronAPI.unbindBrowserAgentTask({ guestId })
      } catch { /* 忽略 */ }
    }
  }, [taskId])

  React.useEffect(() => {
    const guest = webviewRef.current
    if (!guest) return
    const handleStart = (): void => setIsLoading(true)
    const handleStop = (): void => setIsLoading(false)
    const handleDomReady = (): void => {
      if (isWebviewHoveredRef.current) {
        guest.send(BROWSER_IPC_CHANNELS.SET_SCROLLBAR_VISIBLE, true)
      }
    }
    const handleNavigate = (event: Event): void => {
      const nextUrl = (event as Event & { url?: string }).url
      if (!nextUrl) return
      setDisplayUrl(nextUrl)
      setInputUrl(nextUrl)
      prevUrlRef.current = nextUrl
    }
    const handlePointerEnter = (): void => setBrowserScrollbarVisible(true)
    const handlePointerLeave = (): void => setBrowserScrollbarVisible(false)
    guest.addEventListener('pointerenter', handlePointerEnter)
    guest.addEventListener('pointerleave', handlePointerLeave)
    guest.addEventListener('did-start-loading', handleStart)
    guest.addEventListener('did-stop-loading', handleStop)
    guest.addEventListener('dom-ready', handleDomReady)
    guest.addEventListener('did-navigate', handleNavigate)
    guest.addEventListener('did-navigate-in-page', handleNavigate)
    const removeAnnotationListener = window.electronAPI.onBrowserAnnotationCreated((event) => {
      const annotation = event.annotation
      const key = browserAnnotationKey(annotation)
      setAnnotations((current) => current.some((item) => browserAnnotationKey(item) === key)
        ? current
        : [...current, annotation])
      setSelectedIds((current) => {
        const next = new Set(current)
        next.add(key)
        return next
      })
      setBrowserError('')
    })
    const removeErrorListener = window.electronAPI.onBrowserError((event) => {
      setBrowserError(event.error || '浏览器操作失败。')
    })
    return () => {
      guest.removeEventListener('pointerenter', handlePointerEnter)
      guest.removeEventListener('pointerleave', handlePointerLeave)
      guest.removeEventListener('did-start-loading', handleStart)
      guest.removeEventListener('did-stop-loading', handleStop)
      guest.removeEventListener('dom-ready', handleDomReady)
      guest.removeEventListener('did-navigate', handleNavigate)
      guest.removeEventListener('did-navigate-in-page', handleNavigate)
      removeAnnotationListener()
      removeErrorListener()
    }
  }, [setAnnotations, setBrowserScrollbarVisible, setSelectedIds])

  const toggleSelected = (annotation: (typeof annotations)[number]): void => {
    const key = browserAnnotationKey(annotation)
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const removeAnnotation = (annotation: (typeof annotations)[number]): void => {
    const key = browserAnnotationKey(annotation)
    setAnnotations((current) => current.filter((item) => browserAnnotationKey(item) !== key))
    setSelectedIds((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  const copySelected = async (): Promise<void> => {
    const selected = allAnnotations.filter((annotation) => selectedIds.has(browserAnnotationKey(annotation)))
    if (!selected.length) return
    const text = selected.map((annotation, index) => [
      `网页标注 ${index + 1}（${annotationLabel(annotation)}）`,
      `页面：${annotation.pageTitle || annotation.url}`,
      `地址：${annotation.url}`,
      annotation.selector ? `Selector：${annotation.selector}` : '',
      annotation.text ? `页面内容：${annotation.text}` : '',
      `评论：${annotation.comment}`,
    ].filter(Boolean).join('\n')).join('\n\n')
    await navigator.clipboard.writeText(text)
    setBrowserError('已复制选中的网页标注，可粘贴到当前 Agent 消息。')
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-muted/25 px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="后退" onClick={() => webviewRef.current?.goBack()}><ArrowLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="前进" onClick={() => webviewRef.current?.goForward()}><ArrowRight /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="刷新" onClick={() => webviewRef.current?.reload()}><RefreshCw className={isLoading ? 'animate-spin' : ''} /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="主页" onClick={() => navigate(DEFAULT_URL)}><Home /></Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); navigate(inputUrl) }}>
          <div className="relative">
            <Globe className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
            <Input value={inputUrl} onChange={(event) => setInputUrl(event.target.value)} className="h-7 pl-8 text-xs" aria-label="浏览器地址" />
          </div>
        </form>
        <Button variant="ghost" size="icon-sm" aria-label="在系统浏览器打开" onClick={() => void window.electronAPI.openExternal(displayUrl)}><ExternalLink /></Button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border/30 px-2 py-1">
        <Button
          variant={annotationMode === 'element' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => updateAnnotationMode('element')}
        >
          <MousePointer2 className="size-3.5" />元素
        </Button>
        <Button
          variant={annotationMode === 'region' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => updateAnnotationMode('region')}
        >
          <ScanLine className="size-3.5" />区域
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-2 text-[11px]" onClick={() => void copySelected()} disabled={!selectedIds.size}>
          <Clipboard className="size-3.5" />复制引用
        </Button>
        {annotationMode !== 'none' && (
          <Button variant="ghost" size="icon-sm" aria-label="退出标注" onClick={() => updateAnnotationMode('none')}><X /></Button>
        )}
      </div>

      {browserError && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">{browserError}</div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className="flex min-h-0 flex-1 flex-col"
          onPointerEnter={() => setBrowserScrollbarVisible(true)}
          onPointerLeave={() => setBrowserScrollbarVisible(false)}
        >
          {/* React 会丢弃未知属性的布尔值；显式写入字符串，让新窗口请求交给主进程校验并在当前页打开。 */}
          {React.createElement('webview', {
            key: partition,
            ref: webviewRef,
            src: committedSrc,
            partition,
            className: 'min-h-0 flex-1',
            allowpopups: '',
          })}
        </div>
        {annotations.length > 0 && (
          <div className="max-h-44 shrink-0 space-y-1 overflow-y-auto border-t border-border/50 bg-muted/15 p-2">
            <div className="flex items-center gap-1 px-1 text-[10px] font-medium text-muted-foreground">
              <MessageSquare className="size-3" />网页标注
              <span className="ml-auto">{selectedIds.size} 项将随下条消息引用</span>
            </div>
            {annotations.map((annotation) => {
              const key = browserAnnotationKey(annotation)
              const selected = selectedIds.has(key)
              return (
                <div key={key} className="flex items-start gap-2 rounded-lg bg-background/80 px-2 py-1.5 text-[11px] shadow-sm">
                  <button type="button" className="mt-0.5 text-primary" aria-label={selected ? '取消引用网页标注' : '引用网页标注'} onClick={() => toggleSelected(annotation)}>
                    {selected ? <Check className="size-3.5" /> : <span className="block size-3.5 rounded-sm ring-1 ring-border" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{annotationLabel(annotation)}</div>
                    <div className="truncate text-muted-foreground">{annotation.comment}</div>
                    <div className="truncate text-[10px] text-muted-foreground/70">{annotation.pageTitle || annotation.url}</div>
                  </div>
                  <button type="button" className="text-muted-foreground hover:text-destructive" aria-label="删除网页标注" onClick={() => removeAnnotation(annotation)}>
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-border/30 px-3 py-1 text-[10px] text-muted-foreground">
        <ShieldCheck className="size-3 text-emerald-500" /> Xcodes Browser 安全隔离已启用
      </div>
    </div>
  )
}
