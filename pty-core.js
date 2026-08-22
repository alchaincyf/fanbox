'use strict';
/**
 * FanBox — 终端/录制/文件监听共用核心（桌面 Electron 与网页版同一份底层）
 *
 * pty 生命周期、asciinema v2 黑匣子录制、agent 控制接口、录像管理、文件监听
 * 全部在这里；桌面（electron/main.js，ipcMain 传输）与网页（server.js，WebSocket 传输）
 * 各接一层薄薄的传输适配。传输接缝 = emit(channel, payload)：
 *   桌面 → win.webContents.send(channel, payload)
 *   网页 → WS 广播 { type: channel.replace(':', '-') , ...payload }
 *
 * 生命周期钩子（可选）：桌面接电源守卫（合盖继续干活），网页版不传即可。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let chokidar = null;
try { chokidar = require('chokidar'); } catch { /* 未安装时文件监听降级为不可用 */ }

function createCore(opts) {
  const {
    pty = null,             // node-pty 模块；未编译传 null，终端能力降级但其余功能可用
    loginShell = () => process.env.SHELL || '/bin/sh',
    PORT = 4567,            // 注入 pty 环境变量 FANBOX_CTL 用
    AGENT_TOKEN = '',       // agent 控制接口门票（见 docs/12）
    recDir = () => path.join(os.homedir(), '.fanbox', 'records'),
    emit = () => {},        // (channel, payload) 传输推送
    onSpawn = null,         // (id) 终端起来后（桌面：结算电源守卫）
    onActivity = null,      // (id) 终端有输出时（桌面：1s 去抖尽快结算）
    onExit = null,          // (id) 终端退出后
    canCreate = () => true, // agent 请求开新终端时，前端是否在场可接单
  } = opts;

  const hook = (fn, ...a) => { if (fn) { try { fn(...a); } catch { /* 钩子异常不连累终端通路 */ } } };

  const terminals = new Map();
  const termTails = new Map();   // id -> 最近输出尾巴（去 ANSI），给微信 agent 感知别的终端在跑啥/卡哪
  const termBufs = new Map();    // id -> 去 ANSI 滚动缓冲（~200KB），/api/agent/read 的数据源
  const termLastOut = new Map(); // id -> 最近输出时间戳，wait 的 idle 判定
  const termWaiters = new Map(); // id -> Set<fn(text)>，wait 的增量输出订阅

  // ---------- 终端录制（黑匣子）：把 PTY 字节流旁路成 asciinema v2 .cast ----------
  // 设计铁律：录制器是一根哑管子——只异步旁路字节，全程 try/catch，写失败就静默自废，
  // 绝不把异常抛回 PTY 数据通路。所有「聪明」（压缩/变速/导出）都推迟到回放层做。
  const recorders = new Map(); // id -> { stream, start, path }
  function recEnabled() { return process.env.FANBOX_NO_RECORD !== '1'; }
  // 常开录制不能让磁盘无限涨：保留最近 60 个 / 总量 800MB，超了从最旧删起（正在录的跳过）
  function recPrune() {
    try {
      const dir = recDir();
      if (!fs.existsSync(dir)) return;
      const live = new Set([...recorders.values()].map((r) => r.path));
      const files = fs.readdirSync(dir).filter((n) => n.endsWith('.cast'))
        .map((n) => path.join(dir, n)).filter((f) => !live.has(f))
        .map((f) => { try { return { f, st: fs.statSync(f) }; } catch { return null; } }).filter(Boolean)
        .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs); // 旧→新
      const MAX_FILES = 60, MAX_BYTES = 800 * 1024 * 1024;
      let total = files.reduce((s, x) => s + x.st.size, 0), count = files.length;
      for (const x of files) {
        if (count <= MAX_FILES && total <= MAX_BYTES) break;
        try { fs.rmSync(x.f, { force: true }); total -= x.st.size; count--; } catch { /* */ }
      }
    } catch { /* */ }
  }
  function recStart(id, { cols, rows, cwd, theme }) {
    if (!recEnabled()) return;
    try {
      const dir = recDir();
      fs.mkdirSync(dir, { recursive: true });
      recPrune();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}-${id}.cast`);
      const stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => { try { recorders.delete(id); } catch { /* */ } }); // 盘满/权限等：自废，不连累终端
      const header = {
        version: 2, width: cols || 80, height: rows || 24,
        timestamp: Math.floor(Date.now() / 1000), env: { TERM: 'xterm-256color' },
        // fanbox 私有元信息：回放/列表用，asciinema 标准解析器会忽略未知字段
        fanbox: { cwd: cwd || '', cols: cols || 80, rows: rows || 24, startedAt: Date.now(), theme: theme || '' },
      };
      stream.write(JSON.stringify(header) + '\n');
      recorders.set(id, { stream, start: Date.now(), path: file });
    } catch { /* 录制失败静默自废 */ }
  }
  function recEvent(id, code, data) {
    const r = recorders.get(id);
    if (!r) return;
    try { r.stream.write(JSON.stringify([(Date.now() - r.start) / 1000, code, data]) + '\n'); }
    catch { /* */ }
  }
  function recStop(id) {
    const r = recorders.get(id);
    if (!r) return;
    recorders.delete(id);
    try { r.stream.end(); } catch { /* */ }
  }

  // ---------- 终端生命周期（node-pty）----------
  function spawn({ id, cwd, cols, rows, theme }) {
    if (!pty) return { ok: false, error: 'node-pty 未编译，跑：npm run rebuild' };
    const shellPath = loginShell();
    const startCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    // login shell（-l）：GUI 启动的进程只继承精简 PATH，不读 .zprofile/.zlogin，
    // 用户在那里配的 Homebrew/nvm/npm 全局路径（claude 等）就丢了 → 「普通终端能找到、fanbox 找不到」。
    // 走 login shell 把这些路径带进来。Windows 的 powershell 无此机制，保持空参数。
    const shellArgs = process.platform === 'win32' ? [] : ['-l'];
    // GUI 启动的 app 不继承 shell 的 locale，zsh 会把中文路径按字节转义成 \M-^@ 乱码 → 兜底 UTF-8
    const env = {
      ...process.env, TERM: 'xterm-256color', FANBOX: '1',
      // 终端里的 agent 天生知道自己是几号窗口、控制接口在哪、门票是啥——skill 零配置（见 docs/12）
      FANBOX_TERM_ID: id, FANBOX_CTL: `http://127.0.0.1:${PORT}/api/agent`, FANBOX_CTL_TOKEN: AGENT_TOKEN,
    };
    if (!/UTF-8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) env.LANG = 'zh_CN.UTF-8';
    let p;
    try {
      p = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: startCwd,
        env,
      });
    } catch (err) { return { ok: false, error: err.message }; }
    terminals.set(id, p);
    hook(onSpawn, id); // 开关开着时，第一个终端起来即生效
    recStart(id, { cols, rows, cwd: startCwd, theme });
    p.onData((data) => {
      emit('pty:data', { id, data });
      // 开关开着但还没生效 → 有输出说明可能刚开工，尽快结算电源守卫（桌面在钩子里做 1s 去抖）
      hook(onActivity, id);
      recEvent(id, 'o', data);
      const stripped = data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB0]|\r/g, '');
      termTails.set(id, ((termTails.get(id) || '') + stripped).slice(-4000)); // 留最后 ~4KB，给微信 agent 看「最近输出」
      termBufs.set(id, ((termBufs.get(id) || '') + stripped).slice(-200000)); // 大缓冲给 /api/agent/read
      termLastOut.set(id, Date.now());
      const ws = termWaiters.get(id);
      if (ws) for (const fn of ws) { try { fn(stripped); } catch { /* 单个 waiter 异常不连累别人 */ } }
    });
    p.onExit(({ exitCode }) => {
      terminals.delete(id);
      termTails.delete(id);
      termBufs.delete(id);
      termLastOut.delete(id);
      hook(onExit, id); // 最后一个终端退出即恢复休眠
      recStop(id);
      emit('pty:exit', { id, exitCode });
    });
    return { ok: true, cwd: startCwd };
  }
  function input(id, data) { const p = terminals.get(id); if (p) { p.write(data); recEvent(id, 'i', data); } }
  function resize(id, cols, rows) { const p = terminals.get(id); if (p) { try { p.resize(cols, rows); } catch { /* */ } recEvent(id, 'r', `${cols}x${rows}`); } }
  function kill(id) {
    const p = terminals.get(id);
    if (p) { try { p.kill(); } catch { /* */ } terminals.delete(id); hook(onExit, id); recStop(id); }
  }
  // 取某终端 shell 的真实当前目录，实现「定位到终端目录」
  async function cwd(id) {
    const p = terminals.get(id);
    if (!p || !p.pid) return { ok: false };
    const c = await termCwdByPid(p.pid);
    return c ? { ok: true, cwd: c } : { ok: false };
  }
  // 取终端前台进程名（node-pty 维护）：判断当前是裸 shell 还是正跑着 claude/codex 等程序
  function proc(id) {
    const p = terminals.get(id);
    return p ? { ok: true, proc: p.process || '' } : { ok: false };
  }

  // ---------- Agent 控制接口：把跨终端感知/控制能力开成本机 HTTP（server.js 的 /api/agent/* 调这里）----------
  // 让跑在翻箱终端里的 agent 指挥兄弟窗口：列表/读屏/输入/开窗/等待/关闭。安全模型与接口规范见 docs/12。
  const BARE_SHELL_RE = /^-?(zsh|bash|sh|fish|login)$/i;
  let agentReqSeq = 0;
  const agentCreateWaiters = new Map(); // reqId -> resolve（前端建 tab 的回执）

  function agentTouch(id, action) { // 被 agent 控制的 tab 在界面上闪 ⚡：审计 + 围观
    emit('agent:touch', { id, action });
  }
  async function agentList() {
    const arr = [];
    for (const [id, p] of terminals) {
      const proc = (p && p.process) || '';
      const cwd = await termCwdByPid(p && p.pid);
      arr.push({
        id, cwd, name: cwd ? path.basename(cwd) : '', proc,
        busy: !!proc && !BARE_SHELL_RE.test(proc),
        tail: (termTails.get(id) || '').slice(-500),
      });
    }
    return { ok: true, terminals: arr };
  }
  function agentRead(id, lines) {
    if (!terminals.has(id)) return { ok: false, error: 'no such terminal' };
    const n = Math.max(1, Math.min(2000, lines || 200));
    return { ok: true, id, text: (termBufs.get(id) || '').split('\n').slice(-n).join('\n') };
  }
  function agentSend(id, text, opts = {}) {
    const p = terminals.get(id);
    if (!p) return { ok: false, error: 'no such terminal' };
    let t = String(text == null ? '' : text);
    if (opts.paste) t = '\x1b[200~' + t + '\x1b[201~'; // bracketed paste：多行文本整块进 TUI，不被逐行提交
    else t = t.replace(/\r\n|\n/g, '\r'); // 换行 → 回车才会真正提交
    if (opts.submit !== false && !/\r$/.test(t)) t += '\r';
    try { p.write(t); recEvent(id, 'i', t); agentTouch(id, 'send'); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  function agentCreate(opts = {}) {
    return new Promise((resolve) => {
      if (!canCreate()) return resolve({ ok: false, error: 'no window' });
      const reqId = 'ac' + (++agentReqSeq);
      agentCreateWaiters.set(reqId, resolve);
      emit('agent:term-create', { reqId, cwd: typeof opts.cwd === 'string' ? opts.cwd : '' });
      setTimeout(() => { if (agentCreateWaiters.delete(reqId)) resolve({ ok: false, error: 'renderer timeout' }); }, 10000);
    }).then(async (r) => {
      if (!r.ok) return r;
      agentTouch(r.id, 'create');
      if (!opts.autorun) return r;
      // 等 shell 就绪（有过输出且静默 ≥400ms）再敲命令，login shell 初始化慢也不怕
      const t0 = Date.now();
      await new Promise((done) => {
        const iv = setInterval(() => {
          const last = termLastOut.get(r.id);
          if ((last && Date.now() - last >= 400) || Date.now() - t0 > 8000) { clearInterval(iv); done(); }
        }, 100);
      });
      const s = agentSend(r.id, String(opts.autorun));
      return { ...r, autorun: s.ok };
    });
  }
  function onAgentTermCreated({ reqId, ok, id, error } = {}) {
    const resolve = agentCreateWaiters.get(reqId);
    if (!resolve) return;
    agentCreateWaiters.delete(reqId);
    resolve(ok && id ? { ok: true, id } : { ok: false, error: error || 'create failed' });
  }
  function agentWait(id, opts = {}) {
    return new Promise((resolve) => {
      if (!terminals.has(id)) return resolve({ ok: false, error: 'no such terminal' });
      let re = null;
      if (opts.until) {
        try { re = new RegExp(String(opts.until), 'm'); }
        catch { return resolve({ ok: false, error: 'bad regex' }); }
      }
      const idleMs = Math.max(500, Math.min(30000, Number(opts.idleMs) || 2000));
      const timeoutMs = Math.max(1000, Math.min(240000, Number(opts.timeoutMs) || 60000)); // 240s < node requestTimeout(300s)
      const quietMode = opts.idle === 'quiet'; // quiet：只看输出静默（TUI 回答完）；默认还要求前台回到裸 shell
      const started = Date.now();
      let acc = ''; // 只累计 wait 开始后的新输出，正则也只匹配这段
      let set = termWaiters.get(id);
      if (!set) termWaiters.set(id, set = new Set());
      const finish = (extra) => {
        clearInterval(iv); set.delete(onData);
        resolve({ elapsed: Date.now() - started, output: acc.slice(-8000), ...extra });
      };
      const onData = (s) => { acc = (acc + s).slice(-64000); if (re && re.test(acc)) finish({ ok: true, matched: true }); };
      set.add(onData);
      const iv = setInterval(() => {
        const p = terminals.get(id);
        if (!p) return finish({ ok: true, exited: true });
        if (Date.now() - started >= timeoutMs) return finish({ ok: false, timeout: true });
        if (re) return; // until 模式只认正则
        if (Date.now() - (termLastOut.get(id) || started) < idleMs) return;
        const proc = p.process || '';
        if (quietMode || !proc || BARE_SHELL_RE.test(proc)) finish({ ok: true, idle: true });
      }, 200);
    });
  }
  function agentKill(id) {
    const p = terminals.get(id);
    if (!p) return { ok: false, error: 'no such terminal' };
    try { p.kill(); agentTouch(id, 'kill'); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  const agent = { token: AGENT_TOKEN, list: agentList, read: agentRead, send: agentSend, create: agentCreate, wait: agentWait, kill: agentKill };

  // ---------- 录制文件管理 ----------
  // 列表：读每个 .cast 的头行拿元信息 + 文件大小/时长（末事件时间），按新→旧。失败的文件跳过不报错。
  function recList() {
    try {
      const dir = recDir();
      if (!fs.existsSync(dir)) return { ok: true, items: [] };
      const live = new Set([...recorders.values()].map((r) => r.path));
      const items = [];
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.cast')) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          // 「打开但没干活」的空终端会留下几百字节的壳（提示符+括号粘贴开关），是噪音：
          // 非正在录且体量过小的直接不进列表，省得满屏空录像
          if (st.size < 700 && !live.has(full)) continue;
          const head = readFirstLine(full);
          const meta = head ? JSON.parse(head) : {};
          items.push({
            name, path: full, size: st.size, mtime: st.mtimeMs,
            width: meta.width || 80, height: meta.height || 24,
            cwd: (meta.fanbox && meta.fanbox.cwd) || '',
            startedAt: (meta.fanbox && meta.fanbox.startedAt) || (meta.timestamp ? meta.timestamp * 1000 : st.birthtimeMs),
            duration: readLastEventTime(full, st.size), // 原始时长（末事件时间），列表里给用户选片参考
            recording: live.has(full), // 还在录的会话
          });
        } catch { /* 损坏的文件跳过 */ }
      }
      items.sort((a, b) => b.startedAt - a.startedAt);
      return { ok: true, items };
    } catch (err) { return { ok: false, error: err.message, items: [] }; }
  }
  function recRead(p) {
    try {
      if (!isInRecDir(p)) return { ok: false, error: '非录制目录' };
      return { ok: true, text: fs.readFileSync(p, 'utf8') };
    } catch (err) { return { ok: false, error: err.message }; }
  }
  function recRemove(p) {
    try {
      if (!isInRecDir(p)) return { ok: false, error: '非录制目录' };
      fs.rmSync(p, { force: true });
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  }
  // 把导出好的视频/GIF 字节落进录制目录旁，返回真实路径供「在访达显示」
  function recSaveExport(name, buf) {
    try {
      const dir = path.join(recDir(), 'exports');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'export.webm').replace(/[/\\:]/g, '_');
      const dest = uniqueDest(path.join(dir, safe));
      fs.writeFileSync(dest, Buffer.from(buf));
      return { ok: true, path: dest };
    } catch (err) { return { ok: false, error: err.message }; }
  }
  // 导出：渲染层录出的永远是 WebM；要 MP4/GIF 就用本机 ffmpeg 转一道（检测不到 ffmpeg 优雅退回 WebM）。
  function findFfmpeg() {
    for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
    return null;
  }
  async function recExport({ name, buf, format }) {
    const { execFile } = require('child_process');
    try {
      const dir = path.join(recDir(), 'exports');
      fs.mkdirSync(dir, { recursive: true });
      const base = String(name || 'export').replace(/[/\\:]/g, '_').replace(/\.[a-z0-9]+$/i, '').slice(0, 120);
      const tmp = path.join(dir, '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex') + '.webm');
      fs.writeFileSync(tmp, Buffer.from(buf));
      const saveWebm = (reason) => { const d = uniqueDest(path.join(dir, base + '.webm')); fs.renameSync(tmp, d); return { ok: true, path: d, format: 'webm', fellBack: reason || null }; };
      if (format === 'webm') return saveWebm();
      const ff = findFfmpeg();
      if (!ff) return saveWebm('未检测到 ffmpeg，已存 WebM');
      const run = (args) => new Promise((res, rej) => execFile(ff, args, { timeout: 180000 }, (err, so, se) => (err ? rej(new Error((se || err.message || '').slice(0, 300))) : res())));
      try {
        if (format === 'mp4') {
          const dest = uniqueDest(path.join(dir, base + '.mp4'));
          // 偶数宽高（yuv420p 要求）+ faststart（边下边播）
          await run(['-y', '-i', tmp, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest]);
          fs.rmSync(tmp, { force: true });
          return { ok: true, path: dest, format: 'mp4' };
        }
        if (format === 'gif') {
          const dest = uniqueDest(path.join(dir, base + '.gif'));
          const pal = tmp + '.png';
          // 两遍调色板，GIF 才不糊不抖；宽度封到 900，15fps，体积友好
          await run(['-y', '-i', tmp, '-vf', 'fps=15,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff', pal]);
          await run(['-y', '-i', tmp, '-i', pal, '-lavfi', 'fps=15,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3', dest]);
          fs.rmSync(tmp, { force: true }); fs.rmSync(pal, { force: true });
          return { ok: true, path: dest, format: 'gif' };
        }
      } catch (convErr) { try { return saveWebm('转码失败（' + convErr.message + '），已存 WebM'); } catch { /* */ } }
      return saveWebm();
    } catch (err) { return { ok: false, error: err.message }; }
  }
  // recordings 目录内的路径守卫：read/delete/export 只许碰 自家 recordings 下的文件
  function isInRecDir(p) {
    try { const r = path.resolve(recDir()); return p && path.resolve(p).startsWith(r + path.sep); }
    catch { return false; }
  }
  // 只读文件头一行（.cast 头），不把整个大文件读进内存
  function readFirstLine(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const s = buf.slice(0, n).toString('utf8');
      const nl = s.indexOf('\n');
      return nl >= 0 ? s.slice(0, nl) : s;
    } finally { fs.closeSync(fd); }
  }
  // 读文件尾，取最后一条事件的时间戳 = 原始时长（不把大文件整读进内存）
  function readLastEventTime(file, size) {
    try {
      const len = Math.min(4096, size);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
        const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try { const v = JSON.parse(lines[i]); if (Array.isArray(v) && typeof v[0] === 'number') return v[0]; } catch { /* 末行可能被截断，往前找 */ }
        }
      } finally { fs.closeSync(fd); }
    } catch { /* */ }
    return 0;
  }
  // lsof 在非 UTF-8 locale 下会把中文路径按字节转义成 \xe8 字面量（GUI 启动的 app 不继承 shell 的 locale，
  // 正中这个坑：标签标题乱码、双击定位失效）。调 lsof 时显式给 UTF-8 locale，这里再留一层 \xNN 解码兜底
  function decodeLsofPath(s) {
    if (!/\\x[0-9a-fA-F]{2}/.test(s)) return s;
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
        bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
        i += 3;
      } else {
        for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  // 取某终端 shell 的真实当前目录（用 lsof 查 pty 子进程的 cwd）
  function termCwdByPid(pid) {
    return new Promise((resolve) => {
      if (!pid) return resolve('');
      require('child_process').exec(`lsof -a -p ${pid} -d cwd -Fn`, { env: { ...process.env, LC_ALL: 'en_US.UTF-8' }, timeout: 3000 }, (err, stdout) => {
        if (err) return resolve('');
        const line = (stdout || '').split('\n').find((l) => l.startsWith('n'));
        resolve(line ? decodeLsofPath(line.slice(1)) : '');
      });
    });
  }
  // 同名不覆盖：foo.png 已存在就退而求其次 foo 2.png（仿访达）
  function uniqueDest(dest) {
    if (!fs.existsSync(dest)) return dest;
    const d = path.dirname(dest), ext = path.extname(dest), base = path.basename(dest, ext);
    for (let i = 2; i < 1000; i++) { const c = path.join(d, `${base} ${i}${ext}`); if (!fs.existsSync(c)) return c; }
    return path.join(d, `${Date.now()}-${base}${ext}`);
  }

  // ---------- 文件监听（agent 改文件 → 自动刷新 + 跨项目变更收件箱）----------
  // 多目录监听：浏览目录 + 每个终端会话所在的项目目录。一下午开多个项目跑 agent 时，
  // 不在前台的项目也能感知变更。前端发来期望监听集，这里做增量 diff（关掉多余、补上新增）。
  // 网页版共用这一份（chokidar 跨平台递归）；桌面版从原生 fs.watch 迁来，行为对齐：
  // 保留「新鲜度过滤」——FSEvents 连「文件只是被读了一下」都报，mtime/ctime 都不新鲜 = 内容没动过，丢弃。
  const watchers = new Map(); // dir -> chokidar FSWatcher
  function startWatch(dir) {
    if (!chokidar || watchers.has(dir) || !dir || !fs.existsSync(dir)) return;
    try {
      const w = chokidar.watch(dir, { ignoreInitial: true, persistent: false });
      w.on('all', (evt, fp) => {
        const name = fp ? path.relative(dir, fp) : null;
        if (name) {
          try {
            const st = fs.statSync(fp);
            const now = Date.now();
            if (now - st.mtimeMs > 3000 && now - st.ctimeMs > 3000) return;
          } catch { /* 已删除/无权限：当真变更转发 */ }
        }
        emit('fs:changed', { dir, filename: name });
      });
      watchers.set(dir, w);
    } catch { /* 无权限等，跳过该目录 */ }
  }
  function watchSet(dirs) {
    if (!chokidar) return { ok: false, error: 'chokidar 未安装' };
    const want = new Set((dirs || []).filter(Boolean));
    for (const [dir, w] of watchers) { if (!want.has(dir)) { try { w.close(); } catch { /* */ } watchers.delete(dir); } }
    for (const dir of want) startWatch(dir);
    return { ok: true, count: watchers.size };
  }
  // 兼容旧单目录接口：等价于「只监听这一个目录」
  function watch(dir) {
    if (!chokidar) return { ok: false, error: 'chokidar 未安装' };
    for (const [d, w] of watchers) { if (d !== dir) { try { w.close(); } catch { /* */ } watchers.delete(d); } }
    startWatch(dir);
    return { ok: true };
  }

  // ---------- 收尾：杀掉全部终端 + 刷盘录制 + 关监听（桌面退出钩子 / 网页版信号与回收共用）----------
  function shutdown() {
    for (const [, p] of terminals) { try { p.kill(); } catch { /* */ } }
    terminals.clear();
    termTails.clear(); termBufs.clear(); termLastOut.clear();
    for (const [, set] of termWaiters) { try { set.clear(); } catch { /* */ } }
    termWaiters.clear();
    for (const [, r] of recorders) { try { r.stream.end(); } catch { /* */ } } // 收尾刷盘，别丢最后几行
    recorders.clear();
    for (const [, w] of watchers) { try { w.close(); } catch { /* */ } }
    watchers.clear();
  }

  return {
    terminals, termTails, termBufs, termLastOut, termWaiters, recorders,
    recEnabled, recPrune, recStart, recEvent, recStop,
    spawn, input, resize, kill, cwd, proc,
    agent, onAgentTermCreated,
    recList, recRead, recRemove, recSaveExport, recExport,
    uniqueDest, isInRecDir, readFirstLine, readLastEventTime, decodeLsofPath, termCwdByPid, findFfmpeg,
    watchSet, watch,
    shutdown,
  };
}

module.exports = { createCore };
