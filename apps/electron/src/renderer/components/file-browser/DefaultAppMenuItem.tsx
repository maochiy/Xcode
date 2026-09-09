/**
 * DefaultAppMenuItem — 文件浏览器三点菜单里的「用应用打开」。
 *
 * 只有一个可用应用时仍是单项；多个应用时展开子菜单，按文件类型记住选择。
 */

import * as React from 'react'
import { ExternalLink } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { useAvailableOpenApps } from '@/hooks/useAvailableOpenApps'
import { getDefaultAppOpenLabel } from '@/lib/default-app-open-label'
import { cn } from '@/lib/utils'
import type { OpenAppOption } from '@/lib/open-app-preference'

interface DefaultAppMenuItemProps {
  filePath: string
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

export function DefaultAppMenuItem({
  filePath,
  className,
}: DefaultAppMenuItemProps): React.ReactElement {
  const { options, selected, openWith } = useAvailableOpenApps(filePath)
  const label = selected
    ? getDefaultAppOpenLabel({ name: selected.name, appPath: selected.appPath ?? '', iconDataUrl: selected.iconDataUrl ?? '' })
    : getDefaultAppOpenLabel(null)

  if (options.length <= 1) {
    return (
      <DropdownMenuItem
        className={className}
        onSelect={() => {
          if (selected) openWith(selected)
        }}
      >
        <AppIcon option={selected} className="size-3.5" />
        <span className="truncate">{label}</span>
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={className}>
        <AppIcon option={selected} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[160px] p-1">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.appPath || option.name}
            className="cursor-pointer gap-2 text-xs py-1"
            onSelect={() => openWith(option)}
          >
            <AppIcon option={option} className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            {selected?.name === option.name && selected?.appPath === option.appPath && (
              <span className="text-[10px] text-muted-foreground shrink-0">当前</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
