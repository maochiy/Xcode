import { describe, expect, test } from 'bun:test';
import { appendAssistantSnapshot, missingStreamSuffix } from './pi-stream-reconcile.mjs';

describe('Pi Worker 流式结束事件补齐', () => {
  test('Given 尚无 delta When end 事件携带全文 Then 转发完整内容', () => {
    expect(missingStreamSuffix('', '完整内容')).toEqual({
      delta: '完整内容',
      consistent: true,
    });
  });

  test('Given delta 只到一半 When end 事件携带全文 Then 只补缺失后缀', () => {
    expect(missingStreamSuffix('完整', '完整内容')).toEqual({
      delta: '内容',
      consistent: true,
    });
  });

  test('Given delta 与最终快照不一致 When end 事件到达 Then 禁止重复拼接', () => {
    expect(missingStreamSuffix('旧内容', '最终内容')).toEqual({
      delta: '',
      consistent: false,
    });
  });

  test('Given 工具调用前后各有 assistant 消息 When 生成 run 最终快照 Then 保留两段正文和思考', () => {
    const beforeTool = appendAssistantSnapshot(
      { output: '', reasoning: '' },
      { output: '先检查。', reasoning: '先分析。' },
    );
    const afterTool = appendAssistantSnapshot(
      beforeTool,
      { output: '检查完成。', reasoning: '再总结。' },
    );

    expect(afterTool).toEqual({
      output: '先检查。检查完成。',
      reasoning: '先分析。再总结。',
    });
  });
});
