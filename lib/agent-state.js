'use strict';
// agent 钩子事件 → 终端状态。纯函数，主进程（electron/main.js 的 agentEvent）和测试共用。
const fs = require('fs');

// 钩子是 async 的，各自在后台 POST：回合最后一次工具调用的事件可能比 Stop 晚到。
// Stop 之后这段时间内到的工具事件不算「又开工了」
const LATE_MS = 3000;
const RESTING = new Set(['done', 'needs_input']);

// f：这个终端当前的事实（state、restAt = 最近一次进入 done/needs_input 的时刻）；b：钩子 body
// 返回 { state, event }
function claudeNext(f, b, now) {
  let event = b.hook_event_name, state = f.state;
  if (event === 'SessionStart' || event === 'UserPromptSubmit') state = 'working';
  else if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (!(RESTING.has(f.state) && now - (f.restAt || 0) < LATE_MS)) state = 'working';
  } else if (event === 'Stop') state = 'done';
  else if (event === 'SessionEnd') state = 'ended';
  else if (event === 'Notification') {
    const nt = String(b.notification_type || '');
    if (nt === 'permission_prompt') state = 'needs_permission';
    else if (nt === 'idle_prompt' || nt === 'agent_needs_input') state = 'needs_input';
    else if (nt === 'agent_completed') state = 'done';
    event += ':' + nt;
  }
  // SubagentStop 不改状态：子代理收工只说明少了一个在干活的，不说明主回合又开工了
  return { state, event };
}

// 对账：会话日志里主线的最后一条消息是不是「说完了」（assistant 且 stop_reason=end_turn）。
// 返回那条消息的时间戳（毫秒）；不是、读不到、认不出都返回 0
function transcriptEndedAt(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 262144);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i--) { // 截断读时第一行可能是半行
      if (!lines[i]) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      if (r.isSidechain || (r.type !== 'assistant' && r.type !== 'user')) continue;
      if (r.type === 'assistant' && r.message && r.message.stop_reason === 'end_turn') return Date.parse(r.timestamp) || 0;
      return 0;
    }
  } catch { /* 读不到就不对账 */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
  return 0;
}

// 状态是 working、已经 quietMs 没有任何事件、而会话日志说回合在 quietMs 之前就结束了 → 该改成 done
function shouldSettle(f, now, quietMs = 90000) {
  if (!f || f.agent !== 'claude' || f.state !== 'working' || !f.transcript) return false;
  if (now - f.lastEventAt < quietMs) return false;
  const at = transcriptEndedAt(f.transcript);
  return at > 0 && now - at >= quietMs;
}

module.exports = { claudeNext, transcriptEndedAt, shouldSettle, LATE_MS };
