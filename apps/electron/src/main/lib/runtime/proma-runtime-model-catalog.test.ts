import { describe, expect, test } from 'bun:test'
import type { ModelCenterModel } from '@proma/shared'

function usableModelCount(models: ModelCenterModel[]): number {
  return models.filter(model => model.hasApiKey || Boolean(model.oauthAccountId)).length
}

describe('Proma Runtime 模型中心路由契约', () => {
  test('Given 模型中心的公开模型配置 When 统计可用模型 Then 不读取或保存明文凭证', () => {
    const models: ModelCenterModel[] = [{
      id: 'model-a',
      name: 'Model A',
      provider: 'OpenAI',
      providerKey: 'openai',
      model: 'gpt-test',
      models: ['gpt-test'],
      baseUrl: 'https://provider.test/v1',
      apiMode: 'openai_chat_completions',
      hasApiKey: true,
      oauthAccountId: '',
      runtimeRevision: 'revision-a',
    }, {
      id: 'model-b',
      name: 'Model B',
      provider: 'Anthropic',
      providerKey: 'anthropic',
      model: 'claude-test',
      models: ['claude-test'],
      baseUrl: 'https://anthropic.test',
      apiMode: 'anthropic_messages',
      hasApiKey: false,
      oauthAccountId: 'oauth-account',
      runtimeRevision: 'revision-b',
    }]

    expect(usableModelCount(models)).toBe(2)
    expect(models[0]).not.toHaveProperty('apiKey')
  })
})
