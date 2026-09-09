/**
 * Bash 工具结果渲染器 — 终端风格
 *
 * 主题自适应背景、等宽字体、stderr 红色高亮
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

interface BashResultRendererProps {
  result: string
  isError: boolean
  input: Record<string, unknown>
}

/** 简单检测 stderr 行（常见模式） */
function classifyLine(line: string): 'stderr' | 'normal' {
  const lower = line.toLowerCase()
  if (
    lower.startsWith('error:') ||
    lower.startsWith('error ') ||
    lower.startsWith('fatal:') ||
    lower.startsWith('warning:') ||
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.startsWith('stderr:')
  ) {
    return 'stderr'
  }
  return 'normal'
}

export function BashResultRenderer({ result, isError, input }: BashResultRendererProps): React.ReactElement {
  const command = typeof input.command === 'string' ? input.command : undefined
  const lines = result.split('\n')

  return (
    <div
      aria-label="终端输出"
      className={cn(
        'max-h-[300px] overflow-auto rounded-md bg-muted/50 p-3',
        'font-mono text-[12px] leading-relaxed text-foreground/85',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
      role="log"
      tabIndex={0}
    >
      {command && (
        <div className="mb-2 select-none text-muted-foreground">
          <span className="text-emerald-600 dark:text-emerald-400">$</span> {command}
        </div>
      )}
      {lines.map((line, index) => {
        const type = isError ? 'stderr' : classifyLine(line)
        return (
          <div
            key={index}
            className={cn(
              'min-h-[1.25em] whitespace-pre-wrap break-all',
              type === 'stderr' && 'text-destructive dark:text-red-400',
            )}
          >
            {line || '\u200B'}
          </div>
        )
      })}
    </div>
  )
}
