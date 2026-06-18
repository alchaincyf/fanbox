// 本机 CLI 驱动器：用 claude / codex 的无头模式起一个实例和它对话，作为微信消息的「大脑」。
// 用户文本一律走 stdin（不进命令行，零转义/长度风险）；claude 用 session_id 续上下文。
// 复用本机已登录的 claude/codex 凭据，原生读 cwd 下的 CLAUDE.md / AGENTS.md。
const { spawn } = require('child_process');
const { fullEnv } = require('./env');

const loginShell = () => process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

// 跑一条命令，prompt 写 stdin。env 复刻自用户的交互式登录 shell（见 env.js）：
// 打包后从 Finder 启动会丢掉 PATH/代理/BASE_URL，这里补回来，子进程联网方式和用户终端一致。
// onLine：可选，stdout 每攒满一整行就回调一次（用于流式过程播报）；不传则纯收尾解析，行为不变。
async function run(cmd, stdinText, cwd, timeoutMs = 180000, onLine = null) {
  const env = await fullEnv();
  return new Promise((resolve) => {
    const child = spawn(loginShell(), ['-lc', cmd], { cwd: cwd || env.HOME || process.env.HOME, env });
    let out = '', err = '', done = false, lineBuf = '';
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish({ ok: false, out, err: err + '\n[超时]' }); }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8'); out += s;
      if (!onLine) return;
      lineBuf += s; let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, nl); lineBuf = lineBuf.slice(nl + 1); try { onLine(line); } catch { /* */ } }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, out, err: String(e && e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, code, out, err }); });
    try { child.stdin.write(stdinText || ''); child.stdin.end(); } catch { /* */ }
  });
}

// 从一个 usage 对象估出「上下文有多重」的 token 数：优先 claude 的输入侧（含缓存读写=被重放的全部输入），
// 退回 codex/openai 风格的 total/prompt。用来驱动自动压缩闸门，不需要绝对精确，量级对就行。
function usageTokens(u) {
  if (!u || typeof u !== 'object') return 0;
  const claudeInput = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (claudeInput) return claudeInput;
  return u.total_tokens || u.prompt_tokens || 0;
}

// 把一次工具调用翻译成一句手机能看懂的「正在干啥」。null 表示这步不值得播报。
function progressNote(name, input) {
  const i = input || {};
  const base = (p) => (p ? require('path').basename(String(p)) : '');
  switch (name) {
    case 'Read': return `正在看 ${base(i.file_path)}`.trim();
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return `正在改 ${base(i.file_path)}`.trim();
    case 'Bash': return i.description ? `正在跑：${i.description}` : '正在跑命令';
    case 'Grep': case 'Glob': return `正在搜索 ${i.pattern || ''}`.trim();
    case 'WebFetch': case 'WebSearch': return '正在查资料';
    case 'Task': return '正在派子任务处理';
    default: return name ? `正在用 ${name}` : '';
  }
}
// codex 事件五花八门，尽力翻译，翻不出就给个通用句（外层有节流，不会刷屏）。
function codexNote(item) {
  if (!item) return '';
  if (item.command) { const c = Array.isArray(item.command) ? item.command.join(' ') : item.command; return `正在跑：${String(c).slice(0, 60)}`; }
  if (item.path || item.file) return `正在改 ${require('path').basename(item.path || item.file)}`;
  return '正在处理';
}

// 检测本机有没有这个 CLI
function which(bin) {
  return run(`command -v ${bin} || true`, '', null, 8000).then((r) => !!(r.out || '').trim());
}

// claude 无头：续话靠「首轮自带 --session-id <我们生成的 uuid>，之后 --resume 同一 uuid」。
//  关键：不能让 claude 自动生成 session——print 模式自动建的会话 resume 不到（实测会报 No conversation found）。
// onProgress(note)：可选。传了就用 stream-json 边跑边把工具调用播报出去；不传走原来的一次性 json。
async function runClaude(text, cwd, sessionId, persona, onProgress) {
  const sid = sessionId || require('crypto').randomUUID();
  const flag = sessionId ? `--resume ${sid}` : `--session-id ${sid}`;
  const sys = persona ? `--append-system-prompt ${shq(persona)}` : '';
  const fmt = onProgress ? '--output-format stream-json --verbose' : '--output-format json';
  const cmd = `claude -p ${fmt} --dangerously-skip-permissions ${sys} ${flag}`;
  let result = '', outSid = sid, tokens = 0, cost = 0;
  // 流式：逐行解析 JSONL，工具调用 → 播报，result 事件 → 拿最终文本 / session / 用量
  const onLine = onProgress ? (line) => {
    const t = line.trim(); if (!t || t[0] !== '{') return;
    let o; try { o = JSON.parse(t); } catch { return; }
    if (o.type === 'result') { result = o.result || result; outSid = o.session_id || outSid; if (o.usage) tokens = usageTokens(o.usage) || tokens; if (o.total_cost_usd != null) cost = o.total_cost_usd; return; }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) { if (b.type === 'tool_use') { const p = progressNote(b.name, b.input); if (p) onProgress(p); } }
    }
  } : null;
  const r = await run(cmd, text, cwd, 600000, onLine);
  if (!onProgress) {
    try { const j = JSON.parse((r.out || '').trim()); result = j.result || j.text || ''; outSid = j.session_id || sid; if (j.usage) tokens = usageTokens(j.usage); if (j.total_cost_usd != null) cost = j.total_cost_usd; }
    catch { result = (r.out || '').trim(); } // 非 JSON 兜底
  } else if (!result) {
    // 流式没抓到 result 事件 → 兜底再扫一遍全部输出
    for (const line of (r.out || '').split('\n')) { const t = line.trim(); if (t[0] !== '{') continue; let o; try { o = JSON.parse(t); } catch { continue; } if (o.type === 'result') { result = o.result || result; outSid = o.session_id || outSid; if (o.usage) tokens = usageTokens(o.usage) || tokens; if (o.total_cost_usd != null) cost = o.total_cost_usd; } }
  }
  // resume 的会话失效（旧 id / 过期）→ 自动起新会话重试一次，别把报错甩给用户
  if (sessionId && /No conversation found|session.*not found/i.test(result + ' ' + (r.err || ''))) {
    return runClaude(text, cwd, null, persona, onProgress);
  }
  if (!result && !r.ok) result = `（claude 出错）${(r.err || '').trim().slice(-300)}`;
  return { text: result || '（没有返回内容）', sessionId: outSid, tokens, cost };
}

// codex 无头：首轮 `codex exec` 建会话并从 thread.started 抓 thread_id；之后 `codex exec resume <id> -` 续上下文（codex 0.139+）。
async function runCodex(text, cwd, persona, sessionId, onProgress) {
  const flags = '--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox';
  // 续话：prompt 走 stdin（结尾 `-`）；会话已含人格/记忆，不再前置。首轮：把人格+记忆前置到消息里（codex 无独立 system-prompt 入口）。
  const cmd = sessionId ? `codex exec resume ${sessionId} ${flags} -` : `codex exec ${flags}`;
  const stdin = sessionId ? text : (persona ? `${persona}\n\n---\n${text}` : text);
  // 流式：codex 本就吐 JSONL，逐行挑出命令/改文件这类节点播报（最终文本仍走收尾解析）
  const onLine = onProgress ? (line) => {
    const t = line.trim(); if (!t || t[0] !== '{') return;
    let o; try { o = JSON.parse(t); } catch { return; }
    const item = o.item || o.msg || o;
    const ty = (item.type || o.type || '').toLowerCase();
    if (/command|exec|tool|function|patch|file/.test(ty)) { const n = codexNote(item); if (n) onProgress(n); }
  } : null;
  const r = await run(cmd, stdin, cwd, 600000, onLine);
  // --json 输出 JSONL 事件：抓 thread_id + 最终 assistant 文本（后到的覆盖前面）+ 用量（取最大，事件多为累计）
  let result = '', outSid = sessionId || '', tokens = 0;
  for (const line of (r.out || '').split('\n')) {
    const t = line.trim(); if (!t || t[0] !== '{') continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.type === 'thread.started' && o.thread_id) outSid = o.thread_id;
    const item = o.item || o.msg || o;
    const ty = item.type || o.type || '';
    const u = o.usage || item.usage || (/token|usage/i.test(ty) ? (item || o) : null);
    if (u) { const tk = usageTokens(u); if (tk > tokens) tokens = tk; } // codex 用量事件结构不稳，尽力抓、取最大
    if (/agent_message|assistant|message\.completed|item\.completed/i.test(ty)) {
      const txt = item.text || item.message || (item.content && item.content.text) || '';
      if (txt && typeof txt === 'string') result = txt;
    }
  }
  // resume 的会话失效（旧 id / 落盘被清）→ 自动起新会话重试一次，别把报错甩给用户
  if (sessionId && !result && /No .*session|not found|no conversation|无.*会话/i.test(r.err || r.out || '')) {
    return runCodex(text, cwd, persona, null);
  }
  if (!result) { // 没解出 JSON → 取纯文本最后一段，剥掉 header 前言与 prompt 回显
    const parts = stripAnsi(r.out || '').split(/-{6,}/);
    result = (parts[parts.length - 1] || '').replace(/^\s*user[\s\S]*?\n/i, '').trim();
  }
  if (!result && !r.ok) result = `（codex 出错）${stripAnsi(r.err || r.out || '').trim().slice(-300)}`;
  return { text: result || '（没有返回内容）', sessionId: outSid, tokens, cost: 0 };
}

function stripAnsi(s) { return s.replace(/\[[0-9;]*m/g, ''); }

// shell 单引号安全包裹（人格可能含引号/换行/中文）
function shq(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }

// 启动时预热终端环境复刻（缓存到 env.js，第一条消息就不必等 shell 起来）
function warmEnv() { fullEnv().catch(() => { /* 失败就退回 process.env，run 时再算 */ }); }

module.exports = { runClaude, runCodex, which, warmEnv };
