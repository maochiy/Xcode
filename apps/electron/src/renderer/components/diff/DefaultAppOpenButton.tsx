/**
 * DefaultAppOpenButton — 用本机应用打开预览文件
 *
 * 点应用名 / 图标立即打开；多个应用时右侧箭头只用来换应用，
 * 下拉里选中后记住偏好，不会直接打开文件。
 */

import * as React from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import type { FileAccessOptions } from '@proma/shared'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAvailableOpenApps } from '@/hooks/useAvailableOpenApps'
import { getDefaultAppOpenLabel } from '@/lib/default-app-open-label'
import { cn } from '@/lib/utils'
import type { OpenAppOption } from '@/lib/open-app-preference'

interface DefaultAppOpenButtonProps {
  filePath: string
  /** 透传给 systemOpenFile 作为路径授权上下文 */
  access?: FileAccessOptions
  /** 紧凑模式（仅图标）/ 完整模式（图标 + App 名） */
  variant?: 'compact' | 'labeled'
  className?: string
}

function AppIcon({
  option,
  className,
}: {
  option: OpenAppOption | null
  className?: string
}): React.ReactElement {
  if (option?.iconDataUrl) {
    return (
      <img
        src={option.iconDataUrl}
        alt=""
        className={cn('shrink-0', className)}
        draggable={false}
      />
    )
  }
  return <ExternalLink className={cn('shrink-0', className)} />
}

function OpenLabel({
  labeled,
  selected,
}: {
  labeled: boolean
  selected: OpenAppOption | null
}): React.ReactElement {
  return (
    <>
      <AppIcon option={selected} className={labeled ? 'size-4' : 'size-3.5'} />
      {labeled && (
        <span className="text-[11px] leading-none truncate">
          {selected?.name ?? '打开'}
        </span>
      )}
    </>
  )
}

export function DefaultAppOpenButton({
  filePath,
  access,
  variant = 'labeled',
  className,
}: DefaultAppOpenButtonProps): React.ReactElement | null {
  const { options, selected, selectApp, openWith } = useAvailableOpenApps(filePath, access)
  const [menuOpen, setMenuOpen] = React.useState(false)

  const labeled = variant === 'labeled'
  const hasChoices = options.length > 1
  const label = selected
    ? getDefaultAppOpenLabel({ name: selected.name, appPath: selected.appPath ?? '', iconDataUrl: selected.iconDataUrl ?? '' })
    : getDefaultAppOpenLabel(null)

  const partClassName = cn(
    'flex items-center shrink-0 transition-colors',
    'text-muted-foreground hover:text-foreground hover:bg-muted/50',
  )

  const handleOpen = React.useCallback(() => {
    if (!selected) return
    openWith(selected)
  }, [openWith, selected])

  const openButton = (
    <button
      type="button"
      className={cn(
        partClassName,
        labeled ? 'gap-1 h-6 px-1.5 min-w-0' : 'justify-center size-6',
        hasChoices ? 'rounded-l max-w-[160px]' : 'rounded',
        !hasChoices && labeled && 'max-w-[176px]',
        !hasChoices && className,
      )}
      aria-label={label}
      onClick={handleOpen}
    >
      <OpenLabel labeled={labeled} selected={selected} />
    </button>
  )

  if (!hasChoices) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{openButton}</TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{selected ? `用 ${selected.name} 打开编辑` : '用系统默认应用打开'}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className={cn('flex items-center shrink-0 rounded overflow-hidden', className)}>
      <Tooltip>
        <TooltipTrigger asChild>{openButton}</TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{selected ? `用 ${selected.name} 打开编辑` : '用系统默认应用打开'}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(partClassName, 'justify-center h-6 w-4 rounded-r')}
                aria-label="选择打开应用"
              >
                <ChevronDown className="size-3 shrink-0 opacity-70" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>选择打开应用</p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px] p-1">
          {options.map((option) => (
            <DropdownMenuItem
              key={option.appPath || option.name}
              className="cursor-pointer gap-2 text-xs py-1.5"
              onSelect={() => selectApp(option)}
            >
              <AppIcon option={option} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {selected?.name === option.name && selected?.appPath === option.appPath && (
                <span className="text-[10px] text-muted-foreground shrink-0">当前</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
