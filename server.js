#!/usr/bin/env node
/**
 * FanBox — 本地文件指挥中心后端
 *
 * 纯 Node 内置模块，零依赖。只绑定 127.0.0.1，浏览器界面是唯一入口。
 * 这是一个本地个人工具：你的机器、你的文件，服务只在本机回环地址监听。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn, execFile } = require('child_process');
const { URL } = require('url');

const HOME = os.homedir();
const PORT = Number(process.env.FANBOX_PORT) || 4567;
const CONFIG_DIR = path.join(HOME, '.fanbox');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const THUMB_DIR = path.join(CONFIG_DIR, 'thumbs');
const PUBLIC = path.join(__dirname, 'public');
const PLATFORM = process.platform;

// 搜索 / 遍历时跳过的重目录，避免 vibe coding 项目里 node_modules 拖垮速度
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.venv', 'venv',
  '__pycache__', '.DS_Store', 'Pods', '.gradle', 'target', '.idea', '.vscode-test',
  'DerivedData', '.expo', '.turbo', 'vendor', '.svn', '.hg',
]);

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'json5',
  'html', 'htm', 'css', 'scss', 'less', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cc', 'm', 'mm', 'sh', 'bash', 'zsh', 'fish', 'sql', 'yml',
  'yaml', 'toml', 'ini', 'env', 'conf', 'xml', 'svg', 'vue', 'astro', 'php', 'lua',
  'r', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile', 'makefile', 'log',
  'csv', 'tsv', 'gql', 'graphql', 'prisma', 'plist', 'tex', 'rtf', 'srt', 'vtt', 'ass',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif', 'tiff', 'tif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
const PDF_EXT = new Set(['pdf']);
const ARCHIVE_EXT = new Set(['zip', 'jar', 'tar', 'tgz', 'gz', 'bz2', 'xz', '7z', 'rar']);

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', pdf: 'application/pdf',
  ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
};

// ---------- 工具函数 ----------

function ext(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

// 从一组文件/目录名推断项目类型（签名文件），供当前目录徽章 + 子目录浅探共用
function projectOf(names) {
  if (names.has('package.json')) return 'node';
  if (names.has('index.html')) return 'web';
  if (names.has('requirements.txt') || names.has('pyproject.toml')) return 'python';
  if (names.has('Cargo.toml')) return 'rust';
  if (names.has('go.mod')) return 'go';
  if (names.has('.git')) return 'git';
  return null;
}

function kindOf(name, isDir) {
  if (isDir) return 'dir';
  const e = ext(name);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (PDF_EXT.has(e)) return 'pdf';
  if (ARCHIVE_EXT.has(e)) return 'archive';
  if (TEXT_EXT.has(e) || /^(dockerfile|makefile|readme|license|\.[a-z]+rc)$/i.test(name)) return 'text';
  return 'other';
}

// 把任意请求路径规整成绝对真实路径；非绝对路径回退到 HOME。本机个人工具，不做越权拦截，
// 但拒绝空字节这种明显异常输入。
function resolvePath(p) {
  if (!p || typeof p !== 'string') return HOME;
  if (p.includes('\0')) throw new Error('非法路径');
  let abs = p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
  if (!path.isAbsolute(abs)) abs = path.join(HOME, abs);
  return path.normalize(abs);
}

async function readConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { favorites: [], recentOpened: [] };
  }
}

// 串行化「读-改-写」：高频 recordRecent 与收藏共享 config.json，必须排队整个 RMW 才不丢更新
let _cfgChain = Promise.resolve();
function updateConfig(mutator) {
  const run = _cfgChain.then(async () => {
    const cfg = await readConfig();
    await mutator(cfg);
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    // 原子写：temp + fsync + rename，写一半崩溃不留截断 JSON（否则 readConfig 静默清空收藏/最近）
    const tmp = `${CONFIG_FILE}.tmp-${process.pid}-${Date.now()}`;
    try {
      const fh = await fsp.open(tmp, 'w');
      try { await fh.writeFile(JSON.stringify(cfg, null, 2)); await fh.sync(); } finally { await fh.close(); }
      await fsp.rename(tmp, CONFIG_FILE);
    } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; } // 写盘失败要冒泡给调用方，别静默成功
    return cfg;
  });
  _cfgChain = run.catch(() => {}); // 保持队列存活，但 run 本身会 reject 让调用方感知失败
  return run;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- 业务逻辑 ----------

async function listDir(dirPath) {
  const dir = resolvePath(dirPath);
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name === '.DS_Store') continue;
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    let size = 0, mtime = 0;
    // 处理符号链接
    if (d.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);
        isDir = st.isDirectory();
      } catch { continue; }
    }
    let btime = 0;
    try {
      const st = await fsp.lstat(full);
      size = st.size;
      mtime = st.mtimeMs;
      btime = st.birthtimeMs || 0;
    } catch { /* ignore */ }
    entries.push({
      name: d.name,
      path: full,
      isDir,
      kind: kindOf(d.name, isDir),
      hidden: d.name.startsWith('.'),
      size,
      mtime,
      btime,
    });
  }
  // 文件夹在前，按名称排序
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh', { numeric: true });
  });
  // 识别项目类型（含 package.json / .git / index.html 等）
  const names = new Set(entries.map((e) => e.name));
  const project = projectOf(names);

  // 给每个子目录浅探一次项目类型，文件卡片上标徽章——「一下午起的十个项目」一眼认出是 node/web/py
  // 成本受控：只探目录、且总数封顶；大目录（>80 个子目录）跳过，避免拖慢列表
  const subDirs = entries.filter((e) => e.isDir && !e.name.startsWith('.'));
  if (subDirs.length <= 80) {
    await Promise.all(subDirs.map(async (e) => {
      try {
        const inner = await fsp.readdir(e.path);
        e.project = projectOf(new Set(inner));
      } catch { /* 无权限等，跳过 */ }
    }));
  }

  const parts = dir.split(path.sep).filter(Boolean);
  const breadcrumb = [{ name: PLATFORM === 'win32' ? dir.split(path.sep)[0] : '/', path: PLATFORM === 'win32' ? parts[0] + path.sep : path.sep }];
  let acc = PLATFORM === 'win32' ? parts[0] + path.sep : path.sep;
  const start = PLATFORM === 'win32' ? 1 : 0;
  for (let i = start; i < parts.length; i++) {
    acc = path.join(acc, parts[i]);
    breadcrumb.push({ name: parts[i], path: acc });
  }
  return { path: dir, parent: path.dirname(dir), entries, breadcrumb, project };
}

async function readFile(filePath) {
  const file = resolvePath(filePath);
  const st = await fsp.stat(file);
  const kind = kindOf(path.basename(file), false);
  const info = {
    path: file, name: path.basename(file), size: st.size,
    mtime: st.mtimeMs, kind, ext: ext(file),
  };
  if (kind === 'text') {
    if (st.size > 2 * 1024 * 1024) {
      info.tooLarge = true;
      const fd = await fsp.open(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      await fd.close();
      // 回退到完整 UTF-8 边界，避免把末尾多字节字符切坏成 �
      let end = bytesRead;
      while (end > 0 && (buf[end - 1] & 0xC0) === 0x80) end--;
      if (end > 0 && (buf[end - 1] & 0xC0) === 0xC0) end--;
      info.content = buf.toString('utf8', 0, end) + '\n\n… (文件较大，仅显示前 256KB)';
    } else {
      info.content = await fsp.readFile(file, 'utf8');
    }
  }
  return info;
}

// 递归遍历，带忽略表、结果上限与时间预算。返回是否因上限/超时而提前中断（截断）
// onDir（可选）让调用方也拿到目录，用于「按文件夹名搜索」——目录不计入 limit。
async function walk(root, { onFile, onDir, limit = 4000, deadline }) {
  const queue = [root];
  let count = 0;
  let truncated = false;
  while (queue.length) {
    if (Date.now() > deadline || count >= limit) { truncated = true; break; }
    const dir = queue.shift();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    for (const d of dirents) {
      if (d.name === '.DS_Store') continue;
      const full = path.join(dir, d.name);
      const isDir = d.isDirectory();
      if (isDir) {
        if (IGNORE_DIRS.has(d.name)) continue;
        if (onDir) {
          let mtime = 0;
          try { mtime = (await fsp.lstat(full)).mtimeMs; } catch { /* */ }
          onDir({ name: d.name, path: full, dir, isDir: true, kind: 'dir', mtime, size: 0 });
        }
        queue.push(full);
      } else {
        count++;
        let mtime = 0, size = 0;
        try { const st = await fsp.lstat(full); mtime = st.mtimeMs; size = st.size; } catch { /* */ }
        onFile({ name: d.name, path: full, dir, isDir: false, kind: kindOf(d.name, false), mtime, size });
        if (count >= limit) { truncated = true; break; }
      }
    }
  }
  return { truncated };
}

// 模糊匹配打分：子序列匹配，连续命中、词首命中、靠前命中加分
function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, score = 0, lastIdx = -1, streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let pts = 10;
      if (ti === lastIdx + 1) { streak++; pts += streak * 8; } else streak = 0;
      if (ti === 0 || /[\/_\-. ]/.test(t[ti - 1])) pts += 15; // 词首
      pts += Math.max(0, 8 - ti * 0.1); // 靠前
      score += pts;
      lastIdx = ti;
      qi++;
    }
  }
  if (qi < q.length) return -1; // 未能匹配全部字符
  score -= (t.length - q.length) * 0.2; // 越短越好
  return score;
}

async function searchFiles(query, rootPath, deadlineTs) {
  const root = resolvePath(rootPath);
  const q = (query || '').trim();
  if (!q) return { results: [] };
  const matches = [];
  const scoreInto = (f, bonus) => {
    const s = fuzzyScore(q, f.name);
    if (s <= 0) return;
    const pathBonus = fuzzyScore(q, f.path) > 0 ? 3 : 0;
    // 近期修改加权，让「我刚做的东西」优先浮出
    const recencyBonus = Math.max(0, 20 - (Date.now() - f.mtime) / 86400000) * 0.6;
    matches.push({ ...f, score: s + pathBonus + recencyBonus + bonus });
  };
  const { truncated } = await walk(root, {
    limit: 60000,
    deadline: deadlineTs || Date.now() + 4000, // 多根搜索时传共享截止点，封顶总耗时
    onFile: (f) => scoreInto(f, 0),
    // 文件夹小幅加权——vibe coding「一下午起十个项目」，最常找的就是项目目录本身
    onDir: (f) => scoreInto(f, 6),
  });
  matches.sort((a, b) => b.score - a.score);
  return { results: matches.slice(0, 80), truncated };
}

async function grepFiles(query, rootPath) {
  const root = resolvePath(rootPath);
  const q = (query || '').trim();
  if (!q || q.length < 2) return { results: [] };
  const lower = q.toLowerCase();
  const files = [];
  const { truncated: walkTrunc } = await walk(root, {
    limit: 12000,
    deadline: Date.now() + 1800,
    onFile: (f) => { if (f.kind === 'text' && f.size < 512 * 1024) files.push(f); },
  });
  // 按修改时间倒序读，让「我最近写过那句话」的文件优先命中
  files.sort((a, b) => b.mtime - a.mtime);
  const results = [];
  let truncated = walkTrunc;
  const deadline = Date.now() + 3500;
  for (const f of files) {
    if (Date.now() > deadline || results.length >= 50) { truncated = true; break; }
    let content;
    try { content = await fsp.readFile(f.path, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < 4; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
    if (hits.length) results.push({ ...f, hits });
  }
  return { results, truncated };
}

// ---------- Spotlight（mdfind）内容搜索：白嫖系统索引 ----------
// 覆盖全文 + PDF/docx + 截图/图片里的 OCR 文字，毫秒级返回；Spotlight 没索引到的（代码目录等）由 grep 兜底
function mdfind(args) {
  return new Promise((resolve) => {
    execFile('mdfind', args, { timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).split('\n').filter(Boolean));
    });
  });
}
async function contentSearch(query, rootPath) {
  const root = resolvePath(rootPath);
  const q = (query || '').trim();
  if (!q || q.length < 2) return { results: [] };
  // 属性查询而非自由文本：CJK 子串匹配更稳；[cd] = 忽略大小写/音调
  const esc = q.replace(/[\\"*]/g, '');
  const paths = await mdfind(['-onlyin', root, `(kMDItemTextContent == "*${esc}*"cd) || (kMDItemDisplayName == "*${esc}*"cd)`]);
  if (paths === null || !paths.length) {
    const fb = await grepFiles(query, rootPath); // mdfind 不可用或无命中 → 原 grep 兜底
    return { ...fb, engine: 'grep' };
  }
  const results = [];
  const deadline = Date.now() + 2500;
  for (const p of paths) {
    if (results.length >= 60 || Date.now() > deadline) break;
    if (/\/(node_modules|\.git|Library\/Caches)\//.test(p)) continue;
    let st; try { st = await fsp.stat(p); } catch { continue; }
    if (st.isDirectory()) continue;
    const name = path.basename(p);
    results.push({ name, path: p, isDir: false, kind: kindOf(name, false), hidden: name.startsWith('.'), size: st.size, mtime: st.mtimeMs, btime: st.birthtimeMs || 0 });
  }
  results.sort((a, b) => b.mtime - a.mtime); // 近改优先，「我刚写的那句话」浮在最上面
  // 给文本类命中补行级预览（只读前几个小文件，别拖慢整体）
  const lower = q.toLowerCase();
  let read = 0;
  for (const r of results) {
    if (read >= 12) break;
    if (r.kind !== 'text' || r.size > 512 * 1024) continue;
    read++;
    let content; try { content = await fsp.readFile(r.path, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < 3; i++) {
      if (lines[i].toLowerCase().includes(lower)) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
    if (hits.length) r.hits = hits;
  }
  return { results, truncated: paths.length > results.length, engine: 'spotlight' };
}

async function recentFiles(rootPath) {
  const root = resolvePath(rootPath);
  const all = [];
  const { truncated } = await walk(root, {
    limit: 30000,
    deadline: Date.now() + 3500,
    onFile: (f) => { if (!f.name.startsWith('.')) all.push(f); },
  });
  all.sort((a, b) => b.mtime - a.mtime);
  return { results: all.slice(0, 60), truncated };
}

// ---------- 文件操作（编辑 / 废纸篓 / 重命名 / 新建）----------
// 都带护栏：编辑只认文本类、删除走系统废纸篓可恢复、名称拒绝路径分隔符与空字节。

async function writeTextFile(p, content, expectedMtime) {
  const file = resolvePath(p);
  if (!TEXT_EXT.has(ext(file))) throw new Error('只支持文本类文件编辑');
  if (typeof content !== 'string') throw new Error('内容非法');
  // 并发覆盖保护：打开编辑后文件被外部（agent）改过或删除，拒绝盲覆盖
  if (expectedMtime) {
    let cur = 0, missing = false;
    try { cur = (await fsp.stat(file)).mtimeMs; } catch { missing = true; }
    if (missing || (cur && Math.abs(cur - expectedMtime) > 1)) {
      const e = new Error(missing ? '文件已被外部删除' : '文件已被外部修改'); e.conflict = true; throw e;
    }
  }
  // 原子写：临时文件 + fsync + rename，写到一半崩溃也不会损坏原文件
  const tmp = `${file}.fanbox-tmp-${process.pid}-${Date.now()}`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(content, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {}); // 失败清理临时文件，不留残骸
    throw e;
  }
  const st = await fsp.stat(file);
  return { ok: true, size: st.size, mtime: st.mtimeMs };
}

// 移到系统废纸篓（可恢复），而非永久删除——呼应「不删除只归档」
function trashPath(p) {
  return new Promise((resolve) => {
    let target;
    try { target = resolvePath(p); } catch { return resolve({ ok: false, error: '非法路径' }); }
    let isDir = false;
    try { isDir = fs.lstatSync(target).isDirectory(); } catch { return resolve({ ok: false, error: '文件不存在' }); }
    let cmd;
    if (PLATFORM === 'darwin') {
      // 路径走 argv，不拼进单引号 AppleScript 字面量——避免含 ' 的文件名删除失败/注入
      // POSIX file 必须 as alias 强转，否则 Finder 解析不了报 -1728
      cmd = `osascript -e 'on run argv' -e 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)' -e 'end run' ${shellQuote(target)}`;
    } else if (PLATFORM === 'win32') {
      const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
      const ps = target.replace(/'/g, "''");
      cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${ps}','OnlyErrorDialogs','SendToRecycleBin')"`;
    } else {
      cmd = `gio trash ${shellQuote(target)} || trash-put ${shellQuote(target)} || trash ${shellQuote(target)}`;
    }
    exec(cmd, (err) => {
      if (!err) return resolve({ ok: true });
      let msg = err.message;
      // Finder 自动化未授权（-1743/-600）给人话
      if (PLATFORM === 'darwin' && /-1743|-600|not allowed|authoriz/i.test(msg)) {
        msg = '需在「系统设置 → 隐私与安全性 → 自动化」里允许 FanBox 控制 Finder（首次删除会弹授权）';
      }
      resolve({ ok: false, error: msg });
    });
  });
}

function validName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  return n.length > 0 && n.length <= 255 && !/[\/\\\0]/.test(n) && n !== '.' && n !== '..';
}

async function renamePath(p, newName) {
  const src = resolvePath(p);
  newName = (newName || '').trim();
  if (!validName(newName)) throw new Error('名称不合法');
  const dst = path.join(path.dirname(src), newName);
  if (fs.existsSync(dst)) throw new Error('已存在同名项');
  await fsp.rename(src, dst);
  return { ok: true, path: dst };
}

// ---------- AI 整理：备料 + 在内嵌终端拉起交互式 agent（v2，对话式；v1 headless 提案已废弃）----------
// 翻箱不再后台跑 claude -p：把整理偏好、过往整理历史、工作约定写成 brief 文件，
// 前端在内嵌终端启动 claude/codex，方案摊给用户对话确认后由 agent 动手。
// 约定：agent 每批移动追加写 ORGANIZE_LOG_DIR 回滚日志（撤销在对话里完成）、收尾把新学到的偏好沉淀进 prefs 文件。
const ORGANIZE_LOG_DIR = path.join(CONFIG_DIR, 'organize-log');
const ORGANIZE_PREFS_FILE = path.join(CONFIG_DIR, 'organize-prefs.md');
const ORGANIZE_BRIEF_FILE = path.join(CONFIG_DIR, 'organize-brief.md');
const DEFAULT_ORGANIZE_STRATEGY = `- 默认归档：过时/低频的文件移入 _archive/ 下的语义子目录（如 _archive/截图/2026-06/）
- 同一主题的散文件归进语义明确的项目文件夹（项目制：一个项目一个文件夹，按需建议新文件夹）
- 归档之外，单独提一份「建议删除」清单（什么算该删由你判断：明显垃圾、可再生成的产物、过期大文件……），逐条给理由
- 删除须用户逐条点头；确认后移入废纸篓 ~/.Trash/（不直接 rm），并照常记进回滚日志
- 最近 7 天内有动静的文件视为正在进行的工作，不要动
- 文件夹一律不动，只整理松散文件
- 拿不准的单独列出来问，宁可少动不要乱动`;

// codex 各版本旗标常变（0.139 移除了 --full-auto）：按 --help 实测有什么用什么，
// 全不认识就裸跑——退化成多几次审批确认，但不会因 unexpected argument 拉不起来
async function codexOrganizeFlags(bin) {
  const help = await new Promise((resolve) => {
    execFile(bin, ['--help'], { timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
  if (help.includes('--full-auto')) return ' --full-auto';
  let flags = '';
  if (help.includes('--sandbox')) flags += ' --sandbox workspace-write';
  if (help.includes('--ask-for-approval')) flags += ' -a on-request';
  if (help.includes('--add-dir')) flags += ` --add-dir "${CONFIG_DIR}"`;
  return flags;
}

async function findAgentBin(name) {
  // GUI 启动的 app 没有用户 shell 的 PATH，走 login shell 找一次绝对路径。
  // macOS 默认 zsh；Linux 未必装 zsh → 依序 $SHELL → /bin/bash → /bin/sh（见 electron/platform.js 同款逻辑）。
  const shell = PLATFORM === 'win32' ? 'powershell.exe'
    : process.env.SHELL || (PLATFORM === 'darwin' ? '/bin/zsh' : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'));
  return new Promise((resolve) => {
    execFile(shell, ['-lc', `command -v ${name}`], { timeout: 8000 }, (err, stdout) => {
      const out = String(stdout || '').trim().split('\n').pop();
      resolve(!err && out && out.startsWith('/') ? out : null);
    });
  });
}

// Linux 桌面 app 探測：掃 freedesktop .desktop（系統 + 用戶兩層），比對 Name 或 Exec 基名（大小写不敏感）。
// macOS 走 open -Ra；Windows 无此面。扫不到一律视为未装（与 open -Ra 失败的语义一致）。
async function desktopAppExists(name) {
  const want = String(name || '').toLowerCase();
  const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')];
  if (process.env.XDG_DATA_HOME) dirs.push(path.join(process.env.XDG_DATA_HOME, 'applications'));
  try {
    for (const dir of dirs) {
      let names;
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.desktop')) continue;
        let txt;
        try { txt = await fsp.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
        if (/^(NoDisplay|Hidden)=true$/m.test(txt)) continue; // 隐藏入口不算「装了」
        const nameMatch = /^Name=(.+)$/m.exec(txt);
        const execMatch = /^Exec=(.+)$/m.exec(txt);
        const base = execMatch ? path.basename(String(execMatch[1]).trim().split(/\s+/)[0]) : '';
        if ((nameMatch && nameMatch[1].trim().toLowerCase() === want) || (base && base.toLowerCase() === want)) return true;
      }
    }
  } catch { /* 扫描失败一律当没装 */ }
  return false;
}

// 最近几次整理日志的一句话摘要，给 agent 当历史参照（日志由 agent 按 brief 约定写入）
async function organizeHistory() {
  let files = [];
  try { files = (await fsp.readdir(ORGANIZE_LOG_DIR)).filter((f) => f.endsWith('.json')); } catch { return ''; }
  files.sort().reverse();
  const lines = [];
  for (const f of files.slice(0, 3)) {
    try {
      const log = JSON.parse(await fsp.readFile(path.join(ORGANIZE_LOG_DIR, f), 'utf8'));
      const m0 = (log.moves || [])[0];
      const sample = m0 ? `（如 ${path.basename(m0.from)} → ${path.relative(log.dir, m0.to)}）` : '';
      lines.push(`- ${new Date(log.at).toLocaleString('zh-CN')} 整理过 ${log.dir}，移动 ${(log.moves || []).length} 项${sample}`);
    } catch { /* 坏日志跳过 */ }
  }
  return lines.join('\n');
}

// 备料并返回终端启动命令：brief 写盘（偏好 + 历史 + 工作约定），前端用 term.runInDir 拉起交互式 agent
async function organizeLaunch(b) {
  const dir = resolvePath(b.path);
  const cfg = await readConfig();
  let engine = cfg.organizeEngine === 'codex' ? 'codex' : 'claude';
  let bin = await findAgentBin(engine);
  if (!bin) {
    const alt = engine === 'claude' ? 'codex' : 'claude';
    bin = await findAgentBin(alt);
    if (bin) engine = alt;
    else return { ok: false, error: '没找到 claude / codex 命令——AI 整理需要装其中一个 CLI' };
  }
  const prefs = await fsp.readFile(ORGANIZE_PREFS_FILE, 'utf8').catch(() => '');
  const history = await organizeHistory();
  const brief = `# AI 整理任务（翻箱 FanBox 生成，每次启动覆盖本文件）

你在翻箱的内嵌终端里，帮用户对话式整理这个文件夹：${dir}

## 工作流程
1. 先看现状：列出当前文件夹的松散文件（名字/类型/大小/修改时间）。文件夹和隐藏文件一律不动
2. 结合下面的整理偏好与历史，提出分组整理方案摊给用户——用户明确同意前，一个文件都不要动
3. 用户可能口头调整方案（「截图不动」「这几个归到XX」），以对话为准
4. 动手用 mv 移动，目标目录不存在先 mkdir -p
5. 每完成一批移动，按下面的格式写一份回滚日志，并告诉用户「想撤销随时说」
6. 收尾：把这次对话里新学到的用户偏好（规则/例外/纠正）一条一行追加进偏好文件，别重复已有条目

## 回滚日志（撤销能力全靠它，格式不能错）
每批移动写一个新文件 ${ORGANIZE_LOG_DIR}/<毫秒时间戳>.json，内容：
{"dir":"${dir}","at":<毫秒时间戳>,"moves":[{"from":"<移动前绝对路径>","to":"<移动后绝对路径>"}]}
用户要撤销时：读对应日志，逐条把 to 移回 from（from 位置已被占用的跳过并说明）

## 整理偏好（用户的长期规则，优先级最高）
${DEFAULT_ORGANIZE_STRATEGY}
${prefs.trim() ? `\n### 历次整理沉淀的偏好\n${prefs.trim()}\n` : ''}
## 偏好文件
${ORGANIZE_PREFS_FILE}（markdown 列表，新偏好追加在末尾）

## 最近整理历史
${history || '（还没有历史记录）'}
`;
  await fsp.mkdir(ORGANIZE_LOG_DIR, { recursive: true });
  await fsp.writeFile(ORGANIZE_BRIEF_FILE, brief, 'utf8');
  const kickoff = `先完整读 ${ORGANIZE_BRIEF_FILE}，然后按里面的约定，和我对话式整理当前文件夹`;
  // claude 跳权限确认（动手前方案已过人）；codex 旗标按当前版本实测拼出
  const cmd = engine === 'codex'
    ? `codex${await codexOrganizeFlags(bin)} "${kickoff}"`
    : `claude --dangerously-skip-permissions "${kickoff}"`;
  return { ok: true, engine, cmd };
}

// ---------- 发版向导：检查项目状态 → 改版本号/CHANGELOG → 命令序列交给内嵌终端跑（每步可见可拦）----------
async function releaseInspect(p) {
  const dir = resolvePath(p);
  const sh = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { cwd: dir, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout).trim())));
  let pkg;
  try { pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')); }
  catch { return { ok: false, error: '这里没有 package.json——发版向导目前只认 node 项目' }; }
  const out = { ok: true, dir, name: pkg.name || path.basename(dir), version: pkg.version || '0.0.0' };
  out.hasDist = !!(pkg.scripts && pkg.scripts.dist);
  out.remote = await sh('git', ['remote', 'get-url', 'origin']);
  out.branch = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await sh('git', ['status', '--porcelain']);
  out.isRepo = status !== null;
  out.dirty = !!(status && status.length);
  out.gh = !!(await sh('/bin/sh', ['-lc', 'command -v gh']));
  out.unreleased = ''; out.hasChangelog = false;
  try {
    const cl = await fsp.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
    out.hasChangelog = true;
    const m = cl.match(/## \[Unreleased\]\s*([\s\S]*?)(?=\n## \[|$)/);
    if (m) out.unreleased = m[1].trim();
  } catch { /* 没有 CHANGELOG 不挡发版 */ }
  return out;
}

async function releasePrepare(b) {
  const dir = resolvePath(b.path);
  const version = String(b.version || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, error: '版本号格式不对（要 x.y.z）' };
  const notes = String(b.notes || '').trim();
  // 1) package.json 版本号
  const pkgFile = path.join(dir, 'package.json');
  let pkgRaw;
  try { pkgRaw = await fsp.readFile(pkgFile, 'utf8'); } catch { return { ok: false, error: '读不到 package.json' }; }
  if (!/"version"\s*:\s*"[^"]*"/.test(pkgRaw)) return { ok: false, error: 'package.json 里没有 version 字段' };
  await fsp.writeFile(pkgFile, pkgRaw.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`), 'utf8');
  // 2) CHANGELOG：Unreleased 段落升格为新版本，开新的空 Unreleased
  const clFile = path.join(dir, 'CHANGELOG.md');
  try {
    const cl = await fsp.readFile(clFile, 'utf8');
    if (cl.includes('## [Unreleased]')) {
      const date = new Date().toISOString().slice(0, 10);
      const next = cl.replace(/## \[Unreleased\][\s\S]*?(?=\n## \[|$)/, `## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n\n`);
      await fsp.writeFile(clFile, next, 'utf8');
    }
  } catch { /* 没有 CHANGELOG 跳过 */ }
  // 3) 发布说明落临时文件给 gh 用；命令序列拼好交还前端注入终端
  const notesFile = path.join(os.tmpdir(), `fanbox-release-notes-${Date.now()}.md`);
  await fsp.writeFile(notesFile, notes || `v${version}`, 'utf8');
  // 标题优先取第一个要点的内容，「### Added」这类小节头当不了标题
  const lines = notes.split('\n').map((l) => l.trim()).filter(Boolean);
  const firstBullet = lines.find((l) => /^[-*]\s/.test(l));
  const firstPlain = lines.find((l) => !/^#/.test(l));
  const title = (firstBullet || firstPlain || '').replace(/^[#\-*\s]+/, '').slice(0, 60);
  const steps = [];
  if (b.doDist) steps.push('npm run dist');
  steps.push('git add -A', `git commit -m ${shellQuote(`v${version}: ${title || '发版'}`)}`);
  if (b.doPush) steps.push('git push');
  if (b.doRelease) steps.push(`gh release create v${version} --title ${shellQuote(`v${version}${title ? ' · ' + title : ''}`)} --notes-file ${shellQuote(notesFile)}${b.doDist ? ` dist/*${version}*.dmg` : ''}`);
  return { ok: true, cmd: steps.join(' && ') };
}

// ---------- 项目记忆：这个文件夹里 AI 干过什么 ----------
// 数据源：~/.claude/projects/<munge(cwd)>/*.jsonl + ~/.codex/sessions/**/rollout-*.jsonl（头部 cwd 匹配）
//        + ~/.kimi-code/session_index.jsonl（全局索引→state.json）+ ~/.local/share/opencode/storage/session/**/ses_*.json（directory 字段匹配）。
// 单会话解析结果按 (size, mtime) 缓存，再次打开只重解析有变化的文件。统一会话对象 {id, agent, title, firstT, lastT, userMsgs, files, skills}。
// userMsgs 允许为 null 表示「未统计」（kimi/opencode 只读元数据不解析消息正文），前端遇到 null 不渲染条数；0 保留给「确实数过是零条」。
const projMemCache = new Map(); // file -> { size, mtimeMs, sess }
const mungeClaudeDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

async function parseClaudeSession(fp, st) {
  const hit = projMemCache.get(fp);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sess;
  const sess = { id: path.basename(fp, '.jsonl'), agent: 'claude', title: '', firstT: 0, lastT: st.mtimeMs, userMsgs: 0, files: [], skills: [] };
  const filesSet = new Set(), skillsSet = new Set();
  // 流式逐行，廉价字符串预判后才 JSON.parse——大会话文件也不整读进内存
  const stream = fs.createReadStream(fp, { encoding: 'utf8' });
  let rest = '';
  const handleLine = (line) => {
    if (!sess.firstT) {
      const m = line.match(/"timestamp":"([^"]+)"/);
      if (m) sess.firstT = Date.parse(m[1]) || 0;
    }
    if (line.includes('"type":"user"') && !line.includes('"isMeta":true') && !line.includes('"tool_use_id"')) {
      sess.userMsgs++;
      if (!sess.title) {
        try {
          const d = JSON.parse(line);
          const c = d.message && d.message.content;
          let text = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text || '' : '');
          text = text.trim();
          if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) sess.title = text.slice(0, 160);
        } catch { /* */ }
      }
    }
    if (line.includes('"file_path"') && /"name":"(Write|Edit|MultiEdit|NotebookEdit)"/.test(line)) {
      try {
        const d = JSON.parse(line);
        const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
        for (const it of content) {
          if (it.type === 'tool_use' && it.input && it.input.file_path) filesSet.add(it.input.file_path);
        }
      } catch { /* */ }
    }
    if (line.includes('"name":"Skill"')) {
      try {
        const d = JSON.parse(line);
        const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
        for (const it of content) {
          if (it.type === 'tool_use' && it.name === 'Skill' && it.input && it.input.skill) skillsSet.add(String(it.input.skill).replace(/^.*:/, ''));
        }
      } catch { /* */ }
    } else if (line.includes('<command-name>')) {
      const m = line.match(/<command-name>\s*\/?([\w.:-]+)\s*<\/command-name>/);
      if (m) skillsSet.add(m[1].replace(/^.*:/, ''));
    }
  };
  for await (const chunk of stream) {
    rest += chunk;
    let idx;
    while ((idx = rest.indexOf('\n')) !== -1) { handleLine(rest.slice(0, idx)); rest = rest.slice(idx + 1); }
  }
  if (rest.trim()) handleLine(rest);
  sess.files = [...filesSet].slice(0, 80);
  sess.skills = [...skillsSet].slice(0, 20);
  projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess });
  return sess;
}

async function parseCodexSession(fp, st) {
  const hit = projMemCache.get(fp);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sess;
  const sess = { id: '', agent: 'codex', title: '', firstT: st.birthtimeMs || 0, lastT: st.mtimeMs, userMsgs: 0, files: [], skills: [] };
  try {
    const txt = await fsp.readFile(fp, 'utf8');
    for (const line of txt.split('\n')) {
      if (!sess.id && line.includes('session_meta')) {
        const m = line.match(/"id":"([0-9a-f-]{8,})"/);
        if (m) sess.id = m[1];
      }
      if (line.includes('"role":"user"') && line.includes('input_text')) {
        try {
          const d = JSON.parse(line);
          const payload = d.payload || d;
          const item = payload.type === 'message' ? payload : null;
          if (item) {
            const text = (item.content || []).filter((x) => x.type === 'input_text').map((x) => x.text).join(' ').trim();
            // 环境上下文/IDE 注入的供述跳过，只要人打的字
            if (text && !text.startsWith('<')) { sess.userMsgs++; if (!sess.title) sess.title = text.slice(0, 160); }
          }
        } catch { /* */ }
      }
    }
  } catch { /* */ }
  if (!sess.id) sess.id = path.basename(fp, '.jsonl').replace(/^rollout-[\d-]*T[\d-]*-/, '');
  projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess });
  return sess;
}

// Kimi Code 适配器：~/.kimi-code/session_index.jsonl 是现成的全局索引（sessionId → sessionDir + workDir），
// 按 workDir 过滤后逐个读 state.json 拿标题/时间戳，完全不用碰 wire.jsonl 协议日志。
// 消息数/改过的文件埋在 wire.jsonl 里（协议带版本号 1.4，会漂移），列表页不值得挖——给默认值。
const KIMI_HOME = path.join(HOME, '.kimi-code');
async function listKimiSessions(cwd) {
  const out = [];
  let idx;
  try { idx = await fsp.readFile(path.join(KIMI_HOME, 'session_index.jsonl'), 'utf8'); } catch { return out; } // 没装/没用过 Kimi Code
  for (const line of idx.split('\n')) {
    if (!line.includes('"workDir"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.workDir !== cwd || !rec.sessionId || !rec.sessionDir) continue;
    const fp = path.join(String(rec.sessionDir), 'state.json');
    try {
      const st = await fsp.stat(fp);
      const hit = projMemCache.get(fp);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { out.push(hit.sess); continue; }
      const d = JSON.parse(await fsp.readFile(fp, 'utf8'));
      const title = String(d.title || d.lastPrompt || '').trim().slice(0, 160);
      const sess = { id: rec.sessionId, agent: 'kimi', title, firstT: Date.parse(d.createdAt) || 0, lastT: Date.parse(d.updatedAt) || st.mtimeMs, userMsgs: null, files: [], skills: [] };
      projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess });
      out.push(sess);
    } catch { /* 单条会话坏了不拖垮整个列表 */ }
  }
  return out;
}

// opencode 适配器：~/.local/share/opencode/storage/session/<projectID>/ses_*.json 单文件即全部元数据，
// 按 JSON 里的 directory 字段过滤（目录名是 projectID hash，没法从 cwd 正向算，只能全扫——文件小，先 stat 排序封顶控 IO）。
// summary.files 只有改动数量没有路径列表，前端要的是可点击的路径，所以 files 给空数组。
const OPENCODE_SESS = path.join(HOME, '.local', 'share', 'opencode', 'storage', 'session');
async function listOpencodeSessions(cwd) {
  const out = [];
  let projDirs;
  try { projDirs = await fsp.readdir(OPENCODE_SESS, { withFileTypes: true }); } catch { return out; } // 没装/没用过 opencode
  const files = [];
  for (const pd of projDirs) {
    if (!pd.isDirectory()) continue;
    let names;
    try { names = await fsp.readdir(path.join(OPENCODE_SESS, pd.name)); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('ses_') || !n.endsWith('.json')) continue;
      const fp = path.join(OPENCODE_SESS, pd.name, n);
      try { files.push({ fp, st: await fsp.stat(fp) }); } catch { /* */ }
    }
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  for (const { fp, st } of files.slice(0, 200)) {
    try {
      const hit = projMemCache.get(fp);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { if (hit.dir === cwd) out.push(hit.sess); continue; }
      const d = JSON.parse(await fsp.readFile(fp, 'utf8'));
      const dir = String(d.directory || '');
      const t = d.time || {};
      const sess = { id: String(d.id || path.basename(fp, '.json')), agent: 'opencode', title: String(d.title || '').trim().slice(0, 160), firstT: Number(t.created) || 0, lastT: Number(t.updated) || st.mtimeMs, userMsgs: null, files: [], skills: [] };
      projMemCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, sess, dir });
      if (dir === cwd) out.push(sess);
    } catch { /* 单条会话坏了不拖垮整个列表 */ }
  }
  return out;
}

async function projectMemory(p) {
  const cwd = resolvePath(p);
  const sessions = [];
  // Claude Code：项目目录名就是 munge 过的 cwd，正向算一遍直达
  try {
    const base = path.join(CLAUDE_PROJ, mungeClaudeDir(cwd));
    const names = (await fsp.readdir(base)).filter((n) => n.endsWith('.jsonl'));
    const stats = (await Promise.all(names.map(async (n) => {
      const fp = path.join(base, n);
      try { return { fp, st: await fsp.stat(fp) }; } catch { return null; }
    }))).filter(Boolean).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 40);
    for (const { fp, st } of stats) sessions.push(await parseClaudeSession(fp, st));
  } catch { /* 这个目录没有 Claude Code 会话 */ }
  // Codex：近期 rollout 文件按头部 cwd 匹配（数量封顶控 IO）
  try {
    const files = [];
    const walk = async (dir, depth) => {
      let names;
      try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const fp = path.join(dir, n.name);
        if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
        else if (n.isFile() && n.name.endsWith('.jsonl')) {
          try { files.push({ fp, st: await fsp.stat(fp) }); } catch { /* */ }
        }
      }
    };
    await walk(CODEX_SESS, 0);
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const { fp, st } of files.slice(0, 60)) {
      try { if ((await readCwdFromHead(fp, 16384)) === cwd) sessions.push(await parseCodexSession(fp, st)); } catch { /* */ }
    }
  } catch { /* 没用过 Codex */ }
  // Kimi Code / opencode：适配器内部已各自兜底，这里再包一层——任何一家格式漂移都不拖垮整个面板
  try { sessions.push(...await listKimiSessions(cwd)); } catch { /* */ }
  try { sessions.push(...await listOpencodeSessions(cwd)); } catch { /* */ }
  // 没有正经标题的会话（纯 warmup / 空会话）沉底，按最近活跃排
  sessions.sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || b.lastT - a.lastT);
  sessions.sort((a, b) => b.lastT - a.lastT);
  return { ok: true, cwd, sessions: sessions.filter((s) => s.title || s.files.length).slice(0, 40) };
}

// ---------- 磁盘占用透视：算清当前目录每个子项的真实占用 ----------
// 文件直接 stat（快）；目录一次 du -sk 批量算。du 碰到无权限子目录会报错但仍输出能算的部分，所以忽略 err 只用 stdout
async function diskUsage(p) {
  const dir = resolvePath(p);
  let names;
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
  const dirs = [], items = [];
  await Promise.all(names.map(async (d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory() && !d.isSymbolicLink()) { dirs.push(full); return; }
    try { const st = await fsp.lstat(full); if (st.isFile()) items.push({ name: d.name, size: st.size, isDir: false }); } catch { /* */ }
  }));
  if (dirs.length) {
    const out = await new Promise((resolve) => {
      execFile('du', ['-sk', ...dirs], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(stdout || ''));
    });
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) items.push({ name: path.basename(m[2]), size: Number(m[1]) * 1024, isDir: true });
    }
  }
  items.sort((a, b) => b.size - a.size);
  const total = items.reduce((a, b) => a + b.size, 0);
  return { ok: true, dir, total, items: items.slice(0, 60), more: Math.max(0, items.length - 60) };
}

// 压缩包内容清单：全用系统自带工具（unzip / bsdtar / gzip），保持零依赖
// 直接读 zip 中央目录拿文件名：按「通用位标记 bit 11 = UTF-8」决定编码，没设就按 GBK 解（中文名才不乱码）。
// 系统 unzip/bsdtar 会先把字节转码、丢失原始编码，没法事后挽救，所以自己解。zip64/异常结构返回 null 交回退。
async function zipNames(file, MAX) {
  let fd;
  try {
    fd = await fsp.open(file, 'r');
    const { size } = await fd.stat();
    const tailLen = Math.min(size, 65557); // EOCD 22 字节 + 最多 65535 注释
    const tail = Buffer.alloc(tailLen);
    await fd.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) { if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) return null;
    const cdCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null; // zip64，超出本简单解析
    const cd = Buffer.alloc(cdSize);
    await fd.read(cd, 0, cdSize, cdOffset);
    const gbk = new TextDecoder('gbk');
    const out = [];
    let p = 0;
    for (let i = 0; i < cdCount && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break; // central file header 签名
      const flag = cd.readUInt16LE(p + 8);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      let nm;
      if (flag & 0x800) nm = nameBuf.toString('utf8');
      else { try { nm = gbk.decode(nameBuf); } catch { nm = nameBuf.toString('utf8'); } }
      out.push({ name: nm, size: usize });
      p += 46 + nameLen + extraLen + commentLen;
      if (out.length > MAX) break;
    }
    return out;
  } catch { return null; } // 解析失败一律交给 unzip 兜底
  finally { if (fd) await fd.close().catch(() => {}); }
}

async function archiveList(p) {
  const file = resolvePath(p);
  try { await fsp.stat(file); } catch { return { ok: false, error: '文件不存在' }; }
  const name = path.basename(file).toLowerCase();
  // 压缩包里的中文名常是 GBK/CP936 且没设 UTF-8 标志位，按 UTF-8 读会乱码：
  // 拿原始字节，先严格按 UTF-8 解，失败（多半是 GBK 中文名）再回退 GBK。
  const decodeMaybeGbk = (buf) => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('latin1'); } }
  };
  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => (err ? reject(err) : resolve(decodeMaybeGbk(stdout))));
  });
  const MAX = 800;
  const entries = [];
  try {
    if (/\.(zip|jar)$/.test(name)) {
      const parsed = await zipNames(file, MAX); // 自读中央目录，中文名按 GBK/UTF-8 正确解（unzip 会乱码）
      if (parsed) {
        entries.push(...parsed);
      } else { // zip64 / 异常结构本解析器够不着：回退 unzip（名字可能乱码，但至少列得出）
        const out = await run('unzip', ['-l', '--', file]);
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
          if (m) entries.push({ name: m[2], size: Number(m[1]) });
          if (entries.length > MAX) break;
        }
      }
    } else if (/\.(tar|tgz|tbz2?|txz)$/.test(name) || /\.tar\.(gz|bz2|xz|zst)$/.test(name)) {
      const out = await run('tar', ['-tf', file]); // bsdtar 自动识别压缩格式
      for (const line of out.split('\n')) {
        if (line.trim()) entries.push({ name: line });
        if (entries.length > MAX) break;
      }
    } else if (/\.gz$/.test(name)) {
      const out = await run('gzip', ['-l', file]);
      const m = out.split('\n')[1] && out.split('\n')[1].match(/^\s*\d+\s+(\d+)/);
      entries.push({ name: path.basename(file, '.gz'), size: m ? Number(m[1]) : undefined });
    } else {
      return { ok: false, error: '7z / rar 没有系统自带的解析工具，可在系统解压软件中打开' };
    }
  } catch (e) {
    return { ok: false, error: '读取失败：' + (e.message || '').split('\n')[0] };
  }
  const truncated = entries.length > MAX;
  return { ok: true, entries: entries.slice(0, MAX), truncated };
}

// 移动文件到目标目录（截图直通车「收进素材」等用）：同卷 rename，跨卷回退拷贝；同名自动加序号防覆盖
async function movePath(src, dstDir) {
  const s = resolvePath(src), d = resolvePath(dstDir);
  if (!fs.existsSync(s)) return { ok: false, error: '源文件不存在' };
  await fsp.mkdir(d, { recursive: true });
  let dst = path.join(d, path.basename(s));
  if (fs.existsSync(dst)) {
    const ex = path.extname(dst), base = path.basename(dst, ex);
    let i = 2;
    while (fs.existsSync(dst)) dst = path.join(d, `${base}-${i++}${ex}`);
  }
  try { await fsp.rename(s, dst); }
  catch (e) {
    if (e.code === 'EXDEV') { await fsp.copyFile(s, dst); await fsp.unlink(s); }
    else return { ok: false, error: e.message };
  }
  return { ok: true, path: dst };
}

async function createEntry(parentPath, name, type) {
  const parent = resolvePath(parentPath);
  name = (name || '').trim();
  if (!validName(name)) throw new Error('名称不合法');
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw new Error('已存在同名项');
  if (type === 'dir') await fsp.mkdir(target);
  else await fsp.writeFile(target, '', { flag: 'wx' });
  return { ok: true, path: target, isDir: type === 'dir' };
}

// 终端里点文件名 → 定位真实文件：直接 stat → 用 tail 做「空格扩展」逐候选 stat
// → scrollback 回扫候选（alt）逐个 stat → 多根 basename 搜索。
// 空格扩展：前端对带空格的文件名（macOS 截屏等）只能保守匹配到第一个空格，真实边界
// 由文件系统验证——把行尾余文按空格边界逐段拼回路径，哪个候选 stat 命中就是哪个
// 直接 stat + 行尾余文空格扩展（macOS 截屏名「截屏2026-06-10 15.37.43.png」靠这步补全）。
// locatePath 的前半段；也单独服务终端划线前的显示时验证
async function statWithTail(p, tail) {
  const tryStat = async (cand) => {
    try { const real = resolvePath(cand); const st = await fsp.stat(real); return { found: true, path: real, isDir: st.isDirectory() }; }
    catch { return null; }
  };
  if (!p) return null;
  const direct = await tryStat(p);
  if (direct) return direct;
  if (tail) {
    const t = String(tail).slice(0, 160).split(/['"`]/)[0];
    const cands = [];
    const re = /\s+/g; let m;
    while ((m = re.exec(t)) !== null && cands.length < 6) { if (m.index > 0) cands.push(p + t.slice(0, m.index)); }
    if (t.trim() && cands.length < 6) cands.push(p + t.replace(/\s+$/, ''));
    cands.sort((a, b) => b.length - a.length); // 长优先：偏向完整文件名
    for (const c of cands) {
      const hit = await tryStat(c.replace(/[)\]'"`,.:;。，]+$/, ''));
      if (hit) return hit;
    }
  }
  return null;
}

// 终端划线前的批量验证：候选路径 stat 得到才配下划线，中文散文里的「分发/产品演示」不再误标
async function termVerify(b) {
  const cwd = b.cwd ? resolvePath(b.cwd) : HOME;
  const items = Array.isArray(b.items) ? b.items.slice(0, 24) : [];
  const results = await Promise.all(items.map(async (it) => {
    if (!it || typeof it.cand !== 'string') return false;
    let p = it.cand;
    if (!p.startsWith('/') && !p.startsWith('~')) p = cwd.replace(/\/$/, '') + '/' + p.replace(/^\.\//, '');
    return !!(await statWithTail(p, it.tail || ''));
  }));
  return { ok: true, results };
}

async function locatePath(p, name, root, tail, alt, roots) {
  const tryStat = async (cand) => {
    try { const real = resolvePath(cand); const st = await fsp.stat(real); return { found: true, path: real, isDir: st.isDirectory() }; }
    catch { return null; }
  };
  const direct = await statWithTail(p, tail);
  if (direct) return direct;
  // scrollback 回扫候选（最近出现在前）：stat 验证，命中即信——它来自 agent 自己打印的全路径
  for (const a of String(alt || '').split('\n').filter(Boolean).slice(0, 3)) {
    const hit = await tryStat(a);
    if (hit) return { ...hit, viaScrollback: true };
  }
  if (name) {
    // 多根 basename 搜索：终端 cwd + 活跃项目根（前端传来）；同名多个取 mtime 最新（偏向「我刚生成的」）。
    // 所有根共享一个总截止点，避免点了不存在的名时多根 walk 串成十几秒
    const budget = Date.now() + 6000;
    const seen = []; let fuzzy = null;
    for (const r of [root, ...(roots || [])].filter(Boolean)) {
      let rr; try { rr = resolvePath(r); } catch { continue; }
      if (seen.some((d) => rr === d || rr.startsWith(d + path.sep))) continue; // 嵌套根去重
      seen.push(rr);
      try {
        const data = await searchFiles(name, rr, budget);
        const exact = (data.results || []).filter((x) => x.name === name).sort((a, b) => b.mtime - a.mtime)[0];
        if (exact) return { found: true, path: exact.path, isDir: exact.isDir, viaSearch: true };
        if (!fuzzy) fuzzy = (data.results || [])[0];
      } catch { /* */ }
    }
    if (fuzzy) return { found: true, path: fuzzy.path, isDir: fuzzy.isDir, viaSearch: true };
    // Spotlight 兜底（macOS）：截断路径常指向所有项目根之外（桌面、下载、临时目录），
    // 目录遍历够不着；按文件名全盘查，精确同名里取 mtime 最新的（偏向「刚生成的那个」）
    if (process.platform === 'darwin') {
      const paths = await mdfind(['-name', name]);
      let best = null;
      for (const f of (paths || []).slice(0, 200)) {
        if (path.basename(f) !== name) continue;
        try {
          const st = await fsp.stat(f);
          if (!best || st.mtimeMs > best.m) best = { path: f, isDir: st.isDirectory(), m: st.mtimeMs };
        } catch { /* */ }
      }
      if (best) return { found: true, path: best.path, isDir: best.isDir, viaSearch: true };
    }
  }
  return { found: false };
}

// ---------- Git（只读）：让「看 agent 改了什么」从瞬时高亮升级为可回看的 diff ----------
function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 6000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
// 找到 dir 所在 git 仓库根；不是仓库返回 null
async function gitRoot(dir) {
  const r = await execGit(['-C', dir, 'rev-parse', '--show-toplevel'], dir);
  return r.ok ? r.stdout.trim() : null;
}
// 仓库工作区状态：返回相对仓库根的变更文件列表（含状态码）
async function gitStatus(dirPath) {
  const dir = resolvePath(dirPath);
  const root = await gitRoot(dir);
  if (!root) return { isRepo: false };
  const st = await execGit(['-C', root, 'status', '--porcelain'], root);
  const files = (st.stdout || '').split('\n').filter(Boolean).map((line) => {
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    if (rest.includes(' -> ')) rest = rest.split(' -> ')[1]; // 重命名取新名
    rest = rest.replace(/^"|"$/g, '');
    return { code, status: code.trim(), path: path.join(root, rest), name: path.basename(rest) };
  });
  return { isRepo: true, root, files };
}
// 单文件 HEAD 版本 vs 工作区当前内容，供 Monaco DiffEditor 并排渲染
async function gitFileDiff(p) {
  const file = resolvePath(p);
  if (!TEXT_EXT.has(ext(file))) return { isRepo: true, diffable: false };
  const root = await gitRoot(path.dirname(file));
  if (!root) return { isRepo: false };
  const rel = path.relative(root, file).split(path.sep).join('/');
  let modified = '';
  try { modified = await fsp.readFile(file, 'utf8'); } catch { modified = ''; }
  const head = await execGit(['-C', root, 'show', `HEAD:${rel}`], root);
  return { isRepo: true, diffable: true, root, rel, original: head.ok ? head.stdout : '', modified, isNew: !head.ok };
}

// ---------- 回合安全带：影子 git 快照 + 一键回滚 ----------
// agent 每次开工前静默存档。GIT_DIR 放 ~/.fanbox/snapshots/<hash>/，项目文件夹里不落任何东西，
// 对用户自己的 git 仓库零干扰；非 git 项目从此也有 diff 基准和「回到上一轮之前」。
// 每个快照 = commit + tag（tag 保引用，回滚 reset 后历史不丢），tag 滚动裁剪控制磁盘。
const SNAP_ROOT = path.join(CONFIG_DIR, 'snapshots');
const SNAP_INDEX = path.join(SNAP_ROOT, 'index.json');
const SNAP_KEEP = 40; // 每项目保留的快照数
const SNAP_EXCLUDE = [
  'node_modules/', '.git/', 'dist/', 'build/', 'out/', '.next/', '.nuxt/', '.cache/',
  '.venv/', 'venv/', '__pycache__/', 'target/', 'Pods/', 'DerivedData/', '.gradle/',
  '.DS_Store', '*.dmg', '*.iso', '*.mp4', '*.mov', '*.avi', '*.mkv',
].join('\n') + '\n';
const snapThrottle = new Map(); // project → 上次尝试 ms（15s 内不重复扫）
const snapDead = new Set();     // 本次运行内放弃的目录（太大/超时），别每轮都撞一次
// 符号链接归一化：/tmp → /private/tmp 这类别名会让 cwd 和 HOME 字符串对不上、绕过资格守卫
const snapReal = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function snapGitDir(project) {
  return path.join(SNAP_ROOT, crypto.createHash('sha1').update(project).digest('hex').slice(0, 16));
}
function execSnap(gitDir, project, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile('git', ['--git-dir', gitDir, '--work-tree', project, ...args],
      { cwd: project, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, killed: !!(err && err.killed), stdout: stdout || '', stderr: stderr || '' });
      });
  });
}
// 快照资格：拒掉家目录本身、~/Documents 这类一层大目录、Library/废纸篓/.fanbox 自己
// 传入的 project 必须已经 snapReal 归一化（snapshot() 入口统一做）
function snapEligible(project) {
  if (!project || !path.isAbsolute(project)) return false;
  const p = path.normalize(project).replace(/\/+$/, '');
  const realHome = snapReal(HOME);
  if (!p || p === '/' || p === HOME || p === realHome) return false;
  if (p.startsWith(CONFIG_DIR) || p.startsWith(snapReal(CONFIG_DIR))) return false;
  const base = [realHome, HOME].find((h) => p.startsWith(h + path.sep));
  if (base) {
    const segs = path.relative(base, p).split(path.sep);
    // ~/Documents 这类系统大目录整层不给存（自定义的 ~/myproj 一层目录放行）
    const SYS = new Set(['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public', 'Applications', 'Library', '.Trash']);
    if (segs.length === 1 && SYS.has(segs[0])) return false;
    if (segs[0] === 'Library' || segs[0] === '.Trash') return false;
  } else if (p.split(path.sep).filter(Boolean).length < 2) return false; // / 下一层（/tmp 等）不收
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
async function snapEnsureRepo(project) {
  const gitDir = snapGitDir(project);
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    await fsp.mkdir(gitDir, { recursive: true }).catch(() => {}); // git init 不建父目录
    const r = await execSnap(gitDir, project, ['init', '-q']);
    if (!r.ok) return null;
    await fsp.writeFile(path.join(gitDir, 'info', 'exclude'), SNAP_EXCLUDE).catch(() => {});
    // 登记 hash→项目路径，供「文件在哪个影子仓库」反查
    try {
      const idx = JSON.parse(await fsp.readFile(SNAP_INDEX, 'utf8').catch(() => '{}'));
      idx[path.basename(gitDir)] = project;
      await fsp.writeFile(SNAP_INDEX, JSON.stringify(idx, null, 2));
    } catch { /* 索引坏了不挡快照 */ }
  }
  return gitDir;
}
// 打一个快照：无变化不建 commit（天然去重），add 超时视为项目太大、本次运行内放弃
async function snapshot(project, label) {
  project = snapReal(path.normalize(resolvePath(project)).replace(/\/+$/, ''));
  if (!snapEligible(project)) return { ok: false, skipped: 'ineligible' };
  if (snapDead.has(project)) return { ok: false, skipped: 'dead' };
  const last = snapThrottle.get(project) || 0;
  if (Date.now() - last < 15000) return { ok: true, skipped: 'throttled' };
  snapThrottle.set(project, Date.now());
  const gitDir = await snapEnsureRepo(project);
  if (!gitDir) return { ok: false, skipped: 'init-failed' };
  const add = await execSnap(gitDir, project, ['add', '-A'], 25000);
  if (!add.ok) {
    if (add.killed) snapDead.add(project); // 超时 = 太大，别再试
    return { ok: false, skipped: add.killed ? 'too-big' : 'add-failed' };
  }
  const msg = String(label || '回合存档').slice(0, 120);
  const ci = await execSnap(gitDir, project, [
    '-c', 'user.name=FanBox', '-c', 'user.email=snapshot@fanbox.local', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '-m', msg,
  ], 20000);
  if (!ci.ok) return { ok: true, skipped: 'no-change' }; // 与上个快照无差异
  await execSnap(gitDir, project, ['tag', `s${Date.now()}`]);
  // tag 滚动裁剪：超出 SNAP_KEEP 删最旧，gc 交给 git 自己看着办
  const tags = (await execSnap(gitDir, project, ['tag', '-l', 's*'])).stdout.split('\n').filter(Boolean).sort();
  if (tags.length > SNAP_KEEP) {
    await execSnap(gitDir, project, ['tag', '-d', ...tags.slice(0, tags.length - SNAP_KEEP)]);
    execSnap(gitDir, project, ['gc', '--auto', '-q'], 60000); // 不 await，后台随缘
  }
  return { ok: true, created: true };
}
// 列出某目录的快照：精确命中或该目录在某个已存档项目内（取最长前缀）
async function snapResolveProject(p) {
  const norm = snapReal(path.normalize(resolvePath(p)).replace(/\/+$/, ''));
  let idx = {};
  try { idx = JSON.parse(await fsp.readFile(SNAP_INDEX, 'utf8')); } catch { return null; }
  let best = null;
  for (const proj of Object.values(idx)) {
    if ((norm === proj || norm.startsWith(proj + path.sep)) && (!best || proj.length > best.length)) {
      if (fs.existsSync(path.join(snapGitDir(proj), 'HEAD'))) best = proj;
    }
  }
  return best;
}
async function snapList(p) {
  const project = await snapResolveProject(p);
  if (!project) return { ok: true, project: null, snaps: [] };
  const gitDir = snapGitDir(project);
  const r = await execSnap(gitDir, project, [
    'for-each-ref', 'refs/tags/s*', '--sort=-creatordate',
    '--format=%(objectname)%09%(creatordate:unix)%09%(subject)',
  ]);
  const snaps = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, ts, ...rest] = line.split('\t');
    return { hash, ts: Number(ts) * 1000, label: rest.join('\t') };
  });
  return { ok: true, project, snaps };
}
// 回滚：先把当前状态自动存一份（回滚本身永远可撤销），再 reset --hard 到目标快照
async function snapRestore(p, hash) {
  const project = await snapResolveProject(p);
  if (!project) return { ok: false, error: '这个目录还没有存档' };
  if (!/^[0-9a-f]{7,40}$/i.test(String(hash || ''))) return { ok: false, error: '无效的快照标识' };
  const gitDir = snapGitDir(project);
  const has = await execSnap(gitDir, project, ['cat-file', '-e', `${hash}^{commit}`]);
  if (!has.ok) return { ok: false, error: '找不到这个快照' };
  snapThrottle.delete(project); // 安全存档绝不能被节流吞掉：没备份就 reset 等于毁数据
  const backup = await snapshot(project, '回滚前自动存档'); // 无变化时静默跳过，正合适
  if (!backup.ok) return { ok: false, error: '当前状态存档失败，为安全起见不执行恢复' };
  const r = await execSnap(gitDir, project, ['reset', '--hard', hash, '-q'], 60000);
  snapThrottle.delete(project); // 回滚后下一轮 agent 开工要能立刻存档
  if (!r.ok) return { ok: false, error: '恢复失败：' + (r.stderr || '').slice(0, 200) };
  return { ok: true, project };
}
// 影子 diff：文件不在 git 仓库时，以「上一回合快照」为基准出 original
async function snapFileDiff(file) {
  file = snapReal(file); // 项目路径是 realpath 存的，文件也归一化才能算出正确的相对路径
  const project = await snapResolveProject(path.dirname(file));
  if (!project) return null;
  const gitDir = snapGitDir(project);
  const head = await execSnap(gitDir, project, ['log', '-1', '--format=%ct']);
  if (!head.ok) return null;
  const rel = path.relative(project, file).split(path.sep).join('/');
  const show = await execSnap(gitDir, project, ['show', `HEAD:${rel}`]);
  let modified = '';
  try { modified = await fsp.readFile(file, 'utf8'); } catch { modified = ''; }
  return {
    isRepo: false, shadow: true, diffable: true, root: project, rel,
    baseTs: Number(head.stdout.trim()) * 1000,
    original: show.ok ? show.stdout : '', modified, isNew: !show.ok,
  };
}

// 图片编辑保存：前端 canvas 导出 dataURL（已含格式/尺寸/质量/标注），这里原子写回
async function saveImage({ path: target, dataUrl, newName }) {
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('无效图片数据');
  const buf = Buffer.from(m[1], 'base64');
  let dest = resolvePath(target);
  if (newName) {
    if (!validName(newName)) throw new Error('文件名不合法');
    dest = path.join(path.dirname(dest), newName);
    if (fs.existsSync(dest)) throw new Error('已存在同名文件');
  }
  const tmp = `${dest}.fanbox-tmp-${process.pid}-${Date.now()}`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, dest);
  } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  const st = await fsp.stat(dest);
  return { ok: true, path: dest, size: st.size };
}

function openInOS(target, withApp) {
  return new Promise((resolve) => {
    let cmd, args;
    if (withApp === 'terminal') {
      // 在该目录（文件则取其所在目录）打开系统终端，找回项目后一键去跑
      const dir = (() => { try { return fs.statSync(target).isDirectory() ? target : path.dirname(target); } catch { return path.dirname(target); } })();
      if (PLATFORM === 'darwin') cmd = `open -a Terminal ${shellQuote(dir)}`;
      else if (PLATFORM === 'win32') cmd = `start "" cmd /K cd /d "${dir}"`;
      else cmd = `x-terminal-emulator --working-directory=${shellQuote(dir)} || gnome-terminal --working-directory=${shellQuote(dir)} || xterm`;
      exec(cmd, (err) => resolve(err ? { ok: false, error: err.message } : { ok: true, with: 'terminal' }));
      return;
    }
    if (withApp === 'editor') {
      // 用 VS Code 打开（文件或文件夹）
      cmd = 'code';
      args = [target];
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {
        // 没装 code CLI，回退到系统默认
        openDefault(target, withApp).then(resolve);
      });
      child.on('spawn', () => { child.unref(); resolve({ ok: true, with: 'editor' }); });
      return;
    }
    openDefault(target, withApp).then(resolve);
  });
}

function openDefault(target, withApp) {
  return new Promise((resolve) => {
    let cmd;
    if (PLATFORM === 'darwin') {
      if (withApp === 'reveal') cmd = `open -R ${shellQuote(target)}`;
      else cmd = `open ${shellQuote(target)}`;
    } else if (PLATFORM === 'win32') {
      if (withApp === 'reveal') cmd = `explorer /select,"${target}"`;
      else cmd = `start "" "${target}"`;
    } else {
      if (withApp === 'reveal') cmd = `xdg-open ${shellQuote(path.dirname(target))}`;
      else cmd = `xdg-open ${shellQuote(target)}`;
    }
    exec(cmd, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true, with: withApp || 'default' });
    });
  });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function defaultRoots() {
  const candidates = [
    ['主目录', HOME],
    ['桌面', path.join(HOME, 'Desktop')],
    ['文档', path.join(HOME, 'Documents')],
    ['下载', path.join(HOME, 'Downloads')],
    ['代码 / Code', path.join(HOME, 'Code')],
    ['项目 / Projects', path.join(HOME, 'Projects')],
    ['Developer', path.join(HOME, 'Developer')],
  ];
  return candidates
    .filter(([, p]) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .map(([name, p]) => ({ name, path: p }));
}

// ---------- 静态资源 ----------

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC, rel));
  // 边界要带分隔符，否则 /path/to/public-evil 也会 startsWith('/path/to/public') 通过
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

// ---------- 缩略图（性能关键：不再把原图/原视频整文件当缩略图）----------
const THUMB_IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif']);
const ALPHA_IMG_EXT = new Set(['png', 'gif', 'webp', 'avif']); // 可能带透明通道：缩略图必须出 png，jpeg 会把透明拍成白底
const thumbInflight = new Map(); // cacheFile -> Promise，去重并发生成
function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15000 }, (e) => (e ? reject(e) : resolve())));
}
// 图片走 sips 缩放（macOS 快）；视频/PDF/其它走 qlmanage QuickLook 抽帧（macOS）。
// Linux（及非 mac）：sips/qlmanage 不存在 → 图片/视频统一 ffmpeg 缩放抽帧，PDF 走 pdftoppm；
// 工具缺失（如无 HEIF 解码的 ffmpeg）时 run 抛错 → 上层 415，前端降级矢量图标。
async function generateThumb(src, e, size, cacheFile, isImg) {
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  if (PLATFORM === 'darwin') {
    if (isImg) {
      const fmt = cacheFile.endsWith('.png') ? 'png' : 'jpeg';
      await run('sips', ['-s', 'format', fmt, '-Z', String(size), src, '--out', cacheFile]);
      return;
    }
    const tmpDir = path.join(THUMB_DIR, '_ql_' + process.pid + '_' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(tmpDir, { recursive: true });
    try {
      await run('qlmanage', ['-t', '-s', String(size), '-o', tmpDir, src]);
      const png = (await fsp.readdir(tmpDir)).find((f) => f.endsWith('.png'));
      if (!png) throw new Error('no thumb');
      await fsp.rename(path.join(tmpDir, png), cacheFile);
    } finally { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
    return;
  }
  // Linux / 其它：PDF 首帧走 pdftoppm（-singlefile 输出名 == 去扩展名的 base）；其余统一 ffmpeg 缩放抽帧。
  // 输出格式由 cacheFile 后缀决定（透明图 .png → png 编码器，其余 .jpg → jpeg），与 darwin 语义一致。
  if (e === 'pdf') {
    await run('pdftoppm', ['-png', '-singlefile', '-scale-to', String(size), src, cacheFile.replace(/\.png$/i, '')]);
    return;
  }
  const scale = `scale='min(iw,${size})':'min(ih,${size})':force_original_aspect_ratio=decrease`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', scale, '-frames:v', '1', cacheFile]);
}
// 缩略图缓存按总体积上限做 LRU 裁剪（同一文件改一次就多一个缓存键，不清会无限涨）
async function pruneThumbs(maxBytes = 400 * 1024 * 1024) {
  try {
    const files = await fsp.readdir(THUMB_DIR);
    const stats = (await Promise.all(files.map(async (f) => {
      if (f.startsWith('_ql_')) return null;
      const fp = path.join(THUMB_DIR, f);
      try { const s = await fsp.stat(fp); return s.isFile() ? { fp, size: s.size, t: s.mtimeMs } : null; } catch { return null; }
    }))).filter(Boolean);
    let total = stats.reduce((a, b) => a + b.size, 0);
    if (total <= maxBytes) return;
    stats.sort((a, b) => a.t - b.t); // 最旧的先删
    for (const f of stats) { if (total <= maxBytes) break; await fsp.unlink(f.fp).catch(() => {}); total -= f.size; }
  } catch { /* 目录不存在等，忽略 */ }
}

// 排版档把图片转 base64 时用：渲染进程受同源策略限制，抓不到图床里的外链图，
// 由本机服务代抓一次（带上源站 referer，绕开常见的防盗链）。只放行 http(s)，只回图片。
// 代抓目标限定公网：本机服务权限大，不给页面借道探测回环/内网/云元数据地址的机会；响应体设上限防撑爆内存。
// 三个易被绕过的点都要堵：①IPv6 URL 的 hostname 自带方括号（[::1]），丢给 DNS 查会被泛解析域名放行，
// 所以 IP 字面量剥括号后直接按网段判、绝不走 DNS；②长写法（0:0:0:0:0:0:0:1）正则会漏，按网段用 BlockList 算，
// 正则只兜底映射写法；③重定向逐跳校验——follow 模式下中间跳的内网请求已经真实发出去了。
const PRIVATE_HOST_RE = /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\.)|^(::1$|::ffff:|f[cd]|fe80:)/i;
const PRIVATE_NETS = (() => {
  const bl = new (require('net').BlockList)();
  [['127.0.0.0', 8], ['10.0.0.0', 8], ['0.0.0.0', 8], ['192.168.0.0', 16], ['169.254.0.0', 16], ['172.16.0.0', 12], ['100.64.0.0', 10]]
    .forEach(([a, p]) => bl.addSubnet(a, p, 'ipv4'));
  // 注意别加 ::ffff:0:0/96：BlockList 会把普通 IPv4 也算进这条 v6 规则，公网图会被全拦。映射地址在下面单独拆。
  [['::1', 128], ['fc00::', 7], ['fe80::', 10]]
    .forEach(([a, p]) => bl.addSubnet(a, p, 'ipv6'));
  return bl;
})();
// ::ffff:127.0.0.1 和 ::ffff:7f00:1 是同一个回环的两种写法，取出内嵌的 v4 再判
function unmapV4(ip) {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  if (require('net').isIPv4(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!hex) return null;
  const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function isPrivateIp(ip) {
  const fam = require('net').isIP(ip);
  if (!fam) return false;
  if (fam === 6) {
    const v4 = unmapV4(ip);
    if (v4) return isPrivateIp(v4);
    return PRIVATE_NETS.check(ip, 'ipv6') || PRIVATE_HOST_RE.test(ip);
  }
  return PRIVATE_NETS.check(ip, 'ipv4') || PRIVATE_HOST_RE.test(ip);
}
async function assertPublicHost(hostname) {
  const bare = String(hostname || '').replace(/^\[|\]$/g, ''); // IPv6 hostname 形如 [::1]
  if (require('net').isIP(bare)) {
    if (isPrivateIp(bare)) throw new Error('只代抓公网图片地址');
    return;
  }
  const addrs = await require('dns').promises.lookup(bare, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('只代抓公网图片地址');
}
const PROXY_IMG_MAX_BYTES = 20 * 1024 * 1024;
const PROXY_IMG_MAX_HOPS = 5;
async function proxyImage(res, url) {
  try {
    if (!/^https?:\/\//i.test(url || '')) return sendJSON(res, 400, { error: '只支持 http(s) 图片' });
    let target = url; let r = null;
    for (let hop = 0; hop <= PROXY_IMG_MAX_HOPS; hop++) {
      await assertPublicHost(new URL(target).hostname); // 每一跳发请求前都校验，重定向进内网直接断
      r = await fetch(target, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0', referer: new URL(target).origin + '/' },
        signal: AbortSignal.timeout(20000),
      });
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      const loc = r.headers.get('location');
      if (!loc) break;
      try { await r.body?.cancel(); } catch { /* 重定向响应体直接丢弃 */ }
      target = new URL(loc, target).href;
      if (!/^https?:$/i.test(new URL(target).protocol)) return sendJSON(res, 502, { error: '重定向到了非 http(s) 地址' });
      r = null; // 循环耗尽仍是重定向时以此为凭
    }
    if (!r) return sendJSON(res, 502, { error: '重定向次数过多' });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//i.test(type)) return sendJSON(res, 502, { error: '抓不到这张图（HTTP ' + r.status + '）' });
    if (Number(r.headers.get('content-length') || 0) > PROXY_IMG_MAX_BYTES) return sendJSON(res, 502, { error: '图片超过 20MB，不代抓' });
    const chunks = []; let total = 0;
    for await (const chunk of r.body) {
      total += chunk.length;
      if (total > PROXY_IMG_MAX_BYTES) return sendJSON(res, 502, { error: '图片超过 20MB，不代抓' });
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    sendJSON(res, 502, { error: String((e && e.message) || e) });
  }
}

async function serveThumb(req, res, p, size) {
  let src;
  try { src = resolvePath(p); } catch { res.writeHead(400); res.end('bad path'); return; }
  let st;
  try { st = await fsp.stat(src); if (!st.isFile()) throw 0; } catch { res.writeHead(404); res.end('not found'); return; }
  const s = Math.min(1600, Math.max(48, size || 240));
  const e = ext(src);
  const isImg = THUMB_IMG_EXT.has(e);
  const key = crypto.createHash('md5').update(src + ':' + st.mtimeMs + ':' + s).digest('hex');
  const jpegOut = isImg && !ALPHA_IMG_EXT.has(e);
  const cacheFile = path.join(THUMB_DIR, key + (jpegOut ? '.jpg' : '.png'));
  const type = jpegOut ? 'image/jpeg' : 'image/png';
  const sendCache = () => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=604800' });
    const rs = fs.createReadStream(cacheFile);
    rs.on('error', () => { try { res.destroy(); } catch { /* */ } }); // 读缓存中途出错别让未捕获 error 打挂进程
    rs.pipe(res);
  };
  if (fs.existsSync(cacheFile)) return sendCache();
  let pr = thumbInflight.get(cacheFile);
  if (!pr) { pr = generateThumb(src, e, s, cacheFile, isImg).finally(() => thumbInflight.delete(cacheFile)); thumbInflight.set(cacheFile, pr); }
  try { await pr; sendCache(); }
  catch { res.writeHead(415); res.end('no thumb'); } // 前端 onerror 回退矢量图标
}

// HEIC/HEIF 浏览器与 Chromium 原生不支持：macOS 用 sips 全尺寸转码成 jpeg 缓存后再吐，
// Linux 尝试 ffmpeg（需 heif 解码器，多数发行版未编入 → 优雅 415）；
// /api/raw 和 /fs/ 都透明走这条，markdown 里的 ![](x.heic) 预览即可显示。复用缩略图那套 run/缓存/LRU。
const HEIC_EXT = new Set(['heic', 'heif']);
async function serveHeicAsJpeg(req, res, file, st) {
  const key = crypto.createHash('md5').update(file + ':' + st.mtimeMs).digest('hex');
  const cacheFile = path.join(THUMB_DIR, key + '.heic.jpg');
  const send = () => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=604800' });
    const rs = fs.createReadStream(cacheFile);
    rs.on('error', () => { try { res.destroy(); } catch { /* */ } });
    rs.pipe(res);
  };
  if (fs.existsSync(cacheFile)) return send();
  let pr = thumbInflight.get(cacheFile);
  if (!pr) {
    pr = (async () => {
      await fsp.mkdir(THUMB_DIR, { recursive: true });
      if (PLATFORM === 'darwin') await run('sips', ['-s', 'format', 'jpeg', file, '--out', cacheFile]);
      else await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', cacheFile]);
    })()
      .finally(() => thumbInflight.delete(cacheFile));
    thumbInflight.set(cacheFile, pr);
  }
  try { await pr; pruneThumbs(); send(); }
  catch { res.writeHead(415); res.end('heic transcode failed'); } // 前端 onerror 回退矢量图标
}

// 流式返回原始文件（图片 / 视频 / pdf / 音频预览），支持 Range
function serveRaw(req, res, filePath) {
  let file;
  try { file = resolvePath(filePath); } catch { res.writeHead(400); res.end('bad path'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    if (HEIC_EXT.has(ext(file))) return serveHeicAsJpeg(req, res, file, st); // HEIC → 转码 jpeg，绕过下面的原始字节路径
    const type = MIME[ext(file)] || 'application/octet-stream';
    const onStreamErr = (rs) => rs.on('error', () => { try { res.destroy(); } catch { /* */ } });
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      // 钳制到文件实际范围：畸形 Range（如 bytes=99999999-）否则会让 createReadStream 抛未捕获 error 崩进程
      let startB = m && m[1] ? parseInt(m[1], 10) : 0;
      let endB = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!Number.isFinite(startB) || startB < 0) startB = 0;
      if (!Number.isFinite(endB) || endB > st.size - 1) endB = st.size - 1;
      if (startB > endB) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${startB}-${endB}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': endB - startB + 1,
      });
      const rs = fs.createReadStream(file, { start: startB, end: endB });
      onStreamErr(rs); rs.pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      const rs = fs.createReadStream(file);
      onStreamErr(rs); rs.pipe(res);
    }
  });
}

// 为 /fs/ 下 HTML 预览注入辅助标签：
// 1. 测宽脚本——桌面 Chromium 的 iframe 会忽略 viewport meta，定宽桌面页照样按自身宽度铺开，
//    窄预览框只能露出左上角；脚本把页面自然宽度 postMessage 给前端，由前端整页等比缩放适配。
// 2. 兜底样式——html/body 可滚动、图片视频不超宽（canvas/svg 不动，挤压它们会让动效 demo 变形）。
// 3. viewport meta——桌面 iframe 用不上，但保留它，手机经局域网访问预览时有用。
async function serveHtmlPreview(req, res, filePath) {
  let file;
  try { file = resolvePath(filePath); } catch { res.writeHead(400); res.end('bad path'); return; }
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) { res.writeHead(404); res.end('not found'); return; }
  } catch { res.writeHead(404); res.end('not found'); return; }
  try {
    let html = await fsp.readFile(file, 'utf8');
    const viewportRe = /<meta[^>]*name=["']viewport["'][^>]*>/i;
    const styleBlock = `<style data-fanbox-preview>
  html, body { overflow: auto; }
  img, video { max-width: 100%; height: auto; }
</style>`;
    const measureScript = '<script data-fanbox-measure>(function(){var l=0;function r(){var w=Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0);if(w&&w!==l){l=w;try{parent.postMessage({fanboxPreviewWidth:w},"*")}catch(e){}}}addEventListener("load",function(){r();setTimeout(r,300)});addEventListener("resize",r)})()</script>';
    // 本地图片引用兜底：不同 agent 写 html 引图方式各异，http 预览（沙箱 iframe）里有两类必裂——
    //   ① file:// 绝对 URL（http 页面禁加载 file://）；② /Users 这种裸绝对路径（解析到源站根）。
    // 策略分两层，确保「修问题不引入新问题」：
    //   · 主动改写：只碰 file://（http 预览里永远加载不了，改成 /fs 镜像只会帮忙、不会误伤任何能用的引用）；
    //   · 失败兜底：其余绝对路径只在「已加载失败」时才重写到 /fs 再试一次（对本来能加载的引用零影响 → 结构性零回归）。
    //   · 相对路径走 /fs/<目录>/ 本就正常，失败多半是文件真没了，不强行兜底。
    // 未覆盖（注释在此说清，别让后人误以为全兜住）：<style> 块/外部 css 里的 file:// 背景图、srcset、加载后 JS 动态插入的元素。
    const localImgScript = '<script data-fanbox-localimg>(function(){var FS="/fs";function f2fs(u){return (u&&u.slice(0,7)==="file://")?FS+u.slice(7):null;}function fix(el){if(!el.getAttribute)return;["src","href","poster"].forEach(function(a){var v=el.getAttribute(a),n=f2fs(v);if(n)el.setAttribute(a,n);});var st=el.getAttribute("style");if(st&&st.indexOf("file://")>-1)el.setAttribute("style",st.split("file://").join(FS));}function sweep(){document.querySelectorAll("[src],[href],[poster],[style]").forEach(fix);}sweep();document.addEventListener("DOMContentLoaded",sweep);document.addEventListener("error",function(e){var el=e.target;if(!el||!el.getAttribute||el.getAttribute("data-fs-tried"))return;var attr=el.tagName==="LINK"?"href":"src",v=el.getAttribute(attr);if(!v||v.charAt(0)!=="/"||v.slice(0,4)==="/fs/")return;if(/^(https?:|data:|blob:)/.test(v))return;el.setAttribute("data-fs-tried","1");el.setAttribute(attr,FS+v);},true);})()</script>';
    function injectHead(tag) {
      const headClose = html.match(/<\/head>/i);
      const headOpen = html.match(/<head[^>]*>/i);
      if (headClose) {
        html = html.slice(0, headClose.index) + '  ' + tag + '\n' + html.slice(headClose.index);
      } else if (headOpen) {
        html = html.slice(0, headOpen.index + headOpen[0].length) + '\n  ' + tag + '\n' + html.slice(headOpen.index + headOpen[0].length);
      } else {
        // 没有 <head> 时，把标签插到 <!DOCTYPE ...> 之后，或文档最开头
        const doctype = html.match(/<!DOCTYPE[^>]*>/i);
        if (doctype) {
          html = html.slice(0, doctype.index + doctype[0].length) + '\n' + tag + html.slice(doctype.index + doctype[0].length);
        } else {
          html = tag + '\n' + html;
        }
      }
    }
    if (!viewportRe.test(html)) {
      injectHead('<meta name="viewport" content="width=device-width, initial-scale=1">');
    }
    if (!html.includes('data-fanbox-preview')) {
      injectHead(styleBlock);
    }
    if (!html.includes('data-fanbox-measure')) {
      injectHead(measureScript);
    }
    if (!html.includes('data-fanbox-localimg')) {
      injectHead(localImgScript);
    }
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  } catch (err) {
    // 读取/编码异常时回退到原始流，保证至少能打开
    console.error('serveHtmlPreview fallback', err);
    return serveRaw(req, res, filePath);
  }
}

const MAX_BODY = 64 * 1024 * 1024; // 64MB 上限，防止恶意请求无限累加把内存撑爆
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) { aborted = true; try { req.destroy(); } catch { /* */ } resolve({}); return; }
      data += c;
    });
    req.on('end', () => { if (!aborted) { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } } });
    req.on('error', () => { if (!aborted) { aborted = true; resolve({}); } });
  });
}

// ---------- Agent 用量（Claude Code / Codex）----------
// 不依赖两个 CLI 在跑：直接读它们落在本机的会话日志。
// Claude Code：~/.claude/projects/**/*.jsonl 里每条 assistant 消息带 usage（token 明细）→ 增量解析聚合
// Codex：~/.codex/sessions/**/rollout-*.jsonl 的 token_count 事件带 rate_limits（5h 窗口/周配额百分比，官方数）→ tail 取最新快照
const CLAUDE_PROJ = path.join(HOME, '.claude', 'projects');
const CODEX_SESS = path.join(HOME, '.codex', 'sessions');
const PI_SESS = path.join(HOME, '.pi', 'agent', 'sessions');       // pi：sessions/<项目目录>/<时间戳>.jsonl
const HERMES_TERM = path.join(HOME, '.hermes', 'terminal-sessions'); // Hermes：tty-* 单行 JSON 自带 cwd
const claudeFileCache = new Map(); // file -> { offset, lastMsgId, events: [{t, in, out, cc, cr}] }
let usageResultCache = { at: 0, data: null };

// ---------- pi / Hermes 的本地 token 统计（与 Claude 同款三桶：近5h / 今日 / 本周）----------
// pi：会话 JSONL 里 role=assistant 的行自带 usage（input/output/cacheRead/cacheWrite/reasoning）
const piFileCache = new Map(); // file -> { offset, lastRespId, events: [{t,in,out,cc,cr}] }
async function parsePiFile(file, stat) {
  let c = piFileCache.get(file);
  if (!c) { c = { offset: 0, lastRespId: '', events: [] }; piFileCache.set(file, c); }
  if (stat.size < c.offset) { c.offset = 0; c.lastRespId = ''; c.events = []; }
  if (stat.size === c.offset) return c.events;
  const fh = await fsp.open(file, 'r');
  let chunk;
  try {
    const len = stat.size - c.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, c.offset);
    chunk = buf.toString('utf8');
  } finally { await fh.close(); }
  const lastNL = chunk.lastIndexOf('\n');
  if (lastNL === -1) return c.events;
  c.offset += Buffer.byteLength(chunk.slice(0, lastNL + 1), 'utf8');
  for (const line of chunk.slice(0, lastNL).split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d && d.message;
    const u = m && m.usage;
    if (!u || m.role !== 'assistant') continue;
    if (u.input == null && u.output == null) continue;
    if (u.outputTokens != null && u.inputTokens == null && !('input' in u)) continue; // 异形 usage 不认
    if (d.responseId && d.responseId === c.lastRespId) continue; // 重放/续写同一响应：只记一次
    if (d.responseId) c.lastRespId = d.responseId;
    const t = Date.parse(d.timestamp || '') || stat.mtimeMs;
    c.events.push({ t, in: u.input || 0, out: (u.output || 0) + (u.reasoning || 0), cc: u.cacheWrite || 0, cr: u.cacheRead || 0 });
  }
  return c.events;
}
// 三桶聚合器：claude 的内联逻辑抽出来共用（claudeUsage 原样不动，新来源走这里）
function bucketEvents(events) {
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const mk = () => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, msgs: 0 });
  const last5h = mk(), today = mk(), week = mk();
  for (const e of events) {
    const tot = e.in + e.out + e.cc + e.cr;
    for (const [b, from] of [[last5h, now - 5 * 3600000], [today, dayStart.getTime()], [week, now - 7 * 86400000]]) {
      if (e.t >= from) { b.total += tot; b.input += e.in; b.output += e.out; b.cacheRead += e.cr; b.cacheCreate += e.cc; b.msgs++; }
    }
  }
  return { last5h, today, week };
}
async function piUsage() {
  const cutoff = Date.now() - 8 * 86400000;
  const files = [];
  const walk = async (dir, depth) => {
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const fp = path.join(dir, n.name);
      if (n.isDirectory() && depth < 2) await walk(fp, depth + 1);
      else if (n.isFile() && n.name.endsWith('.jsonl')) {
        try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, st }); } catch { /* */ }
      }
    }
  };
  await walk(PI_SESS, 0);
  if (!files.length) return null;
  const live = new Set(files.map((f) => f.fp));
  for (const k of piFileCache.keys()) { if (!live.has(k)) piFileCache.delete(k); }
  const all = [];
  for (const { fp, st } of files) { try { all.push(...await parsePiFile(fp, st)); } catch { /* 单文件坏不挡整体 */ } }
  return all.length ? bucketEvents(all) : null;
}
// Hermes：state.db（SQLite）sessions 表自带每会话 token 合计。node:sqlite 是 Node≥22.5 内置，
// Electron 33 内置 Node 20 没有它 → 桌面版优雅降级为不显示 Hermes 一栏，网页版可用。
let hermesDb = undefined;
function hermesOpen() {
  if (hermesDb !== undefined) return hermesDb;
  try {
    const { DatabaseSync } = require('node:sqlite');
    hermesDb = new DatabaseSync(path.join(HOME, '.hermes', 'state.db'), { readOnly: true });
  } catch { hermesDb = null; } // 没有 node:sqlite / 没装 Hermes / 库损坏：都不致命
  return hermesDb;
}
function hermesUsage() {
  const db = hermesOpen();
  if (!db) return null;
  try {
    const rows = db.prepare('select started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens from sessions where started_at >= ?').all((Date.now() - 8 * 86400000) / 1000);
    if (!rows.length) return null;
    const events = rows.filter((r) => r.started_at != null).map((r) => ({
      t: r.started_at * 1000,
      in: r.input_tokens || 0, out: r.output_tokens || 0, cc: r.cache_write_tokens || 0, cr: r.cache_read_tokens || 0,
    }));
    return events.length ? bucketEvents(events) : null;
  } catch { return null; }
}

async function parseClaudeFile(file, stat) {
  let c = claudeFileCache.get(file);
  if (!c) { c = { offset: 0, lastMsgId: '', events: [] }; claudeFileCache.set(file, c); }
  if (stat.size < c.offset) { c.offset = 0; c.lastMsgId = ''; c.events = []; } // 文件被截断重写：重来
  if (stat.size === c.offset) return c.events;
  const fh = await fsp.open(file, 'r');
  let chunk;
  try {
    const len = stat.size - c.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, c.offset);
    chunk = buf.toString('utf8');
  } finally { await fh.close(); }
  // 末尾可能是写到一半的行：留给下一轮，offset 只推进到最后一个完整换行
  const lastNL = chunk.lastIndexOf('\n');
  if (lastNL === -1) return c.events;
  c.offset += Buffer.byteLength(chunk.slice(0, lastNL + 1), 'utf8');
  for (const line of chunk.slice(0, lastNL).split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d && d.message;
    const u = m && m.usage;
    if (!u || d.type !== 'assistant') continue;
    if (m.model === '<synthetic>') continue;
    if (m.id && m.id === c.lastMsgId) continue; // 同一条消息分多行落盘，usage 重复：只记第一次
    if (m.id) c.lastMsgId = m.id;
    const t = Date.parse(d.timestamp || '') || stat.mtimeMs;
    c.events.push({ t, in: u.input_tokens || 0, out: u.output_tokens || 0, cc: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0 });
  }
  return c.events;
}

async function claudeUsage() {
  const cutoff = Date.now() - 8 * 86400000;
  const files = [];
  let dirs;
  try { dirs = await fsp.readdir(CLAUDE_PROJ); } catch { return null; } // 没装/没用过 Claude Code
  await Promise.all(dirs.map(async (d) => {
    let names;
    try { names = await fsp.readdir(path.join(CLAUDE_PROJ, d)); } catch { return; }
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
      const fp = path.join(CLAUDE_PROJ, d, n);
      try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, st }); } catch { /* */ }
    }));
  }));
  const live = new Set(files.map((f) => f.fp));
  for (const k of claudeFileCache.keys()) { if (!live.has(k)) claudeFileCache.delete(k); } // 过期文件出缓存
  const all = [];
  for (const { fp, st } of files) { try { all.push(...await parseClaudeFile(fp, st)); } catch { /* 单文件坏不挡整体 */ } }
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const mk = () => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, msgs: 0 });
  const last5h = mk(), today = mk(), week = mk();
  for (const e of all) {
    const tot = e.in + e.out + e.cc + e.cr;
    for (const [b, from] of [[last5h, now - 5 * 3600000], [today, dayStart.getTime()], [week, now - 7 * 86400000]]) {
      if (e.t >= from) { b.total += tot; b.input += e.in; b.output += e.out; b.cacheRead += e.cr; b.cacheCreate += e.cc; b.msgs++; }
    }
  }
  return { last5h, today, week };
}

// 从最近改动的 rollout 文件尾部抓最后一条带 rate_limits 的 token_count（官方配额快照）
async function codexUsage() {
  const files = [];
  const walk = async (dir, depth) => {
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const fp = path.join(dir, n.name);
      if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
      else if (n.isFile() && n.name.endsWith('.jsonl')) {
        try { const st = await fsp.stat(fp); files.push({ fp, mtimeMs: st.mtimeMs, size: st.size }); } catch { /* */ }
      }
    }
  };
  await walk(CODEX_SESS, 0);
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, 10)) { // 最新几个会话里找；都没有就放弃
    try {
      const fh = await fsp.open(f.fp, 'r');
      let txt;
      try {
        const len = Math.min(f.size, 262144);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, f.size - len);
        txt = buf.toString('utf8');
      } finally { await fh.close(); }
      const lines = txt.split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('"rate_limits"')) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const pl = d && d.payload;
        const rl = pl && pl.rate_limits;
        if (!rl || (!rl.primary && !rl.secondary)) continue;
        const capturedAt = Date.parse(d.timestamp || '') || f.mtimeMs;
        // 快照是「当时」的数：窗口在快照之后重置过的话，旧百分比就完全失真（比如 21 小时前
        // 的 5h 窗口 57%），归零并标 stale——没有新会话日志就说明重置后根本没用过
        const win = (w) => {
          if (!w) return null;
          let resetsAt = w.resets_at || 0;
          if (typeof resetsAt === 'string') resetsAt = Math.floor(Date.parse(resetsAt) / 1000) || 0;
          let end = resetsAt * 1000;
          if (!end && w.resets_in_seconds != null) end = capturedAt + w.resets_in_seconds * 1000;
          if (!end && w.window_minutes) end = capturedAt + w.window_minutes * 60000;
          const stale = !!end && end < Date.now();
          return { usedPercent: stale ? 0 : w.used_percent, windowMinutes: w.window_minutes, resetsAt: stale ? 0 : resetsAt, stale };
        };
        return { planType: rl.plan_type || '', capturedAt, primary: win(rl.primary), secondary: win(rl.secondary) };
      }
    } catch { /* 下一个文件 */ }
  }
  return null;
}

// Claude Code 官方限额窗口（和它 /usage 面板同源）：5h 滚动窗口 + 周配额的百分比和重置时间。
// 本地 jsonl 只有 token 流水、推不出官方百分比，必须拿 Claude Code 自己的 OAuth token
// （macOS 在 Keychain，其他平台落在 ~/.claude/.credentials.json）查官方 usage 接口。
// 这是本服务唯一的出网请求，只发往 api.anthropic.com——Claude Code 平时也在发同一个请求。
async function claudeOAuthToken() {
  const pick = (raw) => {
    const o = JSON.parse(raw).claudeAiOauth;
    return o && o.accessToken && (!o.expiresAt || o.expiresAt > Date.now()) ? o.accessToken : null;
  };
  if (PLATFORM === 'darwin') {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const t = pick(out);
      if (t) return t;
    } catch { /* 落到凭证文件 */ }
  }
  try { return pick(await fsp.readFile(path.join(HOME, '.claude', '.credentials.json'), 'utf8')); }
  catch { return null; }
}

// 终端启动时 curl 自己会认 http_proxy 等环境变量；但打包 App 从 Finder/Dock 启动没有这些变量，
// curl 直连 api.anthropic.com 会被 403 地域拦截。此时读 macOS 系统代理（Clash 等都会写进去）兜底。
async function curlSysProxyLine() {
  if (['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'].some((k) => process.env[k])) return '';
  if (PLATFORM !== 'darwin') return '';
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('scutil', ['--proxy'], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const grab = (k) => (out.match(new RegExp(`\\b${k} : (\\S+)`)) || [])[1];
    if (grab('HTTPSEnable') === '1') return `proxy = "http://${grab('HTTPSProxy')}:${grab('HTTPSPort')}"\n`;
    if (grab('HTTPEnable') === '1') return `proxy = "http://${grab('HTTPProxy')}:${grab('HTTPPort')}"\n`;
    if (grab('SOCKSEnable') === '1') return `proxy = "socks5h://${grab('SOCKSProxy')}:${grab('SOCKSPort')}"\n`;
  } catch { /* 读不到就直连 */ }
  return '';
}

async function claudeOfficialLimits() {
  const token = await claudeOAuthToken();
  if (!token) return null;
  // 不用 Node https：该接口的防护按 TLS 指纹拦——同样的请求头 curl 能 200、Node 直接 403。
  // 走系统 curl（macOS/Win10+ 自带），顺带继承用户的代理环境变量；
  // token 经 stdin 的 curl 配置传入，不暴露在进程列表里
  const proxyLine = await curlSysProxyLine();
  const body = await new Promise((resolve, reject) => {
    const cp = execFile('curl', ['-sS', '--max-time', '8', '-K', '-', 'https://api.anthropic.com/api/oauth/usage'],
      { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    cp.stdin.end(`${proxyLine}header = "Authorization: Bearer ${token}"\nheader = "anthropic-beta: oauth-2025-04-20"\n`);
  });
  const d = JSON.parse(body);
  const win = (w) => (w && w.utilization != null)
    ? { usedPercent: w.utilization, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : 0 }
    : null;
  const fiveHour = win(d.five_hour), sevenDay = win(d.seven_day);
  return (fiveHour || sevenDay) ? { fiveHour, sevenDay } : null;
}

// ---------- Agent 项目（最近被 coding agent 处理过的项目文件夹）----------
// Claude Code：~/.claude/projects/<munge过的路径>/*.jsonl，目录名不可逆，但行里带 "cwd":"真实路径"
// Codex：~/.codex/sessions/**/rollout-*.jsonl 开头的 session_meta 带 cwd
let agentProjCache = { at: 0, data: null };

async function readCwdFromHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const m = buf.toString('utf8', 0, bytesRead).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } finally { await fh.close(); }
}

async function agentProjects(force = false) {
  if (!force && agentProjCache.data && Date.now() - agentProjCache.at < 60000) return agentProjCache.data;
  const cutoff = Date.now() - 30 * 86400000;
  const map = new Map(); // cwd -> { lastActive, agents: Set }
  const add = (cwd, t, agent) => {
    if (!cwd || cwd === HOME) return; // 在家目录裸跑的会话不算「项目」
    const cur = map.get(cwd) || { lastActive: 0, agents: new Set() };
    cur.lastActive = Math.max(cur.lastActive, t);
    cur.agents.add(agent);
    map.set(cwd, cur);
  };
  // Claude Code：每个项目目录取最新的 jsonl，从文件头抓 cwd
  try {
    const dirs = await fsp.readdir(CLAUDE_PROJ);
    await Promise.all(dirs.map(async (d) => {
      const base = path.join(CLAUDE_PROJ, d);
      let names; try { names = await fsp.readdir(base); } catch { return; }
      let newest = null;
      await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
        try {
          const st = await fsp.stat(path.join(base, n));
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { fp: path.join(base, n), mtimeMs: st.mtimeMs };
        } catch { /* */ }
      }));
      if (!newest || newest.mtimeMs < cutoff) return;
      try { add(await readCwdFromHead(newest.fp, 65536), newest.mtimeMs, 'claude'); } catch { /* */ }
    }));
  } catch { /* 没用过 Claude Code */ }
  // Codex：最近改动的 rollout 文件头部抓 cwd（数量封顶，控制 IO）
  try {
    const files = [];
    const walk = async (dir, depth) => {
      let names;
      try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const fp = path.join(dir, n.name);
        if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
        else if (n.isFile() && n.name.endsWith('.jsonl')) {
          try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, mtimeMs: st.mtimeMs }); } catch { /* */ }
        }
      }
    };
    await walk(CODEX_SESS, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(files.slice(0, 40).map(async (f) => {
      try { add(await readCwdFromHead(f.fp, 16384), f.mtimeMs, 'codex'); } catch { /* */ }
    }));
  } catch { /* 没用过 Codex */ }
  // pi：~/.pi/agent/sessions/<项目目录>/<时间戳>_<uuid>.jsonl，会话头行自带 cwd（同款正则可抓）
  try {
    const files = [];
    const walk = async (dir, depth) => {
      let names;
      try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const n of names) {
        const fp = path.join(dir, n.name);
        if (n.isDirectory() && depth < 2) await walk(fp, depth + 1);
        else if (n.isFile() && n.name.endsWith('.jsonl')) {
          try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, mtimeMs: st.mtimeMs }); } catch { /* */ }
        }
      }
    };
    await walk(PI_SESS, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(files.slice(0, 40).map(async (f) => {
      try { add(await readCwdFromHead(f.fp, 16384), f.mtimeMs, 'pi'); } catch { /* */ }
    }));
  } catch { /* 没用过 pi */ }
  // Hermes Agent：terminal-sessions/tty-* 是「哪个 tty 在哪个目录跑 hermes」的现势记录，单行 JSON 自带 cwd + ts
  try {
    const names = await fsp.readdir(HERMES_TERM);
    await Promise.all(names.map(async (n) => {
      try {
        const fp = path.join(HERMES_TERM, n);
        const st = await fsp.stat(fp);
        if (!st.isFile() || st.mtimeMs < cutoff) return;
        const txt = await fsp.readFile(fp, 'utf8');
        for (const ln of txt.split('\n')) {
          try {
            const j = JSON.parse(ln);
            if (j.cwd) add(j.cwd, Math.max(j.ts ? j.ts * 1000 : 0, st.mtimeMs), 'hermes');
          } catch { /* 半行/空行跳过 */ }
        }
      } catch { /* */ }
    }));
  } catch { /* 没用过 Hermes */ }
  // 按最近活跃排序，已被删除的项目目录剔掉
  const sorted = [...map.entries()].sort((a, b) => b[1].lastActive - a[1].lastActive);
  const projects = [];
  for (const [cwd, info] of sorted) {
    if (projects.length >= 12) break;
    try { if (!(await fsp.stat(cwd)).isDirectory()) continue; } catch { continue; }
    projects.push({ path: cwd, name: path.basename(cwd), agents: [...info.agents], lastActive: info.lastActive });
  }
  const data = { ok: true, projects };
  agentProjCache = { at: Date.now(), data };
  return data;
}

// ---------- Skills 透视（本机 agent skills 的扫描 / 触发统计 / 健康检查 / 启停）----------
// 扫描五类来源：~/.claude/skills、最近 agent 项目的 .claude/skills、Claude 插件、
// ~/.codex/skills、~/.agents/skills。触发统计读两家的会话日志。
// 启停不走 skillOverrides（官方 #50631：用户级配置当前不生效）——用「移入 _disabled/ 子目录」
// 实现：两家 CLI 都只扫一层目录，移进去立即对模型不可见，移回来即恢复，可靠且可逆。
const CLAUDE_SKILLS = path.join(HOME, '.claude', 'skills');
const CODEX_SKILLS = path.join(HOME, '.codex', 'skills');
const AGENTS_SKILLS = path.join(HOME, '.agents', 'skills');
const PI_SKILLS = path.join(HOME, '.pi', 'agent', 'skills');       // pi：~/.pi/agent/skills
const HERMES_SKILLS = path.join(HOME, '.hermes', 'skills');        // Hermes：~/.hermes/skills
const SKILL_DESC_CUT = 1536; // Claude Code 单条 description 的截断线（官方文档）
const SKILL_BUDGET_CHARS = 15000; // 描述总预算的社区实测估算值（窗口的 1%），仅作预警参考
let skillsCache = { at: 0, data: null };

function skillFrontmatter(txt) {
  const m = txt.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1];
  // 不用 m 标志：$ 必须是整段 frontmatter 的末尾，否则块标量（description: >- 换行缩进正文）会被截成空
  const dm = fm.match(/(?:^|\r?\n)description\s*:\s*([\s\S]*?)(?=\r?\n[\w-]+\s*:|\s*$)/);
  let desc = dm ? dm[1].trim() : '';
  desc = desc.replace(/^[|>][+-]?\s*/, '').replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  return { desc };
}

async function scanSkillRoot(root, source, label, out, disabled = false) {
  let names;
  try { names = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const n of names) {
    if (n.name.startsWith('.') || n.name === '_archive' || n.name === '_backups') continue;
    const fp = path.join(root, n.name);
    if (n.name === '_disabled') {
      if (n.isDirectory() && !disabled) await scanSkillRoot(fp, source, label, out, true);
      continue;
    }
    let isDir = n.isDirectory();
    if (!isDir && n.isSymbolicLink()) { // skills.sh 等安装器常用软链，跟随解析
      try { isDir = (await fsp.stat(fp)).isDirectory(); } catch { continue; }
    }
    if (!isDir) {
      if (/\.md$/i.test(n.name)) continue; // 根目录的说明文档不算残留
      out.push({ name: n.name, dir: fp, source, label, disabled, residue: true, desc: '', descLen: 0, mtime: 0,
        issues: ['残留文件——不是有效 skill，只占目录'] });
      continue;
    }
    const item = { name: n.name, dir: fp, source, label, disabled, residue: false, desc: '', descLen: 0, mtime: 0, issues: [] };
    try {
      const sm = path.join(fp, 'SKILL.md');
      const st = await fsp.stat(sm);
      item.mtime = st.mtimeMs;
      const fh = await fsp.open(sm, 'r');
      let head;
      try {
        const buf = Buffer.alloc(Math.min(st.size, 32768));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        head = buf.toString('utf8', 0, bytesRead);
      } finally { await fh.close(); }
      const fm = skillFrontmatter(head);
      if (!fm || !fm.desc) {
        item.issues.push('SKILL.md 缺 frontmatter description——模型的技能清单里看不到它，只能手动调用');
      } else {
        item.desc = fm.desc.slice(0, 240);
        item.descLen = fm.desc.length;
        if (fm.desc.length > SKILL_DESC_CUT) {
          item.issues.push(`description ${fm.desc.length.toLocaleString()} 字符，超过 ${SKILL_DESC_CUT} 截断线——第 ${SKILL_DESC_CUT} 字符之后的触发词模型看不见`);
        }
      }
    } catch {
      item.residue = true;
      item.issues.push('缺 SKILL.md——不是有效 skill');
    }
    out.push(item);
  }
}

// Claude Code 触发统计：jsonl 里的 Skill tool_use（模型自动触发）+ <command-name>（用户手动 /调用）
const claudeSkillStatCache = new Map(); // file -> { offset, events: [{t, skill}] }
async function claudeSkillEvents(cutoff) {
  const files = [];
  let dirs;
  try { dirs = await fsp.readdir(CLAUDE_PROJ); } catch { return []; }
  await Promise.all(dirs.map(async (d) => {
    let names;
    try { names = await fsp.readdir(path.join(CLAUDE_PROJ, d)); } catch { return; }
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
      const fp = path.join(CLAUDE_PROJ, d, n);
      try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, st }); } catch { /* */ }
    }));
  }));
  const live = new Set(files.map((f) => f.fp));
  for (const k of claudeSkillStatCache.keys()) { if (!live.has(k)) claudeSkillStatCache.delete(k); }
  const all = [];
  for (const { fp, st } of files) {
    let c = claudeSkillStatCache.get(fp);
    if (!c) { c = { offset: 0, events: [] }; claudeSkillStatCache.set(fp, c); }
    if (st.size < c.offset) { c.offset = 0; c.events = []; }
    if (st.size > c.offset) {
      try {
        const fh = await fsp.open(fp, 'r');
        let chunk;
        try {
          const buf = Buffer.alloc(st.size - c.offset);
          await fh.read(buf, 0, buf.length, c.offset);
          chunk = buf.toString('utf8');
        } finally { await fh.close(); }
        const lastNL = chunk.lastIndexOf('\n');
        if (lastNL !== -1) {
          c.offset += Buffer.byteLength(chunk.slice(0, lastNL + 1), 'utf8');
          for (const line of chunk.slice(0, lastNL).split('\n')) {
            const isTool = line.includes('"name":"Skill"');
            const isCmd = line.includes('<command-name>');
            if (!isTool && !isCmd) continue;
            const t = Date.parse((line.match(/"timestamp":"([^"]+)"/) || [])[1] || '') || st.mtimeMs;
            if (isTool) {
              let d; try { d = JSON.parse(line); } catch { continue; }
              const content = d && d.message && Array.isArray(d.message.content) ? d.message.content : [];
              for (const it of content) {
                if (it.type === 'tool_use' && it.name === 'Skill' && it.input && it.input.skill) {
                  c.events.push({ t, skill: String(it.input.skill).replace(/^.*:/, '') });
                }
              }
            } else {
              const m = line.match(/<command-name>\s*\/?([\w.:-]+)\s*<\/command-name>/);
              if (m) c.events.push({ t, skill: m[1].replace(/^.*:/, '') });
            }
          }
        }
      } catch { /* 单文件坏不挡整体 */ }
    }
    all.push(...c.events);
  }
  return all.filter((e) => e.t >= cutoff);
}

// Codex 触发统计：rollout 里被激活的 skill 以 "<skill>\n<name>X</name>" 注入——按「会话×skill」去重计数
const codexSkillStatCache = new Map(); // file -> { size, skills: [{t, skill}] }
async function codexSkillEvents(cutoff) {
  const files = [];
  const walk = async (dir, depth) => {
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const fp = path.join(dir, n.name);
      if (n.isDirectory() && depth < 3) await walk(fp, depth + 1);
      else if (n.isFile() && n.name.endsWith('.jsonl')) {
        try { const st = await fsp.stat(fp); if (st.mtimeMs >= cutoff) files.push({ fp, st }); } catch { /* */ }
      }
    }
  };
  await walk(CODEX_SESS, 0);
  const live = new Set(files.map((f) => f.fp));
  for (const k of codexSkillStatCache.keys()) { if (!live.has(k)) codexSkillStatCache.delete(k); }
  const all = [];
  for (const { fp, st } of files) {
    let c = codexSkillStatCache.get(fp);
    if (!c || c.size !== st.size) {
      c = { size: st.size, skills: [] };
      try {
        const txt = await fsp.readFile(fp, 'utf8');
        const seen = new Set();
        const re = /<skill>\\n<name>([\w.:-]+)<\/name>/g;
        let m;
        while ((m = re.exec(txt))) {
          if (seen.has(m[1])) continue;
          seen.add(m[1]);
          c.skills.push({ t: st.mtimeMs, skill: m[1] });
        }
      } catch { /* */ }
      codexSkillStatCache.set(fp, c);
    }
    all.push(...c.skills);
  }
  return all;
}

async function skillsData(opts = {}) {
  const { force = false, extraCwds = [] } = opts;
  if (!force && skillsCache.data && Date.now() - skillsCache.at < 30000) return skillsCache.data;
  const cutoff = Date.now() - 45 * 86400000;
  const items = [];
  await scanSkillRoot(CLAUDE_SKILLS, 'claude', '~/.claude', items);
  await scanSkillRoot(CODEX_SKILLS, 'codex', '~/.codex', items);
  await scanSkillRoot(AGENTS_SKILLS, 'agents', '~/.agents', items);
  await scanSkillRoot(PI_SKILLS, 'pi', '~/.pi', items);
  await scanSkillRoot(HERMES_SKILLS, 'hermes', '~/.hermes', items);
  // Claude 插件自带的 skills
  try {
    const inst = JSON.parse(await fsp.readFile(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, arr] of Object.entries(inst.plugins || {})) {
      for (const p of arr || []) {
        if (p.installPath) await scanSkillRoot(path.join(p.installPath, 'skills'), 'plugin', key.split('@')[0], items);
      }
    }
  } catch { /* 没装插件 */ }
  // 最近 agent 项目的项目级 skills
  const seenCwds = new Set();
  try {
    const pj = await agentProjects(force);
    for (const p of pj.projects || []) {
      seenCwds.add(p.path);
      await scanSkillRoot(path.join(p.path, '.claude', 'skills'), 'project', p.name, items);
    }
  } catch { /* */ }
  // 额外追加扫描当前浏览目录（不在最近12个项目里也能看到）
  for (const cwd of extraCwds) {
    if (!cwd || seenCwds.has(cwd)) continue;
    try {
      if ((await fsp.stat(cwd)).isDirectory()) {
        await scanSkillRoot(path.join(cwd, '.claude', 'skills'), 'project', path.basename(cwd), items);
      }
    } catch { /* */ }
  }

  // 触发统计合并（按 skill 名聚合两端事件）
  const [ce, xe] = await Promise.all([
    claudeSkillEvents(cutoff).catch(() => []),
    codexSkillEvents(cutoff).catch(() => []),
  ]);
  const stats = new Map();
  for (const e of [...ce, ...xe]) {
    const s = stats.get(e.skill) || { hits: 0, last: 0 };
    s.hits++; s.last = Math.max(s.last, e.t);
    stats.set(e.skill, s);
  }
  // 跨来源副本：同名 skill 出现在几处
  const copies = new Map();
  for (const it of items) {
    if (it.residue) continue;
    const arr = copies.get(it.name) || [];
    arr.push(it.label + '/skills' + (it.disabled ? '/_disabled' : ''));
    copies.set(it.name, arr);
  }
  for (const it of items) {
    const st = stats.get(it.name);
    it.hits = st ? st.hits : 0;
    it.last = st ? st.last : 0;
    const cp = copies.get(it.name) || [];
    it.copies = cp.length > 1 ? cp : null;
  }
  // 预算：每个 Claude 会话都常驻的部分（全局 + 插件）；项目级只在对应项目生效，不计入
  let budgetChars = 0;
  for (const it of items) {
    if (!it.disabled && !it.residue && (it.source === 'claude' || it.source === 'plugin')) budgetChars += it.descLen;
  }
  const enabled = items.filter((it) => !it.disabled && !it.residue);
  const data = {
    ok: true, at: Date.now(),
    items,
    roots: { claude: CLAUDE_SKILLS, codex: CODEX_SKILLS, agents: AGENTS_SKILLS, pi: PI_SKILLS, hermes: HERMES_SKILLS },
    overview: {
      total: items.filter((it) => !it.residue).length,
      unique: new Set(items.filter((it) => !it.residue).map((it) => it.name)).size,
      active: enabled.filter((it) => it.hits > 0).length,
      totalHits: enabled.reduce((a, b) => a + b.hits, 0),
      dust: enabled.filter((it) => it.hits === 0).length,
      issues: items.filter((it) => it.issues.length).length,
      budgetChars, budgetLimit: SKILL_BUDGET_CHARS, descCut: SKILL_DESC_CUT,
    },
  };
  skillsCache = { at: Date.now(), data };
  return data;
}

// 启停/卸载的路径校验：只允许动「最近一次扫描出来的 skill 目录」，杜绝任意路径移动/删除
async function validateSkillDir(dir) {
  if (!skillsCache.data) await skillsData();
  const target = path.resolve(String(dir || ''));
  const it = (skillsCache.data.items || []).find((x) => x.dir === target);
  if (!it) return { ok: false, error: '不在已扫描的 skills 清单里' };
  return { ok: true, item: it };
}

async function skillToggle(dir, enable) {
  const v = await validateSkillDir(dir);
  if (!v.ok) return v;
  const it = v.item;
  if (it.residue) return { ok: false, error: '残留文件不能启停，请直接清理' };
  if (!!enable === !it.disabled) return { ok: true, dir: it.dir }; // 已是目标状态
  const root = it.disabled ? path.dirname(path.dirname(it.dir)) : path.dirname(it.dir);
  const dest = enable ? path.join(root, it.name) : path.join(root, '_disabled', it.name);
  try {
    if (!enable) await fsp.mkdir(path.join(root, '_disabled'), { recursive: true });
    await fsp.access(dest).then(() => { throw new Error('目标位置已有同名目录'); }, () => {});
    // skills.sh 等安装器装的是相对路径 symlink（../../.agents/...）——直接 rename 会因层级变化断链，
    // 改为解析出绝对目标后删旧链建新链；真实目录才走 rename
    const lst = await fsp.lstat(it.dir);
    if (lst.isSymbolicLink()) {
      const target = await fsp.realpath(it.dir);
      await fsp.unlink(it.dir);
      await fsp.symlink(target, dest);
    } else {
      await fsp.rename(it.dir, dest);
    }
  } catch (e) { return { ok: false, error: e.message }; }
  skillsCache = { at: 0, data: null };
  return { ok: true, dir: dest };
}

async function skillTrash(dir) {
  const v = await validateSkillDir(dir);
  if (!v.ok) return v;
  const r = await trashPath(v.item.dir);
  if (r.ok) skillsCache = { at: 0, data: null };
  return r;
}

// ---------- 内置 skill 一键安装（设置面板）----------
// 随 app 分发的 skill（skills/<id>/）拷进 ~/.claude/skills/<id>/，终端里的 claude 就学会翻箱的配套玩法。
// asar 包里 fs 照常可读（Electron 补丁过的 fs），开发目录直接跑也一样。
const BUILTIN_SKILLS = ['fanbox-agent'];
function builtinSkillPaths(id) {
  if (!BUILTIN_SKILLS.includes(id)) return null;
  return { src: path.join(__dirname, 'skills', id), dst: path.join(HOME, '.claude', 'skills', id) };
}
async function builtinSkillStatus() {
  const items = [];
  for (const id of BUILTIN_SKILLS) {
    const { src, dst } = builtinSkillPaths(id);
    try {
      const bundled = await fsp.readFile(path.join(src, 'SKILL.md'), 'utf8');
      let installed = false, upToDate = false;
      try { installed = true; upToDate = (await fsp.readFile(path.join(dst, 'SKILL.md'), 'utf8')) === bundled; }
      catch { installed = false; }
      items.push({ id, installed, upToDate });
    } catch { /* 包里没带这个 skill（精简构建）：不展示 */ }
  }
  return { ok: true, skills: items };
}
async function builtinSkillInstall(id) {
  const p = builtinSkillPaths(id);
  if (!p) return { ok: false, error: 'unknown skill' };
  try {
    await fsp.mkdir(p.dst, { recursive: true });
    for (const name of await fsp.readdir(p.src)) { // 单层拷贝够用：skill 目录当前只有 SKILL.md
      const st = await fsp.stat(path.join(p.src, name));
      if (st.isFile()) await fsp.writeFile(path.join(p.dst, name), await fsp.readFile(path.join(p.src, name)));
    }
    skillsCache = { at: 0, data: null }; // skills 面板下次打开能立刻看到
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function agentUsage() {
  if (usageResultCache.data && Date.now() - usageResultCache.at < 30000) return usageResultCache.data;
  const [claude, codex, claudeLimits, pi, hermes] = await Promise.all([
    claudeUsage().catch(() => null),
    codexUsage().catch(() => null),
    claudeOfficialLimits().catch(() => null),
    piUsage().catch(() => null),
    Promise.resolve(hermesUsage()).catch(() => null), // 同步函数，包一层统一 await
  ]);
  const claudeOut = (claude || claudeLimits) ? { ...(claude || {}), official: claudeLimits } : null;
  const data = { ok: true, at: Date.now(), claude: claudeOut, codex, pi, hermes };
  usageResultCache = { at: Date.now(), data };
  return data;
}

// ---------- 路由 ----------

// 只接受指向本机回环地址的 Host。挡住 DNS rebinding：恶意网页把自己的域名重绑定到
// 127.0.0.1 后，浏览器流量打到本机服务、origin 仍是攻击者域名却被当成同源，CORS 失效，
// 进而可调用文件读写 API 读全盘。校验 Host 头是最便宜也最有效的拦截。
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostAllowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(host);
}
// 挡跨站请求伪造（CSRF）：写操作全走 POST，而 text/plain 的 POST 是「简单请求」不触发预检，
// 仅靠 Host 校验拦不住——任意网页都能 fetch 本机 POST 偷偷改文件（响应跨域读不到，但副作用已落地）。
// 浏览器强制带的 Origin 头 JS 改不了：非回环 origin 一律拒。无 Origin（同源 GET / curl /
// Electron 主进程 net.fetch）放行；字面 'null'（sandbox iframe / file://）解析失败即拒。
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return ALLOWED_HOSTS.has(new URL(o).hostname); } catch { return false; }
}

// ---------- 定时任务：cron.json 持久化 + 到点开终端窗口跑 agent/命令 ----------
// 设计：调度器只在 FanBox 跑着时活着（本地工具，不装 launchd 常驻）；app 没开时错过的
// 记一条「错过」绝不补跑——定时任务突然袭击比漏跑一次更吓人。执行复用 Agent 控制接口的
// 开窗能力（global.__fanboxAgent.create），用户在界面上能看到窗口在干活。
const CRON_FILE = path.join(CONFIG_DIR, 'cron.json');
function cronLoad() {
  try { const d = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')); return Array.isArray(d.tasks) ? d.tasks : []; }
  catch { return []; }
}
function cronPersist() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CRON_FILE, JSON.stringify({ tasks: cronTasks }, null, 2)); }
  catch { /* 写失败不致命 */ }
}
let cronTasks = cronLoad();

// 5 字段 cron（分 时 日 月 周，本地时区）。支持 * , - */n；周日 0 或 7 都认
function cronField(spec, min, max) {
  if (spec === '*') return null; // null = 不限
  const set = new Set();
  for (const part of spec.split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return undefined; // 解析失败
    const step = m[3] ? parseInt(m[3], 10) : 1;
    if (!step) return undefined;
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else { lo = parseInt(m[1], 10); hi = m[2] ? parseInt(m[2], 10) : (m[3] ? max : lo); }
    if (lo < min || hi > max + (max === 6 ? 1 : 0) || lo > hi) return undefined; // 周允许 7
    for (let v = lo; v <= hi; v += step) set.add(max === 6 && v === 7 ? 0 : v);
  }
  return set;
}
// 下一次命中时刻（ms）；表达式非法返回 undefined，一年内无命中返回 null
function cronNext(expr, fromMs) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [fMin, fHour, fDom, fMon, fDow] = [
    cronField(parts[0], 0, 59), cronField(parts[1], 0, 23), cronField(parts[2], 1, 31),
    cronField(parts[3], 1, 12), cronField(parts[4], 0, 6),
  ];
  if ([fMin, fHour, fDom, fMon, fDow].some((f) => f === undefined)) return undefined;
  // 经典 cron 语义：日、周都有限时时，任一命中即可
  const dayOk = (d) => {
    const dom = !fDom || fDom.has(d.getDate());
    const dow = !fDow || fDow.has(d.getDay());
    return fDom && fDow ? (dom || dow) : (dom && dow);
  };
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (!fMon || fMon.has(d.getMonth() + 1)) {
      if (dayOk(d)) {
        if ((!fHour || fHour.has(d.getHours())) && (!fMin || fMin.has(d.getMinutes()))) return d.getTime();
      } else { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); i += 1439; continue; } // 整天不匹配就跳天
    } else { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); i += 1439; continue; }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
// 任务的下一次执行时刻；null = 不再执行
function cronNextRun(t, fromMs = Date.now()) {
  const s = t.schedule || {};
  if (s.type === 'at') { const ts = new Date(s.time).getTime(); return !isFinite(ts) || ts <= fromMs ? null : ts; }
  if (s.type === 'every') {
    const step = Math.max(1, Number(s.minutes) || 0) * 60000;
    const base = t.lastFire || t.createdAt || fromMs;
    const n = base + step;
    return n > fromMs ? n : fromMs + step; // 错过的不补，从现在起重新按周期排
  }
  if (s.type === 'cron') { const n = cronNext(s.expr, fromMs); return n === undefined ? null : n; }
  return null;
}
function cronScheduleValid(s) {
  if (!s || typeof s !== 'object') return '缺少时间规则';
  if (s.type === 'at') { const ts = new Date(s.time).getTime(); if (!isFinite(ts)) return '时间点无法解析'; if (ts <= Date.now()) return '时间点已经过去了'; return null; }
  if (s.type === 'every') { const m = Number(s.minutes); if (!isFinite(m) || m < 1) return '周期至少 1 分钟'; return null; }
  if (s.type === 'cron') { return cronNext(s.expr, Date.now()) === undefined ? 'cron 表达式无法解析（需要 5 段：分 时 日 月 周）' : null; }
  return '不认识的时间规则类型';
}
function cronShq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
// 到点敲进新终端的命令。agent 任务默认 acceptEdits（编辑自动同意，跑命令仍确认）；
// full = 用户明确要全自动（无人值守跳过一切确认）
function cronCommand(t) {
  if (t.agent === 'shell') return String(t.prompt || '');
  const p = cronShq(t.prompt || '');
  if (t.agent === 'codex') return t.full ? `codex --full-auto ${p}` : `codex ${p}`;
  return t.full ? `claude --dangerously-skip-permissions ${p}` : `claude --permission-mode acceptEdits ${p}`;
}
async function cronFire(t, manual) {
  t.nextRun = (t.schedule || {}).type === 'at' ? null : cronNextRun(t); // 先排下一次，防调度重入
  const rec = { t: Date.now(), manual: !!manual };
  const A = global.__fanboxAgent;
  if (!A) { rec.ok = false; rec.error = '需要桌面版（浏览器版没有内嵌终端）'; }
  else {
    const r = await A.create({ cwd: t.cwd || HOME, autorun: cronCommand(t) }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    rec.ok = !!(r && r.ok); if (r && r.error) rec.error = r.error; if (r && r.id) rec.term = r.id;
  }
  t.lastFire = rec.t;
  t.history = [rec, ...(t.history || [])].slice(0, 10);
  if ((t.schedule || {}).type === 'at') t.enabled = false; // 一次性任务执行完自动归档
  cronPersist();
  return rec;
}
// 启动结算：错过的记一笔、不补跑；一次性过期的直接停
for (const t of cronTasks) {
  if (t.enabled && t.nextRun && t.nextRun < Date.now() - 60000) {
    t.history = [{ t: t.nextRun, missed: true }, ...(t.history || [])].slice(0, 10);
  }
  t.nextRun = t.enabled ? cronNextRun(t) : null;
  if (t.enabled && (t.schedule || {}).type === 'at' && !t.nextRun) t.enabled = false;
}
cronPersist();
setInterval(() => {
  const now = Date.now();
  for (const t of cronTasks) {
    if (t.enabled && t.nextRun && t.nextRun <= now) cronFire(t, false);
  }
}, 20000);

function cronList() { return { ok: true, desktop: !!global.__fanboxAgent, now: Date.now(), tasks: cronTasks }; }
async function cronAction(action, b = {}) {
  if (action === 'preview') { // 给定时间规则，预告接下来最多 3 次执行
    const err = cronScheduleValid(b.schedule);
    if (err) return { ok: false, error: err };
    const times = [];
    let from = Date.now();
    const fake = { schedule: b.schedule, createdAt: Date.now() };
    for (let i = 0; i < 3; i++) {
      const n = cronNextRun(fake, from);
      if (!n) break;
      times.push(n); from = n; fake.lastFire = n;
    }
    return { ok: true, times };
  }
  if (action === 'save') {
    const err = cronScheduleValid(b.schedule);
    if (err) return { ok: false, error: err };
    if (!String(b.prompt || '').trim()) return { ok: false, error: '任务内容不能为空' };
    const agent = ['claude', 'codex', 'shell'].includes(b.agent) ? b.agent : 'claude';
    const old = b.id && cronTasks.find((x) => x.id === b.id);
    const t = old || { id: 'cr' + crypto.randomBytes(4).toString('hex'), createdAt: Date.now(), history: [] };
    Object.assign(t, {
      name: String(b.name || '').trim() || String(b.prompt).trim().slice(0, 24),
      cwd: String(b.cwd || '').trim() || HOME,
      agent, prompt: String(b.prompt).trim(), full: !!b.full,
      schedule: b.schedule, enabled: b.enabled !== false,
      createdBy: b.createdBy === 'agent' ? 'agent' : (old ? old.createdBy : 'ui'),
    });
    t.nextRun = t.enabled ? cronNextRun(t) : null;
    if (!old) cronTasks.push(t);
    cronPersist();
    return { ok: true, task: t };
  }
  const t = cronTasks.find((x) => x.id === b.id);
  if (!t) return { ok: false, error: 'no such task' };
  if (action === 'delete') { cronTasks = cronTasks.filter((x) => x.id !== b.id); cronPersist(); return { ok: true }; }
  if (action === 'toggle') {
    t.enabled = !!b.enabled;
    t.nextRun = t.enabled ? cronNextRun(t) : null;
    if (t.enabled && (t.schedule || {}).type === 'at' && !t.nextRun) { t.enabled = false; cronPersist(); return { ok: false, error: '时间点已过去，改个时间再启用' }; }
    cronPersist();
    return { ok: true, task: t };
  }
  if (action === 'run') { const rec = await cronFire(t, true); return { ok: !!rec.ok, error: rec.error, term: rec.term, task: t }; }
  return { ok: false, error: 'unknown cron action' };
}

// ---------- 版本历史：解析随包分发的 CHANGELOG.md（Keep a Changelog 格式），侧栏版本号入口用 ----------
let clogCache = null; // { mtime, data }
function changelogData() {
  try {
    const file = path.join(__dirname, 'CHANGELOG.md');
    const mtime = fs.statSync(file).mtimeMs;
    if (clogCache && clogCache.mtime === mtime) return clogCache.data;
    const raw = fs.readFileSync(file, 'utf8');
    const entries = [];
    const re = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/gm;
    let m, prev = null;
    while ((m = re.exec(raw))) {
      if (prev) prev.body = raw.slice(prev.end, m.index).trim();
      prev = { version: m[1], date: m[2] || '', end: re.lastIndex };
      entries.push(prev);
    }
    if (prev) prev.body = raw.slice(prev.end).trim();
    entries.forEach((e) => delete e.end);
    const data = { ok: true, version: require('./package.json').version, entries };
    clogCache = { mtime, data };
    return data;
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

  // ---------- 网页版基础设施（node server.js 直跑才有；桌面版由 electron/main.js 注入 __fanboxAgent）----------
  const WEB_MODE = !process.versions.electron;
  let LAN_MODE = false; // 由 FANBOX_LAN=1 或设置页开关（config lanMode）经 enableLan() 打开
  // LAN 模式强制密码：首次自动生成 12 位随机密码存 ~/.fanbox/webpass（原子写、0600），设置页可改/可显示
  const WEBPASS_FILE = path.join(CONFIG_DIR, 'webpass');
  function loadWebpass() { try { return fs.readFileSync(WEBPASS_FILE, 'utf8').trim(); } catch { return ''; } }
  function saveWebpass(pw) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${WEBPASS_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, pw, { mode: 0o600 });
    fs.renameSync(tmp, WEBPASS_FILE); // 写一半崩溃不留截断文件
  }
  let WEBPASS = loadWebpass();
  if (LAN_MODE && !WEBPASS) { WEBPASS = crypto.randomBytes(9).toString('base64url').slice(0, 12); saveWebpass(WEBPASS); }

  // 会话：HttpOnly + SameSite=Lax cookie，30 天滑动过期；落盘让重启服务不掉登录
  const SESSION_TTL = 30 * 86400e3;
  const SESSION_FILE = path.join(CONFIG_DIR, 'websessions.json');
  const sessions = new Map(); // token -> expires(ms)
  try {
    const d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const [t, e] of Object.entries(d || {})) if (e > Date.now()) sessions.set(t, e);
  } catch { /* 首次没有，正常 */ }
  let sessPersistTimer = null;
  function persistSessions() {
    clearTimeout(sessPersistTimer);
    sessPersistTimer = setTimeout(() => {
      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const o = {};
        for (const [t, e] of sessions) if (e > Date.now()) o[t] = e;
        const tmp = `${SESSION_FILE}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(o));
        fs.renameSync(tmp, SESSION_FILE);
      } catch { /* 存不进就退化为重启掉线 */ }
    }, 500);
  }
  function newWebSession() { const t = crypto.randomBytes(24).toString('base64url'); sessions.set(t, Date.now() + SESSION_TTL); persistSessions(); return t; }
  function sessionTokenOf(req) { const m = (req.headers.cookie || '').match(/(?:^|;\s*)fanbox_session=([A-Za-z0-9_-]+)/); return m ? m[1] : ''; }
  function isLoopbackReq(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
  function webAuthOk(req) {
    if (!LAN_MODE || isLoopbackReq(req)) return true; // 本机免密（现状不变）；LAN 才要票
    const exp = sessions.get(sessionTokenOf(req));
    if (!exp || exp < Date.now()) return false;
    if (exp - Date.now() < SESSION_TTL / 2) { sessions.set(sessionTokenOf(req), Date.now() + SESSION_TTL); persistSessions(); } // 滑动续期
    return true;
  }
  // 暴力破解轻量防护：单 IP 连错 5 次锁 5 分钟 + 失败留痕
  const fails = new Map(); // ip -> { n, until }
  function failLocked(ip) { const f = fails.get(ip); return !!(f && f.until > Date.now()); }
  function recordFail(ip) {
    const f = fails.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; console.warn(`[web] ${ip} 密码连错 5 次，锁定 5 分钟`); }
    fails.set(ip, f);
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.appendFileSync(path.join(CONFIG_DIR, 'webauth.log'), `${new Date().toISOString()} FAIL ${ip}\n`); } catch { /* */ }
  }
  function timingSafeEq(a, b) { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); return ab.length === bb.length && crypto.timingSafeEqual(ab, bb); }
  // Host 白名单扩到本机各网卡 IPv4（手机访问 http://192.168.x.x:PORT）；任意域名仍拒——DNS rebinding 防护保留
  function lanAddresses() {
    const out = [];
    try { for (const list of Object.values(os.networkInterfaces())) for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address); } catch { /* */ }
    return out;
  }
  // 开关 LAN：env FANBOX_LAN=1 或 config lanMode:true（设置页切换，重启生效）。开 = 绑全网卡 + Host 白名单加网卡 IP + 强制密码
  function enableLan() {
    if (LAN_MODE) return;
    LAN_MODE = true;
    for (const ip of lanAddresses()) ALLOWED_HOSTS.add(ip);
    if (!WEBPASS) { WEBPASS = crypto.randomBytes(9).toString('base64url').slice(0, 12); saveWebpass(WEBPASS); }
  }
  if (WEB_MODE && process.env.FANBOX_LAN === '1') enableLan(); // env 开关：启动即生效

  async function lanFromConfig() { // 设置页开关：listen 前读一次 config，重启生效
    if (WEB_MODE && !LAN_MODE) {
      try { const cfg = await readConfig(); if (cfg && cfg.lanMode === true) { enableLan(); console.log('  📡  局域网模式已开启（config.json）'); } } catch { /* */ }
    }
  }

  // 共用核心：pty / 录制 / agent 控制 / 文件监听（桌面 electron/main.js 用同一份 pty-core.js）
  const { createCore } = require('./pty-core');
  let core = null, wss = null, wsClients = 0, lastWsActiveAt = 0;
  const WEB_OPEN = new Set(['/api/web/login', '/api/web/whoami']);
  if (WEB_MODE) {
    let pty = null;
    try { pty = require('node-pty'); } catch (e) { console.error('[fanbox] node-pty 未就绪（跑 npm run rebuild）：', e.message); }
    const { loginShell } = require('./electron/platform');
    wss = new (require('ws').WebSocketServer)({ noServer: true });
    core = createCore({
      pty,
      loginShell,
      PORT,
      AGENT_TOKEN: process.env.FANBOX_AGENT_TOKEN || crypto.randomBytes(24).toString('hex'),
      recDir: () => path.join(CONFIG_DIR, 'records'),
      emit: (channel, payload) => {
        const s = JSON.stringify({ type: channel.replace(':', '-'), ...payload });
        for (const c of wss.clients) if (c.readyState === 1) c.send(s);
      },
      canCreate: () => wsClients > 0,
    });
    global.__fanboxAgent = core.agent;
  }


const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403); res.end('forbidden host'); return; }
  if (req.method === 'POST' && !originAllowed(req)) { res.writeHead(403); res.end('forbidden origin'); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const qp = url.searchParams;
  // 网页版 API 门禁：LAN 模式下非本机请求必须带有效会话（登录/whoami 放行；静态资源开放，由前端盖登录层）
  if (WEB_MODE && p.startsWith('/api/') && !WEB_OPEN.has(p) && !webAuthOk(req)) {
    return sendJSON(res, 401, { ok: false, error: 'unauthorized', authRequired: true });
  }

  try {
    if (p === '/api/roots') {
      return sendJSON(res, 200, { home: HOME, platform: PLATFORM, sep: path.sep, roots: defaultRoots() });
    }
    if (p === '/api/changelog') {
      return sendJSON(res, 200, changelogData());
    }
    // 定时任务（界面用；agent 用带 token 的 /api/agent/cron*，同一套实现）
    if (p === '/api/cron') {
      return sendJSON(res, 200, cronList());
    }
    if (p.startsWith('/api/cron/') && req.method === 'POST') {
      return sendJSON(res, 200, await cronAction(p.slice('/api/cron/'.length), await readBody(req)));
    }
    if (p === '/api/list') {
      return sendJSON(res, 200, await listDir(qp.get('path') || HOME));
    }
    if (p === '/api/read') {
      return sendJSON(res, 200, await readFile(qp.get('path')));
    }
    if (p === '/api/raw') {
      return serveRaw(req, res, qp.get('path'));
    }
    // 路径镜像端点：/fs/<绝对路径> 按真实磁盘路径出文件。
    // HTML 预览的 iframe 指到这里后，页面里的相对引用（./img.png、子目录、嵌套 iframe）
    // 都能按所在目录正确解析——srcdoc 方案没有 base URL，这些全是裂的。
    // 暴露面与 /api/raw 等价（都接受任意绝对路径），且同样只对本机回环开放。
    // HTML 文件额外注入 viewport，让预览框内宽度自适应、滚动稳定。
    if (p.startsWith('/fs/')) {
      const fsPath = decodeURIComponent(p.slice(3));
      const fsExt = (ext(fsPath) || '').toLowerCase();
      if (fsExt === 'html' || fsExt === 'htm') {
        return serveHtmlPreview(req, res, fsPath);
      }
      return serveRaw(req, res, fsPath);
    }
    if (p === '/api/thumb') {
      return serveThumb(req, res, qp.get('path'), parseInt(qp.get('w') || '240', 10));
    }
    if (p === '/api/img-proxy') {
      return proxyImage(res, qp.get('url'));
    }
    if (p === '/api/search') {
      return sendJSON(res, 200, await searchFiles(qp.get('q'), qp.get('root') || HOME));
    }
    if (p === '/api/grep') {
      return sendJSON(res, 200, await grepFiles(qp.get('q'), qp.get('root') || HOME));
    }
    if (p === '/api/content') {
      return sendJSON(res, 200, await contentSearch(qp.get('q'), qp.get('root') || HOME));
    }
    if (p === '/api/recent') {
      return sendJSON(res, 200, await recentFiles(qp.get('root') || HOME));
    }
    if (p === '/api/term-verify' && req.method === 'POST') {
      return sendJSON(res, 200, await termVerify(await readBody(req)));
    }
    if (p === '/api/locate') {
      const extraRoots = String(qp.get('roots') || '').split('\n').filter(Boolean).slice(0, 3);
      return sendJSON(res, 200, await locatePath(qp.get('path'), qp.get('name'), qp.get('root'), qp.get('tail'), qp.get('alt'), extraRoots));
    }
    if (p === '/api/git') {
      return sendJSON(res, 200, await gitStatus(qp.get('path') || HOME));
    }
    if (p === '/api/git-file') {
      const d = await gitFileDiff(qp.get('path'));
      // 不在 git 仓库 → 退回影子快照当基准，「看清改了哪几行」覆盖所有文件夹
      if (!d.isRepo && !d.shadow) {
        const s = await snapFileDiff(resolvePath(qp.get('path'))).catch(() => null);
        if (s) return sendJSON(res, 200, s);
      }
      return sendJSON(res, 200, d);
    }
    if (p === '/api/snapshot' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await snapshot(b.path, b.label));
    }
    if (p === '/api/snapshots') {
      return sendJSON(res, 200, await snapList(qp.get('path')));
    }
    if (p === '/api/snapshot-restore' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await snapRestore(b.path, b.hash));
    }
    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await openInOS(resolvePath(body.path), body.with);
      // 记录最近打开（串行 RMW，不丢更新）
      if (result.ok) {
        await updateConfig((cfg) => { cfg.recentOpened = [body.path, ...(cfg.recentOpened || []).filter((x) => x !== body.path)].slice(0, 30); });
      }
      return sendJSON(res, 200, result);
    }
    if (p === '/api/recent-open' && req.method === 'POST') {
      // 内部预览/编辑也记入「最近打开」，去重 + 最近优先（串行 RMW）
      const body = await readBody(req);
      if (body.path) {
        const cfg = await updateConfig((c) => { c.recentOpened = [body.path, ...(c.recentOpened || []).filter((x) => x !== body.path)].slice(0, 30); });
        return sendJSON(res, 200, { ok: true, recentOpened: cfg.recentOpened });
      }
      return sendJSON(res, 200, { ok: false });
    }
    if (p === '/api/write' && req.method === 'POST') {
      const b = await readBody(req);
      try { return sendJSON(res, 200, await writeTextFile(b.path, b.content, b.expectedMtime)); }
      catch (e) { return sendJSON(res, 200, { ok: false, conflict: !!e.conflict, error: e.message }); }
    }
    if (p === '/api/archive') {
      return sendJSON(res, 200, await archiveList(url.searchParams.get('path')));
    }
    if (p === '/api/du') {
      return sendJSON(res, 200, await diskUsage(url.searchParams.get('path')));
    }
    if (p === '/api/project-memory') {
      return sendJSON(res, 200, await projectMemory(url.searchParams.get('path')));
    }
    if (p === '/api/lang' && req.method === 'POST') {
      const b = await readBody(req);
      const lang = b.lang === 'en' ? 'en' : 'zh';
      await updateConfig((c) => { c.lang = lang; });
      return sendJSON(res, 200, { ok: true, lang });
    }
    if (p === '/api/organize/launch' && req.method === 'POST') {
      return sendJSON(res, 200, await organizeLaunch(await readBody(req)));
    }
    if (p === '/api/release/inspect') {
      return sendJSON(res, 200, await releaseInspect(url.searchParams.get('path')));
    }
    if (p === '/api/release/prepare' && req.method === 'POST') {
      return sendJSON(res, 200, await releasePrepare(await readBody(req)));
    }
    if (p === '/api/trash' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await trashPath(b.path));
    }
    if (p === '/api/move' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await movePath(b.src, b.dstDir));
    }
    if (p === '/api/rename' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await renamePath(b.path, b.newName));
    }
    if (p === '/api/image-save' && req.method === 'POST') {
      const body = await readBody(req);
      try { return sendJSON(res, 200, await saveImage(body)); }
      catch (e) { return sendJSON(res, 200, { error: e.message }); }
    }
    if (p === '/api/create' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await createEntry(b.path, b.name, b.type));
    }
    if (p === '/api/agents') {
      // coding agent 启动按钮（#38）：GET 回配置，POST 存设置面板勾选的 enabledAgents
      // enabled = 面板勾选的内置 agent id；custom = config.json 手写的 agents 数组（同 id 覆盖内置命令，新 id 追加）
      if (req.method === 'POST') {
        const b = await readBody(req);
        const enabled = (Array.isArray(b.enabled) ? b.enabled : [])
          .filter((x) => typeof x === 'string' && /^[\w-]{1,32}$/.test(x)).slice(0, 32);
        await updateConfig((c) => { c.enabledAgents = enabled; });
        return sendJSON(res, 200, { ok: true, enabled });
      }
      const cfg = await readConfig();
      const custom = (Array.isArray(cfg.agents) ? cfg.agents : [])
        .filter((a) => a && typeof a.id === 'string' && a.id && typeof a.cmd === 'string' && a.cmd);
      return sendJSON(res, 200, { enabled: Array.isArray(cfg.enabledAgents) ? cfg.enabledAgents : null, custom });
    }
    if (p === '/api/agents/which') {
      // 装没装探测：bins 走登录 shell command -v；apps 是桌面应用，走 open -Ra
      const out = {};
      const bins = String(url.searchParams.get('bins') || '').split(',')
        .map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._-]{1,64}$/.test(s)).slice(0, 32);
      const apps = String(url.searchParams.get('apps') || '').split(',')
        .map((s) => s.trim()).filter((s) => /^[\w .-]{1,64}$/.test(s)).slice(0, 32);
      await Promise.all([
        ...bins.map(async (b) => { out[b] = !!(await findAgentBin(b)); }),
        // apps：macOS 走 open -Ra；Linux/其它扫 .desktop（freedesktop 标准）
        ...apps.map(async (a) => {
          if (PLATFORM === 'darwin') {
            out[a] = await new Promise((resolve) => {
              execFile('/usr/bin/open', ['-Ra', a], { timeout: 8000 }, (err) => resolve(!err));
            });
          } else {
            out[a] = await desktopAppExists(a);
          }
        }),
      ]);
      return sendJSON(res, 200, out);
    }
    if (p === '/api/agent-projects') {
      return sendJSON(res, 200, await agentProjects());
    }
    if (p === '/api/skills') {
      return sendJSON(res, 200, await skillsData());
    }
    if (p === '/api/skills/builtin') {
      return sendJSON(res, 200, await builtinSkillStatus());
    }
    if (p === '/api/skills/install-builtin' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await builtinSkillInstall(b.id));
    }
    if (p === '/api/skills/refresh' && req.method === 'POST') {
      const b = await readBody(req);
      const extraCwds = b && b.cwd ? [b.cwd] : [];
      return sendJSON(res, 200, await skillsData({ force: true, extraCwds }));
    }
    if (p === '/api/skills/toggle' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await skillToggle(b.dir, !!b.enable));
    }
    if (p === '/api/skills/trash' && req.method === 'POST') {
      const b = await readBody(req);
      return sendJSON(res, 200, await skillTrash(b.dir));
    }
    if (p === '/api/agent-usage') {
      return sendJSON(res, 200, await agentUsage());
    }
    if (p === '/api/favorites') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const cfg = await updateConfig((c) => {
          const has = (c.favorites || []).some((f) => f.path === body.path);
          c.favorites = has
            ? c.favorites.filter((f) => f.path !== body.path)
            : [{ path: body.path, name: body.name, isDir: body.isDir }, ...(c.favorites || [])].slice(0, 50);
        });
        return sendJSON(res, 200, { favorites: cfg.favorites || [], recentOpened: cfg.recentOpened || [] });
      }
      const cfg = await readConfig();
      return sendJSON(res, 200, { favorites: cfg.favorites || [], recentOpened: cfg.recentOpened || [] });
    }

    // ---------- Agent 控制接口：桌面 app 专属（能力由 electron/main.js 注入 global.__fanboxAgent）----------
    // token 只注入翻箱自开终端的环境变量、不落盘：只有跑在翻箱终端里的 agent 拿得到门票。见 docs/12。
    if (p.startsWith('/api/agent/')) {
      const A = global.__fanboxAgent;
      if (!A) return sendJSON(res, 501, { ok: false, error: 'desktop app only' });
      const tok = req.headers['x-fanbox-token'] || qp.get('token') || '';
      if (tok !== A.token) return sendJSON(res, 403, { ok: false, error: 'bad token' });
      // 定时任务：agent 用自然语言理解用户意图后换算成 schedule 调这里（见 skills/fanbox-agent）
      if (p === '/api/agent/cron') return sendJSON(res, 200, cronList());
      if (p.startsWith('/api/agent/cron/') && req.method === 'POST') {
        const b = await readBody(req);
        if (p === '/api/agent/cron/save') b.createdBy = 'agent';
        return sendJSON(res, 200, await cronAction(p.slice('/api/agent/cron/'.length), b));
      }
      if (p === '/api/agent/terminals') return sendJSON(res, 200, await A.list());
      if (p === '/api/agent/read') return sendJSON(res, 200, A.read(qp.get('id'), parseInt(qp.get('lines') || '0', 10)));
      if (p === '/api/agent/send' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, A.send(b.id, b.text, b)); }
      if (p === '/api/agent/create' && req.method === 'POST') { return sendJSON(res, 200, await A.create(await readBody(req))); }
      if (p === '/api/agent/wait' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, await A.wait(b.id, b)); }
      if (p === '/api/agent/kill' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, A.kill(b.id)); }
      return sendJSON(res, 404, { ok: false, error: 'unknown agent endpoint' });
    }

    // ---------- 网页版专属路由（桌面版这些能力走 preload 桥，不进这里）----------
    if (p === '/api/web/whoami') {
      return sendJSON(res, 200, {
        ok: true, lanMode: LAN_MODE,
        addresses: LAN_MODE ? lanAddresses().map((ip) => `http://${ip}:${PORT}`) : [],
        authed: webAuthOk(req), hasPassword: !!WEBPASS,
      });
    }
    if (p === '/api/web/lan' && req.method === 'POST') {
      // 安全设置只许本机改：远端会话即便已认证也不能开关局域网入口
      if (!isLoopbackReq(req)) return sendJSON(res, 403, { ok: false, error: '只能在本机（localhost）更改此设置' });
      const b = await readBody(req);
      const on = !!b.on;
      if (on && !LAN_MODE) enableLan(); // 立即生成密码，用户马上能在设置页看到
      try { await updateConfig((cfg) => { cfg.lanMode = on; }); } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
      return sendJSON(res, 200, { ok: true, lanMode: LAN_MODE, needsRestart: true });
    }
    if (p === '/api/web/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '?';
      if (!WEBPASS) return sendJSON(res, 400, { ok: false, error: '未设置访问密码（非 LAN 模式无需登录）' });
      if (failLocked(ip)) return sendJSON(res, 429, { ok: false, error: '失败次数过多，请 5 分钟后再试' });
      const b = await readBody(req);
      if (!timingSafeEq(b.password || '', WEBPASS)) { recordFail(ip); return sendJSON(res, 403, { ok: false, error: '密码不对' }); }
      fails.delete(ip);
      const token = newWebSession();
      res.setHeader('Set-Cookie', `fanbox_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/web/logout' && req.method === 'POST') {
      const t = sessionTokenOf(req);
      if (t) { sessions.delete(t); persistSessions(); }
      res.setHeader('Set-Cookie', 'fanbox_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/web/password' && req.method === 'GET') return sendJSON(res, 200, { ok: true, password: WEBPASS || '' });
    if (p === '/api/web/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (WEBPASS && !timingSafeEq(b.current || '', WEBPASS)) return sendJSON(res, 403, { ok: false, error: '当前密码不对' });
      const next = String(b.next || '');
      if (next.length < 6) return sendJSON(res, 400, { ok: false, error: '新密码至少 6 位' });
      WEBPASS = next; saveWebpass(next);
      return sendJSON(res, 200, { ok: true });
    }
    if (p.startsWith('/api/web/rec/')) {
      if (!core) return sendJSON(res, 501, { ok: false, error: 'web core 未初始化' });
      if (p === '/api/web/rec/list') return sendJSON(res, 200, core.recList());
      if (p === '/api/web/rec/read') return sendJSON(res, 200, core.recRead(qp.get('p')));
      if (p === '/api/web/rec/remove' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, core.recRemove(b.path)); }
      // 录像字节前端攒成 base64 传来，落盘/转码与桌面版同一份实现
      if (p === '/api/web/rec/save-export' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, core.recSaveExport(b.name, Buffer.from(b.buf || '', 'base64'))); }
      if (p === '/api/web/rec/export' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, 200, await core.recExport({ name: b.name, buf: Buffer.from(b.buf || '', 'base64'), format: b.format })); }
      return sendJSON(res, 404, { ok: false, error: 'unknown rec endpoint' });
    }

    // 静态资源
    return await serveStatic(req, res, p);
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
});

// ---------- 网页版 WebSocket 通道：pty 流 / fs 事件 / agent 控制同一根连接（spec 05）----------
// 帧：客户端 {type:'spawn'|'input'|'resize'|'kill'|'cwd'|'proc'|'watch-set'|'watch'|'term-created', seq?}
//     服务端推送 {type:'pty-data'|'pty-exit'|'fs-changed'|'agent-touch'|'agent-term-create', ...}，
//     带 seq 的请求回一条 {type:'result', seq, r}。桌面版的冒号通道名在这里换成连字符。
if (WEB_MODE) {
  wss.on('connection', (ws) => {
    wsClients++;
    lastWsActiveAt = Date.now();
    ws.on('close', () => { wsClients--; if (wsClients === 0) lastWsActiveAt = Date.now(); });
    ws.on('error', () => { /* 断线由 close 兜住 */ });
    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const { type, seq } = m || {};
      const reply = (r) => { try { if (seq != null && ws.readyState === 1) ws.send(JSON.stringify({ type: 'result', seq, r })); } catch { /* */ } };
      try {
        switch (type) {
          case 'spawn': reply(core.spawn(m)); break;
          case 'input': core.input(m.id, m.data); break;
          case 'resize': core.resize(m.id, m.cols, m.rows); break;
          case 'kill': core.kill(m.id); break;
          case 'cwd': reply(await core.cwd(m.id)); break;
          case 'proc': reply(core.proc(m.id)); break;
          case 'watch-set': reply(core.watchSet(m.dirs)); break;
          case 'watch': reply(core.watch(m.dir)); break;
          case 'term-created': core.onAgentTermCreated(m); break;
          default: if (seq != null) reply({ ok: false, error: 'unknown type ' + type });
        }
      } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    let u; try { u = new URL(req.url, `http://localhost:${PORT}`); } catch { socket.destroy(); return; }
    if (!wss || u.pathname !== '/ws') { socket.destroy(); return; } // 只开 /ws 一条路
    if (!hostAllowed(req)) { socket.destroy(); return; }
    if (req.headers.origin && !originAllowed(req)) { socket.destroy(); return; } // WS 无 CORS，Origin 是防 CSRF 的唯一抓手
    if (!webAuthOk(req)) { socket.destroy(); return; } // LAN 下非本机连接必须带有效会话
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  // 浏览器全断超过 30 分钟：回收全部终端（会话归 server，刷新/重开浏览器可重挂；agent 长跑请保持页面开着）
  setInterval(() => {
    if (wsClients > 0 || !lastWsActiveAt) return;
    if (Date.now() - lastWsActiveAt < 30 * 60e3) return;
    if (!core.terminals.size && ![...core.recorders.keys()].length) { lastWsActiveAt = 0; return; }
    console.log('[web] 浏览器断开超过 30 分钟，回收终端会话');
    core.shutdown();
    lastWsActiveAt = 0;
  }, 60e3).unref();
  // 网页版独占进程：Ctrl+C / kill 时把终端和录制收拾干净再走
  const bye = () => { try { core.shutdown(); } catch { /* */ } process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ⚠️  端口 ${PORT} 已被占用——FanBox 很可能已经在运行了。`);
    console.error(`      直接打开浏览器访问  http://localhost:${PORT}  就行；`);
    console.error(`      想另开一个，换端口：FANBOX_PORT=8080 node server.js\n`);
  } else {
    console.error('\n  启动失败：', err.message, '\n');
  }
  process.exit(1);
});

// 预览专用服务器：只出 /fs/ 静态文件，绝不暴露 /api（删文件/开应用等危险接口）。
// HTML 预览 iframe 指到这个独立端口 + 开 allow-same-origin：页面拿到「自己的」完整源
// （localStorage/fetch 都能跑），却与 App 跨源——碰不到 App 的 DOM、localStorage 和 /api，
// 也无法摘掉 sandbox 反向接管（那要求同源）。可读范围再收紧到主目录、挡掉点目录（.ssh/.aws/.config…），
// 防止恶意预览页 same-origin 下读敏感文件外泄。
const PREVIEW_PORT = PORT + 1;
function previewPathAllowed(file) {
  const real = path.resolve(file);
  const home = path.resolve(HOME);
  if (real !== home && !real.startsWith(home + path.sep)) return false; // 只放行主目录以下
  return !real.slice(home.length).split(path.sep).some((s) => s.startsWith('.')); // 任一段是点目录/点文件 → 拒
}
const previewServer = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403); res.end('forbidden host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }
  const p = new URL(req.url, `http://localhost:${PREVIEW_PORT}`).pathname;
  if (!p.startsWith('/fs/')) { res.writeHead(403); res.end('preview server serves /fs/ only'); return; }
  const raw = decodeURIComponent(p.slice(3));
  let resolved;
  try { resolved = resolvePath(raw); } catch { res.writeHead(400); res.end('bad path'); return; }
  if (!previewPathAllowed(resolved)) { res.writeHead(403); res.end('outside preview scope'); return; }
  try {
    const fsExt = (ext(raw) || '').toLowerCase();
    if (fsExt === 'html' || fsExt === 'htm') return serveHtmlPreview(req, res, raw);
    return serveRaw(req, res, raw);
  } catch (err) { res.writeHead(500); res.end(String((err && err.message) || err)); }
});
previewServer.on('error', (err) => { console.error('  ⚠️  预览服务器启动失败：', err.message); });
previewServer.listen(PREVIEW_PORT, '127.0.0.1', () => { console.log(`  🖼  预览源（隔离）：http://localhost:${PREVIEW_PORT}`); });

(async () => { // listen 前补读设置页的 LAN 开关（config lanMode），绑定地址才算得准
  await lanFromConfig();
  const BIND_HOST = WEB_MODE ? (process.env.FANBOX_HOST || (LAN_MODE ? '0.0.0.0' : '127.0.0.1')) : '127.0.0.1';
  server.listen(PORT, BIND_HOST, () => {
  const link = `http://localhost:${PORT}`;
  console.log('\n  📦  FanBox 已启动');
  console.log(`  🔗  ${link}`);
  console.log('  🏠  根目录:', HOME);
  if (WEB_MODE && LAN_MODE) {
    for (const ip of lanAddresses()) console.log(`  📡  局域网:  http://${ip}:${PORT}`);
    console.log(`  🔑  访问密码: ${WEBPASS ? CONFIG_DIR + '/webpass（设置页可改）' : '（未生成）'}`);
  }
  console.log('\n  按 Ctrl+C 退出\n');
  pruneThumbs().catch(() => {}); // 启动时裁剪缩略图缓存，防止无限增长
  if (!process.env.FANBOX_NO_OPEN) {
    const opener = PLATFORM === 'darwin' ? 'open' : PLATFORM === 'win32' ? 'start' : 'xdg-open';
    exec(`${opener} ${link}`, () => {});
  }
});
})();
