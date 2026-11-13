'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeNext, transcriptEndedAt, shouldSettle, LATE_MS } = require('../lib/agent-state');

// 照 electron/main.js 的 agentEvent 走一遍事件序列，返回最后的事实
function run(events) {
  const f = { agent: 'claude', state: 'working', restAt: 0, lastEventAt: 0 };
  for (const [at, name, extra] of events) {
    const { state } = claudeNext(f, { hook_event_name: name, ...extra }, at);
    if (state !== f.state && (state === 'done' || state === 'needs_input')) f.restAt = at;
    f.state = state; f.lastEventAt = at;
  }
  return f;
}

test('正常一轮：发话→工具→收工', () => {
  assert.equal(run([[0, 'UserPromptSubmit'], [1000, 'PreToolUse'], [2000, 'PostToolUse'], [9000, 'Stop']]).state, 'done');
});

test('收工之后子代理才收尾：不翻回 working', () => {
  assert.equal(run([[0, 'UserPromptSubmit'], [5000, 'Stop'], [200000, 'SubagentStop']]).state, 'done');
  assert.equal(run([[0, 'UserPromptSubmit'], [5000, 'Stop'], [65000, 'Notification', { notification_type: 'idle_prompt' }], [200000, 'SubagentStop']]).state, 'needs_input');
});

test('干活途中子代理收尾：仍是 working', () => {
  assert.equal(run([[0, 'UserPromptSubmit'], [1000, 'PreToolUse'], [5000, 'SubagentStop']]).state, 'working');
});

test('最后一次工具事件比 Stop 晚到（钩子是异步的）：不翻回 working', () => {
  assert.equal(run([[0, 'UserPromptSubmit'], [5000, 'Stop'], [5200, 'PostToolUse']]).state, 'done');
  assert.equal(run([[0, 'UserPromptSubmit'], [5000, 'Stop'], [5000 + LATE_MS - 1, 'PreToolUse']]).state, 'done');
});

test('收工很久以后没人发话、agent 被后台任务叫醒又开工：算 working', () => {
  assert.equal(run([[0, 'UserPromptSubmit'], [5000, 'Stop'], [60000, 'PreToolUse']]).state, 'working');
  assert.equal(run([[0, 'UserPromptSubmit'], [5000, 'Stop'], [5000 + LATE_MS, 'PreToolUse']]).state, 'working');
});

test('等审批、会话结束照旧', () => {
  assert.equal(run([[0, 'UserPromptSubmit'], [1000, 'Notification', { notification_type: 'permission_prompt' }]]).state, 'needs_permission');
  assert.equal(run([[0, 'UserPromptSubmit'], [1000, 'Stop'], [2000, 'SessionEnd']]).state, 'ended');
});

function transcript(rows) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-agent-state-')), 's.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const ts = (ms) => new Date(T0 + ms).toISOString();
const said = (ms, stop) => ({ type: 'assistant', timestamp: ts(ms), message: { stop_reason: stop, content: [] } });

test('对账：日志最后是说完了的助手消息，后面跟着的系统条目不算数', () => {
  const p = transcript([{ type: 'user', timestamp: ts(0), message: {} }, said(5000, 'end_turn'),
    { type: 'system', subtype: 'turn_duration', timestamp: ts(5001) }, { type: 'system', subtype: 'away_summary', timestamp: ts(200000) }]);
  assert.equal(transcriptEndedAt(p), T0 + 5000);
});

test('对账：还在等工具结果、或子代理的支线说完了，都不算回合结束', () => {
  assert.equal(transcriptEndedAt(transcript([said(5000, 'tool_use')])), 0);
  assert.equal(transcriptEndedAt(transcript([said(5000, 'end_turn'), { type: 'user', timestamp: ts(9000), message: {} }])), 0);
  assert.equal(transcriptEndedAt(transcript([said(5000, 'tool_use'), { ...said(8000, 'end_turn'), isSidechain: true }])), 0);
  assert.equal(transcriptEndedAt('/nonexistent/x.jsonl'), 0);
});

test('对账只在「working 且安静够久且日志说早就结束」时出手', () => {
  const p = transcript([said(5000, 'end_turn')]);
  const f = { agent: 'claude', state: 'working', lastEventAt: T0 + 200000, transcript: p };
  assert.equal(shouldSettle(f, T0 + 200000 + 89000), false); // 刚有过事件
  assert.equal(shouldSettle(f, T0 + 200000 + 90000), true);
  assert.equal(shouldSettle({ ...f, state: 'done' }, T0 + 400000), false);
  assert.equal(shouldSettle({ ...f, transcript: transcript([said(5000, 'tool_use')]) }, T0 + 400000), false); // 长命令跑着
  assert.equal(shouldSettle({ ...f, transcript: '' }, T0 + 400000), false);
  assert.equal(shouldSettle({ ...f, agent: 'codex' }, T0 + 400000), false);
});
