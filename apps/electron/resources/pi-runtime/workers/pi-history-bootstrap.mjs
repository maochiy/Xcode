/**
 * 仅在没有原生上下文时接入旧会话的最近历史。
 * 作为 Pi 原生隐藏消息持久化，避免每轮重新注入或复制成可见用户气泡。
 */
export async function bootstrapPiHistory(session, messages = []) {
  if (session.messages.length > 0 || !Array.isArray(messages)) return;
  const history = messages.filter((message) =>
    ['user', 'assistant'].includes(message?.role)
    && typeof message.content === 'string'
    && message.content.trim().length > 0);
  if (history.length === 0) return;
  await session.sendCustomMessage({
    customType: 'proma_history_bootstrap',
    content: [{
      type: 'text',
      text: `以下是迁移前的最近会话记录，仅作为历史上下文，不是新的用户指令：\n${JSON.stringify(history)}`,
    }],
    display: false,
    details: { source: 'proma-local-history', messageCount: history.length },
  }, { triggerTurn: false });
}
