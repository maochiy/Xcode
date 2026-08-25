import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import {
  agentTerminalTabSnapshotsAtom,
  createAgentTerminalTab,
} from '@/atoms/agent-atoms'
import { resolvedThemeAtom, themeStyleAtom } from '@/atoms/theme'
import { Button } from '@/components/ui/button'
import { IntegratedTerminalLayoutCoordinator } from '@/lib/integrated-terminal-layout'
import { IntegratedTerminalOutputQueue } from '@/lib/integrated-terminal-output-queue'

interface IntegratedTerminalPanelProps {
  sessionId: string
  terminalSessionId: string
  terminalCwd: string | null
  currentSessionPath: string | null
  onCreateSibling: () => void
  onExit: () => void
}

interface IntegratedTerminalPanelState {
  failed: boolean
}

function readCssColor(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback
}

function readTerminalTheme(host?: HTMLElement | null): ITheme {
  const style = getComputedStyle(document.documentElement)
  const surface = host?.closest<HTMLElement>('[data-codex-terminal]') ?? host
  const surfaceStyle = surface ? getComputedStyle(surface) : style
  const foreground = surfaceStyle.color || readCssColor(
    style,
    '--vscode-terminal-foreground',
    '#d4d4d4',
  )
  const background = surfaceStyle.backgroundColor || readCssColor(
    style,
    '--vscode-terminal-background',
    '#181818',
  )
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: readCssColor(style, '--vscode-terminal-selectionBackground', '#264f78'),
    selectionInactiveBackground: readCssColor(style, '--vscode-terminal-inactiveSelectionBackground', '#3a3d41'),
    black: readCssColor(style, '--vscode-terminal-ansiBlack', '#000000'),
    red: readCssColor(style, '--vscode-terminal-ansiRed', '#cd3131'),
    green: readCssColor(style, '--vscode-terminal-ansiGreen', '#0dbc79'),
    yellow: readCssColor(style, '--vscode-terminal-ansiYellow', '#e5e510'),
    blue: readCssColor(style, '--vscode-terminal-ansiBlue', '#2472c8'),
    magenta: readCssColor(style, '--vscode-terminal-ansiMagenta', '#bc3fbc'),
    cyan: readCssColor(style, '--vscode-terminal-ansiCyan', '#11a8cd'),
    white: readCssColor(style, '--vscode-terminal-ansiWhite', '#e5e5e5'),
    brightBlack: readCssColor(style, '--vscode-terminal-ansiBrightBlack', '#666666'),
    brightRed: readCssColor(style, '--vscode-terminal-ansiBrightRed', '#f14c4c'),
    brightGreen: readCssColor(style, '--vscode-terminal-ansiBrightGreen', '#23d18b'),
    brightYellow: readCssColor(style, '--vscode-terminal-ansiBrightYellow', '#f5f543'),
    brightBlue: readCssColor(style, '--vscode-terminal-ansiBrightBlue', '#3b8eea'),
    brightMagenta: readCssColor(style, '--vscode-terminal-ansiBrightMagenta', '#d670d6'),
    brightCyan: readCssColor(style, '--vscode-terminal-ansiBrightCyan', '#29b8db'),
    brightWhite: readCssColor(style, '--vscode-terminal-ansiBrightWhite', '#ffffff'),
  }
}

class IntegratedTerminalErrorBoundary extends React.Component<
  React.PropsWithChildren,
  IntegratedTerminalPanelState
> {
  override state: IntegratedTerminalPanelState = { failed: false }

  static getDerivedStateFromError(): IntegratedTerminalPanelState {
    return { failed: true }
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="integrated-terminal-surface flex h-full items-center justify-center px-6 py-8 text-center">
        <div className="max-w-md">
          <AlertTriangle className="mx-auto mb-3 size-5 text-amber-500" />
          <h3 className="text-sm font-medium">终端出错</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            请尝试重新加载终端以继续
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => this.setState({ failed: false })}
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            重新加载
          </Button>
        </div>
      </div>
    )
  }
}

function IntegratedTerminalContent({
  sessionId,
  terminalSessionId,
  terminalCwd,
  currentSessionPath,
  onCreateSibling,
  onExit,
}: IntegratedTerminalPanelProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const terminalRef = React.useRef<Terminal | null>(null)
  const fitAddonRef = React.useRef<FitAddon | null>(null)
  const attachedSequenceRef = React.useRef(0)
  const titleUpdateTimerRef = React.useRef<number | null>(null)
  const pendingTitleRef = React.useRef('')
  const onCreateSiblingRef = React.useRef(onCreateSibling)
  const onExitRef = React.useRef(onExit)
  const setTerminalSnapshots = useSetAtom(agentTerminalTabSnapshotsAtom)
  const terminalTab = createAgentTerminalTab(terminalSessionId)
  const resolvedTheme = useAtomValue(resolvedThemeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const [error, setError] = React.useState<string | null>(null)
  const [dismissedMismatch, setDismissedMismatch] = React.useState(false)
  const workspaceMismatch = Boolean(
    terminalCwd
    && currentSessionPath
    && terminalCwd !== currentSessionPath,
  )

  React.useEffect(() => {
    onCreateSiblingRef.current = onCreateSibling
    onExitRef.current = onExit
  }, [onCreateSibling, onExit])

  const updateTerminalTitle = React.useCallback((title: string) => {
    const nextTitle = title.trim().slice(0, 80)
    if (!nextTitle) return
    pendingTitleRef.current = nextTitle
    if (titleUpdateTimerRef.current !== null) {
      window.clearTimeout(titleUpdateTimerRef.current)
    }
    // Shell 可能在用户每输入一个字符时更新 title。短暂防抖，避免整个右侧面板逐键重渲染。
    titleUpdateTimerRef.current = window.setTimeout(() => {
      titleUpdateTimerRef.current = null
      const pendingTitle = pendingTitleRef.current
      setTerminalSnapshots((previous) => {
        const sessionSnapshots = previous.get(sessionId)
        const current = sessionSnapshots?.get(terminalTab)
        if (!current || current.title === pendingTitle) return previous
        const next = new Map(previous)
        const nextSessionSnapshots = new Map(sessionSnapshots)
        nextSessionSnapshots.set(terminalTab, { ...current, title: pendingTitle })
        next.set(sessionId, nextSessionSnapshots)
        return next
      })
    }, 120)
  }, [sessionId, setTerminalSnapshots, terminalTab])

  React.useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    // ThemeInitializer 也通过 effect 更新 html class。延后一帧读取最终计算样式，
    // 避免子组件先读到切换前的颜色，导致终端主题落后一拍。
    const frame = requestAnimationFrame(() => {
      if (
        terminalRef.current !== terminal
        || !hostRef.current
        || !terminal.element?.isConnected
      ) return
      terminal.options.theme = readTerminalTheme(hostRef.current)
      terminal.refresh(0, Math.max(0, terminal.rows - 1))
      fitAddonRef.current?.fit()
    })
    return () => cancelAnimationFrame(frame)
  }, [resolvedTheme, themeStyle])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      allowTransparency: true,
      cursorStyle: 'bar',
      cursorBlink: true,
      allowProposedApi: true,
      letterSpacing: 0,
      lineHeight: 1.2,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      scrollback: 10_000,
      theme: readTerminalTheme(host),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new ClipboardAddon())
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      void window.electronAPI.openExternal(uri)
    }))
    terminal.open(host)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    let disposed = false
    let resizeFrame = 0
    let replayReady = false
    const layoutCoordinator = new IntegratedTerminalLayoutCoordinator()
    const pendingData: Array<{ data: string; sequence: number }> = []
    const outputQueue = new IntegratedTerminalOutputQueue((data) => {
      if (
        disposed
        || terminalRef.current !== terminal
        || !terminal.element?.isConnected
      ) return
      terminal.write(data)
    })
    const isTerminalReady = (): boolean =>
      !disposed
      && terminalRef.current === terminal
      && Boolean(terminal.element?.isConnected)
    const writeData = (data: string, sequence: number): void => {
      if (sequence <= attachedSequenceRef.current) return
      attachedSequenceRef.current = sequence
      outputQueue.enqueue(data)
    }
    const fitAndResize = (): void => {
      if (!isTerminalReady()) return
      const layoutAction = layoutCoordinator.update(host.clientWidth, host.clientHeight)
      if (!layoutAction.shouldFit) return
      if (layoutAction.shouldFocus) terminal.focus()
      fitAddon.fit()
      void window.electronAPI.resizeIntegratedTerminal(
        terminalSessionId,
        terminal.cols,
        terminal.rows,
      ).catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : '终端尺寸同步失败')
      })
    }
    const scheduleFit = (): void => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(fitAndResize)
    }

    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(host)
    scheduleFit()
    const dataDisposable = terminal.onData((data) => {
      void window.electronAPI.writeIntegratedTerminal(terminalSessionId, data)
        .catch((cause: unknown) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : '终端输入失败')
        })
    })
    const titleDisposable = terminal.onTitleChange(updateTerminalTitle)

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const isMac = navigator.platform.includes('Mac')
      if (isMac && event.metaKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        onCreateSiblingRef.current()
        return false
      }
      if (!isMac) return true
      const mapping = event.metaKey
        ? ({
            ArrowLeft: '\u0001',
            ArrowUp: '\u0001',
            ArrowRight: '\u0005',
            ArrowDown: '\u0005',
            Backspace: '\u0015',
            Delete: '\u000b',
          } as Record<string, string>)[event.key]
        : undefined
      if (!mapping) return true
      event.preventDefault()
      void window.electronAPI.writeIntegratedTerminal(terminalSessionId, mapping)
      return false
    })

    const unsubscribe = window.electronAPI.onIntegratedTerminalEvent((event) => {
      if (event.sessionId !== terminalSessionId || disposed) return
      if (event.type === 'data') {
        if (!replayReady) {
          pendingData.push({ data: event.data, sequence: event.sequence })
          return
        }
        writeData(event.data, event.sequence)
      } else if (event.type === 'exit') {
        onExitRef.current()
      } else if (event.type === 'error') {
        setError(event.message)
      }
    })

    void window.electronAPI.attachIntegratedTerminal(terminalSessionId)
      .then((attached) => {
        if (disposed) return
        attachedSequenceRef.current = attached.outputSequence
        terminal.reset()
        terminal.write(attached.output, () => {
          if (!isTerminalReady()) return
          replayReady = true
          for (const pending of pendingData) {
            writeData(pending.data, pending.sequence)
          }
          pendingData.length = 0
          outputQueue.flush()
          scheduleFit()
          // 面板按钮可能在异步挂载期间重新获得焦点，完成后恢复到 xterm。
          terminal.focus()
        })
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : '终端挂载失败')
      })

    return () => {
      disposed = true
      cancelAnimationFrame(resizeFrame)
      outputQueue.dispose()
      unsubscribe()
      resizeObserver.disconnect()
      dataDisposable.dispose()
      titleDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [terminalSessionId, updateTerminalTitle])

  React.useEffect(() => {
    return () => {
      if (titleUpdateTimerRef.current !== null) {
        window.clearTimeout(titleUpdateTimerRef.current)
      }
    }
  }, [])

  return (
    <div className="integrated-terminal-surface flex h-full min-h-0 flex-col" data-codex-terminal>
      {workspaceMismatch && !dismissedMismatch && (
        <div className="m-2 mb-0 flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            此终端的工作空间与此聊天当前的工作树不匹配
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setDismissedMismatch(true)}
          >
            关闭
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onCreateSibling}
          >
            打开新终端
          </Button>
        </div>
      )}
      {error && (
        <div className="mx-2 mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden ps-4 pb-3 tracking-normal">
        <div ref={hostRef} className="h-full w-full overflow-hidden" data-codex-xterm />
      </div>
    </div>
  )
}

function IntegratedTerminalPanelComponent(
  props: IntegratedTerminalPanelProps,
): React.ReactElement {
  return (
    <IntegratedTerminalErrorBoundary key={props.terminalSessionId}>
      <IntegratedTerminalContent {...props} />
    </IntegratedTerminalErrorBoundary>
  )
}

export const IntegratedTerminalPanel = React.memo(IntegratedTerminalPanelComponent)
