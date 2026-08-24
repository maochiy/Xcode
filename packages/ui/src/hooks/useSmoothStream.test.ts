import { describe, expect, test } from 'bun:test'
import {
  resolveSmoothStreamCharacterCount,
  shouldScheduleSmoothStreamFrame,
} from './useSmoothStream.ts'

describe('shouldScheduleSmoothStreamFrame', () => {
  test('Given 流仍在进行但字符队列为空 When 判断是否调度下一帧 Then 不应继续空转', () => {
    expect(shouldScheduleSmoothStreamFrame(0, false)).toBe(false)
  })

  test('Given 新字符已进入队列且当前没有待执行帧 When 判断是否调度 Then 应唤醒渲染循环', () => {
    expect(shouldScheduleSmoothStreamFrame(1, false)).toBe(true)
  })

  test('Given 已存在待执行帧 When 新字符继续进入队列 Then 不应重复调度', () => {
    expect(shouldScheduleSmoothStreamFrame(1, true)).toBe(false)
  })
})

describe('resolveSmoothStreamCharacterCount', () => {
  test('Given 未限制单帧字数且队列积压 When 计算当前帧 Then 使用动态追赶数量', () => {
    expect(resolveSmoothStreamCharacterCount(80, false)).toBe(10)
    expect(resolveSmoothStreamCharacterCount(80, true)).toBe(20)
  })

  test('Given 打字模式限制每帧一个字素 When SSE 一次推入大量内容 Then 当前帧仍只追加一个字素', () => {
    expect(resolveSmoothStreamCharacterCount(80, false, 1)).toBe(1)
    expect(resolveSmoothStreamCharacterCount(80, true, 1)).toBe(1)
  })

  test('Given 队列为空 When 计算当前帧 Then 不追加内容', () => {
    expect(resolveSmoothStreamCharacterCount(0, false, 1)).toBe(0)
  })
})
