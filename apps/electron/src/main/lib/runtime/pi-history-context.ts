import type { SDKMessage } from '@proma/shared'
import { groupIntoTurns, toTranscript } from '@proma/session-core'

/** 从统一历史投影读取最近对话，不依赖旧扁平消息的 role 字段。 */
export function buildPiHistoryMessages(messages: SDKMessage[]): Array<{ role: string; content: string }> {
  return toTranscript(groupIntoTurns(messages))
    .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
    .slice(-24)
    .map((turn) => ({
      role: turn.role,
      content: [turn.text, ...turn.toolSummaries].filter(Boolean).join('\n'),
    }))
    .filter((message) => message.content.length > 0)
}
