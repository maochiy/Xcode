/**
 * 注册 Agent 与全局 AGENTS.md 的提示词投影。
 * 规则按自然语言解释，能力开关和权限仍由运行时执行，不依赖关键词识别授权。
 */

export function buildGlobalAgentInstructionsSection(instructions: string): string {
  if (!instructions.trim()) return ''
  return `## Xcodes 全局 AGENTS.md

以下内容来自用户在 Xcodes 配置目录维护的全局 AGENTS.md，适用于主会话和子 Agent。
它是用户的持久化协作偏好，不是额外权限：当前用户的明确要求优先于全局默认规则，项目内更具体的规则可覆盖同类默认规则，运行时权限和禁止递归派生的限制始终有效。注册 Agent 的专属提示词只适用于对应子任务。

${instructions}`
}

export function buildAgentDelegationInstructions(available: boolean): string {
  if (!available) {
    return `## Xcodes 子 Agent 能力边界

当前会话未提供 collaboration 工具。即使全局 AGENTS.md 要求委派，也不能虚构已经创建子 Agent、换用其它内核或绕过开关；应说明能力不可用并在当前授权范围内完成可以独立完成的工作。`
  }
  return `## Xcodes 注册 Agent 与协作

所有子 Agent（包括短期并行子任务）统一使用 Xcodes 的 \`collaboration\` MCP，由 Pi 执行；不要调用不存在的 Runtime 原生 Subagent、Codex 或 Claude Code。
- 是否委派、何时委派和职责分工遵循当前用户要求及全局 AGENTS.md；规则已允许自动协作时，无需用户每轮重复说“使用子 Agent”。没有相关规则时只为确实可独立推进且能提升质量或效率的子任务委派，不为简单问答机械拆分。
- 用户本轮明确要求“不使用子 Agent”或“仅由你处理”时，不得委派，全局默认规则不能覆盖本轮要求。
- 按需先调用 \`proma_mcp_discover({server: "collaboration"})\`，然后经 \`proma_mcp_call\` 调用发现的工具。
- 使用 \`list_registered_agents\` 获取当前已启用角色的真实 ID 和适用说明，再通过 \`delegate_agent\` / \`delegate_agents\` 的 \`agentId\` 选择角色。不得虚构 ID、把角色名当作 Runtime 名称，或用临时角色绕过未知/禁用角色的报错。
- 注册角色的模型、推理强度、权限、工具限制和最大轮数由系统应用。不要为注册角色擅自覆盖模型；未配置模型时继承父会话。临时任务可省略 \`agentId\`，需要选模型时先调用 \`list_available_agent_models\`，只使用父会话当前渠道已启用的模型。
- 委派任务应明确目标、必要上下文、输出要求和文件所有权；并行修改的文件范围不得重叠，提醒子 Agent 不得回退他人的改动。
- 主 Agent 继续非重叠工作，需要结果时使用等待/读取工具，依据真实结果复核后汇总，不能只创建任务便宣称完成。
- 子 Agent 不得递归创建子会话，权限不能高于父会话；工具开关与运行时限制不因全局规则而放宽。`
}
