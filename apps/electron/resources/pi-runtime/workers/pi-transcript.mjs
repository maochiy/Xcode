import { randomUUID } from 'node:crypto';

/**
 * steer 只负责在工具边界投递，不会自动撤销模型记住的旧任务目标。
 * 单独传达“更新当前任务”的语义；显示原文仍由 _promaDisplayText 保留。
 */
function currentTaskUpdate(text) {
  return `<proma_current_task_update>
用户在执行过程中点击了“立即发送”。下面的新指令更新当前任务，不是回答后自动返回旧任务的旁支消息。
已经开始的工具可以自然完成，保留其结果；尚未执行的旧计划不再自动继续。
请以这条最新指令的意图决定下一步：如果用户转向新问题或新任务，只完成新请求，答完即结束，不自行恢复、补完或汇报旧任务。
如果新指令明确要求继续、补充或调整原任务，则按新的要求继续。旧对话和工具结果仅作为上下文，不代表仍需完成的待办。
</proma_current_task_update>

${text}`;
}

/**
 * Pi 消息生命周期是投影的唯一顺序来源。
 * 同一条 assistant 的 partial/final 共享身份，不拼接整轮输出来猜测消息边界。
 */
export function createPiTranscript(sessionId, emit, uuid = randomUUID) {
  let assistantId;
  let assistantCreatedAt;
  let assistantActivityPhase = 'idle';
  const accepted = new Set();
  const consumed = new Set();

  function project(message, id, createdAt, partial = false, queued, activityPhase) {
    const base = {
      uuid: id,
      session_id: sessionId,
      parent_tool_use_id: null,
      _createdAt: createdAt,
      _promaNativeMessage: true,
    };
    if (message.role === 'assistant') {
      const content = (message.content || []).flatMap((block) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'thinking') return [{ type: 'thinking', thinking: block.thinking }];
        if (block.type === 'toolCall') {
          return [{ type: 'tool_use', id: block.id, name: block.name, input: block.arguments || {} }];
        }
        return [];
      });
      return {
        ...base,
        type: 'assistant',
        message: { id, role: 'assistant', content, model: message.model },
        _promaActivityPhase: activityPhase,
        ...(partial ? { _partial: true } : {}),
      };
    }
    if (message.role === 'toolResult') {
      return {
        ...base,
        type: 'user',
        message: { content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content || [],
          is_error: Boolean(message.isError),
        }] },
      };
    }
    if (message.role === 'user' && queued) {
      return {
        ...base,
        type: 'user',
        message: { content: [{ type: 'text', text: queued.rawText }] },
        _promaQueuedDuringStreaming: true,
      };
    }
  }

  function resolveAssistantActivityPhase(event, message) {
    const eventType = event.assistantMessageEvent?.type;
    if (eventType === 'thinking_start' || eventType === 'thinking_delta') return 'thinking';
    if (eventType === 'text_start' || eventType === 'text_delta') return 'text';
    if (eventType === 'toolcall_start' || eventType === 'toolcall_delta') return 'tool';
    if (
      eventType === 'thinking_end'
      || eventType === 'text_end'
      || eventType === 'toolcall_end'
    ) return 'idle';
    if (event.assistantMessageEvent) return assistantActivityPhase;

    // 仅兼容缺少 assistantMessageEvent 的旧调用方；实时阶段以 Pi 原生事件为准。
    const lastBlock = Array.isArray(message.content) ? message.content.at(-1) : undefined;
    if (lastBlock?.type === 'thinking') return 'thinking';
    if (lastBlock?.type === 'text') return 'text';
    if (lastBlock?.type === 'toolCall') return 'tool';
    return assistantActivityPhase;
  }

  return {
    /** 入队只登记身份，用户消息必须等 Pi 消费后才进入 transcript。 */
    async enqueue(session, text, options = {}) {
      const id = options.uuid || uuid();
      if (accepted.has(id)) return;
      accepted.add(id);
      try {
        // 使用 Pi Agent 原生消息队列，身份随 UserMessage 一起进入上下文。
        // 宿主已经处理 mention/提示词；无需再展开命令，更不能按文本匹配回执。
        const message = {
          role: 'user',
          content: [{ type: 'text', text: options.interrupt === false ? text : currentTaskUpdate(text) }],
          timestamp: Date.now(),
          _promaMessageUuid: id,
          _promaDisplayText: options.rawText ?? text,
        };
        if (options.interrupt === false) session.agent.followUp(message);
        else session.agent.steer(message);
      } catch (error) {
        accepted.delete(id);
        throw error;
      }
    },
    handle(event) {
      const message = event.message;
      if (!message) return;
      if (message.role === 'assistant' && event.type === 'message_start') {
        assistantId = uuid();
        assistantCreatedAt = Date.now();
        assistantActivityPhase = 'waiting';
        emit(project(
          { ...message, content: [] },
          assistantId,
          assistantCreatedAt,
          true,
          undefined,
          assistantActivityPhase,
        ));
        return;
      }
      if (event.type !== 'message_update' && event.type !== 'message_end') return;
      if (message.role === 'assistant') {
        assistantId ||= uuid();
        assistantCreatedAt ??= Date.now();
        const partial = event.type === 'message_update';
        assistantActivityPhase = partial
          ? resolveAssistantActivityPhase(event, message)
          : 'idle';
        if (!partial) message._promaMessageUuid = assistantId;
        emit(project(
          message,
          assistantId,
          assistantCreatedAt,
          partial,
          undefined,
          assistantActivityPhase,
        ));
        if (!partial) {
          assistantId = undefined;
          assistantCreatedAt = undefined;
          assistantActivityPhase = 'idle';
        }
      } else if (event.type === 'message_end' && message.role === 'toolResult') {
        const id = message._promaMessageUuid || uuid();
        message._promaMessageUuid = id;
        emit(project(message, id, Date.now()));
      } else if (event.type === 'message_end' && message.role === 'user') {
        // 初始输入和内部续写没有宿主队列身份，不能展示成第二个用户气泡。
        if (!message._promaMessageUuid || !accepted.has(message._promaMessageUuid) || consumed.has(message._promaMessageUuid)) return;
        consumed.add(message._promaMessageUuid);
        emit(project(message, message._promaMessageUuid, Date.now(), false, {
          rawText: message._promaDisplayText,
        }));
      }
    },
  };
}
