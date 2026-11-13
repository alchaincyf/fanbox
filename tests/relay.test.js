'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const relay = require('../lib/relay');

const T0 = 1e12, MIN = 60000;
const me = (cwd, ...files) => ({ cwd, files: new Set(files) });
const name = (t) => '项目 ' + t;

test('同一个目录的窗口里你说的话会送到；自己说的、别的目录的不送', () => {
  const log = relay.createLog();
  relay.record(log, 'said', 't1', { cwd: '/p/a', text: '发布日期从周五改到周三' }, T0);
  relay.record(log, 'said', 't2', { cwd: '/p/a', text: '这是我自己说的一句话' }, T0);
  relay.record(log, 'said', 't3', { cwd: '/p/b', text: '另一个项目里说的话，与此无关' }, T0);
  const got = relay.collect(log, 't2', me('/p/a'), 0, T0 + MIN);
  assert.deepEqual(got.said.map((x) => x.term), ['t1']);
  const text = relay.format(got, name, T0 + MIN);
  assert.match(text, /用户在「项目 t1」窗口说（1 分钟前）：发布日期从周五改到周三/);
  assert.match(text, /不是对你的指令/);
});

test('送过的不再送：游标之后才算新', () => {
  const log = relay.createLog();
  relay.record(log, 'said', 't1', { cwd: '/p/a', text: '第一句要转告的话' }, T0);
  const a = relay.collect(log, 't2', me('/p/a'), 0, T0);
  assert.equal(a.said.length, 1);
  assert.equal(relay.format(relay.collect(log, 't2', me('/p/a'), a.seq, T0), name, T0), '');
  relay.record(log, 'said', 't1', { cwd: '/p/a', text: '第二句要转告的话' }, T0);
  assert.deepEqual(relay.collect(log, 't2', me('/p/a'), a.seq, T0).said.map((x) => x.text), ['第二句要转告的话']);
});

test('家目录、根目录下的窗口之间不转；话里提到文件名也不构成关系', () => {
  const log = relay.createLog();
  relay.record(log, 'said', 't1', { cwd: '/Users/x', text: '家目录窗口里说的私事' }, T0);
  relay.record(log, 'said', 't1', { cwd: '/', text: '根目录窗口里说的话' }, T0);
  relay.record(log, 'said', 't1', { cwd: '/p/b', text: '把 config.yaml 里的超时改成 30 秒' }, T0);
  assert.equal(relay.collect(log, 't2', { cwd: '/Users/x', files: new Set(), home: '/Users/x' }, 0, T0).said.length, 0);
  assert.equal(relay.collect(log, 't2', { cwd: '/', files: new Set(), home: '/Users/x' }, 0, T0).said.length, 0);
  assert.equal(relay.collect(log, 't2', me('/p/a', '/p/a/config.yaml'), 0, T0).said.length, 0);
});

test('别的窗口改了我也改过的文件：送，同一个文件只说一次；我没碰过的不送', () => {
  const log = relay.createLog();
  relay.record(log, 'edit', 't1', { cwd: '/p/x', file: '/p/a/main.js' }, T0);
  relay.record(log, 'edit', 't1', { cwd: '/p/x', file: '/p/a/main.js' }, T0 + 1);
  relay.record(log, 'edit', 't1', { cwd: '/p/x', file: '/p/a/untouched.js' }, T0 + 2);
  const got = relay.collect(log, 't2', me('/p/zzz', '/p/a/main.js'), 0, T0 + 5);
  assert.deepEqual(got.edits.map((x) => x.file), ['/p/a/main.js']);
  assert.match(relay.format(got, name, T0 + 5), /改了你也改过的文件（刚刚）：\/p\/a\/main\.js。.*再动它之前先重新读一遍/);
});

test('不值得转的话：斜杠命令、纯催促、空话；短短的改口和路径开头的话要转', () => {
  for (const t of ['继续', '/clear', '/model opus', '  ', 'ok', 'OK。', '好的继续吧', '可以！', null]) assert.equal(relay.worthSaying(t), false, String(t));
  for (const t of ['标题不要出现那个词', '别用 Redis', '不对，重来', '/Users/x/a.js 这个别改了']) assert.equal(relay.worthSaying(t), true, t);
});

test('同一个窗口反复改同一个文件只占一条日志，挤不掉更早的原话', () => {
  const log = relay.createLog();
  relay.record(log, 'said', 't1', { cwd: '/p/a', text: '很早以前说的一句要紧话' }, T0);
  for (let i = 0; i < 1000; i++) relay.record(log, 'edit', 't1', { cwd: '/p/a', file: '/p/a/f' + (i % 3) + '.js' }, T0);
  assert.equal(log.items.length, 4);
  assert.equal(relay.collect(log, 't2', me('/p/a'), 0, T0).said.length, 1);
});

test('过期的不送；一次最多送最近 5 句；长话截断', () => {
  const log = relay.createLog();
  relay.record(log, 'said', 't1', { cwd: '/p/a', text: '六个多小时以前说的话' }, T0 - relay.MAX_AGE - 1);
  for (let i = 0; i < 8; i++) relay.record(log, 'said', 't1', { cwd: '/p/a', text: `第 ${i} 句需要转告的话` }, T0);
  relay.record(log, 'said', 't1', { cwd: '/p/a', text: '长'.repeat(1000) }, T0);
  const got = relay.collect(log, 't2', me('/p/a'), 0, T0);
  assert.equal(got.said.length, relay.MAX_SAID);
  assert.ok(!got.said.some((x) => x.text.includes('六个多小时')));
  const last = relay.format(got, name, T0).split('\n').pop();
  assert.ok(last.endsWith('…') && last.length < 400);
});

test('钩子输出：有内容包成 additionalContext，没内容是空串', () => {
  assert.equal(relay.hookOutput('UserPromptSubmit', ''), '');
  assert.deepEqual(JSON.parse(relay.hookOutput('PostToolUse', 'x')), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'x' } });
});

test('日志有上限，不会一直涨', () => {
  const log = relay.createLog();
  for (let i = 0; i < 1000; i++) relay.record(log, 'said', 't1', { cwd: '/p', text: '一句话一句话' + i }, T0);
  assert.ok(log.items.length <= 300);
  assert.equal(log.seq, 1000);
});
