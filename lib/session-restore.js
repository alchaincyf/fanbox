'use strict';
// 重启后恢复会话：FanBox 把开着的 agent 窗口（目录、会话 id、是否在干活）随时记进 ~/.fanbox/session-restore.json，
// 下次启动（电脑重启或关机、FanBox 升级、⌘Q 之后）在原目录逐个续上；重启前在干活的，续上时补一句「接着干」。
// 纯函数＋文件读写，主进程（electron/main.js）和测试共用。只覆盖有会话续接命令、又能从 hooks 拿到会话 id 的 claude 和 codex。

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = () => path.join(os.homedir(), '.fanbox', 'session-restore.json');
const MAX_WINDOWS = 30;
const BUSY_PROMPT = '（FanBox 重启恢复）刚才电脑或 FanBox 重启打断了你，请从中断的地方继续。';
// 与渲染层 AGENT_REGISTRY 的 resumeCmd 保持一致（public/app.js）：同样的权限参数、同样带上 FanBox 的 hooks
const RESUME = {
  claude: (id) => `claude --dangerously-skip-permissions --settings "$HOME/.fanbox/hooks/claude-settings.json" --resume ${id}`,
  codex: (id) => `codex -c "notify=[\\"$HOME/.fanbox/hooks/codex-notify.sh\\"]" resume ${id}`,
};
const ID_RE = /^[\w-]{6,80}$/; // 会话 id 会被拼进命令行，只收字母数字和连字符
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const supported = (agent) => Object.prototype.hasOwnProperty.call(RESUME, agent);

// 一条窗口记录 → 敲进新终端的命令；认不出的返回空串
function command(w) {
  if (!w || !supported(w.agent) || !ID_RE.test(String(w.sessionId || ''))) return '';
  return RESUME[w.agent](w.sessionId) + (w.busy ? ' ' + shq(BUSY_PROMPT) : '');
}

// 一个终端此刻值得记下的样子；不该记（不是 claude/codex、还没拿到会话 id、不知道目录）返回 null
function entryOf(id, f) {
  if (!f || !supported(f.agent) || !ID_RE.test(String(f.sessionId || '')) || !f.cwd) return null;
  return { agent: f.agent, sessionId: String(f.sessionId), cwd: String(f.cwd), busy: f.state === 'working', order: Number(String(id).replace(/\D/g, '')) || 0 };
}

// 写盘前整理：按开窗先后排序，同一个会话只留一份
function normalize(entries) {
  const seen = new Set(), out = [];
  for (const w of [...entries].sort((a, b) => a.order - b.order)) {
    if (!w || seen.has(w.sessionId)) continue;
    seen.add(w.sessionId);
    out.push(w);
  }
  return out.slice(0, MAX_WINDOWS);
}

function save(windows, file = FILE(), now = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: now, windows: normalize(windows) }, null, 1));
  fs.renameSync(tmp, file); // 先写临时文件再改名：断电时不会留下半份清单
}

// 启动时认领清单：改名成 .last.json（留着排查），同一份清单只恢复一次。没有清单或读不懂返回 null
function claim(file = FILE()) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  try { fs.renameSync(file, file.replace(/\.json$/, '.last.json')); } catch { return null; }
  return data && Array.isArray(data.windows) ? data : null;
}

// 认领到的清单里真正要开的窗口：目录还在、命令拼得出来
function plan(data, { exists = fs.existsSync } = {}) {
  if (!data || !Array.isArray(data.windows)) return [];
  return normalize(data.windows.filter((w) => w && w.cwd && exists(w.cwd) && command(w)));
}

module.exports = { FILE, BUSY_PROMPT, supported, command, entryOf, normalize, save, claim, plan };
