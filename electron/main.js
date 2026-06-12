'use strict';
/**
 * FanBox — Electron 主进程
 *
 * 复用零依赖后端 server.js（文件能力），叠加 node-pty 内嵌终端，
 * 让 TUI coding agent（Claude Code / Codex / Aider…）在界面里直接跑起来。
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, Menu, clipboard, dialog, net } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 复用现有后端：require 即 listen 127.0.0.1:PORT，不自动开浏览器
process.env.FANBOX_NO_OPEN = '1';
const PORT = Number(process.env.FANBOX_PORT) || 4567;
require('../server.js');

// node-pty 是原生模块，需 electron-rebuild 编译过；未就绪时终端能力降级但 app 仍可用
let pty = null;
try { pty = require('node-pty'); }
catch (e) { console.error('[fanbox] node-pty 未就绪（跑 npm run rebuild）：', e.message); }

const terminals = new Map();
let win = null;

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
    },
  });
  // 拖动/缩放后防抖记忆，关窗再存一次兜底
  let bt = null;
  const remember = () => { clearTimeout(bt); bt = setTimeout(saveBounds, 400); };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', saveBounds);

  // 等后端起来再加载（首次 listen 有几十毫秒延迟）
  const load = () => win.loadURL(`http://localhost:${PORT}`).catch(() => setTimeout(load, 150));
  setTimeout(load, 250);

  // 外部链接走系统浏览器，不在 app 里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // 开发模式下 macOS 默认显示 Electron 图标——换成翻箱自己的（打包后由 electron-builder 的 icon 接管）
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'))); } catch { /* */ }
  }
  app.setName('FanBox');
  buildMenu();
  createWindow();
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
      setTimeout(() => { // 等写盘完成再确认
        fs.stat(fp, (err, st) => {
          if (err || !st.isFile() || st.size < 1000) return;
          const last = shotSent.get(fp) || 0;
          if (Date.now() - last < 3000) return;
          shotSent.set(fp, Date.now());
          if (shotSent.size > 50) { const k = shotSent.keys().next().value; shotSent.delete(k); }
          if (win && !win.isDestroyed()) win.webContents.send('shot:new', { path: fp, name, size: st.size });
        });
      }, 600);
    });
  } catch { /* 无权限等，静默放弃 */ }
}

// ---------- 更新检测：查 GitHub Releases，有新版本通知渲染层引导下载 ----------
// 现阶段只做「检测 + 引导」：Apple Development 签名过不了 Squirrel.Mac 的校验，
// electron-updater 全自动更新要等升级 Developer ID 后再换
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
const REL_PAGE = 'https://github.com/alchaincyf/fanbox/releases/latest';
async function fetchLatestRelease() {
  // 先走 API（信息全）；代理共享出口 IP 很容易吃 GitHub API 的未认证限流（60 次/小时/IP，403），
  // 失败就退回抓 releases/latest 网页重定向——重定向后的 URL 自带 tag，且不占 API 配额
  try {
    const res = await net.fetch('https://api.github.com/repos/alchaincyf/fanbox/releases/latest', {
      headers: { 'User-Agent': 'fanbox-app', Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const rel = await res.json();
      if (rel.tag_name) return { tag: rel.tag_name, url: rel.html_url || REL_PAGE };
    }
  } catch { /* 走兜底 */ }
  const res = await net.fetch(REL_PAGE, { headers: { 'User-Agent': 'fanbox-app' } });
  const m = String(res.url || '').match(/\/releases\/tag\/([^/?#]+)/);
  if (m) return { tag: decodeURIComponent(m[1]), url: res.url };
  return null;
}
let pendingUpdate = null; // 渲染层晚注册监听也能拉到（启动 6 秒的推送 vs init 加载大目录，谁先谁后说不准）
let updRetry = 0;
let lastAutoCheck = 0;
async function checkUpdate(opts) {
  const manual = !!(opts && opts.manual);
  if (!manual) lastAutoCheck = Date.now();
  let info = null;
  try { info = await fetchLatestRelease(); } catch { info = null; }
  if (!info) {
    if (manual) {
      dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
        type: 'warning', buttons: [M('好', 'OK')], message: M('检查更新失败', 'Update check failed'),
        detail: M('没连上 GitHub（网络问题或接口限流），稍后再试。', 'Could not reach GitHub (network issue or rate limit). Try again later.'),
      });
    } else if (updRetry < 3) { updRetry++; setTimeout(checkUpdate, 10 * 60 * 1000); } // 失败别干等 12 小时
    return;
  }
  updRetry = 0;
  const newer = cmpVer(info.tag, app.getVersion()) > 0;
  if (newer) {
    pendingUpdate = { version: info.tag.replace(/^v/, ''), url: info.url };
    if (win && !win.isDestroyed()) win.webContents.send('update:available', pendingUpdate);
  }
  if (manual) {
    const owner = win && !win.isDestroyed() ? win : undefined;
    if (newer) {
      const c = dialog.showMessageBoxSync(owner, {
        type: 'info', buttons: [M('去下载', 'Download'), M('取消', 'Cancel')], defaultId: 0, cancelId: 1,
        message: M(`发现新版本 v${pendingUpdate.version}`, `New version v${pendingUpdate.version} available`),
        detail: M(`当前版本 v${app.getVersion()}。点「去下载」打开发布页，下载后替换 /Applications 里的旧版即可。`, `You are on v${app.getVersion()}. "Download" opens the release page; replace the old app in /Applications.`),
      });
      if (c === 0) shell.openExternal(pendingUpdate.url);
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

// 点完成通知把 app 拉到前台（渲染层 window.focus() 唤不醒最小化/被遮挡的窗口）
ipcMain.handle('win:focus', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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

// 原生菜单——关键是 Edit role，终端里的 ⌘C/⌘V 才生效
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: 'FanBox', submenu: [
      { role: 'about', label: M('关于 FanBox', 'About FanBox') },
      { label: M('检查更新…', 'Check for Updates…'), click: () => checkUpdate({ manual: true }) },
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
    ] },
    { role: 'window', label: M('窗口', 'Window'), submenu: [{ role: 'minimize', label: M('最小化', 'Minimize') }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
// ⌘Q 兜底：还有终端在跑时（agent 任务），退出前确认，避免手滑全灭
let quitConfirmed = false;
app.on('before-quit', (e) => {
  if (quitConfirmed || terminals.size === 0) return;
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: [M('取消', 'Cancel'), M('退出', 'Quit')],
    defaultId: 0,
    cancelId: 0,
    message: M(`还有 ${terminals.size} 个终端会话在运行`, `${terminals.size} terminal session(s) still running`),
    detail: M('退出会终止正在运行的 agent 任务，确定退出？', 'Quitting will terminate running agent tasks. Quit anyway?'),
  });
  if (choice === 1) { quitConfirmed = true; app.quit(); }
});
app.on('window-all-closed', () => {
  terminals.forEach((p) => { try { p.kill(); } catch { /* */ } });
  terminals.clear();
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 终端 IPC（node-pty）----------
ipcMain.handle('pty:spawn', (e, { id, cwd, cols, rows }) => {
  if (!pty) return { ok: false, error: 'node-pty 未编译，跑：npm run rebuild' };
  const shellPath = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
  const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // GUI 启动的 app 不继承 shell 的 locale，zsh 会把中文路径按字节转义成 \M-^@ 乱码 → 兜底 UTF-8
  const env = { ...process.env, TERM: 'xterm-256color', FANBOX: '1' };
  if (!/UTF-8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) env.LANG = 'zh_CN.UTF-8';
  let p;
  try {
    p = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startCwd,
      env,
    });
  } catch (err) { return { ok: false, error: err.message }; }
  terminals.set(id, p);
  p.onData((data) => { if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data }); });
  p.onExit(({ exitCode }) => {
    terminals.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode });
  });
  return { ok: true, cwd: startCwd };
});
// ---------- 剪贴板：复制图片本体 / 复制文件（访达可粘贴）----------
ipcMain.handle('clip:image', (e, { path: p }) => {
  try { const img = nativeImage.createFromPath(p); if (img.isEmpty()) return { ok: false, error: '不是可读图片' }; clipboard.writeImage(img); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
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

ipcMain.on('pty:input', (e, { id, data }) => { const p = terminals.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (e, { id, cols, rows }) => { const p = terminals.get(id); if (p) { try { p.resize(cols, rows); } catch { /* */ } } });
ipcMain.on('pty:kill', (e, { id }) => { const p = terminals.get(id); if (p) { try { p.kill(); } catch { /* */ } terminals.delete(id); } });

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
// 取某终端 shell 的真实当前目录（用 lsof 查 pty 子进程的 cwd），实现「定位到终端目录」
ipcMain.handle('pty:cwd', (e, { id }) => new Promise((resolve) => {
  const p = terminals.get(id);
  if (!p || !p.pid) return resolve({ ok: false });
  const { exec } = require('child_process');
  exec(`lsof -a -p ${p.pid} -d cwd -Fn`, { env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }, (err, stdout) => {
    if (err) return resolve({ ok: false });
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    resolve(line ? { ok: true, cwd: decodeLsofPath(line.slice(1)) } : { ok: false });
  });
}));

// 取终端前台进程名（node-pty 维护）：判断当前是裸 shell 还是正跑着 claude/codex 等程序
ipcMain.handle('pty:proc', (e, { id }) => {
  const p = terminals.get(id);
  return p ? { ok: true, proc: p.process || '' } : { ok: false };
});

// ---------- 文件监听（agent 改文件 → 自动刷新 + 跨项目变更收件箱）----------
// 多目录监听：浏览目录 + 每个终端会话所在的项目目录。一下午开多个项目跑 agent 时，
// 不在前台的项目也能感知变更。前端发来期望监听集，这里做增量 diff（关掉多余、补上新增）。
const watchers = new Map(); // dir -> FSWatcher
function startWatch(dir) {
  if (watchers.has(dir) || !dir || !fs.existsSync(dir)) return;
  try {
    // macOS(FSEvents)/Windows 原生递归；Linux 递归不可靠，降级为非递归监听当前目录
    const recursive = process.platform !== 'linux';
    const w = fs.watch(dir, { persistent: false, recursive }, (evt, filename) => {
      if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { dir, filename: filename ? filename.toString() : null });
    });
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
