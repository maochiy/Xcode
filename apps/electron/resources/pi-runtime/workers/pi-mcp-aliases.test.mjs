import { describe, expect, test } from 'bun:test';
import { createPiMcpAliases } from './pi-mcp-aliases.mjs';

const fetchTool = {
  name: 'mcp__web_search__WebFetch',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
};

function setup() {
  const agent = {
    state: { tools: [{ name: 'read' }, { name: 'proma_mcp_call' }] },
  };
  const aliases = createPiMcpAliases(agent, (server, tool) => ({ ...tool, server }));
  return { agent, aliases };
}

describe('Pi 已发现 MCP 工具兼容', () => {
  test('Given 未发现服务 When 初始注册 Then 不加载任何 MCP 别名', () => {
    const { agent, aliases } = setup();
    aliases.replace([]);
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(['read', 'proma_mcp_call']);
    expect(aliases.resolve(fetchTool.name, {})).toBeUndefined();
  });

  test('Given 已发现工具 When 模型直接调用 Then 按发现的服务和原始参数映射到网关', () => {
    const { agent, aliases } = setup();
    aliases.discovered({ server: 'web_search', tools: [fetchTool] });
    expect(agent.state.tools.at(-1)).toMatchObject(fetchTool);
    expect(aliases.resolve(fetchTool.name, { url: 'https://example.test' })).toEqual({
      server: 'web_search', tool: fetchTool.name, arguments: { url: 'https://example.test' },
    });
  });

  test('Given 已发现多个服务 When 重复发现一个服务 Then 替换该服务而不删除其他工具', () => {
    const { agent, aliases } = setup();
    aliases.discovered({ server: 'web_search', tools: [fetchTool] });
    aliases.discovered({ server: 'collaboration', tools: [{ ...fetchTool, name: 'delegate_agent' }] });
    aliases.discovered({ server: 'web_search', tools: [] });
    expect(aliases.resolve(fetchTool.name, {})).toBeUndefined();
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(['read', 'proma_mcp_call', 'delegate_agent']);
  });

  test('Given 新一轮宿主缓存已失效 When 同步有效工具快照 Then 删除旧别名且保持原生工具', () => {
    const { agent, aliases } = setup();
    aliases.replace([{ server: 'web_search', tools: [fetchTool] }]);
    aliases.replace([]);
    expect(aliases.resolve(fetchTool.name, {})).toBeUndefined();
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(['read', 'proma_mcp_call']);
  });

  test('Given 其他会话已发现 When 当前会话直接使用 Then 不能共享别名', () => {
    const first = setup();
    const second = setup();
    first.aliases.discovered({ server: 'web_search', tools: [fetchTool] });
    expect(second.aliases.resolve(fetchTool.name, {})).toBeUndefined();
  });

  test('Given MCP 工具与内置名称冲突或跨服务同名 When 注册 Then 不覆盖内置工具且拒绝歧义别名', () => {
    const { agent, aliases } = setup();
    aliases.replace([
      { server: 'one', tools: [fetchTool, { ...fetchTool, name: 'read' }] },
      { server: 'two', tools: [fetchTool] },
    ]);
    expect(aliases.resolve('read', {})).toBeUndefined();
    expect(aliases.resolve(fetchTool.name, {})).toBeUndefined();
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(['read', 'proma_mcp_call']);
  });
});
