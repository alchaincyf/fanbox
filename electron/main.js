'use strict';
/**
 * FanBox — Electron 主进程
 *
 * 复用零依赖后端 server.js（文件能力），叠加 node-pty 内嵌终端，
 * 让 TUI coding agent（Claude Code / Codex / Aider…）在界面里直接跑起来。
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, Menu, clipboard, dialog, net, session, systemPreferences, utilityProcess } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 复用现有后端 server.js，但它跑在自己的进程里（见 startBackendServer）。
// 从前是 require 进主进程的，于是文件服务、目录扫描、缩略图子进程和 node-pty 抢同一个
// 事件循环——主进程一忙，「拖个文件进终端」这种只需写几十字节的操作也得排在几百次
// statSync 和一片 sips 后面，实测能等十几秒。拆开后主进程只剩窗口 + pty + IPC。
process.env.FANBOX_NO_OPEN = '1';
const PORT = Number(process.env.FANBOX_PORT) || 4567;

// node-pty 是原生模块，需 electron-rebuild 编译过；未就绪时终端能力降级但 app 仍可用
let pty = null;
try { pty = require('node-pty'); }
catch (e) { console.error('[fanbox] node-pty 未就绪（跑 npm run rebuild）：', e.message); }

const terminals = new Map();
const termTails = new Map(); // id -> 最近输出尾巴（去 ANSI），给微信 agent 感知别的终端在跑啥/卡哪
let win = null;

// ---------- Agent 控制接口状态（/api/agent/*，见 docs/12）----------
// token 每次启动随机生成、不落盘：只注入翻箱自己开的 pty 环境变量（FANBOX_CTL_TOKEN），
// 能力边界 = FanBox 进程树——只有跑在翻箱终端里的 agent 拿得到门票，本机其他进程无从读取。
// FANBOX_AGENT_TOKEN 环境变量可覆盖，供本地开发/自动化测试注入已知 token。
const crypto = require('crypto');
const AGENT_TOKEN = process.env.FANBOX_AGENT_TOKEN || crypto.randomBytes(24).toString('hex');
const termBufs = new Map();    // id -> 去 ANSI 滚动缓冲（~200KB），/api/agent/read 的数据源
const termLastOut = new Map(); // id -> 最近输出时间戳，wait 的 idle 判定
const termWaiters = new Map(); // id -> Set<fn(text)>，wait 的增量输出订阅
// id -> { agent, sessionId, state, since, lastEventAt, hooked:true, changed: Map(path -> {n, lastAt, tool}) }
// agent 官方 hooks 报来的事实（见 writeHookFiles / agentEvent）。有这条记录的终端，忙闲不再刮终端文本
const termFacts = new Map();

// ---------- Agent 官方 hooks：让 claude/codex 自己汇报「在干活 / 等确认 / 干完了」，取代刮终端文本 ----------
// 启动时把两份静态文件写到 ~/.fanbox/hooks/：claude 走 `--settings 文件` 叠加（不动用户自己的
// ~/.claude/settings.json），codex 走 `-c notify=[脚本]`。命令里的 $FANBOX_* 由 pty 环境展开，
// 所以文件内容对所有终端相同。--noproxy：用户开着系统代理时 curl 127.0.0.1 会被拦掉（实测）。
const HOOKS_DIR = () => path.join(os.homedir(), '.fanbox', 'hooks');
const HOOK_CURL = `curl -s --noproxy '*' -m 3 -X POST "$FANBOX_CTL/event" -H "x-fanbox-token: $FANBOX_CTL_TOKEN" -H "x-fanbox-term: $FANBOX_TERM_ID" -H 'content-type: application/json' --data-binary`;
function writeHookFiles() {
  try {
    const dir = HOOKS_DIR();
    fs.mkdirSync(dir, { recursive: true });
    // async：hook 在后台跑、不等返回，绝不拖慢 agent；timeout 5s 兜底
    const on = (matcher) => [{ matcher, hooks: [{ type: 'command', command: `${HOOK_CURL} @- >/dev/null 2>&1 || true`, async: true, timeout: 5 }] }];
    const hooks = {};
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd']) hooks[ev] = on('*');
    hooks.PostToolUse = on('Edit|Write|MultiEdit|NotebookEdit|Bash');
    fs.copyFileSync(path.join(__dirname, '..', 'lib', 'claude-statusline.cjs'), path.join(dir, 'claude-statusline.cjs'));
    const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    const command = process.platform === 'win32'
      ? `set ELECTRON_RUN_AS_NODE=1&&"${process.execPath}" "${path.join(dir, 'claude-statusline.cjs')}"`
      : `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(path.join(dir, 'claude-statusline.cjs'))}`;
    const statusLine = { type: 'command', command };
    fs.writeFileSync(path.join(dir, 'claude-settings.json'), JSON.stringify({ hooks, statusLine }, null, 2) + '\n');
    // codex 的 notify 是整个数组覆盖：用户 ~/.codex/config.toml 里原有的通知程序（如 Codex Computer Use）
    // 会被顶掉，所以脚本末尾接力调用它、原参数照传
    const orig = codexUserNotify();
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const sh = ['#!/bin/sh', '# FanBox 启动时生成：把 Codex notify 事件（JSON 是最后一个参数）转发给 FanBox；$FANBOX_* 来自终端环境',
      'for last; do :; done',
      `[ -n "$FANBOX_CTL" ] && ${HOOK_CURL} "$last" >/dev/null 2>&1`,
      orig.length ? `exec ${orig.map(q).join(' ')} "$@"` : 'exit 0', ''].join('\n');
    const shPath = path.join(dir, 'codex-notify.sh');
    fs.writeFileSync(shPath, sh);
    fs.chmodSync(shPath, 0o755);
  } catch (e) { console.error('[fanbox] hooks 文件写入失败：', e.message); }
}
// 只读 ~/.codex/config.toml 顶层的 notify = ["程序", "参数"…]，粗解析够用（不动这个文件）
function codexUserNotify() {
  try {
    const m = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8').match(/^notify\s*=\s*\[([^\]]*)\]/m);
    return m ? [...m[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((x) => x[1].replace(/\\(["\\])/g, '$1')) : [];
  } catch { return []; }
}

// ---------- 后端子进程 ----------
// server.js 跑在 utilityProcess 里（入口 server-child.js）。agent 能力（pty 都活在
// 主进程）通过消息桥回去：子进程发 {type:'agent:call', id, method, args}，这里查
// agentImpl（定义在 agent 各方法之后）真执行，再按 id 回 {type:'agent:reply'}。
let backendProc = null;
let backendRestarts = 0;
function startBackendServer() {
  backendProc = utilityProcess.fork(path.join(__dirname, 'server-child.js'), [], {
    serviceName: 'fanbox-server',
    stdio: 'inherit', // 后端日志照旧进 app 的终端输出
    env: { ...process.env, FANBOX_NO_OPEN: '1', FANBOX_PORT: String(PORT), FANBOX_AGENT_TOKEN: AGENT_TOKEN },
  });
  const child = backendProc;
  // 活过 5 秒 = 这次启动是成功的，重启计数清零；否则偶发崩溃隔几天攒满 5 次会误判「起不来」
  const settled = setTimeout(() => { backendRestarts = 0; }, 5000);
  child.on('message', async (m) => {
    if (!m || m.type !== 'agent:call') return;
    let result;
    try { result = await agentImpl[m.method](...(m.args || [])); }
    catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
    try { child.postMessage({ type: 'agent:reply', id: m.id, result }); } catch { /* 子进程已死，回包作废 */ }
  });
  child.on('exit', (code) => {
    clearTimeout(settled);
    if (backendProc === child) backendProc = null;
    if (isQuitting || code === 0) return;
    if (backendRestarts++ < 5) { setTimeout(startBackendServer, 300 * backendRestarts); return; }
    // 连拉 5 次都活不成，最常见是端口被占（另一个 FanBox / 裸跑的 node server.js）。
    // server 还在主进程里的年代，这种情况是整个 app 直接退出——结局保持一致，但把原因说出来
    dialog.showMessageBoxSync({
      type: 'error', message: 'FanBox 后端启动失败',
      detail: `端口 ${PORT} 可能已被占用（另一个 FanBox 或 node server.js）。\n关掉占用者再启动，或换端口：FANBOX_PORT=8080。`,
    });
    isQuitting = true; app.quit();
  });
}

// ---------- 窗口尺寸/位置记忆 ----------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (b && b.width > 400 && b.height > 300) return b;
  } catch { /* 首次启动无记录 */ }
  return { width: 1320, height: 860 };
}
function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch { /* */ }
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 920, minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0c0a',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--fanbox-ctl-token=${AGENT_TOKEN}`], // 渲染层写接口的门票，preload 读 argv 暴露为 fanboxEnv.ctlToken
    },
  });
  // 拖动/缩放后防抖记忆，关窗再存一次兜底
  let bt = null;
  const remember = () => { clearTimeout(bt); bt = setTimeout(saveBounds, 400); };
  win.on('resize', remember);
  win.on('move', remember);
  // macOS：点左上角红叉只隐藏到 Dock（保活渲染进程，所有界面/终端状态原样保留），真正退出走 ⌘Q。
  win.on('close', (e) => {
    saveBounds();
    if (process.platform === 'darwin' && !isQuitting) { e.preventDefault(); win.hide(); }
  });

  // 等后端起来再加载（首次 listen 有几十毫秒延迟）
  const load = () => win.loadURL(`http://localhost:${PORT}`).catch(() => setTimeout(load, 150));
  setTimeout(load, 250);

  // 外部链接走系统浏览器；其余协议（file:/javascript:/自定义 scheme）一律不开——页面内容里混进的 window.open 别想开出新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // ↑ 只拦得住 window.open / target=_blank。md 正文里 marked 渲染出来的普通 <a href> 走的是
  // 「当前页导航」，绕过它：整个界面被外站替换掉，而窗口是 hiddenInset 没有地址栏和后退键、
  // 渲染层连同快捷键一起没了，等于死界面只能强退 app。这里按框架分两档兜住：
  //   主框架——只准停在 app 自己的入口页（启动加载、⌘R 刷新），其余一律拦下；
  //   子框架——html 文件预览的 iframe，跳本机文件随它去（出不了预览框），跳外站才拦。
  // 自己人 = 后端（PORT）和 html 预览的隔离源（PORT+1，见 server.js 的 PREVIEW_PORT）
  const isOurs = (url) => {
    try {
      const u = new URL(url);
      return (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
        && (u.port === String(PORT) || u.port === String(PORT + 1));
    } catch { return false; } // about:blank、非法 URL 都按外部处理
  };
  win.webContents.on('will-frame-navigate', (ev) => {
    const url = ev.url || '';
    if (ev.isMainFrame) {
      let atEntry = false;
      try { const u = new URL(url); atEntry = isOurs(url) && u.port === String(PORT) && (u.pathname === '/' || u.pathname === ''); } catch { /* 非法 URL 直接拦 */ }
      if (atEntry) return;
    } else if (isOurs(url)) {
      return;
    }
    ev.preventDefault();
    // 外站交给系统浏览器；本机的（md 里 [x](./y.md) 这类相对链接会解析成 http://localhost:PORT/y.md）
    // 只拦不开——扔进浏览器只会得到一个 404 页，更莫名其妙
    if (!isOurs(url) && /^(https?|mailto|tel):/i.test(url)) shell.openExternal(url).catch(() => { /* 没有可处理的应用就算了 */ });
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // 开发模式下 macOS 默认显示 Electron 图标——换成翻箱自己的（打包后由 electron-builder 的 icon 接管）
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))); } catch { /* */ }
  }
  app.setName('FanBox');
  writeHookFiles(); // 每次启动重写，随版本升级自动更新，用户不用管
  startBackendServer(); // utilityProcess 只能在 ready 之后 fork；窗口加载自带重试，等它起

  // 后端跑在 localhost，访问它永不该走代理。个别环境（clash 强制系统代理、企业 PAC 把 loopback 也代理）
  // 会把本地请求拦成 502 → 整个界面白屏。给 loopback 显式加旁路；其余（如查更新走 GitHub）仍按系统代理，互不影响。
  session.defaultSession.setProxy({ mode: 'system', proxyBypassRules: 'localhost;127.0.0.1;[::1]' }).catch(() => { /* 设置失败就退回默认行为，不影响启动 */ });
  // 合盖继续运行：恢复上次的开关意图；启动时把残留的禁休眠清掉（防上次崩溃没恢复），有终端跑起来再按需重新生效
  lidIntent = !!readConfig().lidStayAwake;
  wechatStayAwake = !!readConfig().wechatStayAwake;
  if (process.platform === 'darwin') trySetDisableSleep(false);
  // agent 忙闲轮询：开着「合盖继续干活」时每 30s 结算一次（所有终端收工、缓冲到期后恢复休眠靠它）
  setInterval(() => { if (lidIntent && terminals.size) refreshLidGuard(); }, 30000);
  buildMenu();
  try {
    const m = Menu.getApplicationMenu();
    const view = m && m.items.find((i) => i.label === M('视图', 'View'));
    console.log('[lid] 视图 子菜单 =', view ? JSON.stringify(view.submenu.items.map((x) => x.label || `<${x.type}>`)) : '没找到视图菜单');
  } catch (e) { console.log('[lid] dump menu 出错:', e.message); }
  createWindow();
  // 临时调试：dev 实例强制抢到最前，避免和正式版搞混。只限开发实例——正式版若跟着抢，开机自启 / 更新后重启时会把你正在打字的窗口夺走
  if (!app.isPackaged) setTimeout(() => { try { app.focus({ steal: true }); if (win && !win.isDestroyed()) { win.show(); win.focus(); win.setAlwaysOnTop(true); setTimeout(() => win.setAlwaysOnTop(false), 1500); } } catch { /* */ } }, 1200);
  startShotWatch();
  // 启动 6 秒后查一次新版本（不挡启动）；长开会话每 2 小时再查；
  // 窗口重新聚焦也顺手查（30 分钟节流）——否则发版当天老 app 要等满周期才知道有新版
  setTimeout(checkUpdate, 6000);
  setInterval(checkUpdate, 2 * 3600 * 1000);
  app.on('browser-window-focus', () => {
    if (Date.now() - lastAutoCheck > 30 * 60 * 1000) checkUpdate();
  });
});

// ---------- 截图直通车：监听系统截屏落盘，新截图推给渲染层浮出直通卡 ----------
function screenshotDir() {
  try {
    const out = require('child_process').execSync('defaults read com.apple.screencapture location 2>/dev/null', { encoding: 'utf8' }).trim();
    if (out) return out.startsWith('~') ? path.join(os.homedir(), out.slice(1)) : out;
  } catch { /* 未自定义 → 默认桌面 */ }
  return path.join(os.homedir(), 'Desktop');
}
let shotWatcher = null;
const shotSent = new Map(); // path -> t，fs.watch 同一文件会连发多个事件，3s 内去重
function startShotWatch() {
  if (process.platform !== 'darwin' || shotWatcher) return;
  const dir = screenshotDir();
  if (!fs.existsSync(dir)) return;
  try {
    shotWatcher = fs.watch(dir, { persistent: false }, (evt, filename) => {
      const name = filename ? filename.toString() : '';
      // 截屏写盘有「.截屏xxx.png」点前缀的中间态，跳过；只认系统截屏的命名习惯
      if (!/^(截屏|截圖|截图|Screenshot|Screen Shot|CleanShot|SCR-)/i.test(name) || !/\.(png|jpe?g)$/i.test(name)) return;
      const fp = path.join(dir, name);
      // 等写盘「真正完成」再通知：Retina 全屏截图有几 MB，固定等 600ms 可能文件还在写，
      // 缩略图会拿到半截文件生成失败→裂图。改成轮询直到大小连续两次不变（最多 ~3s）。
      const waitStable = (tries, lastSize) => {
        fs.stat(fp, (err, st) => {
          if (err || !st.isFile()) return;
          if (st.size >= 1000 && st.size === lastSize) { // 大小稳定 = 写完
            const last = shotSent.get(fp) || 0;
            if (Date.now() - last < 3000) return;
            shotSent.set(fp, Date.now());
            if (shotSent.size > 50) { const k = shotSent.keys().next().value; shotSent.delete(k); }
            if (win && !win.isDestroyed()) win.webContents.send('shot:new', { path: fp, name, size: st.size });
            return;
          }
          if (tries > 0) setTimeout(() => waitStable(tries - 1, st.size), 250); // 还在涨，再等
        });
      };
      setTimeout(() => waitStable(12, -1), 350);
    });
  } catch { /* 无权限等，静默放弃 */ }
}

// ---------- 更新检测：查 GitHub Releases，有新版本通知渲染层 ----------
// 有没有新版仍靠下面的 GitHub 查询（老 Release 没有 latest-mac.yml，只有这条路知道）；
// 能不能自动装由 probeAutoUpdate 用 electron-updater 回答（#26），装不了退回应用内下载 dmg
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
const REL_PAGE = 'https://github.com/alchaincyf/fanbox/releases/latest';
let latestReleaseError = '';
async function fetchLatestRelease() {
  latestReleaseError = '';
  // 先走 API（信息全）；代理共享出口 IP 很容易吃 GitHub API 的未认证限流（60 次/小时/IP，403），
  // 失败就退回抓 releases/latest 网页重定向——重定向后的 URL 自带 tag，且不占 API 配额
  try {
    const res = await net.fetch('https://api.github.com/repos/alchaincyf/fanbox/releases/latest', {
      headers: { 'User-Agent': 'fanbox-app', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const rel = await res.json();
      // 顺带带上资产清单（网页兜底那条路拿不到，那时为 null 表示「不知道」）
      if (rel.tag_name) return { tag: rel.tag_name, url: rel.html_url || REL_PAGE, assets: (rel.assets || []).map((a) => a.name) };
    }
    latestReleaseError = (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) ? `GitHub API限流（HTTP ${res.status}）` : `GitHub API HTTP ${res.status}`;
  } catch { latestReleaseError = 'GitHub API网络连接失败或超时'; }
  const res = await net.fetch(REL_PAGE, { headers: { 'User-Agent': 'fanbox-app' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) { latestReleaseError += `；发布页HTTP ${res.status}`; return null; }
  const m = String(res.url || '').match(/\/releases\/tag\/([^/?#]+)/);
  if (m) return { tag: decodeURIComponent(m[1]), url: res.url, assets: null };
  return null;
}
let pendingUpdate = null; // 渲染层晚注册监听也能拉到（启动 6 秒的推送 vs init 加载大目录，谁先谁后说不准）
let latestAssets = null; // 最新 Release 的资产文件名清单；null = 没拿到（走了网页兜底），此时不拦下载
let updRetry = 0;
let lastAutoCheck = 0;
async function checkUpdate(opts) {
  const manual = !!(opts && opts.manual);
  if (!manual) lastAutoCheck = Date.now();
  let info = null;
  try { info = await fetchLatestRelease(); } catch { info = null; }
  if (!info) {
    if (manual) {
      const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
        type: 'warning', buttons: [M('打开下载页', 'Open download page'), M('关闭', 'Close')], defaultId: 0, cancelId: 1, message: M('检查更新失败', 'Update check failed'),
        detail: `${latestReleaseError || M('网络连接失败或超时', 'Network connection failed or timed out')}\n${REL_PAGE}`,
      });
      if (choice === 0) shell.openExternal(REL_PAGE);
    } else if (updRetry < 3) { updRetry++; setTimeout(checkUpdate, 10 * 60 * 1000); } // 失败别干等 12 小时
    return;
  }
  updRetry = 0;
  const newer = cmpVer(info.tag, app.getVersion()) > 0;
  if (newer) {
    latestAssets = Array.isArray(info.assets) ? info.assets : null;
    // 探测完再落 pendingUpdate：渲染层启动时会主动 get() 一次，探测中途给它 auto:false 会先弹出 dmg 胶囊，
    // 随后真正的推送因为「胶囊已存在」被跳过，用户就见不到「更新」按钮
    const auto = await probeAutoUpdate();
    pendingUpdate = { version: info.tag.replace(/^v/, ''), url: info.url, auto };
    if (win && !win.isDestroyed()) win.webContents.send('update:available', pendingUpdate);
  }
  if (manual) {
    const owner = win && !win.isDestroyed() ? win : undefined;
    if (newer) {
      const auto = pendingUpdate.auto;
      const c = dialog.showMessageBoxSync(owner, {
        type: 'info', buttons: [auto ? M('更新', 'Update') : M('去下载', 'Download'), M('取消', 'Cancel')], defaultId: 0, cancelId: 1,
        message: M(`发现新版本 v${pendingUpdate.version}`, `New version v${pendingUpdate.version} available`),
        detail: auto
          ? M(`当前版本 v${app.getVersion()}。点「更新」在后台下载，下完重启一次就换好了。`, `You are on v${app.getVersion()}. "Update" downloads in the background; restart once to finish.`)
          : M(`当前版本 v${app.getVersion()}。点「去下载」打开发布页，下载后替换 /Applications 里的旧版即可。`, `You are on v${app.getVersion()}. "Download" opens the release page; replace the old app in /Applications.`),
      });
      // 自动更新：让渲染层弹出胶囊并直接开始下载（manual 绕过「这个版本不再提醒」）
      if (c === 0 && auto && win && !win.isDestroyed()) win.webContents.send('update:available', { ...pendingUpdate, manual: true, start: true });
      else if (c === 0) shell.openExternal(pendingUpdate.url);
    } else {
      dialog.showMessageBoxSync(owner, {
        type: 'info', buttons: [M('好', 'OK')], message: M('已是最新版本', 'You are up to date'),
        detail: M(`当前版本 v${app.getVersion()} 就是最新发布版。`, `v${app.getVersion()} is the latest release.`),
      });
    }
  }
}
ipcMain.handle('update:open', (e, { url }) => { if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url); });
ipcMain.handle('update:get', () => pendingUpdate);

// #26 全自动更新：electron-updater 读 Release 里的 latest-mac.yml，下载同架构 zip，Squirrel.Mac 原地换包，
// 重启即完成（没点「重启安装」的话，下次退出 app 时也会装上）。2.4.1 起是 Developer ID 签名 + 公证，签名校验过得了。
// 只在打包后的 app 里生效；开发实例和依赖缺失时只剩 dmg 下载。
// 联调用：FANBOX_UPDATE_FEED=http://127.0.0.1:端口/ 指向放着 latest-mac.yml + zip 的目录，不用真发 Release
const sendUpd = (m) => { if (win && !win.isDestroyed()) win.webContents.send('update:progress', m); };
let updReady = false, updInstalling = false;
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.logger = null;
  if (process.env.FANBOX_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.FANBOX_UPDATE_FEED });
  autoUpdater.on('download-progress', (p) => sendUpd({ state: 'downloading', pct: Math.floor(p.percent || 0) }));
  autoUpdater.on('update-downloaded', () => { updReady = true; sendUpd({ state: 'ready' }); });
} catch { /* 没装 electron-updater 就走 dmg */ }
// 这个 Release 能不能自动装：拿得到 yml，且有当前架构能用的 zip（Intel 机器上 arm64 包不算，electron-updater 也会排除它）
async function probeAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return false;
  try {
    const r = await autoUpdater.checkForUpdates();
    if (!r || !r.isUpdateAvailable) return false;
    const arm = process.arch === 'arm64';
    return (r.updateInfo.files || []).some((f) => /\.zip$/i.test(f.url) && (arm || !/arm64/i.test(f.url)));
  } catch { return false; }
}
ipcMain.handle('update:install', async () => {
  if (!autoUpdater || !pendingUpdate || !pendingUpdate.auto) return { ok: false, error: 'no-auto' };
  if (updReady) return { ok: true, ready: true };
  if (updInstalling) return { ok: false, error: 'busy' };
  updInstalling = true;
  try { await autoUpdater.downloadUpdate(); updReady = true; return { ok: true, ready: true }; }
  catch (err) { const msg = String((err && err.message) || err); sendUpd({ state: 'error', error: msg }); return { ok: false, error: msg }; }
  finally { updInstalling = false; }
});
ipcMain.handle('update:restart', () => {
  if (!updReady || !autoUpdater) return { ok: false };
  isQuitting = true; // 和菜单退出同款：红叉只是隐藏窗口，这里要真退。agent 正在干活时 before-quit 照常拦一道确认
  autoUpdater.quitAndInstall();
  return { ok: true };
});

// #26 应用内下载更新：按当前架构拼 dmg 资产地址（发布产物统一 FanBox-<版本>-<arch>.dmg），
// 下到 ~/Downloads 后直接打开挂载，拖进 Applications 即完成。全自动安装（Squirrel）仍要等 Developer ID 签名
let updDownloading = false;
ipcMain.handle('update:download', async (e, { version }) => {
  if (updDownloading) return { ok: false, error: 'busy' };
  const ver = String(version || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(ver)) return { ok: false, error: 'bad version' };
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `FanBox-${ver}-${arch}.dmg`;
  // 这个 Release 没发当前架构的包时（x64 产物最后一次是 v2.5.0），别甩个必然 404 的地址给用户：
  // 直接开发布页，让渲染层说明一句。资产清单没拿到（走了网页兜底）就不拦，照旧试下载
  if (latestAssets && pendingUpdate && pendingUpdate.version === ver && !latestAssets.includes(name)) {
    shell.openExternal(pendingUpdate.url || REL_PAGE);
    return { ok: false, error: 'no-asset', arch };
  }
  const url = `https://github.com/alchaincyf/fanbox/releases/download/v${ver}/${name}`;
  const dest = path.join(app.getPath('downloads'), name);
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send('update:progress', m); };
  updDownloading = true;
  const tmp = dest + '.part';
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'fanbox-app' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(tmp);
    let got = 0, lastPct = -1;
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      got += buf.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== lastPct) { lastPct = pct; send({ state: 'downloading', pct }); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    await fs.promises.rename(tmp, dest);
    send({ state: 'done', file: dest });
    shell.openPath(dest);
    return { ok: true, file: dest };
  } catch (err) {
    fs.promises.unlink(tmp).catch(() => {});
    send({ state: 'error', error: String((err && err.message) || err) });
    return { ok: false, error: String((err && err.message) || err) };
  } finally { updDownloading = false; }
});

// 点完成通知把 app 拉到前台（渲染层 window.focus() 唤不醒最小化/被遮挡的窗口）
ipcMain.handle('win:focus', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Dock 角标：渲染层的指挥台算出「几个会话在等你」，窗口被遮住/最小化时还能从 Dock 一眼看到。空串即清空
ipcMain.handle('win:badge', (e, { text }) => {
  if (process.platform !== 'darwin' || !app.dock) return;
  try { app.dock.setBadge(String(text || '')); } catch { /* */ }
});

// 系统通知闸门：macOS 上 FanBox 第一次发通知时，要不要问「允许通知」由系统决定——agent 收工 / 等确认多半发生在你没看着的时候，
// 不能让授权框在后台突然冒出来。只有系统里已登记过 FanBox 的通知设置（允许、拒绝都算，之后不会再问），
// 或你在设置面板亲手开过，才发系统通知；否则提醒只留在应用内（提示音、指挥台、Dock 角标、终端按钮红点）。只读登记，不碰系统设置
let ncCache = { t: 0, v: false };
function notifyRegistered() {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  if (Date.now() - ncCache.t < 60000) return Promise.resolve(ncCache.v);
  let id = '';
  try { id = (fs.readFileSync(path.join(path.dirname(process.execPath), '..', 'Info.plist'), 'utf8').match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || ''; } catch { /* */ }
  return new Promise((resolve) => require('child_process').execFile('/usr/bin/defaults', ['export', 'com.apple.ncprefs', '-'], { timeout: 3000, maxBuffer: 16 << 20 }, (err, out) => {
    const v = !err && !!id && new RegExp(`<key>bundle-id</key>\\s*<string>${id.replace(/\./g, '\\.')}</string>`).test(String(out));
    ncCache = { t: Date.now(), v }; resolve(v);
  }));
}
ipcMain.handle('notify:state', async () => {
  const pref = readConfig().systemNotify; // true = 亲手开过，false = 亲手关了，undefined = 没表过态
  const registered = await notifyRegistered();
  return { on: pref === false ? false : (pref === true || registered), pref: typeof pref === 'boolean' ? pref : null, registered };
});
ipcMain.handle('notify:set', (e, { on } = {}) => { writeConfig({ systemNotify: !!on }); return { ok: true }; });

// 预览全屏时藏掉左上角红黄绿系统按钮——它和右侧自家关闭图标太像，容易让人误点
ipcMain.handle('win:traffic', (e, { show }) => {
  if (!win || win.isDestroyed() || typeof win.setWindowButtonVisibility !== 'function') return;
  win.setWindowButtonVisibility(!!show);
});

// 界面语言：用户手动选过的存在 ~/.fanbox/config.json（渲染层切换时写入），没选过跟随系统
function uiLang() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.fanbox', 'config.json'), 'utf8'));
    if (c.lang === 'zh' || c.lang === 'en') return c.lang;
  } catch { /* 没配置过 */ }
  return String(app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
const M = (zh, en) => (uiLang() === 'zh' ? zh : en);

// ---------- 合盖继续运行（禁用合盖休眠）----------
// macOS 的「合盖休眠」是独立机制，caffeinate / powerSaveBlocker 这类 power assertion 都挡不住，
// 唯一手段是 `pmset -a disablesleep 1`（需 root）。为避免智能模式反复弹密码，首次开启时装一条
// 仅限 pmset disablesleep 0/1 的 sudoers 免密规则，之后静默切换。
// 智能模式：只有「开关开 且 有终端在跑」才真正禁休眠；终端全退/退出 app 立即恢复，绝不让 Mac 一直不睡。
const CONFIG = path.join(os.homedir(), '.fanbox', 'config.json');
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } }
function writeConfig(patch) {
  try { const c = readConfig(); Object.assign(c, patch); fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); }
  catch { /* 写失败不致命，下次再写 */ }
}
let lidIntent = false; // 用户意图（侧栏/菜单勾选），跨会话持久
let lidActive = false; // 当前是否已对系统下达禁休眠
let wechatStayAwake = false; // 「微信遥控不断线」开关，跨会话持久
let wechatConnected = false; // 微信 ClawBot 当前是否连着（bridge 回调更新）

// ---- agent 工作状态检测：前台不是裸 shell = 终端里有东西在跑（和微信 termControl 同一判据）----
const BARE_SHELL = /^-?(zsh|bash|sh|fish|login)$/i;
// 正在干活的 agent 终端清单：休眠守卫与退出确认共用同一份判据，两边不会各说各话
function activeAgentTerms() {
  const out = [];
  for (const [id, p] of terminals) {
    // 有官方 hook 事实的终端只认它说的：claude 空闲等输入时前台进程仍是 claude，旧判据会一直「忙」不让 Mac 睡
    const f = termFacts.get(id);
    if (f) {
      // 等审批也算干活中——任务在半途，杀掉就是半截；等输入/已完成的空闲 agent 不算
      if (f.state === 'working' || f.state === 'needs_permission') out.push({ id, label: f.agent || (p && p.process) || id });
      continue;
    }
    const proc = (p && p.process) || '';
    if (proc && !BARE_SHELL.test(proc)) out.push({ id, label: proc });
  }
  return out;
}
function termBusyAny() { return activeAgentTerms().length > 0; }
// 收工不立刻放行休眠：agent 工具调用间隙 / 刚跑完下一句还没起，留 2 分钟缓冲防误判
const IDLE_GRACE_MS = 2 * 60 * 1000;
let lastBusyAt = 0;
let lidPoke = null; // 终端一有输出就尽快结算（1s 去抖），刚启动的 agent 不用等 30s 轮询才被护住
function termsBusyRecently() {
  if (termBusyAny()) { lastBusyAt = Date.now(); return true; }
  return lidActive && Date.now() - lastBusyAt < IDLE_GRACE_MS;
}

// 电源状态汇总：渲染层侧栏开关 + 状态点都吃这一份
function powerPayload() {
  const busy = termBusyAny();
  return {
    ok: true, platform: process.platform,
    lid: lidIntent, wechat: wechatStayAwake, active: lidActive,
    busy, terms: terminals.size, wechatConnected,
    // 分条「正在生效」判定，侧栏状态点直接用（lid 侧含收工缓冲期）
    lidHolding: lidIntent && terminals.size > 0 && (busy || (lidActive && Date.now() - lastBusyAt < IDLE_GRACE_MS)),
    wechatHolding: wechatStayAwake && wechatConnected,
  };
}
function sendPower() {
  if (win && !win.isDestroyed()) win.webContents.send('power:changed', powerPayload());
}

// 用 sudo -n（非交互）切换；sudoers 没装好就直接失败、绝不在后台弹密码
function trySetDisableSleep(on) {
  if (process.platform !== 'darwin') return false;
  // stdio 全静音：免密规则没装时 `sudo -n` 会往 stderr 喷「a password is required」，无害但会误导
  try { require('child_process').execFileSync('/usr/bin/sudo', ['-n', 'pmset', '-a', 'disablesleep', on ? '1' : '0'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// 首次开启时弹一次系统管理员框，装仅限本用户、仅限 pmset disablesleep 0/1 的免密规则
function installSudoers() {
  return new Promise((resolve) => {
    const user = (os.userInfo().username || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!user) return resolve(false);
    const sh = [
      '#!/bin/sh', 'set -e',
      'f=/etc/sudoers.d/fanbox-pmset',
      "cat > \"$f\" <<'EOF'",
      `${user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1`,
      'EOF',
      'chown root:wheel "$f"',
      'chmod 440 "$f"',
      '/usr/sbin/visudo -cf "$f" || { rm -f "$f"; exit 1; }',
      '',
    ].join('\n');
    let tmp;
    try { tmp = path.join(app.getPath('temp'), 'fanbox-sudoers-install.sh'); fs.writeFileSync(tmp, sh, { mode: 0o700 }); }
    catch { return resolve(false); }
    const apple = `do shell script "/bin/sh " & quoted form of "${tmp}" with administrator privileges`;
    console.log('[lid] running osascript admin prompt, tmp =', tmp);
    require('child_process').execFile('/usr/bin/osascript', ['-e', apple], (err, stdout, stderr) => {
      console.log('[lid] osascript done. err =', err && err.message, '| stderr =', stderr);
      try { fs.unlinkSync(tmp); } catch { /* */ }
      resolve(!err); // 用户取消 → err（-128）→ false
    });
  });
}

// 确保 pmset 免密规则就位（探针：设 0 无害；不行就装一次规则）。两个开关共用。
async function ensurePmsetRule() {
  if (process.platform !== 'darwin') return false;
  if (trySetDisableSleep(false)) return true; // 已有免密规则
  return installSudoers();
}

// 按「意图 × 触发条件」结算系统状态，幂等。终端起落、agent 忙闲轮询、微信连断、开关变化都调它。
//  两条独立诉求 OR 起来：① 合盖继续干活（要有 agent 正在干活）② 微信遥控不断线（微信连着就保持唤醒，断开自动恢复）
function refreshLidGuard() {
  if (process.platform !== 'darwin') return;
  const want = (lidIntent && terminals.size > 0 && termsBusyRecently()) || (wechatStayAwake && wechatConnected);
  if (want !== lidActive) {
    const ok = trySetDisableSleep(want);
    if (want && !ok) { // 免密规则丢了，两个开关都退回关闭，别让用户以为还护着
      lidIntent = false; wechatStayAwake = false;
      writeConfig({ lidStayAwake: false, wechatStayAwake: false });
    }
    lidActive = want && ok;
    buildMenu();
  }
  sendPower();
}

// 侧栏开关 / 菜单勾选共用的入口
async function setLidIntent(on) {
  console.log('[lid] setLidIntent called, on =', on);
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS only' };
  if (on) {
    const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', buttons: [M('开启', 'Enable'), M('取消', 'Cancel')], defaultId: 0, cancelId: 1,
      message: M('Agent 干活时，合盖继续', 'Keep working with lid closed'),
      detail: M('翻箱能看到每个终端窗口的工作状态。开启后：只要检测到有 agent 正在干活，合上盖子也不休眠，任务接着跑；所有终端都空闲约两分钟后，自动恢复正常休眠——不会让 Mac 一直不睡。\n\n注意：合盖期间持续耗电发热，建议接电源。\n\n首次开启需输入一次管理员密码（装一条仅限电源设置的免密规则）。',
        'FanBox watches what each terminal is doing. When any agent is actively working, closing the lid won\'t sleep the Mac — the task keeps going. Once every terminal has been idle for ~2 minutes, normal sleep resumes automatically.\n\nNote: it keeps drawing power and heat while closed; stay plugged in.\n\nFirst time needs your admin password once (installs a power-only passwordless rule).'),
    });
    console.log('[lid] warning dialog choice =', choice, '(0=开启)');
    if (choice !== 0) { buildMenu(); sendPower(); return { ok: false, error: 'cancelled' }; } // 取消 → 复位勾选
    // 探针：能否免密 sudo（设 0 无害）。不行就装规则。
    const probe = trySetDisableSleep(false);
    console.log('[lid] sudo probe ok =', probe, '→', probe ? '已有免密规则' : '需安装');
    if (!probe) {
      const installed = await installSudoers();
      console.log('[lid] installSudoers result =', installed);
      if (!installed) { buildMenu(); sendPower(); return { ok: false, error: 'setup-cancelled' }; } // 装失败/取消 → 保持关闭
    }
  }
  lidIntent = !!on;
  writeConfig({ lidStayAwake: !!on });
  refreshLidGuard();
  buildMenu();
  return { ok: true, on: lidIntent };
}

// 侧栏「离开电脑」两个开关的 IPC（微信开关的 handler 在下方微信段，要联动 bridge）
ipcMain.handle('power:state', () => powerPayload());
ipcMain.handle('power:setLid', async (e, { on } = {}) => {
  const r = await setLidIntent(!!on);
  return { ...powerPayload(), ...r };
});

// ---------- 权限体检（macOS）----------
// 终端里的 agent 要截屏、要控制别的 app，权限算在 FanBox 头上（TCC 的 responsible 就是本 app，
// node-pty 起的 zsh 会正确继承）。但 TCC 的授权记录是按「服务 + bundle id + 代码签名要求」存的：
// 换过签名证书之后（开发者账号升级、换 Team），旧记录的签名要求再也匹配不上当前 app，
// 系统按「从未授权」处理 → 每次都弹窗。而系统设置里那一条仍然打着勾——它只读 auth_value，
// 从不校验签名要求。于是「明明已经开了」和「每次都被拒」同时成立，肉眼无从分辨，
// 更要命的是在设置里取关再勾回来只改 auth_value、改不动签名要求，怎么点都没用。
// 这里主动把真实状态问出来，并给出唯一有效的那条出路：删掉记录重新授权。
const PERM_SERVICES = ['ScreenCapture', 'Accessibility', 'AppleEvents'];
function permStatus() {
  return {
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    a11y: systemPreferences.isTrustedAccessibilityClient(false), // false = 只查询，不弹系统提示
  };
}
function checkPermissions() {
  const s = permStatus();
  const ok = (v) => (v ? M('✅ 已生效', '✅ working') : M('❌ 未生效', '❌ not working'));
  const detail = [
    `${M('屏幕录制', 'Screen Recording')}：${ok(s.screen)}`,
    `${M('辅助功能', 'Accessibility')}：${ok(s.a11y)}`,
  ].join('\n');
  if (s.screen && s.a11y) {
    dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
      type: 'info', message: M('权限正常', 'Permissions OK'), detail,
    });
    return;
  }
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: [M('取消', 'Cancel'), M('清除记录并退出', 'Clear records and quit')],
    defaultId: 1,
    cancelId: 0,
    message: M('有权限没生效', 'Some permissions are not working'),
    detail: `${detail}\n\n` + M(
      '如果「系统设置 → 隐私与安全性」里 FanBox 明明是打勾的，那是一条换签名后失效的旧记录。'
      + '在设置里取关再勾回来改不动它——只能删掉记录重新授权。\n\n'
      + '点「清除记录并退出」会清掉 FanBox 的授权记录并完全退出（屏幕录制权限对已运行的进程不生效，'
      + '而点左上角红叉只是隐藏窗口、进程还活着，必须真退出）。重新打开后让 agent 再跑一次截屏，'
      + '这次弹窗点允许，记录就会按当前签名重建。',
      'If FanBox appears checked under System Settings → Privacy & Security, that is a stale record '
      + 'left behind by a signing-certificate change. Toggling it there cannot fix it — the record has to be removed.\n\n'
      + 'Clearing will remove FanBox\'s TCC records and quit completely (screen-recording permission never applies to '
      + 'an already-running process, and the red close button only hides the window). Reopen, trigger a screenshot '
      + 'again, and approve the prompt — the record will be rebuilt against the current signature.',
    ),
  });
  if (choice !== 1) return;
  const failed = [];
  for (const svc of PERM_SERVICES) {
    // 记录不存在时 tccutil 也返回成功，多清一个无害
    try { require('child_process').execFileSync('/usr/bin/tccutil', ['reset', svc, 'com.huashu.fanbox'], { stdio: 'ignore' }); }
    catch { failed.push(svc); }
  }
  if (failed.length) {
    dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
      type: 'error', message: M('清除失败', 'Reset failed'),
      detail: M(`这几项没能清掉：${failed.join('、')}\n手动跑一次：\n`, `Could not reset: ${failed.join(', ')}\nRun manually:\n`)
        + failed.map((s2) => `tccutil reset ${s2} com.huashu.fanbox`).join('\n'),
    });
    return;
  }
  quitConfirmed = true; // 已经当面确认过一次了，别再问「还有终端在跑」
  isQuitting = true;
  app.quit();
}

// 原生菜单——关键是 Edit role，终端里的 ⌘C/⌘V 才生效
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: 'FanBox', submenu: [
      { role: 'about', label: M('关于 FanBox', 'About FanBox') },
      { label: M('检查更新…', 'Check for Updates…'), click: () => checkUpdate({ manual: true }) },
      { label: M('权限体检…', 'Check Permissions…'), click: () => checkPermissions() },
      { type: 'separator' },
      { role: 'hide', label: M('隐藏 FanBox', 'Hide FanBox') }, { role: 'hideOthers', label: M('隐藏其他', 'Hide Others') }, { role: 'unhide', label: M('全部显示', 'Show All') },
      { type: 'separator' },
      { role: 'quit', label: M('退出 FanBox', 'Quit FanBox') },
    ] }] : []),
    { label: M('文件', 'File'), submenu: [
      ...(isMac ? [] : [{ label: M('检查更新…', 'Check for Updates…'), click: () => checkUpdate({ manual: true }) }, { type: 'separator' }]),
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: M('编辑', 'Edit'), submenu: [
      { role: 'undo', label: M('撤销', 'Undo') }, { role: 'redo', label: M('重做', 'Redo') }, { type: 'separator' },
      { role: 'cut', label: M('剪切', 'Cut') }, { role: 'copy', label: M('复制', 'Copy') }, { role: 'paste', label: M('粘贴', 'Paste') },
      { role: 'selectAll', label: M('全选', 'Select All') },
    ] },
    { label: M('视图', 'View'), submenu: [
      { role: 'reload', label: M('重新加载', 'Reload') }, { role: 'toggleDevTools', label: M('开发者工具', 'Developer Tools') },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen', label: M('全屏', 'Full Screen') },
      ...(isMac ? [{ type: 'separator' }, {
        // 合盖继续干活：仅在检测到 agent 正在干活时真正生效（智能模式）；勾选状态反映用户意图。
        // 侧栏也有这个开关（高频），两边读同一份 power:state、改完都广播 power:changed，勾选不会打架
        label: lidActive ? M('合盖继续干活（生效中）', 'Keep working with lid closed (active)') : M('合盖继续干活', 'Keep working with lid closed'),
        type: 'checkbox', checked: lidIntent,
        click: (item) => { setLidIntent(item.checked); },
      }, {
        // 微信遥控不断线：从侧栏「离开电脑」区块挪进来，和上一项成对。开关本体是下方微信段的
        // power:setWechat handler（要联动 bridge），这里借渲染层的 preload 桥绕一圈调它，不动那段代码；
        // 取消 / 失败时 handler 不会重建菜单，所以回来自己 buildMenu 一次把勾选复位
        label: (wechatStayAwake && wechatConnected) ? M('微信遥控不断线（生效中）', 'Stay awake for WeChat (active)') : M('微信遥控不断线', 'Stay awake for WeChat'),
        type: 'checkbox', checked: wechatStayAwake,
        click: (item) => {
          const p = win && !win.isDestroyed() ? win.webContents.executeJavaScript(`window.fanboxPower && window.fanboxPower.setWechat(${!!item.checked})`, true) : Promise.resolve();
          p.catch(() => {}).then(() => buildMenu());
        },
      }] : []),
    ] },
    { role: 'window', label: M('窗口', 'Window'), submenu: [{ role: 'minimize', label: M('最小化', 'Minimize') }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win && !win.isDestroyed()) { win.show(); win.focus(); } // 从 Dock 点回来：显示隐藏的窗口，状态原样还在
});
// ⌘Q 兜底：还有终端在跑时（agent 任务），退出前确认，避免手滑全灭
let quitConfirmed = false;
let isQuitting = false; // 真正退出（⌘Q / 菜单退出）才置真；点红叉只隐藏不退出，见 win.on('close')
app.on('before-quit', (e) => {
  // 只拦「agent 正在干活」的情况：开着的裸 shell、停在提示符等输入的 claude 都不算——
  // 从前按「有没有终端开着」拦，每次退出都要多点一下，久了确认框就成了噪音
  const active = quitConfirmed ? [] : activeAgentTerms();
  if (active.length === 0) { isQuitting = true; return; }
  e.preventDefault();
  const names = active.map((a) => a.label).join('、');
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: [M('取消', 'Cancel'), M('退出', 'Quit')],
    defaultId: 0,
    cancelId: 0,
    message: M(`还有 ${active.length} 个 agent 正在干活`, `${active.length} agent(s) still working`),
    detail: M(`${names}\n\n退出会终止这些任务，确定退出？`, `${names}\n\nQuitting will terminate these tasks. Quit anyway?`),
  });
  if (choice === 1) { quitConfirmed = true; isQuitting = true; app.quit(); }
});
app.on('window-all-closed', () => {
  terminals.forEach((p) => { try { p.kill(); } catch { /* */ } });
  terminals.clear();
  if (lidActive) { trySetDisableSleep(false); lidActive = false; } // 终端没了，别让 Mac 一直不睡
  recorders.forEach((r) => { try { r.stream.end(); } catch { /* */ } }); // 收尾刷盘，别丢最后几行
  recorders.clear();
  if (process.platform !== 'darwin') app.quit();
});
// 退出兜底：无论怎么退（⌘Q、崩溃前的正常退出），都恢复系统休眠，绝不留禁休眠的烂摊子
app.on('will-quit', () => {
  if (process.platform === 'darwin') trySetDisableSleep(false);
  try { if (backendProc) backendProc.kill(); } catch { /* 已死 */ }
});

// ---------- 终端录制（黑匣子）：把 PTY 字节流旁路成 asciinema v2 .cast ----------
// 设计铁律：录制器是一根哑管子——只异步旁路字节，全程 try/catch，写失败就静默自废，
// 绝不把异常抛回 PTY 数据通路。所有「聪明」（压缩/变速/导出）都推迟到回放层做。
const recorders = new Map(); // id -> { stream, start, path }
const REC_DIR = () => path.join(app.getPath('userData'), 'recordings');
function recEnabled() { return process.env.FANBOX_NO_RECORD !== '1'; }
// 常开录制不能让磁盘无限涨：保留最近 60 个 / 总量 800MB，超了从最旧删起（正在录的跳过）
function recPrune() {
  try {
    const dir = REC_DIR();
    if (!fs.existsSync(dir)) return;
    const live = new Set([...recorders.values()].map((r) => r.path));
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.cast'))
      .map((n) => path.join(dir, n)).filter((f) => !live.has(f))
      .map((f) => { try { return { f, st: fs.statSync(f) }; } catch { return null; } }).filter(Boolean)
      .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs); // 旧→新
    const MAX_FILES = 60, MAX_BYTES = 800 * 1024 * 1024;
    let total = files.reduce((s, x) => s + x.st.size, 0), count = files.length;
    for (const x of files) {
      if (count <= MAX_FILES && total <= MAX_BYTES) break;
      try { fs.rmSync(x.f, { force: true }); total -= x.st.size; count--; } catch { /* */ }
    }
  } catch { /* */ }
}
function recStart(id, { cols, rows, cwd, theme }) {
  if (!recEnabled()) return;
  try {
    const dir = REC_DIR();
    fs.mkdirSync(dir, { recursive: true });
    recPrune();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${id}.cast`);
    const stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { try { recorders.delete(id); } catch { /* */ } }); // 盘满/权限等：自废，不连累终端
    const header = {
      version: 2, width: cols || 80, height: rows || 24,
      timestamp: Math.floor(Date.now() / 1000), env: { TERM: 'xterm-256color' },
      // fanbox 私有元信息：回放/列表用，asciinema 标准解析器会忽略未知字段
      fanbox: { cwd: cwd || '', cols: cols || 80, rows: rows || 24, startedAt: Date.now(), theme: theme || '' },
    };
    stream.write(JSON.stringify(header) + '\n');
    recorders.set(id, { stream, start: Date.now(), path: file });
  } catch { /* 录制失败静默自废 */ }
}
function recEvent(id, code, data) {
  const r = recorders.get(id);
  if (!r) return;
  try { r.stream.write(JSON.stringify([(Date.now() - r.start) / 1000, code, data]) + '\n'); }
  catch { /* */ }
}
function recStop(id) {
  const r = recorders.get(id);
  if (!r) return;
  recorders.delete(id);
  try { r.stream.end(); } catch { /* */ }
}

// ---------- 终端 IPC（node-pty）----------
ipcMain.handle('pty:spawn', (e, { id, cwd, cols, rows, theme }) => {
  if (!pty) return { ok: false, error: 'node-pty 未编译，跑：npm run rebuild' };
  const shellPath = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
  const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // login shell（-l）：GUI 启动的进程只继承精简 PATH，不读 .zprofile/.zlogin，
  // 用户在那里配的 Homebrew/nvm/npm 全局路径（claude 等）就丢了 → 「普通终端能找到、fanbox 找不到」。
  // 走 login shell 把这些路径带进来。Windows 的 powershell 无此机制，保持空参数。
  const shellArgs = process.platform === 'win32' ? [] : ['-l'];
  // GUI 启动的 app 不继承 shell 的 locale，zsh 会把中文路径按字节转义成 \M-^@ 乱码 → 兜底 UTF-8
  const env = {
    ...process.env, TERM: 'xterm-256color', FANBOX: '1',
    // 终端里的 agent 天生知道自己是几号窗口、控制接口在哪、门票是啥——skill 零配置（见 docs/12）
    FANBOX_TERM_ID: id, FANBOX_CTL: `http://127.0.0.1:${PORT}/api/agent`, FANBOX_CTL_TOKEN: AGENT_TOKEN,
  };
  if (!/UTF-8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) env.LANG = 'zh_CN.UTF-8';
  let p;
  try {
    p = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startCwd,
      env,
    });
  } catch (err) { return { ok: false, error: err.message }; }
  terminals.set(id, p);
  refreshLidGuard(); // 开关开着时，第一个终端起来即生效
  recStart(id, { cols, rows, cwd: startCwd, theme });
  p.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data });
    // 开关开着但还没生效 → 有输出说明可能刚开工，尽快结算电源守卫（1s 去抖）
    if (lidIntent && !lidActive && !lidPoke) lidPoke = setTimeout(() => { lidPoke = null; refreshLidGuard(); }, 1000);
    recEvent(id, 'o', data);
    const stripped = data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB0]|\r/g, '');
    termTails.set(id, ((termTails.get(id) || '') + stripped).slice(-4000)); // 留最后 ~4KB，给微信 agent 看「最近输出」
    termBufs.set(id, ((termBufs.get(id) || '') + stripped).slice(-200000)); // 大缓冲给 /api/agent/read
    termLastOut.set(id, Date.now());
    const ws = termWaiters.get(id);
    if (ws) for (const fn of ws) { try { fn(stripped); } catch { /* 单个 waiter 异常不连累别人 */ } }
  });
  p.onExit(({ exitCode }) => {
    terminals.delete(id);
    termTails.delete(id);
    termBufs.delete(id);
    termLastOut.delete(id);
    termFacts.delete(id);
    refreshLidGuard(); // 最后一个终端退出即恢复休眠
    recStop(id);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode });
  });
  return { ok: true, cwd: startCwd };
});
// ---------- 剪贴板：复制图片本体 / 复制文件（访达可粘贴）----------
ipcMain.handle('clip:image', (e, { path: p }) => {
  try { const img = nativeImage.createFromPath(p); if (img.isEmpty()) return { ok: false, error: '不是可读图片' }; clipboard.writeImage(img); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
// 终端粘贴：⌘V 时问一句剪贴板里到底是什么。
// 文字照常回文字；网页/微信里复制的图片没有路径，落盘临时目录换一个路径回去——
// 终端里的 agent 只认路径，图片本体塞不进 PTY。访达里 ⌘C 的文件同理，直接给真实路径。
ipcMain.handle('clip:read', () => {
  try {
    const text = clipboard.readText();
    if (text) return { kind: 'text', text }; // 文字优先：表格类应用同时放文字和位图，别把复制的表格粘成图片路径
    const fileUrl = process.platform === 'darwin' ? clipboard.read('public.file-url') : '';
    if (fileUrl) {
      try {
        const fp = decodeURIComponent(new URL(fileUrl).pathname);
        if (fs.existsSync(fp)) return { kind: 'file', path: fp };
      } catch { /* 不是合法 file:// 就当没有 */ }
    }
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const dir = path.join(app.getPath('temp'), 'fanbox-drops');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date(), z = (x) => String(x).padStart(2, '0');
      const name = `粘贴图片-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.png`;
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, img.toPNG());
      return { kind: 'image', path: dest };
    }
    return { kind: 'empty' };
  } catch (err) { return { kind: 'error', error: err.message }; }
});
ipcMain.handle('clip:file', (e, { path: p }) => new Promise((resolve) => {
  const { execFile } = require('child_process');
  // argv 传路径，避免拼进 AppleScript 字面量被注入
  execFile('osascript', ['-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', p], (err) => resolve({ ok: !err, error: err && err.message }));
}));

// 拖拽落盘：file-promise 类拖入（截图浮窗等）没有真实路径，把字节写进临时目录换路径
ipcMain.handle('drop:save', (e, { name, buf }) => {
  try {
    const dir = path.join(app.getPath('temp'), 'fanbox-drops');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || '拖入文件.png').replace(/[/\\:]/g, '_');
    let dest = path.join(dir, safe);
    if (fs.existsSync(dest)) dest = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(dest, Buffer.from(buf));
    return { ok: true, path: dest };
  } catch (err) { return { ok: false, error: err.message }; }
});
// 同名不覆盖：foo.png 已存在就退而求其次 foo 2.png（仿访达）
function uniqueDest(dest) {
  if (!fs.existsSync(dest)) return dest;
  const d = path.dirname(dest), ext = path.extname(dest), base = path.basename(dest, ext);
  for (let i = 2; i < 1000; i++) { const c = path.join(d, `${base} ${i}${ext}`); if (!fs.existsSync(c)) return c; }
  return path.join(d, `${Date.now()}-${base}${ext}`);
}
// 拖进文件区：把没路径的拖入内容（截图浮窗等）写进目标目录
ipcMain.handle('drop:save-into', (e, { dir, name, buf }) => {
  try {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: '目标目录无效' };
    const safe = String(name || '拖入文件').replace(/[/\\:]/g, '_');
    const dest = uniqueDest(path.join(dir, safe));
    fs.writeFileSync(dest, Buffer.from(buf));
    return { ok: true, path: dest };
  } catch (err) { return { ok: false, error: err.message }; }
});
// 拖进文件区：把已有路径的文件（Finder 文件）复制进目标目录
ipcMain.handle('drop:copy-into', (e, { srcPath, dir }) => {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: '源文件不存在' };
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: '目标目录无效' };
    const dest = uniqueDest(path.join(dir, path.basename(srcPath)));
    if (path.resolve(srcPath) === path.resolve(dest)) return { ok: true, path: dest }; // 原地拖入，无需复制
    fs.copyFileSync(srcPath, dest);
    return { ok: true, path: dest };
  } catch (err) { return { ok: false, error: err.message }; }
});
// md 编辑器「插入图片」按钮：原生系统选图，默认目录是 md 文件所在目录——网页 <input type=file>
// 没有办法指定起始目录，这是唯一能做到的地方，只能走 Electron 自己的 dialog
ipcMain.handle('drop:pick-images', async (e, { defaultPath } = {}) => {
  try {
    const owner = win && !win.isDestroyed() ? win : undefined;
    const r = await dialog.showOpenDialog(owner, {
      title: '选择要插入的图片',
      defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
    });
    if (r.canceled) return { ok: true, paths: [] };
    return { ok: true, paths: r.filePaths };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.on('pty:input', (e, { id, data }) => { const p = terminals.get(id); if (p) { p.write(data); recEvent(id, 'i', data); } });
ipcMain.on('pty:resize', (e, { id, cols, rows }) => { const p = terminals.get(id); if (p) { try { p.resize(cols, rows); } catch { /* */ } recEvent(id, 'r', `${cols}x${rows}`); } });
ipcMain.on('pty:kill', (e, { id }) => { const p = terminals.get(id); if (p) { try { p.kill(); } catch { /* */ } terminals.delete(id); refreshLidGuard(); recStop(id); } });

// ---------- Agent 控制接口：把跨终端感知/控制能力开成本机 HTTP（server.js 的 /api/agent/* 调这里）----------
// 让跑在翻箱终端里的 agent 指挥兄弟窗口：列表/读屏/输入/开窗/等待/关闭。安全模型与接口规范见 docs/12。
const BARE_SHELL_RE = /^-?(zsh|bash|sh|fish|login)$/i;
let agentReqSeq = 0;
const agentCreateWaiters = new Map(); // reqId -> resolve（渲染进程建 tab 的回执）

function agentTouch(id, action) { // 被 agent 控制的 tab 在界面上闪 ⚡：审计 + 围观
  if (win && !win.isDestroyed()) win.webContents.send('agent:touch', { id, action });
}
async function agentList() {
  const arr = [];
  for (const [id, p] of terminals) {
    const proc = (p && p.process) || '';
    const cwd = await termCwdByPid(p && p.pid);
    const f = termFacts.get(id); // hooked 终端的忙闲/状态来自 agent 自己的事件，比看前台进程准
    arr.push({
      id, cwd, name: cwd ? path.basename(cwd) : '', proc,
      busy: f ? f.state === 'working' : !!proc && !BARE_SHELL_RE.test(proc),
      state: f ? f.state : null, hooked: !!f,
      tail: (termTails.get(id) || '').slice(-500),
    });
  }
  return { ok: true, terminals: arr };
}
// 官方 hook 事件入口（/api/agent/event → RPC → 这里）。claude 看 hook_event_name，codex 看 type。
// 状态机：SessionStart/UserPromptSubmit/PreToolUse → working；Notification permission_prompt → needs_permission；
// idle_prompt / agent_needs_input → needs_input；Stop / agent_completed → done；SessionEnd → ended（事实随即清掉，
// 裸 shell 回到旧判据）；codex 的 *turn-complete → done，其他 → working。每个事件都广播给渲染层。
function agentEvent(termId, body) {
  const id = String(termId || '');
  if (!terminals.has(id)) return { ok: false, error: 'no such terminal' };
  const b = body && typeof body === 'object' ? body : {};
  // 先认清是谁的事件再建事实：认不出的 body 不能留下一条空「working」，否则这个终端永远算忙
  const kind = typeof b.hook_event_name === 'string' ? 'claude' : typeof b.type === 'string' ? 'codex' : '';
  if (!kind) return { ok: false, error: 'unknown event' };
  const now = Date.now();
  let f = termFacts.get(id);
  if (!f) termFacts.set(id, f = { agent: kind, sessionId: '', state: 'working', since: now, lastEventAt: now, hooked: true, changed: new Map() });
  let event, state = f.state, file = '';
  if (kind === 'claude') {
    f.agent = 'claude'; event = b.hook_event_name;
    if (b.session_id) f.sessionId = String(b.session_id);
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PreToolUse' || event === 'SubagentStop') state = 'working';
    else if (event === 'Stop') state = 'done';
    else if (event === 'SessionEnd') state = 'ended';
    else if (event === 'Notification') {
      const nt = String(b.notification_type || '');
      if (nt === 'permission_prompt') state = 'needs_permission';
      else if (nt === 'idle_prompt' || nt === 'agent_needs_input') state = 'needs_input';
      else if (nt === 'agent_completed') state = 'done';
      event += ':' + nt;
    } else if (event === 'PostToolUse') {
      state = 'working';
      const tool = String(b.tool_name || '');
      const p = b.tool_input && (b.tool_input.file_path || b.tool_input.notebook_path);
      if (tool !== 'Bash' && typeof p === 'string' && p) { // Bash 不记文件：改了什么它自己也说不清
        file = p;
        const c = f.changed.get(p) || { n: 0, lastAt: 0, tool };
        c.n++; c.lastAt = now; c.tool = tool;
        if (!f.changed.has(p) && f.changed.size >= 500) f.changed.delete(f.changed.keys().next().value);
        f.changed.set(p, c);
      }
    }
  } else {
    f.agent = 'codex'; event = b.type;
    if (b['thread-id']) f.sessionId = String(b['thread-id']);
    state = /turn-(complete|ended)/.test(event) ? 'done' : 'working';
  }
  const changed = state !== f.state;
  if (changed) f.since = now;
  f.state = state; f.lastEventAt = now;
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', { id, state, event, file: file || undefined, agent: f.agent });
  if (state === 'ended') termFacts.delete(id);
  if (changed) refreshLidGuard(); // 收工/开工立刻结算电源守卫，不等 30s 轮询
  return { ok: true, id, state };
}
function agentRead(id, lines) {
  if (!terminals.has(id)) return { ok: false, error: 'no such terminal' };
  const n = Math.max(1, Math.min(2000, lines || 200));
  return { ok: true, id, text: (termBufs.get(id) || '').split('\n').slice(-n).join('\n') };
}
function agentSend(id, text, opts = {}) {
  const p = terminals.get(id);
  if (!p) return { ok: false, error: 'no such terminal' };
  let t = String(text == null ? '' : text);
  if (opts.paste) t = '\x1b[200~' + t + '\x1b[201~'; // bracketed paste：多行文本整块进 TUI，不被逐行提交
  else t = t.replace(/\r\n|\n/g, '\r'); // 换行 → 回车才会真正提交
  if (opts.submit !== false && !/\r$/.test(t)) t += '\r';
  try { p.write(t); recEvent(id, 'i', t); agentTouch(id, 'send'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
function agentCreate(opts = {}) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve({ ok: false, error: 'no window' });
    const reqId = 'ac' + (++agentReqSeq);
    agentCreateWaiters.set(reqId, resolve);
    win.webContents.send('agent:term-create', { reqId, cwd: typeof opts.cwd === 'string' ? opts.cwd : '' });
    setTimeout(() => { if (agentCreateWaiters.delete(reqId)) resolve({ ok: false, error: 'renderer timeout' }); }, 10000);
  }).then(async (r) => {
    if (!r.ok) return r;
    agentTouch(r.id, 'create');
    if (!opts.autorun) return r;
    // 等 shell 就绪（有过输出且静默 ≥400ms）再敲命令，login shell 初始化慢也不怕
    const t0 = Date.now();
    await new Promise((done) => {
      const iv = setInterval(() => {
        const last = termLastOut.get(r.id);
        if ((last && Date.now() - last >= 400) || Date.now() - t0 > 8000) { clearInterval(iv); done(); }
      }, 100);
    });
    const s = agentSend(r.id, String(opts.autorun));
    return { ...r, autorun: s.ok };
  });
}
ipcMain.on('agent:term-created', (e, { reqId, ok, id, error } = {}) => {
  const resolve = agentCreateWaiters.get(reqId);
  if (!resolve) return;
  agentCreateWaiters.delete(reqId);
  resolve(ok && id ? { ok: true, id } : { ok: false, error: error || 'create failed' });
});
function agentWait(id, opts = {}) {
  return new Promise((resolve) => {
    if (!terminals.has(id)) return resolve({ ok: false, error: 'no such terminal' });
    let re = null;
    if (opts.until) {
      try { re = new RegExp(String(opts.until), 'm'); }
      catch { return resolve({ ok: false, error: 'bad regex' }); }
    }
    const idleMs = Math.max(500, Math.min(30000, Number(opts.idleMs) || 2000));
    const timeoutMs = Math.max(1000, Math.min(240000, Number(opts.timeoutMs) || 60000)); // 240s < node requestTimeout(300s)
    const quietMode = opts.idle === 'quiet'; // quiet：只看输出静默（TUI 回答完）；默认还要求前台回到裸 shell
    const started = Date.now();
    let acc = ''; // 只累计 wait 开始后的新输出，正则也只匹配这段
    let set = termWaiters.get(id);
    if (!set) termWaiters.set(id, set = new Set());
    const finish = (extra) => {
      clearInterval(iv); set.delete(onData);
      resolve({ elapsed: Date.now() - started, output: acc.slice(-8000), ...extra });
    };
    const onData = (s) => { acc = (acc + s).slice(-64000); if (re && re.test(acc)) finish({ ok: true, matched: true }); };
    set.add(onData);
    const iv = setInterval(() => {
      const p = terminals.get(id);
      if (!p) return finish({ ok: true, exited: true });
      if (Date.now() - started >= timeoutMs) return finish({ ok: false, timeout: true });
      if (re) return; // until 模式只认正则
      if (Date.now() - (termLastOut.get(id) || started) < idleMs) return;
      const proc = p.process || '';
      if (quietMode || !proc || BARE_SHELL_RE.test(proc)) finish({ ok: true, idle: true });
    }, 200);
  });
}
function agentKill(id) {
  const p = terminals.get(id);
  if (!p) return { ok: false, error: 'no such terminal' };
  try { p.kill(); agentTouch(id, 'kill'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
// server.js 在子进程里经 RPC 桥调这组能力（见 startBackendServer）；token 走 fork env
const agentImpl = { list: agentList, read: agentRead, send: agentSend, create: agentCreate, wait: agentWait, kill: agentKill, event: agentEvent };

// ---------- 录制文件管理 IPC ----------
// 列表：读每个 .cast 的头行拿元信息 + 文件大小/时长（末事件时间），按新→旧。失败的文件跳过不报错。
ipcMain.handle('rec:list', () => {
  try {
    const dir = REC_DIR();
    if (!fs.existsSync(dir)) return { ok: true, items: [] };
    const live = new Set([...recorders.values()].map((r) => r.path));
    const items = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.cast')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        // 「打开但没干活」的空终端会留下几百字节的壳（提示符+括号粘贴开关），是噪音：
        // 非正在录且体量过小的直接不进列表，省得满屏空录像
        if (st.size < 700 && !live.has(full)) continue;
        const head = readFirstLine(full);
        const meta = head ? JSON.parse(head) : {};
        items.push({
          name, path: full, size: st.size, mtime: st.mtimeMs,
          width: meta.width || 80, height: meta.height || 24,
          cwd: (meta.fanbox && meta.fanbox.cwd) || '',
          startedAt: (meta.fanbox && meta.fanbox.startedAt) || (meta.timestamp ? meta.timestamp * 1000 : st.birthtimeMs),
          duration: readLastEventTime(full, st.size), // 原始时长（末事件时间），列表里给用户选片参考
          recording: live.has(full), // 还在录的会话
        });
      } catch { /* 损坏的文件跳过 */ }
    }
    items.sort((a, b) => b.startedAt - a.startedAt);
    return { ok: true, items };
  } catch (err) { return { ok: false, error: err.message, items: [] }; }
});
ipcMain.handle('rec:read', (e, { path: p }) => {
  try {
    if (!isInRecDir(p)) return { ok: false, error: '非录制目录' };
    return { ok: true, text: fs.readFileSync(p, 'utf8') };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('rec:delete', (e, { path: p }) => {
  try {
    if (!isInRecDir(p)) return { ok: false, error: '非录制目录' };
    fs.rmSync(p, { force: true });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('rec:reveal', (e, { path: p }) => {
  try { shell.showItemInFolder(isInRecDir(p) ? p : REC_DIR()); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
// 把导出好的视频/GIF 字节落进录制目录旁，返回真实路径供「在访达显示」
ipcMain.handle('rec:save-export', (e, { name, buf }) => {
  try {
    const dir = path.join(REC_DIR(), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'export.webm').replace(/[/\\:]/g, '_');
    const dest = uniqueDest(path.join(dir, safe));
    fs.writeFileSync(dest, Buffer.from(buf));
    return { ok: true, path: dest };
  } catch (err) { return { ok: false, error: err.message }; }
});
// 导出：渲染层录出的永远是 WebM；要 MP4/GIF 就用本机 ffmpeg 转一道（检测不到 ffmpeg 优雅退回 WebM）。
function findFfmpeg() {
  for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
  return null;
}
ipcMain.handle('rec:export', async (e, { name, buf, format }) => {
  const { execFile } = require('child_process');
  const crypto = require('crypto');
  try {
    const dir = path.join(REC_DIR(), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const base = String(name || 'export').replace(/[/\\:]/g, '_').replace(/\.[a-z0-9]+$/i, '').slice(0, 120);
    const tmp = path.join(dir, '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex') + '.webm');
    fs.writeFileSync(tmp, Buffer.from(buf));
    const saveWebm = (reason) => { const d = uniqueDest(path.join(dir, base + '.webm')); fs.renameSync(tmp, d); return { ok: true, path: d, format: 'webm', fellBack: reason || null }; };
    if (format === 'webm') return saveWebm();
    const ff = findFfmpeg();
    if (!ff) return saveWebm('未检测到 ffmpeg，已存 WebM');
    const run = (args) => new Promise((res, rej) => execFile(ff, args, { timeout: 180000 }, (err, so, se) => (err ? rej(new Error((se || err.message || '').slice(0, 300))) : res())));
    try {
      if (format === 'mp4') {
        const dest = uniqueDest(path.join(dir, base + '.mp4'));
        // 偶数宽高（yuv420p 要求）+ faststart（边下边播）
        await run(['-y', '-i', tmp, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest]);
        fs.rmSync(tmp, { force: true });
        return { ok: true, path: dest, format: 'mp4' };
      }
      if (format === 'gif') {
        const dest = uniqueDest(path.join(dir, base + '.gif'));
        const pal = tmp + '.png';
        // 两遍调色板，GIF 才不糊不抖；宽度封到 900，15fps，体积友好
        await run(['-y', '-i', tmp, '-vf', 'fps=15,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff', pal]);
        await run(['-y', '-i', tmp, '-i', pal, '-lavfi', 'fps=15,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3', dest]);
        fs.rmSync(tmp, { force: true }); fs.rmSync(pal, { force: true });
        return { ok: true, path: dest, format: 'gif' };
      }
    } catch (convErr) { try { return saveWebm('转码失败（' + convErr.message + '），已存 WebM'); } catch { /* */ } }
    return saveWebm();
  } catch (err) { return { ok: false, error: err.message }; }
});
function isInRecDir(p) {
  try { const r = path.resolve(REC_DIR()); return p && path.resolve(p).startsWith(r + path.sep); }
  catch { return false; }
}
// 只读文件头一行（.cast 头），不把整个大文件读进内存
function readFirstLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.slice(0, n).toString('utf8');
    const nl = s.indexOf('\n');
    return nl >= 0 ? s.slice(0, nl) : s;
  } finally { fs.closeSync(fd); }
}
// 读文件尾，取最后一条事件的时间戳 = 原始时长（不把大文件整读进内存）
function readLastEventTime(file, size) {
  try {
    const len = Math.min(4096, size);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
      const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const v = JSON.parse(lines[i]); if (Array.isArray(v) && typeof v[0] === 'number') return v[0]; } catch { /* 末行可能被截断，往前找 */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* */ }
  return 0;
}

// lsof 在非 UTF-8 locale 下会把中文路径按字节转义成 \xe8 字面量（GUI 启动的 app 不继承 shell 的 locale，
// 正中这个坑：标签标题乱码、双击定位失效）。调 lsof 时显式给 UTF-8 locale，这里再留一层 \xNN 解码兜底
function decodeLsofPath(s) {
  if (!/\\x[0-9a-fA-F]{2}/.test(s)) return s;
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
      bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
      i += 3;
    } else {
      for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
// 取某终端 shell 的真实当前目录（用 lsof 查 pty 子进程的 cwd）
function termCwdByPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve('');
    require('child_process').exec(`lsof -a -p ${pid} -d cwd -Fn`, { env: { ...process.env, LC_ALL: 'en_US.UTF-8' }, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve('');
      const line = (stdout || '').split('\n').find((l) => l.startsWith('n'));
      resolve(line ? decodeLsofPath(line.slice(1)) : '');
    });
  });
}
// 取某终端 shell 的真实当前目录，实现「定位到终端目录」
ipcMain.handle('pty:cwd', async (e, { id }) => {
  const p = terminals.get(id);
  if (!p || !p.pid) return { ok: false };
  const cwd = await termCwdByPid(p.pid);
  return cwd ? { ok: true, cwd } : { ok: false };
});

// 取终端前台进程名（node-pty 维护）：判断当前是裸 shell 还是正跑着 claude/codex 等程序
ipcMain.handle('pty:proc', (e, { id }) => {
  const p = terminals.get(id);
  return p ? { ok: true, proc: p.process || '' } : { ok: false };
});

// ---------- 微信 ClawBot：不经 openclaw，直连腾讯 iLink 协议 + 本机 claude/codex 无头实例 ----------
// 编排见 electron/wechat/bridge.js（iLink 客户端 ilink.js + 本机 CLI 驱动 driver.js）。
// 参考的开源项目与署名见 docs/08-微信ClawBot-参考与署名.md。
const wechatBridge = require('./wechat/bridge');
let wechatInited = false;
function ensureWechat() {
  if (wechatInited) return;
  wechatInited = true;
  // 微信连/断 → 更新电源守卫（开了「离开不待机」时，连着才保持唤醒，断开自动恢复休眠）
  wechatBridge.onConnChange = (on) => { wechatConnected = !!on; refreshLidGuard(); };
  // 跨终端感知 + 控制：把本机其他 pty 终端的状态/写入能力交给微信 agent（手机上看电脑在跑啥、并能遥控）
  wechatBridge.termControl = {
    async list() {
      const arr = [];
      for (const [id, p] of terminals) {
        const proc = (p && p.process) || '';
        const cwd = await termCwdByPid(p && p.pid);
        const busy = !!proc && !/^-?(zsh|bash|sh|fish|login)$/i.test(proc); // 前台不是裸 shell = 正跑着东西
        arr.push({ id, cwd, name: cwd ? path.basename(cwd) : '', proc, busy, tail: termTails.get(id) || '' });
      }
      return arr;
    },
    send(id, text) {
      const p = terminals.get(id);
      if (!p) return { ok: false, error: 'no such terminal' };
      try { p.write(text); recEvent(id, 'i', text); return { ok: true }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    },
  };
  try { wechatBridge.init(win); } catch (e) { console.error('[wechat] init failed', e); }
  try { wechatConnected = wechatBridge.isConnected(); refreshLidGuard(); } catch { /* */ }
}
ipcMain.handle('wechat:env', async () => { ensureWechat(); return wechatBridge.env(); });
ipcMain.handle('wechat:setTarget', (e, { target } = {}) => { ensureWechat(); return wechatBridge.setTarget(target); });
ipcMain.handle('wechat:setCwd', (e, { dir } = {}) => { ensureWechat(); return wechatBridge.setCwd(dir); });
ipcMain.handle('wechat:setPersona', (e, { persona } = {}) => { ensureWechat(); return wechatBridge.setPersona(persona); });
ipcMain.handle('wechat:send', async (e, { text } = {}) => { ensureWechat(); return wechatBridge.sendDesktop(text); });
ipcMain.handle('wechat:conversation', (e, { id } = {}) => { ensureWechat(); return wechatBridge.conversation(id); });
ipcMain.handle('wechat:newConversation', async (e, { id } = {}) => { ensureWechat(); return wechatBridge.newConversation(id); });
ipcMain.handle('wechat:compact', async (e, { id } = {}) => { ensureWechat(); return wechatBridge.compact(id, false); });
ipcMain.handle('wechat:login', async () => { ensureWechat(); return wechatBridge.login(); });
ipcMain.handle('wechat:disconnect', async () => { ensureWechat(); return wechatBridge.disconnect(); });
ipcMain.handle('wechat:cancel', () => ({ ok: true }));
ipcMain.handle('wechat:check', async () => { ensureWechat(); return wechatBridge.check(); }); // 主动探活，返回 { state }

// 「微信遥控不断线」开关：开启时（首次需管理员密码装免密规则）+ 微信连着 → 禁休眠，息屏/合盖也能远程操控
ipcMain.handle('power:setWechat', async (e, { on } = {}) => {
  ensureWechat();
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS only' };
  if (on) {
    const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', buttons: [M('开启', 'Enable'), M('取消', 'Cancel')], defaultId: 0, cancelId: 1,
      message: M('离开电脑也能用微信遥控', 'Keep controllable via WeChat while away'),
      detail: M('开启后，只要微信 ClawBot 还连着，合盖 / 息屏也不休眠——你能一直用手机微信遥控本机的 Claude Code / Codex。\n\n注意：持续耗电发热，建议接电源。断开微信、或关掉这个开关，自动恢复正常休眠。\n\n首次开启需输入一次管理员密码（装一条仅限电源设置的免密规则）。',
        'While WeChat ClawBot stays connected, closing the lid / screen off won\'t sleep the Mac — you can keep remote-controlling Claude Code / Codex from your phone.\n\nNote: it keeps drawing power and heat; stay plugged in. Disconnecting WeChat or turning this off restores normal sleep.\n\nFirst time needs your admin password once (installs a power-only passwordless rule).'),
    });
    if (choice !== 0) return { ...powerPayload(), ok: false, error: 'cancelled' };
    const ruleOk = await ensurePmsetRule();
    if (!ruleOk) return { ...powerPayload(), ok: false, error: 'setup-cancelled' };
  }
  wechatStayAwake = !!on;
  writeConfig({ wechatStayAwake });
  try { wechatConnected = wechatBridge.isConnected(); } catch { /* */ }
  refreshLidGuard();
  return { ...powerPayload(), ok: true, on: wechatStayAwake };
});

// ---------- 文件监听（agent 改文件 → 自动刷新 + 跨项目变更收件箱）----------
// 多目录监听：浏览目录 + 每个终端会话所在的项目目录。一下午开多个项目跑 agent 时，
// 不在前台的项目也能感知变更。前端发来期望监听集，这里做增量 diff（关掉多余、补上新增）。
const watchers = new Map(); // dir -> FSWatcher
// 噪声过滤在这一侧做：node_modules / 构建目录的 FSEvents 风暴从前是每个事件
// 一次同步 statSync + 一次 IPC，全部白付（过滤器写在渲染层，站在 IPC 的错误一侧）。
// 现在噪声在源头丢弃；规则与 public/app.js 的 isNoisyChange 保持一致（那边还守着
// recordChange 等语义层，这边挡量），改一处记得同步另一处。
const WATCH_IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.venv', 'venv', '__pycache__', '.DS_Store', 'target', '.turbo', '.expo', 'Library', 'Caches', '.Trash', 'CloudStorage', '.cocoapods', 'DerivedData']);
function watchNoisy(filename) {
  const segs = String(filename).split('/');
  if (segs.some((s) => WATCH_IGNORE.has(s) || s.startsWith('.'))) return true;
  const name = segs[segs.length - 1];
  return !name || name.endsWith('~') || name.endsWith('.swp')
    || /\.(tmp|part|crdownload|lock)(\.|$)|-(journal|shm|wal)$/i.test(name);
}
// 去重、有界队列、最多16个并行stat；上批完成才调度下一批。
const { createWatchBatcher } = require('../lib/watch-batcher');
const watchBatcher = createWatchBatcher((batch) => {
  if (win && !win.isDestroyed()) win.webContents.send('fs:changed-batch', batch);
  for (const dir of new Set(batch.map((m) => m.dir))) {
    fs.promises.stat(dir).catch((e) => {
      if (e.code !== 'ENOENT') return;
      const w = watchers.get(dir);
      if (w) { try { w.close(); } catch { /* */ } watchers.delete(dir); }
    });
  }
});
function startWatch(dir) {
  if (watchers.has(dir) || !dir || !fs.existsSync(dir)) return;
  try {
    // macOS(FSEvents)/Windows 原生递归；Linux 递归不可靠，降级为非递归监听当前目录
    const recursive = process.platform !== 'linux';
    const w = fs.watch(dir, { persistent: false, recursive }, (evt, filename) => {
      if (!win || win.isDestroyed()) return;
      const name = filename ? filename.toString() : null;
      if (name && watchNoisy(name)) return;
      watchBatcher.enqueue({ dir, filename: name });
    });
    // FSWatcher 是 EventEmitter：EMFILE（fd 用光）这类错误异步走 'error' 事件，没人听就是主进程未捕获异常，
    // 整个 app 跟着崩。听到就把这只关掉、从表里摘除，下次 watch-set 会重试
    w.on('error', () => { try { w.close(); } catch { /* */ } if (watchers.get(dir) === w) watchers.delete(dir); });
    watchers.set(dir, w);
  } catch { /* 无权限等，跳过该目录 */ }
}
ipcMain.handle('fs:watch-set', (e, { dirs }) => {
  const want = new Set((dirs || []).filter(Boolean));
  for (const [dir, w] of watchers) { if (!want.has(dir)) { try { w.close(); } catch { /* */ } watchers.delete(dir); } }
  for (const dir of want) startWatch(dir);
  return { ok: true, count: watchers.size };
});
// 兼容旧单目录接口：等价于「只监听这一个目录」
ipcMain.handle('fs:watch', (e, { dir }) => {
  for (const [d, w] of watchers) { if (d !== dir) { try { w.close(); } catch { /* */ } watchers.delete(d); } }
  startWatch(dir);
  return { ok: true };
});
