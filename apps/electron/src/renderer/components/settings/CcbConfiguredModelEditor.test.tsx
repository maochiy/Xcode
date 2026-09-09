import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CcbConfiguredModelEditor } from './CcbConfiguredModelEditor'
import type { ThinkingEffortLevel } from '@proma/shared'

function render(effortLevels?: ThinkingEffortLevel[]): string {
  return renderToStaticMarkup(
    <CcbConfiguredModelEditor value={{ id: 'test-model', effortLevels }} onChange={() => {}} />,
  )
}

describe('模型编辑器默认思考等级', () => {
  test('Given 新模型或旧模型未配置等级 When 打开编辑器 Then 统一四档全部选中且可编辑', () => {
    const html = render()
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(4)
    expect(html).toContain('轻度')
    expect(html).toContain('中')
    expect(html).toContain('高')
    expect(html).toContain('极高')
    expect(html).not.toContain('disabled=""')
  })

  test('Given 手动取消全部等级 When 重新打开 Then 仍全部未选中', () => {
    expect(render([]).match(/aria-pressed="false"/g)).toHaveLength(4)
  })

  test('Given 手动选择子集 When 重新打开 Then 只选中指定等级', () => {
    const html = render(['medium', 'high'])
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2)
  })

  test('Given 旧配置使用 max When 打开编辑器 Then 归并选中 xhigh 且不额外渲染第五档', () => {
    const html = render(['max'])
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html.match(/aria-pressed=/g)).toHaveLength(4)
    expect(html).toContain('极高')
  })
})
