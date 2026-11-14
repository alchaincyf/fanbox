// 微信 ClawBot 编排层：把「消息来源」和「本机大脑」接起来，彻底不经 openclaw。
//  消息来源两条：① 桌面输入框（本地直连，方便不掏手机也能聊、也方便自测）② iLink 长轮询（手机微信）。
//  大脑：本机 claude / codex 无头实例（driver.js），工作目录 = FanBox 当前打开的项目目录。
//  会话按 conversationId 各自续上下文；全部落盘，重启不丢。
const path = require('path');
const os = require('os');
const fs = require('fs');
const ilink = require('./ilink');
const driver = require('./driver');
const memory = require('./memory');
const ao = require('../../lib/always-on'); // 常驻值守：事件收件箱 / 定时器 / 发件箱三张表和规则

let DATA_DIR = null;
function dataDir() {
  if (DATA_DIR) return DATA_DIR;
  try { DATA_DIR = path.join(require('electron').app.getPath('userData'), 'wechat'); }
  catch { DATA_DIR = path.join(os.homedir(), '.fanbox', 'wechat'); }
  return DATA_DIR;
}
const f = (name) => path.join(dataDir(), name);
const now = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// 微信场景默认人格：claude/codex 桌面端很啰嗦，手机上刷屏难受——注入这条让回复适配手机。可自定义。
const WX_PERSONA_DEFAULT = '你正通过微信被远程遥控，回复会显示在手机微信里。请：用中文、简洁直接、适合手机阅读；先给结论，细节按需再展开；除非用户明确要求，别贴大段代码或长列表；做了改动用一两句话说清改了什么。';

// 上下文预算：单轮被重放的输入 token 超过这条线，回合结束后自动压缩（flush 记忆 + 摘要续场 + 换新 session）。
// claude 默认 200k 窗口，抬到 160k 让 claude 自己多跑、少被我们抢着重置；留 ~20% 垫给当轮输出与压缩自身。
// 常用 1M 版本可调高。配 TAIL_REPLAY_TURNS 的尾部回放，重置时近期对话不再断。
const CTX_BUDGET = 160000;
// 重置后回放给新 session 的「近期原话」轮数：保护在途任务的尾部上下文（借 Hermes「保护尾部」的思路，
// 在 --resume 没法做中段裁剪的约束下，用尾部回放近似）。
const TAIL_REPLAY_TURNS = 5;
// 压缩归档时让 agent 先 flush 记忆、再吐一段结构化进度摘要的指令（不发给用户、只系统用）。
// 摘要覆盖「最容易在压缩里丢」的几类：任务目标 / 关键决策与约束的原话数字 / 已完成 / 下一步 / 涉及文件。
const WX_COMPACT_PROMPT = [
  '（系统指令，不是用户发的，别当成对话）这段对话即将被压缩归档，请只做两件事：',
  '1. 用 <memory> ops 把这段对话里值得长期记住的事实 / 偏好 / 项目进展写进记忆（没有就不写）。',
  '2. 正文只输出一段「当前进度摘要」（≤350 字），让接手的新会话能无缝接着干，按这几点写、缺的跳过：',
  '   · 任务：正在做什么、目标是什么',
  '   · 关键约束与决策：端口/路径/版本/数字等照原话写下来，别改写（这些一压缩最容易丢）',
  '   · 已完成：做到哪了',
  '   · 下一步：紧接着要做什么',
  '   · 涉及文件：关键文件的绝对路径',
  '除此之外什么都别说，别寒暄。',
].join('\n');

// 发文件协议：让 agent 能把本机文件/图片发到微信。在回复末尾追加标记，系统解析后发送、并从展示里剥掉。
const WX_FILE_PROTOCOL = [
  '如果用户要你把某个文件或图片发到微信，在回复的最末尾追加发送标记（每个文件一行，可多个）：',
  '<wxfile>文件的绝对路径</wxfile>',
  '路径用绝对路径（相对路径会按当前工作目录解析）。系统会把这些文件发到微信，所以正文里不要重复贴路径、也不要说“无法发送文件”。只有用户明确要发文件时才加这个标记。',
].join('\n');

// 从回复里抽出 <wxfile> 路径，返回 { clean(剥掉标记的正文), files:[原始路径] }
function extractFiles(reply) {
  const files = [];
  const clean = String(reply || '').replace(/<wxfile>\s*([\s\S]*?)\s*<\/wxfile>/gi, (_, p) => { const s = p.trim(); if (s) files.push(s); return ''; }).trim();
  return { clean, files };
}

// 控制别的终端协议：让 agent 能往本机其他正在运行的终端发指令/按键（fire-and-forget，结果下一轮在状态里体现）。
const WX_TERM_PROTOCOL = [
  '上下文里会给你一份「本机其他终端实时状态」（带 #编号、目录、前台进程、最近输出）。用户可能让你看它们在跑啥、或去操控它们。',
  '要往某个终端输入内容（命令或回答它的提问），在回复末尾追加标记（每个一行，可多个）：',
  '<term n="编号">要输入的文本</term>',
  '注意：要执行命令必须让文本以换行结尾（相当于按回车），例如 <term n="2">npm test\\n</term>；只回车确认就写一个 \\n。只有用户明确要你操控某终端时才用，别擅自发指令。',
].join('\n');

// 终端输入规范化：① 把 agent 按协议写的字面转义（\n \r \t）还原成控制符；
// ② 交互式 TUI（claude/codex 输入框）里「回车提交」是 CR(\r) 不是 LF(\n)——把换行统一成 \r，
//    否则文本只换行、停在输入框里发不出去。
function normTermText(text) {
  return String(text == null ? '' : text)
    .replace(/\\r\\n|\\r|\\n/g, '\n') // 字面 \n / \r 还原为真换行
    .replace(/\\t/g, '\t')           // 字面 \t 还原为制表符
    .replace(/\r\n|\n/g, '\r');      // 换行 → 回车，才会真正提交
}

// 长任务安抚语：超过阈值没动静时随机挑一句发出去，让花叔知道链路还活着、agent 还在干活。
const REASSURE = ['还在弄，稍等一下', '这个有点复杂，正在跑', '处理中，马上好', '正在想，再给我点时间', '还在处理，没断'];
function pickReassure() { return REASSURE[Math.floor(Math.random() * REASSURE.length)]; }

const bridge = {
  win: null,
  target: 'claude',                // 当前大脑：claude / codex（默认 claude——已验证无头 JSON 干净可用）
  persona: WX_PERSONA_DEFAULT,     // 微信 bot 人格（手机场景行为指令），可自定义
  cwd: os.homedir(),               // agent 工作目录（前端 navigate 时推过来）
  conversations: {},               // cid -> { id, label, messages:[{role,text,time}], claudeSession }
  activeCid: 'desktop',            // UI 当前展示的会话
  account: null,                   // iLink 账号 { token, baseUrl, accountId, userId }
  pollAbort: null,
  msgQueue: {},                    // cid -> 待处理入站消息队列（轮询只入队、不阻塞，worker 串行消费）
  draining: {},                    // cid -> 该会话的 worker 是否在跑（同会话不并发，避免跑乱 session）
  avail: null,                     // { codex, claude } CLI 可用性缓存
  expired: false,                  // 已连过但 token 失效（轮询/探活发现）→ 当作未连，需重新扫码
  onConnChange: null,              // 连接态变化回调（主进程用来联动「离开不待机」电源守卫）
  termControl: null,               // 跨终端感知/控制（主进程注入 { list(), send(id,text) }）
  alwaysOn: true,                  // 常驻值守开关（默认开，面板里可关）：关掉后只被动应答
  aoState: ao.empty(),             // 收件箱 / 定时器 / 发件箱（always.json，重启不丢）
  aoTimer: null,
  aoRunPolicy: ao.RUN_POLICY,      // 没人触发的运行的限额：两次至少隔 3 分钟、一天最多 48 次、事件放 6 小时作废
  aoPolicy: ao.DEFAULT_POLICY,     // 发件箱节奏：夜里 23–8 点不发、两条至少隔 10 分钟、一天最多 20 条
  _termRoster: [],                 // 上一轮注入的终端花名册，用来把 <term n=编号> 映回内部 id

  // 连接是否真活着：有账号、有 token、且没被标记失效
  isConnected() { return !!(this.account && this.account.token && !this.expired); },
  fireConnChange() { try { if (this.onConnChange) this.onConnChange(this.isConnected()); } catch { /* */ } },

  init(win) {
    this.win = win;
    const st = ilink.readJson(f('state.json'), {}) || {};
    this.target = st.target || 'claude';
    this.cwd = st.cwd || os.homedir();
    if (typeof st.persona === 'string' && st.persona.trim()) this.persona = st.persona;
    this.conversations = ilink.readJson(f('conversations.json'), {}) || {};
    this.alwaysOn = st.alwaysOn !== false;
    this.aoState = ao.recover(ao.load(f('always.json')), Date.now());
    if (!this.aoTimer) { this.aoTimer = setInterval(() => this.aoTick().catch(() => {}), 30000); if (this.aoTimer.unref) this.aoTimer.unref(); }
    this.account = ilink.readJson(f('account.json'), null);
    driver.warmEnv(); // 启动时预热「终端环境复刻」(抓 PATH/代理)，免得第一条微信消息卡几百毫秒
    if (this.account && this.account.token) { this.startPolling(); this.fireConnChange(); } // 已登录则自动恢复收消息
    this.aoReplay();
  },
  persistState() { ilink.writeJson(f('state.json'), { target: this.target, cwd: this.cwd, persona: this.persona, alwaysOn: this.alwaysOn }); },
  setAlwaysOn(on) { this.alwaysOn = !!on; this.persistState(); return { ok: true, alwaysOn: this.alwaysOn }; },
  setPersona(p) { this.persona = (typeof p === 'string' && p.trim()) ? p : WX_PERSONA_DEFAULT; this.persistState(); return { ok: true, persona: this.persona }; },
  persistConvos() { ilink.writeJson(f('conversations.json'), this.conversations); },
  emit(ch, m) { if (this.win && !this.win.isDestroyed()) this.win.webContents.send(ch, m); },

  conv(cid) {
    if (!this.conversations[cid]) this.conversations[cid] = { id: cid, label: cid === 'desktop' ? '桌面' : cid, messages: [], claudeSession: '', codexSession: '' };
    return this.conversations[cid];
  },
  push(cid, role, text, extra) {
    const c = this.conv(cid);
    const m = { role, text, time: now() };
    if (extra && extra.images && extra.images.length) m.images = extra.images; // 入站图片绝对路径，UI 直接渲染
    if (extra && extra.proactive) m.proactive = true; // 没人问、它主动发的
    c.messages.push(m);
    c.updatedAt = Date.now();        // 最近活跃时间：决定打开面板默认显示哪个会话（落盘随 persistConvos）
    if (c.messages.length > 400) c.messages = c.messages.slice(-400);
    this.persistConvos();
    if (cid === this.activeCid) this.emit('wechat:message', { cid });
  },
  // 最近活跃的会话 id：打开面板默认显示它，而不是写死的 desktop（否则重启/用过桌面框后总先看到旧线）。
  // 老数据没时间戳时偏向手机会话（@im.wechat）——那才是花叔遥控的真进展，桌面框只是本地草稿。
  latestCid() {
    const entries = Object.entries(this.conversations).filter(([, c]) => c && c.messages && c.messages.length);
    if (!entries.length) return 'desktop';
    entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0) || ((a[0] === 'desktop') - (b[0] === 'desktop')));
    return entries[0][0];
  },

  async targets() {
    if (!this.avail) this.avail = { codex: await driver.which('codex'), claude: await driver.which('claude') };
    return [
      { id: 'codex', label: 'Codex', available: this.avail.codex },
      { id: 'claude', label: 'Claude Code', available: this.avail.claude },
    ];
  },
  // 主动探活：打开面板时调，给前端一个权威的连接状态（不只是读「有没有存账号」）
  async check() {
    if (!this.isConnected()) return { ok: true, state: this.account ? 'expired' : 'disconnected' };
    try {
      const r = await ilink.ping(this.account);
      const j = r.json || {};
      if (r.status === 401 || r.status === 403 || j.errcode === -14 || j.ret === -14) {
        this.expired = true; this.fireConnChange(); this.emit('wechat:expired', {});
        return { ok: true, state: 'expired' };
      }
      if (r.ok) { this.expired = false; return { ok: true, state: 'connected' }; }
      return { ok: true, state: 'unreachable' }; // 临时网络问题，别逼用户重扫
    } catch { return { ok: true, state: 'unreachable' }; }
  },
  async env() {
    return {
      ok: true,
      connected: this.isConnected(),
      account: this.account ? this.account.accountId : '',
      target: this.target,
      targets: await this.targets(),
      cwd: this.cwd,
      cwdName: path.basename(this.cwd || '') || '/',
      persona: this.persona,
      personaDefault: WX_PERSONA_DEFAULT,
      alwaysOn: this.alwaysOn,
      always: { watches: (this.aoState.watches || []).filter((w) => w.status === 'active').length, timers: this.aoState.timers.filter((t) => t.status === 'active').length, pendingOut: this.aoState.outbox.filter((m) => m.status === 'pending').length },
    };
  },
  setTarget(t) { if (t === 'codex' || t === 'claude') { this.target = t; this.persistState(); } return { ok: true, target: this.target }; },
  setCwd(dir) { if (dir && typeof dir === 'string') { this.cwd = dir; this.persistState(); } return { ok: true }; },
  conversation(cid) {
    const id = cid || this.latestCid();            // 不指定就取最近活跃会话，别再写死回 desktop
    this.activeCid = id;                            // 同步活跃会话，让后续推送的 emit 门控跟着当前展示的线走
    const c = this.conv(id);
    return { ok: true, id: c.id, messages: c.messages, tokens: c.ctxPeak || c.lastTokens || 0, budget: CTX_BUDGET };
  },

  // 本机其他终端实时状态：花名册（编号/目录/进程/忙闲）+ 最近输出尾巴，注入给 agent 感知
  async buildTermContext() {
    if (!this.termControl) return '';
    let list = [];
    try { list = await this.termControl.list(); } catch { return ''; }
    this._termRoster = list; // 存下来，<term n=编号> 按此映回内部 id
    if (!list.length) return '【本机其他终端】当前没有正在运行的终端。';
    const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(-360);
    const lines = list.map((t, i) => `#${i + 1} ${t.name || '终端'}｜目录:${t.cwd || '?'}｜前台:${t.proc || 'shell'}${t.busy ? '(运行中)' : '(空闲)'}\n  最近输出: ${oneLine(t.tail) || '（无）'}`);
    return '【本机其他终端实时状态】（用户可能让你查看或操控它们）\n' + lines.join('\n');
  },
  // 抽出 <term n=编号>文本</term>，返回 { clean, ops:[{n,text}] }
  extractTermOps(reply) {
    const ops = [];
    const clean = String(reply || '').replace(/<term\s+n=["']?(\d+)["']?\s*>([\s\S]*?)<\/term>/gi, (_, n, txt) => { ops.push({ n: parseInt(n, 10), text: txt }); return ''; }).trim();
    return { clean, ops };
  },
  // 执行 agent 发出的终端操作：按花名册编号映回 id，写进对应 pty。返回一句话回执（附到正文）。
  runTermOps(reply) {
    const { clean, ops } = this.extractTermOps(reply);
    if (!ops.length || !this.termControl) return clean || reply;
    const done = [];
    for (const op of ops) {
      const t = this._termRoster[op.n - 1];
      if (!t) { done.push(`#${op.n}（找不到）`); continue; }
      const r = this.termControl.send(t.id, normTermText(op.text));
      done.push(r && r.ok ? `#${op.n} ${t.name || ''}`.trim() : `#${op.n}（失败）`);
    }
    return (clean || '') + (done.length ? `\n\n⌨️ 已向终端发送：${done.join('、')}` : '');
  },

  // 跑一轮大脑：按 target 选 driver，带上该会话的工作目录与（claude 的）续话 session
  // onProgress：可选，driver 流式跑时把「正在干啥」回调出来，用于微信实时播报
  // opts.auto：没人触发的运行（常驻唤醒）——只读权限，不执行它发出的终端操作
  async runAgent(cid, text, onProgress, opts = {}) {
    const c = this.conv(cid);
    // 压缩后留的「上次进度摘要」：换了新 session，把它播种进去让 agent 无缝接着干，用一次就清
    let recap = '';
    if (c.pendingRecap) { recap = `【上下文已压缩归档，下面是进度摘要 + 最近几轮原话，接着干、别从头开始】\n${c.pendingRecap}`; c.pendingRecap = ''; }
    // 系统提示 = 人格 + 注入记忆 + 记忆协议 + 发文件协议 + 控制终端协议 + 别的终端实时状态 + 续场摘要
    const termCtx = await this.buildTermContext();
    const sys = [this.persona, memory.inject(), memory.PROTOCOL, WX_FILE_PROTOCOL, WX_TERM_PROTOCOL, this.alwaysOn ? ao.TIMER_PROTOCOL : '', this.alwaysOn ? ao.timersNote(this.aoState, Date.now()) : '', termCtx, recap].filter(Boolean).join('\n\n');
    let raw, r;
    if (this.target === 'claude') {
      r = await driver.runClaude(text, this.cwd, c.claudeSession, sys, onProgress, { readOnly: !!opts.auto });
      if (r.sessionId) { c.claudeSession = r.sessionId; }
      raw = r.text;
    } else {
      r = await driver.runCodex(text, this.cwd, sys, c.codexSession, onProgress);
      if (r.sessionId) { c.codexSession = r.sessionId; }
      raw = r.text;
    }
    // 记录上下文用量：driver 拿到 token 就用真值；codex 常拿不到 → 用消息字符数粗估（量级够驱动闸门/进度条）
    let tk = r.tokens || 0;
    if (!tk) { const chars = (c.messages || []).reduce((s, m) => s + (m.text ? m.text.length : 0), 0); tk = Math.round(chars / 3); }
    c.lastTokens = tk;
    c.lastRunError = !!r.isError;
    c.ctxPeak = Math.max(c.ctxPeak || 0, tk); // 进度条用的「上下文水位」：取峰值单调爬升，避免单轮 usage 抖动让条来回跳
    if (r.cost) c.totalCost = (c.totalCost || 0) + r.cost;
    this.logRun(cid, r); // 一行流水：耗时/重试次数/是否超时，排查链路问题时直接 cat
    this.persistConvos();
    // 抽出 <memory> ops 确定性落盘（去污染），把记忆块从展示里剥掉
    // 没人触发的一轮（auto）不许写长期记忆：它读的是终端输出、issue 标题这些别人写的东西，写进记忆就会带进以后每一轮全权限的运行
    const mem = memory.extractOps(raw);
    if (mem.ops.length && !opts.auto) { try { memory.applyOps(mem.ops); } catch (e) { console.error('[wechat] memory apply', e); } }
    // 抽出 <timer> 指令落进定时器表（跟进 / 定期任务 / 取消），标记不显示给用户
    const tm = ao.extractTimers(mem.clean || raw);
    const receipts = []; // 定成了什么、没定成什么，原样告诉用户：不然它嘴上说「好，明早叫你」而表里其实没有
    if (this.alwaysOn && !opts.internal && (tm.sets.length || tm.cancels.length)) {
      const nowMs = Date.now();
      if (!opts.auto) for (const id of tm.cancels) ao.timerCancel(this.aoState, id, nowMs);
      for (const t of (opts.auto ? tm.sets.slice(0, 1) : tm.sets)) {
        const it = ao.timerSet(this.aoState, t, nowMs, { auto: !!opts.auto });
        receipts.push(it ? `⏰ 已定${it.kind === 'schedule' ? '（重复）' : ''}：${it.note.slice(0, 60)}` : `⚠️ 这个定时没定成（时间不对或太密）：${String(t.note || '').slice(0, 40)}`);
      }
      this.aoSave();
    }
    // 抽出 <watch> 指令：盯梢只在用户触发的运行里建（没人触发的一轮不能给自己加定期跑的命令）
    const wt = ao.extractWatches(tm.clean);
    if (this.alwaysOn && !opts.auto && !opts.internal && (wt.sets.length || wt.cancels.length)) {
      const nowMs = Date.now();
      for (const id of wt.cancels) receipts.push(ao.watchCancel(this.aoState, id, nowMs) ? `👀 已停止盯：${id}` : `⚠️ 没找到要停的盯梢：${id}`);
      for (const w of wt.sets) {
        const it = ao.watchSet(this.aoState, w, nowMs);
        // 盯梢是定期在你电脑上跑的命令：建的时候把命令原样亮给你看
        receipts.push(it ? `👀 开始盯「${it.name}」，每 ${Math.round(it.everyMs / 60000)} 分钟跑一次：\n${it.cmd.slice(0, 300)}\n（回「别盯${it.name}了」可停）` : `⚠️ 这条盯梢没建成（缺名字或命令，或已经满 20 条）`);
      }
      this.aoSave();
    }
    const hadTags = mem.ops.length || tm.sets.length || tm.cancels.length || wt.sets.length || wt.cancels.length;
    const clean = wt.clean; // 标记都已剥掉；剥完是空的就是空的，不回落到带标记的原文
    if (opts.auto) return this.extractTermOps(clean).clean; // 只读的一轮：终端操作一律不执行
    if (!clean && hadTags) return [ '好的。', ...receipts ].join('\n');
    if (receipts.length) return this.runTermOps(clean) + '\n\n' + receipts.join('\n');
    // 抽出 <term> ops 写进别的终端（fire-and-forget），把标记从展示里剥掉、附一句回执
    return this.runTermOps(clean || raw);
  },

  // 压缩归档前的静默一轮：在「当前满 session」上让 agent flush 记忆 + 吐一段进度摘要。
  // 走 runAgent 复用 <memory> ops 落盘；返回的正文就是进度摘要（已剥掉记忆块）。失败返回空串，绝不阻塞重置。
  async memoryFlush(cid) {
    try { return (await this.runAgent(cid, WX_COMPACT_PROMPT, null, { internal: true }) || '').trim(); } // 没人在场的内部一轮：不许定时、不许建盯梢
    catch (e) { console.error('[wechat] memoryFlush', e); return ''; }
  },
  // 尾部回放：从展示用的 messages 里取最近几轮用户+助手原话，重置后连同摘要一起播种进新 session，
  // 让在途任务的近期上下文不断（claude/codex 的真上下文在它们进程里、--resume 重置后清空，只能靠回放补）。
  buildTailReplay(c) {
    const turns = (c.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
    const tail = turns.slice(-TAIL_REPLAY_TURNS * 2); // 一轮 ≈ 一问一答
    if (!tail.length) return '';
    const cap = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 500 ? t.slice(0, 500) + '…' : t; };
    const lines = tail.map((m) => `${m.role === 'user' ? '用户' : '你'}：${cap(m.text)}`).filter((l) => l.length > 3);
    if (!lines.length) return '';
    return '【最近几轮原话（接着这个上下文聊，别重复回答上面的内容）】\n' + lines.join('\n');
  },
  // 整理对话（compact）：flush → 换新 session → 用「进度摘要 + 尾部回放」播种下一轮。auto=true 是闸门自动触发。
  async compact(cid, auto) {
    const c = this.conv(cid);
    if (!c.claudeSession && !c.codexSession) return { ok: true, skipped: true }; // 没会话可压
    const tail = this.buildTailReplay(c); // 在 flush 换 session 前就抓好尾部原话（messages 不受 session 影响，但先抓更稳）
    const summary = await this.memoryFlush(cid);
    c.claudeSession = ''; c.codexSession = '';
    c.pendingRecap = [summary, tail].filter(Boolean).join('\n\n'); // 摘要在前给全局、尾部回放在后给细节
    c.lastTokens = 0; c.ctxPeak = 0; // 整理后水位回落
    this.push(cid, 'system', auto ? '🧹 已自动整理上下文（旧对话归档进记忆，近期对话保留，继续聊不受影响）' : '🧹 已整理上下文，旧对话归档进记忆，近期对话保留，可继续聊');
    return { ok: true };
  },
  // 新对话（硬重置）：flush 一次保住记忆 → 清 session 与续场摘要 → 之后纯靠长期记忆续。
  async newConversation(cid) {
    const id = cid || this.activeCid;
    const c = this.conv(id);
    if (c.claudeSession || c.codexSession) { try { await this.memoryFlush(id); } catch { /* 失败也照样开新的 */ } }
    c.claudeSession = ''; c.codexSession = ''; c.pendingRecap = ''; c.lastTokens = 0; c.ctxPeak = 0;
    this.push(id, 'system', '—— 新对话 ——');
    return { ok: true };
  },

  // 桌面输入框 → 本机大脑（不经微信，纯本地）
  async sendDesktop(text) {
    const cid = 'desktop';
    this.activeCid = cid;
    this.push(cid, 'user', text);
    let reply;
    try { reply = await this.runAgent(cid, text); }
    catch (e) { reply = `（出错）${String(e && e.message || e).slice(0, 300)}`; }
    reply = extractFiles(reply).clean || reply; // 桌面无收件人，只剥掉发文件标记，不真发
    this.push(cid, 'assistant', reply);
    await this.autoCompactIfHeavy(cid);
    return { ok: true, messages: this.conv(cid).messages };
  },
  // 上下文过重 → 回合结束后静默压缩（放在回复之后，绝不打断当轮回答）。失败不影响主流程。
  async autoCompactIfHeavy(cid) {
    if ((this.conv(cid).lastTokens || 0) < CTX_BUDGET) return;
    try { await this.compact(cid, true); } catch (e) { console.error('[wechat] autoCompact', e); }
  },

  // ---------- iLink（手机微信）----------
  async login(onErr) {
    try {
      const qr = await ilink.fetchQrcode();
      const content = qr.qrcode_img_content || qr.qrcode || '';
      let dataUrl = '';
      try { dataUrl = await require('qrcode').toDataURL(content, { width: 240, margin: 1 }); } catch { /* 退回原始串 */ }
      this.emit('wechat:qr', { dataUrl, content });
      // 轮询扫码状态
      let base = ilink.LOGIN_BASE, verify = '', tries = 0;
      while (tries++ < 480) {
        const st = await ilink.pollQrStatus(base, qr.qrcode, verify);
        const s = st.status;
        if (s === 'confirmed') {
          this.account = { token: st.bot_token, baseUrl: st.baseurl || base, accountId: st.ilink_bot_id || '', userId: st.ilink_user_id || '' };
          this.expired = false;
          ilink.writeJson(f('account.json'), this.account);
          this.emit('wechat:connected', { ok: true, account: this.account.accountId });
          this.startPolling();
          this.fireConnChange();
          return { ok: true };
        }
        if (s === 'scaned_but_redirect' && st.redirect_host) { base = `https://${st.redirect_host}`; continue; }
        if (s === 'binded_redirect') { // 已绑过，当作成功（需已有 account）
          if (this.account) { this.emit('wechat:connected', { ok: true, account: this.account.accountId }); this.startPolling(); return { ok: true }; }
        }
        if (s === 'expired') { this.emit('wechat:qr', { expired: true }); return { ok: false, error: '二维码过期，请重试' }; }
      }
      return { ok: false, error: '登录超时' };
    } catch (e) { if (onErr) onErr(e); return { ok: false, error: String(e && e.message || e) }; }
  },
  startPolling() {
    if (this.pollAbort) return; // 已在跑
    const ac = new AbortController();
    this.pollAbort = ac;
    (async () => {
      let buf = (ilink.readJson(f('cursor.json'), {}) || {}).buf || '';
      let fails = 0, timeout = 35000;
      while (!ac.signal.aborted && this.account) {
        try {
          const resp = await ilink.getUpdates(this.account, buf, timeout, ac.signal);
          if (resp.longpolling_timeout_ms > 0) timeout = resp.longpolling_timeout_ms;
          if ((resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0)) {
            if (resp.errcode === -14 || resp.ret === -14) { this.expired = true; this.emit('wechat:expired', {}); this.fireConnChange(); break; } // token 失效
            fails++; await sleep(fails >= 3 ? 30000 : 2000); continue;
          }
          fails = 0;
          if (resp.get_updates_buf) { buf = resp.get_updates_buf; ilink.writeJson(f('cursor.json'), { buf }); } // 先推进游标=去重
          // 只入队，绝不在轮询线上 await 跑 agent——否则一个回合（最长 10min）会把整条收消息链路堵死，
          // 期间新消息根本拉不进来。入队后立刻回去继续 getUpdates，agent 由 worker 按会话串行消费。
          for (const msg of resp.msgs || []) this.enqueueMsg(msg);
        } catch (e) {
          if (ac.signal.aborted) break;
          fails++; await sleep(fails >= 3 ? 30000 : 2000);
        }
      }
    })();
  },
  // 入队 + 唤醒 worker：轮询线只调这个，O(1) 返回。按会话（from_user_id）分队，
  // 同会话串行消费（不并发跑乱上下文），不同会话各自的 worker 可并行。
  enqueueMsg(msg) {
    if (!msg || msg.message_type !== 1) return;   // 只处理用户发来的
    const from = msg.from_user_id;
    if (!from) return;
    // 先落进收件箱再处理：FanBox 在回话途中崩了，重启后这条还在（见 aoReplay）。同一条消息重复送达只处理一次
    const key = 'wx:' + (msg.message_id || msg.msg_id || msg.client_id || require('crypto').createHash('sha1').update(JSON.stringify(msg)).digest('hex').slice(0, 16));
    if (!ao.inboxAdd(this.aoState, { kind: 'user_msg', key, payload: { msg } }, Date.now())) return;
    const ev = this.aoState.inbox[this.aoState.inbox.length - 1];
    ev.status = 'running'; ev.attempts = 1;
    if (msg.context_token) (this.aoState.ctx = this.aoState.ctx || {})[from] = msg.context_token; // 主动发消息时要用
    ao.outboxRetryNow(this.aoState); // 拿到新凭据：之前没发出去的可以马上再试
    this.aoSave();
    (this.msgQueue[from] = this.msgQueue[from] || []).push({ ...msg, __inboxId: ev.id });
    this.drainQueue(from);
  },
  // ---------- 常驻值守（lib/always-on.js 的接线）----------
  aoSave() { ao.save(f('always.json'), this.aoState); },
  aoLog(o) { try { fs.appendFileSync(f('always.log'), JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); } catch { /* */ } },
  // 手机那头的会话：主动消息发给它。取最近活跃的微信会话
  ownerCid() {
    const ids = Object.keys(this.conversations).filter((k) => /@im\.wechat$/.test(k));
    return ids.sort((a, b) => (this.conversations[b].updatedAt || 0) - (this.conversations[a].updatedAt || 0))[0] || '';
  },
  // 事件入口：主进程把「窗口等你太久」「断线续不上」这类事送进来。只入箱、立刻返回
  event(kind, key, payload) {
    if (!this.alwaysOn || !this.isConnected() || !this.ownerCid() || this.target !== 'claude') return false; // 只读运行目前只对 Claude Code 验证过，大脑是 Codex 时不值守
    const added = ao.inboxAdd(this.aoState, { kind, key, payload }, Date.now());
    if (added) { this.aoSave(); this.aoKick(); }
    return added;
  },
  // 有待处理的非用户事件 → 往手机会话的队列里放一个唤醒标记。和用户消息共用同一个串行 worker：
  // 同一时间只有一轮在跑，攒下的事件合并成一轮
  aoKick() {
    const cid = this.ownerCid();
    if (!cid || !this.alwaysOn || this.target !== 'claude') return;
    const gate = ao.autoGate(this.aoState, Date.now(), this.aoRunPolicy); // 太近、今天跑满了都先不跑，事件留着；放了 6 小时的作废
    if (!ao.inboxPending(this.aoState, (e) => e.kind !== 'user_msg').length) return;
    if (gate) { if (this._aoGate !== gate) { this._aoGate = gate; this.aoLog({ run: 'held', why: gate }); } return; }
    this._aoGate = '';
    const q = (this.msgQueue[cid] = this.msgQueue[cid] || []);
    if (!q.some((m) => m && m.__auto)) q.push({ __auto: true });
    this.drainQueue(cid);
  },
  // 调度器 + 派发器，30 秒一轮：到期的定时器变成事件；有事件就唤醒；发件箱里能发的发一条
  async aoTick() {
    if (!this.alwaysOn) return;
    const now = Date.now();
    if (now - (this._aoPruneAt || 0) > 3600e3) { this._aoPruneAt = now; ao.prune(this.aoState, now); this.aoSave(); }
    if (ao.timersFire(this.aoState, now)) this.aoSave();
    await this.aoWatch(now);
    if (this.isConnected()) { this.aoKick(); await this.aoDispatch(); }
  },
  // 盯梢：到点的命令各跑一遍（登录 shell 环境，和用户终端一致；60 秒封顶），输出交给 watchIngest 找新行
  async aoWatch(now) {
    if (this._aoWatching) return;
    this._aoWatching = true;
    try {
      for (const w of ao.watchesDue(this.aoState, now)) {
        let r;
        try { r = await driver.run(w.cmd, '', this.cwd, { idleMs: 30000, maxMs: 60000 }); } catch (e) { r = { ok: false, out: '', err: String(e && e.message || e) }; }
        const n = ao.watchIngest(this.aoState, w.id, r.ok ? r.out : (r.err || r.out), Date.now(), !!r.ok);
        this.aoSave();
        this.aoLog({ watch: w.name, ok: !!r.ok, fresh: n });
      }
    } finally { this._aoWatching = false; }
  },
  // 没人触发的一轮：把攒下的事件一次交给 agent（只读），它决定发不发
  async onAuto(cid) {
    const events = ao.inboxTake(this.aoState, (e) => e.kind !== 'user_msg');
    if (!events.length) return;
    ao.autoRan(this.aoState, Date.now());
    this.aoSave();
    const ids = events.map((e) => e.id), t0 = Date.now();
    let reply = '', ok = true;
    try { reply = await this.runAgent(cid, ao.autoPrompt(events, ao.recentSent(this.aoState), t0), null, { auto: true }); }
    catch (e) { ok = false; reply = ''; this.aoLog({ run: 'auto', error: String(e && e.message || e).slice(0, 200), events: events.map((e2) => e2.kind) }); }
    if (ok && (this.conv(cid).lastRunError || ao.isBrainError(reply))) ok = false; // 大脑没跑成（超时、额度、要登录、空结果）：事件放回去下次再试，别把报错发给人
    const silent = !ok || ao.isSilent(extractFiles(reply).clean);
    if (ok && !silent) ao.outboxAdd(this.aoState, extractFiles(reply).clean.replace(/<silent\s*\/?>/gi, '').trim(), Date.now(), { from: events.map((e) => e.kind).join(',') });
    ao.inboxDone(this.aoState, ids, Date.now(), ok);
    this.aoSave();
    this.aoLog({ run: 'auto', ok, events: events.map((e) => ({ kind: e.kind, key: e.key })), silent, ms: Date.now() - t0, say: silent ? '' : reply.slice(0, 200) });
    await this.aoDispatch();
  },
  // 派发器：按节奏规则放行一条，发到手机。微信要求带上最近一次收到消息时的 context_token
  async aoDispatch() {
    const cid = this.ownerCid();
    if (!cid || !this.isConnected() || this._aoSending) return; // 一次只发一条：调度器和运行收尾可能同时来叫
    this._aoSending = true;
    try { await this.aoDispatchOne(cid); } finally { this._aoSending = false; }
  },
  async aoDispatchOne(cid) {
    const now = Date.now();
    const { msg, hold } = ao.outboxNext(this.aoState, now, this.aoPolicy);
    if (!msg) { if (hold && hold !== 'empty' && this._aoHold !== hold) { this._aoHold = hold; this.aoLog({ outbox: 'hold', why: hold }); } return; }
    this._aoHold = '';
    const ctx = (this.aoState.ctx || {})[cid] || '';
    let sent = false, err = '';
    try { const r = await ilink.sendText(this.account, cid, msg.text, ctx); sent = !!(r && r.ok && !(r.json && ((r.json.ret && r.json.ret !== 0) || (r.json.errcode && r.json.errcode !== 0)))); if (!sent) err = JSON.stringify(r && r.json || {}).slice(0, 160); }
    catch (e) { err = String(e && e.message || e).slice(0, 160); }
    ao.outboxMark(this.aoState, msg.id, Date.now(), sent);
    this.aoSave();
    this.aoLog({ outbox: sent ? 'sent' : 'send_failed', id: msg.id, err, text: msg.text.slice(0, 120) });
    if (sent) this.push(cid, 'assistant', msg.text, { proactive: true });
  },
  // 启动时：上次崩在半路、还没回的用户消息（半小时内的）重新排队；别的待处理事件照常唤醒
  aoReplay() {
    const now = Date.now();
    for (const e of ao.inboxPending(this.aoState, (x) => x.kind === 'user_msg')) {
      if (now - e.at > 30 * 60000 || !e.payload || !e.payload.msg) { ao.inboxDone(this.aoState, [e.id], now, true); continue; }
      if (e.attempts >= 2) { ao.inboxDone(this.aoState, [e.id], now, true); continue; } // 补过一次还是没回成：不再补，免得一条坏消息每次重启都重放
      e.attempts++;
      const m = e.payload.msg, from = m.from_user_id;
      (this.msgQueue[from] = this.msgQueue[from] || []).push({ ...m, __inboxId: e.id, __replay: true });
      this.drainQueue(from);
    }
    this.aoSave();
  },

  async drainQueue(from) {
    if (this.draining[from]) return;              // 该会话已有 worker 在跑
    this.draining[from] = true;
    try {
      while (this.msgQueue[from] && this.msgQueue[from].length) {
        const msg = this.msgQueue[from].shift();
        try { if (msg.__auto) await this.onAuto(from); else await this.onWechatMsg(msg); }
        catch (e) { console.error('[wechat] onWechatMsg', e); }
        if (msg.__inboxId) { ao.inboxDone(this.aoState, [msg.__inboxId], Date.now(), true); this.aoSave(); }
      }
    } finally { this.draining[from] = false; }
  },
  // 入站媒体原始 JSON 落盘：用来确认图片/文件消息的字段结构，好实现 downloadMedia 真读取。
  logInbound(msg) {
    try { fs.appendFileSync(f('inbound-media.log'), JSON.stringify(msg) + '\n'); } catch { /* */ }
  },
  // 每轮大脑的耗时流水：定位卡顿/超时是网络还是别的，不用再事后取证。
  logRun(cid, r) {
    try {
      const sec = ((r.ms || 0) / 1000).toFixed(1);
      const tag = r.timedOut ? 'TIMEOUT' : 'ok';
      const line = `${new Date().toISOString()}\t${this.target}\t${cid}\t${sec}s\t重试${r.attempts || 1}\t${tag}\ttokens=${r.tokens || 0}`;
      fs.appendFileSync(f('runs.log'), line + '\n');
    } catch { /* */ }
  },

  // 生命体征控制器：在 agent 跑的整段时间里维持「链路活着」的感知，回收时一次性收尾。
  //  ① typing 心跳：微信「正在输入」气泡几秒就消失，每 4s 续一次让它一直亮着。
  //  ② 进度播报：driver 流式回调的「正在看 X」节流后发出去（≥15s 才发一条，不刷屏）。
  //  ③ 安抚兜底：超过 22s 没有任何真消息（纯思考、没工具调用），随机发一句安抚。
  //  真消息（进度/安抚/最终回复）才是微信平台「判活」的依据——只靠 typing 仍会被判「连接不到」。
  startLiveness(from, ctxToken) {
    let lastBeat = Date.now();
    let alive = true;
    const beat = (textMsg) => {
      if (!alive || !textMsg) return;
      lastBeat = Date.now();
      ilink.sendText(this.account, from, textMsg, ctxToken).catch(() => {});
      this.push(from, 'assistant', textMsg);
    };
    ilink.sendTyping(this.account, from, true);
    const typingTimer = setInterval(() => { if (alive) ilink.sendTyping(this.account, from, true); }, 4000);
    // 安抚消息已停用（花叔决定）：「对方正在输入」气泡已足够表达链路活着，安抚文字是噪音。
    // 备查：如需恢复，放开下一行（曾每 22s 刷一次太密集，改成 2 分钟才发一次），并在 stop() 里 clearTimeout(reassureTimer)。
    // const reassureTimer = setTimeout(() => { if (alive) beat(pickReassure()); }, 120000);
    return {
      onProgress: (note) => { if (alive && note && Date.now() - lastBeat > 15000) beat('⏳ ' + note); },
      stop: () => { alive = false; clearInterval(typingTimer); ilink.sendTyping(this.account, from, false); },
    };
  },

  async onWechatMsg(msg) {
    if (msg.message_type !== 1) return;           // 只处理用户发来的
    const from = msg.from_user_id;
    if (!from) return;
    const { text, medias } = ilink.contentFromMsg(msg);
    if (!text && !medias.length) return;          // 真空消息才丢
    this.activeCid = from;
    // 媒体先下载解密落盘到收件箱：拿到绝对路径，既喂给 agent Read，也回填给气泡让 UI 真显示图片。
    // 失败的留个原始 JSON 样本好排查。
    let mediaNote = '';
    const imgPaths = [];        // 下载成功的图片，气泡直接渲染（不再只显示「（图片）」）
    const placeholders = [];    // 没图可渲染的（文件附件 / 下载失败）才退回文字占位
    if (medias.length) {
      const ok = [], bad = [];
      for (const m of medias) {
        try {
          const fp = await ilink.downloadMedia(m.item, f('inbox'));
          ok.push(fp);
          if (m.kind === 'image') imgPaths.push(fp); else placeholders.push(`（${m.name}）`);
        } catch (e) {
          bad.push(`${m.name}（${String(e && e.message || e).slice(0, 80)}）`);
          placeholders.push(`（${m.kind === 'image' ? '图片' : '文件'}）`);
          this.logInbound(msg);
        }
      }
      const okLine = ok.length ? `用户通过微信发来${ok.length}个文件，已存到本机，请用 Read 工具直接读取来理解内容、再回应他：\n${ok.map((p) => `- ${p}`).join('\n')}` : '';
      const badLine = bad.length ? `另有没下下来的：${bad.join('、')}。如实告诉用户这几个没收到。` : '';
      mediaNote = `\n\n[${[okLine, badLine].filter(Boolean).join('\n')}]`;
    }
    // 气泡文字：有用户文字就用文字；没文字时退回占位（仅文件/失败图）；纯图无文字则留空，图自己就是内容
    this.push(from, 'user', text || placeholders.join(''), imgPaths.length ? { images: imgPaths } : null);
    const live = this.startLiveness(from, msg.context_token);
    let reply;
    // 崩溃后补回的消息：上次可能已经做到一半，先让它核对，别把有副作用的事再做一遍
    const replayNote = msg.__replay ? '\n\n[系统说明：这条消息是 FanBox 意外退出前收到的，当时可能已经处理到一半。先确认哪些已经做过，没做的再做，不要重复执行。]' : '';
    try { reply = await this.runAgent(from, (text || '（无文字说明）') + mediaNote + replayNote, live.onProgress); }
    catch (e) { reply = `（出错）${String(e && e.message || e).slice(0, 300)}`; }
    finally { live.stop(); }
    const { clean, files } = extractFiles(reply);
    reply = clean || reply;
    if (reply) await ilink.sendText(this.account, from, reply, msg.context_token).catch(() => {});
    // 发文件：相对路径按工作目录解析，逐个发；失败/缺失回一句话，不闷掉
    const sent = [];
    for (const raw of files) {
      const fp = path.isAbsolute(raw) ? raw : path.join(this.cwd, raw);
      try {
        if (!fs.existsSync(fp)) { await ilink.sendText(this.account, from, `（找不到文件：${raw}）`, msg.context_token).catch(() => {}); continue; }
        await ilink.sendMedia(this.account, from, fp, msg.context_token);
        sent.push(path.basename(fp));
      } catch (e) { await ilink.sendText(this.account, from, `（发文件失败：${path.basename(fp)} — ${String(e && e.message || e).slice(0, 150)}）`, msg.context_token).catch(() => {}); }
    }
    this.push(from, 'assistant', reply + (sent.length ? `\n📎 已发送：${sent.join('、')}` : ''));
    await this.autoCompactIfHeavy(from);
  },
  disconnect() {
    if (this.pollAbort) { try { this.pollAbort.abort(); } catch { /* */ } this.pollAbort = null; }
    this.account = null;
    this.expired = false;
    ilink.writeJson(f('account.json'), null);
    this.fireConnChange();
    return { ok: true };
  },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = bridge;
