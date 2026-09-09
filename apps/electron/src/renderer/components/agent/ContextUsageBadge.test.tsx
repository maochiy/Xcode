import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { computeCacheHitRate, ContextUsageBadge } from './ContextUsageBadge'

function renderBadge(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <ContextUsageBadge
      inputTokens={props.inputTokens as number | undefined}
      outputTokens={props.outputTokens as number | undefined}
      cacheReadTokens={props.cacheReadTokens as number | undefined}
      cacheCreationTokens={props.cacheCreationTokens as number | undefined}
      cumulativeInputTokens={props.cumulativeInputTokens as number | undefined}
      cumulativeCacheReadTokens={props.cumulativeCacheReadTokens as number | undefined}
      cumulativeCacheCreationTokens={props.cumulativeCacheCreationTokens as number | undefined}
      contextWindow={props.contextWindow as number | undefined}
      isEstimated={props.isEstimated as boolean}
      autoCompactEnabled={props.autoCompactEnabled as boolean | undefined}
      autoCompactThreshold={props.autoCompactThreshold as number | undefined}
      effectiveContextWindow={props.effectiveContextWindow as number | undefined}
      isCompacting={props.isCompacting as boolean}
      isProcessing={props.isProcessing as boolean}
      onCompact={() => {}}
      sessionId="session-1"
      channelId={props.channelId as string | null | undefined}
      channelUpdatedAt={props.channelUpdatedAt as number | undefined}
    />,
  )
}

describe('ContextUsageBadge 上下文执行情况入口', () => {
  test('Given 只有上下文窗口没有 token usage When 渲染 Then 仍显示入口按钮', () => {
    const html = renderBadge({ contextWindow: 200_000, isEstimated: false, isCompacting: false, isProcessing: false })
    expect(html).toContain('<button')
    expect(html).toContain('<svg')
  })

  test('Given 无任何上下文元数据 When 渲染 Then 不显示入口', () => {
    const html = renderBadge({ isEstimated: false, isCompacting: false, isProcessing: false })
    expect(html).toBe('')
  })

  test('Given 只有压缩阈值没有 token usage When 渲染 Then 仍显示入口按钮', () => {
    const html = renderBadge({
      autoCompactEnabled: true,
      autoCompactThreshold: 150_000,
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('<button')
  })

  test('Given 有 token usage 与上下文窗口 When 渲染 Then 显示入口与占用比例', () => {
    const html = renderBadge({
      inputTokens: 24_000,
      contextWindow: 200_000,
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('<button')
    expect(html).toContain('<svg')
  })

  test('Given 压缩中 When 渲染 Then 显示 spinner 且禁用', () => {
    const html = renderBadge({
      inputTokens: 24_000,
      isEstimated: false,
      isCompacting: true,
      isProcessing: false,
    })
    expect(html).toContain('animate-spin')
    expect(html).toContain('disabled')
  })

  test('Given 无累计缓存数据 When 渲染 Then 不显示缓存命中率', () => {
    const html = renderBadge({
      inputTokens: 30_000,
      contextWindow: 200_000,
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).not.toContain('缓存命中率')
  })
})

describe('computeCacheHitRate 缓存命中率计算', () => {
  test('Given 净输入 90000 缓存读取 10000 When 计算 Then 返回 10%', () => {
    expect(computeCacheHitRate(90_000, 10_000)).toBe(10)
  })

  test('Given 全部命中 When 计算 Then 返回 100', () => {
    expect(computeCacheHitRate(0, 50_000)).toBe(100)
  })

  test('Given 无缓存读取 When 计算 Then 返回 0', () => {
    expect(computeCacheHitRate(50_000, 0)).toBe(0)
  })

  test('Given 无累计数据 When 计算 Then 返回 undefined', () => {
    expect(computeCacheHitRate(undefined, undefined)).toBeUndefined()
    expect(computeCacheHitRate(50_000, undefined)).toBeUndefined()
  })

  test('Given 运行中已有累计缓存 When 计算 Then 立即返回命中率', () => {
    expect(computeCacheHitRate(12_000, 30_000)).toBe(71)
  })
})
