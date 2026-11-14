'use strict';
// 叫人的判断和文案（lib/notify.js）
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const nt = require('../lib/notify');

const base = { on: true, channel: true, idleS: 600, last: undefined };
const NOW = 1e12;

test('人不在电脑前才发手机；在电脑前只在界面提示', () => {
  assert.equal(nt.decide('测试跑完了', base, NOW).action, 'phone');
  assert.equal(nt.decide('测试跑完了', { ...base, idleS: 30 }, NOW).action, 'desktop');
  assert.equal(nt.decide('测试跑完了', { ...base, idleS: nt.AT_DESK_S }, NOW).action, 'phone');
});

test('没内容、关着、没通道：拒绝，并且告诉调用方别重试', () => {
  assert.equal(nt.decide('', base, NOW).why, 'empty');
  const off = nt.decide('x', { ...base, on: false }, NOW);
  assert.equal(off.action, 'reject'); assert.match(off.note, /不要重试/);
  const none = nt.decide('x', { ...base, channel: false }, NOW);
  assert.equal(none.why, 'no_channel'); assert.match(none.note, /不要重试/);
});

test('同一个窗口：半小时内同一句话不重发，一分钟内不连发', () => {
  assert.equal(nt.decide('a', { ...base, last: { at: NOW - 20 * 60000, text: 'a' } }, NOW).why, 'dup');
  assert.equal(nt.decide('a', { ...base, last: { at: NOW - 31 * 60000, text: 'a' } }, NOW).action, 'phone');
  assert.equal(nt.decide('b', { ...base, last: { at: NOW - 30000, text: 'a' } }, NOW).why, 'too_soon');
  assert.equal(nt.decide('b', { ...base, last: { at: NOW - 61000, text: 'a' } }, NOW).action, 'phone');
});

test('内容收拾：去掉多余空行，超长截断', () => {
  assert.equal(nt.clean('  a\r\n\n\n\nb  '), 'a\n\nb');
  assert.equal(nt.clean('字'.repeat(900)).length, nt.MAX_LEN);
  assert.equal(nt.clean(null), '');
});

test('发到手机的那条带上是哪个窗口', () => {
  assert.equal(nt.label('好了', 't3', 'fanbox'), '「fanbox t3」好了');
});

test('只连飞书时的直白提醒：等待和断线各一句，别的事件不发', () => {
  const w = nt.plainEvent('term_waiting', { id: 't2', name: 'web', minutes: 12, state: 'needs_permission', tail: 'x\n\nDo you want to proceed?\n❯ 1. Yes' });
  assert.match(w, /「web t2」停下来等你 12 分钟了（等你确认一个操作）/); assert.match(w, /Do you want to proceed\?/);
  assert.match(nt.plainEvent('resume_failed', { id: 't2', name: 'web', action: 'give_up' }), /试了 3 次没续上/);
  assert.equal(nt.plainEvent('watch', { name: 'x', line: 'y' }), '');
});

test('飞书地址只认群机器人的 webhook', () => {
  assert.ok(nt.isFeishuUrl('https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234-efgh'));
  assert.ok(nt.isFeishuUrl(' https://open.larksuite.com/open-apis/bot/v2/hook/abcd1234 '));
  for (const u of ['', 'http://open.feishu.cn/open-apis/bot/v2/hook/abcd1234', 'https://evil.com/open-apis/bot/v2/hook/abcd1234', 'https://open.feishu.cn.evil.com/open-apis/bot/v2/hook/abcd1234', 'https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234?x=1']) assert.equal(nt.isFeishuUrl(u), false, u);
});

test('飞书请求体：不带密钥不签名；带密钥按「时间戳\\n密钥」当 key、空消息做 HMAC', () => {
  assert.deepEqual(nt.feishuBody('hi', '', NOW), { msg_type: 'text', content: { text: 'hi' } });
  const b = nt.feishuBody('hi', 'sec', NOW);
  assert.equal(b.timestamp, String(NOW / 1000));
  assert.equal(b.sign, crypto.createHmac('sha256', `${b.timestamp}\nsec`).update('').digest('base64'));
  assert.ok(nt.feishuOk({ code: 0 })); assert.ok(nt.feishuOk({ StatusCode: 0 }));
  assert.equal(nt.feishuOk({ code: 19024, msg: 'Key Words Not Found' }), false); assert.equal(nt.feishuOk(null), false);
});
