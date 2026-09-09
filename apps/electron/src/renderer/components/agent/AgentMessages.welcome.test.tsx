import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import type { SDKMessage } from '@proma/shared'
import { AgentMessages } from './AgentMessages'

const firstMessage: SDKMessage = {
  type: 'user',
  uuid: 'welcome-first-message',
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text: '请帮我理解这个项目' }] },
}

function renderMessages(props: Partial<ComponentProps<typeof AgentMessages>> = {}): string {
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <AgentMessages
        sessionId="welcome-session"
        messagesLoaded
        streaming={false}
        projectName="Proma"
        persistedSDKMessages={[]}
        {...props}
      />
    </Provider>,
  )
}

describe('新建任务的首次欢迎页', () => {
  test('Given 项目下新建空会话 When 消息已加载 Then 显示项目名称和四个任务入口', () => {
    const html = renderMessages({ onSelectWelcomePrompt: () => {} })
    expect(html).toContain('Proma')
    expect(html).toContain('中构建什么？')
    expect(html).toContain('探索并理解代码')
    expect(html).toContain('审查代码')
    expect(html).not.toContain('接下来做什么？')
  })

  test('Given 未选择项目的新任务 When 打开首屏 Then 不展示虚构的项目名称', () => {
    const html = renderMessages({ projectName: null })
    expect(html).toContain('你想让我们构建什么？')
    expect(html).not.toContain('中构建什么？')
  })

  test('Given 历史消息尚未加载 When 暂时没有消息 Then 不闪现首次欢迎页', () => {
    expect(renderMessages({ messagesLoaded: false })).not.toContain('中构建什么？')
  })

  test('Given 空任务已发送首条消息 When 乐观用户消息出现 Then 欢迎页被正常消息替换', () => {
    const html = renderMessages({ persistedSDKMessages: [firstMessage], streaming: true })
    expect(html).not.toContain('中构建什么？')
    expect(html).not.toContain('探索并理解代码')
    expect(html).toContain('请帮我理解这个项目')
  })

  test('Given 首次任务已运行 When 尚未收到消息首帧 Then 不再显示欢迎页', () => {
    expect(renderMessages({ streaming: true })).not.toContain('中构建什么？')
  })

  test('Given 首次发送正在排队 When 等待 Runtime Then 不返回欢迎页', () => {
    expect(renderMessages({ waitingForQueuedRun: true })).not.toContain('中构建什么？')
  })

  test('Given 会话已有实时用户消息 When 消息尚未持久化 Then 继续展示对话而不是欢迎页', () => {
    const html = renderMessages({ liveMessages: [firstMessage] })
    expect(html).toContain('请帮我理解这个项目')
    expect(html).not.toContain('中构建什么？')
  })

  test('Given 首轮完成或停止 When 重新打开已有消息的会话 Then 保留现有对话展示', () => {
    for (const stoppedByUser of [false, true]) {
      const html = renderMessages({ persistedSDKMessages: [firstMessage], stoppedByUser })
      expect(html).toContain('请帮我理解这个项目')
      expect(html).not.toContain('中构建什么？')
    }
  })
})
