// FanBox 记忆模块：文件式语义记忆 + 写入操作语义（ADD/UPDATE/DELETE/NOOP）去污染。
//  设计见 docs/09。FanBox 独立一份（~/.fanbox/memory/），并默认引用 ~/.claude/memory/ 作为数据源之一。
//  写入由 agent 在回复末尾产出 <memory> ops 块，FanBox 确定性地判重落盘——不靠 agent 自觉乱写文件。
const fs = require('fs');
const os = require('os');
const path = require('path');

const FB_DIR = path.join(os.homedir(), '.fanbox', 'memory');     // FanBox 自己的记忆（单一写入目标）
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'memory');  // 引用源（只读）
const FB_MEM = path.join(FB_DIR, 'MEMORY.md');
const INJECT_BUDGET = 4000; // 注入字符预算（≈1200 token）：磁盘保全，注入超预算截断

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const write = (p, s) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); } catch { /* */ } };

// 一条记忆 = 一行 `- **主题**: 正文`，按主题判重
const ENTRY_RE = /^-\s*\*\*(.+?)\*\*:\s*(.*)$/;
function parseEntries(md) {
  const out = [];
  for (const line of (md || '').split('\n')) { const m = line.match(ENTRY_RE); if (m) out.push({ topic: m[1].trim(), text: m[2].trim() }); }
  return out;
}
const fmtEntry = (e) => `- **${e.topic}**: ${e.text}`;
function serialize(entries) {
  return `# FanBox 记忆\n\n> 由微信 ClawBot 在对话中沉淀，可手改。\n\n${entries.map(fmtEntry).join('\n')}\n`;
}

// 注入给 agent 的记忆块：FanBox 自己的 + 引用花叔全局（~/.claude/memory），有界截断
function inject() {
  const own = read(FB_MEM).trim();
  const refMem = read(path.join(CLAUDE_DIR, 'MEMORY.md')).trim();
  const refProj = read(path.join(CLAUDE_DIR, 'PROJECTS.md')).trim();
  let block = '';
  if (own) block += `【FanBox 长期记忆】\n${own}\n`;
  if (refMem) block += `\n【花叔全局记忆 · 参考】\n${refMem}\n`;
  if (refProj) block += `\n【花叔当前项目 · 参考】\n${refProj}\n`;
  block = block.trim();
  if (block.length > INJECT_BUDGET) block = block.slice(0, INJECT_BUDGET) + '\n…（记忆较长，已截断；完整见磁盘文件）';
  return block;
}

// 给 agent 的写入协议（注入系统提示，让它在回复末尾产出 ops 块）
const PROTOCOL = [
  '你有持久记忆。当对话里出现值得长期记住的事实 / 偏好 / 项目进展时，在回复的最末尾追加一个记忆块：',
  '<memory>[{"op":"ADD|UPDATE|DELETE","topic":"简短主题","text":"一句话内容"}]</memory>',
  '规则：写前对照上面已有记忆判重——同主题已存在且有变化用 UPDATE（别重复 ADD）；发现矛盾/过时用 DELETE；没有值得记的就不要加这个块。',
  '这个块只给系统处理、不会展示给用户，所以正文里不要重复它的内容。',
].join('\n');

// 从 agent 回复里抽出 <memory> ops，返回 { clean(剥掉块的正文), ops }
function extractOps(reply) {
  const m = (reply || '').match(/<memory>\s*([\s\S]*?)\s*<\/memory>/i);
  if (!m) return { clean: reply, ops: [] };
  let ops = [];
  try { const j = JSON.parse(m[1].trim()); if (Array.isArray(j)) ops = j; } catch { /* 解析失败当没写 */ }
  const clean = (reply.slice(0, m.index) + reply.slice(m.index + m[0].length)).trim();
  return { clean, ops };
}

// 确定性落盘：按主题判重应用 ADD/UPDATE/DELETE/NOOP
function applyOps(ops) {
  if (!Array.isArray(ops) || !ops.length) return { applied: 0 };
  const entries = parseEntries(read(FB_MEM));
  const idx = (topic) => entries.findIndex((e) => e.topic === topic);
  let applied = 0;
  for (const op of ops) {
    if (!op || !op.topic) continue;
    const topic = String(op.topic).trim();
    const text = String(op.text || '').trim();
    const at = idx(topic);
    const kind = String(op.op || 'ADD').toUpperCase();
    if (kind === 'DELETE') { if (at >= 0) { entries.splice(at, 1); applied++; } }
    else if (kind === 'NOOP') { /* 不动 */ }
    else { // ADD / UPDATE 统一：存在则覆盖、不存在则新增（天然去重）
      if (!text) continue;
      if (at >= 0) { if (entries[at].text !== text) { entries[at].text = text; applied++; } }
      else { entries.push({ topic, text }); applied++; }
    }
  }
  if (applied) write(FB_MEM, serialize(entries));
  return { applied };
}

module.exports = { inject, PROTOCOL, extractOps, applyOps, FB_DIR, FB_MEM };
