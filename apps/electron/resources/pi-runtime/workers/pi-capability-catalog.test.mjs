import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilityCatalogKey, capabilityCatalogPrompt } from './pi-capability-catalog.mjs';

test('Given 旧packet仍含Skill正文 When 构建能力目录 Then 仅展示名称简介路径并要求按需read', () => {
  const packet = { skills: [{ name: '测试技能', description: '需要写文档时使用', path: '/fixture/SKILL.md', content: '不能提前注入的完整正文' }] };
  const prompt = capabilityCatalogPrompt(packet, [{ server: 'browser', description: '内置浏览器' }]);
  assert(prompt.includes('/fixture/SKILL.md'));
  assert(prompt.includes('需要写文档时使用'));
  assert(!prompt.includes('不能提前注入的完整正文'));
  assert(prompt.includes('先用 read'));
  assert(prompt.includes('proma_mcp_discover'));
  assert(prompt.includes('proma_mcp_call'));
});

test('Given 续聊时目录改变 When 计算目录版本 Then 更新目录但不因未加载正文变化重复注入', () => {
  const initial = { skills: [{ name: '写作', path: '/one/SKILL.md', content: '版本一' }] };
  assert.equal(capabilityCatalogKey(initial, []), capabilityCatalogKey({ skills: [{ ...initial.skills[0], content: '版本二' }] }, []));
  assert.notEqual(capabilityCatalogKey(initial, []), capabilityCatalogKey(initial, [{ server: 'browser' }]));
  assert.notEqual(capabilityCatalogKey(initial, []), capabilityCatalogKey({ skills: [] }, []));
});
