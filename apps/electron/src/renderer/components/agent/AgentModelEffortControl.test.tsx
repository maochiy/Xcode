import { describe, expect, test } from 'bun:test'
import { Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ModelOption } from '@proma/shared'
import { AgentModelEffortControl } from './AgentModelEffortControl'

const model: ModelOption = {
  channelId: 'test', channelName: '测试渠道', modelId: 'model-1', modelName: '模型 A', provider: 'custom',
}

describe('输入框模型与思考等级入口', () => {
  test('Given 已选择模型与等级 When 渲染输入框 Then 只显示一个合并入口', () => {
    const html = renderToStaticMarkup(<Provider><AgentModelEffortControl
      models={[model]}
      selectedModel={model}
      loading={false}
      modelSwitchDisabled={false}
      capability={{ levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' }}
      effortLevel="xhigh"
      onModelSelect={() => {}}
      onEffortChange={() => {}}
    /></Provider>)
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('模型与思考等级：模型 A，极高')
  })

  test('Given 目录未加载或模型不支持思考 When 渲染入口 Then 仍保留模型选择而不显示虚假等级', () => {
    const html = renderToStaticMarkup(<Provider><AgentModelEffortControl
      models={[]}
      selectedModel={model}
      loading={true}
      modelSwitchDisabled={false}
      capability={null}
      onModelSelect={() => {}}
      onEffortChange={() => {}}
    /></Provider>)
    expect(html).toContain('模型与思考等级：model-1')
    expect(html).not.toContain('极高')
  })
})
