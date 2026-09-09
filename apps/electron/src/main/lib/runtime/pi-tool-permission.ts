/** 将 Pi 内置工具参数映射到 Proma 已有的权限规则，不改变实际执行内核。 */
export function piPermissionTool(name: string, input: Record<string, unknown>): {
  name: string
  input: Record<string, unknown>
} {
  const names: Record<string, string> = {
    read: 'Read', bash: 'Bash', edit: 'Edit', write: 'Write',
    grep: 'Grep', find: 'Glob', ls: 'LS',
    proma_mcp_discover: 'ListMcpResourcesTool',
  }
  if (!names[name]) return { name, input }
  return {
    name: names[name] || name,
    input: {
      ...input,
      ...(input.path !== undefined ? { file_path: input.path } : {}),
      ...(input.oldText !== undefined ? { old_string: input.oldText } : {}),
      ...(input.newText !== undefined ? { new_string: input.newText } : {}),
    },
  }
}

export function piApprovedToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const { file_path, old_string, new_string, ...rest } = input
  return {
    ...rest,
    ...(file_path !== undefined ? { path: file_path } : {}),
    ...(old_string !== undefined ? { oldText: old_string } : {}),
    ...(new_string !== undefined ? { newText: new_string } : {}),
  }
}
