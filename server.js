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
const LANG_PACK_DIR = path.join(CONFIG_DIR, 'lang-packs');
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
  if (p.includes('\0')) throw new Error('Invalid path');
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

// ---------- 语言包：导入/列表/读取 ----------
// 自定义语言包持久化在 ~/.fanbox/lang-packs/<id>.json，走与 config.json 相同的「temp + rename」原子写。
const LANG_PACK_ID_RE = /^[a-z0-9-]{1,40}$/;
const LANG_TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_LANG_PACK_SIZE = 1024 * 1024; // 1MB

function validateLangPack(pack) {
  if (!pack || typeof pack !== 'object') return 'Language pack must be a JSON object';
  if (pack.base !== 'en') return 'this pack targets an old FanBox text base — please get a pack updated for the English base (base: "en")';
  if (typeof pack.id !== 'string' || !LANG_PACK_ID_RE.test(pack.id)) return 'id has an invalid format (lowercase letters/digits/- only, 1-40 chars)';
  if (typeof pack.name !== 'string' || !pack.name) return 'name cannot be empty';
  if (typeof pack.lang !== 'string' || !LANG_TAG_RE.test(pack.lang)) return 'lang is not a valid language tag (e.g. zh-TW)';
  if (!pack.dict || typeof pack.dict !== 'object' || Array.isArray(pack.dict)) return 'dict must be a flat object';
  for (const [k, v] of Object.entries(pack.dict)) {
    if (typeof k !== 'string' || !k || typeof v !== 'string' || !v) return 'dict keys and values must all be non-empty strings';
  }
  if (pack.rules !== undefined) {
    if (!Array.isArray(pack.rules)) return 'rules must be an array';
    for (const r of pack.rules) {
      if (!Array.isArray(r) || r.length !== 2 || typeof r[0] !== 'string' || typeof r[1] !== 'string') return 'each item in rules must be [regex string, replacement string]';
      try { new RegExp(r[0]); } catch { return `Invalid regex in rules: ${r[0]}`; }
    }
  }
  if (Buffer.byteLength(JSON.stringify(pack), 'utf8') > MAX_LANG_PACK_SIZE) return 'Language pack is too large (1MB limit)';
  return null;
}

async function writeLangPack(pack) {
  await fsp.mkdir(LANG_PACK_DIR, { recursive: true });
  const file = path.join(LANG_PACK_DIR, `${pack.id}.json`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(JSON.stringify(pack, null, 2)); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
}

async function listLangPacks() {
  const packs = [];
  let entries;
  try { entries = await fsp.readdir(LANG_PACK_DIR); } catch { return packs; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(LANG_PACK_DIR, name), 'utf8');
      const pack = JSON.parse(raw);
      if (pack && typeof pack.id === 'string' && typeof pack.name === 'string' && typeof pack.lang === 'string') {
        packs.push({ id: pack.id, name: pack.name, lang: pack.lang });
      }
    } catch { /* 跳过无法解析的文件 */ }
  }
  return packs;
}

async function readLangPack(id) {
  if (!LANG_PACK_ID_RE.test(id)) return null;
  try {
    const raw = await fsp.readFile(path.join(LANG_PACK_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
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
      info.content = buf.toString('utf8', 0, end) + '\n\n… (file is large, showing first 256KB only)';
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
  if (!TEXT_EXT.has(ext(file))) throw new Error('Only text files can be edited');
  if (typeof content !== 'string') throw new Error('Invalid content');
  // 并发覆盖保护：打开编辑后文件被外部（agent）改过或删除，拒绝盲覆盖
  if (expectedMtime) {
    let cur = 0, missing = false;
    try { cur = (await fsp.stat(file)).mtimeMs; } catch { missing = true; }
    if (missing || (cur && Math.abs(cur - expectedMtime) > 1)) {
      const e = new Error(missing ? 'File was deleted externally' : 'File was modified externally'); e.conflict = true; throw e;
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
    try { target = resolvePath(p); } catch { return resolve({ ok: false, error: 'Invalid path' }); }
    let isDir = false;
    try { isDir = fs.lstatSync(target).isDirectory(); } catch { return resolve({ ok: false, error: 'File does not exist' }); }
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
        msg = 'Allow FanBox to control Finder in System Settings → Privacy & Security → Automation (first deletion will prompt for authorization)';
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
  if (!validName(newName)) throw new Error('Invalid name');
  const dst = path.join(path.dirname(src), newName);
  if (fs.existsSync(dst)) throw new Error('An item with this name already exists');
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
  // GUI 启动的 app 没有用户 shell 的 PATH，走登录 shell 找一次绝对路径
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', `command -v ${name}`], { timeout: 8000 }, (err, stdout) => {
      const out = String(stdout || '').trim().split('\n').pop();
      resolve(!err && out && out.startsWith('/') ? out : null);
    });
  });
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
    else return { ok: false, error: "Couldn't find the claude / codex command — AI organize needs one of these CLIs installed" };
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
  catch { return { ok: false, error: "No package.json here — the release wizard only supports node projects" }; }
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
  if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, error: 'Version format is wrong (expected x.y.z)' };
  const notes = String(b.notes || '').trim();
  // 1) package.json 版本号
  const pkgFile = path.join(dir, 'package.json');
  let pkgRaw;
  try { pkgRaw = await fsp.readFile(pkgFile, 'utf8'); } catch { return { ok: false, error: "Can't read package.json" }; }
  if (!/"version"\s*:\s*"[^"]*"/.test(pkgRaw)) return { ok: false, error: 'package.json has no version field' };
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
  steps.push('git add -A', `git commit -m ${shellQuote(`v${version}: ${title || 'Release'}`)}`);
  if (b.doPush) steps.push('git push');
  if (b.doRelease) steps.push(`gh release create v${version} --title ${shellQuote(`v${version}${title ? ' · ' + title : ''}`)} --notes-file ${shellQuote(notesFile)}${b.doDist ? ` dist/*${version}*.dmg` : ''}`);
  return { ok: true, cmd: steps.join(' && ') };
}

// ---------- 项目记忆：这个文件夹里 AI 干过什么 ----------
// 数据源：~/.claude/projects/<munge(cwd)>/*.jsonl + ~/.codex/sessions/**/rollout-*.jsonl（头部 cwd 匹配）。
// 单会话解析结果按 (size, mtime) 缓存，再次打开只重解析有变化的文件。
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
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return { ok: false, error: 'Read failed: ' + e.message }; }
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
async function archiveList(p) {
  const file = resolvePath(p);
  try { await fsp.stat(file); } catch { return { ok: false, error: 'File does not exist' }; }
  const name = path.basename(file).toLowerCase();
  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  const MAX = 800;
  const entries = [];
  try {
    if (/\.(zip|jar)$/.test(name)) {
      const out = await run('unzip', ['-l', '--', file]);
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
        if (m) entries.push({ name: m[2], size: Number(m[1]) });
        if (entries.length > MAX) break;
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
      return { ok: false, error: '7z / rar have no built-in parser — open with a system archive utility instead' };
    }
  } catch (e) {
    return { ok: false, error: 'Read failed: ' + (e.message || '').split('\n')[0] };
  }
  const truncated = entries.length > MAX;
  return { ok: true, entries: entries.slice(0, MAX), truncated };
}

// 移动文件到目标目录（截图直通车「收进素材」等用）：同卷 rename，跨卷回退拷贝；同名自动加序号防覆盖
async function movePath(src, dstDir) {
  const s = resolvePath(src), d = resolvePath(dstDir);
  if (!fs.existsSync(s)) return { ok: false, error: 'Source file does not exist' };
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
  if (!validName(name)) throw new Error('Invalid name');
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw new Error('An item with this name already exists');
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

// 图片编辑保存：前端 canvas 导出 dataURL（已含格式/尺寸/质量/标注），这里原子写回
async function saveImage({ path: target, dataUrl, newName }) {
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('Invalid image data');
  const buf = Buffer.from(m[1], 'base64');
  let dest = resolvePath(target);
  if (newName) {
    if (!validName(newName)) throw new Error('Invalid file name');
    dest = path.join(path.dirname(dest), newName);
    if (fs.existsSync(dest)) throw new Error('A file with this name already exists');
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
    ['Home', HOME],
    ['Desktop', path.join(HOME, 'Desktop')],
    ['Documents', path.join(HOME, 'Documents')],
    ['Downloads', path.join(HOME, 'Downloads')],
    ['Code', path.join(HOME, 'Code')],
    ['Projects', path.join(HOME, 'Projects')],
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
// 图片走 sips 缩放（快）；视频/PDF/其它走 qlmanage QuickLook 抽帧
async function generateThumb(src, e, size, cacheFile, isImg) {
  await fsp.mkdir(THUMB_DIR, { recursive: true });
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

// 流式返回原始文件（图片 / 视频 / pdf / 音频预览），支持 Range
function serveRaw(req, res, filePath) {
  let file;
  try { file = resolvePath(filePath); } catch { res.writeHead(400); res.end('bad path'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
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
const claudeFileCache = new Map(); // file -> { offset, lastMsgId, events: [{t, in, out, cc, cr}] }
let usageResultCache = { at: 0, data: null };

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

async function agentProjects() {
  if (agentProjCache.data && Date.now() - agentProjCache.at < 60000) return agentProjCache.data;
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
        issues: ['Residue file — not a valid skill, just taking up space in the directory'] });
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
        item.issues.push("SKILL.md is missing frontmatter description — the model can't see it in its skill list, only manual invocation works");
      } else {
        item.desc = fm.desc.slice(0, 240);
        item.descLen = fm.desc.length;
        if (fm.desc.length > SKILL_DESC_CUT) {
          item.issues.push(`description is ${fm.desc.length.toLocaleString()} chars; the model can't see past char ${SKILL_DESC_CUT.toLocaleString()} — trigger words in the tail will never fire`);
        }
      }
    } catch {
      item.residue = true;
      item.issues.push('Missing SKILL.md — not a valid skill');
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

async function skillsData() {
  if (skillsCache.data && Date.now() - skillsCache.at < 30000) return skillsCache.data;
  const cutoff = Date.now() - 45 * 86400000;
  const items = [];
  await scanSkillRoot(CLAUDE_SKILLS, 'claude', '~/.claude', items);
  await scanSkillRoot(CODEX_SKILLS, 'codex', '~/.codex', items);
  await scanSkillRoot(AGENTS_SKILLS, 'agents', '~/.agents', items);
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
  try {
    const pj = await agentProjects();
    for (const p of pj.projects || []) {
      await scanSkillRoot(path.join(p.path, '.claude', 'skills'), 'project', p.name, items);
    }
  } catch { /* */ }

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
    roots: { claude: CLAUDE_SKILLS, codex: CODEX_SKILLS, agents: AGENTS_SKILLS },
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
  if (!it) return { ok: false, error: 'Not in the scanned skills list' };
  return { ok: true, item: it };
}

async function skillToggle(dir, enable) {
  const v = await validateSkillDir(dir);
  if (!v.ok) return v;
  const it = v.item;
  if (it.residue) return { ok: false, error: "Residue files can't be enabled/disabled — clean them up directly" };
  if (!!enable === !it.disabled) return { ok: true, dir: it.dir }; // 已是目标状态
  const root = it.disabled ? path.dirname(path.dirname(it.dir)) : path.dirname(it.dir);
  const dest = enable ? path.join(root, it.name) : path.join(root, '_disabled', it.name);
  try {
    if (!enable) await fsp.mkdir(path.join(root, '_disabled'), { recursive: true });
    await fsp.access(dest).then(() => { throw new Error('A directory with this name already exists at the destination'); }, () => {});
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

async function agentUsage() {
  if (usageResultCache.data && Date.now() - usageResultCache.at < 30000) return usageResultCache.data;
  const [claude, codex, claudeLimits] = await Promise.all([
    claudeUsage().catch(() => null),
    codexUsage().catch(() => null),
    claudeOfficialLimits().catch(() => null),
  ]);
  const claudeOut = (claude || claudeLimits) ? { ...(claude || {}), official: claudeLimits } : null;
  const data = { ok: true, at: Date.now(), claude: claudeOut, codex };
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

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403); res.end('forbidden host'); return; }
  if (req.method === 'POST' && !originAllowed(req)) { res.writeHead(403); res.end('forbidden origin'); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const qp = url.searchParams;

  try {
    if (p === '/api/roots') {
      return sendJSON(res, 200, { home: HOME, platform: PLATFORM, sep: path.sep, roots: defaultRoots() });
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
    if (p.startsWith('/fs/')) {
      return serveRaw(req, res, decodeURIComponent(p.slice(3)));
    }
    if (p === '/api/thumb') {
      return serveThumb(req, res, qp.get('path'), parseInt(qp.get('w') || '240', 10));
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
      return sendJSON(res, 200, await gitFileDiff(qp.get('path')));
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
      const custom = typeof b.lang === 'string' && /^custom:[a-z0-9-]{1,40}$/.test(b.lang) && LANG_PACK_ID_RE.test(b.lang.slice(7));
      const lang = b.lang === 'en' || custom ? b.lang : 'zh';
      await updateConfig((c) => {
        c.lang = lang;
        if (custom && typeof b.langTag === 'string' && LANG_TAG_RE.test(b.langTag)) c.langTag = b.langTag;
        else delete c.langTag;
      });
      return sendJSON(res, 200, { ok: true, lang });
    }
    if (p === '/api/lang-pack/import' && req.method === 'POST') {
      const pack = await readBody(req);
      const err = validateLangPack(pack);
      if (err) return sendJSON(res, 200, { ok: false, error: err });
      try {
        await writeLangPack(pack);
        return sendJSON(res, 200, { ok: true, id: pack.id });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: String(e.message || e) });
      }
    }
    if (p === '/api/lang-packs') {
      return sendJSON(res, 200, { ok: true, packs: await listLangPacks() });
    }
    if (p === '/api/lang-pack') {
      const id = url.searchParams.get('id') || '';
      if (!LANG_PACK_ID_RE.test(id)) return sendJSON(res, 200, { ok: false });
      const pack = await readLangPack(id);
      if (!pack) return sendJSON(res, 200, { ok: false });
      return sendJSON(res, 200, pack);
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
    if (p === '/api/agent-projects') {
      return sendJSON(res, 200, await agentProjects());
    }
    if (p === '/api/skills') {
      return sendJSON(res, 200, await skillsData());
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

    // 静态资源
    return await serveStatic(req, res, p);
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ⚠️  Port ${PORT} is already in use — FanBox is probably already running.`);
    console.error(`      Just open  http://localhost:${PORT}  in your browser;`);
    console.error(`      to start another one, use a different port: FANBOX_PORT=8080 node server.js\n`);
  } else {
    console.error('\n  Failed to start:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log('\n  📦  FanBox is up');
  console.log(`  🔗  ${link}`);
  console.log('  🏠  Root:', HOME);
  console.log('\n  Press Ctrl+C to quit\n');
  pruneThumbs().catch(() => {}); // 启动时裁剪缩略图缓存，防止无限增长
  if (!process.env.FANBOX_NO_OPEN) {
    const opener = PLATFORM === 'darwin' ? 'open' : PLATFORM === 'win32' ? 'start' : 'xdg-open';
    exec(`${opener} ${link}`, () => {});
  }
});
