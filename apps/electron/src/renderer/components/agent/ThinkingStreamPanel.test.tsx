import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  isThinkingScrollNearBottom,
  normalizeThinkingStreamContent,
  THINKING_STREAM_MAX_CHARS_PER_FRAME,
  THINKING_STREAM_MIN_DELAY_MS,
  ThinkingStreamPanel,
} from './ThinkingStreamPanel'

describe('ThinkingStreamPanel Cursor 风格思考流', () => {
  test('Given 正在生成的多行思考内容 When 渲染 Then 固定视口顶部使用白色渐隐遮罩', () => {
    const html = renderToStaticMarkup(
      <ThinkingStreamPanel
        content={'第一行思考。\n第二行思考。\n最新一行思考。'}
        running
      />,
    )

    expect(html).toContain('正在思考')
    expect(html).toContain('agent-status-shimmer')
    expect(html).not.toContain('12 秒')
    expect(html).toContain('第一行思考')
    expect(html).toContain('第二行思考')
    expect(html).toContain('最新一行思考')
    expect(html).toContain('data-thinking-scroll-viewport="true"')
    expect(html).toContain('agent-thinking-stream-surface')
    expect(html).toContain('agent-thinking-stream-top-fade')
    expect(html).toContain('data-thinking-top-fade="true"')
    expect(html).toContain('data-active="true"')
    expect(html).not.toContain('agent-thinking-stream-text-shadow')
    expect(html).not.toContain('agent-thinking-stream-history')
    expect(html).not.toContain('agent-thinking-stream-latest')
    expect(html).toContain('h-36')
    expect(html).toContain('overflow-y-scroll')
    expect(html).toContain('[scrollbar-gutter:stable]')
    expect(html).toContain('[overflow-anchor:none]')
    expect(html).toContain('py-2')
    expect(html).not.toContain('pt-10')
    expect(html).toContain('leading-[1.4]')
    expect(html).not.toContain('leading-5')
    expect(html).not.toContain('bg-muted')
    expect(html).not.toContain('rounded-xl')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('data-collapse-chevron')
    expect(html).not.toContain('max-h-0')
    expect(html).not.toContain('思考摘要')
  })

  test('Given 只有一行思考内容 When 渲染 Then 最新内容保持普通清晰文字', () => {
    const html = renderToStaticMarkup(
      <ThinkingStreamPanel content="只有最新一行。" running />,
    )

    expect(html).toContain('只有最新一行。')
    expect(html).not.toContain('agent-thinking-stream-text-shadow')
  })

  test('Given 思考内容白色遮罩 When 读取主题样式 Then 以百分之七十五透明遮罩覆盖整个视口', () => {
    const css = readFileSync(
      new URL('../../styles/globals.css', import.meta.url),
      'utf8',
    )
    const rule = css.match(/\.agent-thinking-stream-top-fade\s*\{([^}]+)\}/)?.[1] ?? ''

    expect(rule).toContain('position: absolute')
    expect(rule).toContain('inset: 0')
    expect(rule).not.toContain('height: 2.25rem')
    expect(rule).toContain('hsl(var(--background) / 0.75)')
    expect(rule).not.toContain('linear-gradient')
    expect(rule).toContain('pointer-events: none')
    expect(rule).toContain('opacity: 0')
    expect(css).toContain('.agent-thinking-stream-top-fade[data-active="true"]')
    expect(css).not.toContain('.agent-thinking-stream-text-shadow')
  })

  test('Given 尚无 thinking delta When 正在运行 Then 只显示一个等待标题且保留固定高度滚动区', () => {
    const html = renderToStaticMarkup(
      <ThinkingStreamPanel content="" running />,
    )

    expect(html).toContain('正在思考')
    expect(html.match(/正在思考/g)?.length).toBe(1)
    expect(html).toContain('data-agent-activity="thinking"')
    expect(html).toContain('data-thinking-scroll-viewport="true"')
    expect(html).toContain('data-active="false"')
    expect(html).toContain('h-36')
  })

  test('Given 思考已经完成 When 渲染 Then 面板自动隐藏', () => {
    const html = renderToStaticMarkup(
      <ThinkingStreamPanel
        content="已经完成分析。"
        running={false}
      />,
    )

    expect(html).toBe('')
  })

  test('Given 用户滚动位置 When 判断自动跟随 Then 仅接近底部时继续跟随', () => {
    expect(isThinkingScrollNearBottom({
      scrollHeight: 600,
      scrollTop: 432,
      clientHeight: 144,
    })).toBe(true)
    expect(isThinkingScrollNearBottom({
      scrollHeight: 600,
      scrollTop: 300,
      clientHeight: 144,
    })).toBe(false)
  })

  test('Given 第一段思考刚刚出现 When 尚未产生滚动 Then 透明遮罩也立即显示', () => {
    const html = renderToStaticMarkup(
      <ThinkingStreamPanel content="刚收到第一段思考。" running />,
    )

    expect(html).toContain('data-thinking-top-fade="true"')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('agent-status-shimmer')
  })

  test('Given 状态文字长度不同 When 读取动画样式 Then 正在思考使用独立且明显更慢的完整动画', () => {
    const css = readFileSync(
      new URL('../../styles/globals.css', import.meta.url),
      'utf8',
    )
    const rule = css.match(/\.agent-status-shimmer\s*\{([^}]+)\}/)?.[1] ?? ''

    expect(rule).toContain('-webkit-text-fill-color: transparent')
    expect(rule).toContain('hsl(0 0% 100% / 0.95)')
    expect(rule).toContain('background-size: 18px 100%')
    expect(rule).toContain('background-repeat: no-repeat')
    expect(rule).toContain('animation: agent-status-shimmer 1.2s linear infinite')
    expect(rule).not.toContain('background-size: 220% 100%')
    expect(rule).not.toContain('600ms')
    expect(css).toContain(
      '.agent-status-shimmer.agent-thinking-status-shimmer {\n  animation: agent-status-shimmer 2.8s linear infinite;',
    )
  })

  test('Given 正在思考与顶部已处理共用波纹 When 渲染标题 Then 字号一致并对短文字进行视觉速度补偿', () => {
    const html = renderToStaticMarkup(
      <ThinkingStreamPanel content="持续分析中。" running />,
    )

    expect(html).toContain('agent-status-shimmer')
    expect(html).toContain('agent-thinking-status-shimmer')
    expect(html).toContain('text-[14px]')
    expect(html).not.toContain('text-[13px] font-medium')
  })

  test('Given 多段思考包含空白行 When 展示 Then 合并为空白紧凑的连续行', () => {
    expect(normalizeThinkingStreamContent(
      '第一段思考。\n\n第二段思考。\n   \n\n第三段思考。',
    )).toBe('第一段思考。\n第二段思考。\n第三段思考。')
  })

  test('Given 思考流存在积压 When 平滑渲染 Then 每帧最多追赶两个字素且不额外跳帧', () => {
    expect(THINKING_STREAM_MIN_DELAY_MS).toBe(0)
    expect(THINKING_STREAM_MAX_CHARS_PER_FRAME).toBe(2)
  })
})
