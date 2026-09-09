/**
 * 只给已发现的 MCP 工具注册 Pi 原生别名。
 * 执行仍转发到 proma_mcp_call；不猜测服务、不绕过宿主的缓存和权限检查。
 */
export function createPiMcpAliases(agent, createTool) {
  const baseTools = agent.state.tools.slice();
  const baseNames = new Set(baseTools.map((tool) => tool.name));
  const services = new Map();
  let aliases = new Map();

  function refresh() {
    const next = new Map();
    const duplicates = new Set();
    for (const [server, tools] of services) {
      for (const tool of tools) {
        if (baseNames.has(tool.name) || duplicates.has(tool.name)) continue;
        if (next.has(tool.name)) {
          next.delete(tool.name);
          duplicates.add(tool.name);
        } else {
          next.set(tool.name, { server, tool });
        }
      }
    }
    aliases = next;
    agent.state.tools = [
      ...baseTools,
      ...[...aliases.values()].map(({ server, tool }) => createTool(server, tool)),
    ];
  }

  function remember(group) {
    if (!group || typeof group.server !== 'string' || !Array.isArray(group.tools)) return;
    services.set(group.server, group.tools.filter((tool) =>
      tool && typeof tool.name === 'string' && tool.name
      && tool.parameters && typeof tool.parameters === 'object'));
  }

  return {
    /** 每轮以宿主当前有效缓存为准：保留续聊能力，同时撤销失效服务的别名。 */
    replace(groups) {
      services.clear();
      for (const group of Array.isArray(groups) ? groups : []) remember(group);
      refresh();
    },
    discovered(group) {
      remember(group);
      refresh();
    },
    resolve(name, args) {
      const alias = aliases.get(name);
      return alias ? { server: alias.server, tool: name, arguments: args } : undefined;
    },
  };
}
