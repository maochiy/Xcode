import { describe, expect, test } from 'bun:test'
import {
  buildQueuedMessageSendPayload,
  canAutoSendQueuedAgentMessage,
  createAgentQueuedMessage,
  markQueuedMessageSending,
  parseQueuedMessageMentions,
  resolveAgentQueuedDeliveryPlan,
  restoreQueuedMessagePending,
  shouldDeferAgentMessage,
} from './agent-message-queue'

const SOURCE_SESSION_ID = 'b5839484-13e3-4ac3-9415-9cb05caa446d'
const OTHER_SESSION_ID = 'bc42070b-483f-4352-bba6-b3f8714b5af9'

describe('Agent 暂停后续发队列', () => {
  test('Given 工具仍运行且已有新指令待消费 When 用户再次发送 Then 直接接入，不留在本地队列', () => {
    expect(shouldDeferAgentMessage({
      streaming: true,
      stopping: false,
      messagesRefreshing: true,
      immediateSending: true,
    })).toBe(false)
  })

  test('Given 已发出停止请求但 running 尚未清除 When 用户发送 Then 仍等待停止确认', () => {
    expect(shouldDeferAgentMessage({
      streaming: true,
      stopping: true,
      messagesRefreshing: false,
    })).toBe(true)
  })

  test('Given 用户已点击暂停但 Runtime 尚未完成收尾 When 立即发送下一条消息 Then 消息应进入等待队列', () => {
    expect(shouldDeferAgentMessage({
      streaming: false,
      stopping: true,
      messagesRefreshing: false,
    })).toBe(true)
  })

  test('Given 上一轮消息仍在同步 When 用户发送下一条消息 Then 消息应继续进入等待队列', () => {
    expect(shouldDeferAgentMessage({
      streaming: false,
      stopping: false,
      messagesRefreshing: true,
    })).toBe(true)
  })

  test('Given 暂停后的消息正在排队 When Runtime 未收尾 Then 不自动启动新一轮', () => {
    expect(canAutoSendQueuedAgentMessage({
      queueLength: 1,
      canSendNow: true,
      streaming: false,
      stopping: true,
      messagesRefreshing: false,
    })).toBe(false)
  })

  test('Given 暂停后的消息正在排队 When Runtime 已收尾且消息同步完成 Then 自动启动新一轮', () => {
    expect(canAutoSendQueuedAgentMessage({
      queueLength: 1,
      canSendNow: true,
      streaming: false,
      stopping: false,
      messagesRefreshing: false,
    })).toBe(true)
  })
})

describe('Agent 队列消息投递策略', () => {
  test('Given 当前 Turn 正在运行 When 普通追加消息 Then 使用原生 steering，不替代显式立即发送的停止流程', () => {
    expect(resolveAgentQueuedDeliveryPlan({
      streaming: true,
      backgroundWaiting: false,
    })).toEqual({
      kind: 'runtime-queue',
      interrupt: true,
    })
  })

  test('Given Runtime 正在后台等待 When 用户发送队列消息 Then 复用 Runtime 且不打断', () => {
    expect(resolveAgentQueuedDeliveryPlan({
      streaming: false,
      backgroundWaiting: true,
    })).toEqual({
      kind: 'runtime-queue',
      interrupt: false,
    })
  })

  test('Given 会话完全空闲 When 用户发送队列消息 Then 启动新的运行', () => {
    expect(resolveAgentQueuedDeliveryPlan({
      streaming: false,
      backgroundWaiting: false,
    })).toEqual({
      kind: 'new-run',
      interrupt: false,
    })
  })
})

describe('Agent 原生队列消费确认', () => {
  test('Given 消息已提交给 Pi When 尚未收到消费确认 Then 队列项保持发送中且不丢失', () => {
    const message = createAgentQueuedMessage('继续检查', 'message-1', 100)

    expect(markQueuedMessageSending([message], message.id)).toEqual([
      {
        ...message,
        deliveryState: 'sending',
      },
    ])
  })

  test('Given Pi 在消费前停止或失败 When queueAgentMessage 拒绝 Then 队列项恢复为可发送状态', () => {
    const message = {
      ...createAgentQueuedMessage('继续检查', 'message-1', 100),
      deliveryState: 'sending' as const,
    }

    expect(restoreQueuedMessagePending([message], message.id)).toEqual([
      createAgentQueuedMessage('继续检查', 'message-1', 100),
    ])
  })
})

describe('parseQueuedMessageMentions 会话 ID 引用', () => {
  test('Given 用户从会话菜单复制裸 ID When 粘贴到新会话 Then 识别为结构化会话引用', () => {
    const result = parseQueuedMessageMentions(
      `请读取会话 ${SOURCE_SESSION_ID}，然后继续完成剩余工作。`,
      [SOURCE_SESSION_ID, OTHER_SESSION_ID],
    )

    expect(result.mentionedSessionIds).toEqual([SOURCE_SESSION_ID])
    expect(result.cleanedText).toContain(SOURCE_SESSION_ID)
  })

  test('Given 文本只包含未知或不完整 ID When 解析引用 Then 不注入其他会话历史', () => {
    const result = parseQueuedMessageMentions(
      `排查 ${SOURCE_SESSION_ID.slice(0, -1)} 和 prefix${OTHER_SESSION_ID}`,
      [SOURCE_SESSION_ID, OTHER_SESSION_ID],
    )

    expect(result.mentionedSessionIds).toEqual([])
  })

  test('Given 同一会话同时使用 mention 和裸 ID When 解析引用 Then 自动去重', () => {
    const result = parseQueuedMessageMentions(
      `读取 &session:${SOURCE_SESSION_ID}，ID 是 ${SOURCE_SESSION_ID}`,
      [SOURCE_SESSION_ID],
    )

    expect(result.mentionedSessionIds).toEqual([SOURCE_SESSION_ID])
  })

  test('Given 队列消息含复制的会话 ID When 构建发送载荷 Then 保留可见原文并携带引用 ID', () => {
    const message = createAgentQueuedMessage(
      `根据 ${SOURCE_SESSION_ID} 继续执行`,
      'message-1',
      1,
    )

    const payload = buildQueuedMessageSendPayload(message, '', [SOURCE_SESSION_ID])

    expect(payload.rawText).toContain(SOURCE_SESSION_ID)
    expect(payload.sdkText).toContain(SOURCE_SESSION_ID)
    expect(payload.mentions.mentionedSessionIds).toEqual([SOURCE_SESSION_ID])
  })
})


test('Given 未消费的 steering 因停止或失败退回 When 会话空闲 Then 保留在队列但不自动重启 Agent', () => {
  expect(canAutoSendQueuedAgentMessage({
    queueLength: 1, canSendNow: true, streaming: false, stopping: false,
    messagesRefreshing: false, immediateSending: false, headRequiresManualSend: true,
  })).toBe(false)
})
