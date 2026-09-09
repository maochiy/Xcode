import type { ReactElement } from 'react'
import { Check } from 'lucide-react'
import type { ThemeStyle } from '../../../types'
import { cn } from '@/lib/utils'

interface CursorThemeOption {
  id: Exclude<ThemeStyle, 'default'>
  name: string
  description: string
}

export const CURSOR_THEME_OPTIONS: readonly CursorThemeOption[] = [
  { id: 'cursor-dark', name: 'Cursor Dark', description: '中性炭灰 · 柔和蓝色' },
  { id: 'cursor-light', name: 'Cursor Light', description: '纸白底色 · 清晰层次' },
  { id: 'cursor-midnight-dark', name: 'Cursor Dark Midnight', description: '午夜蓝灰 · 冷色强调' },
  { id: 'cursor-high-contrast-dark', name: 'Cursor Dark High Contrast', description: '高对比深色' },
  { id: 'cursor-colorblind-light', name: 'Cursor Light Colorblind', description: '色盲友好浅色 · Beta' },
]

interface CursorThemePickerProps {
  selectedStyle: ThemeStyle
  disabled?: boolean
  onSelect: (style: ThemeStyle) => void
}

/** 直接使用实际主题 token 绘制缩略界面，避免图片预览与应用配色脱节。 */
export function CursorThemePicker({
  selectedStyle,
  disabled,
  onSelect,
}: CursorThemePickerProps): ReactElement {
  return (
    <div className="px-4 py-4 space-y-3">
      <div>
        <div className="text-sm font-medium text-foreground">Cursor 主题</div>
        <p className="mt-1 text-xs text-muted-foreground">
          选择主题即刻应用到整个界面；跟随系统时自动切换 Cursor Light / Dark。
        </p>
      </div>
      <div className="grid grid-cols-1 min-[440px]:grid-cols-2 min-[760px]:grid-cols-3 gap-3" role="group" aria-label="Cursor 主题">
        {CURSOR_THEME_OPTIONS.map((theme) => {
          const selected = selectedStyle === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              aria-pressed={selected}
              aria-label={theme.name}
              disabled={disabled}
              onClick={() => onSelect(theme.id)}
              className={cn(
                'min-w-0 rounded-lg p-2 text-left transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                'disabled:cursor-wait disabled:opacity-60',
                selected ? 'bg-muted/50 ring-2 ring-primary' : 'bg-muted/20 hover:bg-muted/50',
              )}
            >
              <div
                aria-hidden="true"
                className={cn('h-28 overflow-hidden rounded-md flex shadow-sm', `theme-${theme.id}`)}
                style={{ background: 'hsl(var(--content-area))', color: 'hsl(var(--foreground))' }}
              >
                <div className="w-[28%] p-2.5 space-y-2" style={{ background: 'hsl(var(--sidebar-surface))' }}>
                  <div className="flex gap-1 mb-4">
                    {[0, 1, 2].map((dot) => (
                      <span key={dot} className="size-1 rounded-full" style={{ background: 'hsl(var(--muted-foreground))' }} />
                    ))}
                  </div>
                  <div className="h-2 rounded-sm" style={{ background: 'hsl(var(--accent))' }} />
                  <div className="h-1 w-4/5 rounded-sm opacity-40" style={{ background: 'currentColor' }} />
                  <div className="h-1 w-3/5 rounded-sm opacity-25" style={{ background: 'currentColor' }} />
                </div>
                <div className="flex-1 min-w-0 flex flex-col">
                  <div className="h-5 px-3 flex items-center" style={{ background: 'hsl(var(--tabbar-surface))' }}>
                    <span className="h-1 w-10 rounded-sm opacity-35" style={{ background: 'currentColor' }} />
                  </div>
                  <div className="px-3 py-2 flex-1 space-y-1.5">
                    <div className="h-1 w-3/4 rounded-sm opacity-65" style={{ background: 'currentColor' }} />
                    <div className="h-1 w-1/2 rounded-sm opacity-30" style={{ background: 'currentColor' }} />
                    <div className="flex gap-1">
                      <span className="h-2 w-8 rounded-sm" style={{ background: 'var(--diff-added)' }} />
                      <span className="h-2 w-6 rounded-sm" style={{ background: 'var(--diff-removed)' }} />
                    </div>
                  </div>
                  <div className="mx-2 mb-2 h-6 rounded-md px-2 flex items-center justify-between" style={{ background: 'hsl(var(--input-surface))', boxShadow: 'inset 0 0 0 1px hsl(var(--input))' }}>
                    <span className="h-1 w-1/2 rounded-sm opacity-30" style={{ background: 'currentColor' }} />
                    <span className="size-3 rounded-sm" style={{ background: 'hsl(var(--primary))' }} />
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-xs font-medium leading-5 text-foreground">{theme.name}</span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">{theme.description}</span>
                </span>
                {selected && <Check className="mt-0.5 size-4 shrink-0 text-primary" />}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
