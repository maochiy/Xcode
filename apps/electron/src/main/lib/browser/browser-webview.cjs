const fs = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');
const { repairBrowserDirectoryRedirectHeaders } = require('./browser-navigation-policy.cjs');

/**
 * 内置浏览器 Electron session partition 前缀。
 *
 * 每个 Agent 会话使用独立的 partition（`persist:proma-browser-${sessionId}`），
 * 从而隔离各会话的 Cookie / localStorage / 缓存等浏览器数据，避免登录态跨会话串用。
 */
const BROWSER_PARTITION_PREFIX = 'persist:proma-browser';
/** 旧版本全局唯一 partition（无会话隔离），仅用于校验兼容，不再作为目标。 */
const LEGACY_BROWSER_PARTITION = BROWSER_PARTITION_PREFIX;

const configuredSessions = new WeakSet();
const browserGuestIds = new Set();

/** 判断 partition 是否属于 Proma 内置浏览器（含 legacy 全局 partition 与按会话的 partition）。 */
function isBrowserSessionPartition(partition) {
  return partition === LEGACY_BROWSER_PARTITION
    || (typeof partition === 'string' && partition.startsWith(`${BROWSER_PARTITION_PREFIX}-`));
}

/** 将 partition 归一到会话隔离形态：legacy → 视为 sessionId 为空的会话 partition。 */
function normalizeBrowserPartition(partition) {
  if (partition === LEGACY_BROWSER_PARTITION) return `${BROWSER_PARTITION_PREFIX}-`;
  return partition;
}

function isAllowedBrowserUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedInitialUrl(value) {
  return value === 'about:blank' || isAllowedBrowserUrl(value);
}

function browserPreloadPath() {
  const packaged = path.join(process.resourcesPath, 'browser', 'browser-preload.cjs');
  if (app?.isPackaged) return packaged;
  const unpackaged = [
    path.join(__dirname, 'resources/browser/browser-preload.cjs'),
    path.join(__dirname, '../resources/browser/browser-preload.cjs'),
    path.join(__dirname, '../../../resources/browser/browser-preload.cjs'),
  ];
  return unpackaged.find((candidate) => fs.existsSync(candidate)) || unpackaged[0];
}

function hardenBrowserWebPreferences(webPreferences, params) {
  delete params.disablewebsecurity;
  delete params.webpreferences;
  // 保持 webview 声明的 partition（按会话隔离），由 will-attach-webview 校验通过后才到达这里。
  params.allowpopups = 'true';

  webPreferences.preload = browserPreloadPath();
  webPreferences.sandbox = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  webPreferences.plugins = false;
  webPreferences.experimentalFeatures = false;
  webPreferences.enableBlinkFeatures = '';
  webPreferences.disableBlinkFeatures = '';
}

function notifyHost(getWindow, error) {
  const window = getWindow?.();
  if (!window || window.isDestroyed()) return;
  window.webContents.send('proma:browser-error', { error });
}

function configureBrowserSession(partition, getWindow) {
  const browserSession = session.fromPartition(partition, { cache: true });
  if (configuredSessions.has(browserSession)) return browserSession;
  // 目录兼容以实际重定向为依据，不提前篡改荣耀等站点的无斜杠路由。
  browserSession.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    repairBrowserDirectoryRedirectHeaders,
  );
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.on('will-download', (event) => {
    event.preventDefault();
    notifyHost(getWindow, '第一版浏览器暂不支持下载。');
  });
  configuredSessions.add(browserSession);
  return browserSession;
}

function installBrowserWebviewSecurity(getWindow) {
  app.on('web-contents-created', (_event, hostContents) => {
    let pendingBrowserGuest = false;
    hostContents.on('will-attach-webview', (event, webPreferences, params) => {
      const initialUrl = String(params.src || 'about:blank');
      // 仅接受 Proma 内置浏览器 partition（含 legacy 全局 partition 与按会话隔离的 partition）。
      if (!isBrowserSessionPartition(params.partition) || !isAllowedInitialUrl(initialUrl)) {
        pendingBrowserGuest = false;
        event.preventDefault();
        return;
      }
      // 归一化后配置对应的 Electron session（每个会话一个独立存储空间）。
      configureBrowserSession(normalizeBrowserPartition(params.partition), getWindow);
      hardenBrowserWebPreferences(webPreferences, params);
      pendingBrowserGuest = true;
    });
    hostContents.on('did-attach-webview', (_event, guestContents) => {
      if (!pendingBrowserGuest) return;
      pendingBrowserGuest = false;
      browserGuestIds.add(guestContents.id);
      guestContents.setWindowOpenHandler(({ url }) => {
        if (!isAllowedBrowserUrl(url)) {
          notifyHost(getWindow, '已阻止非网页协议。');
          return { action: 'deny' };
        }
        void guestContents.loadURL(url).catch((error) => {
          notifyHost(getWindow, error?.message || '网页打开失败。');
        });
        return { action: 'deny' };
      });
      guestContents.on('will-navigate', (event, url) => {
        if (isAllowedBrowserUrl(url)) return;
        event.preventDefault();
        notifyHost(getWindow, '已阻止非网页协议。');
      });
      guestContents.on('will-redirect', (event, url) => {
        if (isAllowedBrowserUrl(url)) return;
        event.preventDefault();
        notifyHost(getWindow, '已阻止重定向到非网页协议。');
      });
      guestContents.once('destroyed', () => browserGuestIds.delete(guestContents.id));
    });
  });
}

async function handleBrowserAnnotation(event, annotation, getWindow) {
  const contents = event.sender;
  if (!contents || !browserGuestIds.has(contents.id)) return;
  if (!annotation || !['element', 'region'].includes(annotation.target)) return;
  if (typeof annotation.comment !== 'string' || !annotation.comment.trim()) return;
  if (!annotation.rect || typeof annotation.rect !== 'object') return;
  let evidenceDataUrl = '';
  if (annotation?.target === 'region' && annotation.rect?.width > 1 && annotation.rect?.height > 1) {
    const rect = {
      x: Math.max(0, Math.round(annotation.rect.x)),
      y: Math.max(0, Math.round(annotation.rect.y)),
      width: Math.min(4096, Math.max(1, Math.round(annotation.rect.width))),
      height: Math.min(4096, Math.max(1, Math.round(annotation.rect.height))),
    };
    const image = await contents.capturePage(rect).catch(() => null);
    if (image && !image.isEmpty()) evidenceDataUrl = image.toDataURL();
  }
  const window = getWindow?.();
  if (!window || window.isDestroyed()) return;
  window.webContents.send('proma:browser-annotation-created', {
    annotation: {
      ...annotation,
      comment: annotation.comment.trim().slice(0, 4000),
      url: typeof annotation.url === 'string' ? annotation.url.slice(0, 4000) : '',
      pageTitle: typeof annotation.pageTitle === 'string' ? annotation.pageTitle.slice(0, 500) : '',
      text: typeof annotation.text === 'string' ? annotation.text.slice(0, 2000) : '',
      domExcerpt: typeof annotation.domExcerpt === 'string' ? annotation.domExcerpt.slice(0, 8000) : '',
      createdAt: Date.now(),
      ...(evidenceDataUrl ? { evidenceDataUrl } : {}),
    },
    ...(evidenceDataUrl ? { evidenceDataUrl } : {}),
  });
}

function registerBrowserWebviewIpc(ipcMain, getWindow) {
  ipcMain.on('proma:browser-annotation', (event, annotation) => {
    void handleBrowserAnnotation(event, annotation, getWindow);
  });
}

/** 清理某会话的内置浏览器存储数据（Cookie/localStorage/缓存等）。会话删除时调用。 */
async function clearBrowserSessionData(sessionId) {
  try {
    const partition = `${BROWSER_PARTITION_PREFIX}-${sessionId}`;
    const browserSession = session.fromPartition(partition, { cache: true });
    await browserSession.clearStorageData();
    await browserSession.clearCache();
  } catch (error) {
    console.warn(`[内置浏览器] 清理会话存储失败 (${sessionId}):`, error);
  }
}

module.exports = {
  BROWSER_PARTITION_PREFIX,
  LEGACY_BROWSER_PARTITION,
  browserGuestIds,
  browserPreloadPath,
  clearBrowserSessionData,
  configureBrowserSession,
  hardenBrowserWebPreferences,
  handleBrowserAnnotation,
  installBrowserWebviewSecurity,
  isAllowedBrowserUrl,
  isBrowserSessionPartition,
  normalizeBrowserPartition,
  registerBrowserWebviewIpc,
};
