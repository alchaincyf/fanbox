'use strict';
// 微信值守开关回归。驱动真实 Electron，跑在隔离环境里：
// 临时 HOME、独立 userData、端口 4736，窗口不显示、不抢前台，系统通知全部换成假的（不在系统里留登记）。
// 运行：NODE_PATH=<含playwright-core的node_modules> node tests/ui-always.cjs [截图路径]（约十秒）
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = 4736, TOKEN = 'ui-always-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-ui-always-'));
const home = path.join(tmp, 'home');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj']) fs.mkdirSync(path.join(home, d), { recursive: true });
// 外壳：窗口一律不显示、focus/置顶空转，再加载真实主进程
fs.mkdirSync(path.join(tmp, 'shell'));
fs.writeFileSync(path.join(tmp, 'shell', 'package.json'), JSON.stringify({ name: 'fanbox-ui-always', version: '0.0.0', main: 'main.js' }));
fs.writeFileSync(path.join(tmp, 'shell', 'main.js'), `
const Module = require('module'), electron = require('electron');
class BW extends electron.BrowserWindow {
  constructor(o = {}) { super({ ...o, show: false, paintWhenInitiallyHidden: true, webPreferences: { ...(o.webPreferences || {}), backgroundThrottling: false } }); }
  show() {} focus() {} setAlwaysOnTop() {} moveTop() {}
}
const proxy = new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? BW : t[k]) });
const load = Module._load; Module._load = function (r, ...a) { return r === 'electron' ? proxy : load.call(this, r, ...a); };
electron.app.focus = () => {};
electron.app.whenReady().then(() => { try { electron.app.dock.hide(); } catch {} });
require(${JSON.stringify(path.join(ROOT, 'electron', 'main.js'))});`);

const api = (p, body, term) => fetch(`http://127.0.0.1:${PORT}/api/agent/${p}`, { method: 'POST', headers: { 'x-fanbox-token': TOKEN, 'content-type': 'application/json', ...(term ? { 'x-fanbox-term': term } : {}) }, body: JSON.stringify(body || {}) }).then((r) => r.json());

(async () => {
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [path.join(tmp, 'shell'), '--user-data-dir=' + path.join(tmp, 'ud')], cwd: ROOT,
    env: { ...process.env, HOME: home, ZDOTDIR: home, FANBOX_PORT: String(PORT), FANBOX_AGENT_TOKEN: TOKEN, FANBOX_NO_RECORD: '1' },
  });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForFunction(() => typeof term !== 'undefined' && document.readyState === 'complete', null, { timeout: 30000 });
  await sleep(1500);
  // 设置里有「微信值守」一行：默认开；没连微信时标「未连微信」
  await win.evaluate(() => document.querySelectorAll('.guide-overlay').forEach((el) => el.remove())); // 首次启动的引导层会挡住点击
  await win.click('#agent-config');
  const row = win.locator('.ap-row[data-always]');
  await row.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await row.locator('input').isChecked(), true, '默认开');
  assert.equal(await row.locator('[data-always-flag]').textContent(), '未连微信');
  assert.deepEqual(await win.evaluate(() => window.fanboxWin.alwaysOnState()), { ok: true, alwaysOn: true, connected: false });
  if (process.argv[2]) await win.screenshot({ path: process.argv[2] });
  // 关掉：状态变、落盘、标「已关」；重开恢复
  await row.locator('input').click(); await sleep(400);
  assert.equal(await row.locator('[data-always-flag]').textContent(), '已关');
  assert.equal((await win.evaluate(() => window.fanboxWin.alwaysOnState())).alwaysOn, false);
  const stFile = path.join(tmp, 'ud', 'wechat', 'state.json');
  assert.equal(JSON.parse(fs.readFileSync(stFile, 'utf8')).alwaysOn, false, '关掉要落盘');
  await row.locator('input').click(); await sleep(400);
  assert.equal((await win.evaluate(() => window.fanboxWin.alwaysOnState())).alwaysOn, true);
  assert.deepEqual(errors, []);
  console.log('always-on checks passed: settings row, default on, not-connected flag, off/on persisted');
  await app.evaluate(({ app }) => app.exit(0));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
