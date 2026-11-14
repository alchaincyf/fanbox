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
electron.dialog.showErrorBox = (t, m) => { console.error('[main error]', t, m); process.exit(1); }; // 主进程报错不许弹到用户屏幕上
process.on('uncaughtException', (e) => { console.error('[main error]', e); process.exit(1); });
electron.app.whenReady().then(() => { try { electron.app.dock.hide(); } catch {} });
require(${JSON.stringify(path.join(ROOT, 'electron', 'main.js'))});`);

const api = (p, body, term) => fetch(`http://127.0.0.1:${PORT}/api/agent/${p}`, { method: 'POST', headers: { 'x-fanbox-token': TOKEN, 'content-type': 'application/json', ...(term ? { 'x-fanbox-term': term } : {}) }, body: JSON.stringify(body || {}) }).then((r) => r.json());

setTimeout(() => { console.error('超过 90 秒没跑完'); process.exit(1); }, 90000).unref();
(async () => {
  // 假飞书：收下每条消息，回成功
  const got = [];
  const srv = require('http').createServer((req, res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { got.push(JSON.parse(d)); res.end('{"code":0,"msg":"success"}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const FAKE = `http://127.0.0.1:${srv.address().port}/`, HOOK = FAKE + 'open-apis/bot/v2/hook/test';
  const idleFile = path.join(tmp, 'idle'); fs.writeFileSync(idleFile, '0');
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [path.join(tmp, 'shell'), '--user-data-dir=' + path.join(tmp, 'ud')], cwd: ROOT,
    env: { ...process.env, HOME: home, ZDOTDIR: home, FANBOX_PORT: String(PORT), FANBOX_AGENT_TOKEN: TOKEN, FANBOX_NO_RECORD: '1', FANBOX_FAKE_FEISHU: FAKE, FANBOX_FAKE_IDLE: idleFile, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
  });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForFunction(() => typeof term !== 'undefined' && document.readyState === 'complete', null, { timeout: 30000 });
  await sleep(1500);
  // 设置里有「离开时叫我」一行：默认开；没连通道时标出来
  await win.evaluate(() => document.querySelectorAll('.guide-overlay').forEach((el) => el.remove())); // 首次启动的引导层会挡住点击
  await win.click('#agent-config');
  const row = win.locator('.ap-row[data-always]');
  await row.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await row.locator('input').isChecked(), true, '默认开');
  assert.equal(await row.locator('[data-always-flag]').textContent(), '未连微信或飞书');
  assert.deepEqual(await win.evaluate(() => window.fanboxWin.reachState()), { ok: true, alwaysOn: true, wechat: false, feishu: false });

  // 标签栏默认常驻 Claude Code 和 Codex；DeepSeek Harness 在清单里排 Codex 后面，默认不勾；清单里没有只能打开桌面应用的条目
  assert.deepEqual(await win.evaluate(() => [...document.querySelectorAll('button[data-agent]')].map((b) => b.dataset.agent)), ['claude', 'codex']);
  assert.deepEqual(await win.evaluate(() => AGENT_REGISTRY.slice(0, 3).map((a) => a.id)), ['claude', 'codex', 'dsh']);
  assert.equal(await win.evaluate(() => AGENT_REGISTRY.some((a) => a.app || /^open -a /.test(a.cmd))), false);

  // 侧栏也有一个「离开时叫我」：和设置里是同一个状态。没连通道时开关亮着但圆点不亮
  const side = win.locator('#pw-reach');
  assert.equal(await side.isVisible(), true, '侧栏有这一行');
  assert.equal(await side.locator('.pw-switch.on').count(), 1, '默认开');
  assert.equal(await side.locator('.pw-dot.lit').count(), 0, '没连通道，圆点不亮');

  // 终端里有 fanbox-notify；没通道时不发，并告诉调用方别重试
  const call = (text, t) => fetch(`http://127.0.0.1:${PORT}/api/agent/notify`, { method: 'POST', headers: { 'x-fanbox-token': TOKEN, 'x-fanbox-term': t, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ text }) }).then((r) => r.json());
  const T = await win.evaluate(() => term.sessions[0].id);
  assert.ok(fs.statSync(path.join(home, '.fanbox', 'bin', 'fanbox-notify')).mode & 0o100, 'fanbox-notify 可执行');
  let r = await call('测试跑完了', T);
  assert.equal(r.ok, false); assert.equal(r.why, 'no_channel');

  // 连飞书：地址不对不存；对的先真发一条再存（这里把飞书换成本机假服务）
  assert.equal((await win.evaluate(() => window.fanboxWin.feishuSet('https://example.com/hook', ''))).ok, false);
  await win.locator('.ap-row[data-feishu]').click();
  await win.locator('[data-feishu-url]').fill(HOOK);
  if (process.argv[2]) await win.screenshot({ path: process.argv[2] });
  await win.locator('[data-feishu-save]').click();
  await win.waitForFunction(() => document.querySelector('[data-feishu-flag]').textContent.startsWith('已连'), null, { timeout: 8000 });
  assert.equal(await row.locator('[data-always-flag]').textContent(), '飞书');
  assert.equal(got.length, 1); assert.ok(got[0].content.text.includes('FanBox 已连上'));
  assert.equal(fs.statSync(path.join(tmp, 'ud', 'wechat', 'feishu.json')).mode & 0o777, 0o600, '地址是凭据，只许自己读');

  // 连上飞书后，侧栏圆点亮；在侧栏关掉，设置里再打开时也是关的，再从侧栏开回来
  await win.evaluate(() => reachBar.refresh());
  assert.equal(await side.locator('.pw-dot.lit').count(), 1, '连了飞书，圆点亮');
  if (process.argv[3]) await win.screenshot({ path: process.argv[3] });
  await win.evaluate(() => reachBar.flip());
  assert.equal((await win.evaluate(() => window.fanboxWin.reachState())).alwaysOn, false, '侧栏能关');
  assert.equal(await side.locator('.pw-switch.on').count(), 0);
  assert.equal(await side.locator('.pw-dot.lit').count(), 0, '关着，圆点不亮');
  await win.evaluate(() => reachBar.flip());
  assert.equal((await win.evaluate(() => window.fanboxWin.reachState())).alwaysOn, true, '侧栏能开');

  // 人在电脑前（空闲 0 秒）：只在界面提示，不发手机
  r = await call('我在电脑前不该收到', T);
  assert.equal(r.delivered, 'desktop'); assert.equal(got.length, 1);
  // 一分钟内同一个窗口再发：挡掉
  r = await call('又一条', T);
  assert.equal(r.delivered, 'skip');
  // 人离开了（空闲 10 分钟）、换一个窗口发：进发件箱，飞书群里收到，开头带着是哪个窗口
  fs.writeFileSync(idleFile, '600');
  const T2 = await win.evaluate(() => term.create({ background: true }).then((s) => s.id)).catch(() => null) || 'tX';
  r = await call('构建失败了，回来看一眼', T2);
  assert.equal(r.delivered, 'phone', JSON.stringify(r));
  for (let i = 0; i < 40 && got.length < 2; i++) await sleep(250);
  assert.equal(got.length, 2, '离开时发到飞书');
  assert.ok(/^「.+」构建失败了，回来看一眼$/.test(got[1].content.text), got[1].content.text);
  // 关掉「离开时叫我」：不发
  await row.locator('input').click(); await sleep(300);
  assert.equal(await side.locator('.pw-switch.on').count(), 0, '设置里关了，侧栏跟着关');
  r = await call('关着的时候', 'tY');
  assert.equal(r.ok, false); assert.equal(r.why, 'off');
  assert.deepEqual(errors, []);
  console.log('always-on checks passed: settings row, default on, fanbox-notify installed, no channel rejected, feishu connect (bad url refused, test message, 0600), at-desk stays on desktop, per-window gap, away goes to feishu with window label, off respected');
  await app.evaluate(({ app }) => app.exit(0));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0); // 假飞书服务上还挂着保活连接，等它自己关会拖很久
})().catch((e) => { console.error(e); process.exit(1); });
