import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKToolUseBlock } from '@proma/shared'
import type { AgentActivityItem } from '@/lib/agent-turn-presentation'
import {
  AgentToolCallShelf,
  splitAgentToolCallShelf,
} from './AgentToolCallShelf'

function tool(
  id: string,
  name: string,
  running = false,
): AgentActivityItem {
  return {
    block: {
      type: 'tool_use',
      id,
      name,
      input: {},
    } as SDKToolUseBlock,
    index: Number(id.replace(/\D/g, '')) || 0,
    foldable: true,
    running,
  }
}

describe('AgentToolCallShelf 流式最新工具展示', () => {
  test('Given 只有一个工具调用 When 渲染 Then 直接显示且不出现历史折叠入口', () => {
    const html = renderToStaticMarkup(
      <AgentToolCallShelf
        items={[tool('tool-1', 'Read')]}
        renderItem={(item) => (
          <span>{(item.block as SDKToolUseBlock).name}</span>
        )}
      />,
    )

    expect(html).toContain('data-agent-tool-latest="true"')
    expect(html).toContain('Read')
    expect(html).not.toContain('工具调用')
  })

  test('Given 多个工具调用 When 渲染 Then 最新工具替换占位标题且接收旧工具作为折叠内容', () => {
    const html = renderToStaticMarkup(
      <AgentToolCallShelf
        items={[
          tool('tool-1', 'Read'),
          tool('tool-2', 'Bash'),
          tool('tool-3', 'Grep'),
        ]}
        renderItem={(item, placement, historyNodes) => (
          <div data-placement={placement}>
            <span>{(item.block as SDKToolUseBlock).name}</span>
            {historyNodes}
          </div>
        )}
      />,
    )

    expect(html).not.toContain('工具调用')
    expect(html).toContain('data-agent-tool-history="true"')
    expect(html).toContain('Read')
    expect(html).toContain('Bash')
    expect(html).toContain('data-agent-tool-latest="true"')
    expect(html).toContain('data-agent-tool-history-count="2"')
    expect(html).toContain('Grep')
    expect(html.indexOf('Grep')).toBeLessThan(html.indexOf('Read'))
  })

  test('Given 后来出现新工具 When 重新归纳 Then 原最新工具进入历史且新工具替换直接显示项', () => {
    const first = splitAgentToolCallShelf([
      tool('tool-1', 'Read'),
      tool('tool-2', 'Bash'),
    ])
    const next = splitAgentToolCallShelf([
      tool('tool-1', 'Read'),
      tool('tool-2', 'Bash'),
      tool('tool-3', 'Grep'),
    ])

    expect((first.latest?.block as SDKToolUseBlock).name).toBe('Bash')
    expect(first.history.map((item) => (item.block as SDKToolUseBlock).name)).toEqual([
      'Read',
    ])
    expect((next.latest?.block as SDKToolUseBlock).name).toBe('Grep')
    expect(next.history.map((item) => (item.block as SDKToolUseBlock).name)).toEqual([
      'Read',
      'Bash',
    ])
  })

  test('Given 最新工具仍在执行 When 展示 Shelf Then 显式标记为运行中供白色波纹状态校验', () => {
    const html = renderToStaticMarkup(
      <AgentToolCallShelf
        items={[
          tool('tool-1', 'Read'),
          tool('tool-2', 'Bash', true),
        ]}
        renderItem={(item) => (
          <span className={item.running ? 'agent-status-shimmer' : undefined}>
            {(item.block as SDKToolUseBlock).name}
          </span>
        )}
      />,
    )

    expect(html).toContain('data-agent-tool-running="true"')
    expect(html).toContain('agent-status-shimmer')
  })

  test('Given 最新工具已经结束 When 展示 Shelf Then 移除运行标记且不再显示白色波纹', () => {
    const html = renderToStaticMarkup(
      <AgentToolCallShelf
        items={[tool('tool-1', 'Read')]}
        renderItem={(item) => (
          <span className={item.running ? 'agent-status-shimmer' : undefined}>
            {(item.block as SDKToolUseBlock).name}
          </span>
        )}
      />,
    )

    expect(html).toContain('data-agent-tool-running="false"')
    expect(html).not.toContain('agent-status-shimmer')
  })
})
