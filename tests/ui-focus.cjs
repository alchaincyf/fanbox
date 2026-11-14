'use strict';
// 焦点保护 / 后台提醒 / 系统通知闸门 / 中文标点（#66）回归。驱动真实 Electron，跑在隔离环境里：
// 临时 HOME、独立 userData、端口 4733，窗口不显示、不抢前台，系统通知全部换成假的（不在系统里留登记）。
// 运行：NODE_PATH=<含playwright-core的node_modules> node tests/ui-focus.cjs
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = 4733, TOKEN = 'ui-focus-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-ui-focus-'));
const home = path.join(tmp, 'home');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj']) fs.mkdirSync(path.join(home, d), { recursive: true });
// 外壳：窗口一律不显示、focus/置顶空转，再加载真实主进程
fs.mkdirSync(path.join(tmp, 'shell'));
fs.writeFileSync(path.join(tmp, 'shell', 'package.json'), JSON.stringify({ name: 'fanbox-ui-focus', version: '0.0.0', main: 'main.js' }));
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

(async () => {
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [path.join(tmp, 'shell'), '--user-data-dir=' + path.join(tmp, 'ud')], cwd: ROOT,
    env: { ...process.env, HOME: home, ZDOTDIR: home, FANBOX_PORT: String(PORT), FANBOX_AGENT_TOKEN: TOKEN, FANBOX_NO_RECORD: '1' },
  });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForFunction(() => typeof term !== 'undefined' && document.readyState === 'complete', null, { timeout: 30000 });
  await sleep(1500); // 等启动时的延迟提示放完
  await win.evaluate(() => {
    localStorage.setItem('fb_guided', '1'); document.querySelector('.guide-overlay')?.remove();
    while (term.sessions.length) term.closeTab(term.sessions[0].id);
    window.__log = []; window.__notes = []; window.__req = 0;
    const input = term.input.bind(term); term.input = (id, d) => { window.__log.push([id, d]); return input(id, d); };
    window.Notification = class { constructor(t) { window.__notes.push(t); } static get permission() { return 'granted'; } static requestPermission() { window.__req++; return Promise.resolve('granted'); } close() {} };
  });
  const cdp = await win.context().newCDPSession(win);
  const st = () => win.evaluate(() => ({
    active: term.active, n: term.sessions.length, shown: term.sessions.filter((s) => s.host.classList.contains('show')).map((s) => s.id),
    focusTerm: (term.sessions.find((s) => s.host.contains(document.activeElement)) || {}).id || null, activeId: document.activeElement && document.activeElement.id,
    hidden: $('#terminal-panel').classList.contains('hidden'), toast: $('#toast').className.includes('hidden') ? '' : $('#toast').textContent,
  }));
  const typed = (id) => win.evaluate((id) => window.__log.filter((x) => x[0] === id).map((x) => x[1]).join(''), id);
  const clear = () => win.evaluate(() => { window.__log.length = 0; window.__notes.length = 0; window.__req = 0; });

  // 面板收着、没有终端、用户在 ⌘K 里打字：后台新开不弹面板、不抢焦点、只多一个标签，并给出提示
  await win.evaluate(() => cmdk.open());
  const A = (await api('create', { cwd: path.join(home, 'proj') })).id; await sleep(400);
  let s = await st();
  assert.ok(A && s.hidden && s.n === 1 && s.active === A && s.activeId === 'cmdk-input', '首次无终端：' + JSON.stringify(s));
  assert.match(s.toast, /后台新开了终端/);
  await win.evaluate(() => cmdk.close());
  // 用户主动打开面板、点标签：照常切过去并聚焦
  await win.evaluate(() => $('#btn-terminal').click()); await sleep(400);
  await win.evaluate((id) => document.querySelector(`#term-tabs .term-tab[data-id="${id}"]`).click(), A); await sleep(1500);
  assert.equal((await st()).focusTerm, A);
  // 输入法组合进行中后台新开：组合不被打断，上屏文字落回原终端
  await clear();
  await cdp.send('Input.imeSetComposition', { text: 'ce', selectionStart: 2, selectionEnd: 2 });
  const B = (await api('create', {})).id; await sleep(500);
  await cdp.send('Input.insertText', { text: '测试' }); await sleep(200);
  s = await st();
  assert.ok(B && s.active === A && s.focusTerm === A && !s.shown.includes(B), '组合中后台新开：' + JSON.stringify(s));
  assert.equal(await typed(A), '测试'); assert.equal(await typed(B), '');
  // 用户点「+」新建：切过去并聚焦
  await win.evaluate(() => $('#term-newtab').click()); await sleep(400);
  s = await st(); assert.ok(s.active !== A && s.focusTerm === s.active, '手动新建：' + JSON.stringify(s));
  await win.evaluate((id) => term.activate(id), A); await sleep(200);
  // 后台终端等你确认：焦点不动；macOS 未登记、没表过态 → 不发系统通知、不请求授权，提醒留在应用内
  await clear();
  await api('event', { hook_event_name: 'UserPromptSubmit' }, B);
  await api('event', { hook_event_name: 'Notification', notification_type: 'permission_prompt' }, B); await sleep(600);
  s = await st();
  assert.ok(s.active === A && s.focusTerm === A, '等你确认：' + JSON.stringify(s));
  assert.ok(await win.evaluate((id) => !!document.querySelector(`#term-roster .tr-row.st-ask[data-id="${id}"]`) && roster._badge === 1, B), '指挥台/角标');
  const gate = await win.evaluate(() => window.fanboxWin.notifyState());
  if (!gate.registered) assert.deepEqual(await win.evaluate(() => [window.__notes.length, window.__req]), [0, 0]);
  await win.evaluate(() => term.close()); await sleep(200);
  assert.ok(await win.evaluate(() => $('#btn-terminal').classList.contains('need')), '面板收着时终端按钮挂红点');
  await win.evaluate(() => roster.next()); await sleep(300);
  s = await st(); assert.ok(!s.hidden && s.active === B && s.focusTerm === B, '⌘⌥L 主动处理：' + JSON.stringify(s));
  await win.evaluate((id) => term.activate(id), A); await sleep(200);
  // 设置里亲手开 → 当面发测试通知，之后后台事件也发；亲手关 → 不发
  const fire = () => win.evaluate((id) => { window.__notes.length = 0; return term.notify(term.sessions.find((x) => x.id === id), '等待你确认', 'b'); }, B);
  await win.evaluate(() => agentsPop.open()); await sleep(400);
  if (!(await win.evaluate(() => document.querySelector('[data-notify] input').checked))) {
    await win.evaluate(() => document.querySelector('[data-notify] input').click()); await sleep(300);
    assert.ok(await win.evaluate(() => window.__notes.includes('FanBox 系统通知已开启')), '亲手开时发测试通知');
  }
  await fire(); assert.equal(await win.evaluate(() => window.__notes.length), 1);
  await win.evaluate(() => document.querySelector('[data-notify] input').click()); await sleep(200);
  await fire(); assert.equal(await win.evaluate(() => window.__notes.length), 0);
  await win.evaluate(() => agentsPop.close());
  // #66：输入法给的中文标点原样进终端；英文标点、多字符标点、普通按键不受影响
  const press = async (o, insert) => {
    await cdp.send('Input.dispatchKeyEvent', { type: o.text ? 'keyDown' : 'rawKeyDown', ...o });
    if (insert) await cdp.send('Input.insertText', { text: insert });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: o.key, code: o.code, windowsVirtualKeyCode: o.windowsVirtualKeyCode, modifiers: o.modifiers });
    await sleep(100);
  };
  for (const [o, want, insert] of [
    [{ key: ',', code: 'Comma', windowsVirtualKeyCode: 188, text: '，' }, '，'],
    [{ key: '.', code: 'Period', windowsVirtualKeyCode: 190, text: '。' }, '。'],
    [{ key: ',', code: 'Comma', windowsVirtualKeyCode: 188, text: ',' }, ','],
    [{ key: '^', code: 'Digit6', windowsVirtualKeyCode: 54, modifiers: 8 }, '……', '……'],
    [{ key: ';', code: 'Semicolon', windowsVirtualKeyCode: 186 }, ';'],
    [{ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' }, 'a'],
    [{ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, '\r'],
    [{ key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }, '\x1b[A'],
    [{ key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 }, '\x03'],
  ]) { await clear(); await press(o, insert); assert.equal(await typed(A), want, 'key ' + o.key); }
  assert.deepEqual(errors, []);
  console.log('UI focus checks passed: background create keeps tab/focus/IME, manual new/switch focus, in-app reminders, notification gate, IME punctuation');
  await app.evaluate(({ app }) => app.exit(0));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; });
