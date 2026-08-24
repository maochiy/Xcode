import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentThinkingEffortControl } from './AgentThinkingEffortControl'

describe('AgentThinkingEffortControl 思考等级控件', () => {
  test('Given 模型支持思考等级 When 渲染控件 Then 只保留等级选择且不再提供展开思考过程开关', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl
        capability={{
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'medium',
        }}
        value="medium"
        onValueChange={() => {}}
      />,
    )
    const source = readFileSync(
      new URL('./AgentThinkingEffortControl.tsx', import.meta.url),
      'utf8',
    )

    expect(html).toContain('aria-label="思考等级：标准"')
    expect(source).not.toContain('展开思考过程')
    expect(source).not.toContain("components/ui/switch")
    expect(source).not.toContain('onExpandedChange')
  })
})
