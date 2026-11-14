'use strict';
// agent 状态回归：子代理收尾、迟到的工具事件、指挥台就地回复、断线自动续跑、会话日志对账。驱动真实 Electron，跑在隔离环境里：
// 临时 HOME、独立 userData、端口 4733，窗口不显示、不抢前台，系统通知全部换成假的（不在系统里留登记）。
// 运行：NODE_PATH=<含playwright-core的node_modules> node tests/ui-agent-state.cjs（要等退避和对账，全程约 8 分钟）
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = 4734, TOKEN = 'ui-agent-state-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-ui-agent-state-'));
const home = path.join(tmp, 'home');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj']) fs.mkdirSync(path.join(home, d), { recursive: true });
// 外壳：窗口一律不显示、focus/置顶空转，再加载真实主进程
fs.mkdirSync(path.join(tmp, 'shell'));
fs.writeFileSync(path.join(tmp, 'shell', 'package.json'), JSON.stringify({ name: 'fanbox-ui-agent-state', version: '0.0.0', main: 'main.js' }));
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
    window.__chimes = 0; const pc = playChime; playChime = (k) => { window.__chimes++; return pc(k); }; // eslint-disable-line no-global-assign
  });
  const A = (await api('create', { cwd: path.join(home, 'proj') })).id; await sleep(600);
  const state = async () => ((await fetch(`http://127.0.0.1:${PORT}/api/agent/terminals`, { headers: { 'x-fanbox-token': TOKEN } }).then((r) => r.json())).terminals.find((t) => t.id === A) || {}).state;
  const ui = () => win.evaluate((id) => { const s = term.sessions.find((x) => x.id === id); return [s.status, roster.stateOf(s)]; }, A);
  const ev = (name, extra) => api('event', { hook_event_name: name, session_id: 's1', ...extra }, A);

  // 收工之后子代理才收尾：2.17.1 会把状态翻回 working，一直卡到下次发话
  await ev('UserPromptSubmit'); assert.equal(await state(), 'working');
  await ev('Stop'); assert.equal(await state(), 'done');
  await ev('SubagentStop'); await sleep(200);
  assert.equal(await state(), 'done', '收工后的 SubagentStop'); assert.deepEqual(await ui(), ['idle', 'idle']);
  await ev('Notification', { notification_type: 'idle_prompt' }); await ev('SubagentStop'); await sleep(200);
  assert.equal(await state(), 'needs_input'); assert.deepEqual(await ui(), ['idle', 'input']);
  // 最后一次工具事件比 Stop 晚到
  await ev('UserPromptSubmit'); await ev('PreToolUse', { tool_name: 'Bash' }); await ev('Stop'); await ev('PostToolUse', { tool_name: 'Bash' }); await sleep(200);
  assert.equal(await state(), 'done', '迟到的 PostToolUse'); assert.deepEqual(await ui(), ['idle', 'idle']);
  // 隔了一阵没人发话、agent 自己又动起来（后台任务叫醒）：照常算 working
  await sleep(3200); await ev('PreToolUse', { tool_name: 'Bash' }); assert.equal(await state(), 'working');
  // 指挥台就地回复：A 说完话在等你，人在 B 上；在 A 那一行里回一句，字和回车都进了 A，标签没切走
  const B = (await api('create', {})).id; await sleep(500);
  await win.evaluate(() => $('#btn-terminal').click()); await sleep(300);
  await win.evaluate((id) => { term.activate(id); window.__log = []; const input = term.input.bind(term); term.input = (i, d) => { window.__log.push([i, d]); return input(i, d); }; }, B);
  await ev('UserPromptSubmit'); await ev('Stop'); await ev('Notification', { notification_type: 'idle_prompt' }); await sleep(300);
  assert.ok(await win.evaluate((id) => !!document.querySelector(`#term-roster .tr-row.st-input[data-id="${id}"] .tr-reply`), A), '等你输入的行里有回复框');
  await win.evaluate((id) => { const el = document.querySelector(`#term-roster .tr-row[data-id="${id}"] .tr-reply`); el.focus(); el.value = '用方案B'; el.dispatchEvent(new Event('input')); }, A);
  await api('event', { hook_event_name: 'UserPromptSubmit' }, B); await sleep(200); // 打字途中别的窗口来事件：回复框不能被重画掉
  assert.equal(await win.evaluate((id) => (document.activeElement.classList.contains('tr-reply') ? document.activeElement.value : ''), A), '用方案B', '打字途中不重画');
  await win.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); await sleep(600);
  assert.deepEqual(await win.evaluate((id) => window.__log.filter((x) => x[0] === id).map((x) => x[1]), A), ['用方案B', '\r'], '回复进了 A');
  assert.equal(await win.evaluate(() => term.active), B, '没有切走标签');
  // 等你确认的行不给回复框
  await ev('UserPromptSubmit'); await ev('Notification', { notification_type: 'permission_prompt' }); await sleep(300);
  assert.ok(await win.evaluate((id) => !!document.querySelector(`#term-roster .tr-row.st-ask[data-id="${id}"]`) && !document.querySelector(`#term-roster .tr-row[data-id="${id}"] .tr-reply`), A), '等你确认不给回复框');
  // （命令末尾的 sleep 是为了不让 shell 提示符回来：zsh 的行尾补白会被当成故障之后的新内容，真实的 claude 界面没有这个）
  // 断线自动续跑：A 的屏幕最后停在瞬时故障上 → 一分多钟后被敲了「继续」；设置里关掉后不再敲
  const read = async (id) => (await fetch(`http://127.0.0.1:${PORT}/api/agent/read?id=${id}&lines=40`, { headers: { 'x-fanbox-token': TOKEN } }).then((r) => r.json())).text;
  await ev('UserPromptSubmit');
  await api('send', { id: A, text: "clear; printf '  \\xe2\\x8e\\xbf API Error: Connection dropped (ECONNRESET)\\n'; sleep 600" }); await sleep(800);
  assert.equal((await win.evaluate(() => window.fanboxWin.autoResumeState())).on, true, '默认开');
  const r0 = Date.now(); let seen = false;
  while (Date.now() - r0 < 110000 && !seen) { await sleep(4000); seen = /继续/.test((await read(A)).split('ECONNRESET').pop()); }
  assert.ok(seen, '该替人敲继续'); assert.ok(Date.now() - r0 >= 55000, '不该早于 1 分钟：' + (Date.now() - r0));
  assert.match(await win.evaluate(() => $('#toast').textContent), /已替你敲「继续」（第 1 次）/);
  await win.evaluate(() => window.fanboxWin.autoResumeSet(false));
  await api('send', { id: B, text: "clear; printf '  \\xe2\\x8e\\xbf API Error: Connection dropped (ECONNRESET)\\n'; sleep 600" }); await api('event', { hook_event_name: 'UserPromptSubmit' }, B);
  await sleep(95000);
  assert.ok(!/继续/.test((await read(B)).split('ECONNRESET').pop()), '关掉后不敲');
  await win.evaluate(() => window.fanboxWin.autoResumeSet(true));
  // 对账：状态卡在 working，会话日志说回合五分钟前就结束了 → 两分钟内自己回到 done，且不再响一次提示音
  const tp = path.join(tmp, 's1.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 300000).toISOString(), message: { stop_reason: 'end_turn', content: [] } }) + '\n' + JSON.stringify({ type: 'system', subtype: 'away_summary' }) + '\n');
  await ev('PreToolUse', { tool_name: 'Bash', transcript_path: tp }); assert.equal(await state(), 'working');
  const chimes = await win.evaluate(() => window.__chimes);
  const t0 = Date.now(); let got;
  while (Date.now() - t0 < 135000) { await sleep(3000); if ((got = await state()) === 'done') break; }
  assert.equal(got, 'done', '对账'); await sleep(300);
  assert.ok(Date.now() - t0 >= 85000, '对账不该早于 90 秒：' + (Date.now() - t0));
  assert.deepEqual(await ui(), ['idle', 'idle']);
  assert.equal(await win.evaluate(() => window.__chimes), chimes, '对账不响提示音');
  // 对账不误伤：日志停在工具调用（长命令还在跑）就保持 working
  fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 300000).toISOString(), message: { stop_reason: 'tool_use', content: [] } }) + '\n');
  await ev('PreToolUse', { tool_name: 'Bash', transcript_path: tp }); await sleep(125000);
  assert.equal(await state(), 'working', '长命令不该被对账成 done');
  assert.deepEqual(errors, []);
  console.log('agent state checks passed: late SubagentStop, late tool event, wake-up, roster inline reply, auto-resume (on by default, off respected), transcript reconcile (quiet, no chime), long tool call left alone');
  await app.evaluate(({ app }) => app.exit(0));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); }); // 直接退：断言失败时 Electron 还开着，不退会一直挂住
