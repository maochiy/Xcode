'use strict'

/**
 * Pi Worker 兼容补丁。
 *
 * Pi 0.80.x 使用的 proper-lockfile@4 依赖 signal-exit@3 的函数式导出。
 * 当宿主依赖树把 signal-exit@4 提升到同级目录时，旧版 proper-lockfile
 * 会收到 { onExit } 对象并在 Worker 启动阶段崩溃。这里只对
 * proper-lockfile 的这一次 require 做兼容映射，不改变其他依赖看到的
 * signal-exit@4 导出。
 */

const Module = require('node:module')
const originalLoad = Module._load

function isProperLockfileParent(filename) {
  return /(?:^|[\\/])proper-lockfile(?:[\\/]|$)/.test(filename || '')
}

Module._load = function load(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments)

  if (
    request === 'signal-exit'
    && isProperLockfileParent(parent?.filename)
    && typeof loaded !== 'function'
    && typeof loaded?.onExit === 'function'
  ) {
    return loaded.onExit
  }

  return loaded
}
