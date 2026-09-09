import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CursorTurnPresentation } from '@/lib/agent-cursor-turn'
import { agentTimelineExpandedAtom } from '@/atoms/agent-timeline-atoms'
import { AgentTurnTimeline } from './AgentTurnTimeline'

const completed: CursorTurnPresentation = {
  id: 'turn',
  status: 'completed',
  durationMs: 20000,
  activities: [
    { block: { type: 'text', text: '读取后的过程说明' }, index: 0, running: false, foldable: false },
    { block: { type: 'tool_use', id: 'read', name: 'read', input: {} }, index: 1, running: false, foldable: true },
  ],
  finalItems: [{ kind: 'answer', block: { type: 'text', text: '最终答案' }, index: 2 }],
  showThinkingPlaceholder: false,
  showWaitingPlaceholder: false,
}

function render(presentation = completed, store = createStore()): string {
  return renderToStaticMarkup(<Provider store={store}>
    <AgentTurnTimeline
      presentation={presentation}
      sessionId="session"
      renderActivity={item => <p>{item.block.type === 'text' ? String(item.block.text) : '工具详情'}</p>}
      renderFinal={block => <p>{block.type === 'text' ? String(block.text) : ''}</p>}
    />
  </Provider>)
}

describe('整轮时间线交互', () => {
  test('Given 完成且有阶段正文与工具 When 默认渲染 Then 原位保留正文和工具标题并在底部显示答案与元信息', () => {
    const html = render()
    expect(html).toContain('data-agent-turn-timeline="completed"')
    expect(html).toContain('读取后的过程说明')
    expect(html).toContain('已查看 1 个文件')
    expect(html).not.toContain('工具详情')
    expect(html).toContain('最终答案')
    expect(html).toContain('已处理 20 秒')
    expect(html).not.toContain('正在思考')
    const processIndex = html.indexOf('读取后的过程说明')
    const toolIndex = html.indexOf('已查看 1 个文件')
    const finalIndex = html.indexOf('最终答案')
    const statusIndex = html.indexOf('已处理 20 秒')
    expect(toolIndex).toBeGreaterThan(processIndex)
    expect(finalIndex).toBeGreaterThan(toolIndex)
    expect(statusIndex).toBeGreaterThan(finalIndex)
  })

  test('Given 旧整轮展开状态为 false When 重新挂载 Then 不再隐藏阶段正文和工具标题', () => {
    const store = createStore()
    store.set(agentTimelineExpandedAtom, new Map([['session/turn/turn', false]]))
    render(completed, store)
    const html = render(completed, store)
    expect(html).toContain('读取后的过程说明')
    expect(html).toContain('已查看 1 个文件')
    expect(html).toContain('最终答案')
  })

  test('Given 完成 Turn When 渲染底部元信息 Then 不提供整轮折叠开关', () => {
    const html = render()
    expect(html).toContain('已处理 20 秒')
    expect(html).not.toContain(
      'class="inline-flex min-h-7 max-w-full items-center gap-1 rounded-md text-left outline-none',
    )
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1)
  })

  test('Given 正在等待下次模型输出 When 运行 Then 过程保持展示且只有底部中性扫光状态', () => {
    const html = render({
      ...completed, status: 'running', finalItems: [], showWaitingPlaceholder: true,
    })
    expect(html).toContain('读取后的过程说明')
    expect(html.match(/正在准备下一步/g)).toHaveLength(1)
    expect(html).toContain('data-agent-activity="waiting"')
    expect(html).toContain('agent-status-shimmer')
    expect(html).not.toContain('正在思考')
    expect(html).not.toContain('正在处理')
    expect(html).not.toContain('已处理 20 秒')
    expect(html.indexOf('正在准备下一步')).toBeGreaterThan(html.indexOf('已查看 1 个文件'))
  })

  test('Given 用户停止且已有工具 When 渲染 Then 保留过程与工具明细并把停止元信息放在末尾', () => {
    const html = render({ ...completed, status: 'stopped', finalItems: [] })
    expect(html).toContain('data-agent-turn-timeline="stopped"')
    expect(html).toContain('读取后的过程说明')
    expect(html).toContain('已查看 1 个文件')
    expect(html).toContain('工具详情')
    expect(html).toContain('你在 20 秒 后停止了')
    expect(html).not.toContain('agent-status-shimmer')
    expect(html).not.toContain('正在思考')
    expect(html.indexOf('你在 20 秒 后停止了')).toBeGreaterThan(
      html.indexOf('工具详情'),
    )
  })

  test('Given 完整转录或隐藏 final When 渲染 Then 仍保留各自的展开和隐藏语义', () => {
    const transcriptHtml = render(completed)
    const fullTranscriptHtml = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentTurnTimeline
          presentation={completed}
          sessionId="session"
          fullTranscript
          renderActivity={item => <p>{item.block.type === 'text' ? String(item.block.text) : '工具详情'}</p>}
          renderFinal={block => <p>{block.type === 'text' ? String(block.text) : ''}</p>}
        />
      </Provider>,
    )
    const hiddenFinalHtml = renderToStaticMarkup(
      <Provider store={createStore()}>
        <AgentTurnTimeline
          presentation={completed}
          sessionId="session"
          hideFinalItems
          renderActivity={item => <p>{item.block.type === 'text' ? String(item.block.text) : '工具详情'}</p>}
          renderFinal={block => <p>{block.type === 'text' ? String(block.text) : ''}</p>}
        />
      </Provider>,
    )

    expect(transcriptHtml).not.toContain('工具详情')
    expect(fullTranscriptHtml).toContain('工具详情')
    expect(hiddenFinalHtml).toContain('读取后的过程说明')
    expect(hiddenFinalHtml).toContain('已查看 1 个文件')
    expect(hiddenFinalHtml).not.toContain('最终答案')
    expect(hiddenFinalHtml).toContain('已处理 20 秒')
  })
})
