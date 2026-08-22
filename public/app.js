/* FanBox 前端 */
'use strict';
// ---------- 网页版桥接（Web Shim）：无 Electron 时以 WebSocket 提供与 preload 相同介面 ----------
// 桌面版（window.fanboxEnv.isDesktopApp）直接跳过，走 preload 真桥；浏览器版在这里把
// fanboxPty / fanboxFs / fanboxAgentCtl 映射到 ws://…/ws 帧（spec 05），fanboxRec 走 /api/web/rec/*。
// app.js 其余部分零改动：term.available() 只看 window.fanboxPty 是否存在。
(function () {
  if (window.__fanboxWebShim) return;
  if (window.fanboxEnv && window.fanboxEnv.isDesktopApp) return; // 桌面版：preload 已提供真桥
  if (window.fanboxPty) return; // 已有桥（老版桌面 preload）：不覆盖
  window.__fanboxWebShim = true;

  let ws = null, seq = 0, backoff = 600, wsReady = false;
  const pending = new Map(); // seq -> resolve(result)
  const subs = { 'pty-data': new Set(), 'pty-exit': new Set(), 'fs-changed': new Set(), 'agent-touch': new Set(), 'agent-term-create': new Set() };
  const connWaiters = [];

  function notifyConn() { connWaiters.splice(0).forEach((f) => { try { f(wsReady); } catch { /* */ } }); }
  function whenConnected(ms) {
    return new Promise((res) => {
      if (wsReady) return res(true);
      const f = (ok) => { clearTimeout(t); res(ok); };
      const t = setTimeout(() => { const i = connWaiters.indexOf(f); if (i >= 0) connWaiters.splice(i, 1); res(false); }, ms || 8000);
      connWaiters.push(f);
    });
  }
  function connect() {
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
    catch { return retry(); }
    ws.onopen = () => { wsReady = true; backoff = 600; notifyConn(); };
    ws.onclose = () => {
      const was = wsReady; wsReady = false; notifyConn();
      for (const [, r] of pending) r({ ok: false, error: '连接断开' });
      pending.clear();
      if (was || !window.__fbLoginShown) retry(); // 401 登录层盖着时不空转重连
    };
    ws.onerror = () => { /* onclose 会跟着来 */ };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'result') { const r = pending.get(m.seq); if (r) { pending.delete(m.seq); r(m.r); } return; }
      const set = subs[m.type];
      if (set) for (const f of set) { try { f(m); } catch { /* 单个订阅者异常不连累别人 */ } }
    };
  }
  function retry() { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 8000); }
  connect();

  async function call(m, timeoutMs) {
    if (!(await whenConnected(8000))) return { ok: false, error: '未连接到服务器' };
    return new Promise((resolve) => {
      const s = ++seq;
      pending.set(s, resolve);
      try { ws.send(JSON.stringify({ ...m, seq: s })); } catch { pending.delete(s); resolve({ ok: false, error: '发送失败' }); }
      setTimeout(() => { if (pending.delete(s)) resolve({ ok: false, error: '超时' }); }, timeoutMs || 15000);
    });
  }
  function tell(m) { try { if (wsReady) ws.send(JSON.stringify(m)); } catch { /* 断线即丢，与桌面 IPC 语义一致 */ } }
  function sub(k, cb) { subs[k].add(cb); return () => subs[k].delete(cb); }

  window.fanboxEnv = { isDesktopApp: false, platform: '' }; // platform 由 whoami 回填（服务器所在机器才是真平台）
  window.fanboxPty = {
    spawn: (opts) => call({ type: 'spawn', ...(opts || {}) }),
    input: (id, data) => tell({ type: 'input', id, data }),
    resize: (id, cols, rows) => tell({ type: 'resize', id, cols, rows }),
    kill: (id) => tell({ type: 'kill', id }),
    cwd: (id) => call({ type: 'cwd', id }),
    proc: (id) => call({ type: 'proc', id }),
    onData: (cb) => sub('pty-data', cb),
    onExit: (cb) => sub('pty-exit', cb),
  };
  window.fanboxFs = {
    watch: (dir) => call({ type: 'watch', dir }),
    watchSet: (dirs) => call({ type: 'watch-set', dirs }),
    onChanged: (cb) => sub('fs-changed', cb),
  };
  // agent 开窗/闪标记：与桌面 preload 同介面，走同一根 WS
  window.fanboxAgentCtl = {
    onCreate: (cb) => sub('agent-term-create', cb),
    created: (m) => tell({ type: 'term-created', ...(m || {}) }),
    onTouch: (cb) => sub('agent-touch', cb),
  };

  // 录像走 HTTP（与 server 端 /api/web/rec/* 对齐）；字节攒成 base64 过 JSON
  function b64(u8) {
    try {
      const u = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || 0);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
    } catch { return ''; }
  }
  async function jfetch(url, opt) {
    try {
      const r = await fetch(url, opt);
      if (r.status === 401) { showLogin(); return { ok: false, error: '需要登录' }; }
      return await r.json();
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  const jpost = (url, body) => jfetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  window.fanboxRec = {
    list: () => jfetch('/api/web/rec/list'),
    read: (path) => jfetch('/api/web/rec/read?p=' + encodeURIComponent(path)),
    remove: (path) => jpost('/api/web/rec/remove', { path }),
    reveal: async () => ({ ok: false }), // 浏览器没有访达：静默无操作
    saveExport: (name, buf) => jpost('/api/web/rec/save-export', { name, buf: b64(buf) }),
    export: (name, buf, format) => jpost('/api/web/rec/export', { name, buf: b64(buf), format }),
  };

  // ---------- 登录层：LAN 模式未认证时盖住整个界面 ----------
  function showLogin(err) {
    if ($('#fb-login-overlay')) { const e = $('#fb-login-err'); if (e) e.textContent = err || ''; return; }
    window.__fbLoginShown = true;
    const ov = document.createElement('div');
    ov.id = 'fb-login-overlay'; ov.className = 'fb-login-overlay';
    ov.innerHTML = `<div class="fb-login-card"><h3>FanBox 访问验证</h3><p>这台 FanBox 开了局域网访问，需要输入访问密码。<br>密码存在服务器的 ~/.fanbox/webpass。</p><input id="fb-login-pw" type="password" placeholder="访问密码" autocomplete="current-password"><div id="fb-login-err" class="fb-login-err">${err || ''}</div><button id="fb-login-go" class="fb-login-btn">进入</button></div>`;
    document.body.appendChild(ov);
    const go = async () => {
      const pw = $('#fb-login-pw').value;
      const r = await jpost('/api/web/login', { password: pw });
      if (r && r.ok) location.reload();
      else { const e = $('#fb-login-err'); if (e) e.textContent = (r && r.error) || '登录失败'; }
    };
    $('#fb-login-go').onclick = go;
    $('#fb-login-pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('#fb-login-pw').focus();
  }
  window.__fanboxShowLogin = showLogin;

  // ---------- 侧栏「网页版」卡：连接状态 / 局域网地址 / 访问密码 ----------
  const webSec = {
    st: null, connected: false,
    async init() {
      const sec = $('#web-sec');
      if (!sec) return;
      sec.classList.remove('hidden');
      this.render();
      const w = await jfetch('/api/web/whoami');
      if (!w || !w.ok) return;
      if (w.platform) window.fanboxEnv.platform = w.platform;
      if (w.lanMode && !w.authed) showLogin();
      this.st = w;
      this.render();
    },
    render() {
      const body = $('#web-sec-body');
      if (!body) return;
      const st = this.st || {};
      const rows = [];
      rows.push(`<div class="pw-row" title="与服务器的 WebSocket 连接状态"><span class="pw-dot${this.connected ? ' lit' : ''}"></span><span class="pw-label">${this.connected ? '已连接' : '连接中…'}</span></div>`);
      for (const a of st.addresses || []) rows.push(`<div class="pw-row" title="点击复制地址"><span class="pw-dot"></span><span class="pw-label web-addr" data-copy="${a}">${a}</span></div>`);
      if (st.lanMode && st.authed) {
        rows.push(`<div class="pw-row"><span class="pw-dot"></span><span class="pw-label">访问密码</span><button class="web-mini-btn" id="web-pw-show">显示</button><button class="web-mini-btn" id="web-pw-change">修改</button></div>`);
        rows.push(`<div class="pw-row"><span class="pw-dot"></span><span class="pw-label">退出登录</span><button class="web-mini-btn" id="web-logout">登出</button></div>`);
      }
      body.innerHTML = rows.join('');
      body.querySelectorAll('.web-addr').forEach((el) => { el.onclick = () => { try { navigator.clipboard.writeText(el.dataset.copy); toast('已复制 ' + el.dataset.copy); } catch { /* */ } }; });
      const show = $('#web-pw-show');
      if (show) show.onclick = async () => {
        const r = await jfetch('/api/web/password');
        toast(r && r.ok ? '访问密码：' + r.password : '读取失败', !(r && r.ok));
      };
      const change = $('#web-pw-change');
      if (change) change.onclick = async () => {
        const next = prompt('新访问密码（至少 6 位）');
        if (!next) return;
        const cur = prompt('当前访问密码（未设置过可留空）') || '';
        const r = await jpost('/api/web/password', { current: cur, next });
        toast(r && r.ok ? '密码已更新' : '修改失败' + (r && r.error ? '：' + r.error : ''), !(r && r.ok));
      };
      const out = $('#web-logout');
      if (out) out.onclick = async () => { await jpost('/api/web/logout', {}); location.reload(); };
    },
  };
  // WS 连接状态点亮侧栏卡
  const origNotify = notifyConn;
  notifyConn = function () { origNotify(); webSec.connected = wsReady; if (window.__fbWebSecBooted) webSec.render(); };
  window.__fbWebSecBooted = true;
  window.webSec = webSec;
})();

const $ = (s) => document.querySelector(s);
const api = (p) => fetch(p).then((r) => r.json());
const apiPost = (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// ---------- SVG 图标系统（替代 emoji，统一矢量审美） ----------
const SVG = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  text: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  pdf: '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/>',
  data: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>',
  json: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 1 2 2 2 2 0 0 1-2 2v5a2 2 0 0 1-2 2h-1"/>',
  archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  // UI 装饰图标（统一矢量，替代散落的 emoji）
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  link: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  term: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  clip: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  edit3: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  gitbranch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
  maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  redo: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  // 高辨识度文件类型图标
  md: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M6 15.5V9l3 3 3-3v6.5"/><path d="M17 9v4.5"/><path d="M14.8 12.5L17 15l2.2-2.5"/>',
  html: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9.3 12.5 7.5 14.5 9.3 16.5"/><polyline points="14.7 12.5 16.5 14.5 14.7 16.5"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M7.6 13.5h1.3a1.2 1.2 0 0 1 0 2.4H7.6zm0 0v4.2"/><path d="M12.4 13.5v4.2h1a1.5 1.5 0 0 0 1.5-1.5v-1.2a1.5 1.5 0 0 0-1.5-1.5z"/>',
};
// 按扩展名优先匹配的专属图标（比按 kind 更精准、辨识度更高）
const ICON_BY_EXT = { md: 'md', markdown: 'md', html: 'html', htm: 'html', pdf: 'pdf' };
// UI 图标快捷函数（默认 currentColor，随主题文字色自适应）
function ic(name, color, size) { return svgWrap(SVG[name], color || 'currentColor', size || 16, false); }
// ext → 类别 + 颜色
const EXT_KIND = {
  js: ['code', '#e8c95b'], mjs: ['code', '#e8c95b'], cjs: ['code', '#e8c95b'], jsx: ['code', '#5bc9e8'],
  ts: ['code', '#5b9ae8'], tsx: ['code', '#5b9ae8'], py: ['code', '#5b90c9'], go: ['code', '#5bc9d6'],
  rs: ['code', '#d68a5b'], swift: ['code', '#e8825b'], java: ['code', '#d68a5b'], rb: ['code', '#e85b5b'],
  c: ['code', '#7b9ae8'], cpp: ['code', '#7b9ae8'], h: ['code', '#7b9ae8'], php: ['code', '#9a7be8'],
  vue: ['code', '#5bd6a0'], sh: ['code', '#9aa3b2'], bash: ['code', '#9aa3b2'], lua: ['code', '#5b9ae8'],
  html: ['code', '#e87b5b'], htm: ['code', '#e87b5b'], css: ['code', '#5b9ae8'], scss: ['code', '#e85b9a'],
  json: ['json', '#e8c95b'], json5: ['json', '#e8c95b'], yml: ['json', '#d65b9a'], yaml: ['json', '#d65b9a'],
  toml: ['json', '#9a7be8'], ini: ['json', '#9aa3b2'], env: ['json', '#e8c95b'], xml: ['code', '#9aa3b2'],
  md: ['text', '#7bc9e8'], markdown: ['text', '#7bc9e8'], txt: ['text', '#9aa3b2'], log: ['text', '#9aa3b2'],
  csv: ['data', '#5bd6a0'], tsv: ['data', '#5bd6a0'], sql: ['data', '#e8a85b'],
  zip: ['archive', '#e8c95b'], rar: ['archive', '#e8c95b'], '7z': ['archive', '#e8c95b'],
  gz: ['archive', '#e8c95b'], tar: ['archive', '#e8c95b'],
};
const KIND_COLOR = { dir: '#6d8bff', image: '#5bd6a0', video: '#9a7be8', audio: '#e85b9a', pdf: '#e85b5b', text: '#9aa3b2', other: '#7a8294' };
// 缩略图加载失败时的回退图标
window.__svgVideo = svgWrap(SVG.video, KIND_COLOR.video, 34);
window.__svgImg = svgWrap(SVG.image, KIND_COLOR.image, 34);

// 图标配色随皮肤变化
function iconColorFor(e) {
  const ex = (e.name.split('.').pop() || '').toLowerCase();
  const t = state.theme;
  if (t === 'warm') {
    if (e.isDir) return '#c0714f';
    if (['md', 'markdown', 'txt', 'pdf'].includes(ex)) return '#a0895c';
    if (['csv', 'tsv', 'sql'].includes(ex)) return '#8a7a48';
    return '#9b8b6e';
  }
  if (t === 'editorial') {
    if (e.isDir) return '#0a0a0a';
    if (['html', 'htm'].includes(ex)) return '#ff433d';
    if (['md', 'markdown'].includes(ex)) return '#0000ee';
    if (e.kind === 'data' || ['csv', 'tsv'].includes(ex)) return '#00a33e';
    return '#0a0a0a';
  }
  // terminal：暖色多彩，文件夹用中性灰绿不抢 volt
  if (e.isDir) return '#9aa08a';
  if (EXT_KIND[ex]) return EXT_KIND[ex][1];
  return KIND_COLOR[e.kind] || KIND_COLOR.other;
}
function iconSvg(e, size = 22) {
  const rich = richIcon(e, size); // 强色实体字形优先
  if (rich) return rich;
  const color = iconColorFor(e);
  if (e.isDir) return svgWrap(SVG.folder, color, size, true);
  const ex = (e.name.split('.').pop() || '').toLowerCase();
  let shape = SVG[e.kind] || SVG.file;
  if (EXT_KIND[ex]) shape = SVG[EXT_KIND[ex][0]];
  if (ICON_BY_EXT[ex]) shape = SVG[ICON_BY_EXT[ex]]; // 专属图标优先（md/html/pdf）
  return svgWrap(shape, color, size);
}
function svgWrap(inner, color, size, fill) {
  const isCur = color === 'currentColor';
  const fillVal = fill ? (isCur ? 'currentColor' : color + '22') : 'none';
  const fillOp = (fill && isCur) ? ' fill-opacity="0.15"' : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fillVal}"${fillOp} stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

// ---------- 强色实体文件图标（10x 识别度）----------
// 文档族：实色页面 + 折角 + 白色短标签；代码族：品牌色圆角徽章 + 字母；媒体/压缩各有专属形。
// 颜色烧死在图标里，跨三套皮肤都醒目——一眼认出「这是个 PDF / JS / 压缩包」。
function gWrap(size, inner) { return `<svg class="rich-glyph" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">${inner}</svg>`; }
function gDoc(color, fold) {
  return `<path d="M5 3.6A1.6 1.6 0 0 1 6.6 2H14l5 5v11.4A1.6 1.6 0 0 1 17.4 20H6.6A1.6 1.6 0 0 1 5 18.4z" fill="${color}"/>`
    + `<path d="M14 2l5 5h-3.4A1.6 1.6 0 0 1 14 5.4z" fill="${fold}"/>`;
}
function gLabel(t, fs) { return `<text x="11.6" y="16.6" text-anchor="middle" font-family="-apple-system,'Helvetica Neue',Arial,sans-serif" font-weight="800" font-size="${fs}" letter-spacing="0.1" fill="#fff">${t}</text>`; }
function gBadge(color) { return `<rect x="3" y="3" width="18" height="18" rx="5" fill="${color}"/>`; }
function gInit(t, fs, color) { return `<text x="12" y="15.7" text-anchor="middle" font-family="-apple-system,'Helvetica Neue',Arial,sans-serif" font-weight="800" font-size="${fs}" fill="${color}">${t}</text>`; }
// 文档族：[标签, 字号, 主体色, 折角色]
const DOC_TYPES = {
  pdf: ['PDF', 5, '#E64A3B', '#C23E31'],
  md: ['MD', 7, '#3B82F6', '#2E68C8'], markdown: ['MD', 7, '#3B82F6', '#2E68C8'],
  html: ['&lt;&gt;', 7, '#E8662A', '#C4541F'], htm: ['&lt;&gt;', 7, '#E8662A', '#C4541F'],
  css: ['CSS', 5, '#2D6FD6', '#2459AC'], scss: ['SCSS', 4, '#CF649A', '#A94E7C'], less: ['LESS', 4, '#2D5B8A', '#244A70'],
  json: ['{ }', 7, '#A6824C', '#856A3E'], json5: ['{ }', 7, '#A6824C', '#856A3E'],
  yml: ['YML', 5, '#9C5BD6', '#7E49AC'], yaml: ['YAML', 4.2, '#9C5BD6', '#7E49AC'], toml: ['TOML', 4.2, '#9C5BD6', '#7E49AC'],
  xml: ['XML', 5, '#5E8A3E', '#4A6E31'], svg: ['SVG', 5, '#E8923A', '#C4761F'],
  csv: ['CSV', 5, '#1FAE5A', '#188F4A'], tsv: ['TSV', 5, '#1FAE5A', '#188F4A'],
  sql: ['SQL', 5, '#C77D2E', '#A4661F'],
  doc: ['DOC', 5, '#2B579A', '#21457A'], docx: ['DOC', 5, '#2B579A', '#21457A'],
  xls: ['XLS', 5, '#1D6F42', '#155632'], xlsx: ['XLS', 5, '#1D6F42', '#155632'],
  ppt: ['PPT', 5, '#C43E1C', '#9E3216'], pptx: ['PPT', 5, '#C43E1C', '#9E3216'],
  log: ['LOG', 5, '#7A8290', '#626977'], txt: ['TXT', 5, '#7A8290', '#626977'],
};
// 代码族：[字母, 字号, 徽章色, 字色]
const CODE_BADGES = {
  js: ['JS', 8, '#F0DB4F', '#1A1A1A'], mjs: ['JS', 8, '#F0DB4F', '#1A1A1A'], cjs: ['JS', 8, '#F0DB4F', '#1A1A1A'],
  jsx: ['JSX', 6, '#61DAFB', '#1A1A1A'],
  ts: ['TS', 8, '#3178C6', '#fff'], tsx: ['TSX', 6, '#3178C6', '#fff'],
  py: ['PY', 8, '#3776AB', '#FFE05B'],
  go: ['GO', 7.5, '#00ACD7', '#fff'], rs: ['RS', 8, '#CE7B43', '#fff'],
  java: ['JV', 8, '#E7700E', '#fff'], kt: ['KT', 8, '#A97BFF', '#fff'],
  rb: ['RB', 8, '#CC342D', '#fff'], php: ['PHP', 6, '#7A86B8', '#fff'],
  c: ['C', 9, '#5C6BC0', '#fff'], h: ['H', 9, '#5C6BC0', '#fff'], cpp: ['C++', 6, '#5C6BC0', '#fff'], cc: ['C++', 6, '#5C6BC0', '#fff'],
  vue: ['Vue', 6, '#41B883', '#fff'], swift: ['SW', 8, '#F05138', '#fff'], dart: ['DT', 8, '#0A9EDC', '#fff'],
  sh: ['&gt;_', 8, '#33373D', '#3FD46A'], bash: ['&gt;_', 8, '#33373D', '#3FD46A'], zsh: ['&gt;_', 8, '#33373D', '#3FD46A'],
};
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'bz2', 'xz']);
// 终端裸文件名识别的扩展名白名单：没有它 e.g/node.js/v1.2 这类词全是误报下划线
// 首尾边界都含全角胶水标点：「生成了 a.png、b.png」顿号列举的两个名字才都识别得到
const TERM_LINK_RE_BARE = /(?<=^|[\s'"`(\[（【>：:=；，。、？！])[\p{L}\p{N}_@][\p{L}\p{N}_.\-@/]*\.(?:md|markdown|txt|pdf|png|jpe?g|gif|webp|svg|avif|heic|icns|ico|mp4|mov|webm|mkv|mp3|wav|m4a|flac|json|jsonl|js|mjs|cjs|ts|tsx|jsx|css|scss|sass|less|html?|xml|ya?ml|toml|ini|conf|lock|log|sh|zsh|bash|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sql|csv|tsv|xlsx?|docx?|pptx?|key|numbers|pages|zip|tar|gz|tgz|dmg|app|plist|epub|srt|vtt|command)(?=$|[.\s'"`)\],:;。，）】、？！；：])/gu;
// 文件夹：干净扁平的单色实心文件夹（强色 + 简洁几何，不做作）
function gFolder(size, color) {
  return `<svg class="rich-glyph" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">`
    + `<path d="M3.6 5.5h4.4a1.2 1.2 0 0 1 .85.35l1.3 1.3a1.2 1.2 0 0 0 .85.35H20a1.6 1.6 0 0 1 1.6 1.6v8.45A1.6 1.6 0 0 1 20 19.1H4A1.6 1.6 0 0 1 2.4 17.5V6.7A1.2 1.2 0 0 1 3.6 5.5z" fill="${color}"/>`
    + `</svg>`;
}
function richIcon(e, size) {
  if (e.isDir) return gFolder(size, iconColorFor(e));
  const ex = (e.name.split('.').pop() || '').toLowerCase();
  if (DOC_TYPES[ex]) { const [l, fs, c, f] = DOC_TYPES[ex]; return gWrap(size, gDoc(c, f) + gLabel(l, fs)); }
  if (CODE_BADGES[ex]) { const [l, fs, c, t] = CODE_BADGES[ex]; return gWrap(size, gBadge(c) + gInit(l, fs, t)); }
  if (ARCHIVE_EXT.has(ex)) {
    return gWrap(size, `<rect x="4" y="3.5" width="16" height="17" rx="2.2" fill="#E0A23B"/><rect x="4" y="3.5" width="16" height="17" rx="2.2" fill="#000" opacity="0.06"/>`
      + `<rect x="10.6" y="3.5" width="2.8" height="17" fill="#C8862A"/>`
      + `<rect x="10.6" y="8" width="2.8" height="3" rx="0.5" fill="#fff8e6"/><rect x="11.4" y="11" width="1.2" height="3.4" rx="0.6" fill="#fff8e6"/>`);
  }
  if (e.kind === 'audio') {
    return gWrap(size, gBadge('#E0457B') + `<g stroke="#fff" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="10" x2="8" y2="14"/><line x1="10.7" y1="8" x2="10.7" y2="16"/><line x1="13.3" y1="9.5" x2="13.3" y2="14.5"/><line x1="16" y1="7.5" x2="16" y2="16.5"/></g>`);
  }
  if (e.kind === 'video') {
    return gWrap(size, gBadge('#7C5CE0') + `<path d="M10 8.5l5 3.5-5 3.5z" fill="#fff"/>`);
  }
  if (e.kind === 'image') {
    return gWrap(size, gBadge('#2BB6A3') + `<circle cx="9" cy="9.5" r="1.6" fill="#fff"/><path d="M5 16l3.5-3.5 2.5 2.5L14.5 11 19 16z" fill="#fff"/>`);
  }
  return null; // 未知类型回退到细线通用图标
}
// 缩略图加载失败时的回退（覆盖前面用细线图标的版本，改用强色实体字形）
window.__svgImg = richIcon({ name: '_.jpg', kind: 'image' }, 40);
window.__svgVideo = richIcon({ name: '_.mp4', kind: 'video' }, 40);

const state = {
  cwd: null, home: null, platform: 'darwin', sep: '/',
  theme: localStorage.getItem('fb_theme') || 'warm',
  entries: [], project: null, history: [],
  view: localStorage.getItem('fb_view') || 'grid',
  gridSize: localStorage.getItem('fb_gridsize') || 'sm',
  sort: localStorage.getItem('fb_sort') || 'name',
  showHidden: localStorage.getItem('fb_hidden') === '1',
  filter: '', selected: null, cursor: -1, cols: 1, visible: [],
  favorites: [], recentOpened: [], recentMode: false, skillsMode: false,
  previewW: Number(localStorage.getItem('fb_preview_w')) || 0, // 0 = 用户还没拖过，走 1:2 比例默认
  previewH: Number(localStorage.getItem('fb_preview_h')) || 0,
  sidebarCollapsed: localStorage.getItem('fb_sidebar_collapsed') === '1',
  sidebarW: Math.min(420, Math.max(190, Number(localStorage.getItem('fb_sidebar_w')) || 248)),
  muted: localStorage.getItem('fb_muted') === '1', // WOW4 提示音静音开关
  changeLog: [], // 本会话 agent 改过的文件（跨所有监听目录，按文件去重、最新置顶），供「变更」面板回看
  changeTimeline: [], // 每一次写入事件（不去重，带时间戳），供「会话回放」拖时间轴重现
};

// ---------- 工具 ----------
function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
// 秒 → 人话时长（录像列表用）：93→「1分33秒」、5400→「1小时30分」、20→「20秒」
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m}分${s}秒` : `${m}分`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}小时${mm}分` : `${h}小时`;
}
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 跨平台路径处理：用服务端返回的分隔符
function dirOf(p) { const i = p.lastIndexOf(state.sep); return i > 0 ? p.slice(0, i) : p; }
function baseOf(p) { const parts = p.split(state.sep).filter(Boolean); return parts[parts.length - 1] || p; }
function tilde(p) { return state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p; }
function isFav(path) { return state.favorites.some((f) => f.path === path); }
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 未保存守卫 ----------
// 文本/图片编辑期间，离开当前编辑器（点别的文件、跳目录、关预览）都要先确认，
// 否则会静默丢掉改动。dirtyCheck 在进入编辑器时挂上，保存/确认离开后清空。
let dirtyCheck = null; // () => boolean，true=有未保存改动；null=当前没有编辑器
let autosaveFlush = null; // 自动保存编辑器挂上：离开前把未落盘的改动写掉，不弹「放弃？」
let edStatusTimer = null; // 代码编辑器「xx 之前已保存」每秒刷新的定时器；编辑器关掉时自清
// 当前打开的 md 编辑器，供「外部文件变更」时重载用。{ path, isDirty(), reload() }；离开时清空。
let currentEditor = null;
async function guardDirty() {
  if (autosaveFlush) {
    const f = autosaveFlush;
    autosaveFlush = null; dirtyCheck = null; currentEditor = null;
    await f();
    return true;
  }
  if (dirtyCheck && dirtyCheck()) {
    const ok = await confirmDialog('当前编辑有未保存的改动，放弃并离开？');
    if (!ok) return false;
  }
  dirtyCheck = null;
  return true;
}
const isMdName = (n) => /\.(md|markdown)$/i.test(String(n || ''));

// ---------- 导航 ----------
async function navigate(p, pushHistory = true) {
  if (!await guardDirty()) return;
  if (pushHistory && !follow.navving) restoreFileAreaIfHidden(); // 用户主动导航时，终端铺满/全铺就退出，让文件区回来
  try {
    const data = await api('/api/list?path=' + encodeURIComponent(p));
    if (data.error) { toast('无法打开：' + data.error, true); return; }
    if (pushHistory && state.cwd) state.history.push(state.cwd);
    state.cwd = data.path;
    try { window.fanboxWechat && window.fanboxWechat.setCwd(state.cwd); } catch { /* 微信 ClawBot 的 agent 工作目录跟随当前项目 */ }
    state.entries = data.entries;
    state.project = data.project;
    state.breadcrumb = data.breadcrumb;
    state.parent = data.parent;
    state.recentMode = false;
    state.skillsMode = false;
    state.cursor = -1;
    localStorage.setItem('fb_last_cwd', state.cwd); // 下次启动回到这里
    render();
    renderRootsActive();
    // 联动：监听此目录 + 各终端项目目录的文件变化（agent 改文件→自动刷新）
    updateWatches();
    // 手动跳目录 = 接管浏览，文件跟随让位（跟随自己发起的导航除外）
    if (follow.on && !follow.navving) setFileFollow(false, '手动接管，文件跟随已停');
  } catch (e) { toast('打开失败', true); }
}
// 汇总当前要监听的目录：浏览目录 + 每个终端会话的项目目录，发给主进程做增量监听
function updateWatches() {
  if (!window.fanboxFs) return;
  const dirs = new Set();
  if (state.cwd) dirs.add(state.cwd);
  if (typeof term !== 'undefined') term.sessions.forEach((s) => { if (s.startDir) dirs.add(s.startDir); });
  if (window.fanboxFs.watchSet) window.fanboxFs.watchSet([...dirs]);
  else window.fanboxFs.watch(state.cwd); // 旧版主进程兜底
}
// shell 单引号转义（用于把路径塞进终端 cd 命令）
function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function goBack() { if (state.history.length) navigate(state.history.pop(), false); }
function goUp() { if (state.parent && state.parent !== state.cwd) navigate(state.parent); }

// ---------- 渲染 ----------
function render() {
  renderBreadcrumb();
  renderFiles();
}
function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  if (state.skillsMode) { bc.innerHTML = `<span class="crumb last">Skills 透视</span>`; return; }
  if (state.recentMode) { bc.innerHTML = `<span class="crumb last">${ic('clock', 'currentColor', 15)} 最近修改的文件</span>`; return; }
  (state.breadcrumb || []).forEach((c, i, arr) => {
    if (i > 0) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; bc.appendChild(s); }
    const el = document.createElement('span');
    el.className = 'crumb' + (i === arr.length - 1 ? ' last' : '');
    if (c.name === '/') el.innerHTML = ic('monitor', 'currentColor', 15);
    else el.textContent = c.name;
    el.onclick = () => navigate(c.path);
    bc.appendChild(el);
  });
  // 项目配对色点：当前浏览目录落在某个终端的项目里 → 末级面包屑挂同款色，和终端标签图标呼应
  if (typeof term !== 'undefined' && term.sessions.length) {
    const ts = term.sessions
      // 排掉 / 和家目录这类浅根：它们 startsWith 任何路径都成立，色点会常亮、配对语义失效
      .filter((s) => s.cwd && s.cwd !== '/' && s.cwd !== state.home && (state.cwd === s.cwd || (state.cwd || '').startsWith(s.cwd.replace(/\/$/, '') + '/')))
      .sort((a, b) => b.cwd.length - a.cwd.length)[0];
    if (ts) {
      const d = document.createElement('span');
      d.className = 'crumb-proj';
      d.style.background = `hsl(${term.hueOf(ts.cwd)} 62% 48%)`;
      d.title = '终端「' + (ts.title || '') + '」正在这个项目里干活';
      bc.appendChild(d);
    }
  }
  if (state.project) {
    const b = document.createElement('span');
    b.className = 'proj-badge';
    b.textContent = state.project.toUpperCase() + ' 项目';
    bc.appendChild(b);
  }
  // 滚到末尾，确保被挤压时也能看到当前所在目录（而非根目录）
  requestAnimationFrame(() => { bc.scrollLeft = bc.scrollWidth; });
}
function visibleEntries() {
  let list = state.entries.slice();
  if (!state.showHidden) list = list.filter((e) => !e.hidden);
  const dirFirst = (a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : 0);
  // 最近修改视图：以时间为本义，默认按 mtime 倒序（用户可显式切到大小/名称）
  if (state.recentMode && state.sort === 'name') list.sort((a, b) => b.mtime - a.mtime);
  else if (state.sort === 'mtime') list.sort((a, b) => dirFirst(a, b) || b.mtime - a.mtime);
  else if (state.sort === 'size') list.sort((a, b) => dirFirst(a, b) || b.size - a.size);
  else list.sort((a, b) => dirFirst(a, b) || a.name.localeCompare(b.name, 'zh', { numeric: true }));
  return list;
}
// 底部状态条：当前文件夹的基础信息小字常驻，「占用透视」入口也安在这
function renderStatusbar() {
  const sb = $('#statusbar'); if (!sb) return;
  if (state.skillsMode || state.recentMode || !state.cwd) { sb.classList.add('hidden'); return; }
  sb.classList.remove('hidden');
  sb.innerHTML = `<span class="sb-links"><a id="sb-mem" title="这个文件夹里 AI 干过什么：历史会话、改过的文件、一键续上">项目记忆</a><a id="sb-snap" title="agent 每轮开工前的自动存档，可一键回到任意一轮之前">回合存档</a><a id="sb-du" title="算上子目录的真实磁盘占用">占用透视</a></span>`;
  $('#sb-du').onclick = () => diskPanel(state.cwd);
  $('#sb-mem').onclick = () => memoryPanel(state.cwd);
  $('#sb-snap').onclick = () => snapshotPanel(state.cwd);
}
function renderFiles() {
  if (state.skillsMode) return; // skills 视图自管 #file-area，文件渲染不要清掉它
  const area = $('#file-area');
  const list = visibleEntries();
  state.visible = list;
  renderStatusbar();
  if (!list.length) {
    const emptyMsg = state.recentMode ? '没找到最近修改的文件' : '这个文件夹是空的';
    const emptyIc = state.recentMode ? 'clock' : 'inbox';
    area.innerHTML = `<div class="empty-state"><div class="big">${ic(emptyIc, 'currentColor', 48)}</div>${emptyMsg}</div>`;
    return;
  }
  // 最近修改是跨目录平铺列表，强制列表视图并显示来源目录
  if (state.recentMode || state.view === 'list') {
    const wrap = document.createElement('div');
    wrap.className = 'list';
    const head = document.createElement('div');
    head.className = 'row list-head';
    head.innerHTML = `<div></div><div>名称</div><div>修改时间</div><div>大小</div><div></div>`;
    wrap.appendChild(head);
    list.forEach((e, i) => wrap.appendChild(listRow(e, i)));
    area.innerHTML = '';
    area.appendChild(wrap);
    if (state.recentMode && state.recentTruncated) area.insertAdjacentHTML('beforeend', truncNote());
    state.cols = 1;
    highlightCursor();
    return;
  }
  // 至此只剩网格视图（列表/最近已在上面提前返回）
  const grid = document.createElement('div');
  grid.className = 'grid size-' + state.gridSize;
  list.forEach((e, i) => grid.appendChild(gridItem(e, i)));
  area.innerHTML = '';
  area.appendChild(grid);
  measureCols();
  highlightCursor();
}
function measureCols() {
  const items = $('#file-area').querySelectorAll('.item');
  if (!items.length) { state.cols = 1; return; }
  const top0 = items[0].offsetTop;
  let c = 0;
  for (const it of items) { if (it.offsetTop === top0) c++; else break; }
  state.cols = Math.max(1, c);
}
function favBtn(e) {
  const on = isFav(e.path);
  return `<span class="fav-btn ${on ? 'on' : ''}" title="收藏">${svgWrap(SVG.star, 'currentColor', 15, on)}</span>`;
}
function thumbHtml(e) {
  // 关键性能修复：用缩略图端点（sips/qlmanage 缓存小图），不再把原图/原视频整文件拉进来解码
  if (e.kind === 'image' || e.kind === 'video') {
    const w = state.gridSize === 'lg' ? 320 : (state.gridSize === 'sm' ? 160 : 240);
    const fb = e.kind === 'video' ? 'window.__svgVideo' : 'window.__svgImg';
    // 照片按原比例呈现（object-fit:contain）+ 柔和投影，像散落的照片；缩略图失败回退强色字形
    const img = `<img class="thumb" loading="lazy" decoding="async" src="/api/thumb?path=${encodeURIComponent(e.path)}&w=${w}&v=${e.mtime || 0}" alt="" onerror="this.closest('.thumb-wrap').replaceWith(Object.assign(document.createElement('span'),{className:'svg-icon',innerHTML:${fb}}))">`;
    const play = e.kind === 'video' ? '<span class="play-badge"><svg viewBox="0 0 24 24" width="40%" height="40%"><path d="M8 5.5l11 6.5-11 6.5z" fill="#fff"/></svg></span>' : '';
    return `<span class="thumb-wrap${e.kind === 'video' ? ' is-video' : ''}">${img}${play}</span>`;
  }
  const gs = state.gridSize;
  // 文件夹比文件略大，强化「容器」存在感；按网格尺寸分三档
  const sz = e.isDir
    ? (gs === 'lg' ? 84 : gs === 'sm' ? 46 : 64)
    : (gs === 'lg' ? 72 : gs === 'sm' ? 40 : 56);
  return `<span class="svg-icon">${iconSvg(e, sz)}</span>`;
}
// 项目类型徽章：文件夹卡片上标 node/web/py… 一眼认出 AI 起的项目
const PROJ_LABEL = { node: 'node', web: 'web', python: 'py', rust: 'rs', go: 'go', git: 'git' };
function projBadge(e) {
  if (!e.isDir || !e.project || !PROJ_LABEL[e.project]) return '';
  return `<span class="proj-tag proj-${e.project}">${PROJ_LABEL[e.project]}</span>`;
}
function gridItem(e, i) {
  const el = document.createElement('div');
  const chg = state.changed && state.changed.get(e.name);
  el.className = 'item' + (e.isDir ? ' is-dir' : ' is-file') + (e.hidden ? ' hidden-file' : '') + (state.selected === e.path ? ' selected' : '') + (chg ? ' changed' : '');
  el.dataset.idx = i;
  el.dataset.path = e.path;
  if (chg) { el.dataset.changed = chg.count > 1 ? '改·' + chg.count : '改'; el.style.setProperty('--heat', Math.min(1, 0.4 + chg.count * 0.12).toFixed(2)); if (chg.files.size) el.title = '刚变更：\n' + [...chg.files].join('\n'); }
  el.innerHTML = `<div class="icon" style="--tint:${iconColorFor(e)}">${thumbHtml(e)}${projBadge(e)}</div><div class="fname">${escapeHtml(e.name)}</div>${favBtn(e)}`;
  bindItem(el, e);
  return el;
}
function listRow(e, i) {
  const el = document.createElement('div');
  const chgR = state.changed && state.changed.get(e.name);
  el.className = 'row' + (e.isDir ? ' is-dir' : ' is-file') + (e.hidden ? ' hidden-file' : '') + (state.selected === e.path ? ' selected' : '') + (chgR ? ' changed' : '');
  el.dataset.idx = i;
  el.dataset.path = e.path;
  if (chgR) { el.dataset.changed = chgR.count > 1 ? '改·' + chgR.count : '改'; el.style.setProperty('--heat', Math.min(1, 0.4 + chgR.count * 0.12).toFixed(2)); if (chgR.files.size) el.title = '刚变更：\n' + [...chgR.files].join('\n'); }
  // 最近修改是跨目录列表，名称后缀显示来源目录，方便区分同名文件
  const dirHint = state.recentMode ? ` <span class="row-dir">· ${escapeHtml(tilde(e.dir || dirOf(e.path)))}</span>` : '';
  el.innerHTML = `<div class="icon">${(e.kind === 'image' || e.kind === 'video') ? `<img class="thumb-sm" loading="lazy" decoding="async" src="/api/thumb?path=${encodeURIComponent(e.path)}&w=96&v=${e.mtime || 0}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'svg-icon',innerHTML:this.dataset.fb||''}))" data-fb='${escapeHtml(iconSvg(e, 18))}'>` : `<span class="svg-icon">${iconSvg(e, 18)}</span>`}</div>
    <div class="fname">${escapeHtml(e.name)}${projBadge(e)}${dirHint}</div>
    <div class="meta">${fmtTime(e.mtime)}</div>
    <div class="meta">${e.isDir ? '' : fmtSize(e.size)}</div>
    ${favBtn(e)}`;
  bindItem(el, e);
  return el;
}
function bindItem(el, e) {
  // 拖拽到终端：把路径作为上下文喂给 coding agent
  el.draggable = true;
  el.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/plain', e.path);
    ev.dataTransfer.setData('application/x-fanbox-path', e.path);
    // 拖图片进 md 编辑器：插入原文件路径引用。不带这条时浏览器默认抓的是卡片缩略图的
    // /api/thumb?w=160 链接，低清且写进文档发出去就裂
    if (e.kind === 'image') ev.dataTransfer.setData('text/html', `<img src="${escapeHtml(encodeURI(e.path))}" alt="${escapeHtml(e.name)}">`);
    ev.dataTransfer.effectAllowed = 'copy';
  });
  el.onclick = (ev) => {
    if (ev.target.closest('.fav-btn')) { ev.stopPropagation(); toggleFav(e); return; }
    state.cursor = Number(el.dataset.idx);
    onItemClick(e);
  };
  el.ondblclick = (ev) => { if (ev.target.closest('.fav-btn')) return; onItemOpen(e); };
  el.oncontextmenu = (ev) => { state.cursor = Number(el.dataset.idx); showContextMenu(ev, e); };
}
// 把系统拖入的文件（Finder 文件 / 截图浮窗缩略图）存进目标目录：
// 有真实路径就复制进去，没路径（file-promise）就把字节直接写进去。仿终端那套口径。
async function dropFilesInto(fileList, dir) {
  if (!window.fanboxDrop || !dir) { toast('该环境不支持拖入保存', true); return; }
  const files = [...(fileList || [])];
  if (!files.length) return;
  let saved = 0, lastPath = null;
  for (const f of files) {
    const src = window.fanboxDrop.pathForFile(f);
    let r;
    if (src) r = await window.fanboxDrop.copyInto(src, dir).catch(() => null);
    else r = await window.fanboxDrop.saveInto(dir, f.name, await f.arrayBuffer()).catch(() => null);
    if (r && r.ok) { saved++; lastPath = r.path; }
  }
  if (!saved) { toast('存入失败', true); return; }
  const where = dir === state.cwd ? '' : '「' + baseOf(dir) + '」';
  toast(saved === 1 ? `已存入${where} ${baseOf(lastPath)}` : `已存入${where} ${saved} 个文件`);
  if (dir === state.cwd && !state.recentMode) { await refresh(); if (lastPath) applySelection(lastPath); }
}
// 拖入 app 内/外部的图片（微信收到的图、预览里的图等都是 <img>，拖动带的是图片 URL 而非系统文件）：
// 取 URL → fetch 出字节 → 存进目标目录。只收图片，非图片忽略。
async function dropUrlInto(url, dir) {
  if (!window.fanboxDrop || !dir) { toast('该环境不支持拖入保存', true); return; }
  url = (String(url || '').split(/[\r\n]/).find((l) => l && !l.trim().startsWith('#')) || '').trim(); // uri-list 可能多行/含 # 注释
  if (!url) return;
  let blob;
  try { const r = await fetch(url); if (!r.ok) throw 0; blob = await r.blob(); }
  catch { toast('读不到拖入的图片', true); return; }
  if (!/^image\//.test(blob.type)) { toast('目前只支持拖入图片', true); return; }
  const e = ((blob.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')) || 'png';
  let name = '';
  try { name = baseOf(decodeURIComponent(new URL(url, location.href).pathname)); } catch { /* blob:/data: 无 pathname */ }
  if (!name || !/\.[a-z0-9]+$/i.test(name)) name = `image-${Date.now()}.${e}`;
  const r = await window.fanboxDrop.saveInto(dir, name, await blob.arrayBuffer()).catch(() => null);
  if (!r || !r.ok) { toast('存入失败', true); return; }
  const where = dir === state.cwd ? '' : '「' + baseOf(dir) + '」';
  toast(`已存入${where} ${baseOf(r.path)}`);
  if (dir === state.cwd && !state.recentMode) { await refresh(); if (r.path) applySelection(r.path); }
}
// 让任意元素可拖拽出一个路径（侧栏目录/收藏 → 终端）
function makeDraggablePath(el, p) {
  el.draggable = true;
  el.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/plain', p);
    ev.dataTransfer.setData('application/x-fanbox-path', p);
    ev.dataTransfer.effectAllowed = 'copy';
  });
}
// 只切换选中态的 class，绝不重建整个网格（重建会把所有缩略图重新解码 → 点击卡顿元凶）
function applySelection(path) {
  const area = $('#file-area');
  const prev = area.querySelector('.item.selected, .row.selected');
  if (prev) prev.classList.remove('selected');
  state.selected = path;
  if (path) { const el = area.querySelector(`[data-path="${CSS.escape(path)}"]`); if (el) el.classList.add('selected'); }
}
function onItemClick(e) {
  if (follow.on) setFileFollow(false, '手动接管，文件跟随已停'); // 目录分支由 navigate 内统一处理，这里管点文件
  if (e.isDir) { state.selected = e.path; navigate(e.path); return; }
  applySelection(e.path);
  openPreview(e);
  recordRecent(e.path);
}
function onItemOpen(e) {
  if (e.isDir) return navigate(e.path);
  // 文本/代码、图片、视频双击 =「正经看这文件」→ 全屏预览；pdf/压缩包/二进制仍交系统默认 App 打开。
  // 单击已经预览过同一文件，这里只负责放大，避免重复加载编辑器。
  const k = e.kind || kindFromName(e.name);
  if (k === 'text' || k === 'image' || k === 'video') {
    if (state.selected !== e.path) { applySelection(e.path); openPreview(e); recordRecent(e.path); }
    setPreviewMax(true);
  } else { openWith(e.path, 'default'); }
}

// ---------- 主区键盘导航 ----------
function highlightCursor() {
  const area = $('#file-area');
  area.querySelectorAll('.cursor').forEach((x) => x.classList.remove('cursor'));
  if (state.cursor < 0) return;
  const el = area.querySelector(`[data-idx="${state.cursor}"]`);
  if (el) { el.classList.add('cursor'); el.scrollIntoView({ block: 'nearest' }); }
}
function moveCursor(d) {
  if (!state.visible.length) return;
  if (state.cursor < 0) state.cursor = 0;
  else state.cursor = Math.min(state.visible.length - 1, Math.max(0, state.cursor + d));
  highlightCursor();
}
function cursorEnter(editor) {
  const e = state.visible[state.cursor];
  if (!e) return;
  if (follow.on) setFileFollow(false, '手动接管，文件跟随已停');
  if (editor && !e.isDir) { openWith(e.path, 'editor'); return; }
  if (e.isDir) { state.selected = e.path; navigate(e.path); }
  else { applySelection(e.path); openPreview(e); recordRecent(e.path); }
}

// ---------- 预览 ----------
async function openPreview(e) {
  if (!await guardDirty()) return;
  mona.disposeIfAny(); crepe.disposeIfAny(); imgEditState = null; // 离开编辑态时回收编辑器（连带 worker），避免泄漏
  showPreviewPanel();
  $('#preview-title').textContent = e.name;
  const body = $('#preview-body');
  body.innerHTML = '<div class="cmdk-loading">加载中…</div>';
  renderPreviewActions(e);
  renderPreviewFoot(e);
  const k = e.kind;
  if (k === 'image') {
    // 预览用中等缩略图（秒开）。heic/heif/tiff 浏览器无法直接渲染原图，统一走 sips 缩略图端点
    const exi = (e.name.split('.').pop() || '').toLowerCase();
    const nativeImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(exi);
    const fallback = nativeImg ? `/api/raw?path=${encodeURIComponent(e.path)}&v=${e.mtime || 0}` : `/api/thumb?path=${encodeURIComponent(e.path)}&w=1600&v=${e.mtime || 0}`;
    body.innerHTML = `<img class="pv-img" src="/api/thumb?path=${encodeURIComponent(e.path)}&w=1000&v=${e.mtime || 0}" title="点击放大" onerror="this.onerror=null;this.src='${fallback}'">`;
    body.querySelector('.pv-img').onclick = () => lightbox(e.path, nativeImg, e.mtime);
  } else if (k === 'video') {
    body.innerHTML = `<video controls src="/api/raw?path=${encodeURIComponent(e.path)}"></video>`;
  } else if (k === 'audio') {
    body.innerHTML = `<div class="preview-meta"><span>${fmtSize(e.size)}</span></div><audio controls src="/api/raw?path=${encodeURIComponent(e.path)}"></audio>`;
  } else if (k === 'pdf') {
    body.innerHTML = `<iframe class="iframe-preview" src="/api/raw?path=${encodeURIComponent(e.path)}"></iframe>`;
  } else if (k === 'text') {
    // 代码/文本「预览即编辑」：像 md 一样默认进可编辑态，不用再点编辑按钮。
    // html 例外（给人看的是渲染形态）、csv/tsv 例外（表格视图更有用）→ 仍走只读渲染。
    if (isHtmlName(e.name) || /\.(csv|tsv)$/i.test(e.name)) {
      renderTextPreview(await api('/api/read?path=' + encodeURIComponent(e.path)));
    } else {
      return enterEditMode(e); // md/代码/纯文本：打开即可编辑、自动保存守卫
    }
  } else if (k === 'archive') {
    const d = await api('/api/archive?path=' + encodeURIComponent(e.path));
    if (!d.ok) {
      body.innerHTML = `<div class="empty-state"><div class="big">${iconSvg(e, 48)}</div>${escapeHtml(d.error || '无法读取')}<br><br>${fmtSize(e.size)}</div>`;
    } else {
      const rows = d.entries.map((en) =>
        `<div class="arch-row${en.name.endsWith('/') ? ' is-dir' : ''}"><span class="arch-name">${escapeHtml(en.name)}</span><span class="arch-size">${en.size != null ? fmtSize(en.size) : ''}</span></div>`).join('');
      body.innerHTML = `<div class="preview-meta"><span>${fmtSize(e.size)}</span><span>${d.entries.length}${d.truncated ? '+' : ''} 项</span></div><div class="arch-list">${rows}</div>`;
    }
  } else {
    body.innerHTML = `<div class="empty-state"><div class="big">${iconSvg(e, 48)}</div>这个文件类型无法预览<br><br>${fmtSize(e.size)}</div>`;
  }
}
function renderTextPreview(data) {
  const body = $('#preview-body');
  const meta = `<div class="preview-meta"><span>${data.ext || 'txt'}</span><span>${fmtSize(data.size)}</span><span>${fmtTime(data.mtime)}</span></div>`;
  const ex = (data.ext || '').toLowerCase();
  if ((ex === 'md' || ex === 'markdown') && !window.__noMarked && window.marked) {
    body.innerHTML = meta;
    body.appendChild(mdReadBody(data.content || '', data.path));
  } else if (ex === 'csv' || ex === 'tsv') {
    body.innerHTML = meta + csvTable(data.content || '', ex === 'tsv' ? '\t' : ',');
  } else if (ex === 'html' || ex === 'htm') {
    renderHtmlPreview(data, meta);
  } else {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (ex) code.className = 'language-' + ex;
    code.textContent = data.content || '';
    pre.appendChild(code);
    body.innerHTML = meta;
    body.appendChild(pre);
    if (window.hljs && !window.__noHljs) { try { window.hljs.highlightElement(code); } catch {} }
  }
}
// md 只读阅读体：渲染好的文章本体（代码高亮 + 本地图片能显出来），编辑器和跟随共用。
// srcPath 用来把 `![](./图/封面.png)` 这类相对/本地绝对路径接到 /api/raw，不然本地配图一律裂图。
function mdReadBody(md, srcPath) {
  const div = document.createElement('div');
  div.className = 'md-body';
  div.innerHTML = window.marked ? window.marked.parse(md || '') : escapeHtml(md || '');
  fixLocalImages(div, srcPath);
  if (window.hljs && !window.__noHljs) div.querySelectorAll('pre code').forEach((b) => { try { window.hljs.highlightElement(b); } catch { /* */ } });
  return div;
}
// 把 md 里指向本机文件的图片换成 /api/raw；外链 http(s)/data/blob 不动
function fixLocalImages(root, srcPath) {
  if (!srcPath) return;
  const base = dirOf(srcPath);
  root.querySelectorAll('img').forEach((im) => {
    const raw = im.getAttribute('src') || '';
    if (!raw || /^(https?:|data:|blob:|\/api\/|\/fs\/)/i.test(raw)) return;
    let rel = raw.split('#')[0].split('?')[0];
    try { rel = decodeURIComponent(rel); } catch { /* 本来就没编码 */ }
    const abs = rel.startsWith('/') ? rel : normPath(base + '/' + rel);
    im.setAttribute('src', '/api/raw?path=' + encodeURIComponent(abs));
  });
}
// 折掉路径里的 ./ 和 ../，让相对图片路径能拼成真实绝对路径
function normPath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}
function csvTable(text, delim) {
  const rows = text.split('\n').filter((r) => r.trim()).slice(0, 500).map((r) => r.split(delim));
  if (!rows.length) return '<div class="empty-state">空表格</div>';
  let h = '<div class="csv-wrap"><table class="csv-table"><thead><tr>';
  rows[0].forEach((c) => { h += `<th>${escapeHtml(c)}</th>`; });
  h += '</tr></thead><tbody>';
  for (let i = 1; i < rows.length; i++) {
    h += '<tr>';
    rows[i].forEach((c) => { h += `<td>${escapeHtml(c)}</td>`; });
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  return h;
}
// 把绝对路径编码成 /fs/ 端点 URL，逐段 encode 以保留目录层级（相对引用按段解析）。
// 指向「预览专用端口」(主端口+1)：那个源只出文件、不含 /api，且与 App 跨源——
// 配合 iframe 的 allow-same-origin，页面能完整交互又碰不到 App 本体（防接管/删文件）。
function fsUrl(p, mtime) {
  const segs = '/fs/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/') + '?v=' + (mtime || 0);
  const base = (location.protocol === 'http:' && location.port)
    ? `${location.protocol}//${location.hostname}:${Number(location.port) + 1}` : '';
  return base + segs;
}
function renderHtmlPreview(data, meta) {
  const body = $('#preview-body');
  // 用 html-preview-host 把 meta、工具栏、iframe 包成 flex 列：
  // iframe 占满剩余高度，避免 100% 高度叠加兄弟元素导致父容器也出现滚动条，
  // 从而让 iframe 自己稳定处理页面内滚动。
  // 头部不再放 meta/「查看源码」/「浏览器打开」：顶栏的编辑（笔）= 看源码、打开 = 浏览器打开，已经够了
  body.innerHTML =
    `<div class="html-preview-host">
      <div class="iframe-wrap"><iframe class="iframe-preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" scrolling="yes" src="${fsUrl(data.path, data.mtime)}"></iframe></div>
    </div>`;
  // 桌面 Chromium 的 iframe 不认 viewport meta，定宽桌面页在窄预览框里只露左上角。
  // /fs/ 注入的测宽脚本会把页面自然宽度 postMessage 过来：超出容器就整页等比缩到适配宽度。
  const wrap = body.querySelector('.iframe-wrap');
  const frame = wrap.firstElementChild;
  let natW = 0;
  // 定宽桌面页超出预览框就整页等比缩到适配宽度；放得下就保持原样
  const applyFit = () => {
    const cw = wrap.clientWidth;
    if (!natW || natW <= cw + 8 || !cw) { frame.removeAttribute('style'); return; }
    const k = cw / natW;
    frame.style.cssText = `width:${natW}px;height:${Math.round(wrap.clientHeight / k)}px;transform:scale(${k});transform-origin:0 0;`;
  };
  const onMsg = (ev) => {
    if (!frame.isConnected || ev.source !== frame.contentWindow) return;
    const w = ev.data && ev.data.fanboxPreviewWidth;
    if (typeof w === 'number' && w > 0 && w !== natW) { natW = w; applyFit(); }
  };
  // 上一个 HTML 预览的监听先拆掉（切文件时旧 iframe 已 detach，监听只剩泄漏）
  if (renderHtmlPreview._cleanup) renderHtmlPreview._cleanup();
  window.addEventListener('message', onMsg);
  const ro = new ResizeObserver(applyFit);
  ro.observe(wrap);
  renderHtmlPreview._cleanup = () => { window.removeEventListener('message', onMsg); ro.disconnect(); renderHtmlPreview._cleanup = null; };
}
// 查看改动：HEAD 版本 vs 工作区当前内容，用 Monaco 只读 DiffEditor 并排渲染
async function showDiff(e) {
  if (follow.on) setFileFollow(false, '手动接管，文件跟随已停');
  const data = await api('/api/git-file?path=' + encodeURIComponent(e.path));
  if (!data.isRepo && !data.shadow) { toast('该文件不在 git 仓库里，也还没有回合存档（跑过 agent 就有了）', true); return; }
  if (!data.diffable) { toast('该类型不支持 diff', true); return; }
  if (!data.isNew && (data.original || '') === (data.modified || '')) { toast(data.shadow ? '与上一回合存档无差异' : '与 HEAD 无差异'); return; }
  if (!await mona.load()) { toast('编辑器未就绪', true); return; }
  if (!await guardDirty()) return;
  mona.disposeIfAny(); crepe.disposeIfAny(); imgEditState = null;
  showPreviewPanel();
  applySelection(e.path);
  $('#preview-title').textContent = (data.isNew ? '新增 · ' : '改动 · ') + e.name;
  renderPreviewActions(e);
  renderPreviewFoot(e);
  const body = $('#preview-body');
  body.innerHTML =
    `<div class="editor-bar"><span class="editor-hint">${data.isNew ? (data.shadow ? '新文件（上一回合存档时还没有）' : '新文件（HEAD 中不存在）') : (data.shadow ? `左：回合存档（${fmtTime(data.baseTs)}）　·　右：当前` : '左：HEAD　·　右：当前工作区')} · 只读</span><button id="diff-close" class="ghost-btn">返回预览</button></div>` +
    `<div id="ed-host" class="mona-host"></div>`;
  mona.openDiff($('#ed-host'), data.original, data.modified, (e.name.split('.').pop() || '').toLowerCase());
  $('#diff-close').onclick = () => openPreview(e);
}
function renderPreviewActions(e) {
  const box = $('#preview-actions');
  box.innerHTML = '';
  const clip = window.fanboxClipboard;
  // 图标为主、文字精简：主操作「打开」留字，其余只留图标 + tooltip
  const acts = [
    { id: 'preview-maxbtn', icon: ic(previewMax ? 'minimize' : 'maximize', 'currentColor', 15), title: previewMax ? '退出全屏' : '全屏放大', fn: () => setPreviewMax() },
    { icon: ic('link', 'currentColor', 14), label: '打开', title: '默认应用打开', cls: 'primary', fn: () => openWith(e.path, 'default') },
    ...(e.kind === 'text' && !isMdName(e.name) ? [{ icon: ic('edit3', 'currentColor', 15), title: '编辑文本', fn: () => enterEditMode(e) }] : []), // md 预览即编辑，无需入口
    ...(e.kind === 'text' ? [{ icon: ic('gitbranch', 'currentColor', 15), title: '查看改动（HEAD vs 当前）', fn: () => showDiff(e) }] : []),
    ...(e.kind === 'image' ? [{ icon: ic('edit3', 'currentColor', 15), title: '编辑图片', fn: () => enterImageEdit(e) }] : []),
    { icon: ic('term', 'currentColor', 15), title: '在编辑器打开', fn: () => openWith(e.path, 'editor') },
    { icon: ic('folder', 'currentColor', 15), title: '在访达显示', fn: () => openWith(e.path, 'reveal') },
    ...(e.kind === 'image' && clip ? [{ icon: ic('image', 'currentColor', 15), title: '复制图片（可粘贴到其它应用）', fn: () => copyImage(e.path) }] : []),
    ...(clip ? [{ icon: ic('copy', 'currentColor', 15), title: '复制文件（访达里可粘贴）', fn: () => copyFile(e.path) }] : []),
    { icon: ic('clip', 'currentColor', 15), title: '复制路径', fn: () => copyPath(e.path) },
  ];
  acts.forEach((a) => {
    const b = document.createElement('button');
    if (a.id) b.id = a.id;
    b.className = (a.cls || '') + (a.label ? '' : ' icon-only');
    // 有可见文字的按钮不需气泡；纯图标按钮用 data-tip 即时气泡（不再用慢吞吞的原生 title）
    if (!a.label && a.title) b.dataset.tip = a.title;
    b.innerHTML = a.label ? `${a.icon}<span>${a.label}</span>` : a.icon;
    b.onclick = a.fn;
    box.appendChild(b);
  });
}
// 预览底部：大小 · 创建 · 修改
function fmtDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderPreviewFoot(e) {
  const f = $('#preview-foot');
  if (!f) return;
  if (!e || e.isDir) { f.innerHTML = ''; return; }
  f.innerHTML = `<span title="大小">${e.size ? fmtSize(e.size) : '0 B'}</span><span title="创建时间">创建 ${fmtDateTime(e.btime)}</span><span title="修改时间">改 ${fmtDateTime(e.mtime)}</span>`;
}
async function copyImage(p) { const r = await window.fanboxClipboard.copyImage(p); toast(r.ok ? '已复制图片，可粘贴到其它应用' : '复制图片失败：' + (r.error || ''), !r.ok); }
async function copyFile(p) { const r = await window.fanboxClipboard.copyFile(p); toast(r.ok ? '已复制文件，可在访达里粘贴' : '复制文件失败', !r.ok); }
async function closePreview() {
  if (!await guardDirty()) return;
  mona.disposeIfAny(); crepe.disposeIfAny(); imgEditState = null;
  if (previewMax) setPreviewMax(false);
  animateLayout();
  $('#preview').classList.add('hidden');
  $('#preview-resizer').classList.add('hidden');
  applySelection(null);
  term.fitActive();
}
function lightbox(path, nativeImg, mtime) {
  // heic/heif/tiff 无法渲染原图，放大也用大尺寸缩略图
  if (nativeImg === undefined) { const ex = (path.split('.').pop() || '').toLowerCase(); nativeImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ex); }
  const src = nativeImg ? `/api/raw?path=${encodeURIComponent(path)}&v=${mtime || 0}` : `/api/thumb?path=${encodeURIComponent(path)}&w=1600&v=${mtime || 0}`;
  const ov = document.createElement('div');
  ov.className = 'lightbox';
  ov.innerHTML = `<img src="${src}"><div class="lb-hint">点击空白处关闭 · 滚轮缩放</div>`;
  let scale = 1;
  const img = ov.querySelector('img');
  ov.onclick = (ev) => { if (ev.target === ov) ov.remove(); };
  ov.onwheel = (ev) => { ev.preventDefault(); scale = Math.min(8, Math.max(0.2, scale - ev.deltaY * 0.002)); img.style.transform = `scale(${scale})`; };
  document.body.appendChild(ov);
}
// 布局：侧栏(可折叠) + 主区；折叠时侧栏 display:none 退出栅格，故改单列 1fr 让主区铺满
function applyLayout() {
  $('#app').style.gridTemplateColumns = state.sidebarCollapsed ? '1fr' : `${state.sidebarW}px 1fr`;
  document.documentElement.style.setProperty('--sidebar-w', state.sidebarW + 'px'); // 供拖拽条 fixed 定位
}
// WOW3：把选中的文字做成一个残影「甩」进终端，落地时终端闪一下——交互本身就是惊喜
function flingToTerminal(text, fromRect) {
  const panel = $('#terminal-panel');
  const tRect = (panel && !panel.classList.contains('hidden')) ? panel.getBoundingClientRect() : null;
  const ghost = document.createElement('div');
  ghost.className = 'fling-ghost';
  ghost.textContent = text.length > 42 ? text.slice(0, 42) + '…' : text;
  const sx = fromRect.left, sy = fromRect.top;
  ghost.style.left = sx + 'px'; ghost.style.top = sy + 'px';
  document.body.appendChild(ghost);
  const tx = tRect ? (tRect.left + tRect.width / 2 - 60) : window.innerWidth - 120;
  const ty = tRect ? (tRect.top + tRect.height / 2) : window.innerHeight - 80;
  requestAnimationFrame(() => {
    ghost.style.transform = `translate(${tx - sx}px, ${ty - sy}px) scale(0.25) rotate(7deg)`;
    ghost.style.opacity = '0';
  });
  ghost.addEventListener('transitionend', () => ghost.remove(), { once: true });
  setTimeout(() => ghost.remove(), 800); // 兜底清理
  if (panel && tRect) { panel.classList.remove('term-catch'); void panel.offsetWidth; panel.classList.add('term-catch'); setTimeout(() => panel.classList.remove('term-catch'), 520); }
}
// 在预览里选中文字 → 浮现「发到终端」按钮，一键把这段作为上下文喂给 agent（md/代码/文本预览生效）
function bindSelectionToTerminal() {
  const body = $('#preview-body');
  if (!body) return;
  let btn = null;
  const hide = () => { if (btn) { btn.remove(); btn = null; } };
  const show = () => {
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text || !term.available()) { hide(); return; }
    const node = sel.anchorNode;
    const host = node && (node.nodeType === 3 ? node.parentNode : node);
    if (!host || !body.contains(host)) { hide(); return; } // 选区必须落在预览正文里
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hide(); return; }
    if (!btn) { btn = document.createElement('button'); btn.className = 'sel-send'; document.body.appendChild(btn); }
    btn.innerHTML = `${ic('term', 'currentColor', 13)} 发到终端`;
    const top = Math.min(window.innerHeight - 44, rect.bottom + 8);
    btn.style.top = top + 'px';
    btn.style.left = Math.max(8, Math.min(window.innerWidth - 130, rect.left)) + 'px';
    btn.onmousedown = (ev) => ev.preventDefault(); // 别让点击清掉选区
    btn.onclick = () => { const r = btn.getBoundingClientRect(); flingToTerminal(text, r); term.sendContext(text, state.selected); hide(); toast('已甩进终端，补一句要求再回车'); };
  };
  body.addEventListener('mouseup', () => setTimeout(show, 10));
  body.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', (ev) => { if (btn && ev.target !== btn && !btn.contains(ev.target)) hide(); });
}
// 给「无可见文字」的图标按钮挂即时气泡标签：把原生 title 转成 data-tip（CSS 气泡），移除 title 防双重提示
function enableTooltips(scope) {
  (scope || document).querySelectorAll('[title]').forEach((el) => {
    const label = el.getAttribute('title');
    if (!label) return;
    if (el.textContent.replace(/\s/g, '').length > 2) return; // 有明确文字标签的按钮就不加气泡
    el.dataset.tip = label;
    el.removeAttribute('title');
  });
}
// 侧边栏右缘拖拽改宽度（折叠态不可拖）
function bindSidebarResizer() {
  const handle = $('#sidebar-resizer');
  if (!handle) return;
  let dragging = false, raf = null, target = null;
  const apply = () => { raf = null; if (target == null) return; state.sidebarW = target; target = null; applyLayout(); if (typeof term !== 'undefined') term.fitActive(); };
  handle.addEventListener('mousedown', (e) => {
    if (state.sidebarCollapsed) return;
    dragging = true; e.preventDefault();
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    target = Math.round(Math.min(420, Math.max(190, e.clientX)));
    if (!raf) raf = requestAnimationFrame(apply);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    document.body.style.userSelect = ''; document.body.style.cursor = '';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    apply();
    localStorage.setItem('fb_sidebar_w', state.sidebarW);
  });
}
// 预览尺寸随 dock 翻转：终端在右→预览在下方用高度，否则用宽度
function applyPreviewSize() {
  const pv = $('#preview');
  if (!pv || pv.classList.contains('hidden')) return;
  const isRight = term.dock === 'right';
  let basis = isRight ? state.previewH : state.previewW; // 0 = 还没手动拖过
  if (!basis) { // 首次：文件列表:预览 = 1:2，预览占 2/3
    const fm = $('#filemgmt');
    const r = fm && fm.getBoundingClientRect();
    const span = r ? (isRight ? r.height : r.width) : 0;
    basis = span ? Math.round(span * 2 / 3) : (isRight ? 340 : 480);
  }
  pv.style.flexBasis = basis + 'px';
}
// 离散布局切换时短暂开启过渡（拖拽时不开，保证跟手）
function animateLayout() {
  const mb = $('#main-body'); if (!mb) return;
  mb.classList.add('lay-anim');
  clearTimeout(animateLayout._t);
  animateLayout._t = setTimeout(() => mb.classList.remove('lay-anim'), 280);
}
// 极端态特例：只在「文件区被完全盖住」时出手——终端铺满 → 还原；拖成全铺 → 退出并把终端回到 1:2 默认。
// 不做任何「最小尺寸」挤压，普通分栏比例一律不碰（这才是删掉 ensureFileAreaSize 之后要留的唯一兜底）。
function restoreFileAreaIfHidden() {
  const panel = $('#terminal-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  if (term.maximized) term.toggleMax(false); // 铺满：还原即可，终端保留原尺寸
  const mb = $('#main-body');
  if (mb && mb.classList.contains('fm-squeezed')) { // 拖成全铺：文件区被压没，退出并给终端一个 2/3 的默认尺寸
    mb.classList.remove('fm-squeezed');
    localStorage.setItem('fb_term_squeeze', '0');
    const r = mb.getBoundingClientRect();
    if (term.dock === 'bottom') {
      const h = r.height ? Math.round(r.height * 2 / 3) : 280;
      panel.style.height = h + 'px'; localStorage.setItem('fb_term_h', h);
    } else {
      const w = r.width ? Math.round(r.width * 2 / 3) : 480;
      panel.style.width = w + 'px'; localStorage.setItem('fb_term_w', w);
    }
    animateLayout(); term.fitActive();
  }
}
function showPreviewPanel() {
  const wasHidden = $('#preview').classList.contains('hidden');
  $('#preview').classList.remove('hidden');
  $('#preview-resizer').classList.remove('hidden');
  if (wasHidden) animateLayout();
  applyPreviewSize();
}
// 预览全屏：让 #preview 铺满整个窗口（盖住文件区/终端/侧边栏）。md 全屏下仍是所见即所得，可继续编辑。
let previewMax = false;
function setPreviewMax(on) {
  previewMax = on === undefined ? !previewMax : !!on;
  $('#preview').classList.toggle('is-max', previewMax);
  document.documentElement.classList.toggle('preview-maxed', previewMax); // 全屏期间关掉顶栏 drag 区，否则它会吞预览按钮的点击
  // 全屏时藏掉左上角红黄绿系统按钮（和右侧自家关闭图标太像），退出再显回来
  try { window.fanboxWin?.trafficLights(!previewMax); } catch { /* 浏览器版无此桥 */ }
  const b = $('#preview-maxbtn');
  if (b) { b.innerHTML = ic(previewMax ? 'minimize' : 'maximize', 'currentColor', 15); b.dataset.tip = previewMax ? '退出全屏' : '全屏放大'; }
}
function applyPreviewWidth() { applyPreviewSize(); } // 兼容旧调用名
function toggleSidebar(force) {
  // 关/开侧栏前记下终端占主区的比例（仅左右分栏时）：腾出/收回的宽度按比例分给「文件区+预览」和终端，
  // 而不是全甩给左侧文件区
  const panel = $('#terminal-panel');
  const scaleTerm = panel && !panel.classList.contains('hidden') && term.dock === 'right' && !term.maximized;
  let frac = 0, oldMw = 0;
  if (scaleTerm) {
    oldMw = $('#main-body').getBoundingClientRect().width;
    if (oldMw > 0) frac = panel.getBoundingClientRect().width / oldMw;
  }
  state.sidebarCollapsed = force === undefined ? !state.sidebarCollapsed : force;
  localStorage.setItem('fb_sidebar_collapsed', state.sidebarCollapsed ? '1' : '0');
  $('#app').classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  $('#btn-sidebar')?.classList.toggle('on', state.sidebarCollapsed);
  applyLayout();
  if (scaleTerm && frac > 0) {
    const newMw = oldMw + (state.sidebarCollapsed ? state.sidebarW : -state.sidebarW); // 主区列 ±侧栏宽
    const tw = Math.max(280, Math.min(newMw - 480, Math.round(newMw * frac))); // 终端/文件区各留最小宽
    panel.style.width = tw + 'px';
    localStorage.setItem('fb_term_w', tw);
    term.fitActive();
  }
}

// ---------- 图片基础编辑（canvas：标注/打码/转格式/缩放/压缩，原生保存）----------
let imgEditState = null;
async function enterImageEdit(e) {
  if (follow.on) setFileFollow(false, '手动接管，文件跟随已停'); // 编辑时绝不能被跟随抢屏
  if (!await guardDirty()) return;
  recordRecent(e.path);
  mona.disposeIfAny(); crepe.disposeIfAny();
  showPreviewPanel();
  applySelection(e.path);
  $('#preview-title').textContent = '编辑 · ' + e.name;
  $('#preview-actions').innerHTML = '';
  renderPreviewFoot(null);
  const body = $('#preview-body');
  body.innerHTML = '<div class="cmdk-loading">加载图片…</div>';
  const img = new Image();
  img.onload = () => {
    // 大图 OOM 守卫：canvas 按 RGBA 估算，超 60MP（~240MB）拒绝编辑，回退预览
    if (img.naturalWidth * img.naturalHeight > 60e6) { toast('图片过大（>60MP），暂不支持编辑，请先压缩', true); openPreview(e); return; }
    buildImageEditor(e, img);
  };
  img.onerror = () => { toast('图片加载失败', true); openPreview(e); };
  img.src = '/api/raw?path=' + encodeURIComponent(e.path) + '&v=' + (e.mtime || 0);
}
function ieSnapshot(st) { const c = document.createElement('canvas'); c.width = st.canvas.width; c.height = st.canvas.height; c.getContext('2d').drawImage(st.canvas, 0, 0); return c; }
function iePos(st, ev) { const r = st.canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) * (st.canvas.width / r.width), y: (ev.clientY - r.top) * (st.canvas.height / r.height) }; }
function ieDrawShape(st, x0, y0, x1, y1) {
  const c = st.ctx; c.save();
  c.strokeStyle = st.color; c.fillStyle = st.color; c.lineWidth = st.size; c.lineCap = 'round'; c.lineJoin = 'round';
  if (st.tool === 'rect') c.strokeRect(x0, y0, x1 - x0, y1 - y0);
  else if (st.tool === 'line' || st.tool === 'arrow') {
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    if (st.tool === 'arrow') { const a = Math.atan2(y1 - y0, x1 - x0), h = Math.max(12, st.size * 3.2); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x1 - h * Math.cos(a - 0.4), y1 - h * Math.sin(a - 0.4)); c.lineTo(x1 - h * Math.cos(a + 0.4), y1 - h * Math.sin(a + 0.4)); c.closePath(); c.fill(); }
  }
  c.restore();
}
function iePixelate(st, x0, y0, x1, y1) {
  const x = Math.max(0, Math.min(x0, x1)), y = Math.max(0, Math.min(y0, y1));
  const w = Math.min(st.canvas.width - x, Math.abs(x1 - x0)), h = Math.min(st.canvas.height - y, Math.abs(y1 - y0));
  if (w < 2 || h < 2) return;
  const block = Math.max(6, Math.round(Math.min(w, h) / 12));
  const c = st.ctx, data = c.getImageData(x, y, w, h), d = data.data;
  for (let by = 0; by < h; by += block) for (let bx = 0; bx < w; bx += block) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = by; yy < Math.min(by + block, h); yy++) for (let xx = bx; xx < Math.min(bx + block, w); xx++) { const i = (yy * w + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    r = r / n; g = g / n; b = b / n;
    for (let yy = by; yy < Math.min(by + block, h); yy++) for (let xx = bx; xx < Math.min(bx + block, w); xx++) { const i = (yy * w + xx) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; }
  }
  c.putImageData(data, x, y);
}
function ieToolBtn(tool, title, inner, active) {
  return `<button data-tool="${tool}" title="${title}"${active ? ' class="active"' : ''}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></button>`;
}
function buildImageEditor(e, img) {
  const origExt = (e.name.split('.').pop() || 'png').toLowerCase();
  const body = $('#preview-body');
  body.innerHTML =
    `<div class="imgedit-tools">
      <div class="ie-seg" id="ie-tools">
        ${ieToolBtn('pen', '自由画笔', '<path d="M3 21c0-3 2-5 5-6 2-.7 3-2 3.5-4M21 3c-1 4-3 7-6 9"/><path d="M11 11l2 2"/>', true)}
        ${ieToolBtn('rect', '矩形框', '<rect x="4" y="6" width="16" height="12" rx="1.5"/>')}
        ${ieToolBtn('line', '直线', '<line x1="5" y1="19" x2="19" y2="5"/>')}
        ${ieToolBtn('arrow', '箭头', '<line x1="5" y1="19" x2="18" y2="6"/><polyline points="10.5 6 18 6 18 13.5"/>')}
        ${ieToolBtn('text', '文字', '<polyline points="5 7 5 5 19 5 19 7"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="9" y1="19" x2="15" y2="19"/>')}
        ${ieToolBtn('mosaic', '打码', '<rect x="4" y="4" width="6.4" height="6.4"/><rect x="13.6" y="4" width="6.4" height="6.4"/><rect x="4" y="13.6" width="6.4" height="6.4"/><rect x="13.6" y="13.6" width="6.4" height="6.4"/>')}
      </div>
      <input type="color" id="ie-color" value="#ff3b30" title="颜色">
      <span class="ie-thick" title="粗细"><input type="range" id="ie-size" min="1" max="60" value="5"><i id="ie-dot"></i></span>
      <button id="ie-undo" class="ghost-btn" title="撤销 ⌘Z">撤销</button>
    </div>
    <div class="imgedit-canvas-wrap"><canvas id="ie-canvas"></canvas></div>
    <div class="imgedit-export">
      <label>格式 <select id="ie-format"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WEBP</option></select></label>
      <label>宽度 <input id="ie-width" type="number" min="16" step="1"></label>
      <label id="ie-quality-wrap" style="display:none">质量 <input id="ie-quality" type="range" min="10" max="100" value="85"></label>
      <span class="ie-spacer"></span>
      <button id="ie-saveas" class="ghost-btn">另存为</button>
      <button id="ie-save" class="primary">保存</button>
    </div>`;
  const canvas = $('#ie-canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  $('#ie-width').value = img.naturalWidth;
  // 粗细随图分辨率自适应：大图默认更粗，才「看得出」；滑块上限也按图放大
  const defSize = Math.max(3, Math.round(img.naturalWidth / 250));
  const maxSize = Math.max(40, Math.round(img.naturalWidth / 30));
  const st = { e, img, canvas, ctx, tool: 'pen', color: '#ff3b30', size: defSize, undo: [], base: null, dragging: false, sx: 0, sy: 0, lastX: 0, lastY: 0, origExt, dirty: false };
  imgEditState = st;
  // 未保存守卫：图片一旦落过笔（dirty）就拦住离开，避免 Esc/✕ 静默清空画布
  dirtyCheck = () => !!imgEditState && imgEditState.dirty;
  const sizeInput = $('#ie-size'); sizeInput.max = String(maxSize); sizeInput.value = String(defSize);
  const fmtSel = $('#ie-format');
  fmtSel.value = ['jpg', 'jpeg'].includes(origExt) ? 'jpeg' : (origExt === 'webp' ? 'webp' : 'png');
  const toggleQ = () => { $('#ie-quality-wrap').style.display = fmtSel.value === 'png' ? 'none' : ''; };
  toggleQ();
  bindImageEditor(st, toggleQ);
}
function bindImageEditor(st, toggleQ) {
  $('#ie-tools').querySelectorAll('button').forEach((b) => { b.onclick = () => { st.tool = b.dataset.tool; $('#ie-tools').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); }; });
  // 粗细可视化：滑块旁的小圆点直观显示当前笔触粗细
  const updateDot = () => { const d = $('#ie-dot'); if (d) { const px = Math.min(22, Math.max(3, st.size)); d.style.width = px + 'px'; d.style.height = px + 'px'; d.style.background = st.color; d.title = st.size + 'px'; } };
  updateDot();
  $('#ie-color').oninput = (ev) => { st.color = ev.target.value; updateDot(); };
  $('#ie-size').oninput = (ev) => { st.size = Number(ev.target.value); updateDot(); };
  $('#ie-format').onchange = toggleQ;
  $('#ie-undo').onclick = () => ieUndo(st);
  const canvas = st.canvas;
  canvas.addEventListener('pointerdown', async (ev) => {
    const { x, y } = iePos(st, ev);
    if (st.tool === 'text') {
      const txt = await inputDialog('添加文字', '', '输入文字');
      if (!txt) return;
      st.undo.push(ieSnapshot(st)); if (st.undo.length > 25) st.undo.shift();
      const c = st.ctx; c.save(); c.fillStyle = st.color; c.textBaseline = 'top';
      c.font = `600 ${Math.max(14, st.size * 6)}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-ui')}`;
      c.fillText(txt, x, y); c.restore();
      st.dirty = true;
      return;
    }
    st.base = ieSnapshot(st); st.dragging = true; st.sx = x; st.sy = y; st.lastX = x; st.lastY = y;
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!st.dragging) return;
    const { x, y } = iePos(st, ev);
    if (st.tool === 'pen') {
      // 自由画笔：逐段累加，画任意形状（不还原 base）
      const c = st.ctx; c.save(); c.strokeStyle = st.color; c.lineWidth = st.size; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.moveTo(st.lastX, st.lastY); c.lineTo(x, y); c.stroke(); c.restore();
      st.lastX = x; st.lastY = y; return;
    }
    st.ctx.drawImage(st.base, 0, 0); // 还原到拖拽前，再画预览
    if (st.tool === 'mosaic') { st.ctx.save(); st.ctx.strokeStyle = st.color; st.ctx.setLineDash([6, 4]); st.ctx.lineWidth = 2; st.ctx.strokeRect(st.sx, st.sy, x - st.sx, y - st.sy); st.ctx.restore(); }
    else ieDrawShape(st, st.sx, st.sy, x, y);
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!st.dragging) return;
    st.dragging = false;
    const { x, y } = iePos(st, ev);
    if (st.tool !== 'pen') {
      st.ctx.drawImage(st.base, 0, 0);
      if (st.tool === 'mosaic') iePixelate(st, st.sx, st.sy, x, y);
      else ieDrawShape(st, st.sx, st.sy, x, y);
    }
    st.undo.push(st.base); if (st.undo.length > 25) st.undo.shift();
    st.dirty = true;
  });
  $('#ie-save').onclick = () => ieSave(st, false);
  $('#ie-saveas').onclick = () => ieSave(st, true);
}
function ieUndo(st) { const snap = st.undo.pop(); if (!snap) { toast('没有可撤销的'); return; } st.ctx.drawImage(snap, 0, 0); }
function ieExport(st) {
  const fmt = $('#ie-format').value;
  const w = Math.max(16, parseInt($('#ie-width').value, 10) || st.canvas.width);
  let out = st.canvas;
  if (w !== st.canvas.width) { const h = Math.round(st.canvas.height * (w / st.canvas.width)); out = document.createElement('canvas'); out.width = w; out.height = h; out.getContext('2d').drawImage(st.canvas, 0, 0, w, h); }
  const q = (parseInt($('#ie-quality').value, 10) || 85) / 100;
  const mime = fmt === 'jpeg' ? 'image/jpeg' : (fmt === 'webp' ? 'image/webp' : 'image/png');
  return { dataUrl: out.toDataURL(mime, q), ext: fmt === 'jpeg' ? 'jpg' : fmt };
}
async function ieSave(st, asNew) {
  const { dataUrl, ext } = ieExport(st);
  const sameType = st.origExt === ext || (['jpg', 'jpeg'].includes(st.origExt) && ext === 'jpg');
  let newName = null;
  if (asNew || !sameType) {
    const suggest = st.e.name.replace(/\.[^.]+$/, '') + (asNew ? '-编辑' : '') + '.' + ext;
    newName = await inputDialog(asNew ? '另存为' : '格式已变，另存为新文件', suggest, '文件名（含扩展名）');
    if (!newName) return;
  } else {
    // 覆盖原图不可逆且为有损重编码——给一次确认（删除都走废纸篓，覆盖更该拦）
    const ok = await confirmDialog('将覆盖原图、且重新编码（可能轻微降质），此操作不可恢复。确定覆盖？建议用「另存为」。');
    if (!ok) return;
  }
  const r = await apiPost('/api/image-save', { path: st.e.path, dataUrl, newName });
  if (r.error) { toast('保存失败：' + r.error, true); return; }
  toast(newName ? '已另存为 ' + baseOf(r.path) : '已保存（已覆盖原图）');
  imgEditState = null;
  await refresh();
  const saved = state.entries.find((x) => x.path === r.path) || st.e;
  applySelection(saved.path); openPreview(saved);
}

// ---------- 操作 ----------
// macOS 打开文件时 LaunchServices 会写 com.apple.lastuseddate#PS 扩展属性，FSEvents 据此连发事件——
// 内容没动却会点亮「改」徽标。自己发起的打开记下路径，3 秒内该文件的变更事件按噪声丢弃
const selfOpened = new Map(); // 绝对路径 -> 时间戳
async function openWith(p, withApp) {
  selfOpened.set(p, Date.now());
  const r = await apiPost('/api/open', { path: p, with: withApp });
  if (r.ok) {
    const used = r.with;
    if (used === 'reveal') toast('已在文件管理器中显示');
    else if (used === 'terminal') toast('已在终端打开此目录');
    else if (used === 'editor') toast('已在编辑器打开');
    else if (withApp === 'editor' && used === 'default') toast('未找到 code 命令，已用默认应用打开');
    else toast('已打开');
    loadFavorites();
  } else toast('打开失败：' + (r.error || ''), true);
}
async function copyPath(p) {
  try { await navigator.clipboard.writeText(p); toast('已复制路径'); }
  catch { toast('复制失败（浏览器限制），路径：' + p, true); }
}
// 记录最近打开：内部预览/编辑也算「打开过」，本地即时置顶 + 异步落库
function recordRecent(p) {
  if (!p) return;
  state.recentOpened = [p, ...(state.recentOpened || []).filter((x) => x !== p)].slice(0, 30);
  apiPost('/api/recent-open', { path: p }).catch(() => {});
}
async function toggleFav(e) {
  const r = await apiPost('/api/favorites', { path: e.path, name: e.name, isDir: e.isDir });
  state.favorites = r.favorites;
  renderFavs();
  if (!$('#preview').classList.contains('hidden') && state.selected === e.path) renderPreviewActions(e);
  // 只更新该项的星标，不重建网格（避免重新解码所有缩略图）
  const on = isFav(e.path);
  const star = $('#file-area').querySelector(`[data-path="${CSS.escape(e.path)}"] .fav-btn`);
  if (star) { star.classList.toggle('on', on); star.innerHTML = svgWrap(SVG.star, 'currentColor', 15, on); }
  toast(on ? '已收藏' : '已取消收藏');
}

// ---------- 文件操作（编辑 / 重命名 / 废纸篓 / 新建）----------
// 重拉当前目录但保留筛选词，操作后刷新视图
async function refresh() {
  if (!state.cwd || state.recentMode) return;
  const data = await api('/api/list?path=' + encodeURIComponent(state.cwd));
  if (data.error) return;
  state.entries = data.entries;
  state.project = data.project;
  state.breadcrumb = data.breadcrumb;
  renderBreadcrumb();
  renderFiles();
}
// 文本原地编辑：md → Milkdown Crepe 所见即所得；其它 → Monaco；都失败回退 textarea
async function enterEditMode(e) {
  if (follow.on) setFileFollow(false, '手动接管，文件跟随已停'); // 编辑时绝不能被跟随抢屏
  if (!await guardDirty()) return;
  currentEditor = null; // 新编辑器接管前先清旧重载钩子；md 会在 mdEditor 里重新挂
  mona.disposeIfAny();
  crepe.disposeIfAny();
  showPreviewPanel();
  state.selected = e.path;
  $('#preview-title').textContent = e.name;
  renderPreviewActions(e);
  renderPreviewFoot(e);
  const body = $('#preview-body');
  body.innerHTML = '<div class="cmdk-loading">加载中…</div>';
  const data = await api('/api/read?path=' + encodeURIComponent(e.path));
  if (data.tooLarge) {
    toast('文件太大，暂不支持原地编辑', true);
    renderTextPreview(data); return; // 统一回退只读渲染；代码也默认进编辑态了，回 openPreview 会死循环
  }
  if (isMdName(e.name)) return mdEditor(e, data); // md：所见即所得 + 自动保存 + 源码切换
  const ex = (data.ext || '').toLowerCase();
  let baseMtime = data.mtime; // 并发覆盖保护基准
  let getValue = null, baseline = '';
  let timer = null, paused = false, saving = false, statusHeld = false, lastSavedAt = 0;
  let chain = Promise.resolve(); // 写盘串行化：防抖到点的保存和离开时的 flush 不互相踩
  const setStatus = (t) => { const el = $('#ed-status'); if (el) el.textContent = t; };
  // 「xx 之前已保存」：1 分钟内显秒、1 小时内显「分:秒」、再久直接给最后保存的钟点
  const savedAgo = (ts) => {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return `${sec}秒之前已保存`;
    if (sec < 3600) return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}秒之前已保存`;
    const d = new Date(ts), p = (x) => String(x).padStart(2, '0');
    return `最后保存于 ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const renderSaved = () => {
    const el = $('#ed-status');
    if (!el) { if (edStatusTimer) { clearInterval(edStatusTimer); edStatusTimer = null; } return; } // 编辑器已关：自清
    if (saving || statusHeld || !lastSavedAt) return;
    el.textContent = savedAgo(lastSavedAt);
  };
  const doSave = async (force) => {
    if (!getValue || paused) return;
    const content = getValue();
    if (content === baseline) return;
    saving = true; setStatus('保存中…');
    const r = await apiPost('/api/write', { path: e.path, content, expectedMtime: force ? 0 : baseMtime });
    if (r.conflict) {
      paused = true;
      const ok = await confirmDialog('文件已被外部修改（可能是 agent 改的）。覆盖会丢掉外部改动，确定覆盖？');
      paused = false;
      if (ok) return doSave(true);
      saving = false; statusHeld = true; setStatus('未保存：文件被外部修改');
      return;
    }
    if (r.ok === false || r.error) { saving = false; statusHeld = true; setStatus('保存失败'); toast('保存失败：' + (r.error || ''), true); return; }
    baseMtime = r.mtime; baseline = content;
    lastSavedAt = Date.now(); saving = false; statusHeld = false; renderSaved();
  };
  const queue = () => { clearTimeout(timer); timer = setTimeout(() => { chain = chain.then(() => doSave()); }, 800); };
  const flush = () => { clearTimeout(timer); chain = chain.then(() => doSave()); return chain; };
  autosaveFlush = flush; // 离开（切文件/跳目录/关预览）时 guardDirty 把残余改动写掉，不弹确认框
  dirtyCheck = null;
  // 代码/文本编辑器顶部：撤销 / 重做两个小图标（按可用性灰显）+ 自动保存状态（和 md 一致，不再有「保存 / 完成」）
  const editorBar =
    `<div class="editor-bar"><button id="ed-undo" class="ghost-btn" title="撤销 ⌘Z" disabled>${ic('undo', 'currentColor', 15)}</button>` +
    `<button id="ed-redo" class="ghost-btn" title="重做 ⇧⌘Z" disabled>${ic('redo', 'currentColor', 15)}</button>` +
    `<span id="ed-status" class="editor-hint">自动保存</span></div>`;

  if (await mona.load()) {
    const monaco = window.monaco;
    body.innerHTML = editorBar + `<div id="ed-host" class="mona-host"></div>`;
    const ed = monaco.editor.create($('#ed-host'), {
      value: data.content || '', language: mona.lang(ex), theme: mona.themeName(),
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13, lineHeight: 1.7, automaticLayout: true, minimap: { enabled: false },
      scrollBeyondLastLine: false, renderWhitespace: 'none', tabSize: 2, wordWrap: mona.wraps(ex) ? 'on' : 'off',
      smoothScrolling: true, padding: { top: 10, bottom: 10 }, fontLigatures: true,
    });
    mona.editor = ed;
    getValue = () => ed.getValue();
    const model = ed.getModel();
    const undoBtn = $('#ed-undo'), redoBtn = $('#ed-redo');
    const setUR = (u, r) => { undoBtn.disabled = !u; redoBtn.disabled = !r; };
    // 用 alternativeVersionId 跟踪撤销/重做栈：没改动时俩都灰，撤销后才放开重做，回到栈顶则重做又变灰
    const initialVersion = model.getAlternativeVersionId();
    let curVersion = initialVersion, topVersion = initialVersion;
    ed.onDidChangeModelContent(() => {
      queue();
      const v = model.getAlternativeVersionId();
      if (v < curVersion) setUR(v !== initialVersion, true);    // 撤销
      else if (v <= topVersion) setUR(true, v !== topVersion);  // 重做
      else { topVersion = v; setUR(true, false); }              // 新编辑
      curVersion = v;
    });
    ed.addCommand(monaco.KeyMod.CmdCtrl | monaco.KeyCode.KeyS, () => flush()); // ⌘S 立即保存
    undoBtn.onclick = () => { ed.focus(); ed.trigger('bar', 'undo'); };
    redoBtn.onclick = () => { ed.focus(); ed.trigger('bar', 'redo'); };
    setTimeout(() => ed.focus(), 0);
  } else {
    body.innerHTML = editorBar + `<textarea id="ed-host" class="editor-area" spellcheck="false"></textarea>`;
    const ta = $('#ed-host');
    ta.value = data.content || '';
    ta.focus();
    getValue = () => ta.value;
    const undoBtn = $('#ed-undo'), redoBtn = $('#ed-redo');
    // 兜底编辑器查不到撤销栈，改过即放开两个键（execCommand 自己会判断有没有可撤销/重做的）
    ta.addEventListener('input', () => { queue(); undoBtn.disabled = false; redoBtn.disabled = false; });
    ta.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); flush(); }
      ev.stopPropagation(); // 别冒泡到主区键盘导航
    });
    undoBtn.onclick = () => { ta.focus(); document.execCommand('undo'); };
    redoBtn.onclick = () => { ta.focus(); document.execCommand('redo'); };
  }
  baseline = getValue ? getValue() : '';
  if (edStatusTimer) clearInterval(edStatusTimer);
  edStatusTimer = setInterval(renderSaved, 1000); // 每秒刷新「xx 之前已保存」
}
// md 预览即编辑：打开就是 Crepe 所见即所得，停笔 0.8s 自动落盘；「源码」按钮切 Monaco。
// 离开（切文件/跳目录/关预览）由 guardDirty 的 autosaveFlush 把残余改动写掉，不弹确认框。
async function mdEditor(e, data, mode = 'rich') {
  const body = $('#preview-body');
  // 拖图进编辑器时，浏览器常把卡片/预览缩略图的内部 URL（localhost/api-thumb、/fs 镜像）写进文档，
  // 而那是低清缩略图（w=160）链接，发出去就裂。这里统一还原成真实文件路径；外链 https/data: 不动。
  const cleanImgUrls = (md) => String(md)
    .replace(/(?:https?:\/\/localhost:\d+)?\/api\/(?:thumb|raw)\?path=([^)\s"'&]+)(?:&[^)\s"']*)?/g,
      (m, p) => { try { return decodeURIComponent(p); } catch { return m; } })
    .replace(/(?:https?:\/\/localhost:\d+)?\/fs\/([^)\s"']+)/g,
      (m, s) => { try { return '/' + s.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent).join('/'); } catch { return m; } });
  const imgDir = dirOf(e.path); // 粘贴/拖入/浏览插入的图片都存这——花叔已定：和 md 文件同目录
  // 富文本编辑器粘贴/拖入/浏览插入图片的落盘出口：接到文件面板/终端粘贴截图已经在用的
  // fanboxDrop.saveInto 上，别再造一套。返回绝对路径，写进 markdown 就是真文件，不是 blob:
  async function saveEditorImage(fileOrBlob, suggestedName) {
    if (!window.fanboxDrop) throw new Error('该环境不支持图片写盘');
    let name = suggestedName;
    if (!name || !/\.[a-z0-9]+$/i.test(name)) {
      const ext = ((fileOrBlob.type ? fileOrBlob.type.split('/')[1] : '') || 'png').toLowerCase().replace('jpeg', 'jpg');
      name = `图片-${fmtStamp()}.${ext}`;
    }
    const buf = await fileOrBlob.arrayBuffer();
    const r = await window.fanboxDrop.saveInto(imgDir, name, buf);
    if (!r || !r.ok) throw new Error((r && r.error) || '图片写盘失败');
    return r.path;
  }
  let baseMtime = data.mtime;
  let content0 = cleanImgUrls(data.content || ''); // canonical：磁盘原始 markdown（顺手还原历史遗留的内部预览 URL）；唯一事实源，编辑器只从它初始化
  let getValue = null, baseline = '';
  let timer = null, paused = false;
  let forceCode = false; // 该文件 Milkdown 往返有损 → 禁掉富文本（只剥夺「改」的权利，「看」仍走阅读模式）
  let reloading = false; // 外部变更重载 in-flight 锁：fs.watch 同一文件会连发多个事件，去重防并发 render 互踩
  let chain = Promise.resolve(); // 写盘串行化：防抖到点的保存和离开时的 flush 不互相踩
  const setStatus = (t) => { const s = $('#md-status'); if (s) s.textContent = t; };
  // Milkdown 往返是否「语义无损」：所见即所得必然规范化语法（- → *、表格补空格对齐、强调记号拆分等），
  // 逐字节比、甚至逐字节比 HTML，都会把干净文件误判有损。改用「语义指纹」：
  // 两份 markdown 各渲成 HTML，取 ①可见文字（空白折叠）②结构骨架（标签序列 + 图片/链接目标），
  // 两项都一致才算无损。只比文字会漏掉「图没了」，只比 HTML 会被排版差异带偏。
  // marked 不可用时退回严格比对（保守禁掉富文本，绝不误放行有损）。
  const semanticSig = (md) => {
    const d = document.createElement('div');
    d.innerHTML = window.marked.parse(md || '');
    const text = (d.textContent || '').replace(/\s+/g, ' ').trim();
    const bones = [];
    d.querySelectorAll('*').forEach((el) => {
      const t = el.tagName.toLowerCase();
      if (t === 'p' || t === 'strong' || t === 'em' || t === 'span') return; // 段落包裹、行内强调被拆成相邻两段，是序列化风格不是内容
      // 图注（alt）不出现在 textContent 里，但它是正文；不进指纹就等于放任图注被吞
      const attr = t === 'img'
        ? (el.getAttribute('src') || '') + '\u001f' + (el.getAttribute('alt') || '')
        : (el.getAttribute('href') || '');
      bones.push(t + attr);
    });
    return text + ' ' + bones.join('|');
  };
  const semanticEqual = (a, b) => {
    if (!window.marked || window.__noMarked) return a === b;
    try { return semanticSig(a) === semanticSig(b); } catch { return a === b; }
  };
  const doSave = async (force) => {
    if (!getValue || paused) return;
    const content = cleanImgUrls(getValue()); // 落盘前把新拖入图片的内部预览 URL 还原成真实路径
    if (content === baseline) return;
    setStatus('保存中…');
    const r = await apiPost('/api/write', { path: e.path, content, expectedMtime: force ? 0 : baseMtime });
    if (r.conflict) {
      paused = true;
      const ok = await confirmDialog('文件已被外部修改（可能是 agent 改的）。覆盖会丢掉外部改动，确定覆盖？');
      paused = false;
      if (ok) return doSave(true);
      setStatus('未保存：文件被外部修改');
      return;
    }
    if (r.ok === false || r.error) { setStatus('保存失败'); toast('保存失败：' + (r.error || ''), true); return; }
    baseMtime = r.mtime; baseline = content; content0 = content; // 落盘成功 → canonical 跟进，重载基准对齐
    setStatus('已保存');
  };
  const queue = () => { clearTimeout(timer); timer = setTimeout(() => { chain = chain.then(() => doSave()); }, 800); };
  const flush = () => { clearTimeout(timer); chain = chain.then(() => doSave()); return chain; };
  autosaveFlush = flush;
  dirtyCheck = null;
  // 排版：弹窗查看/导出，不再是编辑器的常驻模式——开这个面板不打断底下正在编辑的富文本/源码，
  // 关掉面板原地还在改。内容和交互跟以前的排版档一模一样，只是换了个容器。
  const openTypesetPanel = () => {
    const old = $('.typeset-overlay'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.className = 'input-overlay typeset-overlay';
    ov.innerHTML = `<div class="input-dialog typeset-dialog">
      <div class="editor-bar">
        <select id="ts-style" class="ts-select"></select>
        <button id="ts-wechat" class="primary">复制到公众号</button>
        <button id="ts-more">送去… ▾</button>
        <span id="ts-stat" class="editor-hint"></span>
      </div>
      <div id="ts-preview" class="ts-preview"></div>
    </div>`;
    document.body.appendChild(ov);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    ov.onclick = (ev) => { if (ev.target === ov) close(); };
    document.addEventListener('keydown', onKey, true);
    const sel = ov.querySelector('#ts-style');
    sel.innerHTML = typeset.list().map((s) =>
      `<option value="${s.id}"${s.id === typeset.current() ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    const preview = ov.querySelector('#ts-preview');
    const paint = () => {
      preview.innerHTML = '';
      const box = typeset.build(content0, e.path, typeset.current());
      preview.appendChild(box);
      ov.querySelector('#ts-stat').textContent = typeset.stat(box); // 发文前每次都想知道的两个数
    };
    paint();
    sel.onchange = () => { typeset.setCurrent(sel.value); paint(); };
    const setTsStatus = (t) => { const s = ov.querySelector('#ts-stat'); if (s) s.textContent = t; };
    const copy = async (btn, job) => {
      btn.disabled = true;
      try {
        const r = await job((i, n) => setTsStatus(`处理图片 ${i}/${n}…`));
        if (!r.ok) { setTsStatus('复制失败'); toast('复制失败，点一下窗口再试', true); }
        else if (r.failed) { setTsStatus('已复制'); toast(`已复制，但 ${r.failed} 张图没取到，粘过去会缺图`, true); }
        else { setTsStatus('已复制'); toast('已复制，去编辑器粘贴就行'); }
      } catch (err) { setTsStatus('复制失败'); toast('复制失败：' + (err.message || err), true); }
      finally { btn.disabled = false; }
    };
    ov.querySelector('#ts-wechat').onclick = (ev) => copy(ev.currentTarget, (onStep) => typeset.copyWechat(content0, e.path, typeset.current(), onStep));
    // 导出长图：小红书/朋友圈/即刻要的是图不是文。PNG 落在文章旁边、命名跟着文章走，不覆盖旧图
    const exportLong = async (btn) => {
      btn.disabled = true;
      setTsStatus('生成长图…');
      try {
        const r = await typeset.exportImage(content0, e.path, typeset.current(), (i, n) => setTsStatus(`处理图片 ${i}/${n}…`));
        const name = r.path.split('/').pop();
        setTsStatus('已导出');
        if (r.failed) toast(`长图已导出（${name}），但 ${r.failed} 张图没取到，图里会缺`, true);
        else toast(`长图已导出：${name}，就在文章旁边`);
        if (dirOf(e.path) === state.cwd) refresh(); // 正浏览文章所在目录时文件区跟上，png 立刻可见；在「最近」视图或别的目录时不刷，toast 已说明 png 就在文章旁边
      } catch (err) { setTsStatus('导出失败'); toast('导出失败：' + (err.message || err), true); }
      finally { btn.disabled = false; }
    };
    // 分节多图：小红书一条笔记发的是多图不是单张。按 h2 切，编号连续落在文章旁边
    const exportSlices = async (btn) => {
      btn.disabled = true;
      setTsStatus('切分节…');
      try {
        const r = await typeset.exportSlices(content0, e.path, typeset.current(),
          (i, n, kind) => setTsStatus(kind === 'slice' ? `生成第 ${i}/${n} 张…` : `处理图片 ${i}/${n}…`));
        const first = r.paths[0].split('/').pop();
        setTsStatus('已导出');
        // 18 是小红书一条笔记的图片上限，超了得自己挑——只提醒，不替他删
        if (r.count > 18) toast(`已导出 ${r.count} 张（${first} 起），超过小红书 18 图上限，发之前挑一下`, true);
        else if (r.failed) toast(`已导出 ${r.count} 张（${first} 起），但 ${r.failed} 张图没取到，图里会缺`, true);
        else toast(`已导出 ${r.count} 张：${first} 起，就在文章旁边`);
        if (dirOf(e.path) === state.cwd) refresh(); // 同单张导出：正浏览文章所在目录时文件区才跟上
      } catch (err) { setTsStatus('导出失败'); toast('导出失败：' + (err.message || err), true); }
      finally { btn.disabled = false; }
    };
    // 其余去向：剪贴板类/导出类自己干，平台类递一条指令给终端里的 agent（FanBox 不碰任何平台凭证）
    ov.querySelector('#ts-more').onclick = (ev) => (ev.stopPropagation(), popupMenu(ev, [ // 不拦的话这次点击会冒泡到 document，把刚弹出的菜单当场关掉
      { label: '复制到 X', fn: () => copy(ov.querySelector('#ts-more'), () => typeset.copyX(content0, e.path)) },
      { label: '导出长图', fn: () => exportLong(ov.querySelector('#ts-more')) },
      { label: '导出长图（分节）', fn: () => exportSlices(ov.querySelector('#ts-more')) },
      { sep: true },
      ...typeset.handoffs().map((d) => ({ label: d.label, fn: () => term.sendPrompt(d.prompt(e.path)) })),
    ]));
  };
  const render = async (m) => {
    if (forceCode && m === 'rich') m = 'read'; // 有损文件不给富文本改，但照样让人把文章看成文章
    mode = m;
    mona.disposeIfAny(); crepe.disposeIfAny();
    const hostCls = { rich: 'crepe-host', read: 'read-host', code: 'mona-host' }[m];
    const seg = (id, label, on) =>
      `<button class="seg-btn${m === id ? ' active' : ''}" data-m="${id}"${on ? '' : ' disabled title="此文件含富文本无法无损保存的语法，改请用源码"'}>${label}</button>`;
    const hint = m === 'read' ? (forceCode ? '只读 · 此文件富文本往返有损，要改请点源码' : '只读 · 要改请点富文本或源码')
      : '自动保存 · ⌘S 立即保存';
    // 插入图片：source/rich 都能用，唯独只读（有损文件的兜底阅读态）没意义，不给按钮添乱
    const insImgBtn = m !== 'read' ? `<button id="ed-insimg-btn" class="ghost-btn" type="button">+ 插入图片</button>` : '';
    body.innerHTML =
      `<div class="editor-bar"><div class="ed-modes">${seg('rich', '富文本', !forceCode)}${seg('code', '源码', true)}</div>` +
      insImgBtn +
      `<button id="ed-typeset-btn" class="ghost-btn" type="button">排版…</button>` +
      `<span id="md-status" class="editor-hint">${hint}</span></div>` +
      `<div id="ed-host" class="${hostCls}"></div>`;
    body.querySelectorAll('.ed-modes .seg-btn').forEach((b) => {
      if (b.disabled || b.dataset.m === m) return;
      b.onclick = async () => {
        await flush();
        const cur = getValue ? getValue() : content0;
        if (cur !== baseline) content0 = cleanImgUrls(cur); // 只有真编辑过才采纳编辑器的值（顺手还原拖入图片的内部 URL）；没改就保留磁盘原文，不被 Milkdown 规范化
        render(b.dataset.m);
      };
    });
    // 排版不再是常驻模式——发文前想看看/复制走，弹一下就行，不该打断正在编辑的富文本/源码
    $('#ed-typeset-btn').onclick = async () => {
      await flush();
      const cur = getValue ? getValue() : content0;
      if (cur !== baseline) content0 = cleanImgUrls(cur);
      openTypesetPanel();
    };
    const host = $('#ed-host');
    if (m === 'read') {
      host.appendChild(mdReadBody(content0, e.path));
      getValue = () => content0; // 只读：永远不脏，自动保存链路自然空转
    } else if (m === 'rich') {
      const C = await crepe.load();
      if (!C) { render('code'); return; } // Crepe 加载失败 → 源码模式兜底
      // 保护 YAML frontmatter：Crepe 不识别会丢掉，剥离后只把正文交给它，保存时再拼回
      const fm = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(content0);
      const front = fm ? fm[1] : '';
      const featureConfigs = C.imageFeatureConfigs ? C.imageFeatureConfigs(saveEditorImage) : undefined;
      const inst = new C.Crepe({ root: host, defaultValue: front ? content0.slice(front.length) : content0, featureConfigs });
      if (C.keepImageAlt) C.keepImageAlt(inst.editor); // 图注归 alt，别被 Milkdown 拿去存缩放比例
      if (C.configureImageUpload) C.configureImageUpload(inst.editor, saveEditorImage); // 真截图粘贴 + Finder 拖文件 + 粘贴 HTML 里带 blob:/data: 的 <img> 都存成同目录真文件
      if (C.addImageMoveControls) C.addImageMoveControls(inst.editor); // 每张图常驻的上移/下移按钮，重排不用等 Crepe 那个够不着的拖拽 handle
      await inst.create();
      // 语义无损校验：Milkdown 序列化回来若渲染结果和磁盘原文不同（<br/> 被吞、HTML 被删等真丢内容）→ 禁掉富文本，绝不让它静默落盘
      if (!semanticEqual(front + inst.getMarkdown(), content0)) {
        crepe.disposeIfAny();
        forceCode = true;
        toast('此文件富文本往返有损，已切到只读阅读模式（要改点源码）');
        return render('read');
      }
      try { inst.on((l) => l.markdownUpdated(() => queue())); } catch { /* 旧版 Crepe 无 .on，靠下面的 input 兜底 */ }
      host.addEventListener('input', () => queue(), true); // 兜底：键入路径一定触发
      crepe.editor = inst;
      getValue = () => front + inst.getMarkdown();
      // ⌘S 立即保存：捕获阶段拦在 ProseMirror 与全局键盘导航之前
      host.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); ev.stopPropagation(); flush(); }
      }, true);
    } else if (await mona.load()) {
      const monaco = window.monaco;
      const ed = monaco.editor.create(host, {
        value: content0, language: 'markdown', theme: mona.themeName(),
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
        fontSize: 13, lineHeight: 1.7, automaticLayout: true, minimap: { enabled: false },
        scrollBeyondLastLine: false, renderWhitespace: 'none', tabSize: 2, wordWrap: 'on',
        smoothScrolling: true, padding: { top: 10, bottom: 10 }, fontLigatures: true,
      });
      mona.editor = ed;
      getValue = () => ed.getValue();
      ed.onDidChangeModelContent(() => queue());
      ed.addCommand(monaco.KeyMod.CmdCtrl | monaco.KeyCode.KeyS, () => flush());
    } else {
      const ta = document.createElement('textarea');
      ta.id = 'ed-host'; ta.className = 'editor-area'; ta.spellcheck = false;
      host.replaceWith(ta);
      ta.value = content0;
      getValue = () => ta.value;
      ta.addEventListener('input', () => queue());
      ta.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); flush(); }
        ev.stopPropagation(); // 别冒泡到主区键盘导航
      });
    }
    // 插入图片：按当前模式把真实路径插到光标处
    const insertImagePath = (src) => {
      if (m === 'rich' && crepe.editor && window.FanboxCrepe && window.FanboxCrepe.insertImageAtCursor) {
        window.FanboxCrepe.insertImageAtCursor(crepe.editor.editor, src);
      } else if (mona.editor) {
        const ed = mona.editor;
        ed.executeEdits('insert-image', [{ range: ed.getSelection(), text: `![](${src})`, forceMoveMarkers: true }]);
        ed.focus();
      } else {
        const ta = $('.editor-area');
        if (ta) {
          ta.setRangeText(`![](${src})`, ta.selectionStart, ta.selectionEnd, 'end');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.focus();
        }
      }
    };
    const insImgEl = $('#ed-insimg-btn');
    if (insImgEl) {
      insImgEl.onclick = async () => {
        // 桌面 app：Electron 原生选图对话框，默认目录直接开在 md 文件所在目录；已经在这棵目录树下的图
        // 直接引用真实路径不复制，不在树下的才复制进来，跟粘贴/拖入落点一致
        if (window.fanboxDrop && window.fanboxDrop.pickImages) {
          const r = await window.fanboxDrop.pickImages(imgDir);
          if (!r || !r.ok) { toast('选图失败：' + ((r && r.error) || ''), true); return; }
          for (const p of r.paths || []) {
            try {
              let src = p;
              if (p !== imgDir && !p.startsWith(imgDir + '/')) {
                const r2 = await window.fanboxDrop.copyInto(p, imgDir);
                if (!r2 || !r2.ok) { toast('图片复制失败：' + ((r2 && r2.error) || ''), true); continue; }
                src = r2.path;
              }
              insertImagePath(src);
            } catch (err) { toast('插入图片失败：' + (err.message || err), true); }
          }
          return;
        }
        // 网页/开发环境兜底：普通 <input type=file>，浏览器不允许网页指定默认打开目录
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
        input.onchange = async () => {
          for (const f of [...(input.files || [])]) {
            try { insertImagePath(await saveEditorImage(f, f.name)); }
            catch (err) { toast('插入图片失败：' + (err.message || err), true); }
          }
        };
        input.click();
      };
    }
    baseline = getValue(); // 以编辑器规范化后的内容为基准：打开不编辑就不会触发写盘
  };
  // 外部变更重载钩子（option 4）：编辑器未脏 → 静默重载磁盘最新内容；脏 → 不动，靠保存时的 mtime 冲突保护兜底
  currentEditor = {
    path: e.path,
    // 防御：render 切换/重载途中旧编辑器已 dispose、新 getValue 未赋值，此刻被调到就当「未脏」放行重载
    isDirty: () => { try { return !!getValue && getValue() !== baseline; } catch { return false; } },
    reload: async () => {
      if (reloading) return; // 同一文件连发多个变更事件 → 只跑一次，避免并发 render 互相 dispose
      reloading = true;
      try {
        const fresh = await api('/api/read?path=' + encodeURIComponent(e.path));
        if (!fresh || fresh.error || fresh.tooLarge) return;
        if (Math.abs((fresh.mtime || 0) - baseMtime) <= 1) return; // 自己刚写的 / 无实质变化，不折腾（容差对齐 server 端冲突判定）
        const wasForced = forceCode; // 之前是被迫锁源码的吗？
        content0 = fresh.content || ''; baseMtime = fresh.mtime; forceCode = false; // 重新读盘 → 重做无损判定
        await render(wasForced ? 'rich' : mode); // 被迫锁源码过 → 重走富文本入口重判无损（锁定指示器才准）；否则保持当前模式
        toast('文件已被外部更新，编辑器已重新加载');
      } finally { reloading = false; }
    },
  };
  await render(mode);
}
async function doRename(e) {
  const name = await inputDialog('重命名', e.name, '输入新名称');
  if (!name || name === e.name) return;
  const r = await apiPost('/api/rename', { path: e.path, newName: name });
  if (r.error) { toast('重命名失败：' + r.error, true); return; }
  toast('已重命名');
  if (state.selected === e.path) state.selected = r.path;
  await refresh();
}
async function doTrash(e) {
  // 文件秒删（花叔的选择），但删整个文件夹给一次轻确认——误删项目目录代价高
  if (e.isDir) {
    const ok = await confirmDialog(`把文件夹「${e.name}」移到废纸篓？可从废纸篓恢复。`);
    if (!ok) return;
  }
  const r = await apiPost('/api/trash', { path: e.path });
  if (r.error) { toast('删除失败：' + r.error + '（首次需在弹窗里允许控制 Finder）', true); return; }
  toast('已移到废纸篓，可从废纸篓恢复');
  if (state.selected === e.path) closePreview();
  await refresh();
}
async function doCreate(type) {
  const name = await inputDialog(type === 'dir' ? '新建文件夹' : '新建文件', '', type === 'dir' ? '文件夹名称' : '文件名（带扩展名，如 note.md）');
  if (!name) return;
  const r = await apiPost('/api/create', { path: state.cwd, name, type });
  if (r.error) { toast('新建失败：' + r.error, true); return; }
  toast(type === 'dir' ? '已新建文件夹' : '已新建文件');
  await refresh();
  // 新建文件顺手打开编辑
  if (type === 'file') { const ne = state.entries.find((x) => x.path === r.path); if (ne && ne.kind === 'text') enterEditMode(ne); }
}
// 通用输入弹窗（替代原生 prompt，配合皮肤）
function inputDialog(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'input-overlay';
    ov.innerHTML = `<div class="input-dialog"><div class="input-title">${escapeHtml(title)}</div>
      <input class="input-field" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" spellcheck="false">
      <div class="input-actions"><button class="ghost-btn" data-act="cancel">取消</button><button class="primary" data-act="ok">确定</button></div></div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('.input-field');
    inp.focus();
    inp.select();
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('[data-act=ok]').onclick = () => done(inp.value.trim());
    ov.querySelector('[data-act=cancel]').onclick = () => done(null);
    ov.onclick = (ev) => { if (ev.target === ov) done(null); };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); done(inp.value.trim()); }
      else if (ev.key === 'Escape') { ev.preventDefault(); done(null); }
    });
  });
}
// 是/否确认弹窗
function confirmDialog(msg) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'input-overlay';
    ov.innerHTML = `<div class="input-dialog"><div class="input-title">${escapeHtml(msg)}</div><div class="input-actions"><button class="ghost-btn" data-act="no">取消</button><button class="primary" data-act="yes">确定</button></div></div>`;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); done(false); } else if (ev.key === 'Enter') { ev.preventDefault(); done(true); } }
    ov.querySelector('[data-act=yes]').onclick = () => done(true);
    ov.querySelector('[data-act=no]').onclick = () => done(false);
    ov.onclick = (ev) => { if (ev.target === ov) done(false); };
    document.addEventListener('keydown', onKey, true);
    ov.querySelector('[data-act=yes]').focus();
  });
}
// ---------- 截图直通车：系统截屏落盘 → 右下角浮出直通卡，终端/素材/标注一步到位 ----------
const shotTray = {
  el: null, timer: null,
  init() {
    if (!window.fanboxShot) return; // 浏览器版没有截屏监听
    window.fanboxShot.onNew((m) => this.show(m));
  },
  show(m) {
    this.dismiss();
    const el = document.createElement('div');
    el.className = 'shot-card';
    el.innerHTML = `
      <img class="shot-thumb" draggable="true" src="/api/thumb?path=${encodeURIComponent(m.path)}&w=480&v=${m.size}" title="新截图 · 可拖进终端" data-retry="0">
      <div class="shot-info"><div class="shot-name">${escapeHtml(m.name)}</div>
      <div class="shot-acts">
        <button data-act="term" title="把路径喂给终端里的 agent">→ 终端</button>
        <button data-act="save" title="移动到当前文件夹的 素材/ 子目录">收进素材</button>
        <button data-act="edit" title="圈重点再发">标注</button>
        <button data-act="close" title="不理它也会自己走">✕</button>
      </div></div>`;
    document.body.appendChild(el);
    this.el = el;
    const img = el.querySelector('.shot-thumb');
    // 缩略图首次加载偶尔失败（文件刚写完、缩略图还在生成）：重试几次再放弃，别一裂到底
    img.onerror = () => {
      const n = +(img.dataset.retry || 0);
      if (n >= 4) { img.style.visibility = 'hidden'; return; } // 实在不行就藏掉裂图，不难看
      img.dataset.retry = n + 1;
      setTimeout(() => { img.src = `/api/thumb?path=${encodeURIComponent(m.path)}&w=480&v=${m.size}&r=${n + 1}`; }, 400 * (n + 1));
    };
    img.ondragstart = (ev) => ev.dataTransfer.setData('text/plain', m.path);
    img.onclick = () => lightbox(m.path);
    el.querySelector('[data-act=term]').onclick = () => { term.insertPath(m.path); this.dismiss(); };
    el.querySelector('[data-act=save]').onclick = async () => {
      const r = await apiPost('/api/move', { src: m.path, dstDir: state.cwd + '/素材' });
      if (r.ok) toast('已收进 素材/'); else toast(r.error || '移动失败', true);
      this.dismiss();
    };
    el.querySelector('[data-act=edit]').onclick = () => {
      this.dismiss();
      enterImageEdit({ path: m.path, name: m.name, kind: 'image', size: m.size, mtime: Date.now() });
    };
    el.querySelector('[data-act=close]').onclick = () => this.dismiss();
    this.timer = setTimeout(() => this.dismiss(), 45000);
  },
  dismiss() { clearTimeout(this.timer); if (this.el) { this.el.remove(); this.el = null; } },
};

// 项目记忆：这个文件夹里 AI 干过什么——历史会话考古，可展开改过的文件，可一键续上
async function memoryPanel(dirPath) {
  const old = $('.mem-overlay'); if (old) old.remove();
  const ov = document.createElement('div');
  ov.className = 'input-overlay mem-overlay';
  ov.innerHTML = `<div class="input-dialog mem-dialog">
    <div class="input-title">项目记忆 · ${escapeHtml(dirPath.replace(state.home, '~'))}</div>
    <div class="mem-body"><div class="cmdk-loading">翻会话日志中…</div></div></div>`;
  document.body.appendChild(ov);
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  ov.onclick = (ev) => { if (ev.target === ov) close(); };
  document.addEventListener('keydown', onKey, true);
  const d = await api('/api/project-memory?path=' + encodeURIComponent(dirPath));
  const body = ov.querySelector('.mem-body');
  if (!d.ok || !d.sessions.length) {
    body.innerHTML = '<div class="empty-state">这个文件夹还没有 agent 会话记录<br><br><span class="usage-sub">在这里跑过 Claude Code / Codex / Kimi / opencode 之后，历史会话会出现在这里</span></div>';
    return;
  }
  // 徽标/续接命令从注册表的 sessions 配置读，不再按 agent 逐个硬编码；没配置的兜底成首字母徽标
  const sessCfg = (agent) => (AGENT_REGISTRY.find((a) => a.id === agent) || {}).sessions || {};
  body.innerHTML = d.sessions.map((s, i) => `
    <div class="mem-sess">
      <div class="mem-head" data-i="${i}">
        <span class="mem-agent${s.agent === 'claude' ? '' : ' codex'}">${escapeHtml(sessCfg(s.agent).badge || (s.agent || '?')[0].toUpperCase())}</span>
        <span class="mem-title">${escapeHtml(s.title || '（无标题会话）')}</span>
        <button class="ghost-btn mem-resume" data-i="${i}" title="在内嵌终端里接上这段会话的上下文继续">▶ 续上</button>
      </div>
      <div class="mem-meta">${fmtTime(s.lastT)}${s.userMsgs != null ? ` · ${s.userMsgs} 条消息` : ''}${s.files.length ? ` · 改了 ${s.files.length} 个文件` : ''}${s.skills.length ? ' · ' + s.skills.map((k) => `<i class="mem-skill">${escapeHtml(k)}</i>`).join(' ') : ''}</div>
      ${s.files.length ? `<div class="mem-files hidden">${s.files.map((f) => `<div class="mem-file" data-p="${escapeHtml(f)}" title="${escapeHtml(f)}">${escapeHtml(f.startsWith(dirPath + '/') ? f.slice(dirPath.length + 1) : f.replace(state.home, '~'))}</div>`).join('')}</div>` : ''}
    </div>`).join('');
  body.querySelectorAll('.mem-head').forEach((h) => {
    h.onclick = (ev) => {
      if (ev.target.closest('.mem-resume')) return;
      const files = h.parentElement.querySelector('.mem-files');
      if (files) files.classList.toggle('hidden');
    };
  });
  body.querySelectorAll('.mem-resume').forEach((b) => {
    b.onclick = () => {
      const s = d.sessions[Number(b.dataset.i)];
      const tpl = sessCfg(s.agent).resumeCmd || 'claude --dangerously-skip-permissions --resume {id}';
      const cmd = tpl.replace('{id}', s.id);
      close();
      term.runInDir(dirPath, cmd, '已在终端续上会话');
    };
  });
  body.querySelectorAll('.mem-file').forEach((f) => {
    f.onclick = async () => {
      const p = f.dataset.p;
      close();
      await navigate(dirOf(p));
      const e = state.entries.find((x) => x.path === p);
      if (e) { state.selected = p; openPreview(e); renderFiles(); }
    };
  });
}

// 回合存档：agent 每轮开工前的自动快照列表 + 一键回滚。
// 「AI 弄坏了东西怎么办」从一种恐惧变成一个按钮：回滚前会再自动存一份，回滚本身也能滚回来
async function snapshotPanel(dirPath) {
  const old = $('.snap-overlay'); if (old) old.remove();
  const ov = document.createElement('div');
  ov.className = 'input-overlay snap-overlay';
  ov.innerHTML = `<div class="input-dialog snap-dialog">
    <div class="input-title">回合存档 · ${escapeHtml(dirPath.replace(state.home, '~'))}</div>
    <div class="snap-body"><div class="cmdk-loading">读存档中…</div></div></div>`;
  document.body.appendChild(ov);
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  ov.onclick = (ev) => { if (ev.target === ov) close(); };
  document.addEventListener('keydown', onKey, true);
  const d = await api('/api/snapshots?path=' + encodeURIComponent(dirPath));
  const body = ov.querySelector('.snap-body');
  if (!d.project || !d.snaps.length) {
    body.innerHTML = '<div class="empty-state">这个文件夹还没有存档<br><br><span class="usage-sub">在内嵌终端里跑 agent 时，每轮开工前会自动存一份，坏了随时能回来</span></div>';
    return;
  }
  const clock = (ts) => {
    const t = new Date(ts); const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return t.toDateString() === new Date().toDateString() ? hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`;
  };
  const projName = baseOf(d.project);
  body.innerHTML = `<div class="snap-hint">每一条都是当时整个项目的完整状态。恢复前会自动把当前状态也存一份，随时能再滚回来。</div>` +
    d.snaps.map((s, i) => `
    <div class="snap-row">
      <span class="snap-time" title="${new Date(s.ts).toLocaleString()}">${clock(s.ts)}</span>
      <span class="snap-lb">${escapeHtml(s.label)}${i === 0 ? '<i class="snap-latest">最新</i>' : ''}</span>
      <span class="snap-ago">${fmtTime(s.ts)}</span>
      <button class="ghost-btn snap-restore" data-i="${i}">回到这时</button>
    </div>`).join('');
  body.querySelectorAll('.snap-restore').forEach((b) => {
    b.onclick = async () => {
      const s = d.snaps[Number(b.dataset.i)];
      // agent 正在这个项目里干活时不给回滚：一边写一边恢复只会两败俱伤
      let busy = false;
      term.sessions.forEach((t) => {
        const c = t.cwd || t.startDir || '';
        if (!t.dead && t.status === 'busy' && (c === d.project || c.startsWith(d.project + '/') || d.project.startsWith(c + '/'))) busy = true;
      });
      if (busy) { toast('这个项目的 agent 正在干活，先等它停下（或按 Esc 打断）再恢复', true); return; }
      if (!await confirmDialog(`把「${projName}」整个恢复到 ${clock(s.ts)} 存档时的样子？之后的改动会被移除（当前状态已自动存档，可再滚回来）`)) return;
      b.disabled = true; b.textContent = '恢复中…';
      const r = await apiPost('/api/snapshot-restore', { path: d.project, hash: s.hash });
      if (!r.ok) { toast(r.error || '恢复失败', true); b.disabled = false; b.textContent = '回到这时'; return; }
      close();
      toast(`已恢复到 ${clock(s.ts)} · 恢复前的状态也存了一份`);
      navigate(state.cwd);
    };
  });
}

// AI 整理：一键在内嵌终端拉起交互式 agent（claude/codex）对话式整理。
// 翻箱只备料——把整理偏好、过往整理历史、工作约定写成 brief 文件，agent 读完先摊方案，
// 你在终端里对话确认/调整后它才动手；每批移动写回滚日志，想撤销在对话里说一声就行
async function organizeLaunch(dirPath) {
  const r = await apiPost('/api/organize/launch', { path: dirPath });
  if (!r.ok) { toast(r.error || 'AI 整理启动失败', true); return; }
  term.runInDir(dirPath, r.cmd, `${r.engine === 'codex' ? 'Codex' : 'Claude'} 已开聊——先摊方案，你点头它才动手`);
}

// 发版向导：版本号 + 发布说明（预填 CHANGELOG 的 Unreleased 段）→ 命令序列在内嵌终端跑，每步可见可拦
async function releasePanel() {
  const dirPath = state.cwd;
  const old = $('.rel-overlay'); if (old) old.remove();
  const ov = document.createElement('div');
  ov.className = 'input-overlay rel-overlay';
  ov.innerHTML = `<div class="input-dialog rel-dialog"><div class="input-title">发版</div><div class="rel-body"><div class="cmdk-loading">检查项目状态…</div></div></div>`;
  document.body.appendChild(ov);
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  ov.onclick = (ev) => { if (ev.target === ov) close(); };
  document.addEventListener('keydown', onKey, true);
  const d = await api('/api/release/inspect?path=' + encodeURIComponent(dirPath));
  const body = ov.querySelector('.rel-body');
  if (!d.ok) { body.innerHTML = `<div class="empty-state">${escapeHtml(d.error)}</div>`; return; }
  const bump = d.version.replace(/(\d+)(\D*)$/, (m, n, t) => (Number(n) + 1) + t);
  body.innerHTML = `
    <div class="rel-row"><label>版本号</label><span class="rel-cur">当前 v${escapeHtml(d.version)} →</span><input id="rel-ver" value="${escapeHtml(bump)}" spellcheck="false"></div>
    <div class="rel-row rel-col"><label>发布说明${d.unreleased ? '（预填自 CHANGELOG 的 Unreleased 段）' : ''}</label><textarea id="rel-notes" rows="8" spellcheck="false">${escapeHtml(d.unreleased)}</textarea></div>
    <div class="rel-opts">
      ${d.hasDist ? '<label><input type="checkbox" id="rel-dist" checked> 打包（npm run dist）</label>' : ''}
      ${d.remote ? '<label><input type="checkbox" id="rel-push" checked> 推送（git push）</label>' : ''}
      ${d.gh && d.remote ? '<label><input type="checkbox" id="rel-gh" checked> GitHub Release' + (d.hasDist ? '（附 dmg）' : '') + '</label>' : ''}
    </div>
    ${d.dirty ? '<div class="rel-hint">工作区有未提交改动，会一并进这次发版 commit</div>' : ''}
    ${!d.isRepo ? '<div class="rel-hint">这里不是 git 仓库，只能改版本号</div>' : ''}
    <div class="input-actions"><button class="ghost-btn" id="rel-cancel">取消</button><button class="primary" id="rel-go">在终端开跑</button></div>`;
  $('#rel-cancel').onclick = close;
  $('#rel-go').onclick = async () => {
    const version = $('#rel-ver').value.trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) { toast('版本号要 x.y.z 格式', true); return; }
    $('#rel-go').disabled = true;
    const r = await apiPost('/api/release/prepare', {
      path: dirPath, version,
      notes: $('#rel-notes').value,
      doDist: !!($('#rel-dist') && $('#rel-dist').checked),
      doPush: !!($('#rel-push') && $('#rel-push').checked),
      doRelease: !!($('#rel-gh') && $('#rel-gh').checked),
    });
    if (!r.ok) { toast(r.error || '准备失败', true); $('#rel-go').disabled = false; return; }
    close();
    term.runInDir(dirPath, r.cmd, `v${version} 发版序列已在终端开跑`);
  };
}

// 磁盘占用透视：du 口径的真实占用条形榜，目录行可下钻
async function diskPanel(dirPath) {
  const old = $('.disk-overlay'); if (old) old.remove();
  const ov = document.createElement('div');
  ov.className = 'input-overlay disk-overlay';
  ov.innerHTML = `<div class="input-dialog disk-dialog">
    <div class="input-title disk-title"></div>
    <div class="disk-body"><div class="cmdk-loading">计算中…（大目录会慢几秒）</div></div></div>`;
  document.body.appendChild(ov);
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  ov.onclick = (ev) => { if (ev.target === ov) close(); };
  document.addEventListener('keydown', onKey, true);
  const load = async (p) => {
    ov.querySelector('.disk-title').textContent = '磁盘占用 · ' + p.replace(state.home, '~');
    const body = ov.querySelector('.disk-body');
    body.innerHTML = '<div class="cmdk-loading">计算中…（大目录会慢几秒）</div>';
    const d = await api('/api/du?path=' + encodeURIComponent(p));
    if (!d.ok) { body.innerHTML = `<div class="empty-state">${escapeHtml(d.error || '读取失败')}</div>`; return; }
    const max = d.items.length ? d.items[0].size : 1;
    const up = p !== '/' ? `<div class="disk-row disk-up" data-dir="${escapeHtml(dirOf(p))}"><span class="disk-name">↑ 上一级</span></div>` : '';
    body.innerHTML = `<div class="disk-total">共 ${fmtSize(d.total)}${d.more ? ` · 只显示前 ${d.items.length} 项` : ''}</div>` + up +
      d.items.map((it) => `<div class="disk-row${it.isDir ? ' is-dir' : ''}" data-dir="${it.isDir ? escapeHtml(p + '/' + it.name) : ''}">
        <i class="disk-bar" style="width:${Math.max(1, Math.round(it.size / max * 100))}%"></i>
        <span class="disk-name">${it.isDir ? '📁 ' : ''}${escapeHtml(it.name)}</span><span class="disk-size">${fmtSize(it.size)}</span></div>`).join('');
    body.querySelectorAll('.disk-row[data-dir]').forEach((r) => {
      if (r.dataset.dir) r.onclick = () => load(r.dataset.dir);
    });
  };
  load(dirPath);
}

// 右键上下文菜单
function closeContextMenu() { const m = $('#context-menu'); if (m) m.remove(); }
function showContextMenu(ev, e) {
  ev.preventDefault();
  closeContextMenu();
  const items = [];
  if (e.isDir) items.push({ label: '打开', fn: () => navigate(e.path) });
  else items.push({ label: '预览', fn: () => { state.selected = e.path; openPreview(e); renderFiles(); } });
  if (e.isDir) items.push({ label: 'AI 整理…', fn: () => organizeLaunch(e.path) });
  if (e.isDir) items.push({ label: '磁盘占用透视', fn: () => diskPanel(e.path) });
  if (e.isDir) items.push({ label: '在终端打开', fn: () => term.openInDir(e.path) });
  else items.push({ label: '在所在目录开终端', fn: () => term.openInDir(dirOf(e.path)) });
  if (e.kind === 'text') items.push({ label: '编辑文本', fn: () => enterEditMode(e) });
  if (e.kind === 'image') items.push({ label: '编辑图片', fn: () => enterImageEdit(e) });
  items.push({ label: '在编辑器打开', fn: () => openWith(e.path, 'editor') });
  items.push({ label: '在 Finder 显示', fn: () => openWith(e.path, 'reveal') });
  items.push({ label: '复制路径', fn: () => copyPath(e.path) });
  items.push({ sep: true });
  items.push({ label: isFav(e.path) ? '取消收藏' : '收藏', fn: () => toggleFav(e) });
  items.push({ label: '重命名…', fn: () => doRename(e) });
  items.push({ label: '移到废纸篓', danger: true, fn: () => doTrash(e) });
  popupMenu(ev, items);
}
// 在鼠标位置弹一个菜单（右键菜单与空白处双击菜单共用）
function popupMenu(ev, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.className = 'context-menu';
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); return; }
    const b = document.createElement('div');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { closeContextMenu(); it.fn(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(ev.clientX, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(ev.clientY, window.innerHeight - mh - 8) + 'px';
}

// ---------- 侧边栏 ----------
// 侧栏目录树：目录项带展开箭头，点箭头逐级懒加载子目录（只列文件夹），点行本身仍是跳转
function navDirLi(name, p) {
  const li = document.createElement('li');
  li.dataset.path = p;
  const twirl = document.createElement('span');
  twirl.className = 'twirl';
  twirl.textContent = '▸';
  twirl.title = '展开子文件夹';
  twirl.onclick = (ev) => { ev.stopPropagation(); toggleNavSub(li, p, twirl); };
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.innerHTML = svgWrap(SVG.folder, 'currentColor', 16, true);
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = name;
  label.title = p;
  li.append(twirl, ico, label);
  li.onclick = () => navigate(p);
  makeDraggablePath(li, p);
  return li;
}
async function toggleNavSub(li, dirPath, twirl) {
  const old = li.nextElementSibling;
  if (old && old.classList.contains('nav-sub')) { old.remove(); twirl.textContent = '▸'; return; }
  twirl.textContent = '▾';
  const ul = document.createElement('ul');
  ul.className = 'nav-list nav-sub';
  li.after(ul);
  try {
    const data = await api('/api/list?path=' + encodeURIComponent(dirPath));
    const dirs = (data.entries || []).filter((e) => e.isDir && !e.hidden);
    if (!dirs.length) { ul.innerHTML = '<div class="nav-empty">没有子文件夹</div>'; return; }
    dirs.forEach((e) => ul.appendChild(navDirLi(e.name, e.path)));
  } catch { ul.remove(); twirl.textContent = '▸'; }
}
async function loadRoots() {
  const data = await api('/api/roots');
  state.home = data.home;
  state.platform = data.platform;
  state.sep = data.sep || '/';
  const ul = $('#roots-list');
  ul.innerHTML = '';
  data.roots.forEach((r) => ul.appendChild(navDirLi(r.name, r.path)));
}
function renderRootsActive() {
  // 快速入口 / 收藏 / agent 项目 三个列表统一高亮「当前所在目录」，让用户清楚自己点开/身处哪一项
  ['#roots-list', '#favs-list', '#agent-projects-list'].forEach((sel) => {
    const ul = $(sel); if (!ul) return;
    ul.querySelectorAll('li').forEach((li) => li.classList.toggle('active', li.dataset.path === state.cwd));
  });
}
async function loadFavorites() {
  const data = await api('/api/favorites');
  state.favorites = data.favorites || [];
  state.recentOpened = data.recentOpened || [];
  renderFavs();
}
function renderFavs() {
  const ul = $('#favs-list');
  ul.innerHTML = '';
  if (!state.favorites.length) { ul.innerHTML = '<div class="nav-empty">悬停文件点 ☆ 即可收藏</div>'; return; }
  state.favorites.forEach((f) => {
    let li;
    if (f.isDir) {
      li = navDirLi(f.name, f.path);
    } else {
      li = document.createElement('li');
      li.innerHTML = `<span class="ico">${svgWrap(SVG.file, 'currentColor', 16)}</span><span class="label" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span>`;
      li.onclick = () => navigate(dirOf(f.path)).then(() => { const e = state.entries.find((x) => x.path === f.path); if (e) { state.selected = f.path; openPreview(e); renderFiles(); } });
      makeDraggablePath(li, f.path);
    }
    const un = document.createElement('span');
    un.className = 'unfav';
    un.title = '移除';
    un.textContent = '✕';
    un.onclick = (ev) => { ev.stopPropagation(); toggleFav(f); };
    li.appendChild(un);
    ul.appendChild(li);
  });
  renderRootsActive(); // 重渲后补一次高亮，让「当前所在的收藏」保持选中态
}
// Agent 项目：最近被 Claude Code / Codex 处理过的项目文件夹，从两者的本机会话日志扫出来
function agoShort(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return '刚刚';
  if (m < 60) return m + ' 分';
  if (m < 1440) return Math.round(m / 60) + ' 时';
  return Math.round(m / 1440) + ' 天';
}
async function loadAgentProjects() {
  let data;
  try { data = await api('/api/agent-projects'); } catch { return; }
  const list = (data.projects || []).slice(0, 8);
  // 数据没变就不动 DOM，免得定时刷新把用户展开的子树抹掉
  const sig = JSON.stringify(list);
  if (sig === loadAgentProjects._sig) return;
  loadAgentProjects._sig = sig;
  const ul = $('#agent-projects-list');
  ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = '<div class="nav-empty">用 Claude Code / Codex / pi / Hermes 跑过的项目会出现在这里</div>'; return; }
  list.forEach((pj) => {
    const li = navDirLi(pj.name, pj.path);
    li.querySelector('.label').title = `${pj.path}\n${pj.agents.join(' + ')} · ${agoShort(pj.lastActive)}前活跃`;
    const when = document.createElement('span');
    when.className = 'when';
    pj.agents.forEach((a) => {
      const dot = document.createElement('i');
      dot.className = 'agent-dot ' + a;
      dot.title = a;
      when.appendChild(dot);
    });
    when.append(agoShort(pj.lastActive));
    li.appendChild(when);
    ul.appendChild(li);
  });
  renderRootsActive(); // 重渲后补一次高亮，让「当前所在的 agent 项目」保持选中态
}

// ---------- 最近修改 ----------
// 结果写进统一数据源 state.entries，交给 renderFiles 渲染——这样筛选 / 排序 / 隐藏开关
// 都能直接作用在最近列表上，不会把视图无声切回上一个目录
async function showRecent() {
  if (follow.on) setFileFollow(false, '手动接管，文件跟随已停');
  state.recentMode = true;
  state.cursor = -1;
  $('#file-area').innerHTML = '<div class="cmdk-loading">扫描最近修改的文件…</div>';
  renderBreadcrumb();
  const data = await api('/api/recent?root=' + encodeURIComponent(state.cwd || state.home));
  state.entries = (data.results || []).map((e) => ({ ...e, hidden: false }));
  state.recentTruncated = !!data.truncated;
  renderFiles();
}
function truncNote() {
  return `<div class="trunc-note">⚠ 文件太多，结果可能不完整。进入更具体的子目录可看到全部。</div>`;
}

// ---------- 命令面板 ----------
const cmdk = {
  results: [], active: 0, timer: null, scopeAll: true,
  open() {
    $('#cmdk').classList.remove('hidden');
    this.updateScopeLabel();
    const inp = $('#cmdk-input');
    inp.value = '';
    inp.focus();
    $('#cmdk-results').innerHTML = '<div class="cmdk-loading">输入开始搜索 · 文件名模糊匹配，「内容:」搜全文（含 PDF、截图里的文字）</div>';
    this.results = [];
    this.active = 0;
  },
  close() { $('#cmdk').classList.add('hidden'); },
  toggleScope() { this.scopeAll = !this.scopeAll; this.updateScopeLabel(); this.search($('#cmdk-input').value); },
  root() { return this.scopeAll ? state.home : (state.cwd || state.home); },
  updateScopeLabel() {
    $('#cmdk-scope').textContent = this.scopeAll ? '全机（主目录及以下）' : '当前目录 ' + tilde(state.cwd || state.home);
    $('#scope-toggle').textContent = this.scopeAll ? '⤢ 全机' : '▢ 当前目录';
    $('#scope-toggle').classList.toggle('on', this.scopeAll);
  },
  search(q) {
    clearTimeout(this.timer);
    if (!q.trim()) { $('#cmdk-results').innerHTML = '<div class="cmdk-loading">输入开始搜索</div>'; return; }
    const isContent = /^(内容[:：]|content:)/i.test(q);
    $('#cmdk-results').innerHTML = '<div class="cmdk-loading">搜索中…</div>';
    this.timer = setTimeout(async () => {
      const root = this.root();
      let data, term;
      if (isContent) {
        term = q.replace(/^(内容[:：]|content:)/i, '').trim();
        data = await api(`/api/content?q=${encodeURIComponent(term)}&root=${encodeURIComponent(root)}`);
        this.results = data.results.map((r) => ({ ...r, content: true }));
      } else {
        term = q.trim();
        data = await api(`/api/search?q=${encodeURIComponent(term)}&root=${encodeURIComponent(root)}`);
        this.results = data.results;
      }
      this.truncated = data.truncated;
      this.isContent = isContent;
      this.term = term;
      this.active = 0;
      this.renderResults();
    }, 150);
  },
  renderResults() {
    const ul = $('#cmdk-results');
    if (!this.results.length) { ul.innerHTML = '<div class="cmdk-loading">没有结果</div>'; return; }
    ul.innerHTML = '';
    this.results.forEach((r, i) => {
      const li = document.createElement('li');
      if (i === this.active) li.className = 'active';
      let hits = '';
      if (r.content && r.hits) hits = r.hits.map((h) => `<div class="r-hit">L${h.line}: ${hlTerm(h.text, this.term)}</div>`).join('');
      li.innerHTML = `<span class="r-icon">${iconSvg(r, 18)}</span>
        <div class="r-main">
          <div class="r-name">${this.isContent ? escapeHtml(r.name) : hlFuzzy(r.name, this.term)}</div>
          <div class="r-path">${escapeHtml(tilde(r.path))}</div>${hits}
        </div>`;
      li.onclick = () => this.choose(i, false);
      ul.appendChild(li);
    });
    if (this.truncated) ul.insertAdjacentHTML('beforeend', `<div class="cmdk-loading">⚠ 结果可能不完整，换更具体的关键词或缩小到当前目录</div>`);
    this.scrollActive();
  },
  move(d) { if (!this.results.length) return; this.active = (this.active + d + this.results.length) % this.results.length; this.renderResults(); },
  scrollActive() { const el = $('#cmdk-results').children[this.active]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); },
  choose(i, editor) {
    const r = this.results[i];
    if (!r) return;
    this.close();
    // ⌘↵ 对文件夹也走编辑器——找到项目名直接在 VS Code/编辑器整包打开（vibe coding 核心流）
    if (editor) { openWith(r.path, 'editor'); return; }
    if (r.isDir) { navigate(r.path); return; }
    recordRecent(r.path);
    navigate(dirOf(r.path)).then(() => {
      const entry = state.entries.find((e) => e.path === r.path) || { ...r };
      state.selected = r.path;
      openPreview(entry);
      renderFiles();
    });
  },
};
function hlFuzzy(name, q) {
  if (!q) return escapeHtml(name);
  const lower = name.toLowerCase(); const ql = q.toLowerCase();
  let qi = 0, out = '';
  for (let i = 0; i < name.length; i++) {
    if (qi < ql.length && lower[i] === ql[qi]) { out += `<mark>${escapeHtml(name[i])}</mark>`; qi++; }
    else out += escapeHtml(name[i]);
  }
  return out;
}
function hlTerm(text, term) {
  if (!term) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + term.length)) + '</mark>' + escapeHtml(text.slice(idx + term.length));
}

// ---------- 首次引导 ----------
function maybeShowGuide() {
  if (localStorage.getItem('fb_guided')) return;
  const ov = document.createElement('div');
  ov.className = 'guide-overlay';
  ov.innerHTML = `<div class="guide-card">
    <div class="guide-logo">${svgWrap(SVG.box, 'currentColor', 46, true)}</div>
    <h2>欢迎用 FanBox</h2>
    <p>vibe coding 的驾驶舱——找文件、跑 agent、看它改、随手改，都在一个窗口：</p>
    <ul>
      <li><b>⌘K</b> 全局搜文件和文件夹；<b>⌘↵</b> 把项目直接在编辑器整包打开；<code>内容:关键词</code> 搜文件里的字</li>
      <li>顶部 <b>终端</b> 按钮开内嵌终端跑 Claude Code 等 agent；<b>把文件/文件夹拖进终端</b> 即插入路径喂给它当上下文</li>
      <li><b>单击</b> 预览，<b>双击</b> 系统打开；预览里 <b>编辑</b> md 走所见即所得、<b>编辑图片</b> 可标注/打码/转格式</li>
      <li>agent 改了哪些文件，列表实时高亮「改·N」，不用切窗口盯着看</li>
    </ul>
    <button id="guide-ok">开始使用</button>
  </div>`;
  document.body.appendChild(ov);
  $('#guide-ok').onclick = () => { localStorage.setItem('fb_guided', '1'); ov.remove(); };
}

// ---------- 预览面板拖拽调宽 ----------
function bindResizer() {
  const handle = $('#preview-resizer');
  let dragging = false;
  handle.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); handle.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const fm = $('#filemgmt').getBoundingClientRect();
    if (term.dock === 'right') { // 预览在文件区下方 → 纵向拖
      state.previewH = Math.round(Math.min(fm.height - 120, Math.max(140, fm.bottom - e.clientY)));
    } else { // 预览在文件区右侧 → 横向拖
      state.previewW = Math.round(Math.min(fm.width - 220, Math.max(260, fm.right - e.clientX)));
    }
    applyPreviewSize();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging'); document.body.style.userSelect = '';
    localStorage.setItem('fb_preview_w', state.previewW);
    localStorage.setItem('fb_preview_h', state.previewH || 340);
  });
}

// 终端面板拖拽调整大小（底部拖高度 / 右侧拖宽度）
// 丝滑要点：mousemove 只记目标值，用 rAF 每帧最多应用一次（含一次 fit），不再每个事件都 fit 触发重排
function bindTerminalResizer() {
  const handle = $('#terminal-resizer');
  let dragging = false, raf = null, target = null, squeeze = false;
  const SNAP = 48; // 拖到离边缘 48px 内 → 吸附成全铺（fm-squeezed），不再留丑陋的残条
  const fitNow = () => { const s = term.sessions.find((x) => x.id === term.active); if (s && s.fit) { try { s.fit.fit(); } catch { /* */ } } };
  const apply = () => {
    raf = null;
    if (target == null) return;
    const panel = $('#terminal-panel');
    $('#main-body').classList.toggle('fm-squeezed', squeeze);
    if (term.dock === 'bottom') panel.style.height = target + 'px';
    else panel.style.width = target + 'px';
    target = null;
    fitNow();
  };
  handle.addEventListener('mousedown', (e) => {
    dragging = true; e.preventDefault();
    // 铺满态下抓分割条 = 想拖回分屏，直接退出铺满（不走 toggleMax，拖拽中不要过渡动画）
    if (term.maximized) {
      term.maximized = false;
      $('#main-body').classList.remove('term-max');
      const b = $('#term-max'); if (b) { b.classList.remove('on'); b.title = '终端铺满'; }
    }
    squeeze = $('#main-body').classList.contains('fm-squeezed');
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = term.dock === 'bottom' ? 'row-resize' : 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = $('#main-body').getBoundingClientRect();
    if (term.dock === 'bottom') {
      const raw = rect.bottom - e.clientY;
      squeeze = raw >= rect.height - SNAP;
      target = Math.round(Math.min(rect.height - 4, Math.max(60, raw)));
    } else {
      const raw = rect.right - e.clientX;
      squeeze = raw >= rect.width - SNAP;
      target = Math.round(Math.min(rect.width - 4, Math.max(140, raw)));
    }
    if (!raf) raf = requestAnimationFrame(apply);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    document.body.style.userSelect = ''; document.body.style.cursor = '';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    apply(); fitNow();
    const panel = $('#terminal-panel');
    localStorage.setItem('fb_term_squeeze', squeeze ? '1' : '0');
    if (term.dock === 'bottom') localStorage.setItem('fb_term_h', parseInt(panel.style.height, 10) || 280);
    else localStorage.setItem('fb_term_w', parseInt(panel.style.width, 10) || 480);
  });
}

// ---------- 微信 ClawBot：终端内的 IM 界面（设计方向 A）。桌面输入直连本机 claude/codex，可选连手机微信遥控 ----------
const wechatView = {
  offMsg: null, offQr: null, offConn: null, offExpired: null, onKey: null, onDoc: null,
  target: 'codex', targets: [], connected: false, cwdName: '', menuOpen: false,
  connState: 'unknown',
  el() { return $('#wechat-view'); },
  shown() { const e = this.el(); return e && !e.classList.contains('hidden'); },
  toggle() { this.shown() ? this.close() : this.open(); },
  async open() {
    if (!window.fanboxWechat) { toast('微信连接需在 FanBox 桌面版使用', true); return; }
    if (!term.available()) { toast('需要桌面版的内嵌终端', true); return; }
    if ($('#terminal-panel').classList.contains('hidden')) term.open(); // 这界面活在终端里
    try { window.fanboxWechat.setCwd(state.cwd); } catch { /* */ }
    this.renderShell();
    this.el().classList.remove('hidden');
    this.onKey = (ev) => {
      if (ev.key !== 'Escape' || !this.shown()) return;
      if (this.menuOpen) { ev.preventDefault(); this.closeMenu(); return; }
      const scan = this.el().querySelector('#wx-scan');
      if (scan && !scan.classList.contains('hidden')) { ev.preventDefault(); this.teardownScan(); scan.classList.add('hidden'); return; }
      ev.preventDefault(); this.close();
    };
    document.addEventListener('keydown', this.onKey, true);
    this.offMsg = window.fanboxWechat.onMessage(() => this.loadChat());
    // 连接失效（轮询/探活发现 token 掉了）→ 立刻翻红 + 弹重连横幅，不让用户对着死连接干瞪眼
    this.offExpired = window.fanboxWechat.onExpired ? window.fanboxWechat.onExpired(() => this.setConn('expired')) : null;
    await this.detect();
  },
  close() {
    this.teardown();
    if (this.onKey) { document.removeEventListener('keydown', this.onKey, true); this.onKey = null; }
    if (this.onDoc) { document.removeEventListener('click', this.onDoc, true); this.onDoc = null; }
    const e = this.el(); if (e) { e.classList.add('hidden'); e.innerHTML = ''; }
  },
  teardown() {
    if (this.offMsg) { this.offMsg(); this.offMsg = null; }
    if (this.offExpired) { this.offExpired(); this.offExpired = null; }
    this.teardownScan();
    this.menuOpen = false;
  },
  teardownScan() {
    if (this.offQr) { this.offQr(); this.offQr = null; }
    if (this.offConn) { this.offConn(); this.offConn = null; }
    try { window.fanboxWechat && window.fanboxWechat.cancel(); } catch { /* */ }
  },
  renderShell() {
    const e = this.el();
    e.innerHTML = `<div class="wx-bar">
        <span class="wx-dot off" id="wx-dot"></span>
        <span class="wx-name">微信 ClawBot</span>
        <span class="wx-status" id="wx-status"></span>
        <span class="wx-spacer"></span>
        <span class="wx-brain" id="wx-brain">连到 Codex <span class="caret">▾</span></span>
        <button class="wx-x" id="wx-close" title="收起（回到终端）">✕</button>
        <div class="wx-menu hidden" id="wx-menu"></div>
      </div>
      <div class="wx-body">
        <div class="wx-reconnect hidden" id="wx-reconnect">
          <span class="wx-reconnect-msg" id="wx-reconnect-msg"></span>
          <span class="wx-spacer"></span>
          <button class="wx-reconnect-btn" id="wx-reconnect-btn">重新连接</button>
        </div>
        <div class="wx-ctx" id="wx-ctx">
          <div class="wx-meter" id="wx-meter" title="当前对话上下文用量：越满越贵越慢，满了会自动整理"><span class="wx-meter-fill" id="wx-meter-fill"></span></div>
          <span class="wx-meter-txt" id="wx-meter-txt"></span>
          <span class="wx-spacer"></span>
          <button class="wx-ctx-btn" id="wx-compact" title="整理对话：把要点存进记忆，换个轻量上下文接着聊">整理</button>
          <button class="wx-ctx-btn" id="wx-new" title="新对话：归档当前，开个全新的（靠长期记忆续）">新对话</button>
        </div>
        <div class="wx-chat" id="wx-chat"></div>
        <div class="wx-scan hidden" id="wx-scan"></div>
        <div class="wx-viewonly">仅查看手机微信与本机大脑的对话记录，回复请在手机微信进行</div>
      </div>`;
    e.querySelector('#wx-close').onclick = () => this.close();
    e.querySelector('#wx-brain').onclick = (ev) => { ev.stopPropagation(); this.toggleMenu(); };
    e.querySelector('#wx-compact').onclick = (ev) => this.runCtxAction(ev.currentTarget, '整理中…', () => window.fanboxWechat.compact(), '已整理上下文');
    e.querySelector('#wx-new').onclick = (ev) => this.runCtxAction(ev.currentTarget, '处理中…', () => window.fanboxWechat.newConversation(), '已开启新对话');
    e.querySelector('#wx-reconnect-btn').onclick = () => this.connectPhone();
    this.onDoc = (ev) => { if (this.menuOpen && !ev.target.closest('#wx-menu') && !ev.target.closest('#wx-brain')) this.closeMenu(); };
    document.addEventListener('click', this.onDoc, true);
  },
  async detect() {
    this.setConn('checking'); // 打开就给「检测中」即时反馈，别让用户盯着一个不知真假的绿点
    const env = await window.fanboxWechat.env().catch(() => ({}));
    this.targets = (env.targets && env.targets.length) ? env.targets : [{ id: 'codex', label: 'Codex', available: true }, { id: 'claude', label: 'Claude Code', available: true }];
    if (env.target) this.target = env.target;
    this.cwdName = env.cwdName || '';
    this.persona = env.persona || '';
    this.personaDefault = env.personaDefault || '';
    this.syncBar();
    await this.loadChat();
    // 主动探活，拿到权威状态（connected / expired / unreachable / disconnected）
    const r = window.fanboxWechat.check ? await window.fanboxWechat.check().catch(() => ({})) : {};
    this.setConn(r.state || (env.connected ? 'connected' : 'disconnected'));
  },
  label(id) { const t = this.targets.find((x) => x.id === id); return t ? t.label : (id === 'claude' ? 'Claude Code' : 'Codex'); },
  // 连接状态机：连接监测的唯一出口，统一刷点/状态文案/重连横幅/顶栏绿点
  setConn(state) { this.connState = state; this.connected = (state === 'connected'); this.applyConn(); },
  applyConn() {
    const e = this.el(); if (!e) return;
    const map = {
      checking: { cls: 'checking', text: '检测连接中…' },
      connected: { cls: '', text: '已连接' },
      expired: { cls: 'bad', text: '连接已失效' },
      unreachable: { cls: 'bad', text: '连接异常' },
      disconnected: { cls: 'off', text: '未连接' },
      unknown: { cls: 'off', text: '' },
    };
    const m = map[this.connState] || map.unknown;
    const dot = e.querySelector('#wx-dot'); if (dot) dot.className = ('wx-dot ' + m.cls).trim();
    const status = e.querySelector('#wx-status'); if (status) status.textContent = m.text;
    // 失效 / 未连 → 醒目重连横幅（直接弹二维码）；检测中 / 已连 / 临时异常不打扰
    const rc = e.querySelector('#wx-reconnect');
    if (rc) {
      const show = this.connState === 'expired' || this.connState === 'disconnected';
      rc.classList.toggle('hidden', !show);
      if (show) {
        const msg = rc.querySelector('#wx-reconnect-msg'); const btn = rc.querySelector('#wx-reconnect-btn');
        if (msg) msg.textContent = this.connState === 'expired' ? '微信连接已失效，需要重新扫码' : '还没连接手机微信';
        if (btn) btn.textContent = this.connState === 'expired' ? '重新连接' : '连接手机微信';
      }
    }
    this.syncDot(this.connState === 'connected');
  },
  syncBar() {
    const e = this.el(); if (!e) return;
    const brain = e.querySelector('#wx-brain'); if (brain) brain.innerHTML = `连到 ${escapeHtml(this.label(this.target))} <span class="caret">${this.menuOpen ? '▴' : '▾'}</span>`;
    this.applyConn();
  },
  toggleMenu() { this.menuOpen ? this.closeMenu() : this.openMenu(); },
  openMenu() {
    this.menuOpen = true;
    const e = this.el(); const menu = e.querySelector('#wx-menu');
    const item = (id) => {
      const t = this.targets.find((x) => x.id === id) || { available: true };
      const cur = id === this.target;
      return `<div class="wx-mi ${cur ? 'cur' : ''}" data-pick="${id}"${t.available ? '' : ' disabled'}>${escapeHtml(this.label(id))}${cur ? '<span class="ck">✓</span>' : ''}</div>`;
    };
    menu.innerHTML = item('claude') + item('codex') + `<div class="wx-sep"></div>` +
      `<div class="wx-mi" data-act="persona">自定义人格…</div>` +
      (this.connected ? `<div class="wx-mi danger" data-act="disc">断开手机微信</div>` : `<div class="wx-mi" data-act="conn">连接手机微信…</div>`);
    menu.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => this.pickTarget(b.dataset.pick); });
    const conn = menu.querySelector('[data-act=conn]'); if (conn) conn.onclick = () => { this.closeMenu(); this.connectPhone(); };
    const disc = menu.querySelector('[data-act=disc]'); if (disc) disc.onclick = () => { this.closeMenu(); this.disconnectPhone(); };
    const pers = menu.querySelector('[data-act=persona]'); if (pers) pers.onclick = () => { this.closeMenu(); this.editPersona(); };
    menu.classList.remove('hidden');
    e.querySelector('#wx-brain').classList.add('open');
    this.syncBar();
  },
  closeMenu() {
    this.menuOpen = false; const e = this.el(); if (!e) return;
    const m = e.querySelector('#wx-menu'); if (m) m.classList.add('hidden');
    const b = e.querySelector('#wx-brain'); if (b) b.classList.remove('open');
    this.syncBar();
  },
  async pickTarget(id) {
    const t = this.targets.find((x) => x.id === id);
    if (t && !t.available) { toast(`本机未检测到 ${this.label(id)}`, true); return; }
    this.target = id; this.closeMenu();
    await window.fanboxWechat.setTarget(id).catch(() => {});
    this.syncBar(); this.loadChat();
  },
  async loadChat() {
    const e = this.el(); const chat = e && e.querySelector('#wx-chat'); if (!chat) return;
    const r = await window.fanboxWechat.conversation().catch(() => ({ messages: [] }));
    const msgs = r.messages || [];
    this.updateMeter(r.tokens, r.budget);
    if (!msgs.length) {
      chat.innerHTML = `<div class="wx-empty">还没有对话。<br>点右上「连到 ${escapeHtml(this.label(this.target))} ▾ → 连接手机微信」，<br>用手机微信遥控本机的 <b>${escapeHtml(this.label(this.target))}</b>，对话记录会显示在这里。</div>`;
      return;
    }
    chat.innerHTML = msgs.map((m) => this.bubble(m)).join('');
    chat.scrollTop = chat.scrollHeight;
  },
  // 上下文用量进度条：满了越贵越慢，≥80% 转红提醒（会自动整理）
  updateMeter(tokens, budget) {
    const e = this.el(); if (!e) return;
    tokens = tokens || 0; budget = budget || 120000;
    const pct = Math.min(100, Math.round((tokens / budget) * 100));
    const fill = e.querySelector('#wx-meter-fill'); const txt = e.querySelector('#wx-meter-txt');
    if (fill) { fill.style.width = pct + '%'; fill.classList.toggle('hot', pct >= 80); }
    if (txt) txt.textContent = tokens ? `${Math.round(tokens / 1000)}k / ${Math.round(budget / 1000)}k` : '';
  },
  // 整理/新对话共用：禁用按钮 + 改文案跑（flush 要一次模型调用，几秒），完事 toast + 刷新
  async runCtxAction(btn, busyText, fn, okText) {
    if (btn.disabled) return;
    const old = btn.textContent; btn.disabled = true; btn.textContent = busyText;
    try { await fn(); toast(okText); } catch { toast('操作失败', true); }
    btn.disabled = false; btn.textContent = old; this.loadChat();
  },
  bubble(m) {
    if (m.role === 'system') return `<div class="wx-sys">${escapeHtml(m.text)}</div>`; // 分隔线/系统提示居中
    const me = m.role === 'user';
    const av = me ? '花' : (this.target === 'claude' ? 'C' : 'CX');
    // bot 回复渲染 markdown（手机大脑常回 **加粗**/列表/`代码`）；user 保持纯文本转义
    const text = me ? escapeHtml(m.text) : this.mdBody(m.text);
    // 用户发来的图片：用 /api/raw 直接读本机收件箱里的原图，点击走全局 lightbox 放大
    const imgs = (m.images || []).map((p) =>
      `<img class="wx-img" src="/api/raw?path=${encodeURIComponent(p)}" loading="lazy" alt="图片" onclick="lightbox(this.dataset.path)" data-path="${escapeHtml(p)}">`
    ).join('');
    const body = imgs ? imgs + (m.text ? `<div class="wx-cap">${text}</div>` : '') : text;
    return `<div class="wx-row ${me ? 'me' : 'bot'}"><div class="wx-av ${me ? 'me' : 'bot'}">${av}</div><div class="wx-bub${me ? '' : ' md'}">${body}</div></div>`;
  },
  mdBody(text) {
    try { if (window.marked && !window.__noMarked) return window.marked.parse(String(text || ''), { breaks: true, gfm: true }); } catch { /* 退回纯文本 */ }
    return escapeHtml(text).replace(/\n/g, '<br>');
  },
  connectPhone() {
    const e = this.el(); const scan = e.querySelector('#wx-scan');
    scan.innerHTML = `<div class="wx-qr" id="wx-qr"><div class="wx-loading">生成二维码…</div></div>
      <div class="wx-scan-lead">用手机微信扫一扫</div>
      <div class="wx-scan-sub">连上后，微信就能遥控本机的 ${escapeHtml(this.label(this.target))} —— 看代码、跑测试、改 bug，回手机上一句话就行。</div>
      <div class="wx-scan-close" id="wx-scan-close">取消</div>`;
    scan.classList.remove('hidden');
    e.querySelector('#wx-scan-close').onclick = () => { this.teardownScan(); scan.classList.add('hidden'); };
    this.offQr = window.fanboxWechat.onQr((m) => {
      const qr = this.el() && this.el().querySelector('#wx-qr'); if (!qr) return;
      if (m.expired) { qr.innerHTML = `<div class="wx-loading">二维码过期，请重试</div>`; return; }
      qr.innerHTML = m.dataUrl ? `<img src="${m.dataUrl}" alt="二维码">` : `<div class="wx-loading">${escapeHtml(m.content || '二维码生成失败')}</div>`;
    });
    this.offConn = window.fanboxWechat.onConnected(async () => { this.teardownScan(); scan.classList.add('hidden'); this.setConn('connected'); await this.detect(); toast('微信已连接'); });
    window.fanboxWechat.login().then((r) => { if (r && !r.ok) { const qr = this.el() && this.el().querySelector('#wx-qr'); if (qr) qr.innerHTML = `<div class="wx-loading">${escapeHtml(r.error || '登录失败')}</div>`; } });
  },
  // 自定义微信 bot 人格：复用 scan 覆盖层做一个编辑面板
  editPersona() {
    const e = this.el(); const scan = e.querySelector('#wx-scan');
    scan.innerHTML = `<div class="wx-persona">
        <div class="wx-persona-title">微信 bot 人格</div>
        <div class="wx-persona-sub">这段会作为行为指令注入。手机上回复啰嗦时，让它更简洁。</div>
        <textarea class="wx-persona-ta" id="wx-persona-ta" rows="6" placeholder="例如：用中文、简洁、适合手机看…">${escapeHtml(this.persona || '')}</textarea>
        <div class="wx-persona-btns">
          <span class="wx-scan-close" id="wx-persona-reset">恢复默认</span>
          <span class="wx-spacer"></span>
          <span class="wx-scan-close" id="wx-persona-cancel">取消</span>
          <button class="wx-send" id="wx-persona-save">保存</button>
        </div>
      </div>`;
    scan.classList.remove('hidden');
    const ta = scan.querySelector('#wx-persona-ta');
    scan.querySelector('#wx-persona-reset').onclick = () => { ta.value = this.personaDefault || ''; };
    scan.querySelector('#wx-persona-cancel').onclick = () => { scan.classList.add('hidden'); };
    scan.querySelector('#wx-persona-save').onclick = async () => {
      const r = await window.fanboxWechat.setPersona(ta.value).catch(() => ({}));
      this.persona = (r && r.persona) || ta.value;
      scan.classList.add('hidden'); toast('人格已更新');
    };
  },
  async disconnectPhone() { await window.fanboxWechat.disconnect().catch(() => {}); this.setConn('disconnected'); toast('已断开手机微信'); },
  syncDot(on) { const d = $('#wechat-dot'); if (d) d.classList.toggle('hidden', !on); const btn = $('#term-wechat'); if (btn) btn.classList.toggle('on', on); },
};

// ---------- coding agent 启动按钮（#38：内置注册表 + 设置面板开关 + config 自定义） ----------
// 三层：① AGENT_REGISTRY 内置 11 个主流 agent（图标在 /assets/agents/）
//      ② 设置面板（⚙ 滑杆按钮）勾选启用哪些，存 config.json 的 enabledAgents，默认 claude + codex
//      ③ config.json 的 agents 数组做高级自定义：同 id 覆盖内置命令，新 id 追加按钮
// app: true 的是桌面应用（无终端 CLI 形态，官方确认），按钮改为 open -a 拉起，检测走 open -Ra
// sessions: 有会话适配器的 agent 声明续接方式——badge 是项目记忆面板的徽标，resumeCmd 里 {id} 占位符替换成会话 id；
//           没有 sessions 字段 = 该 agent 暂不支持会话回溯（服务端也没有对应适配器）
const AGENT_REGISTRY = [
  { id: 'claude', label: 'Claude Code', cmd: 'claude --dangerously-skip-permissions', bin: 'claude', install: 'npm install -g @anthropic-ai/claude-code', sessions: { badge: 'C', resumeCmd: 'claude --dangerously-skip-permissions --resume {id}' } },
  { id: 'codex', label: 'Codex', cmd: 'codex', bin: 'codex', install: 'npm install -g @openai/codex', sessions: { badge: '>_', resumeCmd: 'codex resume {id}' } },
  { id: 'hermes', label: 'Hermes Agent', cmd: 'hermes', bin: 'hermes', install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash' },
  { id: 'openclaw', label: 'OpenClaw', cmd: 'openclaw', bin: 'openclaw', install: 'npm install -g openclaw' },
  { id: 'kimi', label: 'Kimi Code', cmd: 'kimi', bin: 'kimi', install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', sessions: { badge: 'K', resumeCmd: 'kimi -S {id}' } },
  { id: 'zcode', label: 'ZCode', cmd: 'open -a ZCode', app: 'ZCode', install: 'https://zcode.z.ai （桌面应用，官网下载 dmg）' },
  { id: 'opencode', label: 'opencode', cmd: 'opencode', bin: 'opencode', install: 'curl -fsSL https://opencode.ai/install | bash', sessions: { badge: 'oc', resumeCmd: 'opencode -s {id}' } },
  { id: 'pi', label: 'pi', cmd: 'pi', bin: 'pi', install: 'curl -fsSL https://pi.dev/install.sh | sh' },
  { id: 'codebuddy', label: 'CodeBuddy', cmd: 'codebuddy', bin: 'codebuddy', install: 'npm install -g @tencent-ai/codebuddy-code' },
  { id: 'workbuddy', label: 'WorkBuddy', cmd: 'open -a WorkBuddy', app: 'WorkBuddy', install: 'https://codebuddy.cn/work （桌面应用，官网下载）' },
  { id: 'qoder', label: 'Qoder CLI', cmd: 'qodercli', bin: 'qodercli', install: 'curl -fsSL https://qoder.com/install | bash' },
];
const AGENT_DEFAULTS = ['claude', 'codex'];
const agentState = { enabled: null, custom: [] };
const agentIconCache = new Map();

async function agentIconHtml(id) {
  const key = String(id).replace(/[^\w-]/g, '');
  if (agentIconCache.has(key)) return agentIconCache.get(key);
  let html = '';
  try {
    const r = await fetch(`/assets/agents/${key}.svg`);
    if (r.ok) { const t = (await r.text()).trim(); if (t.startsWith('<svg') || t.startsWith('<?xml')) html = t; }
  } catch { /* 没图标走缩写兜底 */ }
  if (!html) {
    try {
      const r = await fetch(`/assets/agents/${key}.png`, { method: 'HEAD' });
      if (r.ok) html = `<img src="/assets/agents/${key}.png" alt="">`;
    } catch { /* 同上 */ }
  }
  agentIconCache.set(key, html);
  return html;
}

async function loadAgents() {
  try {
    const r = await api('/api/agents');
    agentState.enabled = Array.isArray(r.enabled) && r.enabled.length ? r.enabled : null;
    agentState.custom = Array.isArray(r.custom) ? r.custom : [];
  } catch { agentState.enabled = null; agentState.custom = []; }
}

// 生效的按钮清单：面板勾选管显隐；custom 同 id 只覆盖 label/cmd，不影响显隐；custom 新 id 恒显示追加在后
function activeAgents() {
  const on = new Set(agentState.enabled || AGENT_DEFAULTS);
  const byId = new Map(agentState.custom.filter((a) => a && a.id && typeof a.cmd === 'string' && a.cmd).map((a) => [String(a.id), a]));
  const list = [];
  for (const a of AGENT_REGISTRY) {
    const ov = byId.get(a.id); byId.delete(a.id);
    if (!on.has(a.id)) continue;
    list.push(ov ? { ...a, label: ov.label || a.label, cmd: ov.cmd } : a);
  }
  for (const [id, a] of byId) list.push({ id, label: a.label || id, cmd: a.cmd });
  return list;
}

async function renderAgentButtons() {
  const anchor = $('#agent-config');
  anchor.parentElement.querySelectorAll('button[data-agent]').forEach((b) => b.remove());
  for (const a of activeAgents()) {
    const b = document.createElement('button');
    b.className = 'agent-launch';
    b.dataset.agent = a.id;
    b.id = 'term-' + String(a.id).replace(/[^\w-]/g, '');
    b.title = a.app ? `打开 ${a.label} 桌面应用（该产品无终端 CLI 形态）` : `启动 ${a.label}：空闲终端就地启动，正跑着任务则新开标签`;
    b.innerHTML = (await agentIconHtml(a.id)) || `<span class="agent-abbr">${escapeHtml(String(a.label || a.id).slice(0, 2))}</span>`;
    b.onclick = () => { wechatView.close(); term.launchAgent(a.cmd); };
    anchor.parentElement.insertBefore(b, anchor);
  }
}

// 设置面板：勾选即生效；未安装的显示「未装」，点它复制安装命令
const agentsPop = {
  el: null, which: null,
  toggle() { if (this.el) this.close(); else this.open(); },
  close() { if (!this.el) return; this.el.remove(); this.el = null; document.removeEventListener('mousedown', this._out, true); },
  open() {
    const on = new Set(agentState.enabled || AGENT_DEFAULTS);
    const pop = document.createElement('div');
    pop.className = 'agents-pop';
    pop.innerHTML = `<div class="ap-head">一键启动的 coding agent</div>
      <div class="ap-list">${AGENT_REGISTRY.map((a) => `
        <label class="ap-row" data-id="${a.id}">
          <input type="checkbox" ${on.has(a.id) ? 'checked' : ''}>
          <span class="ap-ic" data-ic="${a.id}"></span>
          <span class="ap-name">${escapeHtml(a.label)}</span>
          <span class="ap-flag" data-flag="${a.id}"></span>
        </label>`).join('')}</div>
      <div class="ap-head ap-sub">终端渲染</div>
      <label class="ap-row" data-webgl title="长时间中文输出偶发乱码时可关掉：改用兼容渲染（DOM），立即生效，稍慢但稳">
        <input type="checkbox" ${(() => { try { return localStorage.getItem('fanbox.noWebgl') === '1' ? '' : 'checked'; } catch { return 'checked'; } })()}>
        <span class="ap-name">WebGL 加速渲染</span>
      </label>
      <div class="ap-head ap-sub">Agent 互控</div>
      <div class="ap-row" title="装进 ~/.claude/skills 后，翻箱终端里的 claude 就能指挥兄弟窗口：新开窗口 / 读输出 / 发指令 / 等结果">
        <span class="ap-name">fanbox-agent skill</span>
        <span class="ap-flag" data-skill-flag="fanbox-agent"></span>
      </div>
      <div class="ap-foot">勾选即生效 · 点「未装」复制安装命令<br>高级：~/.fanbox/config.json 的 agents 数组可自定义命令 / 加新 agent</div>`;
    document.body.appendChild(pop);
    const r = $('#agent-config').getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    pop.style.right = Math.max(8, Math.round(window.innerWidth - r.right - 8)) + 'px';
    this.el = pop;
    AGENT_REGISTRY.forEach(async (a) => { const el = pop.querySelector(`[data-ic="${a.id}"]`); const ic = await agentIconHtml(a.id); if (el) el.innerHTML = ic || `<span class="agent-abbr">${escapeHtml(a.label.slice(0, 2))}</span>`; });
    this.markInstalled(pop);
    this.markSkill(pop);
    const wgCb = pop.querySelector('[data-webgl] input');
    if (wgCb) wgCb.onchange = () => { term.setWebgl(wgCb.checked); toast(wgCb.checked ? 'WebGL 渲染已开启' : '已切换兼容渲染（修中文乱码）'); };
    pop.querySelectorAll('.ap-list .ap-row input').forEach((cb) => {
      cb.onchange = async () => {
        const ids = [...pop.querySelectorAll('.ap-list .ap-row input:checked')].map((x) => x.closest('.ap-row').dataset.id);
        agentState.enabled = ids.length ? ids : null;
        renderAgentButtons();
        try { await apiPost('/api/agents', { enabled: ids }); } catch { toast('保存失败', true); }
      };
    });
    this._out = (ev) => { if (!pop.contains(ev.target) && !$('#agent-config').contains(ev.target)) this.close(); };
    document.addEventListener('mousedown', this._out, true);
  },
  // 内置 skill 安装状态：未装 →「安装」可点；装过但内容旧 →「可更新」可点；最新 →「已装 ✓」
  async markSkill(pop) {
    const f = pop.querySelector('[data-skill-flag="fanbox-agent"]');
    if (!f) return;
    let st = null;
    try { st = ((await api('/api/skills/builtin')).skills || []).find((s) => s.id === 'fanbox-agent'); } catch { /* */ }
    if (!st) { f.textContent = '不可用'; return; }
    const set = (txt, click) => { f.textContent = txt; f.onclick = click || null; f.style.cursor = click ? 'pointer' : ''; };
    if (st.installed && st.upToDate) return set('已装 ✓');
    set(st.installed ? '可更新' : '安装', async (ev) => {
      ev.preventDefault();
      const r = await apiPost('/api/skills/install-builtin', { id: 'fanbox-agent' }).catch(() => null);
      if (r && r.ok) { set('已装 ✓'); toast('fanbox-agent skill 已装进 ~/.claude/skills，终端里的 claude 即刻可用'); }
      else toast('安装失败' + (r && r.error ? '：' + r.error : ''), true);
    });
  },
  async markInstalled(pop) {
    if (!this.which) {
      const bins = AGENT_REGISTRY.filter((a) => a.bin).map((a) => a.bin).join(',');
      const apps = AGENT_REGISTRY.filter((a) => a.app).map((a) => a.app).join(',');
      try { this.which = await api(`/api/agents/which?bins=${bins}&apps=${encodeURIComponent(apps)}`); } catch { this.which = {}; return; }
    }
    for (const a of AGENT_REGISTRY) {
      const f = pop.querySelector(`[data-flag="${a.id}"]`);
      if (!f || this.which[a.bin || a.app] !== false) continue;
      f.textContent = '未装';
      f.title = '点击复制安装命令：' + a.install;
      f.onclick = (ev) => { ev.preventDefault(); navigator.clipboard.writeText(a.install).then(() => toast('已复制安装命令')); };
    }
  },
};

async function bindAgentButtons() {
  $('#agent-config').onclick = () => agentsPop.toggle();
  await loadAgents();
  await renderAgentButtons();
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 顶栏窄时分级藏低频控件（观测自身宽度而非视口——侧栏会吃掉一截且可折叠）
  const tb = $('#topbar');
  new ResizeObserver((es) => {
    const w = es[0].contentRect.width;
    tb.classList.toggle('tb-sm', w < 980);
    tb.classList.toggle('tb-xs', w < 880);
    tb.classList.toggle('tb-xxs', w < 790);
    tb.classList.toggle('tb-min', w < 660);
  }).observe(tb);
  // 文件区被终端/预览压窄时，列表列让位：名称优先，先藏「大小」再藏「修改时间」（#49）
  const fa = $('#file-area');
  new ResizeObserver((es) => {
    const w = es[0].contentRect.width;
    fa.classList.toggle('fa-narrow', w < 620);
    fa.classList.toggle('fa-tight', w < 460);
  }).observe(fa);
  // ←/↑ 顶栏按钮已删（与面包屑功能重复、且和 macOS 红绿灯冲突）；后退/上一级保留 ⌘[ 和 Backspace 快捷键
  $('#preview-close').onclick = closePreview;
  $('#cmdk-trigger').onclick = () => cmdk.open();
  $('#btn-recent').onclick = showRecent;
  $('#btn-changes').onclick = () => toggleChangesPanel();
  $('#term-wechat').onclick = () => wechatView.toggle();
  // 启动时点一下连接状态，连着就给终端里的微信按钮点绿点（不挡初始化）
  if (window.fanboxWechat) window.fanboxWechat.env().then((e) => wechatView.syncDot(!!(e && e.connected))).catch(() => {});
  $('#btn-terminal').onclick = () => term.toggle();
  bindAgentButtons();
  usagePanel.bind();
  shotTray.init();
  $('#skills-entry').onclick = () => skillsView.show();
  $('#cron-entry').onclick = () => cronPanel.show();
  $('#term-newtab').onclick = () => { wechatView.close(); term.newTab(); };
  $('#term-max').onclick = () => term.toggleMax();
  // 双击终端顶栏空白处（避开标签/按钮/输入框）= 铺满终端：agent 交互窗口最重要，给它一键放到最大
  $('.term-head').addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button, .term-tab, input')) return;
    term.toggleMax();
  });
  $('#term-dock').onclick = () => term.setDock(term.dock === 'bottom' ? 'right' : 'bottom');
  $('#term-replay').onclick = () => player.open();
  const muteBtn = $('#term-mute');
  const syncMute = () => { muteBtn.textContent = state.muted ? '🔕' : '🔔'; muteBtn.title = state.muted ? '提示音已关（点击开启）' : '提示音已开（点击静音）'; };
  syncMute();
  muteBtn.onclick = () => { state.muted = !state.muted; localStorage.setItem('fb_muted', state.muted ? '1' : '0'); syncMute(); if (!state.muted) playChime('tick'); };
  $('#term-close').onclick = () => term.close();
  $('#btn-sidebar').onclick = () => toggleSidebar();
  $('#file-follow').onclick = () => setFileFollow(!follow.on);
  // 定位文件按钮已撤（双击终端 tab 即可定位，见 term.locateCwd / renderTabs 的 ondblclick）
  // 终端随窗口尺寸变化重排，避免 TUI 错位
  window.addEventListener('resize', () => term.fitActive());
  if (window.ResizeObserver) new ResizeObserver(() => term.fitActive()).observe($('#xterm-host'));
  bindTerminalResizer();
  // 拖拽文件/文件夹到终端 → 插入路径
  const tp = $('#terminal-panel');
  tp.addEventListener('dragover', (ev) => {
    const t = ev.dataTransfer.types;
    if (!t.includes('Files') && !t.includes('application/x-fanbox-path') && !t.includes('text/plain')) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; tp.classList.add('term-drop');
  });
  tp.addEventListener('dragleave', (ev) => { if (!tp.contains(ev.relatedTarget)) tp.classList.remove('term-drop'); });
  tp.addEventListener('drop', async (ev) => {
    ev.preventDefault(); tp.classList.remove('term-drop');
    // 系统拖入（Finder 文件 / 截图浮窗缩略图）：有真实路径直接用；file-promise 没路径就落盘临时目录
    const files = ev.dataTransfer.files ? [...ev.dataTransfer.files] : [];
    if (files.length && window.fanboxDrop) {
      for (const f of files) {
        let p = window.fanboxDrop.pathForFile(f);
        if (!p) {
          const r = await window.fanboxDrop.saveTemp(f.name, await f.arrayBuffer()).catch(() => null);
          if (r && r.ok) p = r.path;
        }
        if (p) term.insertPath(p);
      }
      return;
    }
    // skill 行拖进终端：注入 /name 或 $name（按会话里跑的 agent），不是当路径插
    const sk = ev.dataTransfer.getData('application/x-fanbox-skill');
    if (sk) { invokeSkillInTerm(sk); return; }
    const p = ev.dataTransfer.getData('application/x-fanbox-path') || ev.dataTransfer.getData('text/plain');
    if (p) term.insertPath(p);
  });
  // 全局兜底：文件拖到窗口其它区域松手时，阻止 Electron 导航到 file:// 顶掉整个界面
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // 文件区空白处双击/右键 → 新建菜单（#7：右键空白是更普遍的肌肉记忆）
  const blankMenu = (e) => {
    if (e.target.closest('.item') || e.target.closest('.row')) return; // 条目自身的菜单不抢
    e.preventDefault();
    popupMenu(e, [
      { label: '新建文件夹…', fn: () => doCreate('dir') },
      { label: '新建文件…', fn: () => doCreate('file') },
      { sep: true },
      { label: 'AI 整理…', fn: () => organizeLaunch(state.cwd) },
      { label: '磁盘占用透视', fn: () => diskPanel(state.cwd) },
    ]);
  };
  $('#file-area').addEventListener('dblclick', blankMenu);
  $('#file-area').addEventListener('contextmenu', blankMenu);
  // 拖入文件区 = 存进当前目录；拖到某文件夹图标上 = 存进那个文件夹（截图浮窗、Finder 文件都行）。
  // 接两类：①「外部文件」拖入（dataTransfer 里有 Files）；② app 内/外部图片拖入（带 text/uri-list 的 <img>，如微信收到的图、预览里的图）。
  // fanbox 内部路径拖拽（带 application/x-fanbox-path，拖去终端用）排除在外，不受影响。
  const fileArea = $('#file-area');
  const droppableTypes = (t) => t.includes('Files') || (t.includes('text/uri-list') && !t.includes('application/x-fanbox-path'));
  const clearDropHi = () => { fileArea.classList.remove('area-drop'); fileArea.querySelectorAll('.item.drop-into').forEach((x) => x.classList.remove('drop-into')); };
  fileArea.addEventListener('dragover', (ev) => {
    if (state.skillsMode || !droppableTypes(ev.dataTransfer.types)) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy';
    const item = ev.target.closest('.item');
    const idx = item ? Number(item.dataset.idx) : -1;
    const overDir = idx >= 0 && state.visible[idx] && state.visible[idx].isDir ? item : null;
    if (overDir) { if (!overDir.classList.contains('drop-into')) { clearDropHi(); overDir.classList.add('drop-into'); } }
    else { fileArea.querySelectorAll('.item.drop-into').forEach((x) => x.classList.remove('drop-into')); fileArea.classList.add('area-drop'); }
  });
  fileArea.addEventListener('dragleave', (ev) => { if (!fileArea.contains(ev.relatedTarget)) clearDropHi(); });
  fileArea.addEventListener('drop', async (ev) => {
    const dt = ev.dataTransfer;
    const hasFiles = dt.files && dt.files.length;
    const url = (!hasFiles && dt.types.includes('text/uri-list') && !dt.types.includes('application/x-fanbox-path')) ? dt.getData('text/uri-list') : '';
    if (state.skillsMode || (!hasFiles && !url)) return;
    ev.preventDefault(); clearDropHi();
    const item = ev.target.closest('.item');
    const idx = item ? Number(item.dataset.idx) : -1;
    const over = idx >= 0 ? state.visible[idx] : null;
    const dir = over && over.isDir ? over.path : state.cwd;
    if (hasFiles) await dropFilesInto(dt.files, dir);
    else await dropUrlInto(url, dir);
  });
  $('#content').addEventListener('contextmenu', (e) => { if (!e.target.closest('#file-area')) blankMenu(e); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#context-menu')) closeContextMenu(); });
  window.addEventListener('blur', closeContextMenu);
  $('#scope-toggle').onclick = () => cmdk.toggleScope();

  $('#toggle-hidden').checked = state.showHidden;
  $('#toggle-hidden').onchange = (e) => { state.showHidden = e.target.checked; localStorage.setItem('fb_hidden', state.showHidden ? '1' : '0'); renderFiles(); };

  $('#sort-seg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === state.sort);
    b.onclick = () => { state.sort = b.dataset.sort; localStorage.setItem('fb_sort', state.sort); $('#sort-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); renderFiles(); };
  });
  $('#view-seg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
    b.onclick = () => { state.view = b.dataset.view; localStorage.setItem('fb_view', state.view); $('#view-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); updateGridSizeVisibility(); renderFiles(); };
  });
  $('#gridsize-seg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.size === state.gridSize);
    b.onclick = () => { state.gridSize = b.dataset.size; localStorage.setItem('fb_gridsize', state.gridSize); $('#gridsize-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)); renderFiles(); };
  });
  updateGridSizeVisibility();

  $('#cmdk-input').oninput = (e) => cmdk.search(e.target.value);
  $('#cmdk').onclick = (e) => { if (e.target.id === 'cmdk') cmdk.close(); };

  // 启动必为干净态：录像弹窗永远不在 app 打开时默认显示（HTML 已带 hidden，这里再兜一道）
  try { $('#replay-overlay').classList.add('hidden'); } catch { /* */ }
  // 录像弹窗的「保命逃生口」：不管 player 内部状态坏没坏，ESC 一定先把弹窗 DOM 藏掉，绝不困住用户
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#replay-overlay').classList.contains('hidden')) {
      $('#replay-overlay').classList.add('hidden');
      try { player.close(); } catch { /* player 坏了也没关系，上面已经把弹窗藏了 */ }
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!$('#replay-overlay').classList.contains('hidden')) return; // 录像回放开着时，交给它自己的快捷键
    if (e.key === 'Escape' && $('#context-menu')) { closeContextMenu(); return; }
    const cmdkOpen = !$('#cmdk').classList.contains('hidden');
    const lbOpen = !!document.querySelector('.lightbox');
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); cmdkOpen ? cmdk.close() : cmdk.open(); return; }
    if (cmdkOpen) {
      if (e.key === 'Escape') cmdk.close();
      else if (e.key === 'ArrowDown') { e.preventDefault(); cmdk.move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdk.move(-1); }
      else if (e.key === 'Tab') { e.preventDefault(); cmdk.toggleScope(); }
      else if (e.key === 'Enter') { e.preventDefault(); cmdk.choose(cmdk.active, e.metaKey || e.ctrlKey); }
      return;
    }
    if (lbOpen) { if (e.key === 'Escape') document.querySelector('.lightbox').remove(); return; }
    if (imgEditState && (e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); ieUndo(imgEditState); return; }
    // 全屏预览下 Esc 先退出全屏（即便焦点在 md 编辑器里），不直接关掉预览
    if (e.key === 'Escape' && previewMax) { e.preventDefault(); setPreviewMax(false); return; }
    const inTerm = document.activeElement?.closest('.xterm');
    const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable || inTerm;
    // 输入框里按 Esc 先退出输入，别越级把预览关掉
    if (e.key === 'Escape' && inInput) { document.activeElement.blur(); return; }
    if (e.key === 'Escape' && !$('#preview').classList.contains('hidden')) { closePreview(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === '[') { e.preventDefault(); goBack(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !inInput) { e.preventDefault(); toggleSidebar(); return; }
    if (inInput) return;
    // 主区键盘导航
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(state.cols); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-state.cols); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); cursorEnter(e.metaKey || e.ctrlKey); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); const it = state.visible[state.cursor]; if (it) doTrash(it); }
    else if (e.key === 'Backspace') { e.preventDefault(); goUp(); }
    else if (e.key === ' ') { e.preventDefault(); const it = state.visible[state.cursor]; if (it) toggleFav(it); }
    else if (e.key === 'F2') { e.preventDefault(); const it = state.visible[state.cursor]; if (it) doRename(it); }
  });
}
function updateGridSizeVisibility() {
  $('#gridsize-seg').style.display = state.view === 'grid' ? '' : 'none';
}

// ---------- 主题 / 皮肤 ----------
function applyTheme(skin, rerender = true) {
  if (!['terminal', 'warm', 'editorial'].includes(skin)) skin = 'terminal';
  state.theme = skin;
  document.documentElement.dataset.theme = skin;
  localStorage.setItem('fb_theme', skin);
  const link = document.getElementById('hljs-theme');
  if (link) link.href = '/vendor/hljs/styles/' + (skin === 'terminal' ? 'github-dark' : 'github') + '.min.css';
  document.querySelectorAll('#theme-switch .theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.skin === skin));
  if (typeof term !== 'undefined' && term.sessions.length) term.retheme();
  if (typeof mona !== 'undefined') mona.retheme();
  if (rerender && state.entries.length) {
    renderFiles();
    // 预览里的代码高亮配色随皮肤切换，重渲染当前选中项
    if (state.selected && !$('#preview').classList.contains('hidden')) {
      const e = state.entries.find((x) => x.path === state.selected);
      if (e) openPreview(e);
    }
  }
}

// ---------- 终端录像回放（黑匣子的播放端）----------
// 保真铁律：用和 live 终端完全相同的 xterm 配置（主题/字体/unicode11/对比度）回放原始字节流，
// 画面就和当时逐像素一致。时间压缩是非破坏性变换（idle 封顶 + 目标时长反推 + 倍速），原始 .cast 不动。
const player = {
  xterm: null, raw: [], timeline: [], duration: 0, currentTime: 0, cursor: 0,
  playing: false, _raf: 0, _wallStart: 0, _host: null, _canvasOk: false,
  initCols: 80, initRows: 24, cols: 80, rows: 24, current: null, _wired: false,
  opts: { idleCap: 1, target: 60, speed: 1 },

  async open() {
    const ov = $('#replay-overlay');
    if (!ov) return;
    if (!ov.classList.contains('hidden')) return; // 已打开，别重复绑监听（否则 keydown/resize 泄漏）
    ov.classList.remove('hidden');
    this._host = $('#replay-host');
    if (!this._wired) this.wire();
    this._onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      else if (e.key === ' ' && this.timeline.length && !/SELECT|INPUT/.test((e.target.tagName || ''))) { e.preventDefault(); this.toggle(); }
    };
    this._onResize = () => { clearTimeout(this._resizeT); this._resizeT = setTimeout(() => this.rescale(), 120); };
    document.addEventListener('keydown', this._onKey, true);
    window.addEventListener('resize', this._onResize);
    await this.loadList();
  },
  close() {
    // 铁律：关闭永远无条件成功。先把弹窗藏掉（用户立刻解脱），再做清理；任何一步抛错都不许挡住关闭。
    try { $('#replay-overlay').classList.add('hidden'); } catch { /* */ }
    this._exporting = false; // 导出中也允许关：终止导出，不再阻塞
    try { this.pause(); } catch { /* */ }
    try { if (this._onKey) document.removeEventListener('keydown', this._onKey, true); } catch { /* */ }
    try { if (this._onResize) window.removeEventListener('resize', this._onResize); } catch { /* */ }
    try { this.teardownTerm(); } catch { /* */ }
    this.current = null;
  },
  teardownTerm() {
    if (this.xterm) { try { this.xterm.dispose(); } catch { /* */ } this.xterm = null; }
    if (this._host) this._host.innerHTML = '';
  },
  wire() {
    this._wired = true;
    $('#replay-close').onclick = () => this.close();
    $('#replay-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'replay-overlay') this.close(); });
    $('#rp-play').onclick = () => this.toggle();
    // 拖动 seek 用 rAF 节流：大录像每次 seek 是 O(N) 重放，不节流会卡死主线程
    $('#rp-seek').addEventListener('input', (e) => { this.pause(); this._seekTo = this.duration * (e.target.value / 1000); if (this._seekRAF) return; this._seekRAF = requestAnimationFrame(() => { this._seekRAF = 0; this.seekTo(this._seekTo); }); });
    $('#rp-idle').addEventListener('change', (e) => { this.opts.idleCap = parseFloat(e.target.value); this.recompute(); this.seekTo(this.firstAt); });
    $('#rp-target').addEventListener('change', (e) => { this.opts.target = e.target.value ? parseFloat(e.target.value) : null; this.recompute(); this.seekTo(this.firstAt); });
    $('#rp-speed').addEventListener('change', (e) => { this.opts.speed = parseFloat(e.target.value); this.recompute(); this.seekTo(this.firstAt); });
    $('#rp-export').onclick = () => this.exportVideo();
  },
  async loadList() {
    const box = $('#replay-list');
    if (!window.fanboxRec) { box.innerHTML = '<div class="replay-empty-list">录像功能仅在桌面 App 内可用。</div>'; return; }
    const r = await window.fanboxRec.list().catch(() => null);
    const items = (r && r.items) || [];
    if (!items.length) { box.innerHTML = '<div class="replay-empty-list">还没有录像。<br>打开一个终端跑跑 agent，<br>这里会自动出现黑匣子。</div>'; return; }
    box.innerHTML = '';
    items.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'rp-item' + (this.current && this.current.path === it.path ? ' active' : '');
      const when = new Date(it.startedAt || it.mtime);
      const title = (it.cwd ? baseOf(it.cwd) : '') || it.name.replace(/\.cast$/, '');
      const dur = it.duration ? fmtDur(it.duration) + ' · ' : '';
      el.innerHTML = `<div class="rp-item-top">${it.recording ? '<span class="rp-dot-live" title="正在录"></span>' : ''}<span>${escapeHtml(title)}</span><span class="rp-item-del" title="删除">✕</span></div>`
        + `<div class="rp-item-sub">${dur}${when.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${fmtSize(it.size)}</div>`;
      el.querySelector('.rp-item-del').onclick = async (ev) => { ev.stopPropagation(); if (await confirmDialog('删除这段录像？')) { await window.fanboxRec.remove(it.path); this.loadList(); } };
      el.onclick = () => this.select(it);
      box.appendChild(el);
    });
  },
  async select(it) {
    if (this._exporting) { toast('导出进行中，请稍候…', true); return; } // 导出中切换会绑错画布产坏文件
    const r = await window.fanboxRec.read(it.path).catch(() => null);
    if (!r || !r.ok) { toast('读取录像失败', true); return; }
    let header = null; const raw = [];
    for (const line of r.text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (!header && !Array.isArray(v)) { header = v; continue; }
        if (Array.isArray(v) && (v[1] === 'o' || v[1] === 'r')) raw.push({ t: v[0], code: v[1], data: v[2] });
      } catch { /* 跳过坏行 */ }
    }
    if (!header) { toast('录像为空或损坏', true); return; }
    this.current = it;
    this.raw = raw;
    this.recTheme = (header.fanbox && header.fanbox.theme) || ''; // 录制时的皮肤：回放用它，颜色才和当时一致
    this.initCols = this.cols = header.width || 80;
    this.initRows = this.rows = header.height || 24;
    $('#replay-empty').style.display = 'none';
    $('#replay-controls').classList.remove('hidden');
    this.loadList(); // 刷新选中态
    this.buildTerm(this.initCols, this.initRows);
    this.recompute();
    this.seekTo(this.firstAt); // 选中即停在第一帧内容上，不再是空屏
    setTimeout(() => { if (this.current === it) this.play(); }, 400); // 自动播放：选中即「活」起来
  },
  buildTerm(cols, rows) {
    this.teardownTerm();
    const x = new window.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-term').trim() || 'monospace',
      fontSize: 14, lineHeight: 1.2, cursorBlink: false, theme: (term.themes[this.recTheme] || term.theme()), scrollback: 0,
      allowProposedApi: true, minimumContrastRatio: 4.5, cols, rows,
    });
    if (!window.__noUnicode11 && window.Unicode11Addon) {
      try { const U = window.Unicode11Addon.Unicode11Addon || window.Unicode11Addon; x.loadAddon(new U()); x.unicode.activeVersion = '11'; } catch { /* */ }
    }
    x.open(this._host);
    this._canvasOk = false;
    if (!window.__noWebgl && window.WebglAddon) {
      try { const W = window.WebglAddon.WebglAddon || window.WebglAddon; const w = new W(); w.onContextLoss(() => { try { w.dispose(); } catch { /* */ } }); x.loadAddon(w); this._canvasOk = true; } catch { /* 回退 DOM renderer：回放仍可，导出降级 */ }
    }
    this.xterm = x;
    requestAnimationFrame(() => this.rescale());
  },
  // 不改 cols×rows（保证折行和当时一致），用 CSS transform 缩放整块以适配舞台
  rescale() {
    const screen = $('#replay-screen'), host = this._host;
    if (!screen || !host || !this.xterm) return;
    const el = host.querySelector('.xterm');
    if (!el) return;
    host.style.transform = 'none';
    const natW = el.offsetWidth, natH = el.offsetHeight;
    if (!natW || !natH) return;
    const scale = Math.min((screen.clientWidth - 32) / natW, (screen.clientHeight - 32) / natH);
    host.style.transform = `scale(${Math.max(0.1, scale)})`;
  },
  // 非破坏性时间变换。要害：压「等待」不压「流式输出」——把 2h 压成 1min 时，
  // 被牺牲的应该是 agent 思考/装依赖的长静默，而连续吐字的节奏要原样保留，否则糊成闪屏。
  recompute() {
    const STREAM = 0.25; // ≤这个间隔算「流式输出节奏」，保留；更大的算「等待」，可压
    const cap = this.opts.idleCap || 9999;
    const target = this.opts.target;
    const manual = this.opts.speed || 1;
    // 1) 先按 idleCap 压每个间隔（封顶长等待）
    let prev = 0; const gaps = [];
    for (const e of this.raw) { let g = e.t - prev; prev = e.t; if (g < 0) g = 0; if (g > cap) g = cap; gaps.push({ g, code: e.code, data: e.data }); }
    // 2) 设了目标时长：把「等待段」等比压缩去凑目标，「流式段」原样不动；
    //    若光流式段就超目标，宁可超时也保可读（不把连续输出提速成闪屏）
    if (target) {
      let streamSum = 0, idleSum = 0;
      for (const x of gaps) { if (x.g <= STREAM) streamSum += x.g; else idleSum += x.g; }
      const idleBudget = Math.max(0, target - streamSum);
      if (idleSum > idleBudget && idleSum > 0) { const k = idleBudget / idleSum; for (const x of gaps) if (x.g > STREAM) x.g *= k; }
    }
    // 3) 手动倍速叠加，累加成时间轴
    let acc = 0; const tl = [];
    for (const x of gaps) { acc += x.g / manual; tl.push({ at: acc, code: x.code, data: x.data }); }
    this.timeline = tl;
    this.duration = acc;
    const fo = tl.find((x) => x.code === 'o'); // 第一帧有内容的时刻：避开开头空白，选中即见画面
    this.firstAt = fo ? fo.at : 0;
    this.updateTime();
  },
  apply(e) {
    if (!this.xterm) return; // 回放中被关闭/切换会 dispose xterm，这里要挡住空引用
    if (e.code === 'o') this.xterm.write(e.data);
    else if (e.code === 'r') { const m = /^(\d+)x(\d+)$/.exec(e.data); if (m) { try { this.xterm.resize(+m[1], +m[2]); } catch { /* */ } requestAnimationFrame(() => this.rescale()); } }
  },
  seekTo(t) {
    if (!this.xterm) return;
    t = Math.max(0, Math.min(t, this.duration || 0));
    // 后退才从头重放（终端是有状态的，回退必须重建）；前进只从当前 cursor 增量喂，
    // 这样拖动长录像的进度条不会每次都 O(N) 全量重放卡死
    if (t < this.currentTime - 1e-6) {
      try { this.xterm.reset(); this.xterm.resize(this.initCols, this.initRows); } catch { /* */ }
      this.cursor = 0;
    }
    let buf = ''; let resized = false;
    for (; this.cursor < this.timeline.length && this.timeline[this.cursor].at <= t; this.cursor++) {
      const e = this.timeline[this.cursor];
      if (e.code === 'o') buf += e.data;
      else if (e.code === 'r') { if (buf) { this.xterm.write(buf); buf = ''; } const m = /^(\d+)x(\d+)$/.exec(e.data); if (m) { try { this.xterm.resize(+m[1], +m[2]); resized = true; } catch { /* */ } } }
    }
    if (buf) this.xterm.write(buf);
    if (resized) requestAnimationFrame(() => this.rescale());
    this.currentTime = t;
    if (this.playing) this._wallStart = performance.now() - t * 1000;
    this.updateTime();
  },
  toggle() { this.playing ? this.pause() : this.play(); },
  play() {
    if (!this.timeline.length) return;
    if (this.cursor >= this.timeline.length || this.currentTime >= this.duration - 1e-3) this.seekTo(0);
    this.playing = true;
    this._wallStart = performance.now() - this.currentTime * 1000;
    this.setPlayIcon(true);
    this._raf = requestAnimationFrame(() => this.tick());
  },
  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.setPlayIcon(false);
  },
  tick() {
    if (!this.playing || !this.xterm) return;
    const now = (performance.now() - this._wallStart) / 1000;
    while (this.cursor < this.timeline.length && this.timeline[this.cursor].at <= now) this.apply(this.timeline[this.cursor++]);
    this.currentTime = Math.min(now, this.duration);
    this.updateTime();
    if (this.cursor >= this.timeline.length) { this.currentTime = this.duration; this.updateTime(); this.pause(); return; }
    this._raf = requestAnimationFrame(() => this.tick());
  },
  setPlayIcon(playing) {
    const b = $('#rp-play');
    if (b) b.innerHTML = playing
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  },
  updateTime() {
    const f = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const tEl = $('#rp-time'); if (tEl) tEl.textContent = `${f(this.currentTime)} / ${f(this.duration)}`;
    const sk = $('#rp-seek'); if (sk && document.activeElement !== sk) sk.value = this.duration ? String(Math.round(this.currentTime / this.duration * 1000)) : 0;
  },
  exportVideo() { exportReplay(this); },
  // 入口发现性：有录像时给回放按钮点一个小红点（飞行记录仪默默录了一堆，得让用户知道能回看）
  async refreshHint() {
    if (!window.fanboxRec) return;
    const btn = $('#term-replay'); if (!btn) return;
    try { const r = await window.fanboxRec.list(); btn.classList.toggle('has-rec', !!(r && r.items && r.items.length)); } catch { /* */ }
  },
};

// 导出：直接对回放用的 xterm canvas 做 captureStream + MediaRecorder——
// 录的就是播放器画面本身，和你看到的逐像素一致，零外部依赖。手动 requestFrame 保证静止段也出帧。
async function exportReplay(p) {
  if (!p.xterm || !p.timeline.length) { toast('先在左侧选一段录像', true); return; }
  if (!p._canvasOk) { toast('导出需要 WebGL 渲染，当前不可用', true); return; }
  if (!window.MediaRecorder) { toast('当前环境不支持录制导出', true); return; }
  // 选 WebGL 渲染那块画布（另一块 xterm-link-layer 是空覆盖层）。WebGL 不保留 drawing buffer，
  // 必须用 captureStream(fps) 的「自动模式」在合成器层面取帧——手动 requestFrame 取到的是空白。
  const canvases = [...p._host.querySelectorAll('canvas')];
  const srcCanvas = canvases.find((c) => { try { return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } }) || canvases[canvases.length - 1];
  if (!srcCanvas || !srcCanvas.width || !srcCanvas.height) { toast('找不到画布，无法导出', true); return; }
  const cw = srcCanvas.width, ch = srcCanvas.height;
  // WebGL 画布不能直接 drawImage（读回是空白），先 captureStream 喂给 <video>，再画进带 macOS 外框的合成画布
  let srcStream;
  try { srcStream = srcCanvas.captureStream(30); } catch { toast('画布捕获失败', true); return; }
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = srcStream;
  // 外框几何（设备像素，按宽度等比缩放），配色取录像当时的皮肤
  const s = Math.max(0.6, cw / 900);
  const titleH = Math.round(40 * s), pad = Math.round(44 * s), radius = Math.round(11 * s);
  const comp = document.createElement('canvas');
  comp.width = cw + pad * 2; comp.height = ch + titleH + pad * 2;
  const ctx = comp.getContext('2d');
  const theme = term.themes[p.recTheme] || term.theme();
  const termBg = theme.background || '#0b0c0a', fg = theme.foreground || '#cccccc';
  const lightTheme = hexLum(termBg) > 0.5;
  const backdrop = lightTheme ? '#d6d0c4' : '#16181c';
  const title = (p.current && p.current.cwd && baseOf(p.current.cwd)) || '终端录像';
  const fontFam = getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim() || 'sans-serif';
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
  const drawFrame = () => {
    ctx.fillStyle = backdrop; ctx.fillRect(0, 0, comp.width, comp.height);
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.30)'; ctx.shadowBlur = 30 * s; ctx.shadowOffsetY = 12 * s;
    ctx.fillStyle = termBg; rr(pad, pad, cw, titleH + ch, radius); ctx.fill(); ctx.restore();
    ctx.save(); rr(pad, pad, cw, titleH + ch, radius); ctx.clip();
    ctx.fillStyle = lightTheme ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)'; ctx.fillRect(pad, pad, cw, titleH);
    const ly = pad + titleH / 2, lr = Math.round(6 * s); let lx = pad + Math.round(22 * s);
    for (const col of ['#ff5f57', '#febc2e', '#28c840']) { ctx.beginPath(); ctx.fillStyle = col; ctx.arc(lx, ly, lr, 0, Math.PI * 2); ctx.fill(); lx += Math.round(20 * s); }
    ctx.fillStyle = fg; ctx.globalAlpha = 0.68; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(15 * s)}px ${fontFam}`; ctx.fillText(title, pad + cw / 2, ly + 1); ctx.globalAlpha = 1;
    try { ctx.drawImage(video, pad, pad + titleH, cw, ch); } catch { /* video 尚无帧 */ }
    ctx.restore();
  };
  let framePump = 0; const pump = () => { drawFrame(); framePump = requestAnimationFrame(pump); };
  let stream;
  try { stream = comp.captureStream(30); } catch { toast('合成画布捕获失败', true); return; }
  // 渲染层固定录 WebM（Electron 的 MediaRecorder 最稳的就是 vp9/webm），mp4/gif 交给主进程 ffmpeg 转
  const mime = ['video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const chunks = [];
  let mr;
  try { mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10000000 }); }
  catch { toast('无法初始化录制器', true); return; }
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { mr.onstop = res; });
  const btn = $('#rp-export'); const label = btn.textContent;
  p._exporting = true; // 导出期间禁止切换/关闭，避免绑错画布产坏文件
  btn.disabled = true;
  try {
    p.pause(); p.seekTo(0);
    try { await video.play(); } catch { /* */ }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // 等画布稳定
    pump(); // 开始把 video 画进外框
    mr.start(100); // timeslice：周期性产出数据块，短录像也不丢
    p.play();
    // 导出是实时录屏（播一遍就是多久），进度条给用户反馈，别让人以为卡死
    const prog = setInterval(() => { btn.textContent = '录制中 ' + Math.min(99, Math.round(p.currentTime / (p.duration || 1) * 100)) + '%'; }, 200);
    await new Promise((res) => { const iv = setInterval(() => { if (!p.playing) { clearInterval(iv); res(); } }, 80); });
    clearInterval(prog);
    await new Promise((r) => setTimeout(r, 500)); // 末帧多停一拍
    try { mr.stop(); } catch { /* */ }
    await stopped;
    cancelAnimationFrame(framePump);
    try { stream.getTracks().forEach((t) => t.stop()); srcStream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { video.pause(); video.srcObject = null; } catch { /* */ }
    if (!chunks.length) { toast('没有捕获到画面（导出需要 WebGL）', true); return; }
    const fmt = ($('#rp-format') && $('#rp-format').value) || 'mp4';
    btn.textContent = fmt === 'webm' ? '保存中…' : '转码中…';
    const blob = new Blob(chunks, { type: mime });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const tag = (p.current && p.current.cwd && baseOf(p.current.cwd)) || 'session';
    const name = `终端录像-${tag}-${fmtStamp()}`;
    // 渲染层永远产 WebM，交给主进程按 fmt 用 ffmpeg 转 mp4/gif（无 ffmpeg 自动退回 webm）
    const r = await window.fanboxRec.export(name, buf, fmt).catch(() => null);
    if (r && r.ok) { toast('已导出 ' + baseOf(r.path) + (r.fellBack ? '（' + r.fellBack + '）' : '') + '，在访达打开'); window.fanboxRec.reveal(r.path); }
    else { toast('导出失败' + (r && r.error ? '：' + r.error : ''), true); }
  } finally {
    try { cancelAnimationFrame(framePump); } catch { /* */ }
    try { stream.getTracks().forEach((t) => t.stop()); srcStream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { video.pause(); video.srcObject = null; } catch { /* */ }
    p._exporting = false; btn.disabled = false; btn.textContent = label;
  }
}
// 简易相对亮度（判断皮肤深浅，给外框选底色）
function hexLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 0.2;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
function fmtStamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

// ---------- 内嵌终端（仅桌面 app；浏览器版优雅降级）----------
// agent「等你拍板」界面特征（claude code 2.1.x / codex 0.13x 实测文案，宁缺勿滥：
// 不命中只是退化成「任务完成」标题，不会漏响）
const TERM_ASK_RE = /(Do you want to (proceed|continue|make this edit|allow|use this)|Would you like to proceed|Ready to code\?|created or one you trust\?|tell (Claude|Codex) what to do differently|Yes, and don't ask again|Allow Codex to (run|apply|create)|Codex wants to|[❯›][ \t]*1\.[ \t]*Yes)/;
const term = {
  sessions: [], seq: 0, active: null, maximized: false,
  dock: localStorage.getItem('fb_term_dock') || 'right',
  available() { return !!(window.fanboxPty && window.Terminal && !window.__noXterm); },
  // 每套皮肤一整套手调 ANSI 主题——暗皮肤暗终端、亮皮肤亮终端，不再出现「暖纸里嵌黑块」
  themes: {
    terminal: {
      background: '#0b0c0a', foreground: '#d6dac9', cursor: '#cdf24b', cursorAccent: '#0b0c0a', selectionBackground: '#cdf24b40',
      black: '#1c1e17', red: '#e8825b', green: '#cdf24b', yellow: '#e8c95b', blue: '#7bc9e8', magenta: '#d68ad6', cyan: '#5bd6c0', white: '#d6dac9',
      brightBlack: '#62655a', brightRed: '#ff9b73', brightGreen: '#dcff66', brightYellow: '#ffe082', brightBlue: '#9ad8ff', brightMagenta: '#f0a8f0', brightCyan: '#7fffe0', brightWhite: '#f2f2ea',
    },
    warm: {
      background: '#ece2d2', foreground: '#4a3f30', cursor: '#cc785c', cursorAccent: '#ece2d2', selectionBackground: '#cc785c33',
      black: '#3a3025', red: '#b5502f', green: '#5f7a36', yellow: '#9a7b2e', blue: '#3a6a8a', magenta: '#9a5a7a', cyan: '#3a7a70', white: '#6b6355',
      brightBlack: '#8a7d68', brightRed: '#c75f38', brightGreen: '#6f8a40', brightYellow: '#b08a30', brightBlue: '#4a7a9a', brightMagenta: '#aa6a8a', brightCyan: '#4a8a82', brightWhite: '#3a3025',
    },
    editorial: {
      background: '#eae5d8', foreground: '#1a1a1a', cursor: '#ff433d', cursorAccent: '#eae5d8', selectionBackground: '#ff433d22',
      black: '#0a0a0a', red: '#cc1f1a', green: '#00803a', yellow: '#8a6d00', blue: '#0000cc', magenta: '#9a2a8a', cyan: '#007a8a', white: '#57534a',
      brightBlack: '#57534a', brightRed: '#e8302a', brightGreen: '#00a33e', brightYellow: '#a67c00', brightBlue: '#2222dd', brightMagenta: '#b03aa0', brightCyan: '#008a9a', brightWhite: '#0a0a0a',
    },
  },
  theme() { return this.themes[state.theme] || this.themes.terminal; },
  toggle() {
    if (!this.available()) { if (state.cwd) openWith(state.cwd, 'terminal'); return; } // 浏览器降级到系统终端
    const hidden = $('#terminal-panel').classList.contains('hidden');
    hidden ? this.open() : this.close();
  },
  open() {
    $('#terminal-panel').classList.remove('hidden');
    $('#terminal-resizer').classList.remove('hidden');
    this.applyDock();
    if (!this.sessions.length) this.newTab();
    else this.fitActive();
    $('#btn-terminal').classList.add('active');
    player.refreshHint(); // 有录像就给回放按钮点红点，提升发现性
    localStorage.setItem('fb_term_open', '1');
    if (!localStorage.getItem('fb_term_draghint')) { localStorage.setItem('fb_term_draghint', '1'); setTimeout(() => toast('提示：把左侧文件 / 文件夹拖进终端，即插入路径喂给 agent'), 700); }
    // 终端里点击不移光标是终端协议使然（光标归 CLI 程序管，双击只是选词）。xterm 内置
    // altClickMovesCursor（默认开）：Option+点击会合成方向键把光标移过去——补一条一次性提示让人发现（#59）
    else if (!localStorage.getItem('fb_term_optionhint')) { localStorage.setItem('fb_term_optionhint', '1'); setTimeout(() => toast('提示：按住 Option 点击输入行文字，光标会移到点击处（终端里普通点击/双击是选字，同 iTerm）'), 700); }
  },
  close() {
    if (this.maximized) this.toggleMax(false); // 铺满状态下收起终端，term-max 不清会把文件区一起藏没
    if (typeof wechatView !== 'undefined' && wechatView.shown()) wechatView.close(); // 收起终端时一并关掉微信界面，停掉后台轮询
    $('#terminal-panel').classList.add('hidden');
    $('#terminal-resizer').classList.add('hidden');
    $('#main-body').classList.remove('fm-squeezed'); // 终端收起后文件区必须回来
    $('#btn-terminal').classList.remove('active');
    localStorage.setItem('fb_term_open', '0');
  },
  // 标签布局快照：几个标签、各在哪个目录、谁在前台。renderTabs 是所有标签变化的必经之路，在那里落
  persistTabs() {
    try {
      localStorage.setItem('fb_term_tabs', JSON.stringify({
        tabs: this.sessions.map((s) => ({ cwd: s.cwd || s.startDir || '' })),
        active: this.sessions.findIndex((s) => s.id === this.active),
      }));
    } catch { /* */ }
  },
  // 下次打开时还原上面的快照：进程不复活（shell 全新），但打开就是你离开时的格局
  async restore(saved) {
    $('#terminal-panel').classList.remove('hidden');
    $('#terminal-resizer').classList.remove('hidden');
    this.applyDock();
    $('#btn-terminal').classList.add('active');
    for (const t of (saved.tabs || []).slice(0, 8)) await this.newTab(t.cwd || undefined);
    const want = this.sessions[saved.active];
    if (want) this.activate(want.id);
    if (!this.sessions.length) this.newTab(); // 快照坏了也保证有一个标签
    player.refreshHint();
    localStorage.setItem('fb_term_open', '1');
  },
  applyDock() {
    const mb = $('#main-body');
    mb.classList.toggle('dock-bottom', this.dock === 'bottom');
    mb.classList.toggle('dock-right', this.dock === 'right');
    // 全铺状态只在终端可见时恢复，否则文件区会凭空消失
    const termOpen = !$('#terminal-panel').classList.contains('hidden');
    mb.classList.toggle('fm-squeezed', termOpen && localStorage.getItem('fb_term_squeeze') === '1');
    const panel = $('#terminal-panel');
    // 首次开终端：文件区:终端 = 1:2，终端占主区 2/3（用户拖过 resizer 后用记下的 px）
    const mbr = mb.getBoundingClientRect();
    if (this.dock === 'bottom') {
      const h = Number(localStorage.getItem('fb_term_h')) || (mbr.height ? Math.round(mbr.height * 2 / 3) : 280);
      panel.style.height = h + 'px'; panel.style.width = '';
    } else {
      const w = Number(localStorage.getItem('fb_term_w')) || (mbr.width ? Math.round(mbr.width * 2 / 3) : 480);
      panel.style.width = w + 'px'; panel.style.height = '';
    }
    applyPreviewSize(); // 预览随 dock 翻转轴向
    this.fitActive();
  },
  setDock(d) {
    if (this.maximized) this.toggleMax(false); // 铺满下切布局看不出任何变化，先退出铺满让分屏可见
    animateLayout(); this.dock = d; localStorage.setItem('fb_term_dock', d); this.applyDock();
  },
  // 终端最大化：铺满整个中区（文件区让位），再点还原
  toggleMax(force) {
    animateLayout();
    this.maximized = force === undefined ? !this.maximized : force;
    $('#main-body').classList.toggle('term-max', this.maximized);
    const b = $('#term-max');
    if (b) { b.classList.toggle('on', this.maximized); b.title = this.maximized ? '还原终端' : '终端铺满'; }
    this.fitActive();
  },
  // 在指定目录开终端（新标签）；浏览器版降级到系统终端。返回新 session（spawn 完成后）
  openInDir(dir) {
    if (!this.available()) { openWith(dir, 'terminal'); return null; }
    $('#terminal-panel').classList.remove('hidden');
    $('#terminal-resizer').classList.remove('hidden');
    this.applyDock();
    $('#btn-terminal').classList.add('active');
    localStorage.setItem('fb_term_open', '1'); // 右键/一键开终端也记住开合，和 open/close 对称
    return this.newTab(dir);
  },
  // 拖拽文件/文件夹进来：把 shell 转义后的路径插入活动终端（作为 agent 上下文）
  insertPath(p) {
    if (!this.available()) { openWith(dirOf(p), 'terminal'); return; }
    const wasHidden = $('#terminal-panel').classList.contains('hidden');
    if (wasHidden) this.open();
    const write = () => { if (this.active) this.input(this.active, shQuote(p) + ' '); const s = this.sessions.find((x) => x.id === this.active); if (s) s.xterm.focus(); };
    if (wasHidden) setTimeout(write, 280); else write();
  },
  // ⌘V / 右键粘贴：文字照常粘。网页、微信里复制的图片在剪贴板上没有路径，
  // navigator.clipboard 只看得见文字，于是这类粘贴一直是「按了没反应」——
  // 走主进程把位图落盘成临时 png，再把路径插进去，终端里的 agent 就能读到那张图了。
  async pasteInto(xterm) {
    this.pastedAt = Date.now(); // 同步打点：⌘V 还会顺着系统「编辑>粘贴」再触发一次 paste 事件，让那边认出是同一次
    const bridge = window.fanboxClipboard && window.fanboxClipboard.readForPaste;
    if (!bridge) { // 浏览器版没有主进程桥，退回纯文字
      try { const t = await navigator.clipboard.readText(); if (t) xterm.paste(t); } catch { /* 无权限时走 Electron 菜单兜底 */ }
      return;
    }
    const r = await bridge().catch(() => null);
    if (!r) return;
    if (r.kind === 'text') { xterm.paste(r.text); return; }
    if (r.kind === 'image' || r.kind === 'file') {
      this.insertPath(r.path);
      if (r.kind === 'image') toast('剪贴板图片已存成文件，路径已插入终端');
      return;
    }
    if (r.kind === 'error') toast('读剪贴板失败：' + (r.error || ''), true);
    else toast('剪贴板是空的');
  },
  // 一键在终端启动 coding agent：当前标签是空闲 shell 就地启动；正跑着东西（claude/codex/任何前台程序）
  // 则新开标签，不打断也不把命令打进别的程序里
  async launchAgent(cmd) {
    if (!this.available()) { openWith(state.cwd, 'terminal'); return; } // 网页版降级到系统终端
    let sess = null;
    if (this.sessions.length) {
      if ($('#terminal-panel').classList.contains('hidden')) this.open();
      const cur = this.sessions.find((x) => x.id === this.active);
      if (cur && !cur.dead && await this.isPlainShell(cur)) sess = cur;
    }
    if (!sess) sess = await this.openInDir(state.cwd); // 等 spawn 完，拿确切 session 写入
    if (sess && !sess.dead) { this.input(sess.id, cmd + '\r'); sess.xterm.focus(); toast('已在终端启动 ' + cmd); }
    else toast('终端启动失败', true);
  },
  // 在指定目录新开标签跑命令（续会话/发版等）：不复用别处的空闲 shell，目录必须对
  async runInDir(dir, cmd, msg) {
    if (!this.available()) { openWith(dir, 'terminal'); return; }
    const sess = await this.openInDir(dir);
    if (sess && !sess.dead) { this.input(sess.id, cmd + '\r'); sess.xterm.focus(); toast(msg || '已在终端启动'); }
    else toast('终端启动失败', true);
  },
  // 该会话前台是不是裸 shell？判断不了一律按「不是」处理——宁可新开标签，也不往运行中的程序里打字
  async isPlainShell(s) {
    try {
      const r = await window.fanboxPty.proc(s.id);
      if (!r || !r.ok || !r.proc) return false;
      const name = String(r.proc).split('/').pop().replace(/^-/, '').toLowerCase();
      return ['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh', 'nu', 'pwsh', 'powershell.exe', 'cmd.exe'].includes(name);
    } catch { return false; }
  },
  // 把预览里选中的文字作为「上下文」喂给终端 agent：带文件出处 + 围栏，bracketed paste 防逐行误提交
  sendContext(text, srcPath) {
    if (!this.available()) { toast('内嵌终端不可用（网页版没有终端）', true); return; }
    const wasHidden = $('#terminal-panel').classList.contains('hidden');
    if (wasHidden) this.open();
    const rel = srcPath ? srcPath.replace(state.home, '~') : '';
    const head = rel ? `（来自 ${rel} 的片段）` : '（选中的片段）';
    const block = `${head}\n\`\`\`\n${text}\n\`\`\`\n`;
    const write = () => {
      if (!this.active) return;
      // \x1b[200~ … \x1b[201~ 是 bracketed paste：多行内容当作一次粘贴，不会被 shell/TUI agent 逐行执行
      this.input(this.active, '\x1b[200~' + block + '\x1b[201~');
      const s = this.sessions.find((x) => x.id === this.active); if (s) s.xterm.focus();
    };
    if (wasHidden) setTimeout(write, 300); else write();
  },
  // 把一条现成指令递给终端里的 agent（排版档的「送去…」用）：只粘不回车——
  // 用户看得见指令原文、能改能拒，发布这种不可逆动作永远不由 FanBox 代按。
  async sendPrompt(text) {
    if (!this.available()) { toast('内嵌终端不可用（网页版没有终端）', true); return; }
    if (!this.sessions.length || !this.active) { toast('先在右边开个终端、启动 agent，再送稿', true); return; }
    const cur = this.sessions.find((x) => x.id === this.active);
    if (!cur || cur.dead) { toast('当前终端标签已经关了', true); return; }
    // 裸 shell 接不住自然语言，打进去只会 command not found——沿用「不往运行中的程序里乱打字」的老规矩
    if (await this.isPlainShell(cur)) { toast('当前标签是裸 shell，先启动 Claude Code 或 Codex 再送', true); return; }
    const wasHidden = $('#terminal-panel').classList.contains('hidden');
    if (wasHidden) this.open();
    const write = () => { this.input(this.active, '\x1b[200~' + text + '\x1b[201~'); cur.xterm.focus(); };
    if (wasHidden) setTimeout(write, 300); else write();
    toast('指令已递进终端，看一眼没问题就回车');
  },
  // 用户输入统一入口：记 lastInput 供回显过滤（击键/粘贴/拖路径/跟随 cd 引发的重绘不算 agent 干活）
  input(id, d) {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.lastInput = Date.now();
      // 回车多半提交了条命令（cd 这类被回显过滤、不走 busy 周期），稍后把标题对齐真实目录
      if (d.indexOf('\r') !== -1) { clearTimeout(s._cwdT); s._cwdT = setTimeout(() => this.refreshCwd(s, true), 800); }
    }
    window.fanboxPty.input(id, d);
  },
  // 点终端里的文件名/路径 → 结合 cwd + 回扫 scrollback + 搜索定位真实文件，在翻箱里打开
  // tail：路径在该逻辑行里的后续文本，服务端用它做「空格扩展」stat 验证（带空格的文件名靠它补全）
  // rowHint：点击处逻辑行的末物理行号（buffer 绝对行），回扫 scrollback 的起点
  async openTermPath(id, raw, tail, rowHint) {
    let p = String(raw).replace(/^['"]+/, '').replace(/[)\]'"`,:;]+$/, '');
    let cwd = state.cwd;
    let candidate = p;
    const isRel = !p.startsWith('/') && !p.startsWith('~');
    if (isRel) {
      try { const r = await window.fanboxPty.cwd(id); if (r && r.ok && r.cwd) cwd = r.cwd; } catch { /* */ }
      candidate = (cwd || '').replace(/\/$/, '') + '/' + p.replace(/^\.\//, '');
    }
    const name = p.replace(/\/+$/, '').split('/').pop(); // 去掉目录结尾 / 再取 basename，否则名为空 basename 搜索失效
    // 回扫 scrollback：agent 生成文件时几乎总打印过全路径（裸文件名常常不在 cwd 下），比模糊搜索可信
    const alt = isRel ? this.scanScrollbackFor(id, name, rowHint) : '';
    // 活跃项目根（浏览目录 + 各终端项目目录）作 basename 搜索的额外根
    const roots = [];
    if (state.cwd) roots.push(state.cwd);
    this.sessions.forEach((x) => { const d = x.cwd || x.startDir; if (d && !roots.includes(d)) roots.push(d); });
    const q = encodeURIComponent;
    const r = await api(`/api/locate?path=${q(candidate)}&name=${q(name)}&root=${q(cwd || state.home)}&tail=${q(tail || '')}&alt=${q(alt)}&roots=${q(roots.join('\n'))}`);
    if (!r.found) { toast('没找到「' + name + '」', true); return; }
    if (r.isDir) { navigate(r.path); toast('已跳到该目录'); return; }
    await navigate(dirOf(r.path));
    const e = state.entries.find((x) => x.path === r.path) || { path: r.path, name: baseOf(r.path), kind: 'text', isDir: false };
    applySelection(r.path); openPreview(e); recordRecent(r.path);
    toast(r.viaSearch ? '未精确命中，已打开最接近的「' + baseOf(r.path) + '」' : (r.viaScrollback ? '已按会话里出现过的路径打开' : '已打开'));
  },
  // 从 fromRow 往上回扫 scrollback（最多 2000 物理行），收集含该 basename 的绝对路径（/ 或 ~ 开头，
  // 最近出现在前，≤3 个），交给 /api/locate 逐个 stat 验证。折行沿 isWrapped 拼回逻辑行；
  // 含 … 的截断路径、URL（// 开头或紧跟冒号）跳过，继续往上找干净的
  scanScrollbackFor(id, name, fromRow) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || !name) return '';
    const buf = s.xterm.buffer.active;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:~|/)(?:[^\\s\'"`()]*/)?' + esc + '(?=$|[\\s\'"`)\\],:;。，）】、？！；：])', 'gu');
    const hits = [];
    let row = Math.min(fromRow == null ? buf.length - 1 : fromRow, buf.length - 1);
    let budget = 2000;
    while (row >= 0 && budget > 0 && hits.length < 3) {
      let start = row;
      while (start > 0 && buf.getLine(start) && buf.getLine(start).isWrapped) start--;
      budget -= row - start + 1;
      let text = '';
      for (let i = start; i <= row; i++) {
        const ln = buf.getLine(i);
        if (ln) text += ln.translateToString(i === row); // 折行中段保持整行宽（不 trim），仅末行 trim
      }
      if (text.includes(name)) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) { // 行内多候选：跳过被护栏否决的，继续找同行更干净的
          const cand = m[0];
          if (cand && !cand.includes('…') && !cand.includes('...') && !cand.startsWith('//') && text[m.index - 1] !== ':' && !hits.includes(cand)) { hits.push(cand); break; }
        }
      }
      row = start - 1;
    }
    return hits.join('\n');
  },
  // 定位文件区到活动终端的真实目录
  async locateCwd() {
    if (!this.active) return;
    const r = await window.fanboxPty.cwd(this.active);
    if (r && r.ok && r.cwd) navigate(r.cwd);
    else toast('取终端目录失败', true);
  },
  // 项目身份色：路径稳定哈希到色相——同一项目的标签色点永远一个色，扫一眼即配对
  hueOf(p) { let h = 0; for (let i = 0; i < (p || '').length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0; return h % 360; },
  // 标签标题跟着终端「现在」的目录走（lsof 查真实 cwd），不再停留在创建时的快照；
  // 多标签跑不同项目的 agent 时，标题才认得出谁是谁
  async refreshCwd(s, force) {
    if (!s || s.dead) return;
    const now = Date.now();
    // 轻节流：避免每 3-5 秒打一条日志的后台会话（dev server）在 busy→idle 间无限循环里反复 spawn lsof。
    // cd / 用户主动场景传 force 跳过节流，标题立刻对齐
    if (!force && now - (s._cwdAt || 0) < 4000) return;
    s._cwdAt = now;
    try {
      const r = await window.fanboxPty.cwd(s.id);
      if (r && r.ok && r.cwd && r.cwd !== s.cwd) {
        s.cwd = r.cwd; s.title = baseOf(r.cwd) || s.title;
        this.renderTabs(); renderBreadcrumb(); // 面包屑的项目配对色点也跟着换
      }
    } catch { /* 取不到就保持原标题 */ }
  },
  async newTab(cwdOverride) {
    const startDir = cwdOverride || state.cwd;
    const id = 't' + (++this.seq);
    const host = document.createElement('div');
    host.className = 'xterm-instance';
    $('#xterm-host').appendChild(host);
    host.classList.add('show'); // 先可见再 open/fit：display:none 下 fit 量不出尺寸，PTY 会以 80 列出生
    const FitCtor = window.FitAddon ? (window.FitAddon.FitAddon || window.FitAddon) : null;
    const xterm = new window.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-term').trim() || 'monospace',
      fontSize: 13, lineHeight: 1.2, cursorBlink: true, theme: this.theme(), scrollback: 5000,
      allowProposedApi: true, // unicode11 宽度 API 需要
      // claude/codex 等 TUI 会开启鼠标上报，鼠标拖拽被程序吃掉 → 默认无法选中文字。
      // 开这个开关后按住 Option 拖拽即可强制选中复制（iTerm/VS Code 终端同款约定）
      macOptionClickForcesSelection: true,
      // agent 常输出按深色终端设计的 256 色/真彩（如淡蓝路径），在浅色皮肤上几乎隐形；
      // 自动把对比度不足的前景色压暗/提亮到 4.5:1（WCAG AA，VS Code 终端同款默认值）
      minimumContrastRatio: 4.5,
    });
    const fit = FitCtor ? new FitCtor() : null;
    if (fit) xterm.loadAddon(fit);
    // 剪贴板支持：右键菜单 + 复制粘贴
    if (!window.__noClipboard && window.ClipboardAddon) {
      try { const C = window.ClipboardAddon.ClipboardAddon || window.ClipboardAddon; xterm.loadAddon(new C()); } catch { /* */ }
    }
    // CJK 宽字符正确宽度：没有它，中文目录名会让 zsh 提示符重绘错列（乱码）
    if (!window.__noUnicode11 && window.Unicode11Addon) {
      try { const U = window.Unicode11Addon.Unicode11Addon || window.Unicode11Addon; xterm.loadAddon(new U()); xterm.unicode.activeVersion = '11'; } catch { /* */ }
    }
    xterm.open(host);
    // WebGL 渲染加速（大输出/TUI 不掉帧），失败或上下文丢失回退 DOM
    // 诊断开关：控制台跑 fbWebgl(false) 关掉 WebGL（用 DOM renderer）排查 CJK 残影乱码，fbWebgl(true) 恢复，需新开标签生效
    const webglOff = (() => { try { return localStorage.getItem('fanbox.noWebgl') === '1'; } catch { return false; } })();
    let wg = null; // 存到 session 上，换肤/字号/resize 时清图集修 CJK 残影乱码（#37/#45）
    if (!webglOff && !window.__noWebgl && window.WebglAddon) {
      try {
        const Wg = window.WebglAddon.WebglAddon || window.WebglAddon;
        wg = new Wg();
        wg.onContextLoss(() => { try { wg.dispose(); } catch { /* */ } });
        xterm.loadAddon(wg);
        this.watchAtlas(wg);
      } catch { wg = null; /* 回退默认 DOM renderer */ }
    }
    if (fit) try { fit.fit(); } catch { /* */ }
    const sess = { id, xterm, fit, host, webgl: wg, dead: false, status: 'idle', unread: false, startDir, title: baseOf(startDir || '') || 'shell' };
    this.sessions.push(sess);
    this.activate(id);
    updateWatches(); // 新终端的项目目录也纳入监听
    const r = await window.fanboxPty.spawn({ id, cwd: startDir, cols: xterm.cols, rows: xterm.rows, theme: state.theme });
    if (!r.ok) { sess.dead = true; xterm.write('\r\n  \x1b[31m终端启动失败：' + (r.error || '') + '\x1b[0m\r\n'); }
    else sess.cwd = r.cwd || startDir; // 末尾 renderTabs 统一带上 cwd 重画
    xterm.onData((d) => {
      if (sess.dead) { if (d === '\r' || d === '\n') this.respawn(sess); return; } // 进程退出后回车真重开
      this.input(id, d);
    });
    xterm.onResize(({ cols, rows }) => { sess.lastInput = Date.now(); window.fanboxPty.resize(id, cols, rows); }); // resize 引发的 TUI 重绘不算 agent 干活
    window.fanboxPty.resize(id, xterm.cols, xterm.rows); // spawn 等待期间 fit 过的 resize 事件无人监听会丢：补发一次对齐 PTY

    // 自定义键盘处理：⌘C 有选中文本则复制，否则发 SIGINT；⌘V 粘贴；⌘+/⌘-/⌘0 字体缩放
    xterm.attachCustomKeyEventHandler((e) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && (e.key === 'c' || e.key === 'C')) {
        if (xterm.hasSelection()) {
          // 有选中 → 复制到剪贴板，不发给 PTY
          try {
            const sel = xterm.getSelection();
            navigator.clipboard.writeText(sel);
            xterm.clearSelection();
          } catch { /* 剪贴板不可用时走菜单兜底 */ }
          e.preventDefault();
          return false;
        }
        // 无选中 → 正常发送 SIGINT (⌘C 本来的行为)
        return true;
      }
      if (cmd && (e.key === 'v' || e.key === 'V')) {
        // ⌘V 粘贴：文字/图片/文件都收（图片和文件落成路径）
        e.preventDefault();
        term.pasteInto(xterm);
        return false;
      }
      if (cmd && (e.key === '=' || e.key === '+' || e.key === '0')) {
        e.preventDefault();
        const delta = e.key === '0' ? 0 : (e.key === '=' || e.key === '+' ? 1 : -1);
        term.adjustFont(sess, delta);
        return false;
      }
      if (cmd && e.key === '-') {
        e.preventDefault();
        term.adjustFont(sess, -1);
        return false;
      }
      return true;
    });

    // 右键菜单：复制/粘贴
    host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hasSel = xterm.hasSelection();
      const items = [];
      if (hasSel) items.push({ label: '复制', fn: () => {
        try { navigator.clipboard.writeText(xterm.getSelection()); xterm.clearSelection(); } catch {}
      }});
      items.push({ label: '粘贴', fn: () => term.pasteInto(xterm) });
      popupMenu(e, items);
    });
    // 走系统「编辑 > 粘贴」菜单的那条路：图片会以 File 形式落在 clipboardData 上，
    // xterm 只认文字会当没粘。这里截下来落盘换路径，和 ⌘V 一个口径。
    host.addEventListener('paste', (ev) => {
      const files = ev.clipboardData ? [...(ev.clipboardData.files || [])] : [];
      const img = files.find((f) => f.type.startsWith('image/'));
      if (!img || !window.fanboxDrop) return; // 纯文字粘贴交给 xterm 自己处理
      ev.preventDefault();
      ev.stopPropagation(); // 别让 xterm 拿这个事件去粘一段空文本
      if (Date.now() - (term.pastedAt || 0) < 800) return; // ⌘V 那条路已经插过了，别插第二遍
      const ext = (img.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      img.arrayBuffer()
        .then((buf) => window.fanboxDrop.saveTemp(`粘贴图片-${fmtStamp()}.${ext}`, buf))
        .then((r) => { if (r && r.ok) { term.insertPath(r.path); toast('剪贴板图片已存成文件，路径已插入终端'); } })
        .catch(() => toast('剪贴板图片存盘失败', true));
    }, true);

    // 选中即复制（iTerm2 默认行为）
    xterm.onSelectionChange(() => {
      if (xterm.hasSelection()) {
        try { navigator.clipboard.writeText(xterm.getSelection()); } catch { /* 静默失败，用户仍可右键/菜单复制 */ }
      }
    });

    // 识别终端输出里的文件路径 → hover 高亮 + 点击在翻箱打开
    // 三层匹配：引号串（边界最可靠，文件名可含空格）> 斜杠路径 > 带已知扩展名的裸文件名；
    // 长路径折行用逐 cell 拼回逻辑行（CJK 宽字符占两列，下标→坐标必须按 cell 算才不偏移）
    if (xterm.registerLinkProvider) {
      xterm.registerLinkProvider({
        provideLinks: (lineNo, cb) => {
          const buf = xterm.buffer.active;
          if (!buf.getLine(lineNo - 1)) { cb(undefined); return; }
          let startRow = lineNo - 1;
          while (startRow > 0 && buf.getLine(startRow).isWrapped) startRow--;
          let endRow = startRow;
          while (buf.getLine(endRow + 1) && buf.getLine(endRow + 1).isWrapped) endRow++;
          let text = '';
          const pos = []; // pos[i] = 第 i 个字符的终端坐标 {x, y, w}
          for (let row = startRow; row <= endRow; row++) {
            const ln = buf.getLine(row);
            if (!ln) break;
            for (let col = 0; col < ln.length; col++) {
              const cell = ln.getCell(col);
              if (!cell || cell.getWidth() === 0) continue; // 宽字符的占位列
              const ch = cell.getChars() || ' ';
              for (const c of ch) { text += c; pos.push({ x: col + 1, y: row + 1, w: cell.getWidth() }); }
            }
          }
          const t = text.replace(/\s+$/, '');
          const links = []; const found = [];
          const overlaps = (s, e) => found.some((f) => s < f.e && e > f.s);
          const push = (s, e, cand, tail, act) => {
            if (e - s < 3 || overlaps(s, e)) return;
            const a = pos[s], b = pos[e - 1];
            if (!a || !b) return;
            found.push({ s, e, cand, tail });
            links.push({
              range: { start: { x: a.x, y: a.y }, end: { x: b.x + b.w - 1, y: b.y } },
              text: cand,
              decorations: { pointerCursor: true, underline: true },
              activate: act || (() => this.openTermPath(id, cand, tail, endRow)),
            });
          };
          let m;
          // 0. URL：直接系统浏览器打开（Electron 的 windowOpenHandler 会转 shell.openExternal）
          // 全角标点不可能裸出现在合法 URL 里（必须百分号编码），排除掉防止「url、后续散文」粘连
          const reU = /\bhttps?:\/\/[^\s'"`<>）（【】「」，。、？！：；]+/g;
          while ((m = reU.exec(t)) !== null) {
            const url = m[0].replace(/[)\],.:;。，？！?!）】>]+$/, '');
            push(m.index, m.index + url.length, url, '', () => window.open(url));
          }
          // 1. 引号串：拖拽插入/agent 输出常用 '…' 包路径，内容像路径或文件名就整体认
          const reQ = /'([^']{3,})'|"([^"]{3,})"/g;
          while ((m = reQ.exec(t)) !== null) {
            const inner = m[1] || m[2];
            if (!inner.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(inner)) continue;
            push(m.index + 1, m.index + 1 + inner.length, inner, '');
          }
          // 2. 含斜杠的 token：宽进严出——整个 token 都收（.claude/x、写作/01-xx、/abs、~/x 全覆盖），
          // 配不配下划线交给服务端 stat 验证（散文里的「分发/产品演示——……」会被验证刷掉）。
          // 全角胶水标点（：、，。等）必须进切断集：它们出现在路径「前面」时（看看效果：/tmp/x.png、
          // 顿号列举的第二项），后置 split 救不回来——要么整段散文粘进候选 stat 必败，要么首段为空整条丢弃
          const reP = /[^\s'"`:()（）「」【】<>：；，。、？！]*\/[^\s'"`:()（）「」【】<>：；，。、？！]*/g;
          const r2 = [];
          const truncated = [];
          while ((m = reP.exec(t)) !== null) {
            // 全角标点几乎不出现在路径里，却常把路径和后续散文粘成一个 token：切到第一个为止。
            // … 不进切断集：它是 agent 截断长路径的省略号（…tems/x/截屏.png 开头截断最常见），
            // 一刀切会把整条截断路径切成空串丢掉。… 后面还有 / 说明在路径头/中段，保留；
            // 后面没有 / 的才是粘连散文或尾部截断（basename 已残，搜也搜不到），从右往左切掉
            let raw = m[0].split(/[，。、？！—]+/)[0];
            let gi;
            while ((gi = raw.lastIndexOf('…')) !== -1 && !raw.slice(gi + 1).includes('/')) raw = raw.slice(0, gi);
            raw = raw.replace(/[)\],.:;]+$/, '');
            if (raw.length < 3 || !raw.includes('/') || /^https?:\/\//.test(raw)) continue;
            if (overlaps(m.index, m.index + raw.length)) continue;
            const tail = t.slice(m.index + raw.length).split(/['"`]/)[0].slice(0, 160);
            // 截断路径（.../…）：完整字符串通不过 stat 验证，但 basename 搜索通常能定位，
            // 所以不等待验证，直接给下划线；点开后 openTermPath 会走 basename 搜索兜底。
            const isTruncated = raw.includes('…') || /(^|\/)\.{3,}/.test(raw);
            if (isTruncated) truncated.push({ s: m.index, e: m.index + raw.length, cand: raw, tail });
            else r2.push({ s: m.index, e: m.index + raw.length, cand: raw, tail });
          }
          // 截断路径直接创建链接，避免验证失败导致无法点击
          truncated.forEach((x) => push(x.s, x.e, x.cand, x.tail));
          // 目录候选（结尾 /）：和带扩展名的裸文件名享受同等兜底——验证通过则用精确路径，
          // 验证失败（终端 cwd 与打印的相对路径基准不一致时常见）也保留链接，点开走 basename 搜索。
          // 文件靠扩展名白名单兜底，目录没扩展名，全靠结尾 / 这个强信号（散文几乎不这么写）。
          const dirCands = r2.filter((x) => x.cand.endsWith('/'));
          const finish = () => {
            // 3. 裸文件名：unicode 字符类（调研.md 能点）+ 扩展名白名单（e.g/node.js 不误报）。
            // 紧跟斜杠路径、只隔空格的裸名多半是同一带空格路径的后半段：点哪段都按完整串定位
            //（真分离的如 ls /tmp foo.md，完整串 stat 不中会回落到 basename 搜索，不会开错）
            TERM_LINK_RE_BARE.lastIndex = 0;
            let mm;
            while ((mm = TERM_LINK_RE_BARE.exec(t)) !== null) {
              const end = mm.index + mm[0].length;
              const prev = found.find((f) => f.tail && f.e <= mm.index && /^\s+$/.test(t.slice(f.e, mm.index)));
              if (prev) push(mm.index, end, t.slice(prev.s, end), t.slice(end).split(/['"`]/)[0].slice(0, 160));
              else push(mm.index, end, mm[0], '');
            }
            // 验证未命中的目录候选再兜一刀（已被 apply 精确链接的会被 overlaps 跳过）
            dirCands.forEach((x) => push(x.s, x.e, x.cand, x.tail));
            cb(links.length ? links : undefined);
          };
          if (!r2.length) { finish(); return; }
          const sess0 = this.sessions.find((x) => x.id === id);
          const cwd0 = (sess0 && (sess0.cwd || sess0.startDir)) || state.cwd || '';
          // 验证结果按 (cwd, cand, tail) 缓存：provideLinks 在鼠标移动时反复触发，别反复打接口
          this._vCache = this._vCache || new Map();
          const need = r2.filter((x) => !this._vCache.has(cwd0 + ' ' + x.cand + ' ' + x.tail));
          const apply = () => {
            r2.forEach((x) => { if (this._vCache.get(cwd0 + ' ' + x.cand + ' ' + x.tail)) push(x.s, x.e, x.cand, x.tail); });
            finish();
          };
          if (!need.length) { apply(); return; }
          apiPost('/api/term-verify', { cwd: cwd0, items: need.map((x) => ({ cand: x.cand, tail: x.tail })) }).then((res) => {
            need.forEach((x, i) => this._vCache.set(cwd0 + ' ' + x.cand + ' ' + x.tail, !!(res.results && res.results[i])));
            if (this._vCache.size > 600) { for (const k of this._vCache.keys()) { this._vCache.delete(k); if (this._vCache.size <= 400) break; } }
            apply();
          }).catch(() => finish()); // 验证不可用：宁可不划线，不要误标
        },
      });
    }
    this.renderTabs();
    return sess;
  },
  async respawn(sess) {
    sess.dead = false;
    sess.xterm.reset(); // 清掉死亡残留，新 shell 提示符不和旧画面叠在一起
    const r = await window.fanboxPty.spawn({ id: sess.id, cwd: sess.startDir || state.cwd, cols: sess.xterm.cols, rows: sess.xterm.rows });
    if (!r.ok) { sess.dead = true; sess.xterm.write('\x1b[31m重开失败：' + (r.error || '') + '\x1b[0m\r\n'); }
    else sess.cwd = r.cwd || sess.startDir;
  },
  activate(id) {
    this.active = id;
    this.sessions.forEach((s) => s.host.classList.toggle('show', s.id === id));
    const cur = this.sessions.find((x) => x.id === id);
    if (cur) cur.unread = false; // 切到该标签即清未读
    this.renderTabs();
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      this.fitActive();
      setTimeout(() => s.xterm.focus(), 0);
      // 延迟刷新标题（避开双击窗口：双击的第二下若撞上 renderTabs 重建会丢 dblclick 事件）
      setTimeout(() => this.refreshCwd(s), 600);
    }
  },
  closeTab(id) {
    const i = this.sessions.findIndex((x) => x.id === id);
    if (i < 0) return;
    const s = this.sessions[i];
    try { window.fanboxPty.kill(id); } catch { /* */ }
    try { s.xterm.dispose(); } catch { /* */ }
    s.host.remove();
    this.sessions.splice(i, 1);
    updateWatches(); // 该终端的项目目录不再需要监听
    if (!this.sessions.length) { this.close(); return; }
    if (this.active === id) this.activate(this.sessions[Math.max(0, i - 1)].id);
    else this.renderTabs();
  },
  fitActive() {
    const s = this.sessions.find((x) => x.id === this.active);
    if (!s || !s.fit) return;
    requestAnimationFrame(() => { try { s.fit.fit(); } catch { /* */ } });
  },
  // WebGL 字形图集保养：大量中文输出会撑满图集触发分页合并，上游 bug 让汉字画成别字碎片
  //（拖拽窗口能复原＝resize 重建了图集）。忙时每 5 分钟、收工时距上次 >60s 主动重建，重画一帧无感。
  // 图集按字体配置在标签间共享，单独清一个标签会让其他标签的字指向已清空的纹理（大面积丢字），
  // 所以全局节流、到点后所有标签同一 tick 一起清：头一个清掉共享纹理，其余只重建自己的模型并重绘
  atlasCare(now, eager) {
    if (!this._atlasAt) { this._atlasAt = now; return; } // 刚启动图集是干净的，先记时间
    if (now - this._atlasAt < (eager ? 60000 : 300000)) return;
    this._atlasAt = now;
    this.sessions.forEach((s) => { try { s.webgl?.clearTextureAtlas(); } catch { /* */ } });
  },
  // 图集压力监视（分页合并的机制级防线）：addon 每开一页新图集就发事件（同一页会被共享它的每个
  // 标签各转发一次，WeakSet 去重后计数≈真实页数）。页数到 12（上限一般 16，顶格才触发出乱码的
  // 分页合并）就整体重建，让合并从机制上没机会发生。定时的 atlasCare 只回收页内空间、减缓页数增长，
  // 但 clearTextureAtlas 页数只增不减（合并出的大页清空后还永久占坑不可写），压不住时得靠这里真重建
  watchAtlas(wg) {
    if (!wg || !wg.onAddTextureAtlasCanvas) return;
    if (!this._atlasSeen) this._atlasSeen = new WeakSet();
    wg.onAddTextureAtlasCanvas((canvas) => {
      if (this._atlasSeen.has(canvas)) return;
      this._atlasSeen.add(canvas);
      this._atlasPages = (this._atlasPages || 0) + 1;
      if (this._atlasPages < 12 || this._atlasRecycling) return;
      this._atlasRecycling = true;
      requestAnimationFrame(() => this.recycleWebgl()); // 事件在绘制途中同步发出，等这帧画完再动手
    });
  },
  // 真重建：所有标签的 WebGL 插件先全部销毁、再全部重装。图集按引用计数存活，
  // 边销毁边重装会让新插件捡回那张退化的旧图集，必须两趟分开走
  recycleWebgl() {
    this._atlasRecycling = false;
    this._atlasPages = 0;
    this._atlasSeen = new WeakSet();
    this._atlasAt = Date.now();
    const Wg = (!window.__noWebgl && window.WebglAddon) ? (window.WebglAddon.WebglAddon || window.WebglAddon) : null;
    const wants = this.sessions.filter((s) => s.webgl);
    wants.forEach((s) => { try { s.webgl.dispose(); } catch { /* */ } s.webgl = null; });
    if (!Wg) return; // 环境没了 WebGL 就顺势落回 DOM renderer
    wants.forEach((s) => {
      try {
        const wg = new Wg();
        wg.onContextLoss(() => { try { wg.dispose(); } catch { /* */ } if (s.webgl === wg) s.webgl = null; });
        s.xterm.loadAddon(wg);
        s.webgl = wg;
        this.watchAtlas(wg);
      } catch { /* 单个失败回退 DOM，不拦其他 */ }
    });
  },
  // 兼容渲染模式：关 WebGL 改用 DOM renderer（无字形图集，从机制上杜绝中文乱码；大输出略慢）。
  // 对所有已开标签立即生效；选择存 localStorage，新标签在创建处同样遵守
  setWebgl(on) {
    try { if (on) localStorage.removeItem('fanbox.noWebgl'); else localStorage.setItem('fanbox.noWebgl', '1'); } catch { /* */ }
    this.sessions.forEach((s) => {
      try {
        if (!on && s.webgl) { s.webgl.dispose(); s.webgl = null; }
        else if (on && !s.webgl && !window.__noWebgl && window.WebglAddon) {
          const Wg = window.WebglAddon.WebglAddon || window.WebglAddon;
          const wg = new Wg();
          wg.onContextLoss(() => { try { wg.dispose(); } catch { /* */ } if (s.webgl === wg) s.webgl = null; });
          s.xterm.loadAddon(wg);
          s.webgl = wg;
          this.watchAtlas(wg);
        }
      } catch { /* 单个会话失败不拦其他 */ }
    });
  },
  // 字体缩放：⌘+/⌘- 调整字号，⌘0 重置为默认 13px
  adjustFont(sess, delta) {
    if (!sess._fontSize) sess._fontSize = 13;
    if (delta === 0) sess._fontSize = 13;
    else sess._fontSize = Math.max(10, Math.min(24, sess._fontSize + delta));
    const xterm = sess.xterm;
    // xterm 没有直接改 fontSize 的 API，通过 options 更新
    xterm.options.fontSize = sess._fontSize;
    // 字号变了要重新 fit，避免内容裁切。顺带清图集防 CJK 残影——图集在同字号标签间共享，
    // 只清自己会让其他标签的字悬空指向已清空的纹理（2.6.1 的教训），必须所有标签同一 tick 一起清
    requestAnimationFrame(() => {
      try { sess.fit.fit(); } catch { /* */ }
      this.sessions.forEach((s) => { try { s.webgl?.clearTextureAtlas?.(); } catch { /* */ } });
    });
    // 通知 PTY 重新获取尺寸（fit 会触发 onResize，已经做了）
  },
  // agent 态势感知：终端有输出→busy；静默 >2.5s→idle；进程退出→dead。
  // 非活动标签产生输出标记未读小点；长任务（busy>4s）完成且窗口失焦/非当前标签时发系统通知。
  markBusy(s) {
    const now = Date.now();
    $('#terminal-panel').classList.remove('term-awaiting'); // 又有动静了，撤掉「轮到你」呼吸
    // 回显过滤：距上次用户输入 <400ms 的输出多半是回显/TUI 重绘，不算 agent 自主干活：
    // 不进入 busy、不推 busyStart；已在 busy 则只续命（agent 干活时排队打字不打断）。
    // 续命只刷新 lastData（推迟评估时机），不刷新 lastReal（任务时长只数自发输出，打字不算工时）
    if (now - (s.lastInput || 0) < 400) { if (s.status === 'busy') s.lastData = now; return; }
    s.lastData = now; s.lastReal = now;
    if (s.status !== 'busy') { s.status = 'busy'; s.busyStart = now; this.renderTabs(); this.roundSnapshot(s); }
    if (s.id !== this.active) { if (!s.unread) { s.unread = true; this.renderTabs(); } }
    this.ensureStatusTick();
  },
  // 回合安全带：agent 开工瞬间给项目静默存档。资格/节流/判重全在服务端，这里只管扔，失败不打扰
  roundSnapshot(s) {
    const dir = s.cwd || s.startDir;
    if (dir) apiPost('/api/snapshot', { path: dir, label: '回合 · ' + (s.title || 'shell') }).catch(() => {});
  },
  // 取缓冲区末尾 n 行纯文本：确认对话框和忙碌页脚都画在底部
  tailText(s, n = 25) {
    try {
      const buf = s.xterm.buffer.active;
      let t = '';
      for (let i = Math.max(0, buf.length - n); i < buf.length; i++) { const ln = buf.getLine(i); if (ln) t += ln.translateToString(true) + '\n'; }
      return t;
    } catch { return ''; }
  },
  // 轮到你了：终端边缘呼吸几秒，余光可感（agent 干完一段、把球踢回给你）
  awaitGlow() {
    const p = $('#terminal-panel');
    if (!p || p.classList.contains('hidden')) return;
    p.classList.add('term-awaiting');
    clearTimeout(this._awaitT);
    this._awaitT = setTimeout(() => p.classList.remove('term-awaiting'), 6500);
  },
  ensureStatusTick() {
    if (this._statusTimer) return;
    this._statusTimer = setInterval(() => {
      const now = Date.now(); let anyBusy = false;
      this.sessions.forEach((s) => {
        if (s.status !== 'busy') return;
        this.atlasCare(now); // 忙满 5 分钟清一次图集，长中文输出中途也能自愈
        const quiet = now - (s.lastData || 0);
        if (quiet <= 2500) { anyBusy = true; return; } // claude/codex 忙碌心跳约 1s 一帧，容差太紧会闪断误报
        const tail = this.tailText(s);
        // 假静默护栏：页脚仍挂着「esc to interrupt」说明 agent 还在跑（失焦降频/网络卡顿），30s 内不判收工
        if (quiet < 30000 && /esc to interrupt/i.test(tail)) { anyBusy = true; return; }
        const dur = (s.lastReal || 0) - (s.busyStart || 0); // 工时只数自发输出：回显续命不算，免得打字把琐碎回显养肥成「真任务」
        s.status = 'idle';
        this.atlasCare(now, true); // 收工间隙兜底再清一次（距上次 >60s 才动手）
        this.renderTabs();
        this.refreshCwd(s); // 干完一段活，标题对齐终端真实目录
        // 阶段性收工不报喜：底部状态行还挂着后台任务（「1 shell, 1 monitor still running」/「· 1 shell ·」），
        // agent 跑完会被自动唤醒接着干——这会儿弹「完成」是误报。圆点照常变空闲，提醒全部按下，等真收工再响
        const foot = this.tailText(s, 8);
        if (/\bstill running\b/i.test(foot) || /·\s*\d+\s+(shells?|monitors?|tasks?|agents?)\b/i.test(foot)) return;
        const ask = dur > 600 && TERM_ASK_RE.test(tail); // 停在审批/确认界面：等你拍板（不设 4s 门槛，审批常来得很快）
        if (ask || dur > 1500) this.awaitGlow();
        if (ask) {
          playChime('ask'); // 非 done → 单音，和「完成」的双音区分开
          if (!document.hasFocus() || s.id !== this.active) this.notify(s, '等待你确认 · ' + (s.title || 'shell'), this.lastReplyExcerpt(s) || (s.title || 'shell') + ' 在等你拍板');
        } else if (dur > 4000) { // 跑了一会儿的真任务完成：文件区涟漪 + 极轻提示音 + 必要时系统通知
          rippleFileArea();
          playChime('done');
          if (!document.hasFocus() || s.id !== this.active) this.notify(s, 'agent 任务完成 · ' + (s.title || 'shell'), this.lastReplyExcerpt(s) || (s.title || 'shell') + ' 已空闲');
        }
      });
      if (!anyBusy) { clearInterval(this._statusTimer); this._statusTimer = null; }
    }, 600);
  },
  // 收工时从缓冲区捞 agent 最后说的话，做通知预览：剥掉 TUI 框线/输入框/页脚状态行，留正文
  lastReplyExcerpt(s, maxLen = 160) {
    const JUNK = /esc to interrupt|\? for shortcuts|for commands|bypass|auto-accept|accept edits|plan mode|shift\+tab|context left|tokens used|still running|·\s*\d+\s+(shells?|monitors?|tasks?|agents?)\b/i;
    const lines = [];
    for (const raw of this.tailText(s, 40).split('\n')) {
      const t = raw.replace(/^[\s│┃]+|[\s│┃]+$/g, '').replace(/^[⏺●◉>]\s+/, '').trim();
      if (!t) continue;
      if (/^[╭╰╮╯├┤─━┄┆┈·•．.…*=_-]+$/.test(t)) continue; // 纯框线/分隔线
      if (JUNK.test(t)) continue;
      lines.push(t);
    }
    const text = lines.slice(-3).join(' ').replace(/\s+/g, ' ').trim();
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  },
  notify(s, title, body) {
    try {
      if (typeof Notification === 'undefined') return;
      const fire = () => {
        const n = new Notification(title, { body });
        // 点通知：app 拉回前台 + 切到对应终端标签——多项目并行时直达要操作的那个环境
        n.onclick = () => {
          try { if (window.fanboxWin) window.fanboxWin.focus(); else window.focus(); } catch { /* */ }
          if (s && this.sessions.includes(s)) { this.open(); this.activate(s.id); }
          try { n.close(); } catch { /* */ }
        };
      };
      if (Notification.permission === 'granted') fire();
      else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { if (p === 'granted') fire(); });
    } catch { /* 通知不可用就算了 */ }
  },
  renderTabs() {
    this.persistTabs(); // 标签的增删/切换/换目录都路过这里，顺手落快照供下次启动还原
    const bar = $('#term-tabs');
    bar.innerHTML = '';
    this.sessions.forEach((s) => {
      const t = document.createElement('div');
      const dotState = s.dead ? 'dead' : (s.status === 'busy' ? 'busy' : 'idle');
      const followed = follow.on && follow.sid === s.id; // 文件跟随正盯着这个 tab
      t.className = 'term-tab' + (s.id === this.active ? ' active' : '') + (s.unread ? ' unread' : '') + (followed ? ' following' : '');
      const dotTitle = s.dead ? '进程已退出' : (s.status === 'busy' ? 'agent 运行中' : '空闲');
      // 终端图标按项目路径染色：同项目同色，和面包屑的配对色点呼应
      const hue = this.hueOf(s.cwd || s.startDir);
      t.title = followed ? '文件跟随正盯着这个终端 · 双击跳到它所在目录' : '双击：文件区跳到该终端所在目录';
      const eye = followed ? `<span class="tab-eye" title="文件跟随盯着它">${ic('eye', 'currentColor', 11)}</span>` : '';
      const zap = s.agentTouch && Date.now() - s.agentTouch < 8000 ? '<span class="tab-zap" title="正被 agent 控制">⚡</span>' : ''; // 被 agent 遥控过闪 8 秒：审计 + 围观
      t.innerHTML = `<span class="tab-dot ${dotState}" title="${dotTitle}"></span>${eye}${zap}${ic('term', `hsl(${hue} 62% 48%)`, 12)}<span>${escapeHtml(s.title)}</span><span class="tab-x" title="关闭">✕</span>`;
      t.onclick = (e) => { if (e.target.classList.contains('tab-x')) { this.closeTab(s.id); return; } this.activate(s.id); };
      t.ondblclick = (e) => { if (e.target.classList.contains('tab-x')) return; this.locateCwd(); };
      bar.appendChild(t);
    });
  },
  // 换主题后 WebGL 图集里缓存的还是旧配色字形，且 CJK 宽字符偶发图集损坏（#37/#45）：清一次图集强制重栅格化。
  // try/catch 兜住 GPU 故障，别让单个 session 的渲染异常连累其它 session 或拖垮渲染进程（#35）。
  retheme() { const th = this.theme(); this.sessions.forEach((s) => { try { s.xterm.options.theme = th; s.webgl?.clearTextureAtlas?.(); } catch { /* */ } }); },
};

// ---------- Agent 用量面板（侧栏常驻，可开合）----------
// Claude Code 是官方限额窗口（5h/周，OAuth 接口）+ 本地 token 统计兜底，Codex 是官方配额快照（来自其会话日志）
const usagePanel = {
  timer: null,
  fmtTok(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
    return String(n);
  },
  fmtReset(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    const sameDay = d.toDateString() === new Date().toDateString();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return (sameDay ? '' : '周' + '日一二三四五六'[d.getDay()] + ' ') + hm + ' 重置';
  },
  ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 2) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 1440) return Math.round(m / 60) + ' 小时前';
    return Math.round(m / 1440) + ' 天前';
  },
  bar(label, pct, extra) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    const danger = v >= 85 ? ' danger' : '';
    return `<div class="usage-row"><span class="usage-label">${label}</span>
      <span class="usage-bar"><i class="${danger.trim()}" style="width:${v}%"></i></span>
      <span class="usage-num${danger}">${v}%</span></div>
      ${extra ? `<div class="usage-sub">${extra}</div>` : ''}`;
  },
  render(d) {
    const box = $('#usage-body');
    if (!d || !d.ok) { box.innerHTML = '<div class="usage-sub">读取失败</div>'; return; }
    let h = '';
    if (d.codex) {
      const c = d.codex;
      h += `<div class="usage-agent">Codex${c.planType ? ` <i class="usage-plan">${escapeHtml(c.planType)}</i>` : ''}</div>`;
      if (c.primary) h += this.bar('5h 窗口', c.primary.usedPercent, c.primary.stale ? '窗口已重置，跑一次 Codex 才有新数' : '');
      if (c.secondary) h += this.bar('周配额', c.secondary.usedPercent, c.secondary.stale ? '窗口已重置，跑一次 Codex 才有新数' : this.fmtReset(c.secondary.resetsAt));
      h += `<div class="usage-sub">快照：${this.ago(c.capturedAt)}的 Codex 会话</div>`;
    }
    if (d.claude) {
      const c = d.claude;
      h += `<div class="usage-agent">Claude Code</div>`;
      if (c.official) {
        // 官方限额窗口（和 Claude Code /usage 面板同源）：5h 滚动窗口 + 周配额，优先展示
        if (c.official.fiveHour) h += this.bar('5h 窗口', c.official.fiveHour.usedPercent, this.fmtReset(c.official.fiveHour.resetsAt));
        if (c.official.sevenDay) h += this.bar('周配额', c.official.sevenDay.usedPercent, this.fmtReset(c.official.sevenDay.resetsAt));
      }
      if (c.last5h) {
        // 本地 token 统计照常保留（拿不到官方数据时就只剩这块）
        h += `<div class="usage-trio">
          <span><b>${this.fmtTok(c.last5h.total)}</b>近5h</span>
          <span><b>${this.fmtTok(c.today.total)}</b>今日</span>
          <span><b>${this.fmtTok(c.week.total)}</b>本周</span>
        </div>
        <div class="usage-sub">token 总量 · 本地会话日志统计</div>`;
      }
    }
    // pi / Hermes：与 Claude 同款三桶本地统计（无官方限额接口，只报 token 量）
    for (const [key, label] of [['pi', 'pi'], ['hermes', 'Hermes Agent']]) {
      const u = d[key];
      if (!u || !u.last5h) continue;
      h += `<div class="usage-agent">${label}</div>
        <div class="usage-trio">
          <span><b>${this.fmtTok(u.last5h.total)}</b>近5h</span>
          <span><b>${this.fmtTok(u.today.total)}</b>今日</span>
          <span><b>${this.fmtTok(u.week.total)}</b>本周</span>
        </div>
        <div class="usage-sub">token 总量 · 本地会话日志统计</div>`;
    }
    if (!d.codex && !d.claude && !d.pi && !d.hermes) h = '<div class="usage-sub">没找到 Claude Code / Codex / pi / Hermes 的本机会话记录</div>';
    box.innerHTML = h;
  },
  async refresh() {
    try { this.render(await api('/api/agent-usage')); }
    catch { this.render(null); }
  },
  open() { return localStorage.getItem('fb_usage_open') === '1'; },
  apply() {
    const on = this.open();
    $('#usage-body').classList.toggle('hidden', !on);
    $('#usage-arrow').textContent = on ? '▾' : '▸';
    clearInterval(this.timer); this.timer = null;
    if (on) { this.refresh(); this.timer = setInterval(() => this.refresh(), 60000); }
  },
  bind() {
    $('#usage-toggle').onclick = () => {
      localStorage.setItem('fb_usage_open', this.open() ? '0' : '1');
      this.apply();
    };
    this.apply();
  },
};

// ---------- Skills 透视（主区全屏视图）----------
const skillsView = {
  data: null, filter: 'all', sort: 'hits', open: new Set(),
  async show() {
    state.skillsMode = true; state.recentMode = false; state.cursor = -1;
    renderBreadcrumb();
    $('#file-area').innerHTML = '<div class="cmdk-loading">扫描本机 skills…</div>';
    try { this.data = await apiPost('/api/skills/refresh', { cwd: state.cwd }); } catch { $('#file-area').innerHTML = '<div class="nav-empty">扫描失败</div>'; return; }
    this.render();
  },
  async reload() {
    try { this.data = await api('/api/skills'); if (state.skillsMode) this.render(); } catch { /* */ }
  },
  srcTag(it) {
    const cls = { claude: '', codex: ' codex', agents: ' codex', plugin: ' plugin', project: ' proj' }[it.source] || '';
    return `<span class="sk-src${cls}">${escapeHtml(it.label)}</span>`;
  },
  ago(t) {
    if (!t) return '—';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return m < 2 ? '刚刚' : m + ' 分钟前';
    if (m < 1440) return Math.round(m / 60) + ' 小时前';
    return Math.round(m / 1440) + ' 天前';
  },
  rows() {
    let arr = (this.data.items || []).slice();
    const f = this.filter;
    if (f === 'dup') arr = arr.filter((x) => x.copies);
    else if (f === 'bad') arr = arr.filter((x) => x.issues.length);
    else if (f === 'project') arr = arr.filter((x) => x.source === 'project');
    else if (f === 'codex') arr = arr.filter((x) => x.source === 'codex' || x.source === 'agents');
    else if (f !== 'all') arr = arr.filter((x) => x.source === f);
    const ho = (x) => (x.residue || x.issues.length ? 0 : x.disabled ? 1 : 2);
    if (this.sort === 'hits') arr.sort((a, b) => b.hits - a.hits || b.last - a.last || a.name.localeCompare(b.name));
    if (this.sort === 'recent') arr.sort((a, b) => b.last - a.last || b.hits - a.hits);
    if (this.sort === 'health') arr.sort((a, b) => ho(a) - ho(b) || b.hits - a.hits);
    if (this.sort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  },
  render() {
    const o = this.data.overview;
    const items = this.data.items || [];
    const cnt = (fn) => items.filter(fn).length;
    const over = o.budgetChars > o.budgetLimit;
    const ratio = (o.budgetChars / o.budgetLimit).toFixed(1);
    let h = `<div class="sk-wrap">
      <div class="sk-stats">
        <div class="sk-stat"><div class="sk-num">${o.unique}<small>/${o.total}</small></div><div class="sk-lbl">全部 skills</div><div class="sk-note">唯一 / 含跨端副本</div></div>
        <div class="sk-stat"><div class="sk-num good">${o.active}</div><div class="sk-lbl">45 天内活跃</div><div class="sk-note">共 ${o.totalHits} 次触发</div></div>
        <div class="sk-stat dust"><div class="sk-num">${o.dust}</div><div class="sk-lbl">在吃灰</div><div class="sk-note">45 天零触发</div></div>
        <div class="sk-stat ${o.issues ? 'alert' : ''}"><div class="sk-num">${o.issues}</div><div class="sk-lbl">有问题</div><div class="sk-note">截断 / 缺 frontmatter / 残留</div></div>
        <div class="sk-budget">
          <div class="sk-lbl" style="display:flex;justify-content:space-between"><span>Claude 常驻预算（描述总量）</span>${over ? `<b class="bad-t">≈超限 ${ratio}×</b>` : ''}</div>
          <div class="sk-bar"><i style="width:${Math.min(100, o.budgetChars / o.budgetLimit * 41)}%"></i><em></em></div>
          <div class="sk-cap"><span>${o.budgetChars.toLocaleString()} 字符 / 预算约 ${o.budgetLimit.toLocaleString()}（估算）</span><span>${over ? '超出部分被静默丢弃，对应 skill 不会触发' : ''}</span></div>
        </div>
      </div>
      <div class="sk-tools">
        <div class="sk-chips">
          ${[['all', '全部', items.length],
             ['claude', 'Claude 全局', cnt((x) => x.source === 'claude')],
             ['project', '项目', cnt((x) => x.source === 'project')],
             ['plugin', '插件', cnt((x) => x.source === 'plugin')],
             ['codex', 'Codex', cnt((x) => x.source === 'codex' || x.source === 'agents')],
             ['dup', '跨端重复', cnt((x) => x.copies)],
             ['bad', '仅看问题', o.issues]]
            .map(([k, lbl, n]) => `<button class="sk-chip ${this.filter === k ? 'on' : ''}" data-f="${k}">${lbl} <i>${n}</i></button>`).join('')}
        </div>
        <select class="sk-sort" id="sk-sort">
          <option value="hits" ${this.sort === 'hits' ? 'selected' : ''}>按触发次数</option>
          <option value="recent" ${this.sort === 'recent' ? 'selected' : ''}>按最后触发</option>
          <option value="health" ${this.sort === 'health' ? 'selected' : ''}>按健康度</option>
          <option value="name" ${this.sort === 'name' ? 'selected' : ''}>按名称</option>
        </select>
      </div>
      <div class="sk-thead"><span></span><span>Skill</span><span>来源</span><span class="r">45 天触发</span><span class="r">最后触发</span><span class="r">启用</span><span></span></div>`;
    let dustMarked = false;
    this.rows().forEach((it) => {
      if (this.sort === 'hits' && this.filter === 'all' && !dustMarked && it.hits === 0) {
        h += `<div class="sk-mark">以下 ${o.dust} 个 45 天零触发——启用中的描述仍在每次会话占用预算</div>`;
        dustMarked = true;
      }
      const key = it.dir;
      const dot = it.issues.length ? (it.residue || it.issues.some((s) => s.includes('缺')) ? 'bad' : 'warn') : 'ok';
      h += `<div class="sk-row ${this.open.has(key) ? 'expanded' : ''} ${it.disabled ? 'off' : ''}" data-dir="${escapeHtml(key)}" draggable="true">
        <span class="sk-dot ${dot}"></span>
        <div class="sk-name">
          <div class="nm">${escapeHtml(it.name)}${it.copies ? ` <i class="sk-dup">${it.copies.length} 处副本</i>` : ''}${it.disabled ? ' <i class="sk-offtag">已停用</i>' : ''}</div>
          <div class="ds">${escapeHtml(it.issues[0] || it.desc || '')}</div>
        </div>
        ${this.srcTag(it)}
        <div class="sk-hits ${it.hits ? '' : 'zero'}">${it.hits || '· 0 ·'}</div>
        <div class="sk-last">${this.ago(it.last)}</div>
        ${it.residue
          ? '<div class="sk-last r">残留</div>'
          : `<label class="sk-switch ${it.disabled ? '' : 'on'}" data-act="toggle" title="${it.disabled ? '启用（移回 skills 目录）' : '停用（移入 _disabled/，不删文件，立即对模型不可见）'}"><i></i></label>`}
        <span class="sk-chev">▸</span>
      </div>`;
      if (this.open.has(key)) {
        const cut = this.data.overview.descCut;
        h += `<div class="sk-detail">
          <div>
            <div class="fd">${escapeHtml(it.desc || '（无 description）')}${it.descLen > 240 ? '…' : ''}</div>
            ${it.descLen > cut ? `<div class="fd-cut">⚠ description 共 ${it.descLen.toLocaleString()} 字符，第 ${cut.toLocaleString()} 字符之后模型看不见——靠后段触发词的场景不会触发</div>` : ''}
            ${it.issues.map((s) => `<div class="fd-cut">⚠ ${escapeHtml(s)}</div>`).join('')}
            <div class="fd-acts">
              ${it.residue ? '' : '<button data-act="invoke" class="primary">▶ 终端调用</button>'}
              <button data-act="reveal">在文件区显示</button>
              ${it.residue ? '' : '<button data-act="edit">编辑 SKILL.md</button>'}
              <button data-act="trash" class="danger">移到废纸篓</button>
            </div>
          </div>
          <dl class="fd-meta">
            <dt>描述体积</dt><dd>${it.descLen.toLocaleString()} 字符${it.descLen > cut ? ' · 超截断线' : ''}</dd>
            <dt>路径</dt><dd class="mono">${escapeHtml(tilde(it.dir))}</dd>
            ${it.copies ? `<dt>全部副本</dt><dd class="mono">${it.copies.map(escapeHtml).join('<br>')}</dd>` : ''}
          </dl>
        </div>`;
      }
    });
    h += '</div>';
    const area = $('#file-area');
    area.innerHTML = h;
    this.bind(area);
  },
  bind(area) {
    area.querySelector('.sk-chips').onclick = (e) => {
      const c = e.target.closest('.sk-chip'); if (!c) return;
      this.filter = c.dataset.f; this.render();
    };
    area.querySelector('#sk-sort').onchange = (e) => { this.sort = e.target.value; this.render(); };
    area.querySelector('.sk-wrap').addEventListener('click', async (e) => {
      const row = e.target.closest('.sk-row');
      const detail = e.target.closest('.sk-detail');
      const act = e.target.closest('[data-act]');
      const dir = row ? row.dataset.dir : detail ? detail.previousElementSibling.dataset.dir : null;
      if (!dir) return;
      const it = this.data.items.find((x) => x.dir === dir);
      if (act && it) {
        e.stopPropagation();
        if (act.dataset.act === 'toggle') {
          const r = await apiPost('/api/skills/toggle', { dir, enable: it.disabled });
          if (r.ok) { toast(it.disabled ? '已启用 ' + it.name : '已停用 ' + it.name + '（文件还在，随时可启用）'); this.reload(); }
          else toast('操作失败：' + (r.error || ''), true);
        } else if (act.dataset.act === 'invoke') {
          invokeSkillInTerm(it.name);
        } else if (act.dataset.act === 'reveal') {
          navigate(dirOf(it.dir));
        } else if (act.dataset.act === 'edit') {
          await navigate(it.dir);
          const e2 = state.entries.find((x) => x.name === 'SKILL.md');
          if (e2) { state.selected = e2.path; openPreview(e2); renderFiles(); }
        } else if (act.dataset.act === 'trash') {
          const ok = await confirmDialog(`把「${it.name}」移到废纸篓？（系统废纸篓里随时可恢复）`);
          if (!ok) return;
          const r = await apiPost('/api/skills/trash', { dir });
          if (r.ok) { toast('已移到废纸篓'); this.open.delete(dir); this.reload(); }
          else toast('删除失败：' + (r.error || ''), true);
        }
        return;
      }
      if (row) { this.open.has(dir) ? this.open.delete(dir) : this.open.add(dir); this.render(); }
    });
    // 拖 skill 行 → 终端：带 skill 名专用类型；text/plain 给外部目标
    area.querySelectorAll('.sk-row').forEach((r) => {
      r.addEventListener('dragstart', (ev) => {
        const it = this.data.items.find((x) => x.dir === r.dataset.dir);
        if (!it) return;
        ev.dataTransfer.setData('application/x-fanbox-skill', it.name);
        ev.dataTransfer.setData('text/plain', '/' + it.name);
        ev.dataTransfer.effectAllowed = 'copy';
      });
    });
  },
};

// 把 skill 注入当前终端：claude 会话用 /name，codex 会话用 $name；裸 shell 提示先启动 agent
async function invokeSkillInTerm(name) {
  if (typeof term === 'undefined' || !term.available()) { toast('需要桌面版的内嵌终端', true); return; }
  if ($('#terminal-panel').classList.contains('hidden')) term.open();
  const s = term.sessions.find((x) => x.id === term.active);
  if (!s || s.dead) { toast('先开一个终端并启动 agent', true); return; }
  let prefix = '/';
  try {
    const r = await window.fanboxPty.proc(s.id);
    const pn = String((r && r.proc) || '').split('/').pop().replace(/^-/, '').toLowerCase();
    if (pn.includes('codex')) prefix = '$';
    else if (['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh', 'nu'].includes(pn)) {
      toast('终端里还没启动 agent——先点 Claude / Codex 启动按钮', true);
      s.xterm.focus();
      return;
    }
  } catch { /* 判断不了就按 claude 的 / 语法 */ }
  term.input(s.id, prefix + name + ' ');
  s.xterm.focus();
  toast(`已注入 ${prefix}${name}，接着补一句话回车`);
}

// ---------- Monaco 编辑器（本地 vendor，离线可用；加载失败回退 textarea）----------
const mona = {
  editor: null, _p: null,
  themeFor: { terminal: 'fb-dark', warm: 'fb-paper', editorial: 'fb-editorial' },
  themeName() { return this.themeFor[state.theme] || 'fb-dark'; },
  // 散文类（md/txt/字幕）默认软换行，代码不换行
  wraps(ex) { return ['md', 'markdown', 'txt', 'log', 'srt', 'vtt', 'ass'].includes(ex); },
  lang(ex) {
    const m = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      json: 'json', json5: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', vue: 'html',
      css: 'css', scss: 'scss', less: 'less', py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php',
      c: 'c', cpp: 'cpp', cc: 'cpp', h: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'shell', bash: 'shell', zsh: 'shell',
      yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', xml: 'xml', sql: 'sql', swift: 'swift', lua: 'lua', kt: 'kotlin', dart: 'dart', r: 'r',
    };
    return m[ex] || 'plaintext';
  },
  load() {
    if (this._p) return this._p;
    if (window.__noMonaco) return Promise.resolve(null);
    this._p = new Promise((resolve) => {
      if (window.monaco) { resolve(window.monaco); return; }
      // 语言服务 worker 走 blob 代理（同源），无 worker 也能用基础高亮
      window.MonacoEnvironment = {
        getWorkerUrl() {
          return URL.createObjectURL(new Blob([
            `self.MonacoEnvironment={baseUrl:'${location.origin}/vendor/monaco/'};importScripts('${location.origin}/vendor/monaco/vs/base/worker/workerMain.js');`,
          ], { type: 'text/javascript' }));
        },
      };
      const s = document.createElement('script');
      s.src = '/vendor/monaco/vs/loader.js';
      s.onload = () => {
        try {
          window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
          window.require(['vs/editor/editor.main'], () => { this.defineThemes(window.monaco); resolve(window.monaco); }, () => resolve(null));
        } catch { resolve(null); }
      };
      s.onerror = () => { window.__noMonaco = 1; resolve(null); };
      document.head.appendChild(s);
    });
    return this._p;
  },
  // 三皮肤各配一套编辑器配色，和文件区、终端区同呼吸
  defineThemes(m) {
    m.editor.defineTheme('fb-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#0b0c0a', 'editor.foreground': '#d6dac9', 'editorLineNumber.foreground': '#4a4d42', 'editorCursor.foreground': '#cdf24b', 'editor.selectionBackground': '#cdf24b33', 'editor.lineHighlightBackground': '#ffffff08' } });
    m.editor.defineTheme('fb-paper', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ece2d2', 'editor.foreground': '#4a3f30', 'editorLineNumber.foreground': '#b3a589', 'editorCursor.foreground': '#cc785c', 'editor.selectionBackground': '#cc785c33', 'editor.lineHighlightBackground': '#00000008' } });
    m.editor.defineTheme('fb-editorial', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#eae5d8', 'editor.foreground': '#1a1a1a', 'editorLineNumber.foreground': '#9a958a', 'editorCursor.foreground': '#ff433d', 'editor.selectionBackground': '#ff433d22', 'editor.lineHighlightBackground': '#00000008' } });
  },
  retheme() { if (this.editor && window.monaco) window.monaco.editor.setTheme(this.themeName()); },
  // 只读并排 diff：HEAD 版本 vs 工作区当前内容，复用 editor 槽位让 disposeIfAny 统一回收
  openDiff(host, original, modified, ex) {
    const monaco = window.monaco;
    const lang = this.lang(ex);
    const orig = monaco.editor.createModel(original || '', lang);
    const mod = monaco.editor.createModel(modified || '', lang);
    const de = monaco.editor.createDiffEditor(host, {
      theme: this.themeName(), readOnly: true, automaticLayout: true, renderSideBySide: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 12.5, lineHeight: 1.6, minimap: { enabled: false }, scrollBeyondLastLine: false,
    });
    de.setModel({ original: orig, modified: mod });
    this._models = [orig, mod];
    this.editor = de;
    return de;
  },
  disposeIfAny() {
    if (this.editor) { try { this.editor.dispose(); } catch { /* */ } this.editor = null; }
    if (this._models) { this._models.forEach((m) => { try { m.dispose(); } catch { /* */ } }); this._models = null; }
  },
};

// ---------- Milkdown Crepe（Notion 式所见即所得 Markdown；本地 vendor，离线可用）----------
const crepe = {
  editor: null, _p: null,
  load() {
    if (this._p) return this._p;
    if (window.__noCrepe) return Promise.resolve(null);
    this._p = new Promise((resolve) => {
      if (window.FanboxCrepe) { resolve(window.FanboxCrepe); return; }
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/vendor/milkdown/milkdown.css';
      document.head.appendChild(link);
      const s = document.createElement('script'); s.src = '/vendor/milkdown/milkdown.js';
      s.onload = () => resolve(window.FanboxCrepe || null);
      s.onerror = () => { window.__noCrepe = 1; resolve(null); };
      document.head.appendChild(s);
    });
    return this._p;
  },
  disposeIfAny() { if (this.editor) { try { this.editor.destroy(); } catch { /* */ } this.editor = null; } },
};

// ---------- 变更收件箱（本会话 agent 改了哪些文件，可回看 / 看 diff）----------
// 构建/依赖目录 + macOS 系统噪声目录（Library/缓存/废纸篓 后台无时无刻在写，不是 agent 干活，必须过滤）
const CHANGE_IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.venv', 'venv', '__pycache__', '.DS_Store', 'target', '.turbo', '.expo', 'Library', 'Caches', '.Trash', 'CloudStorage', '.cocoapods', 'DerivedData']);
// 这次变更是不是该被忽略的系统/构建噪声（高亮、刷新、收件箱共用一套判断）
function isNoisyChange(filename) {
  const segs = String(filename).split('/');
  // 隐藏文件/目录一律算噪声：agent 写 .git、各种 .config 时用户什么都没的看（.DS_Store/.com.apple. 也被这条覆盖）
  if (segs.some((s) => CHANGE_IGNORE.has(s) || s.startsWith('.'))) return true;
  const name = segs[segs.length - 1];
  return !name || name.endsWith('~') || name.endsWith('.swp')
    || /\.(tmp|part|crdownload|lock)(\.|$)|-(journal|shm|wal)$/i.test(name); // .tmp 可能在中段：原子写 foo.swift.tmp.<pid>.<hex>，sqlite 等后台 App 的临时 sidecar
}
function recordChange(dir, filename) {
  if (isNoisyChange(filename)) return; // 过滤构建/依赖/系统噪声
  const segs = filename.split('/');
  const name = segs[segs.length - 1];
  const full = dir.replace(/\/$/, '') + '/' + filename;
  const now = Date.now();
  state.changeTimeline.push({ path: full, name, ts: now }); // 每次写入都记一笔，供会话回放
  if (state.changeTimeline.length > 3000) state.changeTimeline.shift();
  const existing = state.changeLog.find((c) => c.path === full);
  if (existing) { existing.ts = now; existing.count++; }
  else state.changeLog.unshift({ path: full, name, dir, ts: now, count: 1 });
  // 最新置顶；已存在的移到队首
  state.changeLog.sort((a, b) => b.ts - a.ts);
  if (state.changeLog.length > 100) state.changeLog.length = 100;
  renderChangesBadge();
}
function renderChangesBadge() {
  const b = $('#changes-badge'); if (!b) return;
  b.classList.toggle('hidden', state.changeLog.length === 0);
}
function fmtClock(ms) { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function toggleChangesPanel() {
  const existing = $('#changes-pop');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.id = 'changes-pop';
  pop.className = 'changes-pop';
  if (!state.changeLog.length) {
    pop.innerHTML = '<div class="cp-head">本会话变更</div><div class="cp-empty">还没有捕捉到文件变更。<br>跑起 agent，它改的文件会实时出现在这里。</div>';
  } else {
    const rows = state.changeLog.slice(0, 60).map((c) => {
      const inRepoHint = '';
      return `<div class="cp-row" data-path="${escapeHtml(c.path)}">
        <span class="cp-name">${escapeHtml(c.name)}${c.count > 1 ? ` <em>×${c.count}</em>` : ''}</span>
        <span class="cp-dir">${escapeHtml(c.dir.replace(state.home, '~'))}</span>
        <span class="cp-time">${fmtClock(c.ts)}</span>
      </div>`;
    }).join('');
    pop.innerHTML = `<div class="cp-head">本会话变更 · ${state.changeLog.length}<span class="cp-head-btns"><button id="cp-replay" class="ghost-btn">▶ 回放</button><button id="cp-clear" class="ghost-btn">清空</button></span></div><div class="cp-list">${rows}</div>`;
  }
  document.body.appendChild(pop);
  const btn = $('#btn-changes'); const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.right = (window.innerWidth - r.right) + 'px';
  const clear = $('#cp-clear'); if (clear) clear.onclick = (ev) => { ev.stopPropagation(); state.changeLog = []; state.changeTimeline = []; renderChangesBadge(); pop.remove(); };
  const rep = $('#cp-replay'); if (rep) rep.onclick = (ev) => { ev.stopPropagation(); pop.remove(); openReplay(); };
  pop.querySelectorAll('.cp-row').forEach((row) => {
    row.onclick = async () => {
      const p = row.dataset.path;
      pop.remove();
      await navigate(dirOf(p));
      const e = state.entries.find((x) => x.path === p) || { path: p, name: baseOf(p), kind: kindFromName(p), isDir: false };
      applySelection(p); openPreview(e); recordRecent(p);
    };
  });
  // 点其它地方关闭
  setTimeout(() => {
    const close = (ev) => { if (!ev.target.closest('#changes-pop') && !ev.target.closest('#btn-changes')) { pop.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 0);
}
// WOW2 会话回放：像刷视频一样拖时间轴，重现这段时间 agent 一步步改了哪些文件
function openReplay() {
  const tl = state.changeTimeline.slice();
  if (tl.length < 2) { toast('变更太少，先让 agent 多改几下再回放', true); return; }
  const t0 = tl[0].ts, t1 = tl[tl.length - 1].ts;
  const span = Math.max(1000, t1 - t0);
  const ov = document.createElement('div');
  ov.className = 'replay-ov';
  ov.innerHTML =
    `<div class="replay-panel">
      <div class="replay-head"><span>会话回放 · ${tl.length} 次写入 · 跨 ${fmtDur(span)}</span><button class="replay-close ghost-btn">关闭 (Esc)</button></div>
      <div class="replay-now"><span class="rn-label">此刻 agent 正在改</span><span class="rn-file" id="replay-now">—</span></div>
      <div class="replay-track" id="replay-track"><div class="replay-fill" id="replay-fill"></div><div class="replay-playhead" id="replay-playhead"></div></div>
      <div class="replay-ctl"><button id="replay-play" class="primary">▶ 播放</button><input type="range" id="replay-range" min="0" max="1000" value="1000"><span id="replay-count" class="replay-count"></span></div>
      <div class="replay-list" id="replay-list"></div>
    </div>`;
  document.body.appendChild(ov);
  const track = ov.querySelector('#replay-track');
  tl.forEach((e) => { const t = document.createElement('i'); t.className = 'replay-tick'; t.style.left = ((e.ts - t0) / span * 100) + '%'; track.appendChild(t); });
  const range = ov.querySelector('#replay-range');
  const playBtn = ov.querySelector('#replay-play');
  let raf = null, playing = false, startWall = 0, startFrac = 0;
  const DURATION = Math.min(20000, Math.max(6000, span / 3)); // 把真实时长压缩到 6–20 秒
  const render = (frac) => {
    const at = t0 + span * frac;
    let lastIdx = -1;
    for (let i = 0; i < tl.length; i++) { if (tl[i].ts <= at) lastIdx = i; else break; }
    const done = lastIdx + 1;
    ov.querySelector('#replay-fill').style.width = (frac * 100) + '%';
    ov.querySelector('#replay-playhead').style.left = (frac * 100) + '%';
    ov.querySelector('#replay-now').textContent = lastIdx >= 0 ? tl[lastIdx].name : '—';
    ov.querySelector('#replay-count').textContent = `${done}/${tl.length}`;
    const recent = tl.slice(Math.max(0, lastIdx - 5), lastIdx + 1).reverse();
    ov.querySelector('#replay-list').innerHTML = recent.map((e, i) => `<div class="rl-row${i === 0 ? ' rl-now' : ''}"><span>${escapeHtml(e.name)}</span><span class="rl-t">${fmtClock(e.ts)}</span></div>`).join('');
  };
  const stop = () => { playing = false; if (raf) cancelAnimationFrame(raf); raf = null; playBtn.textContent = '▶ 播放'; };
  const step = () => {
    const elapsed = perfNow() - startWall;
    let frac = startFrac + elapsed / DURATION;
    if (frac >= 1) { frac = 1; render(frac); range.value = 1000; stop(); playBtn.textContent = '↻ 重播'; return; }
    range.value = String(Math.round(frac * 1000));
    render(frac);
    raf = requestAnimationFrame(step);
  };
  playBtn.onclick = () => {
    if (playing) { stop(); return; }
    let frac = Number(range.value) / 1000; if (frac >= 1) frac = 0;
    startFrac = frac; startWall = perfNow(); playing = true; playBtn.textContent = '⏸ 暂停';
    raf = requestAnimationFrame(step);
  };
  range.oninput = () => { stop(); render(Number(range.value) / 1000); };
  const close = () => { stop(); ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.querySelector('.replay-close').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  render(1); // 默认停在最终态
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.round(s / 60);
  return m < 60 ? m + ' 分钟' : (m / 60).toFixed(1) + ' 小时';
}
function perfNow() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
// 从文件名粗判类型（变更项可能不在当前 entries 里）
function kindFromName(p) {
  const e = (p.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif', 'tiff', 'tif'].includes(e)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(e)) return 'video';
  if (e === 'pdf') return 'pdf';
  return 'text';
}

// ---------- 文件跟随（agent 改哪个文件，文件区 + 预览就跟到哪）----------
// 代码文件实时滚动到刚写入的行并高亮；html 边写边出实时网页（双缓冲换页不白闪）；
// md 边写边渲染。任何手动浏览/编辑 = 接管，跟随立即自动停，想跟再点按钮。
const follow = {
  on: false,
  sid: null,         // 开启时绑定的终端会话 id——只跟这个 agent 项目目录里的写入
  label: '',         // 绑定终端的项目名，给 UI 显示「在跟哪个 agent」
  path: null,        // 正在跟随的文件（绝对路径）
  lastContent: null, // 上次渲染的文本内容，用于定位本次改动行
  pendingPath: null, // 节流窗口内最新的待切换目标
  navving: false,    // 跟随自己发起的 navigate，不触发「手动接管即停」
  swapping: false,   // html 双缓冲换页进行中
  swapDirty: false,  // 换页期间又来了新写入，换完补刷一次
  timers: {},
};
const isHtmlName = (n) => /\.(html?|xhtml)$/i.test(String(n || ''));
// 「产物」= agent 编译/打包出来的东西，不是写给人实时看的源码：二进制、库、压缩包、安装包。
// 跟随到这些时不抢实时渲染，改成一张干净的产物卡片（而不是死板的「无法预览」）。
const ARTIFACT_EXT = new Set(['app', 'dylib', 'so', 'o', 'a', 'node', 'wasm', 'bin', 'exe', 'dll', 'class', 'pyc', 'pyo',
  'dmg', 'pkg', 'deb', 'rpm', 'msi', 'framework', 'jar', 'war', 'ipa', 'apk', 'lib', 'obj', 'zip', 'tar', 'gz', 'tgz',
  'bz2', 'xz', '7z', 'rar', 'iso', 'bundle', 'xcarchive']);
// 无扩展名但其实是文本、值得跟的常见配置/构建文件（白名单外的无扩展名一律按二进制产物处理）
const NOEXT_TEXT = new Set(['Makefile', 'Dockerfile', 'LICENSE', 'README', 'CHANGELOG', 'Procfile', 'Gemfile',
  'Rakefile', 'Brewfile', 'Caddyfile', 'Justfile', 'Vagrantfile', 'Jenkinsfile']);
function isFollowArtifact(name) {
  const base = baseOf(String(name || ''));
  const segs = String(name).split('/');
  if (segs.some((s) => /\.(app|framework|xcarchive|bundle)$/i.test(s))) return true; // .app 等「包」内部的一切都算产物
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return !NOEXT_TEXT.has(base); // 无扩展名：白名单外当二进制（编译出的可执行多半没扩展名）
  return ARTIFACT_EXT.has(base.slice(dot + 1).toLowerCase());
}
function setFileFollow(on, offMsg) {
  if (follow.on === on) return;
  // 开启：把跟随死死锚定到一个活着的终端 tab——只盯这个 agent，别的 tab 一律不串。
  // 桌面有终端却没有活动 tab 时直接拒绝（否则退化成「全文件系统跟随」，正是要根治的乱源）。
  if (on && typeof term !== 'undefined' && term.available()) {
    const sid = term.sessions.some((x) => x.id === term.active) ? term.active : null;
    if (!sid) { toast('先点开一个终端 tab，跟随才知道盯哪个 agent', true); $('#file-follow')?.classList.remove('on'); return; }
    follow.sid = sid;
    const s = term.sessions.find((x) => x.id === sid);
    if (s) term.refreshCwd(s, true).catch(() => {}); // 立刻校准 cwd，scope 从第一笔就准（不靠回车后的延迟轮询）
    follow.label = s ? (baseOf(s.cwd || s.startDir || '') || s.title || '') : '';
  } else {
    follow.sid = null; follow.label = ''; // 浏览器版无终端：维持旧口径（全跟）
  }
  follow.on = on;
  $('#file-follow')?.classList.toggle('on', on);
  clearTimeout(follow.timers.sw); clearTimeout(follow.timers.rd);
  stopFollowNarration(); // 清掉上一轮旁白轮询（interval 不能靠下面的 timers={} 回收）
  follow.timers = {};
  follow.path = null; follow.pendingPath = null; follow.lastContent = null;
  follow.swapping = false; follow.swapDirty = false;
  if (typeof term !== 'undefined') term.renderTabs(); // 给绑定的 tab 标上/撤掉「跟随中」标记
  if (!on) $('#preview-title')?.querySelector('.live-badge')?.remove(); // 留住最后画面，只摘掉「跟随中」
  toast(on ? (follow.label ? `文件跟随已开 · 盯着「${follow.label}」这个终端` : '文件跟随已开：agent 改哪个文件就看哪个') : (offMsg || '文件跟随已停'));
  // 一开就有得看：5 分钟内有过范围内的变更就直接跟上，不用干等 agent 下一笔
  if (on) {
    startFollowNarration(); // 底部过程旁白：实时说 agent 在干嘛
    const recent = state.changeLog.find((c) => Date.now() - c.ts < 300000 && inFollowScope(c.path));
    if (recent) followSwitch(recent.path);
  }
}
// 跟随范围 = 绑定终端「现在」所在的项目目录（cwd 随 agent cd 走）；没绑终端则保持旧口径全跟
function followScopeRoot() {
  if (!follow.sid || typeof term === 'undefined') return null;
  const s = term.sessions.find((x) => x.id === follow.sid);
  if (!s) return null;
  return (s.cwd || s.startDir || '').replace(/\/$/, '') || null;
}
function inFollowScope(full) {
  if (!follow.sid) return typeof term === 'undefined' || !term.available(); // 只有无终端(浏览器)才全跟；桌面没绑=不跟
  const root = followScopeRoot();
  if (!root) return false;
  return full === root || full.startsWith(root + '/');
}
// 归属硬化：文件事件本身不带「谁写的」，靠「绑定 tab 此刻在不在干活」消歧。
// 别的 tab 在重叠目录里写东西时，绑定 tab 多半是空闲的，于是这笔不会被误当成它的产出。
function boundAgentActive() {
  if (!follow.sid || typeof term === 'undefined') return true; // 没绑(浏览器降级)不设此关
  const s = term.sessions.find((x) => x.id === follow.sid);
  if (!s) return false;
  return s.status === 'busy' || (Date.now() - (s.lastData || 0) < 8000);
}
// 看头优先级：html/md 这种「写给人看的」> 代码 > 其它（图片/数据）> 产物（二进制/压缩包，最不该抢屏）
const followPrio = (p) => isFollowArtifact(p) ? 0 : ((isHtmlName(p) || isMdName(p)) ? 3 : (kindFromName(p) === 'text' ? 2 : 1));
// 变更事件入口（已过噪声/自打开过滤）：同一文件继续写 → 只刷视图；换了文件 → 节流切目标
function followChange(dir, sub) {
  if (!follow.on) return;
  // 绑定的终端 tab 被关掉：跟随失去对象，全部动作就地停
  if (follow.sid && typeof term !== 'undefined' && !term.sessions.some((x) => x.id === follow.sid)) {
    setFileFollow(false, '绑定的终端已关闭，文件跟随已停');
    return;
  }
  const full = dir.replace(/\/$/, '') + '/' + sub;
  if (!inFollowScope(full)) return; // 别的项目/别的 App 写的文件，不归这次跟随管
  if (!boundAgentActive()) return;  // 绑定的 agent 此刻没在干活——这笔多半是别的 tab 写的，不抢屏
  if (full === follow.path) { scheduleFollowRender(); return; }
  if (dirtyCheck || autosaveFlush || imgEditState) return; // 编辑器开着就不抢屏，等用户收工
  // 已排队的目标更值得看（html/md）时，不被低优先级写入顶掉
  if (follow.timers.sw && follow.pendingPath && followPrio(follow.pendingPath) > followPrio(full)) return;
  follow.pendingPath = full;
  // 节流而非防抖：agent 在多个文件间快速轮写时，定时器只设一次，到点取最新目标，
  // 防抖会被连续事件无限顺延、永远切不过去
  if (!follow.timers.sw) {
    const wait = follow.path ? 900 : 120; // 还没跟上任何文件时秒切，已在跟随时稳住节奏
    follow.timers.sw = setTimeout(() => { follow.timers.sw = null; followSwitch(follow.pendingPath); }, wait);
  }
}
async function followSwitch(full) {
  if (!follow.on || !full) return;
  if (dirtyCheck || autosaveFlush || imgEditState) return;
  follow.switching = true; // 切换期间压住 scheduleFollowRender，末尾的整体渲染会兜住
  follow.path = full; follow.lastContent = null; follow.pendingPath = null;
  follow.swapping = false; follow.swapDirty = false;
  try {
    const dir = dirOf(full);
    if (dir !== state.cwd || state.recentMode) {
      follow.navving = true;
      try { await navigate(dir, false); } finally { follow.navving = false; }
      if (!follow.on || state.cwd !== dir) { follow.path = null; return; } // 目录打不开/期间被停掉
    }
    let e = state.entries.find((x) => x.path === full);
    if (!e) { await refresh(); e = state.entries.find((x) => x.path === full); } // 新文件刚出现，列表还没刷出来
    if (e && e.isDir) { follow.path = null; return; } // mkdir 之类的目录变更不跟
    if (!e) e = { path: full, name: baseOf(full), kind: kindFromName(full), isDir: false };
    applySelection(full);
    await followRender(e, true);
  } finally { follow.switching = false; }
}
function scheduleFollowRender() {
  if (follow.timers.rd) return;
  follow.timers.rd = setTimeout(() => {
    follow.timers.rd = null;
    if (!follow.on || !follow.path || follow.switching) return;
    const e = state.entries.find((x) => x.path === follow.path)
      || { path: follow.path, name: baseOf(follow.path), kind: kindFromName(follow.path), isDir: false };
    followRender(e, false);
  }, 300);
}
async function followRender(e, first) {
  if (!follow.on || follow.path !== e.path) return;
  const kind = e.kind || kindFromName(e.path);
  // 产物（二进制/压缩包/包内容）或服务端识别为不可预览的：不实时渲染，给一张干净的产物卡片
  if (isFollowArtifact(e.name) || !['text', 'image', 'video', 'audio', 'pdf'].includes(kind)) {
    return followArtifactCard(e);
  }
  if (kind === 'text') {
    if (first) followChrome(e);
    if (isHtmlName(e.name)) return liveHtml(e, first);
    if (isMdName(e.name) && window.marked && !window.__noMarked) return liveMd(e, first);
    return liveCode(e, first);
  }
  // 图片/视频/PDF 等：走常规预览，塞新鲜 mtime 破缓存，每次写入整个换新
  await openPreview({ ...e, mtime: Date.now() });
  if (follow.on && follow.path === e.path) followBadge(e);
}
// 跟随视图的外框：面板 + 标题徽标 + 动作条（不复用 openPreview，避免 md 被它转进编辑器）
function followChrome(e) {
  mona.disposeIfAny(); crepe.disposeIfAny(); imgEditState = null;
  showPreviewPanel();
  followBadge(e);
  renderPreviewActions(e);
  renderPreviewFoot(e);
  $('#preview-body').innerHTML = '<div class="cmdk-loading">加载中…</div>';
}
// 产物卡片：agent 编译/打包出来的成品，没法实时渲染，给一张「已生成」的交付态卡片，比「无法预览」有用得多
function followArtifactCard(e) {
  followChrome(e);
  const body = $('#preview-body');
  const real = state.entries.find((x) => x.path === e.path) || e;
  const sizeStr = real.size ? fmtSize(real.size) : '';
  body.innerHTML =
    `<div class="empty-state artifact-card">
      <div class="big">${iconSvg(real, 48)}</div>
      <div class="art-name">${escapeHtml(e.name)}</div>
      <div class="art-sub">agent 刚生成${sizeStr ? ' · ' + sizeStr : ''}</div>
      <div class="art-btns"><button class="ghost-btn" data-act="reveal">在访达显示</button><button class="ghost-btn" data-act="open">打开</button></div>
    </div>`;
  body.querySelector('[data-act="reveal"]').onclick = () => openWith(e.path, 'reveal');
  body.querySelector('[data-act="open"]').onclick = () => openWith(e.path, 'default');
}
function followBadge(e) {
  const art = isFollowArtifact(e.name);
  const where = follow.label ? `<span class="live-where">${escapeHtml(follow.label)}</span>` : '';
  $('#preview-title').innerHTML = `<span class="live-badge${art ? ' done' : ''}"><i></i>${art ? '已生成' : '跟随中'}</span>${where}${escapeHtml(e.name)}`;
}
// ===== 阶段二「过程旁白」：结果是主视图，底部一行实时说 agent 此刻在干嘛 =====
// 工具调用动词 → 人话（Claude Code 2.x 工具行：「⏺ Update(file)」「⏺ Bash(cmd)」「⏺ Web Search(q)」…）
const ACTION_VERB = { Read: '读', Edit: '写', Update: '写', Write: '写', MultiEdit: '写', NotebookEdit: '写',
  Bash: '跑', Grep: '搜', Glob: '找', Search: '搜', Task: '子任务', TodoWrite: '理清单', Fetch: '抓取' };
// 从绑定终端的输出尾巴里捞最近一条「干了什么」。尽量稳健：认 ⏺/● 圆点工具行，认 Web Search，
// 都没有就看是不是在思考（页脚挂着 esc to interrupt）。提炼失败返回空串（旁白只显示文件侧）。
function latestAgentAction(s) {
  const txt = term.tailText(s, 40);
  if (!txt) return '';
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    let m = ln.match(/(?:web\s*search|websearch)[\s(:]+["“]?([^"”)\n]{1,40})/i);
    if (m) return '联网搜 ' + m[1].trim();
    m = ln.match(/[⏺●·]\s*([A-Z][A-Za-z]+)\s*\(([^)]*)\)/);
    if (m) {
      const verb = ACTION_VERB[m[1]] || m[1];
      let arg = (m[2] || '').trim().replace(/^["']|["']$/g, '');
      if (['读', '写'].includes(verb) && arg.includes('/')) arg = baseOf(arg);
      if (arg.length > 30) arg = arg.slice(0, 30) + '…';
      return arg ? `${verb} ${arg}` : verb;
    }
  }
  if (/esc to interrupt/i.test(txt)) return '思考中…';
  return '';
}
function renderFollowNarration() {
  const el = $('#follow-narration');
  if (!el) return;
  if (!follow.on) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const s = follow.sid && typeof term !== 'undefined' ? term.sessions.find((x) => x.id === follow.sid) : null;
  const busy = !!(s && (s.status === 'busy' || Date.now() - (s.lastData || 0) < 8000));
  const action = s ? latestAgentAction(s) : '';
  // 结果已在主视图 + 标题徽标里；这条只说「过程」：优先 agent 的终端动作，
  // 没动作就退回「在写哪个文件」，agent 闲下来则报一句平静的收尾。
  let main, live = busy;
  if (busy && action) main = action;
  else if (busy && follow.path) main = (isFollowArtifact(baseOf(follow.path)) ? '生成 ' : '写 ') + baseOf(follow.path);
  else if (action && action !== '思考中…') main = action; // 刚停手，留住最后动作
  // 跟随已开但绑的终端还没写文件：明说「等待…」，别把旁白栏藏起来让用户以为跟随坏了（#30）
  else { main = follow.path ? '停在 ' + baseOf(follow.path) : (follow.label ? `等待「${follow.label}」写文件…` : '等待 agent 写文件…'); live = false; }
  if (!main) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const lead = live ? 'agent 正在 ' : '';
  el.innerHTML = `<span class="fn-dot${live ? ' live' : ''}"></span>${escapeHtml(lead)}<span class="fn-term">${escapeHtml(main)}</span>`;
}
function startFollowNarration() { stopFollowNarration(); follow.timers.narr = setInterval(renderFollowNarration, 1200); renderFollowNarration(); }
function stopFollowNarration() { if (follow.timers.narr) { clearInterval(follow.timers.narr); follow.timers.narr = null; } const el = $('#follow-narration'); if (el) { el.classList.add('hidden'); el.innerHTML = ''; } }
// 找出新内容相对旧内容的变动行区间（首尾共同前后缀夹逼，够准且 O(n)）
function changedRange(oldStr, newStr) {
  const a = oldStr.split('\n'), b = newStr.split('\n');
  const min = Math.min(a.length, b.length);
  let s = 0;
  while (s < min && a[s] === b[s]) s++;
  let e1 = a.length - 1, e2 = b.length - 1;
  while (e1 >= s && e2 >= s && a[e1] === b[e2]) { e1--; e2--; }
  if (e2 < s) return { start: Math.min(s, b.length - 1), end: Math.min(s, b.length - 1) }; // 纯删除：指向删除位置
  return { start: s, end: e2 };
}
// 把 hljs 输出按行切开：跨行的 span 行尾闭合、下一行重开，每行都是闭合 HTML
function splitHighlighted(html) {
  const out = []; const open = []; let cur = ''; let last = 0; let m;
  const re = /<span[^>]*>|<\/span>|\n/g;
  while ((m = re.exec(html)) !== null) {
    cur += html.slice(last, m.index); last = re.lastIndex;
    if (m[0] === '\n') { out.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else if (m[0] === '</span>') { if (open.length) { open.pop(); cur += '</span>'; } }
    else { open.push(m[0]); cur += m[0]; }
  }
  out.push(cur + html.slice(last));
  return out;
}
function highlightLines(content, ext) {
  if (window.hljs && !window.__noHljs && ext && window.hljs.getLanguage(ext)) {
    try { return splitHighlighted(window.hljs.highlight(content, { language: ext, ignoreIllegals: true }).value); }
    catch { /* 高亮失败退纯文本 */ }
  }
  return content.split('\n').map(escapeHtml);
}
// 代码实时流：每次写入重读全文，逐行渲染，本次改动的行闪一下并平滑滚过去
async function liveCode(e, first) {
  const data = await api('/api/read?path=' + encodeURIComponent(e.path));
  if (!follow.on || follow.path !== e.path) return; // 拉取期间已切走/停掉
  const body = $('#preview-body');
  if (data.error || data.tooLarge) {
    body.innerHTML = `<div class="empty-state">${escapeHtml(data.tooLarge ? '文件太大，跟随暂不渲染内容' : (data.error || '读取失败'))}</div>`;
    follow.lastContent = null;
    return;
  }
  const content = data.content || '';
  if (!first && content === follow.lastContent) return;
  const range = follow.lastContent == null ? null : changedRange(follow.lastContent, content);
  const lines = highlightLines(content, (data.ext || '').toLowerCase());
  let host = body.querySelector('.follow-code');
  if (!host) { body.innerHTML = '<pre class="follow-code"></pre>'; host = body.querySelector('.follow-code'); }
  host.innerHTML = lines.map((ln, i) =>
    `<div class="cl${range && i >= range.start && i <= range.end ? ' cl-new' : ''}">${ln}</div>`).join('');
  follow.lastContent = content;
  // 首次（不知道改了哪）滚到底——正被写的文件大概率在长尾巴；之后跟着改动行走
  const target = range ? host.children[Math.min(range.end, host.children.length - 1)] : host.lastElementChild;
  if (target) target.scrollIntoView({ block: 'center', behavior: first ? 'auto' : 'smooth' });
}
// md 实时渲染：变更在尾部就贴底滚动（agent 通常从上往下写），改中间则保持视口不跳
async function liveMd(e, first) {
  const data = await api('/api/read?path=' + encodeURIComponent(e.path));
  if (!follow.on || follow.path !== e.path) return;
  const body = $('#preview-body');
  if (data.error || data.tooLarge) return liveCode(e, first); // 复用其错误/超限展示
  const content = data.content || '';
  if (!first && content === follow.lastContent) return;
  const range = follow.lastContent == null ? null : changedRange(follow.lastContent, content);
  const nearEnd = !range || range.end >= content.split('\n').length - 4;
  const keep = body.scrollTop;
  body.innerHTML = '';
  body.appendChild(mdReadBody(content, e.path));
  follow.lastContent = content;
  if (nearEnd) body.scrollTo({ top: body.scrollHeight, behavior: first ? 'auto' : 'smooth' });
  else body.scrollTop = keep;
}
// html 实时网页：新 iframe 隐身加载、onload 后换掉旧的（双缓冲），白屏闪烁为零；
// 半截 html 浏览器本来就能渐进渲染，正好呈现「网页长出来」的过程
function liveHtml(e, first) {
  const body = $('#preview-body');
  let wrap = body.querySelector('.follow-html');
  if (first || !wrap) {
    body.innerHTML = `<div class="follow-html"><iframe class="iframe-preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" src="${fsUrl(e.path, Date.now())}"></iframe></div>`;
    return;
  }
  if (follow.swapping) { follow.swapDirty = true; return; } // 正在换页，攒一次换完补刷
  follow.swapping = true;
  const next = document.createElement('iframe');
  next.className = 'iframe-preview follow-next';
  next.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'); // 与常规 html 预览同口径：经隔离端口给 same-origin（跨源于 App，接管不了）
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    follow.swapping = false;
    if (!next.isConnected) return;
    if (!follow.on || follow.path !== e.path) { next.remove(); return; } // 换页途中跟随被停/切走：丢弃，别抢屏
    wrap.querySelectorAll('iframe').forEach((f) => { if (f !== next) f.remove(); });
    next.classList.remove('follow-next');
    if (follow.swapDirty) { follow.swapDirty = false; scheduleFollowRender(); }
  };
  next.onload = swap;
  setTimeout(swap, 2500); // onload 不来（死循环脚本等）也强制换，跟随不卡死
  next.src = fsUrl(e.path, Date.now());
  wrap.appendChild(next);
}

// WOW4 环境感知：完成时文件区荡开一圈大涟漪 + 极轻提示音（Web Audio 当场合成，无需音频文件）
function rippleFileArea() {
  const host = $('#content') || $('#file-area');
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const r = document.createElement('div');
  r.className = 'area-ripple';
  r.style.left = (rect.left + rect.width / 2) + 'px';
  r.style.top = (rect.top + rect.height / 2) + 'px';
  document.body.appendChild(r);
  r.addEventListener('animationend', () => r.remove(), { once: true });
  setTimeout(() => r.remove(), 1400);
}
let _audioCtx = null;
function playChime(type) {
  if (state.muted) return;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx; const now = ctx.currentTime;
    const notes = type === 'done' ? [659.25, 987.77] : [523.25]; // 完成是 E5→B5 上行小叮，其它单音
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = now + i * 0.11;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.11, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.start(t); o.stop(t + 0.45);
    });
  } catch { /* 音频不可用就算了 */ }
}

// WOW1 活的仪表盘：每次写入，让对应文件卡片当场荡开涟漪 + 弹一下 + 按热度发光，agent 写到哪光走到哪
function igniteCard(top, count) {
  const area = $('#file-area');
  if (!area || !state.cwd) return;
  const path = state.cwd.replace(/\/$/, '') + state.sep + top;
  const el = area.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (!el) return; // 卡片还没渲染（新文件首次出现），等 refresh 后由 renderFiles 接管发光
  el.style.setProperty('--heat', Math.min(1, 0.4 + count * 0.12).toFixed(2));
  el.classList.remove('live-edit'); void el.offsetWidth; el.classList.add('live-edit'); // 重新触发弹跳
  const host = el.querySelector('.icon') || el;
  const ripple = document.createElement('span');
  ripple.className = 'edit-ripple';
  host.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
}

// pty 数据回流（全局一次）
if (window.fanboxPty) {
  window.fanboxPty.onData(({ id, data }) => { const s = term.sessions.find((x) => x.id === id); if (s) { s.xterm.write(data); term.markBusy(s); } });
  window.fanboxPty.onExit(({ id }) => {
    const s = term.sessions.find((x) => x.id === id);
    if (s) {
      s.dead = true; s.status = 'dead';
      s.xterm.write('\r\n\x1b[90m[进程已退出 — 回车重开，或 ✕ 关闭]\x1b[0m\r\n');
      term.renderTabs();
      term.notify(s, '终端已退出', (s.title || 'shell') + ' 的进程结束了');
    }
  });
}
// 文件变化 → 自动刷新列表（看着 agent 干活）；编辑中不动预览，避免吞掉未保存内容
if (window.fanboxFs) {
  let rt = null;
  state.changed = new Map(); // 顶层名 → { count, files:Set, ts }
  let sweep = null;
  const scheduleSweep = () => {
    if (sweep) return;
    sweep = setInterval(() => {
      const now = Date.now(); let dirty = false;
      for (const [k, v] of state.changed) { if (now - v.ts > 4500) { state.changed.delete(k); dirty = true; } }
      if (!state.changed.size) { clearInterval(sweep); sweep = null; }
      if (dirty) renderFiles();
    }, 1000); // 单一清理定时器，避免大批量变更时堆积成千上万个 timer
  };
  window.fanboxFs.onChanged(({ dir, filename }) => {
    // 系统/构建噪声（~/Library 缓存、node_modules 等 macOS 后台不停写）直接丢弃：
    // 既不点亮卡片、不进收件箱，也不触发列表刷新——否则 Library 会永远显示「被修改」
    if (filename && isNoisyChange(filename)) return;
    // 自己刚打开的文件：macOS 写 lastuseddate 扩展属性触发的假变更，整条丢弃（不点卡、不进收件箱、不刷新）
    if (filename) {
      const abs = dir.replace(/\/$/, '') + '/' + String(filename);
      const t = selfOpened.get(abs);
      if (t) {
        if (Date.now() - t < 3000) return;
        selfOpened.delete(abs); // 过期条目顺手清掉，Map 不积垃圾
      }
    }
    // 记进会话级收件箱（跨所有监听目录，不止当前目录），供「变更」面板回看
    if (filename) recordChange(dir, String(filename));
    // 文件跟随：必须在「不是当前目录就 return」之前喂，跨目录改动才跟得上
    if (filename) followChange(dir, String(filename));
    // 打开中的 md 编辑器若对应的磁盘文件被外部（如 agent / 命令行）改了：未脏就静默重载，脏则不动（保存时 mtime 冲突保护会拦）
    if (filename && currentEditor) {
      const abs = dir.replace(/\/$/, '') + '/' + String(filename);
      if (abs === currentEditor.path && !currentEditor.isDirty()) currentEditor.reload();
    }
    if (dir !== state.cwd || state.recentMode) return;
    // 高亮被 agent 改动的项：递归监听下 src/foo.js 归到顶层 src，并累计计数 + 记子路径供 tooltip 定位
    if (filename) {
      const sub = String(filename);
      const top = sub.split('/')[0];
      let rec = state.changed.get(top);
      if (!rec) { rec = { count: 0, files: new Set(), ts: 0 }; state.changed.set(top, rec); }
      rec.count++; rec.ts = Date.now();
      if (rec.files.size < 8 && sub !== top) rec.files.add(sub);
      scheduleSweep();
      igniteCard(top, rec.count); // 当场点亮这张卡（不等 250ms 刷新）
    }
    clearTimeout(rt);
    rt = setTimeout(async () => {
      await refresh();
      if (follow.on && follow.path && state.selected === follow.path) return; // 跟随有自己的实时渲染，别用 openPreview 顶掉（md 会被转进编辑器）
      if (state.selected && !$('#preview').classList.contains('hidden') && !$('#ed-host') && !imgEditState) {
        const e = state.entries.find((x) => x.path === state.selected);
        if (e && (e.kind === 'text' || e.kind === 'image')) openPreview(e);
      }
    }, 250);
  });
}

// ---------- 启动 ----------
// ---------- 侧栏悬停解释卡：比原生 title 更快出现、能排版，鼠标移开即散 ----------
function sideHoverCard(el, build) {
  let card = null;
  const hide = () => { if (card) { card.remove(); card = null; } };
  el.addEventListener('mouseenter', () => {
    hide();
    card = document.createElement('div');
    card.className = 'side-tip';
    card.innerHTML = build();
    document.body.appendChild(card);
    const r = el.getBoundingClientRect();
    let left = r.right + 10;
    if (left + card.offsetWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - card.offsetWidth - 8);
    card.style.left = left + 'px';
    card.style.top = Math.max(8, Math.min(r.top, window.innerHeight - card.offsetHeight - 8)) + 'px';
  });
  el.addEventListener('mouseleave', hide);
  el.addEventListener('click', hide);
  window.addEventListener('blur', hide);
}

// ---------- 侧栏「离开电脑」：合盖继续干活 / 微信遥控不断线（macOS 桌面版专属）----------
const powerBar = {
  st: null,
  async init() {
    if (!window.fanboxPower) return; // 浏览器版 / 老 preload：整段不显示
    const st = await window.fanboxPower.state().catch(() => null);
    if (!st || st.platform !== 'darwin') return; // 禁休眠靠 pmset，仅 macOS
    this.st = st;
    $('#power-sec').classList.remove('hidden');
    $('#pw-lid').onclick = () => this.flip('lid');
    $('#pw-wechat').onclick = () => this.flip('wechat');
    sideHoverCard($('#pw-lid'), () => this.tipLid());
    sideHoverCard($('#pw-wechat'), () => this.tipWechat());
    window.fanboxPower.onChange((m) => { this.st = m; this.sync(); });
    this.sync();
  },
  async flip(kind) {
    const st = this.st || {};
    const on = !(kind === 'lid' ? st.lid : st.wechat);
    const r = await (kind === 'lid' ? window.fanboxPower.setLid(on) : window.fanboxPower.setWechat(on)).catch(() => null);
    if (r) { this.st = r; this.sync(); }
    if (r && r.ok) {
      if (kind === 'lid') toast(r.on ? '已开启 · agent 干活时合盖不休眠' : '已关闭 · 合盖照常休眠');
      else toast(r.on ? '已开启 · 微信连着时不休眠' : '已关闭 · 恢复正常休眠');
    } else if (r && r.error && r.error !== 'cancelled' && r.error !== 'setup-cancelled') toast('开启失败：' + r.error, true);
  },
  sync() {
    const st = this.st; if (!st) return;
    const row = (id, on, lit) => {
      const el = $(id); if (!el) return;
      el.querySelector('.pw-switch').classList.toggle('on', on);
      el.querySelector('.pw-dot').classList.toggle('lit', lit);
    };
    row('#pw-lid', !!st.lid, !!st.lidHolding);
    row('#pw-wechat', !!st.wechat, !!st.wechatHolding);
  },
  tipLid() {
    const st = this.st || {};
    let now;
    if (!st.lid) now = '现在：未开启，合盖照常休眠';
    else if (st.lidHolding) now = `现在：${st.terms} 个终端开着，agent 正在干活 → 生效中，合盖也不休眠`;
    else if (st.terms > 0) now = `现在：${st.terms} 个终端开着但都空闲 → 合盖照常休眠`;
    else now = '现在：没有终端会话 → 合盖照常休眠';
    return `<b>合盖继续干活</b>
      <p>翻箱盯着每个终端窗口的工作状态。开启后：只要检测到有 agent 正在干活，合上盖子 Mac 也不休眠，任务接着跑；所有终端都空闲约两分钟后，自动恢复正常休眠——不会让 Mac 一直不睡。</p>
      <p class="tip-note">合盖跑任务持续耗电发热，建议接电源。首次开启需输一次管理员密码（装一条仅限电源设置的免密规则）。</p>
      <p class="tip-state">${escapeHtml(now)}</p>`;
  },
  tipWechat() {
    const st = this.st || {};
    let now;
    if (!st.wechat) now = '现在：未开启，合盖照常休眠';
    else if (st.wechatHolding) now = '现在：微信已连接 → 生效中，合盖 / 息屏也不休眠';
    else now = '现在：微信未连接 → 暂不生效，连上后自动开始守护';
    return `<b>微信遥控不断线</b>
      <p>开启后，手机微信连着 ClawBot 期间，合盖 / 息屏也不休眠——人在外面也能一直用微信遥控本机的 Claude Code / Codex；微信断开自动恢复正常休眠。</p>
      <p class="tip-note">持续耗电发热，建议接电源。首次开启需输一次管理员密码（装一条仅限电源设置的免密规则）。</p>
      <p class="tip-state">${escapeHtml(now)}</p>`;
  },
};

// ---------- 版本号与版本历史：brand 旁小版本标，悬停看最新更新，点击看全部 ----------
const verInfo = {
  data: null,
  async init() {
    let d = null;
    try { d = await api('/api/changelog'); } catch { /* 服务端没这接口就不显示 */ }
    if (!d || !d.ok) return;
    this.data = d;
    const el = $('#ver-tag');
    el.textContent = 'v' + d.version;
    el.classList.remove('hidden');
    el.onclick = (ev) => { ev.stopPropagation(); this.showAll(); };
    sideHoverCard(el, () => this.tipHtml());
  },
  // Keep a Changelog 的英文分类词换成中文再渲染，用户不用猜 Added/Fixed 是啥
  md(body) {
    const zh = String(body || '')
      .replace(/^### Added$/gm, '### 新增')
      .replace(/^### Fixed$/gm, '### 修复')
      .replace(/^### Changed$/gm, '### 改进')
      .replace(/^### Removed$/gm, '### 移除')
      .replace(/^### Deprecated$/gm, '### 弃用')
      .replace(/^### Security$/gm, '### 安全');
    return window.marked ? window.marked.parse(zh) : '<pre>' + escapeHtml(zh) + '</pre>';
  },
  tipHtml() {
    const e = (this.data.entries || []).find((x) => x.version !== 'Unreleased' && x.body);
    if (!e) return '<b>版本历史</b><p class="tip-note">点击查看全部版本更新</p>';
    return `<b>v${escapeHtml(e.version)} 更新了什么</b><span class="tip-date">${escapeHtml(e.date || '')}</span>
      <div class="tip-md">${this.md(e.body)}</div>
      <p class="tip-note">点击版本号查看完整版本历史</p>`;
  },
  showAll() {
    const old = $('.clog-overlay'); if (old) old.remove();
    const entries = (this.data.entries || []).filter((e) => e.body);
    const cur = this.data.version;
    const ov = document.createElement('div');
    ov.className = 'input-overlay clog-overlay';
    ov.innerHTML = `<div class="input-dialog clog-dialog">
      <div class="input-title">版本历史<span class="clog-sub">最新在上</span></div>
      <div class="clog-body">${entries.map((e) => `
        <div class="clog-entry">
          <div class="clog-head">
            <span class="clog-ver">${e.version === 'Unreleased' ? '开发中 · 未发布' : 'v' + escapeHtml(e.version)}</span>
            ${e.date ? `<span class="clog-date">${escapeHtml(e.date)}</span>` : ''}
            ${e.version === cur ? '<span class="clog-curtag">当前版本</span>' : ''}
          </div>
          <div class="clog-md">${this.md(e.body)}</div>
        </div>`).join('') || '<div class="empty-state">还没有版本记录</div>'}</div></div>`;
    document.body.appendChild(ov);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    ov.onclick = (ev) => { if (ev.target === ov) close(); };
    document.addEventListener('keydown', onKey, true);
    // 更新说明里的外链（GitHub、参考项目等）交给系统浏览器，别把 app 自己导航走
    ov.querySelector('.clog-body').addEventListener('click', (ev) => {
      const a = ev.target.closest('a'); if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:/.test(href)) { window.fanboxUpdate ? window.fanboxUpdate.open(href) : window.open(href, '_blank'); }
    });
  },
};

// ---------- 定时任务：到点自动开一个终端窗口跑 agent / 命令（侧栏入口 + 管理弹层）----------
const cronPanel = {
  data: null, editing: null, ov: null,
  WD: ['日', '一', '二', '三', '四', '五', '六'],
  async syncBadge() {
    try { this.data = await api('/api/cron'); } catch { return; }
    const n = (this.data.tasks || []).filter((t) => t.enabled).length;
    const el = $('#cron-count'); if (!el) return;
    el.textContent = n; el.classList.toggle('hidden', !n);
  },
  async show() {
    const old = $('.cron-overlay'); if (old) old.remove();
    const ov = this.ov = document.createElement('div');
    ov.className = 'input-overlay cron-overlay';
    ov.innerHTML = `<div class="input-dialog cron-dialog">
      <div class="input-title">定时任务<span class="cron-sub">到点自动开一个终端窗口干活</span></div>
      <div class="cron-body"><div class="cmdk-loading">读取任务中…</div></div></div>`;
    document.body.appendChild(ov);
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      if (this.editing != null) { this.editing = null; this.render(); } else this.close();
    };
    this.close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); this.ov = null; };
    ov.onclick = (ev) => { if (ev.target === ov) this.close(); };
    document.addEventListener('keydown', onKey, true);
    this.editing = null;
    await this.reload();
  },
  async reload() {
    try { this.data = await api('/api/cron'); } catch { this.data = { tasks: [] }; }
    if (this.ov) this.render();
    this.syncBadgeLocal();
  },
  syncBadgeLocal() {
    const n = ((this.data && this.data.tasks) || []).filter((t) => t.enabled).length;
    const el = $('#cron-count'); if (el) { el.textContent = n; el.classList.toggle('hidden', !n); }
  },
  agentLabel(t) { return t.agent === 'codex' ? 'Codex' : t.agent === 'shell' ? 'Shell' : 'Claude Code'; },
  schedLabel(s) {
    if (!s) return '';
    if (s.type === 'at') return '一次 · ' + this.fmtAbs(new Date(s.time).getTime());
    if (s.type === 'every') { const m = Number(s.minutes) || 0; return m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`; }
    if (s.type === 'cron') {
      const p = String(s.expr || '').trim().split(/\s+/);
      if (p.length === 5) {
        const [mi, h, dom, mon, dow] = p;
        const hm = () => `${h}:${mi.padStart(2, '0')}`;
        if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `每天 ${hm()}`;
        if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*' && /^\d$/.test(dow)) return `每周${this.WD[+dow % 7]} ${hm()}`;
        if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `每小时的第 ${+mi} 分钟`;
        if (/^\d+$/.test(mi) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `每月 ${+dom} 日 ${hm()}`;
      }
      return 'cron · ' + s.expr;
    }
    return '';
  },
  fmtAbs(ms) {
    if (!ms || !isFinite(ms)) return '—';
    const d = new Date(ms); const now = new Date();
    const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, now)) return `今天 ${hm}`;
    const tomorrow = new Date(now.getTime() + 86400000);
    if (sameDay(d, tomorrow)) return `明天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  },
  lastBadge(t) {
    const h = (t.history || [])[0];
    if (!h) return '';
    if (h.missed) return `<i class="cron-last warn">上次到点时 FanBox 没开着，跳过了</i>`;
    if (h.ok) return `<i class="cron-last ok">上次 ${fmtTime(h.t)} ✓</i>`;
    return `<i class="cron-last bad" title="${escapeHtml(h.error || '')}">上次失败 ✗</i>`;
  },
  render() {
    const body = this.ov.querySelector('.cron-body');
    if (this.editing != null) return this.renderForm(body);
    const d = this.data || {}; const tasks = d.tasks || [];
    body.innerHTML = `${d.desktop === false ? '<div class="cron-note">浏览器版只能管理任务；到点开窗执行需要 FanBox 桌面版开着</div>' : ''}
      <div class="cron-list">${tasks.map((t) => {
        const meta = `${this.schedLabel(t.schedule)} · ${this.agentLabel(t)} · ${baseOf(t.cwd || '') || '~'}${t.enabled && t.nextRun ? ` · 下次 ${this.fmtAbs(t.nextRun)}` : ''}`;
        return `
        <div class="cron-row ${t.enabled ? '' : 'off'}" data-id="${t.id}">
          <label class="pw-switch ${t.enabled ? 'on' : ''}" data-act="toggle" title="${t.enabled ? '停用（保留任务，不再到点执行）' : '启用'}"><i></i></label>
          <div class="cron-main">
            <div class="cron-name"><span class="cron-name-text" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>${t.createdBy === 'agent' ? '<i class="cron-src">agent 设的</i>' : ''}${t.full ? '<i class="cron-full" title="全自动：执行时跳过所有确认">全自动</i>' : ''}</div>
            <div class="cron-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)} ${this.lastBadge(t)}</div>
          </div>
          <button class="cron-btn" data-act="run" title="立即执行一次（新开终端窗口）">▶</button>
          <button class="cron-btn" data-act="edit" title="编辑">编辑</button>
          <button class="cron-btn danger" data-act="del" title="删除">删除</button>
        </div>`;
      }).join('') || `<div class="empty-state">还没有定时任务<br><br><span class="usage-sub">点下方「新建」，或在终端里对 agent 说一句<br>「每天早上 9 点到写作目录整理灵感箱」</span></div>`}
      </div>
      <div class="cron-foot">
        <button class="cron-add" id="cron-new">＋ 新建定时任务</button>
        <span class="cron-hint">终端里的 agent 也能帮你设：白话说清「什么时候、去哪个目录、干什么」就行</span>
      </div>`;
    body.querySelector('#cron-new').onclick = () => { this.editing = {}; this.render(); };
    body.querySelectorAll('.cron-row').forEach((row) => {
      const t = tasks.find((x) => x.id === row.dataset.id);
      row.querySelector('[data-act=toggle]').onclick = async () => {
        const r = await apiPost('/api/cron/toggle', { id: t.id, enabled: !t.enabled });
        if (!r.ok) toast(r.error || '操作失败', true);
        this.reload();
      };
      row.querySelector('[data-act=run]').onclick = async () => {
        const r = await apiPost('/api/cron/run', { id: t.id });
        toast(r.ok ? '已开一个终端窗口执行' : (r.error || '执行失败'), !r.ok);
        this.reload();
      };
      row.querySelector('[data-act=edit]').onclick = () => { this.editing = t; this.render(); };
      const del = row.querySelector('[data-act=del]');
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = '确认删除?'; setTimeout(() => { del.dataset.armed = ''; del.textContent = '删除'; }, 2500); return; }
        await apiPost('/api/cron/delete', { id: t.id });
        this.reload();
      };
    });
  },
  // 编辑表单：六种时间预设 → schedule 对象；保存前实时预告接下来 3 次执行
  presetOf(s) {
    if (!s || !s.type) return 'daily';
    if (s.type === 'at') return 'once';
    if (s.type === 'every') return 'every';
    const l = this.schedLabel(s);
    if (l.startsWith('每天')) return 'daily';
    if (l.startsWith('每周')) return 'weekly';
    if (l.startsWith('每小时')) return 'hourly';
    return 'cron';
  },
  renderForm(body) {
    const t = this.editing;
    const s = t.schedule || {};
    const p = String((s.expr || '')).trim().split(/\s+/);
    const pad = (n) => String(n).padStart(2, '0');
    const time0 = p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) ? `${pad(p[1])}:${pad(p[0])}` : '09:00';
    const preset = this.presetOf(s);
    body.innerHTML = `<div class="cron-form">
      <label class="cron-fl">想让它干什么<textarea id="cr-prompt" class="input-field" rows="3" placeholder="白话写就行，如：把灵感箱里的碎片整理进对应选题；Shell 模式则填要执行的命令">${escapeHtml(t.prompt || '')}</textarea></label>
      <div class="cron-grid">
        <label class="cron-fl">谁来干<select id="cr-agent" class="input-field">
          <option value="claude" ${t.agent === 'codex' || t.agent === 'shell' ? '' : 'selected'}>Claude Code</option>
          <option value="codex" ${t.agent === 'codex' ? 'selected' : ''}>Codex</option>
          <option value="shell" ${t.agent === 'shell' ? 'selected' : ''}>Shell 命令</option>
        </select></label>
        <label class="cron-fl">在哪个目录<input id="cr-cwd" class="input-field" value="${escapeHtml(t.cwd || state.cwd || state.home || '')}" /></label>
      </div>
      <label class="cron-check" id="cr-full-wrap"><input type="checkbox" id="cr-full" ${t.full ? 'checked' : ''} /> 全自动：跳过所有确认（无人值守时用，agent 会直接改文件、跑命令）</label>
      <div class="cron-grid">
        <label class="cron-fl">什么时候<select id="cr-preset" class="input-field">
          <option value="daily" ${preset === 'daily' ? 'selected' : ''}>每天</option>
          <option value="weekly" ${preset === 'weekly' ? 'selected' : ''}>每周</option>
          <option value="hourly" ${preset === 'hourly' ? 'selected' : ''}>每小时</option>
          <option value="every" ${preset === 'every' ? 'selected' : ''}>每隔一段时间</option>
          <option value="once" ${preset === 'once' ? 'selected' : ''}>某个时间点，一次</option>
          <option value="cron" ${preset === 'cron' ? 'selected' : ''}>cron 表达式</option>
        </select></label>
        <div class="cron-fl" id="cr-sched-fields"></div>
      </div>
      <div class="cron-preview" id="cr-preview"></div>
      <label class="cron-fl">名称（可不填）<input id="cr-name" class="input-field" value="${escapeHtml(t.name || '')}" placeholder="不填就取任务内容开头" /></label>
      <div class="cron-form-foot">
        <button class="cron-add" id="cr-save">保存</button>
        <button class="cron-btn" id="cr-cancel">取消</button>
      </div>
    </div>`;
    const fields = body.querySelector('#cr-sched-fields');
    const renderFields = (pr) => {
      if (pr === 'daily') fields.innerHTML = `<input type="time" id="cr-time" class="input-field" value="${time0}" />`;
      else if (pr === 'weekly') fields.innerHTML = `<span class="cron-inline"><select id="cr-dow" class="input-field">${this.WD.map((w, i) => `<option value="${i}" ${p[4] == i ? 'selected' : ''}>周${w}</option>`).join('')}</select><input type="time" id="cr-time" class="input-field" value="${time0}" /></span>`;
      else if (pr === 'hourly') fields.innerHTML = `<span class="cron-inline">第 <input type="number" id="cr-min" class="input-field" min="0" max="59" value="${/^\d+$/.test(p[0]) ? +p[0] : 0}" style="width:64px" /> 分钟</span>`;
      else if (pr === 'every') { const m = Number(s.minutes) || 120; fields.innerHTML = `<span class="cron-inline">每 <input type="number" id="cr-n" class="input-field" min="1" value="${m % 60 === 0 ? m / 60 : m}" style="width:64px" /> <select id="cr-unit" class="input-field"><option value="60" ${m % 60 === 0 ? 'selected' : ''}>小时</option><option value="1" ${m % 60 === 0 ? '' : 'selected'}>分钟</option></select></span>`; }
      else if (pr === 'once') { const v = s.time ? s.time.slice(0, 16) : ''; fields.innerHTML = `<input type="datetime-local" id="cr-at" class="input-field" value="${escapeHtml(v)}" />`; }
      else fields.innerHTML = `<input id="cr-expr" class="input-field" value="${escapeHtml(s.expr || '0 9 * * *')}" placeholder="分 时 日 月 周，如 30 8 * * 1-5" />`;
      fields.querySelectorAll('input,select').forEach((el) => { el.oninput = preview; el.onchange = preview; });
    };
    const buildSchedule = () => {
      const pr = body.querySelector('#cr-preset').value;
      const tm = () => { const [h, mi] = (body.querySelector('#cr-time').value || '9:00').split(':'); return { h: +h, mi: +mi }; };
      if (pr === 'daily') { const { h, mi } = tm(); return { type: 'cron', expr: `${mi} ${h} * * *` }; }
      if (pr === 'weekly') { const { h, mi } = tm(); return { type: 'cron', expr: `${mi} ${h} * * ${body.querySelector('#cr-dow').value}` }; }
      if (pr === 'hourly') return { type: 'cron', expr: `${+body.querySelector('#cr-min').value || 0} * * * *` };
      if (pr === 'every') return { type: 'every', minutes: Math.max(1, (+body.querySelector('#cr-n').value || 1) * (+body.querySelector('#cr-unit').value || 1)) };
      if (pr === 'once') return { type: 'at', time: body.querySelector('#cr-at').value };
      return { type: 'cron', expr: body.querySelector('#cr-expr').value };
    };
    let pvTimer = null;
    const preview = () => {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(async () => {
        const el = body.querySelector('#cr-preview'); if (!el) return;
        const r = await apiPost('/api/cron/preview', { schedule: buildSchedule() }).catch(() => null);
        if (!r || !r.ok) { el.innerHTML = `<i class="bad-t">${escapeHtml((r && r.error) || '时间规则无法解析')}</i>`; return; }
        // 分隔用「 · 」：i18n 的 EN 模式按 · 拆段逐段翻，每个时间片段都能命中规则
        el.textContent = r.times.length ? '将执行于：' + r.times.map((x) => this.fmtAbs(x)).join(' · ') + (r.times.length > 1 ? ' · …' : '') : '不会再执行';
      }, 250);
    };
    body.querySelector('#cr-preset').onchange = () => { renderFields(body.querySelector('#cr-preset').value); preview(); };
    body.querySelector('#cr-agent').onchange = () => { body.querySelector('#cr-full-wrap').style.display = body.querySelector('#cr-agent').value === 'shell' ? 'none' : ''; };
    body.querySelector('#cr-agent').onchange();
    body.querySelector('#cr-cancel').onclick = () => { this.editing = null; this.render(); };
    body.querySelector('#cr-save').onclick = async () => {
      const payload = {
        id: t.id, name: body.querySelector('#cr-name').value, cwd: body.querySelector('#cr-cwd').value,
        agent: body.querySelector('#cr-agent').value, prompt: body.querySelector('#cr-prompt').value,
        full: body.querySelector('#cr-full').checked, schedule: buildSchedule(),
        enabled: t.enabled !== false,
      };
      const r = await apiPost('/api/cron/save', payload);
      if (!r.ok) { toast(r.error || '保存失败', true); return; }
      this.editing = null;
      toast('已保存');
      this.reload();
    };
    renderFields(preset);
    preview();
  },
};

async function init() {
  // 桌面 app：标记 body，给顶部交通灯留位、顶部可拖拽
  if (window.fanboxEnv && window.fanboxEnv.isDesktopApp) document.documentElement.classList.add('desktop');
  try { window.fanboxWin?.trafficLights(true); } catch { /* 重载后兜底恢复系统按钮，防上次全屏藏了没显回来 */ }
  applyTheme(state.theme, false);
  if (state.sidebarCollapsed) { $('#app').classList.add('sidebar-collapsed'); $('#btn-sidebar')?.classList.add('on'); }
  applyLayout();
  term.applyDock(); // 初始就给 #main-body 设好 dock 类，决定预览/文件管理方向
  bindEvents();
  bindResizer();
  bindSidebarResizer();
  bindSelectionToTerminal();
  enableTooltips();
  // md 里直接引用本地文件路径的图片，按页面 URL 解析必 404：加载失败时解析成
  // 绝对路径走 /fs/ 镜像端点兜底显示。文档源码保持干净的文件路径，预览和 Crepe 里都能看图
  $('#preview-body').addEventListener('error', (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.fsTried) return;
    const src = decodeURI(img.getAttribute('src') || '');
    if (/^(https?:|data:|blob:)/.test(src) || src.startsWith('/api/') || src.startsWith('/fs/')) return;
    let abs = src;
    if (!abs.startsWith('/')) {
      const stack = (state.selected || '').split('/').slice(0, -1);
      for (const seg of abs.split('/')) {
        if (seg === '..') stack.pop(); else if (seg && seg !== '.') stack.push(seg);
      }
      abs = '/' + stack.filter(Boolean).join('/');
    }
    img.dataset.fsTried = '1';
    img.src = '/fs' + encodeURI(abs);
  }, true);
  document.querySelectorAll('#theme-switch .theme-seg button').forEach((b) => { b.onclick = () => applyTheme(b.dataset.skin); });
  await loadRoots();
  await loadFavorites();
  powerBar.init();
  webSec.init(); // 网页版侧栏卡（桌面版里是空操作）
  verInfo.init();
  cronPanel.syncBadge();
  loadAgentProjects();
  setInterval(loadAgentProjects, 120000); // agent 项目入口保持新鲜（服务端有 60s 缓存，开销很小）
  // 回到上次浏览的目录（目录已不存在则退回主目录）
  const lastDir = localStorage.getItem('fb_last_cwd');
  await navigate(lastDir || state.home, false);
  if (!state.cwd) await navigate(state.home, false);
  // 恢复上次终端开合与标签布局（几个标签、各在哪个目录、谁在前台；进程不复活）。
  // 首次安装没有任何记录 → 默认打开：侧栏 + 文件区 + 终端的三栏就是 FanBox 的本来形态
  if (term.available() && localStorage.getItem('fb_term_open') !== '0') {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('fb_term_tabs') || 'null'); } catch { /* */ }
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) await term.restore(saved);
    else term.open();
  }
  maybeShowGuide();
  bindUpdateNotice();
}
// 新版本提示：主进程查到 GitHub 有新 Release 时右下角弹胶囊，引导去下载页（不强更不打扰）
function bindUpdateNotice() {
  if (!window.fanboxUpdate) return;
  const show = ({ version, url }) => {
    if (localStorage.getItem('fb_skip_ver') === version || document.querySelector('.update-pill')) return;
    const bar = document.createElement('div');
    bar.className = 'update-pill';
    const canDl = typeof window.fanboxUpdate.download === 'function'; // 老 preload 没这桥，降级只留发布页
    bar.innerHTML = `<span class="up-msg">新版本 v${escapeHtml(version)} 已发布</span>`
      + (canDl ? '<button class="up-go up-dl">下载更新</button><button class="up-page">发布页</button>' : '<button class="up-go">去下载</button>')
      + '<button class="up-x" title="这个版本不再提醒">✕</button>';
    document.body.appendChild(bar);
    // #26 一键下载：主进程按当前架构下对应 dmg 到 ~/Downloads 并打开挂载，拖一下完成更新
    const dl = bar.querySelector('.up-dl');
    if (dl) {
      dl.onclick = async () => {
        dl.disabled = true; dl.textContent = '下载中…';
        const r = await window.fanboxUpdate.download(version).catch(() => ({ ok: false }));
        if (r && r.ok) { bar.querySelector('.up-msg').textContent = '已下载并打开 dmg，拖进 Applications 完成更新'; dl.remove(); }
        else {
          dl.disabled = false; dl.textContent = '下载更新';
          // no-asset：这个 Release 没发当前架构的 dmg，主进程已经把发布页开出来了
          toast(r && r.error === 'no-asset' ? `这个版本没有 ${r.arch} 安装包，已打开发布页` : '下载失败，去发布页手动下吧', true);
        }
      };
      if (window.fanboxUpdate.onProgress) window.fanboxUpdate.onProgress((m) => {
        if (m.state === 'downloading' && dl.disabled) dl.textContent = m.pct >= 0 ? `下载中 ${m.pct}%` : '下载中…';
      });
      bar.querySelector('.up-page').onclick = () => window.fanboxUpdate.open(url);
    } else {
      bar.querySelector('.up-go').onclick = () => { window.fanboxUpdate.open(url); bar.remove(); };
    }
    bar.querySelector('.up-x').onclick = () => { localStorage.setItem('fb_skip_ver', version); bar.remove(); };
  };
  window.fanboxUpdate.onAvailable(show);
  // 主进程启动 6 秒就推送，init 加载大目录时这里可能还没注册监听——补拉一次，错过的推送不丢
  if (window.fanboxUpdate.get) window.fanboxUpdate.get().then((m) => { if (m) show(m); }).catch(() => {});
}

// 终端渲染器诊断开关：fbWebgl(false) 关 WebGL 用 DOM renderer 排查 CJK 残影，fbWebgl(true) 恢复。
// 与设置面板「WebGL 加速渲染」同一逻辑，对所有已开标签立即生效
window.fbWebgl = (on) => { term.setWebgl(!!on); console.log('[fanbox] WebGL ' + (on ? '已开启' : '已关闭（DOM renderer 兼容渲染）') + '，已对所有终端标签生效'); return !!on; };

// Agent 控制接口（/api/agent/*）的渲染侧配合：应 main 之邀开新终端 tab + 给被控 tab 闪 ⚡
if (window.fanboxAgentCtl) {
  window.fanboxAgentCtl.onCreate(async ({ reqId, cwd }) => {
    try {
      if ($('#terminal-panel').classList.contains('hidden')) term.open();
      const sess = await term.newTab(cwd || undefined);
      window.fanboxAgentCtl.created({ reqId, ok: !!(sess && sess.id), id: sess && sess.id });
    } catch (e) { window.fanboxAgentCtl.created({ reqId, ok: false, error: String(e && e.message || e) }); }
  });
  window.fanboxAgentCtl.onTouch(({ id }) => {
    const s = term.sessions.find((x) => x.id === id);
    if (!s) return;
    s.agentTouch = Date.now();
    term.renderTabs();
    setTimeout(() => term.renderTabs(), 8200); // 标记过期后重画抹掉
  });
}


init();
