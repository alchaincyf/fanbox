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
const { loginShell } = require('./platform');

// 复用现有后端：require 即 listen 127.0.0.1:PORT，不自动开浏览器
process.env.FANBOX_NO_OPEN = '1';
const PORT = Number(process.env.FANBOX_PORT) || 4567;
require('../server.js');

// node-pty 是原生模块，需 electron-rebuild 编译过；未就绪时终端能力降级但 app 仍可用
let pty = null;
try { pty = require('node-pty'); }
catch (e) { console.error('[fanbox] node-pty 未就绪（跑 npm run rebuild）：', e.message); }

let win = null;

// ---------- Agent 控制接口状态（/api/agent/*，见 docs/12）----------
// token 每次启动随机生成、不落盘：只注入翻箱自己开的 pty 环境变量（FANBOX_CTL_TOKEN），
// 能力边界 = FanBox 进程树——只有跑在翻箱终端里的 agent 拿得到门票，本机其他进程无从读取。
// FANBOX_AGENT_TOKEN 环境变量可覆盖，供本地开发/自动化测试注入已知 token。
const crypto = require('crypto');
const AGENT_TOKEN = process.env.FANBOX_AGENT_TOKEN || crypto.randomBytes(24).toString('hex');
// ---------- 终端/录制/文件监听共用核心：与网页版 server.js 同一份底层（见 pty-core.js）----------
// 桌面传输层 = emit → win.webContents.send；电源守卫钩子指向下方 lid 段的函数声明（有提升，安全）。
const { createCore } = require('../pty-core');
const core = createCore({
  pty,
  loginShell,
  PORT,
  AGENT_TOKEN,
  recDir: () => path.join(app.getPath('userData'), 'recordings'),
  emit: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
  onSpawn: () => refreshLidGuard(), // 开关开着时，第一个终端起来即生效
  onActivity: () => { // 开关开着但还没生效 → 有输出说明可能刚开工，尽快结算电源守卫（1s 去抖）
    if (lidIntent && !lidActive && !lidPoke) lidPoke = setTimeout(() => { lidPoke = null; refreshLidGuard(); }, 1000);
  },
  onExit: () => refreshLidGuard(), // 最后一个终端退出即恢复休眠
  canCreate: () => !!(win && !win.isDestroyed()),
});
// 微信跨终端感知、电源面板、拖入存盘等旧代码仍直读这些名字：借同名解构保持原样不动
const { terminals, termTails, recEvent, termCwdByPid, uniqueDest } = core;

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
  // macOS：点左上角红叉只隐藏到 Dock（保活渲染进程，所有界面/终端状态原样保留），真正退出走 ⌘Q。
  win.on('close', (e) => {
    saveBounds();
    if (process.platform === 'darwin' && !isQuitting) { e.preventDefault(); win.hide(); }
  });

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
// fork 发布仓库（更新检查 / 下载都指向这里；上游 alchaincyf/fanbox 的 release 不再影响本机提示）
const FORK_REPO = 'botio/fanbox';
const REL_PAGE = `https://github.com/${FORK_REPO}/releases/latest`;
async function fetchLatestRelease() {
  // 先走 API（信息全）；代理共享出口 IP 很容易吃 GitHub API 的未认证限流（60 次/小时/IP，403），
  // 失败就退回抓 releases/latest 网页重定向——重定向后的 URL 自带 tag，且不占 API 配额
  try {
    const res = await net.fetch(`https://api.github.com/repos/${FORK_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'fanbox-app', Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const rel = await res.json();
      // 顺带带上资产清单（网页兜底那条路拿不到，那时为 null 表示「不知道」）
      if (rel.tag_name) return { tag: rel.tag_name, url: rel.html_url || REL_PAGE, assets: (rel.assets || []).map((a) => a.name) };
    }
  } catch { /* 走兜底 */ }
  const res = await net.fetch(REL_PAGE, { headers: { 'User-Agent': 'fanbox-app' } });
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
    latestAssets = Array.isArray(info.assets) ? info.assets : null;
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
  const url = `https://github.com/${FORK_REPO}/releases/download/v${ver}/${name}`;
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
function termBusyAny() {
  for (const p of terminals.values()) {
    const proc = (p && p.process) || '';
    if (proc && !BARE_SHELL.test(proc)) return true;
  }
  return false;
}
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
        // 合盖继续干活：仅在检测到 agent 正在干活时真正生效（智能模式）；勾选状态反映用户意图
        label: lidActive ? M('合盖继续干活（生效中）', 'Keep working with lid closed (active)') : M('合盖继续干活', 'Keep working with lid closed'),
        type: 'checkbox', checked: lidIntent,
        click: (item) => { setLidIntent(item.checked); },
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
  if (quitConfirmed || terminals.size === 0) { isQuitting = true; return; }
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: [M('取消', 'Cancel'), M('退出', 'Quit')],
    defaultId: 0,
    cancelId: 0,
    message: M(`还有 ${terminals.size} 个终端会话在运行`, `${terminals.size} terminal session(s) still running`),
    detail: M('退出会终止正在运行的 agent 任务，确定退出？', 'Quitting will terminate running agent tasks. Quit anyway?'),
  });
  if (choice === 1) { quitConfirmed = true; isQuitting = true; app.quit(); }
});
app.on('window-all-closed', () => {
  core.shutdown(); // 杀终端 + 刷盘录制 + 关文件监听
  if (lidActive) { trySetDisableSleep(false); lidActive = false; } // 终端没了，别让 Mac 一直不睡
  if (process.platform !== 'darwin') app.quit();
});
// 退出兜底：无论怎么退（⌘Q、崩溃前的正常退出），都恢复系统休眠，绝不留禁休眠的烂摊子
app.on('will-quit', () => { if (process.platform === 'darwin') trySetDisableSleep(false); });

// ---------- 终端 IPC（node-pty）----------
ipcMain.handle('pty:spawn', (e, opts = {}) => core.spawn(opts));
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

ipcMain.on('pty:input', (e, { id, data }) => core.input(id, data));
ipcMain.on('pty:resize', (e, { id, cols, rows }) => core.resize(id, cols, rows));
ipcMain.on('pty:kill', (e, { id }) => core.kill(id));

// ---------- Agent 控制接口：把跨终端感知/控制能力开成本机 HTTP（server.js 的 /api/agent/* 调这里）----------
// 让跑在翻箱终端里的 agent 指挥兄弟窗口：列表/读屏/输入/开窗/等待/关闭。安全模型与接口规范见 docs/12。
// 实现在共用核心（pty-core.js）；这里注册到 global 供 server.js 路由调用，并转发前端建 tab 的回执。
global.__fanboxAgent = core.agent;
ipcMain.on('agent:term-created', (e, m) => core.onAgentTermCreated(m || {}));

// ---------- 录制文件管理 IPC ----------
// 列表：读每个 .cast 的头行拿元信息 + 文件大小/时长（末事件时间），按新→旧。失败的文件跳过不报错。
ipcMain.handle('rec:list', () => core.recList());
ipcMain.handle('rec:read', (e, { path: p } = {}) => core.recRead(p));
ipcMain.handle('rec:delete', (e, { path: p } = {}) => core.recRemove(p));
ipcMain.handle('rec:reveal', (e, { path: p }) => {
  try { shell.showItemInFolder(core.isInRecDir(p) ? p : core.recDir()); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
// 把导出好的视频/GIF 字节落进录制目录旁，返回真实路径供「在访达显示」
ipcMain.handle('rec:save-export', (e, { name, buf } = {}) => core.recSaveExport(name, buf));
// 导出：渲染层录出的永远是 WebM；要 MP4/GIF 就用本机 ffmpeg 转一道（检测不到 ffmpeg 优雅退回 WebM）。
ipcMain.handle('rec:export', (e, { name, buf, format } = {}) => core.recExport({ name, buf, format }));
// 取某终端 shell 的真实当前目录，实现「定位到终端目录」
ipcMain.handle('pty:cwd', (e, { id } = {}) => core.cwd(id));

// 取终端前台进程名（node-pty 维护）：判断当前是裸 shell 还是正跑着 claude/codex 等程序
ipcMain.handle('pty:proc', (e, { id } = {}) => core.proc(id));

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
ipcMain.handle('fs:watch-set', (e, { dirs } = {}) => core.watchSet(dirs));
// 兼容旧单目录接口：等价于「只监听这一个目录」
ipcMain.handle('fs:watch', (e, { dir } = {}) => core.watch(dir));
