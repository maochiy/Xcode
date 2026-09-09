import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('全局 AGENTS.md 的实际提示词链路', () => {
  test('Given 全局规则已保存 When 主会话再次构建或执行子任务 Then 重新读取规则且不需要消息带子 Agent 关键词', () => {
    // 独立进程与临时 HOME 同时隔离模块缓存、Electron 配置和用户真实数据。
    const home = mkdtempSync(join(tmpdir(), 'proma-global-instructions-'))
    const directory = join(home, 'xcodes-dev')
    mkdirSync(directory)
    const instructionsPath = join(directory, 'AGENTS.md')
    const firstRule = '处理代码问题时先按注册角色分工。'
    const nextRule = '小任务由主 Agent 直接处理，复杂审查才使用 review。'
    writeFileSync(instructionsPath, firstRule)
    const moduleUrl = pathToFileURL(join(import.meta.dir, 'agent-prompt-builder.ts')).href
    const script = `
      import { writeFileSync } from 'node:fs';
      import { buildSystemPrompt, buildRuntimeTaskSystemPrompt } from ${JSON.stringify(moduleUrl)};
      const context = { sessionId: 'isolated-rules-test', permissionMode: 'default', userMessage: '修复登录问题', collaborationAvailable: true };
      const first = buildSystemPrompt(context);
      writeFileSync(${JSON.stringify(instructionsPath)}, ${JSON.stringify(nextRule)});
      const second = buildSystemPrompt(context);
      const task = buildRuntimeTaskSystemPrompt('pi', 'implementation');
      console.log('PROMA_TEST_RESULT:' + JSON.stringify({ first, second, task }));
    `
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: home, PROMA_DEV: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    const line = result.stdout.toString().split('\n').find((item) => item.startsWith('PROMA_TEST_RESULT:'))
    expect(line).toBeDefined()
    const prompts = JSON.parse(line!.slice('PROMA_TEST_RESULT:'.length)) as {
      first: string
      second: string
      task: string
    }
    expect(prompts.first).toContain(firstRule)
    expect(prompts.first).toContain('list_registered_agents')
    expect(prompts.second).toContain(nextRule)
    expect(prompts.second).not.toContain(firstRule)
    expect(prompts.task).toContain(nextRule)
  }, 30_000)
})
