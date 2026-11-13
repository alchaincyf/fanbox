'use strict';
// 窗口互通与指挥台排队回归。驱动真实 Electron，跑在隔离环境里：
// 临时 HOME、独立 userData、端口 4735，窗口不显示、不抢前台，系统通知全部换成假的（不在系统里留登记）。
// 运行：NODE_PATH=<含playwright-core的node_modules> node tests/ui-relay.cjs（约半分钟）
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = 4735, TOKEN = 'ui-relay-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-ui-relay-'));
const home = path.join(tmp, 'home');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj']) fs.mkdirSync(path.join(home, d), { recursive: true });
// 外壳：窗口一律不显示、focus/置顶空转，再加载真实主进程
fs.mkdirSync(path.join(tmp, 'shell'));
fs.writeFileSync(path.join(tmp, 'shell', 'package.json'), JSON.stringify({ name: 'fanbox-ui-relay', version: '0.0.0', main: 'main.js' }));
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
  await win.evaluate(() => {
    localStorage.setItem('fb_guided', '1'); document.querySelector('.guide-overlay')?.remove();
    while (term.sessions.length) term.closeTab(term.sessions[0].id);
    window.__chimes = 0; const pc = playChime; playChime = (k) => { window.__chimes++; return pc(k); }; // eslint-disable-line no-global-assign
  });
  const proj = path.join(home, 'proj'), docs = path.join(home, 'Documents');
  const A = (await api('create', { cwd: proj })).id, B = (await api('create', { cwd: proj })).id, C = (await api('create', { cwd: docs })).id; await sleep(800);
  await win.evaluate(() => $('#btn-terminal').click()); await sleep(300);
  const ev = (t, name, extra) => api('event', { hook_event_name: name, session_id: 's-' + t, ...extra }, t);
  const relay = (t, body) => fetch(`http://127.0.0.1:${PORT}/api/agent/relay`, { method: 'POST', headers: { 'x-fanbox-token': TOKEN, 'content-type': 'application/json', 'x-fanbox-term': t }, body: JSON.stringify(body || { hook_event_name: 'UserPromptSubmit' }) }).then((r) => r.text());
  const ctx = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '');

  // 生成的钩子文件：发话和工具跑完两处各多一条同步的 relay，原来的异步上报还在
  const hooks = JSON.parse(fs.readFileSync(path.join(home, '.fanbox', 'hooks', 'claude-settings.json'), 'utf8')).hooks;
  for (const k of ['UserPromptSubmit', 'PostToolUse']) {
    const hs = hooks[k][0].hooks;
    assert.equal(hs.length, 2); assert.equal(hs[0].async, true); assert.ok(/\/event"/.test(hs[0].command));
    assert.ok(!hs[1].async && /\$FANBOX_CTL\/relay"/.test(hs[1].command) && /-m 2 /.test(hs[1].command), k + ' relay hook');
  }
  assert.equal(hooks.Stop[0].hooks.length, 1);

  // 还没有会话事实的窗口来问：什么都不给
  assert.equal(await relay(B), '');
  for (const [t, cwd] of [[A, proj], [B, proj], [C, docs]]) await ev(t, 'SessionStart', { cwd });
  // A 里说了一句：同目录的 B 收到，不同目录的 C 和 A 自己收不到；B 第二次问就没有了
  await ev(A, 'UserPromptSubmit', { cwd: proj, prompt: '发布日期从周五改到周三' });
  await ev(A, 'UserPromptSubmit', { cwd: proj, prompt: '继续' });
  const got = ctx(await relay(B));
  assert.ok(got.includes('窗口说') && got.includes('发布日期从周五改到周三') && got.includes('proj ' + A), got);
  assert.ok(!got.includes('：继续'), '几个字的催促不转');
  assert.equal(await relay(B), ''); assert.equal(await relay(C), ''); assert.equal(await relay(A), '');
  // 界面上说了一声
  await sleep(300);
  assert.ok(await win.evaluate(() => document.body.innerText.includes('转告给')), '转告有提示');
  // 子代理来问不给，也不吃掉主会话的那一份
  await ev(A, 'UserPromptSubmit', { cwd: proj, prompt: '标题里不要出现那个词' });
  assert.equal(await relay(B, { hook_event_name: 'PostToolUse', agent_id: 'sub1' }), '');
  const out = JSON.parse(await relay(B, { hook_event_name: 'PostToolUse' }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse'); assert.ok(out.hookSpecificOutput.additionalContext.includes('标题里不要出现那个词'));
  // 两个窗口改了同一个文件：后改的那次告诉先改的那个窗口，哪怕不在同一个目录
  const shared = path.join(proj, 'shared-config.js');
  await ev(C, 'PostToolUse', { cwd: docs, tool_name: 'Edit', tool_input: { file_path: shared } });
  await ev(A, 'PostToolUse', { cwd: proj, tool_name: 'Edit', tool_input: { file_path: shared } });
  await ev(A, 'PostToolUse', { cwd: proj, tool_name: 'Write', tool_input: { file_path: path.join(proj, 'only-a.js') } });
  const gc = ctx(await relay(C, { hook_event_name: 'PostToolUse' }));
  assert.ok(gc.includes(shared) && gc.includes('再动它之前先重新读一遍') && !gc.includes('only-a.js'), gc);
  // 家目录下的两个窗口之间不转
  const H1 = (await api('create', { cwd: home })).id, H2 = (await api('create', { cwd: home })).id; await sleep(500);
  await ev(H1, 'SessionStart', { cwd: home }); await ev(H2, 'SessionStart', { cwd: home });
  await ev(H1, 'UserPromptSubmit', { cwd: home, prompt: '家目录窗口里说的一件私事' });
  assert.equal(await relay(H2), '');
  await win.evaluate((ids) => ids.forEach((i) => term.closeTab(i)), [H1, H2]); await sleep(300);
  // 别的 agent 经 /send 发进 A 的话不是你说的：不转
  await api('send', { id: A, text: '这句是兄弟 agent 发来的指令', submit: false });
  await ev(A, 'UserPromptSubmit', { cwd: proj, prompt: '这句是兄弟 agent 发来的指令' });
  assert.equal(await relay(B), '');
  // codex 窗口：回合结束时带出你那回合说的话，转给同目录的 claude 窗口
  const D = (await api('create', { cwd: proj })).id; await sleep(500);
  await api('event', { type: 'agent-turn-complete', 'thread-id': 'th1', cwd: proj, 'input-messages': ['先别管样式', '接口返回值改成数组了'] }, D);
  const gb = ctx(await relay(B));
  assert.ok(gb.includes('接口返回值改成数组了') && !gb.includes('先别管样式'), gb);
  // 关掉：不记也不送，之前记下的清掉；再打开只送打开之后的
  assert.deepEqual(await win.evaluate(() => window.fanboxWin.relayState()), { on: true });
  await ev(A, 'UserPromptSubmit', { cwd: proj, prompt: '关掉之前说的最后一句话' });
  await win.evaluate(() => window.fanboxWin.relaySet(false));
  assert.equal(await relay(B), '');
  await ev(A, 'UserPromptSubmit', { cwd: proj, prompt: '关着的时候说的一句话' });
  await win.evaluate(() => window.fanboxWin.relaySet(true));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.fanbox', 'config.json'), 'utf8')).relay, true);
  assert.equal(await relay(B), '');
  await ev(A, 'UserPromptSubmit', { cwd: proj, prompt: '重新打开之后说的一句话' });
  const gb2 = ctx(await relay(B));
  assert.ok(gb2.includes('重新打开之后说的') && !gb2.includes('关着的时候') && !gb2.includes('关掉之前'), gb2);

  // 指挥台排队：等你确认的在最前；同一档里先停下来的在前；显示等了多久
  for (const t of [A, B, C, D]) await ev(t, 'UserPromptSubmit', { cwd: proj });
  await win.evaluate((id) => term.activate(id), D);
  await ev(B, 'Stop'); await ev(B, 'Notification', { notification_type: 'idle_prompt' }); await sleep(1100);
  await ev(A, 'Stop'); await ev(A, 'Notification', { notification_type: 'idle_prompt' }); await sleep(1100);
  await ev(C, 'Notification', { notification_type: 'permission_prompt' }); await sleep(400);
  const order = () => win.evaluate(() => [...document.querySelectorAll('#term-roster .tr-row')].map((el) => el.dataset.id));
  assert.deepEqual(await order(), [C, B, A], '等你确认在前，其余按等待先后');
  await win.evaluate((id) => { term.sessions.find((x) => x.id === id)._needSince = Date.now() - (125 * 60000 + 5000); roster.render(); }, A);
  assert.deepEqual(await order(), [C, A, B], '等得更久的排到前面');
  assert.equal(await win.evaluate((id) => document.querySelector(`#term-roster .tr-row[data-id="${id}"] .tr-wait`).textContent, A), '等了 2 小时 5 分');
  assert.equal(await win.evaluate((id) => !!document.querySelector(`#term-roster .tr-row[data-id="${id}"] .tr-wait`), B), false, '不到一分钟不显示');
  assert.deepEqual(errors, []);
  console.log('relay checks passed: hook file, same-dir delivery, cursor, subagent skipped, shared-file edits, home dir excluded, agent-sent text skipped, codex as source, off/on, roster queue order and wait time');
  await app.evaluate(({ app }) => app.exit(0));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); }); // 直接退：断言失败时 Electron 还开着，不退会一直挂住
