'use strict';
// 断线自动续跑：agent 因为瞬时故障（断网、休眠、超时、服务过载）停在半路时，替人敲那句「继续」。
// 额度用完、要重新登录这类要人处理的不碰，只提醒。纯函数，主进程（electron/main.js 的 autoResumeTick）和测试共用。
// 故障识别用的是 Claude Code 的报错文案；Codex、Kimi 没有样本，不覆盖。

const BACKOFF_MS = [1, 5, 15].map((m) => m * 60000); // 第 1/2/3 次续跑前，故障至少已持续（或距上次续跑已过）这么久
const WINDOW_MS = 3600000;                            // 一小时内最多续 3 次，之后交给人

const TRANSIENT = /Connection (lost|dropped|refused)|response stopped arriving|Can't reach the API server|went to sleep mid-response|No response from API|Unable to connect to API|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|Overloaded|overloaded_error|\b(500|502|503|504|529)\b.{0,40}error|Request timed out/i;
const NEEDS_HUMAN = /hit your .{0,20}limit|usage limit|run \/login|token (revoked|expired)|\b40[13]\b.{0,30}(not allowed|Unauthorized|forbidden)|credit balance/i;
const ANSI = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|[\x00-\x08\x0b-\x1f\x7f]/g;
// 界面装饰行（分隔线、空输入框、权限模式、额度条、回顾提示）不算实质内容
const CHROME = /^[\s─━│╭╮╰╯❯>▎⏵·•◦✻✶✳✢✽※⧉]*$|bypass permissions|shift\+tab|^\s*(周|5h)\s*\d+%|new task\?|\/clear to save|disable recaps|^※?\s*recap:/i;

// 只看最后一段：最后一条实质内容是不是故障。返回 { kind: ok|empty|transient|needs_human|unknown_error, evidence }
function classify(screen) {
  const lines = String(screen || '').split(/[\r\n]+/).map((l) => l.replace(ANSI, '').replace(/\s+$/, ''));
  const body = lines.filter((l) => l.trim() && !CHROME.test(l));
  if (!body.length) return { kind: 'empty', evidence: '' };
  const tail = body.slice(-6).join('\n');
  // 只认「行首的故障行」；正文里顺带提到 API Error 这个词不算
  const all = [...tail.matchAll(/^[^\w\n]{0,8}(API Error: [^\n]*|You've hit your[^\n]*|Please run \/login[^\n]*|OAuth token[^\n]*)/gm)];
  if (!all.length) return { kind: 'ok', evidence: '' };
  const m = all[all.length - 1];
  const after = tail.slice(m.index + m[0].length);
  const afterReal = after.replace(/\(.*?may be incomplete.*?\)|The response above may be incomplete\.?/g, '').trim();
  // 故障之后有新的输入（含输入框里打了一半的字）或新的助手发言：已经续上、自己恢复了，或者人正在处理，不动
  if (/^\s*(❯|>)\s*\S|^\s*⏺/m.test(after) || afterReal.length > 40) return { kind: 'ok', evidence: '' };
  const evidence = m[1].slice(0, 160);
  if (NEEDS_HUMAN.test(evidence)) return { kind: 'needs_human', evidence };
  if (TRANSIENT.test(evidence)) return { kind: 'transient', evidence };
  return { kind: 'unknown_error', evidence };
}

// e：这个终端的续跑记录（跨轮保留，调用方存着；故障消失时删掉）。返回这一轮该做什么：
// { action: 'send', attempt } 敲「继续」；{ action: 'report' } 要人处理，提醒一次；{ action: 'give_up' } 续够了交给人，提醒一次；null 不动
function decide(e, kind, evidence, now) {
  if (e.evidence !== evidence) { e.firstSeen = now; e.evidence = evidence; e.reported = e.gaveUp = false; } // 换了一次新故障，重新计时
  e.sent = (e.sent || []).filter((t) => now - t < WINDOW_MS);
  if (kind !== 'transient') {
    if (e.reported) return null;
    e.reported = true; return { action: 'report' };
  }
  if (e.gaveUp) return null; // 同一次故障交给人之后不再碰，哪怕早先那几次已经滑出一小时窗口
  const n = e.sent.length;
  if (n >= BACKOFF_MS.length) { e.gaveUp = true; return { action: 'give_up' }; }
  if (now - (n ? e.sent[n - 1] : e.firstSeen) < BACKOFF_MS[n]) return null; // 还没到退避时间
  e.sent.push(now);
  return { action: 'send', attempt: n + 1 };
}

module.exports = { classify, decide, BACKOFF_MS, WINDOW_MS };
