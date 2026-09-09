import { describe, expect, test } from 'bun:test'
import { readSessionMessagesFromString } from '@proma/session-core'
import { buildPiHistoryMessages } from './pi-history-context'

describe('Pi 旧会话上下文迁移', () => {
  test('Given 混合旧扁平与 SDK 历史 When 迁移 Then 保留末条真实回答而不是盲目裁掉', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ role: 'user', content: '项目代号是什么', createdAt: 1 }),
      JSON.stringify({ type: 'assistant', uuid: 'a', message: { id: 'a', content: [{ type: 'text', text: '代号星河' }] } }),
    ].join('\n'))
    expect(buildPiHistoryMessages(messages)).toEqual([
      { role: 'user', content: '项目代号是什么' },
      { role: 'assistant', content: '代号星河' },
    ])
  })

  test('Given 用户前后发送相同文案 When 捕获发送前历史 Then 不按文本删除任何一轮', () => {
    const messages = readSessionMessagesFromString([
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '继续' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'a1', content: [{ type: 'text', text: '第一步' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: '继续' }] } }),
    ].join('\n'))
    expect(buildPiHistoryMessages(messages).map((message) => message.content))
      .toEqual(['继续', '第一步', '继续'])
  })
})
