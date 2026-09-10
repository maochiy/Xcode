import * as React from 'react'
import {
  Bug,
  Hammer,
  ScanSearch,
  SquareCode,
  type LucideIcon,
} from 'lucide-react'
import xcodesIcon from '@/assets/xcodes-icon.svg'

interface AgentWelcomeScreenProps {
  projectName?: string | null
  onSelectPrompt?: (prompt: string) => void
}

interface WelcomeTask {
  label: string
  prompt: string
  icon: LucideIcon
  iconClassName: string
}

const WELCOME_TASKS: WelcomeTask[] = [
  {
    label: '探索并理解代码',
    prompt: '探索并理解当前代码库的结构、关键模块和主要运行流程。',
    icon: ScanSearch,
    iconClassName: 'text-blue-500 dark:text-blue-400',
  },
  {
    label: '构建新功能、应用或工具',
    prompt: '在当前项目中构建一个新功能、应用或工具。',
    icon: Hammer,
    iconClassName: 'text-violet-500 dark:text-violet-400',
  },
  {
    label: '审查代码并提出修改建议',
    prompt: '审查当前代码，找出可改进之处并提出具体修改建议。',
    icon: SquareCode,
    iconClassName: 'text-emerald-500 dark:text-emerald-400',
  },
  {
    label: '修复问题和失败',
    prompt: '定位并修复当前项目中的问题或失败，并验证修复结果。',
    icon: Bug,
    iconClassName: 'text-orange-500 dark:text-orange-400',
  },
]

export function AgentWelcomeScreen({
  projectName,
  onSelectPrompt,
}: AgentWelcomeScreenProps): React.ReactElement {
  const titleId = React.useId()
  const displayProjectName = projectName?.trim()
  const isDisabled = onSelectPrompt == null

  return (
    <section
      className="flex min-h-0 w-full flex-1 items-center justify-center py-10"
      aria-labelledby={titleId}
    >
      <div className="w-full max-w-[720px] pb-12">
        <div className="flex flex-col items-center text-center">
          <img src={xcodesIcon} alt="Xcodes" className="size-12" draggable={false} />

          <h1
            id={titleId}
            className="mt-6 max-w-full break-words text-balance text-[clamp(20px,2.2vw,28px)] font-medium leading-snug tracking-[-0.02em] text-foreground"
          >
            {displayProjectName ? (
              <>
                你想让我们在{' '}
                <span className="break-all underline decoration-foreground/35 decoration-1 underline-offset-4">
                  {displayProjectName}
                </span>{' '}
                中构建什么？
              </>
            ) : (
              '你想让我们构建什么？'
            )}
          </h1>
        </div>

        {/* 使用原生 Grid 根据所在面板宽度换列，不依赖额外的 Tailwind 容器查询插件。 */}
        <div
          className="mt-8 grid gap-2.5"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))' }}
        >
          {WELCOME_TASKS.map((task) => {
            const Icon = task.icon
            return (
              <button
                key={task.label}
                type="button"
                aria-label={task.label}
                disabled={isDisabled}
                onClick={() => onSelectPrompt?.(task.prompt)}
                className="group flex min-h-[106px] min-w-0 flex-col items-start rounded-2xl border border-border/45 bg-card/30 p-4 text-left shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:border-border/70 hover:bg-accent/45 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none"
              >
                <Icon
                  className={`size-4 shrink-0 ${task.iconClassName}`}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="mt-auto pt-5 text-[13px] font-medium leading-5 text-foreground/75 transition-colors group-hover:text-foreground">
                  {task.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
