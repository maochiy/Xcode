const { ipcRenderer } = require('electron');

const state = { mode: 'none', start: null, selected: null, markerCount: 0 };
let host;
let shadow;
let highlight;
let selection;
let editor;
let editorInput;

function ensureOverlay() {
  if (host?.isConnected) return;
  host = document.createElement('div');
  host.setAttribute('data-proma-annotation-layer', '');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .box { position: fixed; box-sizing: border-box; border: 2px solid #1687ff; background: rgb(22 135 255 / 12%); pointer-events: none; display: none; }
    .editor { position: fixed; width: min(360px, calc(100vw - 24px)); padding: 8px; border: 1px solid rgb(0 0 0 / 12%); border-radius: 8px; background: rgb(255 255 255 / 98%); box-shadow: 0 16px 44px rgb(0 0 0 / 18%); pointer-events: auto; display: none; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .editor textarea { box-sizing: border-box; width: 100%; min-height: 72px; resize: vertical; border: 0; outline: 0; padding: 8px; color: #1f2328; background: transparent; font: inherit; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    button { border: 0; border-radius: 6px; padding: 7px 11px; color: #4b5563; background: #f1f3f5; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button.primary { color: white; background: #1687ff; }
    .marker { position: fixed; display: grid; place-items: center; width: 24px; height: 24px; border: 2px solid white; border-radius: 50%; color: white; background: #1687ff; box-shadow: 0 2px 8px rgb(0 0 0 / 22%); pointer-events: none; font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  `;
  highlight = document.createElement('div');
  highlight.className = 'box';
  selection = document.createElement('div');
  selection.className = 'box';
  editor = document.createElement('div');
  editor.className = 'editor';
  editorInput = document.createElement('textarea');
  editorInput.placeholder = '添加评论...';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeEditor);
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = '添加';
  save.addEventListener('click', saveAnnotation);
  editorInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') saveAnnotation();
    if (event.key === 'Escape') closeEditor();
  });
  actions.append(cancel, save);
  editor.append(editorInput, actions);
  shadow.append(style, highlight, selection, editor);
  document.documentElement.appendChild(host);
}

function selectorFor(element) {
  if (!(element instanceof Element)) return '';
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let node = element;
  while (node && node !== document.documentElement && parts.length < 7) {
    let part = node.localName;
    const stableClasses = [...node.classList].filter((name) => !/^(active|hover|focus|selected|open|closed|css-|sc-)/i.test(name)).slice(0, 2);
    if (stableClasses.length) part += stableClasses.map((name) => `.${CSS.escape(name)}`).join('');
    const siblings = node.parentElement ? [...node.parentElement.children].filter((child) => child.localName === node.localName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function rectValue(rect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function showBox(box, rect) {
  Object.assign(box.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

function hideBoxes() {
  if (highlight) highlight.style.display = 'none';
  if (selection) selection.style.display = 'none';
}

function pageTarget(event) {
  const path = event.composedPath?.() || [];
  return path.find((node) => node instanceof Element && node !== host) || event.target;
}

function openEditor(target) {
  state.selected = target;
  const rect = target.rect;
  const width = Math.min(360, window.innerWidth - 24);
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.x + rect.width - width));
  const top = Math.max(12, Math.min(window.innerHeight - 130, rect.y + Math.min(rect.height, 56)));
  Object.assign(editor.style, { display: 'block', left: `${left}px`, top: `${top}px`, width: `${width}px` });
  editorInput.value = '';
  requestAnimationFrame(() => editorInput.focus());
}

function closeEditor() {
  if (editor) editor.style.display = 'none';
  state.selected = null;
  hideBoxes();
}

function saveAnnotation() {
  const comment = String(editorInput?.value || '').trim();
  if (!comment || !state.selected) return;
  const annotation = { ...state.selected, comment, url: location.href, pageTitle: document.title };
  ipcRenderer.send('proma:browser-annotation', annotation);
  state.markerCount += 1;
  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.textContent = String(state.markerCount);
  marker.style.left = `${Math.max(4, annotation.rect.x + annotation.rect.width - 12)}px`;
  marker.style.top = `${Math.max(4, annotation.rect.y - 12)}px`;
  shadow.appendChild(marker);
  closeEditor();
}

function onPointerMove(event) {
  if (state.mode === 'element' && !state.selected) {
    const target = pageTarget(event);
    if (target instanceof Element) showBox(highlight, target.getBoundingClientRect());
  }
  if (state.mode === 'region' && state.start) {
    const x = Math.min(state.start.x, event.clientX);
    const y = Math.min(state.start.y, event.clientY);
    showBox(selection, { x, y, width: Math.abs(event.clientX - state.start.x), height: Math.abs(event.clientY - state.start.y) });
  }
}

function onPointerDown(event) {
  if (editor?.style.display === 'block') return;
  if (state.mode === 'element') {
    const target = pageTarget(event);
    if (!(target instanceof Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = target.getBoundingClientRect();
    showBox(highlight, rect);
    openEditor({
      target: 'element',
      selector: selectorFor(target),
      tagName: target.tagName.toLowerCase(),
      accessibleName: target.getAttribute('aria-label') || target.getAttribute('alt') || target.getAttribute('title') || '',
      text: String(target.innerText || target.textContent || '').trim().slice(0, 1000),
      domExcerpt: target.outerHTML.slice(0, 4000),
      rect: rectValue(rect),
    });
  } else if (state.mode === 'region') {
    event.preventDefault();
    event.stopImmediatePropagation();
    state.start = { x: event.clientX, y: event.clientY };
    showBox(selection, { x: event.clientX, y: event.clientY, width: 1, height: 1 });
  }
}

function onPointerUp(event) {
  if (state.mode !== 'region' || !state.start) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const x = Math.min(state.start.x, event.clientX);
  const y = Math.min(state.start.y, event.clientY);
  const width = Math.abs(event.clientX - state.start.x);
  const height = Math.abs(event.clientY - state.start.y);
  state.start = null;
  if (width < 8 || height < 8) {
    hideBoxes();
    return;
  }
  const center = document.elementFromPoint(x + width / 2, y + height / 2);
  openEditor({
    target: 'region',
    text: String(center?.innerText || center?.textContent || '').trim().slice(0, 1000),
    domExcerpt: center instanceof Element ? center.outerHTML.slice(0, 4000) : '',
    rect: rectValue({ x, y, width, height }),
  });
}

function updateMode(mode) {
  ensureOverlay();
  state.mode = ['element', 'region'].includes(mode) ? mode : 'none';
  state.start = null;
  closeEditor();
  document.documentElement.style.cursor = state.mode === 'element' ? 'crosshair' : state.mode === 'region' ? 'crosshair' : '';
}

function setDocumentScrollbarsVisible(visible) {
  document.documentElement.classList.toggle('proma-show-scrollbars', visible);
  document.body?.classList.toggle('proma-show-scrollbars', visible);
}

function ensureHoverHorizontalScrollbar() {
  const apply = () => {
    if (document.getElementById('proma-hover-h-scrollbar')) return;
    const style = document.createElement('style');
    style.id = 'proma-hover-h-scrollbar';
    style.textContent = `
      html, body {
        min-width: 1100px !important;
        scrollbar-width: none !important;
      }
      html.proma-show-scrollbars, body.proma-show-scrollbars {
        scrollbar-width: thin !important;
        scrollbar-color: rgb(0 0 0 / 0.28) transparent !important;
      }
      html::-webkit-scrollbar, body::-webkit-scrollbar {
        width: 8px !important;
        height: 8px !important;
        display: block !important;
        background: transparent !important;
      }
      html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb {
        background: transparent !important;
      }
      html.proma-show-scrollbars::-webkit-scrollbar-thumb,
      body.proma-show-scrollbars::-webkit-scrollbar-thumb {
        background: rgb(0 0 0 / 0.28) !important;
        border-radius: 999px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply, { once: true });
}

window.addEventListener('DOMContentLoaded', () => {
  ensureOverlay();
  ensureHoverHorizontalScrollbar();
}, { once: true });
ensureHoverHorizontalScrollbar();
window.addEventListener('pointermove', onPointerMove, true);
window.addEventListener('pointerdown', onPointerDown, true);
window.addEventListener('pointerup', onPointerUp, true);
ipcRenderer.on('proma-browser:set-mode', (_event, mode) => updateMode(mode));
ipcRenderer.on('proma-browser:set-scrollbar-visible', (_event, visible) => {
  setDocumentScrollbarsVisible(visible === true);
});
