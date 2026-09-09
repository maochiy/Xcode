import type {
  BuiltinMcpServerDefinition,
  LazyBuiltinMcpServerDefinition,
} from './tool-definition'
import { isBuiltinMcpServerDefinition } from './tool-definition'

interface CreateLazyBuiltinMcpServerDefinitionInput {
  name: string
  description: string
  revision?: string
  load: () => Promise<BuiltinMcpServerDefinition>
}

/**
 * 创建可并发复用的惰性定义。
 *
 * 同一描述对象的并发 load 只执行一次；成功后复用结果，失败后清除进行中的
 * Promise，使后续发现或调用可以重试。加载错误原样抛给使用方，不伪装成成功。
 */
export function createLazyBuiltinMcpServerDefinition(
  input: CreateLazyBuiltinMcpServerDefinitionInput,
): LazyBuiltinMcpServerDefinition {
  let loaded: BuiltinMcpServerDefinition | undefined
  let loading: Promise<BuiltinMcpServerDefinition> | undefined

  return {
    kind: 'proma-lazy-builtin-mcp',
    name: input.name,
    description: input.description,
    revision: input.revision,
    async load() {
      if (loaded) return loaded
      if (loading) return loading

      const currentLoad = input.load().then((definition) => {
        if (!isBuiltinMcpServerDefinition(definition)) {
          throw new Error(`内置 MCP "${input.name}" 初始化结果无效`)
        }
        if (definition.name !== input.name) {
          throw new Error(
            `内置 MCP "${input.name}" 初始化名称不一致：${definition.name}`,
          )
        }
        loaded = definition
        return definition
      })
      loading = currentLoad

      try {
        return await currentLoad
      } finally {
        if (loading === currentLoad) loading = undefined
      }
    },
  }
}
