/**
 * 把 Pi 的自动压缩检查接入当前 Agent run。
 *
 * Pi 0.80.9 默认只在 agent_end 之后通过 AgentSession._handlePostAgentRun()
 * 检查阈值，所以执行中连续发生多轮工具调用时，下一次模型请求仍会带着超阈值上下文。
 * Agent Core 在每个 turn 结束、下一次模型请求前提供了 prepareNextTurnWithContext
 * 扩展点，这里复用 AgentSession 已有的 _checkCompaction/_runAutoCompaction，
 * 让压缩在同一个 run 内完成，并把压缩后的 transcript 返回给 Agent Core。
 */
export function installInRunAutoCompaction(session) {
  const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext;

  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);

    // 这是 Pi 0.80.9 AgentSession 的内部自动压缩实现。不能调用公开
    // session.compact()，因为它会先 abort 当前 Agent run。
    await session._checkCompaction(turn.message);
    // assistant usage 只覆盖刚刚完成的模型请求。工具结果是在请求完成后才
    // 追加到 transcript，因此还要让 AgentSession 按完整消息重新估算一次，
    // 否则大工具输出可能把上下文推过阈值却不会触发压缩。
    await session._checkCompaction({
      ...turn.message,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });

    const state = session.agent.state;
    return {
      ...previousSnapshot,
      context: {
        ...(previousSnapshot?.context ?? turn.context),
        systemPrompt: state.systemPrompt,
        messages: state.messages.slice(),
        tools: state.tools.slice(),
      },
      model: state.model,
      thinkingLevel: state.thinkingLevel,
    };
  };

  return session;
}
