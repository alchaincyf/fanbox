# 09 · FanBox Agent 架构设计 —— 记忆 / 上下文 / 自主进化

> 研究 + 产品设计文档（不直接动手，先想清楚）。
> 调研来源：OpenClaw 官方文档逐页精读、Hermes Agent 源码级拆解（NousResearch）、学界 SOTA 论文（CoALA / MemGPT-Letta / Generative Agents / mem0 / Voyager / Reflexion / Self-Evolving Agents Survey）+ Anthropic context engineering。
> 设计视角：**张小龙**（微信设计哲学）——克制、用完即走、做减法、警惕过度设计、用户价值压倒功能堆砌。叠加 FanBox 第一原则：**先服务花叔自己的工作流，不为外部用户牺牲他的体验**。
> 日期：2026-06-15

---

## 0. 一句话结论与立场

**FanBox 不需要重造一个 agent runtime，它需要把花叔已经有的零件接成一个连贯的「个人 agent 操作系统」，并补三个高 ROI 的小升级。**

三份调研异口同声地告诫一件事：OpenClaw 和 Hermes 之所以复杂，是因为它们要**服务全世界的用户**（多平台网关、多部署后端、多 provider 可插拔、多 agent 路由、自进化全套引擎）。这些复杂度对「先服务花叔自己」的 FanBox 全是**负债**。

张小龙会说：**「一个产品，要做的不是把功能堆上去，而是把不需要的都拿掉。」** 所以这份设计的核心动作不是「加」，而是「**接 + 减**」——接通已有零件，减掉别人为规模付出的重量。

---

## 1. 调研精华三连（收敛结论）

### 1.1 OpenClaw 教我们的（取其神，弃其重）

**值得学**：
- **记忆 = 纯 Markdown 文件 + "no hidden state"**：`MEMORY.md`（压缩长期层）/ `memory/YYYY-MM-DD.md`（每日工作层）/ `DREAMS.md`（晋升日记）。长期记忆超注入预算时，**磁盘保完整、注入副本截断**。
- **三层上下文各司其职**：Pruning（`cache-ttl` 剪 tool 结果、不落盘、专为省 prompt-cache）/ Compaction（摘要、落盘、防溢出）/ Context Engine（可插拔装配）。**关键招：压缩前先跑一个 silent turn 做 memory-flush**，把重要信息落盘再压。
- **Skill 渐进披露**：system prompt 只注入 name+description+location，SKILL.md 正文按需 read。
- **Skill Workshop**：agent 自造技能，但走 `proposal → scan → approve` 治理流，`autonomous` 默认关、hash-bound、可回滚。
- **Dreaming**：记忆晋升用 6 信号加权打分 + 阈值门 + `promote-explain` 可解释 + 人审。
- **Heartbeat + Commitments**：把「主动性」做成可控周期 turn（`activeHours` 只在活跃时段、`HEARTBEAT_OK` ack 契约、`maxPerDay` 限流）。
- **故障隔离**：可插拔组件抛错 → quarantine → 降级内置 legacy，agent 绝不哑掉。
- **上下文可观测**：`/context map` treemap 看谁在吃 token。

**弃其重（FanBox 不要）**：Provider/Model/Runtime/Channel 四层抽象、WebSocket 网关 + Nodes + 设备 pairing、8 级 bindings 路由、Honcho 外部记忆服务、ACP 双向桥（半成品）、「什么都可插拔」导致的配置爆炸。

### 1.2 Hermes 教我们的（同物种，最该抄记忆）

Hermes Agent（NousResearch，「The agent that grows with you」）和 FanBox 是**同物种**——本地、持久、个人化。它的 **Five Pillars**（记忆 / 技能 / Soul / Crons / 自进化）是个好骨架。最值钱的是一个**反直觉的克制赌注**：

- **有界 Markdown 记忆 + 冻结快照**：`MEMORY.md`（~800 token 硬上限）+ `USER.md`（~500 token），开会话一次性注入、**会话内冻结只读**（吃满 prefix caching、防止追着自己刚改的记忆打转、本次写入下次生效）。
- **单一 `memory` 工具**：add / replace（`old_text` 子串外科式替换）/ remove，**故意没有 read**（因为它一直在 prompt 里）。
- **遗忘 = 容量管理，不是时间衰减**：满 80% 主动整合，满 100% 报错并列出所有条目，逼 agent 自己策展。一句话：「**Bounded memory works better. Forgetting isn't failure — it's maintenance.**」
- **历史 = SQLite + FTS5 全文检索 + 小模型摘要**，**不用向量 RAG**（源码证明二手博客的「三层 + 向量」说法是错的）。
- **子 agent 零上下文成本并行**（RPC 调用，中间过程不污染主上下文）。
- **SOUL.md 人格文件**，跨会话防漂移，可 `/personality` 切换。

**弃其重**：16+ 消息平台、6 种部署后端、DSPy+GEPA 全套离线进化引擎（$2–10/次、需 trace 基建）、多 provider 记忆抽象。

### 1.3 学界 SOTA 教我们的（三条铁律）

- **记忆铁律**：分层（CoALA 的 working/episodic/semantic/procedural）+ **写入要带操作语义**（mem0 的 ADD/UPDATE/DELETE/NOOP——**这是避免记忆污染的核心**，纯 append 必然越用越脏）+ 检索 = recency × relevance × importance（Generative Agents 三因子）+ reflection 把流水升华成结论。**结构化优先于向量，向量只做补充。**
- **上下文铁律**：context window 是「有限且会衰减的资源」，要主动 curate；压缩按重要性分级（保决策/未决/偏好，丢冗余 tool 输出）；能卸载就卸载到文件（note-taking + just-in-time 拉回）；重活派子 agent 主线只收摘要；system prompt 要找对 **altitude**（最小完整信息集，别太脆也别太空）。
- **自进化铁律**：**可验证才自改（verifiability constraint）**——有客观判定（代码跑通/测试过/任务达成）的能力才让 agent 自进化；**棘轮机制（ratchet）只保留通过验证的改进**；写 procedural（技能/代码）比写 memory 危险得多，要更严的闸门；不可验证的（文风/判断）只做「提议 → 人确认」。

---

## 2. 核心洞察：FanBox 已经站在正确的地基上

把三份调研的「最佳实践」和花叔现有的东西并排，会发现惊人的同构：

| 业界最佳实践 | 花叔已经有的 | 状态 |
|---|---|---|
| 文件式结构化记忆（MEMORY.md 常驻） | `~/.claude/memory/MEMORY.md` + `PROJECTS.md` | ✅ 已有，方向正确 |
| episodic 流水层（按需检索不自动加载） | `~/.claude/memory/daily/*.md` | ✅ 已有 |
| procedural memory（技能库） | nuwa 造的 persona skills + 上百个 skills | ✅ 已有，且有专门造引擎 |
| 自进化 = 验证闸门 + 棘轮 | **darwin-skill**（9 维 rubric + 爬山 + git 棘轮 + 盲评 + validation-gated） | ✅ 已有，几乎就是标准答案 |
| 技能创造（self-verification 入库） | **nuwa-skill**（女娲造人术） | ✅ 已有 |
| 本地真实大脑（不经中转） | openclaw-free 的 iLink + 本机 claude/codex 桥 | ✅ 刚建好 |
| 表达 / 设计能力 | **huashu-design** | ✅ 已有 |
| 人格 Soul | 全局 CLAUDE.md（花叔的 AI 协作配置） | ✅ 已有（local claude 原生加载） |

**结论**：FanBox 不缺零件，缺的是「把零件接成一个 OS」和三个高 ROI 升级（见 §9）。darwin 几乎就是 SOTA 说的 ratchet，nuwa 几乎就是 Voyager 说的 skill genesis——花叔等于自己独立走到了学界共识，现在只需把它们**接进 FanBox agent 的主循环**。

---

## 3. FanBox Agent 设计总览

### 3.1 架构图（文字版）

```
┌───────────────────────────── FanBox Agent OS ─────────────────────────────┐
│                                                                            │
│  入口层        微信(iLink) ─┐                                               │
│               桌面输入框 ───┼──► 编排(bridge) ── cwd=当前项目 ──┐           │
│               终端(直接跑) ─┘                                    │           │
│                                                                 ▼           │
│  大脑层                                       本机真实 Claude Code / Codex   │
│               （openclaw-free，无中转，原生读 cwd 的 CLAUDE.md/AGENTS.md）  │
│                                                 │         │        │        │
│        ┌────────────────────────────────────────┘         │        │        │
│        ▼                          ▼                        ▼        ▼        │
│  记忆层(§4)                 上下文层(§5)              能力层(§7)   人格层      │
│  · semantic: MEMORY.md      · 有界+冻结快照          · huashu-design  SOUL/   │
│  · project:  PROJECTS.md    · 压缩前 memory-flush    · nuwa(造)    CLAUDE.md  │
│  · episodic: daily/*.md     · 子 agent 卸载          · darwin(进化)          │
│  · 操作语义 ADD/UPD/DEL     · note-taking 文件外存   · skills(渐进披露)      │
│  · FTS5 历史检索            · altitude 审计                                  │
│                                                                            │
│  进化层(§6)   verifiability constraint + ratchet（darwin 把关）            │
│              可验证→自动进化 / 不可验证→提议+花叔确认                       │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 五个部件一句话

1. **记忆**：文件式三层（语义/项目/流水）+ 操作语义去污染 + 有界冻结 + FTS5 检索。
2. **上下文**：手机端极省 + 压缩前先 flush + 子 agent 卸载 + 文件外存 + altitude 审计。
3. **能力**：huashu-design（表达）/ nuwa（造 skill）/ darwin（进化 skill）作为 agent 的三个可调用引擎，skills 渐进披露。
4. **人格（Soul）**：全局 CLAUDE.md + 可选的微信场景 persona（已做）。
5. **进化**：verifiability constraint 分级闸门 + darwin 棘轮 + nuwa self-verification。

---

## 4. 记忆机制设计

### 4.1 三层，不强凑四层（克制）

| 层 | 落地 | 加载策略 | 说明 |
|---|---|---|---|
| **语义 semantic** | `MEMORY.md`（身份/偏好/风格）| 每会话开头**一次性注入、会话内冻结** | 有界（建议 ≤ ~1000 token 注入预算，磁盘可超、注入截断） |
| **项目 project** | `PROJECTS.md`（当前项目/deadline/优先级）| 同上 | 花叔已有，等于 Hermes 的 USER.md + 任务态 |
| **流水 episodic** | `daily/YYYY-MM-DD.md` | **不自动注入**，FTS5/grep 按需检索 | 永不自动加载（花叔已有此约束，正确） |
| **程序 procedural** | = nuwa 造的 skill 库 | 渐进披露（只注入索引） | **不在记忆系统里重复造**，直接复用 skill 体系 |

### 4.2 写入加操作语义（最高 ROI 的一处升级）

现状：MEMORY.md 多是 append。**问题**：纯 append + 时间久 → 记忆污染（旧偏好和新偏好并存、矛盾、越来越脏）。

**设计**：引入 mem0 式四操作（零基建，就是 agent 编辑 markdown 的规范）：
- **ADD**：新主题，追加。
- **UPDATE**：已有同主题条目 → 用新值**替换**（Hermes 式 `old_text` 子串外科替换），不堆叠。
- **DELETE**：发现矛盾/过时 → 删旧条目。
- **NOOP**：已记过且无变化 → 不动。

写入前先「查同主题是否已存在」，再决定 ADD/UPDATE/DELETE。这条直接解决长期记忆最大的腐烂问题。

### 4.3 有界 + 冻结快照（抄 Hermes）

- 注入模型的记忆**会话内冻结**（本次写入下次生效）——吃满 prefix caching，防止模型追着自己刚改的记忆打转。
- 注入有**预算上限**；磁盘文件保完整，注入副本超预算就截断（抄 OpenClaw）。
- **遗忘 = 容量管理**：MEMORY.md 注入层接近预算时，触发一次「整合压缩」（让 agent 自己合并/删次要条目），而不是搞时间衰减算法。

### 4.4 检索：三因子轻量版，先不上向量

- 跨 `daily/` 检索用 **recency × relevance（关键词）× importance（一个简单标记）** 排序（Generative Agents 三因子的轻量实现）。
- **暂不上向量库**：文件量没到需要 embedding 的规模，`grep` + 文件名 + FTS5 就够。等真的检索不动了再说（避免过度工程）。
- 历史长对话：落 SQLite + FTS5，需要翻旧账时「全文检索 → 小模型摘要返回片段」（抄 Hermes，零向量依赖）。

### 4.5 reflection：微信/手动触发，不做后台定时

- **不做后台 cron 反思**（耗资源、易跑偏、半夜刷屏）。
- 花叔说「今天总结一下 / 记一下」时，让 agent 回看当天 episodic，抽 semantic 结论写回 MEMORY.md（带 §4.2 的操作语义）。
- 这同时也是花叔现有「私人助理」记忆系统的产品化。

---

## 5. 上下文管理设计

微信入口决定了**上下文必须极省**（手机看长输出体验差、多轮易爆）——这正好是张小龙会盯的点。

1. **手机端默认简洁**（已做）：微信 persona 注入「简洁、先结论、别甩大段代码」。
2. **压缩在 ~70-80% 阈值主动触发**，不等爆；保留决策/未决问题/偏好，丢冗余 tool 输出。
3. **压缩前先 memory-flush**（抄 OpenClaw）：插一个 silent 步骤让模型把没落盘的重要事实写进 MEMORY.md 再压——几乎零成本，体验提升明显。
4. **子 agent 卸载**：nuwa / darwin / 重搜索 / 重浏览 类任务当**隔离子 agent**调用，主对话只收 1000–2000 token 结论，detailed 过程留子 agent 内（Anthropic 推荐、Hermes 已验证）。
5. **note-taking 文件外存**：遥控本机跑长任务时，让 agent 把进度/决策/待办写进任务笔记文件，压缩或断线后从文件恢复（逻辑黑匣子，呼应 FanBox 已有的终端录像黑匣子）。
6. **CLAUDE.md altitude 审计**：全局 CLAUDE.md 偏长、每轮进 context。挑出真正 load-bearing 的（身份硬约束、写作红线）常驻，低频规则移到按需加载的子文件。
7. **tool 结果 cache-ttl 剪枝**（可选、降本）：超大 tool 结果留头尾插 `...`，TTL 过期 hard-clear，重置缓存。

### 5.x 已落地（v2.3.0）：会话轮换 = compact 与「新对话」共用一个机制

实现时认清一个关键现实：**FanBox 的上下文不在自己手里，活在 claude/codex 自己的 session 里**（`--resume <id>`，每轮重放全部历史）。FanBox 里的 `messages` 只是 UI 显示用，不是模型 context。所以真正的「省上下文」动作只有一个——**轮换 session**。compact 和「新对话」对 FanBox 是同一个机制，区别只在换之前留不留摘要续场：

- **机制**：`memoryFlush`（清 session 前的静默一轮，让 agent 用 `<memory>` ops 落盘 + 吐一段 ≤150 字进度摘要）→ 清 `claudeSession`/`codexSession`。
- **整理（compact）**：flush → 换 session → 把进度摘要**播种**进下一轮系统提示（`pendingRecap`，用一次即清）。续场顺滑。
- **新对话**：flush → 硬清 session 与摘要 → 纯靠注入的 MEMORY.md 续。换话题用。
- **自动闸门**：`driver` 从 claude `-p` 的 `result.usage` 抓单轮输入 token（≈被重放的上下文大小，codex 抓不到就用消息字符数粗估）；每个回合**结束后**若超 `CTX_BUDGET`（默认 120k，留足 200k 窗口的垫）就静默 compact，绝不打断当轮回答。
- **可观测**：面板顶栏一条轻量进度条（`38k / 120k`，≥80% 转红），呼应 §9.9 的 `/context`。
- **连续性靠记忆层兜底**：任何重置前强制 flush，所以重置永不丢重要信息——这正是 §4 的 `<memory>` ops 落盘 + §5.3 的 memory-flush 合流。

> 还没做（押后）：子 agent 卸载（§5.4）、note-taking 外存（§5.5）、cache-ttl 剪枝（§5.7）、CLAUDE.md altitude 审计（§5.6）。

---

## 6. 自主进化设计

**铁律：可验证才自改 + 棘轮只保留改进。** 这正是 darwin 已经在做的事——只需把它接进 agent 主循环并明确分级。

### 6.1 两类自改，两种闸门（CoALA 风险分级）

| 类型 | 例子 | 闸门 | 引擎 |
|---|---|---|---|
| **procedural（技能/代码）** | 优化一个 skill、沉淀一个新 skill | **严闸门**：隔离环境跑测例 + 不劣于原版才替换 + git 棘轮回滚 | darwin（优化）/ nuwa（创造） |
| **semantic（偏好/记忆）** | 记一条新偏好 | **轻闸门**：写前判重去污染（§4.2）即可，错了好改 | 记忆系统 |
| **不可验证（文风/判断/产品决策）** | 改写作风格、调产品方向 | **不自动改**：agent 提议 → 微信问花叔 → 确认才落库 | 人在回路 |

### 6.2 darwin = ratchet（几乎现成）

darwin 已有 9 维 rubric + 爬山 + git 版本控制 + 盲评 judge + validation-gated。要做的只是**把它变成 FanBox agent 可调用的进化能力**：当某个 skill 反复表现不好（从交互 trace 观察到），触发 darwin 在隔离环境优化 → 通过验证才替换 → 否则回滚。**棘轮天然防「越进化越烂」。**

### 6.3 nuwa = self-verification 入库（Voyager 铁律）

nuwa 造的新 skill**入库前必须自测**（能跑通 + 解决目标任务）才生效，绝不让没验证过的 skill 自动 live。对应 OpenClaw Skill Workshop 的 `proposal → scan → approve`：**FanBox 观察花叔重复的工作流 → 提议用 nuwa 沉淀成 skill → 花叔点确认才生效**。这正中第一原则（服务花叔自己的工作流）。

### 6.4 反思闭环要落地成产物

任务失败时做 Reflexion 式反思，但产物必须落地：要么变成 MEMORY.md 一条经验，要么触发 darwin 优化对应 skill——**别让反思只停在对话里**。

---

## 7. 三大内核集成（huashu-design / nuwa / darwin）

把三个内核定位成 FanBox agent 的**三个可调用引擎**（作为子 agent / skill 暴露给主循环），各自值得专门设计：

### 7.1 huashu-design —— 表达 / 造物引擎
- 定位：agent 的「手」。需要出原型、PPT、动画、海报、可视化时调用。
- 集成：作为 skill（已是）+ 子 agent 调用（重活隔离，主线收成品路径）。
- 专门设计点：微信场景下「花叔说做个 X」→ agent 调 huashu-design 在当前项目目录产出 → 回传可点开的本地链接/截图，而不是把 HTML 源码刷屏到手机。

### 7.2 nuwa（女娲）—— 创造引擎（procedural genesis）
- 定位：agent 的「生育能力」——把人物思维 / 花叔重复的工作流蒸馏成可运行 skill。
- 集成：① 显式调用（「造个 X 的 skill」）；② **自主提议**（观察到花叔反复做同一类事 → 提议沉淀成 skill，确认才造）。
- 专门设计点：入库走 self-verification 闸门（§6.3）；造出的 skill 进 procedural 记忆层，渐进披露。

### 7.3 darwin（达尔文）—— 进化引擎（ratchet）
- 定位：agent 的「自然选择」——让 skill 库越用越好，自动汰弱留强。
- 集成：① 显式调用（「优化这个 skill」）；② **自主触发**（trace 显示某 skill 老出问题 → 隔离优化 → 验证棘轮）。
- 专门设计点：把 darwin 的 git 棘轮 + 盲评 + validation-gated 接成 agent 的后台进化闭环；不可验证维度只提议不自动改。

### 7.4 人格（Soul）
- 全局 CLAUDE.md（花叔的 AI 协作配置）= 默认人格，local claude 原生加载（已验证）。
- 微信场景叠加可自定义 persona（已做）。
- 可选：未来支持 `/personality` 切换不同 nuwa persona（芒格/费曼…）当顾问。

---

## 8. 不做清单（反过度工程 —— 张小龙的「拿掉」）

三份报告共同标红、FanBox **明确不做**的：

1. ❌ **向量记忆库 / embedding 基建**——文件 + grep + FTS5 够用，到规模再说。
2. ❌ **后台定时 reflection / dreaming cron**——耗资源易跑偏，改手动/微信触发。
3. ❌ **对不可验证内容（文风/判断）的自动自改**——违反 verifiability constraint，只提议。
4. ❌ **多 IM 平台网关**（Telegram/WhatsApp/Signal…）——违反第一原则，只做微信。
5. ❌ **多部署后端 / serverless / 设备 pairing / WebSocket 网关**——单机桌面不需要。
6. ❌ **Provider/Model/Runtime/Channel 四层抽象 + bindings 路由**——provider+model 两层足够。
7. ❌ **多 provider 可插拔记忆抽象（Honcho/Mem0 service）**——核心文件 + SQLite 即可。
8. ❌ **DSPy+GEPA 全套离线进化引擎**——darwin 的轻量棘轮够用，重引擎是过早优化。
9. ❌ **「什么都可插拔」的配置哲学**——只选一种内置实现做到极好，避免配置爆炸。

> 原则：**学它们的机制思想，不学它们为规模付出的重量。**

---

## 9. 落地路线图（按 ROI 排序）

### 第一梯队（高 ROI、低成本、最该先做）
1. **记忆写入操作语义（ADD/UPDATE/DELETE/NOOP）** —— 解决长期记忆腐烂，零基建。
2. **压缩前 memory-flush** —— 防压缩丢信息，几乎零成本。
3. **darwin 接成「验证通过才替换」的棘轮** —— 把已有 darwin 接进主循环，加隔离验证。
4. **nuwa 造 skill 强制 self-verification + 提议制** —— 入库闸门。

### 第二梯队（中等、提升体验）
5. **子 agent 卸载**（nuwa/darwin/重活隔离，主线收摘要）。
6. **note-taking 文件外存**（长任务逻辑黑匣子）。
7. **CLAUDE.md altitude 审计 + 有界冻结记忆注入**。
8. **FTS5 历史检索 + 小模型摘要召回**。

### 第三梯队（锦上添花、按需）
9. **上下文可观测面板**（`/context` 谁在吃 token）。
10. **轻量 heartbeat 主动性**（activeHours + HEARTBEAT.md，只在活跃时段）。
11. **reflection 升华闭环**（手动触发 → 写回记忆/触发 darwin）。

### 明确押后 / 不做
- 向量库、定时 dreaming、多平台、多部署、四层抽象、GEPA 全套（见 §8）。

---

## 10. 待花叔拍板的开放问题

1. **记忆系统的「家」在哪？** 复用 `~/.claude/memory/`（和花叔现有助理体系共用一套，强一致），还是 FanBox 独立一份 `userData/memory/`（隔离但要同步）？建议复用，单一事实源。
2. **自主提议的打扰边界？** nuwa/darwin 的「自主提议沉淀/进化」默认要不要开？建议默认**关**（像 OpenClaw `autonomous.enabled` 默认 false），花叔显式开启或每次确认——克制优先。
3. **第一梯队先落哪一个？** 我建议从 ①记忆操作语义 开始（ROI 最高、改动最小、立刻能体感到记忆变干净）。
4. **darwin/nuwa 当「子 agent」还是「skill」接入？** 建议 skill（渐进披露、复用现有机制）+ 重活时以子 agent 形式跑。

---

## 附：调研来源

- OpenClaw 官方文档 docs.openclaw.ai（concepts/memory、context、context-engine、compaction、session-pruning、dreaming、commitments、agent-runtimes、multi-agent、plugins、skills、skill-workshop、heartbeat 等 30+ 页）
- Hermes Agent：github.com/NousResearch/hermes-agent、hermes-agent-self-evolution；源码级拆解 glukhov.org/ai-systems/hermes/
- 学界：CoALA(arXiv 2309.02427)、MemGPT(2310.08560)/Letta、Generative Agents(2304.03442)、mem0(2504.19413)、Voyager(2305.16291)、Reflexion(2303.11366)、Self-Evolving Agents Survey(2507.21046)、Externalization in LLM Agents(2604.08224)、Agent Memory Evolution Survey(2605.06716)、Anthropic「Effective context engineering for AI agents」
- 花叔内核：darwin-skill（9 维 rubric + 棘轮，基于 SkillLens 2605.23899 / SkillOpt 2605.23904）、nuwa-skill（女娲造人术）、huashu-design
