import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserAgentTask } from '@proma/shared'
import { browserAgentTasksAtom } from '@/atoms/browser-atoms'
import { BrowserTasksPanel } from './BrowserTasksPanel'

const SESSION_ID = 'browser-task-panel-test'

function renderPanel(tasks: BrowserAgentTask[]): string {
  const store = createStore()
  store.set(browserAgentTasksAtom, new Map(tasks.map((task) => [task.taskId, task])))
  return renderToStaticMarkup(
    <Provider store={store}>
      <BrowserTasksPanel sessionId={SESSION_ID} onOpenTask={() => undefined} />
    </Provider>,
  )
}

describe('BrowserTasksPanel 浏览器任务状态', () => {
  test('Given 运行、等待用户、暂停、完成和失败任务 When 渲染列表 Then 只有运行中任务使用流光', () => {
    const statuses: BrowserAgentTask['status'][] = [
      'running',
      'waiting_user',
      'paused',
      'completed',
      'failed',
    ]
    const html = renderPanel(statuses.map((status, index) => ({
      taskId: status,
      sessionId: SESSION_ID,
      title: `任务 ${status}`,
      url: `https://example.com/${status}`,
      status,
      createdAt: index + 1,
      updatedAt: index + 1,
    })))

    expect(html).not.toContain('animate-spin')
    expect(html.match(/agent-status-shimmer/g)).toHaveLength(1)
    expect(html).not.toContain('aria-label="运行中"')
    expect(html).toContain('aria-label="等待用户操作"')
    expect(html).toContain('aria-label="已暂停"')
    expect(html).toContain('aria-label="已完成"')
    expect(html).toContain('aria-label="失败"')
  })
})
