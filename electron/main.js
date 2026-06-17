'use strict';
/**
 * FanBox — Electron 主进程
 *
 * 复用零依赖后端 server.js（文件能力），叠加 node-pty 内嵌终端，
 * 让 TUI coding agent（Claude Code / Codex / Aider…）在界面里直接跑起来。
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, Menu, clipboard, dialog, net, session } = require('electron');
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
const termStartCwd = new Map(); // id -> spawn 时的起始目录；Windows 无 lsof、conpty 拿不到 shell 实时 cwd，用起始目录兜底
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
  const isMac = process.platform === 'darwin';
  // 红绿灯 hiddenInset + 侧栏毛玻璃 vibrancy 是 macOS 专属；Windows/Linux 用原生标题栏（最稳，
  // 也能正常拿到最小化/最大化/关闭）。对应的 .desktop CSS 红绿灯留白由渲染层按平台 class 收敛。
  const macFrame = isMac ? { titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', visualEffectState: 'active' } : {};
  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 920, minHeight: 600,
    backgroundColor: '#0b0c0a',
    ...macFrame,
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
  // 后端跑在 localhost，访问它永不该走代理。个别环境（clash 强制系统代理、企业 PAC 把 loopback 也代理）
  // 会把本地请求拦成 502 → 整个界面白屏。给 loopback 显式加旁路；其余（如查更新走 GitHub）仍按系统代理，互不影响。
  session.defaultSession.setProxy({ mode: 'system', proxyBypassRules: 'localhost;127.0.0.1;[::1]' }).catch(() => { /* 设置失败就退回默认行为，不影响启动 */ });
  // 合盖继续运行：恢复上次的开关意图；启动时把残留的禁休眠清掉（防上次崩溃没恢复），有终端跑起来再按需重新生效
  lidIntent = !!readConfig().lidStayAwake;
  if (process.platform === 'darwin') trySetDisableSleep(false);
  buildMenu();
  try {
    const m = Menu.getApplicationMenu();
    const view = m && m.items.find((i) => i.label === M('视图', 'View'));
    console.log('[lid] 视图 子菜单 =', view ? JSON.stringify(view.submenu.items.map((x) => x.label || `<${x.type}>`)) : '没找到视图菜单');
  } catch (e) { console.log('[lid] dump menu 出错:', e.message); }
  createWindow();
  // 临时调试：dev 实例强制抢到最前，避免和正式版搞混
  setTimeout(() => { try { app.focus({ steal: true }); if (win && !win.isDestroyed()) { win.show(); win.focus(); win.setAlwaysOnTop(true); setTimeout(() => win.setAlwaysOnTop(false), 1500); } } catch { /* */ } }, 1200);
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
let lidIntent = false; // 用户意图（菜单勾选），跨会话持久
let lidActive = false; // 当前是否已对系统下达禁休眠

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

// 按「意图 × 终端数」结算系统状态，幂等。终端起落、开关变化都调它。
function refreshLidGuard() {
  if (process.platform !== 'darwin') return;
  const want = lidIntent && terminals.size > 0;
  if (want === lidActive) return;
  const ok = trySetDisableSleep(want);
  if (want && !ok) { lidIntent = false; writeConfig({ lidStayAwake: false }); } // 免密规则丢了，退回关闭
  lidActive = want && ok;
  buildMenu();
}

// 菜单勾选/取消的入口
async function setLidIntent(on) {
  console.log('[lid] setLidIntent called, on =', on);
  if (process.platform !== 'darwin') return;
  if (on) {
    const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning', buttons: [M('开启', 'Enable'), M('取消', 'Cancel')], defaultId: 0, cancelId: 1,
      message: M('合盖后继续运行', 'Keep running with lid closed'),
      detail: M('开启后，只要还有终端会话在跑，合上盖子也不会休眠——agent 任务能接着干。\n\n注意：合盖期间持续耗电发热，建议接电源。终端全部退出或退出翻箱时自动恢复正常休眠。\n\n首次开启需输入一次管理员密码（装一条仅限电源设置的免密规则）。',
        'While any terminal session is running, closing the lid won\'t sleep the Mac — your agent tasks keep going.\n\nNote: it keeps drawing power and heat while closed; stay plugged in. Normal sleep is restored once all terminals exit or you quit FanBox.\n\nFirst time needs your admin password once (installs a power-only passwordless rule).'),
    });
    console.log('[lid] warning dialog choice =', choice, '(0=开启)');
    if (choice !== 0) { buildMenu(); return; } // 取消 → 复位勾选
    // 探针：能否免密 sudo（设 0 无害）。不行就装规则。
    const probe = trySetDisableSleep(false);
    console.log('[lid] sudo probe ok =', probe, '→', probe ? '已有免密规则' : '需安装');
    if (!probe) {
      const installed = await installSudoers();
      console.log('[lid] installSudoers result =', installed);
      if (!installed) { buildMenu(); return; } // 装失败/取消 → 保持关闭
    }
  }
  lidIntent = on;
  writeConfig({ lidStayAwake: on });
  refreshLidGuard();
  buildMenu();
}

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
      ...(isMac ? [{ type: 'separator' }, {
        // 合盖后继续运行：仅在有终端跑着时真正生效（智能模式）；勾选状态反映用户意图
        label: lidActive ? M('合盖后继续运行（生效中）', 'Keep running with lid closed (active)') : M('合盖后继续运行', 'Keep running with lid closed'),
        type: 'checkbox', checked: lidIntent,
        click: (item) => { setLidIntent(item.checked); },
      }] : []),
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
  if (lidActive) { trySetDisableSleep(false); lidActive = false; } // 终端没了，别让 Mac 一直不睡
  recorders.forEach((r) => { try { r.stream.end(); } catch { /* */ } }); // 收尾刷盘，别丢最后几行
  recorders.clear();
  if (process.platform !== 'darwin') app.quit();
});
// 退出兜底：无论怎么退（⌘Q、崩溃前的正常退出），都恢复系统休眠，绝不留禁休眠的烂摊子
app.on('will-quit', () => { if (process.platform === 'darwin') trySetDisableSleep(false); });

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
  const env = { ...process.env, TERM: 'xterm-256color', FANBOX: '1' };
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
  termStartCwd.set(id, startCwd);
  refreshLidGuard(); // 开关开着时，第一个终端起来即生效
  recStart(id, { cols, rows, cwd: startCwd, theme });
  p.onData((data) => { if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data }); recEvent(id, 'o', data); });
  p.onExit(({ exitCode }) => {
    terminals.delete(id);
    termStartCwd.delete(id);
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
ipcMain.handle('clip:file', (e, { path: p }) => {
  if (process.platform === 'win32') {
    // 复制文件本体到剪贴板（资源管理器里可粘贴）。Clipboard 必须 STA 线程 → -STA；
    // 路径经环境变量 FB_CLIP 传入，含空格/中文/引号也不会炸。
    // SetFileDropList 偶发 OpenClipboard Failed（截图工具/输入法/Snipaste 正持有剪贴板）：
    // PS try/catch 退出码 2 → main 侧重试一次（250ms）盖住绝大部分瞬时占用
    const ps = 'try { Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Collections.Specialized.StringCollection; $f.Add($env:FB_CLIP); [System.Windows.Forms.Clipboard]::SetFileDropList($f) } catch { exit 2 }';
    const { execFile } = require('child_process');
    const run = () => new Promise((resolve) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps],
      { env: { ...process.env, FB_CLIP: String(p || '') }, windowsHide: true, timeout: 8000 },
      (err) => resolve(err)));
    return (async () => {
      let err = await run();
      if (err) { await new Promise((r) => setTimeout(r, 250)); err = await run(); } // 剪贴板被占用，重试一次
      return { ok: !err, error: err ? '剪贴板被其它程序占用，请重试' : undefined };
    })();
  }
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    // argv 传路径，避免拼进 AppleScript 字面量被注入
    execFile('osascript', ['-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', p], (err) => resolve({ ok: !err, error: err && err.message }));
  });
});

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

ipcMain.on('pty:input', (e, { id, data }) => { const p = terminals.get(id); if (p) { p.write(data); recEvent(id, 'i', data); } });
ipcMain.on('pty:resize', (e, { id, cols, rows }) => { const p = terminals.get(id); if (p) { try { p.resize(cols, rows); } catch { /* */ } recEvent(id, 'r', `${cols}x${rows}`); } });
ipcMain.on('pty:kill', (e, { id }) => { const p = terminals.get(id); if (p) { try { p.kill(); } catch { /* */ } terminals.delete(id); termStartCwd.delete(id); refreshLidGuard(); recStop(id); } });

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
  if (process.platform === 'win32') {
    // Scoop/choco 装的 ffmpeg 在系统 PATH，where 能找到
    try {
      const out = require('child_process').execFileSync('where', ['ffmpeg'], { timeout: 3000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const line = String(out).split(/\r?\n/).find(Boolean);
      if (line) return line;
    } catch { /* */ }
    return null;
  }
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
// 取某终端 shell 的真实当前目录（用 lsof 查 pty 子进程的 cwd），实现「定位到终端目录」
ipcMain.handle('pty:cwd', (e, { id }) => new Promise((resolve) => {
  const p = terminals.get(id);
  if (!p || !p.pid) return resolve({ ok: false });
  // Windows 没有 lsof，conpty 也拿不到 shell 子进程的实时 cwd：退回 spawn 起始目录。
  // 点标签「定位到终端目录」会落在初始项目目录（用户多在项目根开 tab，多数场景正确）。
  if (process.platform === 'win32') {
    const cwd = termStartCwd.get(id);
    return resolve(cwd ? { ok: true, cwd } : { ok: false });
  }
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

// ---------- 微信 ClawBot：微信 →（官方插件）→ OpenClaw →（runtime）→ Claude Code / Codex ----------
// GUI 启动的 app 只继承精简 PATH，openclaw 在 ~/.npm-global/bin 等处会找不到 → 一律走 login shell（zsh -lc）带全 PATH。
const wxLoginShell = () => process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
function ocEnv() {
  const env = { ...process.env };
  if (!/UTF-8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) env.LANG = 'en_US.UTF-8';
  return env;
}
// 跑一条 openclaw 命令，拿 stdout（login shell 带全 PATH）
function ocRun(cmd, timeout = 20000) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile(wxLoginShell(), ['-lc', cmd], { env: ocEnv(), timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
const wxAccountsFile = () => path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts.json');
const ocSessionsDir = () => path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
function wxAccount() {
  try { const a = JSON.parse(fs.readFileSync(wxAccountsFile(), 'utf8')); if (Array.isArray(a) && a.length) return a[0]; } catch { /* 没绑过 */ }
  return '';
}
let wxLogin = null; // 等待扫码的登录子进程

// 环境/连接状态：装没装 openclaw、有没有绑过微信、main agent 现在是哪个模型（= 微信连的是谁）
ipcMain.handle('wechat:env', async () => {
  const which = await ocRun('command -v openclaw || true', 8000);
  const installed = !!which.stdout.trim();
  let agentModel = '';
  if (installed) agentModel = (await ocRun('openclaw config get agents.defaults.model.primary 2>/dev/null || true', 8000)).stdout.trim();
  const account = wxAccount();
  return { ok: true, installed, connected: !!account, account, agentModel };
});

// 启用插件 → 起网关 → 流式跑 login：二维码 URL、连接成功都通过事件推给前端
ipcMain.handle('wechat:login', async () => {
  const which = await ocRun('command -v openclaw || true', 8000);
  if (!which.stdout.trim()) return { ok: false, error: 'openclaw 未安装' };
  if (wxLogin) { try { wxLogin.kill(); } catch { /* */ } wxLogin = null; }
  await ocRun('openclaw config set plugins.entries.openclaw-weixin.enabled true', 20000); // 幂等
  await ocRun('openclaw gateway start', 30000); // 幂等，已在跑也无妨
  const { spawn } = require('child_process');
  const p = spawn(wxLoginShell(), ['-lc', 'openclaw channels login --channel openclaw-weixin'], { env: ocEnv() });
  wxLogin = p;
  let buf = '', qrSent = false, done = false;
  const send = (ch, m) => { if (win && !win.isDestroyed()) win.webContents.send(ch, m); };
  const QRCode = require('qrcode');
  const onChunk = async (d) => {
    buf += d.toString('utf8');
    if (!qrSent) {
      const m = buf.match(/https:\/\/liteapp\.weixin\.qq\.com\/\S+/);
      if (m) {
        qrSent = true;
        let dataUrl = '';
        try { dataUrl = await QRCode.toDataURL(m[0], { width: 240, margin: 1 }); } catch { /* 退回给前端原始 URL */ }
        send('wechat:qr', { url: m[0], dataUrl });
      }
    }
    if (!done && /已将此\s*OpenClaw\s*连接到微信|connected this OpenClaw to (WeChat|Weixin)/i.test(buf)) {
      done = true;
      // 登录存了凭证但运行中的网关不会热加载新 channel，必须重启才激活；restart 用 launchctl 会 I/O error，改 stop→start
      await ocRun('openclaw gateway stop', 30000);
      await ocRun('openclaw gateway start', 30000);
      send('wechat:connected', { ok: true, account: wxAccount() });
    }
  };
  p.stdout.on('data', onChunk);
  p.stderr.on('data', onChunk);
  p.on('exit', () => { if (wxLogin === p) wxLogin = null; });
  return { ok: true };
});

// 关弹窗时若还在等扫码，停掉登录进程（避免悬挂）
ipcMain.handle('wechat:cancel', () => {
  if (wxLogin) { try { wxLogin.kill(); } catch { /* */ } wxLogin = null; }
  return { ok: true };
});

// 断开：登出微信 channel
ipcMain.handle('wechat:disconnect', async () => {
  if (wxLogin) { try { wxLogin.kill(); } catch { /* */ } wxLogin = null; }
  const acc = wxAccount();
  const r = await ocRun(`openclaw channels logout --channel openclaw-weixin${acc ? ` --account ${acc}` : ''}`, 30000);
  return { ok: r.ok, error: r.stderr };
});

// 列出微信来的会话（sessions list 里筛 openclaw-weixin + @im.wechat，取 session id）
ipcMain.handle('wechat:sessions', async () => {
  const r = await ocRun('openclaw sessions list', 20000);
  const items = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!/openclaw-weixin/.test(line) || !/@im\.wechat/.test(line)) continue;
    const id = (line.match(/id:([0-9a-fA-F-]{36})/) || [])[1];
    const age = (line.match(/(\d+\s*\w+ ago)/) || [])[1] || '';
    if (id) items.push({ id, age });
  }
  return { ok: true, items };
});

// 读对话正文：解析 transcript JSONL，取 user / assistant 的可读文本（跳过 toolCall / toolResult 噪声）
ipcMain.handle('wechat:transcript', (e, { sid }) => {
  if (!/^[0-9a-fA-F-]{36}$/.test(sid || '')) return { ok: false, error: 'bad sid' };
  let txt;
  try { txt = fs.readFileSync(path.join(ocSessionsDir(), sid + '.jsonl'), 'utf8'); }
  catch { return { ok: false, error: 'no transcript' }; }
  const msgs = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'message' || !o.message) continue;
    const role = o.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const c = o.message.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
    if (!text) continue; // 纯工具调用的 assistant 轮不显示
    if (role === 'user' && /^Delivery:\s/.test(text)) continue; // 投递框架注入的系统指令，不是用户说的话
    msgs.push({ role, text, time: o.timestamp || '' });
  }
  return { ok: true, msgs };
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
      if (!win || win.isDestroyed()) return;
      const name = filename ? filename.toString() : null;
      // FSEvents 连「文件只是被读了一下」（atime/元数据更新）都报：agent cat/Read 个文件、
      // Spotlight 扫一遍都会触发。mtime/ctime 都不新鲜 = 内容根本没动过，丢弃；
      // stat 失败 = 刚被删，是真变更，照常转发
      if (name) {
        try {
          const st = fs.statSync(path.join(dir, name));
          const now = Date.now();
          if (now - st.mtimeMs > 3000 && now - st.ctimeMs > 3000) return;
        } catch { /* 已删除/无权限：当真变更转发 */ }
      }
      win.webContents.send('fs:changed', { dir, filename: name });
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
