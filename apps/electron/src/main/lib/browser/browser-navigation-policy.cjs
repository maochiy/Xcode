/**
 * 修复反向代理泄露内部 HTTP 端口的“目录补斜杠”重定向。
 *
 * 必须有服务器 Location 作为依据，且仅限同域、同路径补 `/`、查询不变、
 * HTTPS 被降级到带独立端口的 HTTP。普通路由、跨域登录和正常重定向都保持原样。
 */
function resolveBrowserDirectoryRedirect(sourceUrl, location) {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(location, source);
    if (
      source.protocol !== 'https:'
      || target.protocol !== 'http:'
      || !target.port
      || target.port === source.port
      || source.hostname !== target.hostname
      || source.username || source.password || target.username || target.password
      || source.pathname.endsWith('/')
      || target.pathname !== `${source.pathname}/`
      || source.search !== target.search
    ) return null;
    target.protocol = source.protocol;
    target.port = source.port;
    return target.toString();
  } catch {
    return null;
  }
}

/** 只调整主文档 GET 的重定向，不重放 POST、不干预页面 API 和子资源。 */
function repairBrowserDirectoryRedirectHeaders(details, callback) {
  const headers = details.responseHeaders;
  const locationKey = Object.keys(headers || {}).find((key) => key.toLowerCase() === 'location');
  const location = locationKey && headers[locationKey]?.[0];
  const redirect = details.resourceType === 'mainFrame'
    && details.method === 'GET'
    && [301, 302, 307, 308].includes(details.statusCode)
    && typeof location === 'string'
    ? resolveBrowserDirectoryRedirect(details.url, location)
    : null;
  if (!redirect) {
    callback({});
    return;
  }
  callback({ responseHeaders: { ...headers, [locationKey]: [redirect] } });
}

module.exports = {
  repairBrowserDirectoryRedirectHeaders,
  resolveBrowserDirectoryRedirect,
};
