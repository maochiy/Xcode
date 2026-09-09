import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentActivityItem } from '@/lib/agent-turn-presentation'
import { agentTimelineExpandedAtom } from '@/atoms/agent-timeline-atoms'
import { AgentActivityTimeline, ThinkingActivity } from './AgentActivityTimeline'

const items: AgentActivityItem[] = [
  { block: { type: 'thinking', thinking: '核对折扣约束。' }, index: 0, running: false, foldable: true },
  { block: { type: 'text', text: '开始查看文件。' }, index: 1, running: false, foldable: false },
  { block: { type: 'tool_use', id: 'r1', name: 'read', input: {} }, index: 2, running: false, foldable: true },
  { block: { type: 'tool_use', id: 'r2', name: 'read', input: {} }, index: 3, running: false, foldable: true },
  { block: { type: 'text', text: '接下来运行测试。' }, index: 4, running: false, foldable: false },
  { block: { type: 'tool_use', id: 'cmd', name: 'bash', input: {} }, index: 5, running: true, foldable: true },
]
function render(store = createStore(), props: Partial<React.ComponentProps<typeof AgentActivityTimeline>> = {}): string {
  return renderToStaticMarkup(<Provider store={store}>
    <AgentActivityTimeline items={items} stateKey="session/turn" renderItem={(item) => (
      item.block.type === 'text' ? <p>{String(item.block.text)}</p> : <span>工具明细-{item.index}</span>
    )} {...props} />
  </Provider>)
}

function renderThinking(
  store: ReturnType<typeof createStore>,
  props: React.ComponentProps<typeof ThinkingActivity>,
): string {
  return renderToStaticMarkup(
    <Provider store={store}>
      <ThinkingActivity stateKey="session/turn/thinking:0" {...props} />
    </Provider>,
  )
}

describe('Cursor 式活动时间线', () => {
  test('Given 思考内容包含 Markdown When 完整转录强制展开 Then 渲染段落与强调而非暴露星号标记', () => {
    const html = renderToStaticMarkup(
      <ThinkingActivity content={'**核对文件**\n\n检查 `index.ts`。'} running forceExpanded />,
    )
    expect(html).toContain('<strong>核对文件</strong>')
    expect(html).not.toContain('**核对文件**')
    expect(html).toContain('index.ts')
    expect(html.match(/正在思考/g)).toHaveLength(1)
    expect(html).toContain('aria-expanded="true"')
  })

  test('Given 命令间夹着已结束思考 When 工具组收起再展开 Then 只显示一个计数入口且原文顺序完整保留', () => {
    const store = createStore()
    const grouped: AgentActivityItem[] = [
      { block: { type: 'tool_use', id: 'cmd1', name: 'bash', input: {} }, index: 0, running: false, foldable: true },
      { block: { type: 'thinking', thinking: '命令间原始思考' }, index: 1, running: false, foldable: true },
      { block: { type: 'tool_use', id: 'cmd2', name: 'bash', input: {} }, index: 2, running: false, foldable: true },
    ]
    const collapsed = render(store, { items: grouped })
    expect(collapsed).toContain('已运行 2 条命令')
    expect(collapsed).not.toContain('已思考')
    const expanded = render(store, { items: grouped, fullTranscript: true })
    expect(expanded).toContain('命令间原始思考')
    expect(expanded.indexOf('工具明细-0')).toBeLessThan(expanded.indexOf('命令间原始思考'))
    expect(expanded.indexOf('命令间原始思考')).toBeLessThan(expanded.indexOf('工具明细-2'))
  })
  test('Given 正在思考且已有内容 When 尚未进行任何点击 Then 默认收起正文并显示状态标题', () => {
    const html = renderToStaticMarkup(<ThinkingActivity content="这段内容正在流式追加。" running />)
    expect(html).not.toContain('这段内容正在流式追加。')
    expect(html.match(/正在思考/g)).toHaveLength(1)
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('overflow-y-scroll')
  })
  test('Given 用户主动展开思考 When 后续流式增量到达 Then 保留展开选择并显示新增内容', () => {
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([['session/turn/thinking:0', true]]))

    const initialHtml = renderThinking(store, { content: '第一段。', running: true })
    expect(initialHtml).toContain('第一段。')
    expect(initialHtml).toContain('aria-expanded="true"')

    const incrementalHtml = renderThinking(store, { content: '第一段。新增片段。', running: true })
    expect(incrementalHtml).toContain('第一段。新增片段。')
    expect(incrementalHtml).toContain('aria-expanded="true"')
    expect(store.get(agentTimelineExpandedAtom).get('session/turn/thinking:0')).toBe(true)
  })
  test('Given 真实 thinking 状态尚无正文 When 渲染 Then 仍显示思考状态标题', () => {
    const html = renderToStaticMarkup(<ThinkingActivity content="" running />)
    expect(html).toContain('正在思考')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('data-agent-thinking-content')
  })
  test('Given 思考结束或暂停 When 不再运行 Then 原文仍可从历史入口展开且没有动画状态', () => {
    const store = createStore()
    const stoppedItems: AgentActivityItem[] = [
      { block: { type: 'thinking', thinking: '结束前保留的原文。' }, index: 0, running: false, foldable: true },
    ]
    expect(render(store, { items: stoppedItems })).toContain('已思考')
    store.set(agentTimelineExpandedAtom, new Map([['session/turn/thinking:0', true]]))
    const html = render(store, { items: stoppedItems })
    expect(html).toContain('结束前保留的原文。')
    expect(html).not.toContain('agent-status-shimmer')
  })
  test('Given 原生连续思考片段 When 当前片段运行 Then 仅显示一个思考入口并完整保留原文', () => {
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([['session/turn/thinking:0', true]]))
    const html = render(store, { items: [
      { block: { type: 'thinking', thinking: '第一段。' }, index: 0, running: false, foldable: true },
      { block: { type: 'thinking', thinking: '第二段。' }, index: 1, running: true, foldable: true },
    ] })
    expect(html.match(/正在思考/g)).toHaveLength(1)
    expect(html).not.toContain('已思考')
    expect(html).toContain('第一段。')
    expect(html).toContain('第二段。')
  })
  test('Given 正文和工具穿插 When 默认渲染 Then 保留全部阶段正文且仅收起明细', () => {
    const html = render()
    expect(html).toContain('已思考')
    expect(html).not.toContain('核对折扣约束。')
    expect(html).not.toContain('工具明细-')
    const labels = ['已思考', '开始查看文件。', '已查看 2 个文件', '接下来运行测试。', '正在运行 1 条命令']
    labels.forEach((label, index) => {
      expect(html).toContain(label)
      if (index) expect(html.indexOf(label)).toBeGreaterThan(html.indexOf(labels[index - 1]!))
    })
  })
  test('Given 用户已展开思考与工具组 When 整轮卸载重挂 Then 保留展开选择与原文', () => {
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([
      ['session/turn/thinking:0', true], ['session/turn/tool:r1', true],
    ]))
    render(store)
    const html = render(store)
    expect(html).toContain('核对折扣约束。')
    expect(html).toContain('工具明细-2')
    expect(html).toContain('工具明细-3')
    expect(html).not.toContain('工具明细-5')
  })
  test('Given 工具返回失败 When 渲染 Then 收起标题标明失败且默认展开出错组', () => {
    const html = render(createStore(), { failedToolIds: new Set(['r2']) })
    expect(html).toContain('已查看 2 个文件 · 1 项失败')
    expect(html).toContain('工具明细-2')
    expect(html).toContain('工具明细-3')
    expect(html).not.toContain('工具明细-5')
  })
  test('Given 暂停轮工具默认展开 When 用户手动收起 Then 新增快照不重新展开该组', () => {
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([['session/turn/tool:r1', false]]))
    const html = render(store, { revealTools: true, items: items.map(item => ({...item, running:false})) })
    expect(html).not.toContain('工具明细-2')
    expect(html).toContain('工具明细-5')
    expect(html).not.toContain('agent-status-shimmer')
  })
  test('Given 完整转录模式 When 渲染 Then 所有思考与工具可见且不受手动收起影响', () => {
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([['session/turn/thinking:0', false]]))
    const html = render(store, { fullTranscript: true })
    expect(html).toContain('核对折扣约束。')
    expect(html).toContain('工具明细-2')
    expect(html).toContain('工具明细-3')
    expect(html).toContain('工具明细-5')
  })
})
