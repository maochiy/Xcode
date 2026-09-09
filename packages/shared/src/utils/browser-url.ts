/**
 * 规范化内置浏览器导航地址。
 *
 * 仅补全协议并校验网页地址，不猜测路径是否为目录。
 * 末尾斜杠属于站点路由语义（例如荣耀文档加斜杠会变成 404），交由站点自行重定向。
 */
export function normalizeBrowserNavigationUrl(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return null
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}
