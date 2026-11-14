'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateRate } = require('../lib/agent-tokens');

const MIN = 60000;
const ev = (minAgo, total, output) => ({ t: Date.now() - minAgo * MIN, total, output, input: total - output, cacheRead: 0, cacheCreate: 0, msgs: 1 });

test('近1分钟窗口只收60s内事件，输出与总量分桶', () => {
  const now = Date.now();
  const r = aggregateRate([
    { t: now - 30 * 1000, total: 1000, output: 100, input: 900, cacheRead: 0, cacheCreate: 0 },
    { t: now - 59 * 1000, total: 500, output: 50, input: 450, cacheRead: 0, cacheCreate: 0 },
    { t: now - 61 * 1000, total: 999, output: 10, input: 0, cacheRead: 0, cacheCreate: 0 }, // 窗口外
  ], now);
  assert.equal(r.win60.total, 1500);
  assert.equal(r.win60.output, 150);
  assert.equal(r.win60.msgs, 2);
});

test('10个每分钟桶：[0]是最旧的，[9]是最近1分钟，10分钟外丢弃', () => {
  const now = Date.now();
  const r = aggregateRate([
    { t: now - 30 * 1000, total: 10, output: 1, input: 0, cacheRead: 0, cacheCreate: 0 },   // 桶[9]
    { t: now - 90 * 1000, total: 20, output: 2, input: 0, cacheRead: 0, cacheCreate: 0 },   // 桶[8]
    { t: now - 9.5 * MIN, total: 30, output: 3, input: 0, cacheRead: 0, cacheCreate: 0 },   // 桶[0]
    { t: now - 10.5 * MIN, total: 9999, output: 999, input: 0, cacheRead: 0, cacheCreate: 0 }, // 丢弃
  ], now);
  assert.equal(r.buckets[9].total, 10); assert.equal(r.buckets[9].output, 1);
  assert.equal(r.buckets[8].total, 20);
  assert.equal(r.buckets[0].total, 30);
  assert.ok(r.buckets.every((b, i) => i === 0 || i === 8 || i === 9 ? true : b.total === 0));
});

test('未来时间戳（时钟偏移）不纳入', () => {
  const now = Date.now();
  const r = aggregateRate([{ t: now + 5 * MIN, total: 42, output: 4, input: 0, cacheRead: 0, cacheCreate: 0 }], now);
  assert.equal(r.win60.total, 0);
  assert.ok(r.buckets.every((b) => b.total === 0));
});

test('空事件返回全零结构，前端可以无判空直读', () => {
  const r = aggregateRate([], Date.now());
  assert.deepEqual(r.win60, { total: 0, output: 0, input: 0, cacheRead: 0, cacheCreate: 0, msgs: 0 });
  assert.equal(r.buckets.length, 10);
  assert.ok(r.buckets.every((b) => b.total === 0 && b.output === 0));
});
