import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BashResultRenderer } from './bash-result'

describe('BashResultRenderer 终端输出', () => {
  test('Given 长命令输出 When 渲染详情 Then 在可滚动输出窗内保留完整内容且不再嵌套展开层', () => {
    const result = Array.from(
      { length: 40 },
      (_, index) => `第 ${index + 1} 行输出`,
    ).join('\n')

    const html = renderToStaticMarkup(
      <BashResultRenderer
        result={result}
        isError={false}
        input={{ command: 'ls -la' }}
      />,
    )

    expect(html).toContain('$')
    expect(html).toContain('ls -la')
    expect(html).toContain('第 1 行输出')
    expect(html).toContain('第 40 行输出')
    expect(html).toContain('max-h-[300px]')
    expect(html).toContain('overflow-auto')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('bg-muted/50')
    expect(html).toContain('text-foreground/85')
    expect(html).not.toContain('展开全部')
  })

  test('Given Bash 返回真实错误 When 渲染详情 Then 错误输出保持主题错误色', () => {
    const html = renderToStaticMarkup(
      <BashResultRenderer
        result="command failed"
        isError
        input={{ command: 'false' }}
      />,
    )

    expect(html).toContain('command failed')
    expect(html).toContain('text-destructive')
    expect(html).toContain('dark:text-red-400')
  })
})
