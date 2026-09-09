import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentThinkingEffortControl } from './AgentThinkingEffortControl'

const commonProps = {
  modelName: '测试模型',
  onModelClick: () => {},
  onValueChange: () => {},
}

describe('AgentThinkingEffortControl 思考等级面板', () => {
  test('Given 模型支持全部等级 When 渲染面板 Then 展示四档滑杆、模型入口、重置与不可用的快速模式', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl
        {...commonProps}
        capability={{ levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'medium' }}
        value="high"
      />,
    )

    expect(html).toContain('aria-valuemax="3"')
    expect(html).toContain('aria-valuetext="高"')
    expect(html).toContain('选择模型，当前：测试模型')
    expect(html).toContain('重置思考等级')
    expect(html).toContain('快速模式（当前内核暂不支持）')
    expect(html).not.toContain('展开思考过程')
  })

  test('Given 模型仅支持一个等级 When 渲染面板 Then 滑杆禁用且数值有效', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl {...commonProps} capability={{ levels: ['high'], defaultLevel: 'high' }} value="high" />,
    )
    expect(html).toContain('data-disabled')
    expect(html).not.toContain('NaN')
    expect(html).toContain('aria-valuetext="高"')
  })

  test('Given 上次选择极高 When 首次打开面板 Then 保留档位且不启用位置过渡，蓝色与参考图一致', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl
        {...commonProps}
        capability={{ levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' }}
        value="xhigh"
      />,
    )

    expect(html).toContain('aria-valuenow="3"')
    expect(html).toContain('aria-valuetext="极高"')
    expect(html).not.toContain('transition-[left')
    expect(html).toContain('bg-[#3A83F7]')
    expect(html).toContain('text-[#3A83F7]')
  })

  test('Given 模型关闭思考等级 When 渲染面板 Then 保留模型入口但不渲染滑杆', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl {...commonProps} capability={null} />,
    )
    expect(html).toContain('该模型未启用思考等级')
    expect(html).toContain('选择模型，当前：测试模型')
    expect(html).not.toContain('role="slider"')
  })
})
