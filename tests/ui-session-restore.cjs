'use strict';
// 重启后恢复会话回归：驱动真实 Electron，跑在隔离环境里（临时 HOME、独立 userData、端口 4735，窗口不显示、不抢前台）。
// 第一次启动：开三个窗口，用 hook 事件把它们变成 claude（在干活）、codex（收工）、claude（之后被关掉）；
// 关掉第三个，模拟系统关机后退出。第二次启动：FanBox 照常还原标签，两个会话在同目录的标签里续上（不另开重复标签），
// 在干活的那个带「接着干」。第三次启动：不重复续。
// claude / codex 换成假命令，只把收到的参数记进文件，不碰真 agent、不联网。
// 运行：NODE_PATH=<含playwright-core的node_modules> node tests/ui-session-restore.cjs（约 1 分钟）
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = 4735, TOKEN = 'ui-session-restore-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-ui-restore-'))); // 真实路径：/var 是 /private/var 的链接，标签目录报的是后者
const home = path.join(tmp, 'home');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj-a', 'proj-b', 'proj-c', 'fakebin']) fs.mkdirSync(path.join(home, d), { recursive: true });
const LOG = path.join(home, 'agent-args.log');
for (const name of ['claude', 'codex']) {
  const f = path.join(home, 'fakebin', name);
  fs.writeFileSync(f, `#!/bin/sh\nprintf '%s|%s|%s\\n' "${name}" "$PWD" "$*" >> "${LOG}"\nexec sleep 600\n`);
  fs.chmodSync(f, 0o755);
}
fs.writeFileSync(path.join(home, '.zshrc'), `export PATH="${path.join(home, 'fakebin')}:$PATH"\n`);
fs.mkdirSync(path.join(tmp, 'shell'));
fs.writeFileSync(path.join(tmp, 'shell', 'package.json'), JSON.stringify({ name: 'fanbox-ui-restore', version: '0.0.0', main: 'main.js' }));
fs.writeFileSync(path.join(tmp, 'shell', 'main.js'), `
const Module = require('module'), electron = require('electron');
class BW extends electron.BrowserWindow {
  constructor(o = {}) { super({ ...o, show: false, paintWhenInitiallyHidden: true, webPreferences: { ...(o.webPreferences || {}), backgroundThrottling: false } }); }
  show() {} focus() {} setAlwaysOnTop() {} moveTop() {}
}
const proxy = new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? BW : t[k]) });
const load = Module._load; Module._load = function (r, ...a) { return r === 'electron' ? proxy : load.call(this, r, ...a); };
electron.app.focus = () => {};
electron.dialog.showErrorBox = (t, m) => { console.error('[main error]', t, m); process.exit(1); };
electron.dialog.showMessageBoxSync = (...a) => { console.error('[main error] 退出时弹了确认框', JSON.stringify(a.slice(-1))); return 1; };
process.on('uncaughtException', (e) => { console.error('[main error]', e); process.exit(1); });
electron.app.whenReady().then(() => { try { electron.app.dock.hide(); } catch {} });
require(${JSON.stringify(path.join(ROOT, 'electron', 'main.js'))});`);

const api = (p, body, term) => fetch(`http://127.0.0.1:${PORT}/api/agent/${p}`, { method: 'POST', headers: { 'x-fanbox-token': TOKEN, 'content-type': 'application/json', ...(term ? { 'x-fanbox-term': term } : {}) }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const terms = () => fetch(`http://127.0.0.1:${PORT}/api/agent/terminals`, { headers: { 'x-fanbox-token': TOKEN } }).then((r) => r.json()).then((d) => d.terminals);
const MANIFEST = path.join(home, '.fanbox', 'session-restore.json');
const readManifest = () => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; } };
const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
// 退出实例：正常退出最多等 8 秒，退不掉就强杀（假 agent 还挂着 sleep 时 Electron 可能迟迟不退）
async function quit(app) { await Promise.race([app.close().catch(() => {}), sleep(8000)]); try { app.process().kill('SIGKILL'); } catch { /* 已退出 */ } await sleep(500); }
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('等不到：' + what); await sleep(300); } }

let mainErr = '', current = null;
async function launch() {
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules', 'electron')),
    args: [path.join(tmp, 'shell'), '--user-data-dir=' + path.join(tmp, 'ud')], cwd: ROOT,
    env: { ...process.env, HOME: home, ZDOTDIR: home, FANBOX_PORT: String(PORT), FANBOX_AGENT_TOKEN: TOKEN, FANBOX_NO_RECORD: '1' },
  });
  app.process().stderr.on('data', (d) => { const s = String(d); if (s.includes('[main error]')) mainErr += s; });
  current = app;
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof term !== 'undefined' && document.readyState === 'complete', null, { timeout: 30000 });
  return { app, win };
}

(async () => {
  const S1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', S2 = '0193f2aa-4c5e-7d21-b8e0-6a7c3d1f9e42', S3 = 'cccccccc-3333-4333-8333-cccccccccccc';
  const A = path.join(home, 'proj-a'), B = path.join(home, 'proj-b'), C = path.join(home, 'proj-c');
  try {
    // ---- 第一次启动：记清单 ----
    let { app, win } = await launch();
    await until(() => terms().then((r) => Array.isArray(r)).catch(() => false), 20000, '控制接口起来');
    assert.equal(fs.existsSync(MANIFEST), false, '没开过 agent 时不该有清单');
    const ta = (await api('create', { cwd: A })).id, tb = (await api('create', { cwd: B })).id, tc = (await api('create', { cwd: C })).id;
    assert.ok(ta && tb && tc, '三个窗口都开出来');
    await api('event', { hook_event_name: 'SessionStart', session_id: S1, cwd: A }, ta);
    await api('event', { hook_event_name: 'UserPromptSubmit', session_id: S1, cwd: A, prompt: '把发布脚本改成分片上传' }, ta);
    await api('event', { type: 'agent-turn-complete', 'thread-id': S2, cwd: B, 'input-messages': ['看一下'] }, tb);
    await api('event', { hook_event_name: 'SessionStart', session_id: S3, cwd: C }, tc);
    await api('event', { hook_event_name: 'Stop', session_id: S3, cwd: C }, tc);
    let m = await until(() => { const d = readManifest(); return d && d.windows.length === 3 && d; }, 5000, '清单记下三个窗口');
    assert.deepEqual(m.windows.map((w) => [w.agent, w.sessionId, w.cwd, w.busy]), [['claude', S1, A, true], ['codex', S2, B, false], ['claude', S3, C, false]]);
    console.log('✓ 记清单：三个窗口、目录、会话 id、谁在干活都对');

    assert.deepEqual(await win.evaluate(() => window.fanboxWin.restoreState()), { on: true }, '开关默认开');
    await api('kill', { id: tc });
    await sleep(2000);
    assert.equal(readManifest().windows.length, 3, '关窗后 8 秒内还留着（防关机时被删空）');
    m = await until(() => { const d = readManifest(); return d && d.windows.length === 2 && d; }, 12000, '关掉的窗口 8 秒后划掉');
    console.log('✓ 自己关掉的窗口 8 秒后从清单划掉');

    // 模拟系统关机：先来 shutdown 事件，再退出。在干活的窗口不能弹确认框拦住重启，清单不能被删空
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('shutdown'));
    await quit(app);
    m = readManifest();
    assert.ok(m && m.windows.length === 2, '退出后清单仍是两个窗口');
    assert.equal(mainErr, '', '退出过程没有报错或确认框：' + mainErr);
    console.log('✓ 关机退出：不弹确认框，清单定格在关机前');

    // ---- 第二次启动：续上 ----
    ({ app, win } = await launch());
    const lines = await until(() => { const l = logLines(); return l.length >= 2 && l; }, 30000, '两个窗口的 agent 被拉起');
    const claude = lines.find((l) => l.startsWith('claude|')), codex = lines.find((l) => l.startsWith('codex|'));
    assert.ok(claude && claude.split('|')[1] === A, 'claude 在原目录：' + claude);
    assert.match(claude, new RegExp(`--settings ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.fanbox/hooks/claude-settings\\.json --resume ${S1} （FanBox 重启恢复）`));
    assert.ok(codex && codex.split('|')[1] === B, 'codex 在原目录：' + codex);
    assert.ok(codex.endsWith(`resume ${S2}`), 'codex 收工的不补话：' + codex);
    assert.equal(lines.length, 2, '关掉的那个没回来');
    assert.equal(fs.existsSync(MANIFEST), false, '清单已认领');
    assert.ok(fs.existsSync(MANIFEST.replace('.json', '.last.json')), '认领后留一份 .last.json');
    const cwds = (await terms()).map((t) => t.cwd);
    assert.ok(cwds.filter((c) => c === A).length === 1 && cwds.filter((c) => c === B).length === 1, '恢复出来的窗口在终端列表里：' + cwds.join(', '));
    console.log('✓ 再次启动：两个会话在原来的标签里续上（没有重复标签），在干活的带「接着干」，收工的不打扰');
    await quit(app);

    // ---- 第三次启动：同一份清单不重复开 ----
    ({ app, win } = await launch());
    await until(() => terms().then((r) => Array.isArray(r)).catch(() => false), 20000, '控制接口起来');
    await sleep(5000);
    assert.equal(logLines().length, 2, '没有重复恢复');
    console.log('✓ 第三次启动：不重复开窗');

    // 关掉开关：清单清掉，之后也不再记
    await win.evaluate(() => window.fanboxWin.restoreSet(false));
    const td = (await api('create', { cwd: A })).id;
    await api('event', { hook_event_name: 'SessionStart', session_id: S1, cwd: A }, td);
    await sleep(1500);
    assert.equal(fs.existsSync(MANIFEST), false, '关掉后不记清单');
    console.log('✓ 关掉开关后不再记');
    await quit(app);
    console.log('全部通过');
  } catch (e) {
    console.error('✗', e.message);
    process.exitCode = 1;
  } finally {
    if (current) await Promise.race([current.close().catch(() => {}), sleep(5000)]);
    try { current && current.process().kill('SIGKILL'); } catch { /* 已退出 */ }
    if (process.env.KEEP) console.log('临时目录保留：' + tmp); else fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
