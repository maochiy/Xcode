/**
 * useSmoothStream - 流式文本平滑渲染 Hook
 *
 * 将后端推送的流式文本（可能每秒几十次更新）转化为
 * 平滑的逐字渲染效果，类似打字机。
 *
 * 核心机制：
 * 1. 新增 delta 通过 Intl.Segmenter 拆分为字符粒度后入队
 * 2. requestAnimationFrame 驱动渲染循环
 * 3. 每帧动态计算渲染字符数（队列长时加速追赶，短时放慢）
 * 4. 流结束后加速但渐进排空队列（不一次性 dump，避免跳动）
 *
 * 参考 Cherry Studio 的 useSmoothStream 实现。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseSmoothStreamOptions {
  /** 原始流式内容（每次 chunk 累积后的完整文本） */
  content: string
  /** 是否正在流式输出中 */
  isStreaming: boolean
  /** 每帧最小间隔（ms），默认 10 */
  minDelay?: number
  /**
   * 每个渲染帧最多追加多少个字素。
   *
   * 不传时沿用动态追赶策略；传 1 时就是稳定的逐字打字效果，
   * 不会因为某个 SSE chunk 较大而一帧突然出现一整段。
   */
  maxCharsPerFrame?: number
}

interface UseSmoothStreamReturn {
  /** 平滑后的显示内容 */
  displayedContent: string
}

/** 多语言字符分割器（正确处理中文、日文等多字节字符） */
const segmenter = new Intl.Segmenter(
  ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'pt-PT', 'ru-RU'],
)

/** 用 Intl.Segmenter 将文本拆分为字符数组 */
function segmentText(text: string): string[] {
  return Array.from(segmenter.segment(text)).map((s) => s.segment)
}

/** 仅在存在待渲染字符且当前没有待执行帧时启动渲染。 */
export function shouldScheduleSmoothStreamFrame(
  pendingCharacterCount: number,
  hasScheduledFrame: boolean,
): boolean {
  return pendingCharacterCount > 0 && !hasScheduledFrame
}

/** 计算当前帧应该追加的字素数，并在需要时限制单帧突发量。 */
export function resolveSmoothStreamCharacterCount(
  pendingCharacterCount: number,
  streamDone: boolean,
  maxCharsPerFrame?: number,
): number {
  if (pendingCharacterCount <= 0) return 0

  const divisor = streamDone ? 4 : 8
  const dynamicCount = Math.max(1, Math.floor(pendingCharacterCount / divisor))
  if (maxCharsPerFrame == null) return dynamicCount

  const normalizedMax = Math.max(1, Math.floor(maxCharsPerFrame))
  return Math.min(dynamicCount, normalizedMax)
}

/**
 * 流式文本平滑渲染 Hook
 *
 * @example
 * ```tsx
 * const streamingContent = useAtomValue(streamingContentAtom)
 * const isStreaming = useAtomValue(streamingAtom)
 *
 * const { displayedContent } = useSmoothStream({
 *   content: streamingContent,
 *   isStreaming,
 * })
 *
 * return <MessageResponse>{displayedContent}</MessageResponse>
 * ```
 */
export function useSmoothStream({
  content,
  isStreaming,
  minDelay = 10,
  maxCharsPerFrame,
}: UseSmoothStreamOptions): UseSmoothStreamReturn {
  const [displayedContent, setDisplayedContent] = useState(content)

  // 字符队列（待渲染的字符）
  const chunkQueueRef = useRef<string[]>([])
  // rAF ID
  const rafRef = useRef<number | null>(null)
  // 已渲染到 UI 的文本
  const displayedRef = useRef(content)
  // 上一次收到的完整内容（用于计算 delta）
  const prevContentRef = useRef(content)
  // 上次渲染时间
  const lastRenderTimeRef = useRef(0)
  // 流是否结束
  const streamDoneRef = useRef(!isStreaming)

  // 同步 streamDone 状态
  streamDoneRef.current = !isStreaming

  // 渲染循环
  const renderLoop = useCallback((currentTime: number) => {
    // 当前帧已经开始执行，不再视为待调度帧。
    rafRef.current = null
    const queue = chunkQueueRef.current

    // 队列为空
    if (queue.length === 0) {
      if (streamDoneRef.current) {
        // 流结束 + 队列空 → 同步最终内容并停止
        if (displayedRef.current !== prevContentRef.current) {
          displayedRef.current = prevContentRef.current
          setDisplayedContent(displayedRef.current)
        }
      }
      // 无论流是否结束，队列为空时都停止；新内容入队后会重新唤醒。
      return
    }

    // 最小延迟控制
    if (currentTime - lastRenderTimeRef.current < minDelay) {
      rafRef.current = requestAnimationFrame(renderLoop)
      return
    }
    lastRenderTimeRef.current = currentTime

    // 默认仍允许动态追赶；需要严格打字效果的调用方可把单帧上限设为 1。
    const count = resolveSmoothStreamCharacterCount(
      queue.length,
      streamDoneRef.current,
      maxCharsPerFrame,
    )

    // 取出字符并更新
    const chars = queue.splice(0, count)
    displayedRef.current += chars.join('')
    setDisplayedContent(displayedRef.current)

    // 仅在仍有待渲染字符时继续，避免流式等待期间空转。
    if (queue.length > 0) {
      rafRef.current = requestAnimationFrame(renderLoop)
    } else {
      // 队列刚排空且流已结束 → 同步最终内容并停止
      if (streamDoneRef.current && displayedRef.current !== prevContentRef.current) {
        displayedRef.current = prevContentRef.current
        setDisplayedContent(displayedRef.current)
      }
    }
  }, [maxCharsPerFrame, minDelay])

  const scheduleRenderLoop = useCallback(() => {
    if (!shouldScheduleSmoothStreamFrame(
      chunkQueueRef.current.length,
      rafRef.current !== null,
    )) {
      return
    }
    rafRef.current = requestAnimationFrame(renderLoop)
  }, [renderLoop])

  // 检测内容变化，计算 delta 并入队
  useEffect(() => {
    const prevContent = prevContentRef.current
    const newContent = content

    if (newContent === prevContent) return

    // 检测是否为追加（正常流式）
    const isAppend = newContent.startsWith(prevContent)

    if (isAppend) {
      // 增量部分拆分为字符后入队，并在空闲时唤醒渲染循环。
      const delta = newContent.slice(prevContent.length)
      if (delta) {
        const chars = segmentText(delta)
        chunkQueueRef.current.push(...chars)
        scheduleRenderLoop()
      }
    } else {
      // 内容重置（用户重新发送等场景）
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      chunkQueueRef.current = []
      displayedRef.current = newContent
      setDisplayedContent(newContent)
    }

    prevContentRef.current = newContent
  }, [content, scheduleRenderLoop])

  // 非流式状态时，确保最终内容一致（安全网，不立即 flush 队列）
  useEffect(() => {
    if (isStreaming) return

    // 如果还有排队内容，确保渲染循环正在排空。
    if (chunkQueueRef.current.length > 0) {
      scheduleRenderLoop()
      return
    }

    if (displayedRef.current !== content) {
      displayedRef.current = content
      setDisplayedContent(displayedRef.current)
    }
  }, [isStreaming, content, scheduleRenderLoop])

  // minDelay 变化时重新调度待渲染内容，并在卸载时清理。
  useEffect(() => {
    scheduleRenderLoop()
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [scheduleRenderLoop])

  return { displayedContent }
}
