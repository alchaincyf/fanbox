'use strict';
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const artifacts = path.join(ROOT, 'tests/artifacts/agent-launch');
fs.mkdirSync(artifacts, { recursive: true });
const temporary = fs.mkdtempSync(path.join(artifacts, 'desktop-home-'));
const home = path.join(temporary, 'home');
const project = path.join(home, 'Documents', 'demo project 中文');
for (const folder of ['Desktop', 'Documents', 'Downloads', 'bin']) fs.mkdirSync(path.join(home, folder), { recursive: true });
fs.mkdirSync(project);
fs.writeFileSync(path.join(home, '.zshrc'), `export PATH='${path.join(home, 'bin')}':$PATH\nPROMPT='%# '\n`);
for (const agent of ['agy', 't3']) {
  fs.writeFileSync(path.join(home, 'bin', agent), `#!/bin/sh\nprintf 'LAUNCH:${agent}:%s:%s\\n' "$PWD" "$*"\nexec sleep 120\n`, { mode: 0o755 });
}
const shell = path.join(temporary, 'shell');
fs.mkdirSync(shell);
fs.writeFileSync(path.join(shell, 'package.json'), JSON.stringify({ name: 'fanbox-ui-launch', version: '0.0.0', main: 'main.js' }));
fs.writeFileSync(path.join(shell, 'main.js'), `
const Module = require('module'), electron = require('electron');
class HiddenWindow extends electron.BrowserWindow {
  constructor(options = {}) { super({ ...options, show: false, paintWhenInitiallyHidden: true, webPreferences: { ...(options.webPreferences || {}), backgroundThrottling: false } }); }
  show() {} focus() {} setAlwaysOnTop() {} moveTop() {}
}
const proxy = new Proxy(electron, { get: (target, key) => key === 'BrowserWindow' ? HiddenWindow : target[key] });
const originalLoad = Module._load;
Module._load = function (request, ...args) { return request === 'electron' ? proxy : originalLoad.call(this, request, ...args); };
electron.app.focus = () => {};
electron.app.whenReady().then(() => electron.app.dock.hide());
electron.dialog.showErrorBox = (title, message) => { console.error(title, message); process.exit(1); };
require(${JSON.stringify(path.join(ROOT, 'electron/main.js'))});`);

(async () => {
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules/electron')),
    args: [shell, '--user-data-dir=' + path.join(temporary, 'user-data')], cwd: ROOT,
    env: { ...process.env, HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', FANBOX_PORT: '4750', FANBOX_AGENT_TOKEN: 'ui-launch-test', FANBOX_NO_RECORD: '1' },
  });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => typeof term !== 'undefined' && document.readyState === 'complete');
    await page.waitForTimeout(1500);
    await page.evaluate(async (directory) => {
      localStorage.setItem('fb_guided', '1'); document.querySelector('.guide-overlay')?.remove();
      while (term.sessions.length) term.closeTab(term.sessions[0].id);
      await navigate(directory);
      window.launchOutput = [];
      window.fanboxPty.onData((message) => window.launchOutput.push(message));
      window.launchInputs = [];
      const originalInput = term.input.bind(term);
      term.input = (id, data) => { window.launchInputs.push({ id, data }); originalInput(id, data); };
      await term.openInDir(directory);
    }, project);
    await page.waitForFunction(() => window.launchOutput.length > 0);
    await page.waitForFunction(async () => term.sessions.length === 1 && await term.isPlainShell(term.sessions[0]));
    const original = await page.evaluate(() => term.active);
    await page.locator('#term-agy').click();
    await page.waitForFunction(() => window.launchOutput.some(message => message.data.includes('LAUNCH:agy:')));
    assert.equal(await page.evaluate(() => term.active), original, 'idle shell reused');
    assert.equal(await page.evaluate(() => term.sessions.length), 1);
    assert.ok(await page.evaluate((directory) => window.launchOutput.map(message => message.data).join('').includes(`LAUNCH:agy:${directory}:--dangerously-skip-permissions`), project));
    await page.waitForFunction(async () => !(await term.isPlainShell(term.sessions[0])));
    await page.screenshot({ path: path.join(artifacts, 'desktop-agy-command-cwd.png') });
    await page.locator('#agent-config').click();
    await page.locator('.ap-row[data-id="t3"] input').check();
    await page.evaluate(() => agentsPop.close());
    await page.locator('#term-t3').click();
    await page.waitForFunction(() => window.launchOutput.some(message => message.data.includes('LAUNCH:t3:')));
    assert.equal(await page.evaluate(() => term.sessions.length), 2, 'busy terminal gets a new tab');
    assert.notEqual(await page.evaluate(() => term.active), original);
    assert.ok(await page.evaluate((directory) => window.launchOutput.map(message => message.data).join('').includes(`LAUNCH:t3:${directory}:`), project));
    assert.deepEqual(await page.evaluate(() => window.launchInputs.map(input => input.data)), ['agy --dangerously-skip-permissions\r', 't3\r']);
    await page.screenshot({ path: path.join(artifacts, 'desktop-command-cwd.png') });
    assert.deepEqual(errors, []);
    console.log('Desktop launcher checks passed: actual PTY argv/cwd, idle reuse, busy new tab, no page errors');
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
