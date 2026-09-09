import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@proma/shared'
import type { AgentActivityItem } from './agent-turn-presentation'
import {
  buildAgentActivityTimeline,
  getToolGroupLabel,
} from './agent-activity-timeline'

function activity(
  block: SDKContentBlock,
  index: number,
  running = false,
): AgentActivityItem {
  return {
    block,
    index,
    running,
    foldable: block.type !== 'text',
  }
}

function text(index: number, value: string): AgentActivityItem {
  return activity({ type: 'text', text: value }, index)
}

function thinking(index: number, value: string): AgentActivityItem {
  return activity({ type: 'thinking', thinking: value }, index)
}

function tool(
  index: number,
  id: string,
  name: string,
  running = false,
  input: Record<string, unknown> = {},
): AgentActivityItem {
  return activity({
    type: 'tool_use',
    id,
    name,
    input,
  }, index, running)
}

describe('Agent 活动时间线', () => {
  test('Given 连续思考片段 When 追加与重建 Then 共用稳定入口且不跨正文或工具合并', () => {
    const first = thinking(0, '首先分析')
    const timeline = buildAgentActivityTimeline([
      first, thinking(1, '继续分析'), text(2, '准备读取'),
      thinking(3, '检查文件'), tool(4, 'r1', 'read'), thinking(5, '分析结果'),
    ])
    expect(timeline.map(entry => entry.items.map(item => item.index))).toEqual([
      [0, 1], [2], [3], [4], [5],
    ])
    expect(timeline[0]?.id).toBe(buildAgentActivityTimeline([first])[0]?.id)
    expect(timeline[0]?.items[0]?.block).toBe(first.block)
  })
  test('Given 正文、thinking 与工具按原生顺序穿插 When 构建时间线 Then 工具间已结束思考归入工具组且保持原顺序', () => {
    const items = [
      text(0, '先说明'),
      tool(1, 'read-1', 'read'),
      tool(2, 'grep-1', 'grep'),
      thinking(3, '继续分析'),
      tool(4, 'bash-1', 'bash'),
      text(5, '最后说明'),
    ]

    const timeline = buildAgentActivityTimeline(items)

    expect(timeline.map((entry) => entry.kind)).toEqual([
      'text',
      'tools',
      'text',
    ])
    expect(timeline.map((entry) => entry.items.map((item) => item.index))).toEqual([
      [0],
      [1, 2, 3, 4],
      [5],
    ])
  })

  test('Given 输入索引非递增且工具 id 重复 When 构建时间线 Then 不排序也不去重', () => {
    const timeline = buildAgentActivityTimeline([
      tool(8, 'same-tool', 'Read'),
      tool(3, 'same-tool', 'Read'),
      text(5, '保持输入位置'),
    ])

    expect(timeline.map((entry) => entry.items.map((item) => item.index))).toEqual([
      [8, 3],
      [5],
    ])
    expect(timeline[0]?.items).toHaveLength(2)
  })

  test('Given 两组工具之间存在过程正文 When 构建时间线 Then 正文截断工具组且不跨正文合并', () => {
    const timeline = buildAgentActivityTimeline([
      tool(0, 'read-before', 'Read'),
      text(1, '读取后说明'),
      tool(2, 'read-after', 'read_file'),
    ])

    expect(timeline).toHaveLength(3)
    expect(timeline.map((entry) => entry.kind)).toEqual(['tools', 'text', 'tools'])
  })

  test('Given 两组工具之间存在已结束 thinking When 构建时间线 Then 合组但工具计数不包含思考', () => {
    const timeline = buildAgentActivityTimeline([
      tool(0, 'grep-before', 'Grep'),
      thinking(1, '分析搜索结果'),
      tool(2, 'glob-after', 'Glob'),
    ])

    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.items.map(item => item.index)).toEqual([0, 1, 2])
    expect(getToolGroupLabel(timeline[0]!.items)).toBe('已搜索 2 项')
  })

  test('Given 工具后的思考仍在运行 When 下个工具尚未开始 Then 实时思考独立可见而不是藏进工具组', () => {
    const timeline = buildAgentActivityTimeline([
      tool(0, 'done', 'bash'),
      activity({ type: 'thinking', thinking: '实时新增内容' }, 1, true),
    ])
    expect(timeline.map(entry => entry.kind)).toEqual(['tools', 'thinking'])
  })

  test('Given 多个已结束思考位于工具之间 When 合组 Then 不修改原数据且沿用首工具的稳定标识', () => {
    const items = [tool(0, 'first', 'bash'), thinking(1, '一'), thinking(2, '二'), tool(3, 'last', 'bash', true)]
    const timeline = buildAgentActivityTimeline(items)
    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.id).toBe('tool:first')
    expect(timeline[0]?.items).toEqual(items)
    expect(timeline[0]?.items[1]).toBe(items[1])
    expect(getToolGroupLabel(timeline[0]!.items)).toBe('正在运行 2 条命令')
  })

  test('Given 未知工具与已知工具相邻 When 生成摘要 Then 不误分类并使用通用混合标签', () => {
    const items = [
      tool(0, 'custom-1', 'web_search'),
      tool(1, 'read-1', 'Read'),
    ]

    expect(getToolGroupLabel(items)).toBe('已调用 2 个工具')
    expect(getToolGroupLabel([
      tool(0, 'edit-1', 'edit'),
      tool(1, 'write-1', 'write'),
    ])).toBe('已调用 2 个工具')
  })

  test('Given 工具组后续追加相邻工具 When 重建时间线 Then id 始终取首个工具 block id', () => {
    const initial = buildAgentActivityTimeline([
      tool(4, 'stable-tool', 'read'),
    ])
    const appended = buildAgentActivityTimeline([
      tool(4, 'stable-tool', 'read'),
      tool(5, 'next-tool', 'grep'),
    ])
    const nonTool = buildAgentActivityTimeline([
      text(7, '过程正文'),
      activity({ type: 'custom_block' }, 8),
    ])

    expect(initial[0]?.id).toBe('tool:stable-tool')
    expect(appended[0]?.id).toBe(initial[0]?.id)
    expect(nonTool.map((entry) => entry.id)).toEqual(['text:7', 'custom_block:8'])
  })

  test('Given Pi 与现有命名的同类工具均已结束 When 生成摘要 Then 返回对应完成标签', () => {
    expect(getToolGroupLabel([
      tool(0, 'read-1', 'read'),
      tool(1, 'read-2', 'NotebookRead'),
      tool(2, 'read-3', 'read_file'),
    ])).toBe('已查看 3 个文件')
    expect(getToolGroupLabel([
      tool(0, 'bash-1', 'bash'),
      tool(1, 'execute-1', 'Execute'),
      tool(2, 'terminal-1', 'run_command'),
    ])).toBe('已运行 3 条命令')
    expect(getToolGroupLabel([
      tool(0, 'grep-1', 'grep'),
      tool(1, 'find-1', 'find'),
      tool(2, 'ls-1', 'LS'),
      tool(3, 'search-1', 'search_files'),
    ])).toBe('已搜索 4 项')
  })

  test('Given 当前工具提供真实任务目标 When 生成运行摘要 Then 优先展示description或title而不是计数', () => {
    expect(getToolGroupLabel([
      tool(0, 'bash-description', 'Bash', true, {
        description: 'Verify 24 coin states unique outcomes',
      }),
    ])).toBe('正在运行 Verify 24 coin states unique outcomes')
    expect(getToolGroupLabel([
      tool(0, 'bash-title', 'Bash', true, {
        title: '检查构建产物',
      }),
    ])).toBe('正在运行 检查构建产物')
    expect(getToolGroupLabel([
      tool(0, 'read-path', 'Read', true, {
        description: '不应替代真实文件路径',
        file_path: '/workspace/package.json',
      }),
    ])).toBe('正在查看 /workspace/package.json')
  })

  test('Given 带目标描述的工具已经完成 When 生成摘要 Then 保持原有完成计数行为', () => {
    expect(getToolGroupLabel([
      tool(0, 'bash-1', 'Bash', false, { description: '运行单测' }),
      tool(1, 'bash-2', 'Bash', false, { title: '检查类型' }),
    ])).toBe('已运行 2 条命令')
  })

  test('Given 工具组包含多个活动 When 生成运行摘要 Then 选择最后一个真实运行工具的目标和类别', () => {
    expect(getToolGroupLabel([
      tool(0, 'read-done', 'Read', false, { file_path: '/workspace/old.ts' }),
      tool(1, 'bash-old', 'Bash', true, { description: '旧运行目标' }),
      tool(2, 'bash-current', 'Bash', true, { description: '当前运行目标' }),
    ])).toBe('正在运行 当前运行目标')
  })

  test('Given 命令或读取工具没有可用字符串目标 When 生成运行摘要 Then 保持原计数fallback且不伪造描述', () => {
    expect(getToolGroupLabel([
      tool(0, 'bash-empty', 'Bash', true, {
        description: 24,
        title: { text: '非字符串标题' },
      }),
    ])).toBe('正在运行 1 条命令')
    expect(getToolGroupLabel([
      tool(0, 'read-empty', 'Read', true, {
        file_path: 42,
        path: '',
      }),
    ])).toBe('正在查看 1 个文件')
  })

  test('Given 其他工具带有附加description或title When 生成运行摘要 Then 仍使用真实工具name', () => {
    expect(getToolGroupLabel([
      tool(0, 'search-running', 'search_files', true, {
        description: '不应伪装成搜索目标',
      }),
    ])).toBe('正在搜索 search_files')
    expect(getToolGroupLabel([
      tool(0, 'custom-running', 'custom_tool', true, {
        title: '不应替代真实工具名',
      }),
    ])).toBe('正在调用 custom_tool')
  })

  test('Given 工具组中任一工具仍在运行 When 生成摘要 Then 使用对应正在进行标签', () => {
    expect(getToolGroupLabel([
      tool(0, 'read-1', 'Read'),
      tool(1, 'read-2', 'read', true),
    ])).toBe('正在查看 2 个文件')
    expect(getToolGroupLabel([
      tool(0, 'bash-1', 'Bash', true),
    ])).toBe('正在运行 1 条命令')
    expect(getToolGroupLabel([
      tool(0, 'grep-1', 'Glob'),
      tool(1, 'grep-2', 'search', true),
    ])).toBe('正在搜索 search')
    expect(getToolGroupLabel([
      tool(0, 'custom-1', 'custom_tool', true),
      tool(1, 'read-1', 'Read'),
    ])).toBe('正在调用 custom_tool')
  })
})
