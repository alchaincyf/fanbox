'use strict';
// 预览跟随键盘光标 + ⌘⇧G 前往文件夹 回归。驱动真实 Electron，跑在隔离环境里：
// 临时 HOME、独立 userData、端口 4737，窗口不显示、不抢前台，系统通知全部换成假的（不在系统里留登记）。
// 运行：NODE_PATH=<含playwright-core的node_modules> node tests/ui-goto-preview.cjs
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = 4737, TOKEN = 'ui-goto-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-ui-goto-'));
const home = path.join(tmp, 'home');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj', 'fix/sub']) fs.mkdirSync(path.join(home, d), { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
for (const n of ['a1.png', 'a2.png', 'a3.png', 'a4.png']) fs.writeFileSync(path.join(home, 'fix', n), PNG);
fs.writeFileSync(path.join(home, 'fix', 'note.txt'), 'hello');
const SHOTS = '/private/tmp/claude-501/-Users-lyrl-orca-workspaces-fanbox-fb1-2/6f1c43ee-2517-4a53-9d5c-e54759c2a7a7/scratchpad/shots';
fs.mkdirSync(SHOTS, { recursive: true });
// 外壳：窗口一律不显示、focus/置顶空转，再加载真实主进程
fs.mkdirSync(path.join(tmp, 'shell'));
fs.writeFileSync(path.join(tmp, 'shell', 'package.json'), JSON.stringify({ name: 'fanbox-ui-goto', version: '0.0.0', main: 'main.js' }));
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
  await sleep(1500);
  await win.evaluate(() => {
    localStorage.setItem('fb_guided', '1'); document.querySelector('.guide-overlay')?.remove();
    while (term.sessions.length) term.closeTab(term.sessions[0].id);
  });
  const shot = (n) => win.screenshot({ path: path.join(SHOTS, n + '.png') });
  const fix = path.join(home, 'fix');
  const S = () => win.evaluate(() => ({
    cwd: state.cwd, cursor: state.cursor, cur: (state.visible[state.cursor] || {}).name,
    pvHidden: $('#preview').classList.contains('hidden'), title: $('#preview-title').textContent,
    img: (document.querySelector('#preview-body .pv-img') || {}).src || '', dialog: !!document.querySelector('.input-overlay'),
    toast: $('#toast').className.includes('hidden') ? '' : $('#toast').textContent, toastErr: $('#toast').className.includes('err'),
    editor: !!document.querySelector('#preview-body .monaco-editor, #preview-body .cm-editor, #preview-body textarea'),
  }));
  const goto = async (p) => { await win.evaluate((p) => navigate(p), p); await sleep(500); };
  const key = async (k, n = 1, gap = 0) => { for (let i = 0; i < n; i++) { await win.keyboard.press(k); if (gap) await sleep(gap); } };
  const names = () => win.evaluate(() => state.visible.map((e) => e.name));
  const setCursor = (name) => win.evaluate((n) => { state.cursor = state.visible.findIndex((e) => e.name === n); highlightCursor(); }, name);
  const blurAll = () => win.evaluate(() => document.activeElement && document.activeElement.blur());

  // 1. 预览开着，方向键切图
  await goto(fix);
  const order = await names();
  console.log('order', order.join(','));
  await win.click('[data-path$="/a1.png"]'); await sleep(600);
  await blurAll();
  let s = await S();
  assert.ok(!s.pvHidden && s.img.includes('a1.png'), '点开 a1：' + JSON.stringify(s));
  const i1 = order.indexOf('a1.png');
  assert.equal(order[i1 + 1], 'a2.png');
  await setCursor('a1.png');
  await key('ArrowRight'); await sleep(500); s = await S();
  assert.ok(s.img.includes('a2.png') && s.title === 'a2.png', '→ 一下应切到 a2：' + JSON.stringify(s));
  await shot('1-follow-a2');
  // 连按：a2 → a3 → a4 → note.txt → a4 …，不等渲染完，最终必须落在最后一个光标上
  await key('ArrowRight', 2, 5); await sleep(700); s = await S();
  assert.ok(s.img.includes('a4.png') && s.cur === 'a4.png', '连按 → 终态应为 a4：' + JSON.stringify(s));
  // 竞态：图 → txt → 图 极快连发，txt 的异步读文件不能晚于图覆盖回来
  await setCursor('a3.png'); await key('ArrowRight'); await sleep(500);
  const ni = order.indexOf('note.txt'), a4 = order.indexOf('a4.png');
  assert.equal(ni, a4 + 1, 'note.txt 紧跟 a4（排序假设）');
  for (let r = 0; r < 15; r++) {
    await setCursor('a4.png'); await key('ArrowRight'); await key('ArrowLeft'); await sleep(900);
    s = await S();
    assert.ok(s.img.includes('a4.png') && !s.editor, `竞态第 ${r} 轮：终态应为 a4 图 ${JSON.stringify(s)}`);
  }

  // 2. txt 切换不报错；目录不动
  await setCursor('a4.png'); await key('ArrowRight'); await sleep(800); s = await S();
  assert.equal(s.cur, 'note.txt'); assert.equal(s.title, 'note.txt', 'txt 预览：' + JSON.stringify(s));
  await shot('2-follow-txt');
  await blurAll();
  const sub = order.indexOf('sub'); assert.ok(sub >= 0);
  // 直接把光标放到 sub 邻格再用方向键走过去，保证走的是键盘路径
  const neighbor = sub > 0 ? order[sub - 1] : order[sub + 1];
  await setCursor(neighbor); await blurAll();
  await key(sub > 0 ? 'ArrowRight' : 'ArrowLeft'); await sleep(500);
  const before = await S(); // 此刻光标在 sub 上
  assert.equal(before.cur, 'sub');
  assert.equal(before.cwd, fix, '光标压在目录上不进入');
  assert.ok(!before.pvHidden, '预览仍开着');
  assert.notEqual(before.title, 'sub', '预览不跟到目录');
  await shot('3-cursor-on-dir');

  // 3. 预览关着：只移高亮
  await win.evaluate(() => closePreview()); await sleep(300);
  await setCursor('a1.png'); await blurAll(); await key('ArrowRight'); await sleep(500); s = await S();
  assert.ok(s.pvHidden && s.cur === 'a2.png', '预览关着不弹：' + JSON.stringify(s));

  // 4. ⌘⇧G
  const root = await win.evaluate(() => state.home);
  await blurAll(); await goto(fix);
  await key('Meta+Shift+G'); await sleep(300); s = await S();
  assert.ok(s.dialog, '⌘⇧G 应弹窗'); await shot('4-dialog');
  assert.equal(await win.evaluate(() => document.querySelector('.input-dialog .input-title').textContent), '前往文件夹');
  await win.keyboard.type('~/fix/sub'); await key('Enter'); await sleep(700); s = await S();
  assert.equal(s.cwd, path.join(fix, 'sub'), '跳到 sub：' + JSON.stringify(s)); assert.ok(!s.dialog);
  await goto(fix);
  await key('Meta+Shift+G'); await sleep(300);
  await win.keyboard.type('~/no/such/dir'); await key('Enter'); await sleep(700); s = await S();
  assert.equal(s.cwd, fix, '不存在的路径不改 cwd'); assert.ok(s.toastErr && /无法打开|Can't open/.test(s.toast), 'toast：' + JSON.stringify(s)); await shot('5-bad-path');
  await key('Meta+Shift+G'); await sleep(300);
  await win.keyboard.type('~/fix/note.txt'); await key('Enter'); await sleep(700); s = await S();
  assert.equal(s.cwd, fix, '文件路径不改 cwd');
  await key('Meta+Shift+G'); await sleep(300); await key('Escape'); await sleep(300); s = await S();
  assert.ok(!s.dialog && s.cwd === fix, 'Esc 关弹窗：' + JSON.stringify(s));
  // 输入框里不触发：在 ⌘K 输入框里按 ⌘⇧G 不弹
  await win.evaluate(() => cmdk.open()); await sleep(200);
  await key('Meta+Shift+G'); await sleep(300); s = await S();
  assert.ok(!s.dialog, '输入框内不触发'); await win.evaluate(() => cmdk.close());

  // 5. 终端里按 ⌘⇧G
  await win.evaluate(() => { while (term.sessions.length) term.closeTab(term.sessions[0].id); });
  const A = (await api('create', { cwd: fix })).id; await sleep(600);
  await win.evaluate(() => $('#btn-terminal').click()); await sleep(400);
  await win.evaluate((id) => document.querySelector(`#term-tabs .term-tab[data-id="${id}"]`).click(), A); await sleep(1500);
  const inTerm = await win.evaluate(() => !!(document.activeElement && document.activeElement.closest('.xterm')));
  if (!inTerm) console.log('NOTE: 终端未能聚焦，跳过终端内 ⌘⇧G 断言');
  else {
    await key('Meta+Shift+G'); await sleep(300); s = await S();
    assert.ok(s.dialog, '终端内 ⌘⇧G 应弹窗'); await shot('6-dialog-from-term'); await key('Escape'); await sleep(300);
    // Ctrl+Shift+G 属于终端里的 TUI：不弹窗，且终端的自定义键盘处理返回 true（= 交给 xterm 处理）。
    // xterm 对 Ctrl+Shift+G 自身不产生数据（onData/onKey 均为空），所以直接取处理函数的返回值作信号；⌘⇧G 对照应返回 false（冒泡给全局）
    await win.evaluate(() => document.querySelector('.xterm-helper-textarea').focus()); // 弹窗关掉后焦点没回终端，手动聚回
    await key('Control+Shift+G'); await sleep(300); s = await S();
    assert.ok(!s.dialog, 'Ctrl+Shift+G 不应弹窗');
    const verdict = await win.evaluate(() => {
      const h = term.sessions[0].xterm._core._customKeyEventHandler;
      const ev = (o) => h(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', shiftKey: true, ...o }));
      return { ctrl: ev({ ctrlKey: true }), meta: ev({ metaKey: true }) };
    });
    assert.deepEqual(verdict, { ctrl: true, meta: false }, 'Ctrl+Shift+G 应留给 xterm、⌘⇧G 应冒泡：' + JSON.stringify(verdict));
    console.log('terminal focused: ⌘⇧G ok');
  }
  assert.deepEqual(errors, []);
  console.log('UI goto/preview checks passed: preview follows arrow cursor (no stale overwrite), dir/closed preview untouched, ⌘⇧G go-to-folder');
  await app.evaluate(({ app }) => app.exit(0));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
