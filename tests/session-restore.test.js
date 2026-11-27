'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/session-restore');

const SID = '5b1f0c2e-7a3d-4e9b-9c11-2f6d8a4e0b73';

test('命令：claude 和 codex 带 hooks 续上，在干活的补一句接着干', () => {
  assert.equal(R.command({ agent: 'claude', sessionId: SID }),
    `claude --dangerously-skip-permissions --settings "$HOME/.fanbox/hooks/claude-settings.json" --resume ${SID}`);
  assert.match(R.command({ agent: 'codex', sessionId: SID }), new RegExp(`^codex -c "notify=\\[\\\\"\\$HOME/\\.fanbox/hooks/codex-notify\\.sh\\\\"\\]" resume ${SID}$`));
  const busy = R.command({ agent: 'claude', sessionId: SID, busy: true });
  assert.ok(busy.endsWith(` '${R.BUSY_PROMPT}'`));
});

test('命令：认不出的 agent、可疑的会话 id 一律不拼', () => {
  assert.equal(R.command({ agent: 'agy', sessionId: SID }), '');
  assert.equal(R.command({ agent: 'claude', sessionId: 'abc; rm -rf ~' }), '');
  assert.equal(R.command({ agent: 'claude', sessionId: '' }), '');
  assert.equal(R.command(null), '');
});

test('记录：只记拿到了会话 id 和目录的 claude/codex', () => {
  assert.deepEqual(R.entryOf('t58', { agent: 'claude', sessionId: SID, cwd: '/x', state: 'working' }),
    { agent: 'claude', sessionId: SID, cwd: '/x', busy: true, order: 58 });
  assert.equal(R.entryOf('t1', { agent: 'claude', sessionId: '', cwd: '/x' }), null);
  assert.equal(R.entryOf('t1', { agent: 'claude', sessionId: SID, cwd: '' }), null);
  assert.equal(R.entryOf('t1', { agent: 'kimi', sessionId: SID, cwd: '/x' }), null);
  assert.equal(R.entryOf('t1', { agent: 'claude', sessionId: SID, cwd: '/x', state: 'needs_input' }).busy, false);
});

test('写盘、认领、只恢复一次；目录没了的跳过；同一会话去重、按开窗先后排', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-restore-'));
  const file = path.join(dir, 'session-restore.json');
  const live = path.join(dir, 'proj');
  fs.mkdirSync(live);
  R.save([
    { agent: 'codex', sessionId: 'bbbbbbbb', cwd: live, busy: false, order: 9 },
    { agent: 'claude', sessionId: 'aaaaaaaa', cwd: live, busy: true, order: 3 },
    { agent: 'claude', sessionId: 'aaaaaaaa', cwd: live, busy: true, order: 12 },
    { agent: 'claude', sessionId: 'cccccccc', cwd: path.join(dir, 'gone'), busy: false, order: 1 },
  ], file);
  const data = R.claim(file);
  assert.ok(data);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(dir, 'session-restore.last.json')), true);
  assert.equal(R.claim(file), null); // 第二次启动认领不到：不会重复开窗
  const wins = R.plan(data);
  assert.deepEqual(wins.map((w) => w.sessionId), ['aaaaaaaa', 'bbbbbbbb']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('认领：坏文件不恢复也不报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-restore-'));
  const file = path.join(dir, 'session-restore.json');
  fs.writeFileSync(file, '{半份');
  assert.equal(R.claim(file), null);
  assert.deepEqual(R.plan(null), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
