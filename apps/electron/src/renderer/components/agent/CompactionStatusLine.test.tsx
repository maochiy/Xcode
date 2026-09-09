import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompactionStatusLine } from './CompactionStatusLine'

describe('CompactionStatusLine Cursor 压缩状态行', () => {
  test('Given 上下文正在压缩 When 渲染 Then 只有正文起点的单行灰字且没有 spinner 或卡片', () => {
    const html = renderToStaticMarkup(<CompactionStatusLine status="running" />)

    expect(html).toContain('data-agent-compaction-bubble-id="summarization"')
    expect(html).toContain('data-agent-compaction-status="running"')
    expect(html).toContain('px-4')
    expect(html).toContain('text-muted-foreground')
    expect(html).toContain('正在压缩上下文')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('border')
    expect(html).not.toContain('bg-')
  })

  test.each([
    ['manual', '手动触发。'],
    ['auto', '自动触发。'],
  ] as const)('Given %s 压缩完成 When 渲染 Then 状态与悬浮提示使用中文且不改变布局', (trigger, sourceLabel) => {
    const html = renderToStaticMarkup(
      <CompactionStatusLine
        status="success"
        trigger={trigger}
        preTokens={168_000}
        postTokens={24_000}
      />,
    )

    expect(html).toContain('data-agent-compaction-status="success"')
    expect(html).toContain('上下文已压缩')
    expect(html).not.toContain(`${sourceLabel}</div>`)
    expect(html).not.toContain('168.0k → 24.0k tokens。</div>')
    expect(html).toContain(`title="${sourceLabel} 上下文约 168.0k → 24.0k tokens。"`)
    expect(html).not.toMatch(/Summarizing|summarized|Triggered|Context approximately/)
  })

  test('Given 压缩停止、失败或无需执行 When 渲染 Then 各终态仍保留同款状态行', () => {
    const stopped = renderToStaticMarkup(<CompactionStatusLine status="stopped" />)
    const failed = renderToStaticMarkup(
      <CompactionStatusLine status="failed" detail="provider unavailable" />,
    )
    const noop = renderToStaticMarkup(<CompactionStatusLine status="noop" />)

    expect(stopped).toContain('上下文压缩已停止')
    expect(failed).toContain('上下文压缩失败')
    expect(failed).toContain('title="provider unavailable"')
    expect(failed).not.toContain('provider unavailable</div>')
    expect(noop).toContain('当前上下文无需压缩')
  })
})
