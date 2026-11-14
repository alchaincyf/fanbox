'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const ao = require('../lib/always-on');

const at = (h, m = 0) => new Date(2026, 10, 14, h, m, 0, 0).getTime(); // 本地时间 11-14 h:m
const MIN = 60000;

test('收件箱：同一个 key 只进一次；拿活时把待处理的一次全拿走', () => {
  const s = ao.empty();
  assert.equal(ao.inboxAdd(s, { kind: 'term_waiting', key: 'wait:t1:1' }, 1), true);
  assert.equal(ao.inboxAdd(s, { kind: 'term_waiting', key: 'wait:t1:1' }, 2), false);
  ao.inboxAdd(s, { kind: 'timer', key: 'timer:t9:5' }, 3);
  ao.inboxAdd(s, { kind: 'user_msg', key: 'wx:1' }, 4);
  const got = ao.inboxTake(s, (e) => e.kind !== 'user_msg');
  assert.deepEqual(got.map((e) => e.kind), ['term_waiting', 'timer']);
  assert.equal(ao.inboxTake(s, (e) => e.kind !== 'user_msg').length, 0); // 处理中的不会被第二个 worker 再拿
  ao.inboxDone(s, got.map((e) => e.id), 10);
  assert.equal(ao.inboxAdd(s, { kind: 'term_waiting', key: 'wait:t1:1' }, 11), false); // 处理完的仍然挡重复
});

test('收件箱：工作进程死在半路，重启后事件回到待处理；试满 3 次判失败', () => {
  let s = ao.empty();
  ao.inboxAdd(s, { kind: 'timer', key: 'k' }, 1);
  for (let i = 1; i <= ao.MAX_ATTEMPTS; i++) {
    assert.equal(ao.inboxTake(s).length, 1, '第 ' + i + ' 次能拿到');
    s = ao.recover(JSON.parse(JSON.stringify(s)), 100); // 模拟崩溃重启
  }
  assert.equal(s.inbox[0].status, 'failed');
  assert.equal(ao.inboxTake(s).length, 0);
});

test('收件箱：运行失败的事件放回去重试，不丢', () => {
  const s = ao.empty();
  ao.inboxAdd(s, { kind: 'timer', key: 'k' }, 1);
  const [e] = ao.inboxTake(s);
  ao.inboxDone(s, [e.id], 5, false);
  assert.equal(s.inbox[0].status, 'pending');
});

test('定时器：跟进到点进收件箱一次并标记完成；没到点不动', () => {
  const s = ao.empty();
  const t = ao.timerSet(s, { in: '30m', note: '看看 t3 测试跑完没' }, at(10));
  assert.equal(t.kind, 'followup'); assert.equal(t.due, at(10, 30));
  assert.equal(ao.timersFire(s, at(10, 29)), 0);
  assert.equal(ao.timersFire(s, at(10, 30)), 1);
  assert.equal(ao.timersFire(s, at(10, 31)), 0);
  assert.equal(s.timers[0].status, 'done');
  assert.deepEqual(s.inbox.map((e) => [e.kind, e.payload.note]), [['timer', '看看 t3 测试跑完没']]);
});

test('定时器：每日任务触发后排到第二天；错过的不补跑', () => {
  const s = ao.empty();
  const t = ao.timerSet(s, { daily: '09:00', note: '汇报各窗口进度' }, at(10));
  assert.equal(t.kind, 'schedule');
  assert.equal(t.due, at(9) + 86400e3);
  assert.equal(ao.timersFire(s, at(9) + 3 * 86400e3 + 5 * MIN), 1); // 机器睡了三天才醒：只触发一次
  assert.equal(s.timers[0].status, 'active');
  assert.equal(s.timers[0].due, at(9) + 4 * 86400e3);
});

test('定时器：不合法的不收（没备注、过去的时刻、太密的重复、上限）', () => {
  const s = ao.empty();
  assert.equal(ao.timerSet(s, { in: '30m', note: '' }, at(10)), null);
  assert.equal(ao.timerSet(s, { at: '2020-01-01T00:00', note: 'x' }, at(10)), null);
  assert.equal(ao.timerSet(s, { every: '1m', note: 'x' }, at(10)), null);
  assert.equal(ao.timerSet(s, { in: '10s', note: 'x' }, at(10)), null);
  assert.equal(ao.timerSet(s, { daily: '25:00', note: 'x' }, at(10)), null);
  for (let i = 0; i < 60; i++) ao.timerSet(s, { in: '1h', note: 'n' + i }, at(10));
  assert.equal(s.timers.length, 50);
});

test('从回复里抽定时器指令，标记不留在给用户看的正文里', () => {
  const r = ao.extractTimers('好，半小时后我再看。<timer in="30m">看 t3 的测试</timer>\n<timer daily="09:00">早报</timer><timer cancel="t12"/>');
  assert.equal(r.clean, '好，半小时后我再看。');
  assert.deepEqual(r.sets, [{ in: '30m', note: '看 t3 的测试' }, { daily: '09:00', note: '早报' }]);
  assert.deepEqual(r.cancels, ['t12']);
  const s = ao.empty(); const t = ao.timerSet(s, { in: '2h', note: 'x' }, at(10));
  assert.equal(ao.timerCancel(s, t.id, at(11)), true);
  assert.equal(ao.timersFire(s, at(13)), 0);
});

test('发件箱：夜里不发，攒到早上并成一条', () => {
  const s = ao.empty();
  ao.outboxAdd(s, 't3 等你确认删除', at(23, 30));
  ao.outboxAdd(s, 't5 断线续不上', at(2));
  assert.deepEqual(ao.outboxNext(s, at(2, 1)), { hold: 'quiet' });
  assert.deepEqual(ao.outboxNext(s, at(7, 59)), { hold: 'quiet' });
  const { msg } = ao.outboxNext(s, at(8));
  assert.ok(msg.text.includes('t3 等你确认删除') && msg.text.includes('t5 断线续不上'));
  ao.outboxMark(s, msg.id, at(8), true);
  assert.deepEqual(ao.outboxNext(s, at(8, 1)), { hold: 'empty' });
});

test('发件箱：两条之间至少隔 10 分钟；一天最多 20 条', () => {
  const s = ao.empty();
  const a = ao.outboxAdd(s, '第一条', at(10)); ao.outboxMark(s, ao.outboxNext(s, at(10)).msg.id, at(10), true);
  ao.outboxAdd(s, '第二条', at(10, 1));
  assert.deepEqual(ao.outboxNext(s, at(10, 9)), { hold: 'gap' });
  assert.equal(ao.outboxNext(s, at(10, 10)).msg.text, '第二条');
  assert.ok(a);
  const s2 = ao.empty();
  for (let i = 0; i < 20; i++) { ao.outboxAdd(s2, 'm' + i, at(9) + i * 11 * MIN); ao.outboxMark(s2, ao.outboxNext(s2, at(9) + i * 11 * MIN).msg.id, at(9) + i * 11 * MIN, true); }
  ao.outboxAdd(s2, '第 21 条', at(13));
  assert.deepEqual(ao.outboxNext(s2, at(13, 30)), { hold: 'cap' });
});

test('发件箱：发不出去不丢，退避着重试；用户一开口立刻再试；一天后才作废', () => {
  const s = ao.empty();
  const m = ao.outboxAdd(s, '发不出去的', at(10));
  ao.outboxMark(s, m.id, at(10), false);
  assert.deepEqual(ao.outboxNext(s, at(10) + 30000), { hold: 'retry' });
  assert.equal(ao.outboxNext(s, at(10, 1)).msg.id, m.id);
  for (let i = 0; i < 20; i++) ao.outboxMark(s, m.id, at(10, 1), false);
  assert.equal(s.outbox[0].status, 'pending');
  assert.deepEqual(ao.outboxNext(s, at(10, 30)), { hold: 'retry' }); // 最长退避 30 分钟
  ao.outboxRetryNow(s);
  assert.equal(ao.outboxNext(s, at(10, 2)).msg.id, m.id);
  ao.prune(s, at(10) + 25 * 3600e3);
  assert.equal(s.outbox[0].status, 'failed');
});

test('没人触发的运行有自己的限额：两次至少隔 3 分钟、一天最多 48 次；放了 6 小时的事件作废', () => {
  const s = ao.empty();
  assert.equal(ao.autoGate(s, at(10)), '');
  ao.autoRan(s, at(10));
  assert.equal(ao.autoGate(s, at(10, 2)), 'gap');
  assert.equal(ao.autoGate(s, at(10, 3)), '');
  for (let i = 1; i < 48; i++) ao.autoRan(s, at(10) + i * 5 * MIN);
  assert.equal(ao.autoGate(s, at(15)), 'cap');
  assert.equal(ao.autoGate(s, at(10) + 30 * 3600e3), '', '过了一天名额放回');
  ao.inboxAdd(s, { kind: 'timer', key: 'old' }, at(1));
  ao.inboxAdd(s, { kind: 'user_msg', key: 'wx:old' }, at(1));
  ao.autoGate(s, at(8));
  assert.deepEqual(s.inbox.map((e) => [e.kind, e.status]), [['timer', 'failed'], ['user_msg', 'pending']]);
});

test('没人触发的运行里定跟进：最短 10 分钟，不许定重复的', () => {
  const s = ao.empty();
  assert.equal(ao.timerSet(s, { in: '2m', note: 'x' }, at(10), { auto: true }), null);
  assert.equal(ao.timerSet(s, { daily: '09:00', note: 'x' }, at(10), { auto: true }), null);
  assert.ok(ao.timerSet(s, { in: '10m', note: 'x' }, at(10), { auto: true }));
  assert.ok(ao.timerSet(s, { in: '2m', note: 'x' }, at(10)));
});

test('盯梢防刷：一次最多报 10 条；输出每次都全是新的（带了会变的内容）连续 3 次就停掉并报告', () => {
  const s = ao.empty();
  const w = ao.watchSet(s, { name: 'n', every: '5m', cmd: 'c' }, at(10));
  ao.watchIngest(s, w.id, 'seed\n', at(10));
  assert.equal(ao.watchIngest(s, w.id, Array.from({ length: 30 }, (_, i) => 'line' + i).join('\n'), at(10, 5)), 10);
  const s2 = ao.empty();
  const w2 = ao.watchSet(s2, { name: 'n', every: '5m', cmd: 'c' }, at(10));
  ao.watchIngest(s2, w2.id, 'a 1分钟前\nb 1分钟前\nc 1分钟前\n', at(10));
  for (let i = 2; i <= 4; i++) ao.watchIngest(s2, w2.id, `a ${i}分钟前\nb ${i}分钟前\nc ${i}分钟前\n`, at(10, i * 5));
  assert.equal(s2.watches[0].status, 'done');
  assert.ok(s2.inbox.some((e) => e.kind === 'watch_broken' && /每次输出的行都不一样/.test(e.payload.err)));
});

test('处理完的用户消息不留原文和凭据；大脑没跑成的占位话认得出来', () => {
  const s = ao.empty();
  ao.inboxAdd(s, { kind: 'user_msg', key: 'wx:1', payload: { msg: { context_token: 'secret', text: '原文' } } }, 1);
  ao.inboxDone(s, [s.inbox[0].id], 2);
  assert.deepEqual(s.inbox[0].payload, {});
  assert.equal(ao.inboxAdd(s, { kind: 'user_msg', key: 'wx:1' }, 3), false);
  for (const t of ['（claude 出错）连接超时', '（没有返回内容）', '（codex 出错）x']) assert.equal(ao.isBrainError(t), true, t);
  assert.equal(ao.isBrainError('t3 等你确认'), false);
});

test('没人触发的一轮：提示里写明只能看、带上已经告诉过用户的；<silent/> 和空回复都算不发', () => {
  const s = ao.empty();
  ao.outboxAdd(s, 't3 在等你确认要不要删 dist', at(9)); ao.outboxMark(s, s.outbox[0].id, at(9), true);
  ao.inboxAdd(s, { kind: 'term_waiting', key: 'w', payload: { id: 't3', name: 'fanbox', state: 'needs_permission', minutes: 12, tail: 'Do you want to proceed?' } }, at(9, 30));
  const p = ao.autoPrompt(ao.inboxTake(s), ao.recentSent(s), at(9, 30));
  assert.match(p, /没有人给你发消息/); assert.match(p, /只能看/);
  assert.match(p, /终端「fanbox」的 agent 已经停下来等用户 12 分钟（状态：等确认一个操作）/);
  assert.match(p, /已经告诉过他的[\s\S]*09:00 t3 在等你确认要不要删 dist/);
  for (const r of ['<silent/>', ' <silent />\n', '', '   ']) assert.equal(ao.isSilent(r), true, JSON.stringify(r));
  assert.equal(ao.isSilent('t3 等你确认'), false);
});

test('落盘再读回：三张表都还在', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-ao-')), 'always.json');
  const s = ao.empty();
  ao.inboxAdd(s, { kind: 'timer', key: 'k' }, 1); ao.timerSet(s, { in: '1h', note: 'n' }, at(10)); ao.outboxAdd(s, 'm', at(10)); s.ctx = { u: 'tok' };
  ao.save(file, s);
  const r = ao.recover(ao.load(file), at(10));
  assert.equal(r.inbox.length, 1); assert.equal(r.timers.length, 1); assert.equal(r.outbox.length, 1); assert.equal(r.ctx.u, 'tok');
  assert.deepEqual(ao.recover(ao.load('/nonexistent/x.json'), 1), ao.empty());
});

test('盯梢：第一次只记底不叫醒；之后多出来的行才是事件；同一行不重复报', () => {
  const s = ao.empty();
  const w = ao.watchSet(s, { name: 'fanbox 新 issue', every: '15m', cmd: 'gh issue list' }, at(10));
  assert.equal(ao.watchesDue(s, at(10)).length, 1);
  assert.equal(ao.watchIngest(s, w.id, '#66 输入法标点\n#65 白屏\n', at(10)), 0);
  assert.equal(s.inbox.length, 0);
  assert.equal(ao.watchesDue(s, at(10, 14)).length, 0);
  assert.equal(ao.watchesDue(s, at(10, 15)).length, 1);
  assert.equal(ao.watchIngest(s, w.id, '#67 更新后打不开\n#66 输入法标点\n#65 白屏\n', at(10, 15)), 1);
  assert.deepEqual(s.inbox.map((e) => [e.kind, e.payload.name, e.payload.line]), [['watch', 'fanbox 新 issue', '#67 更新后打不开']]);
  assert.equal(ao.watchIngest(s, w.id, '#67 更新后打不开\n#66 输入法标点\n', at(10, 30)), 0);
  assert.match(ao.describe(s.inbox[0]), /盯着的「fanbox 新 issue」有新条目：#67 更新后打不开/);
});

test('盯梢：命令失败不当成「没有了」；连续 5 次失败报一次；同名的换掉；间隔下限 5 分钟', () => {
  const s = ao.empty();
  const w = ao.watchSet(s, { name: 'n', every: '1m', cmd: 'c' }, at(10));
  assert.equal(w.everyMs, 5 * MIN);
  ao.watchIngest(s, w.id, 'a\n', at(10));
  for (let i = 1; i <= 6; i++) ao.watchIngest(s, w.id, 'gh: not logged in', at(10) + i * 5 * MIN, false);
  assert.deepEqual(s.inbox.map((e) => e.kind), ['watch_broken']);
  assert.equal(ao.watchIngest(s, w.id, 'a\nb\n', at(11)), 1); // 恢复后照常，a 仍然算见过
  const w2 = ao.watchSet(s, { name: 'n', every: '30m', cmd: 'c2' }, at(11));
  assert.equal(s.watches.filter((x) => x.status === 'active').length, 1);
  assert.equal(ao.watchCancel(s, 'n', at(11)), true);
  assert.equal(ao.watchesDue(s, at(12)).length, 0);
  assert.ok(w2);
});

test('从回复里抽盯梢指令', () => {
  const r = ao.extractWatches(`好，我盯着。<watch every="15m" name="fanbox 新 issue">gh issue list -R a/b --json number,title --jq '.[]|"#\\(.number) \\(.title)"'</watch><watch cancel="w3"/>`);
  assert.equal(r.clean, '好，我盯着。');
  assert.deepEqual(r.sets, [{ name: 'fanbox 新 issue', every: '15m', cmd: `gh issue list -R a/b --json number,title --jq '.[]|"#\\(.number) \\(.title)"'` }]);
  assert.deepEqual(r.cancels, ['w3']);
});
