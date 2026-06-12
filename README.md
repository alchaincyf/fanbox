<div align="center">

# 📦 FanBox

> *"AI spins up ten projects in an afternoon. FanBox helps you find them again."*

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/alchaincyf/fanbox?label=Release&color=blue)](https://github.com/alchaincyf/fanbox/releases/latest)
[![Platform](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)](https://github.com/alchaincyf/fanbox/releases/latest)
[![Runtime](https://img.shields.io/badge/Runtime-no--build-blueviolet)](#architecture)

[English](#why-fanbox) · [简体中文](#为什么要做-fanbox)

<br>

**The cockpit for vibe coding: browse files on the left, command agents on the right, watch every change in between.**

<br>

Browse, preview and edit local files on one side; run Claude Code or any coding agent in a real embedded terminal on the other.<br>
Every time the agent writes a file, its card lights up — *find files → run agents → see what changed*, all in one window.

<br>

[⬇ Download dmg](https://github.com/alchaincyf/fanbox/releases/latest) · [Screenshots](#three-skins) · [Features](#what-it-does) · [Install](#install) · [Credits](#standing-on-the-shoulders-of-giants)

</div>

---

<p align="center">
  <img src="assets/screenshot-volt.png" alt="FanBox · Volt skin · file browser on the left, README preview at the bottom, embedded terminal on the right" width="100%">
</p>

<p align="center"><sub>▲ Real capture: browsing the fanbox repo itself, README previewed in place, git running in the embedded terminal. All screenshots in this README are taken from the live app via Playwright, unedited.</sub></p>

---

## Why FanBox

AI helps you start ten projects in an afternoon — then they scatter everywhere, the names stop making sense, and you can't see what got changed. The daily reality: dig through Finder → switch to iTerm to launch an agent → switch to the browser to check results. Three windows, endless hopping.

FanBox folds that loop into one window: **files on the left × terminal on the right/bottom × preview in place**. It doesn't compete with Finder on file ops or VS Code on editing. It does one chain well: *find → preview → light edits → command the agent*.

No cloud, no remote, no accounts. Local-first, zero config, zero runtime dependencies.

## Three skins

The UI was designed with [huashu-design](https://github.com/alchaincyf/huashu-design). The three skins are not theme-color swaps — palette, typography, icons, code highlighting and terminal ANSI themes all change together:

| | |
|---|---|
| <img src="assets/screenshot-volt.png" alt="Volt skin"> | **Volt** · neon green × charcoal × monospace, industrial instrument panel (default) |
| <img src="assets/screenshot-archive.png" alt="Archive skin"> | **Archive** · cream paper × terracotta × serif, a warm paper archive |
| <img src="assets/screenshot-index.png" alt="Index skin"> | **Index** · black & white × signal red/green × oversized type, editorial index daily |

## What it does

### Files · find & preview

- **⌘K global fuzzy search** — a fragment of the name is enough; `⌘↵` opens the project in your editor; `content:keyword` switches to full-text search.
- **Bold solid icons** — every file type "looks like itself": red PDFs, yellow JS, blue Markdown; photos and videos render at true aspect ratio.
- **Preview in place** — rendered Markdown, live HTML, syntax-highlighted code, inline images/video/PDF (HEIC included), archive content listing, checkerboard backing for transparent images.
- **Thumbnail speed** — scrolling and clicking through large folders stays under 0.1s.
- **Project badges** — folder cards show node / web / py / rs / go badges, so ten projects from one afternoon are recognizable at a glance.

### Watch what the agent changed

- **A live dashboard** — every file the agent writes makes its card ripple and glow by change frequency; the light follows wherever the agent goes.
- **Follow mode** — one click and the file view + preview track whatever file the agent edits: code scrolls with freshly written lines flashing, HTML renders as a live web page while it's being written (double-buffered, zero white flash), Markdown renders live. Any manual browsing hands control back to you instantly.
- **Session replay** — drag the timeline like scrubbing a video to replay which files the agent touched, step by step.
- **Change inbox** — all files modified this session, aggregated across projects, for parallel agent runs.
- **Git diff** — Monaco read-only DiffEditor, HEAD vs working tree side by side.

### Agent cockpit

- **Project memory** — open any project folder and see what AI did there: past sessions (your first message as the title), the files each session changed, the skills it triggered — and a "resume" button that reconnects the context via `claude --resume` / `codex resume` in the embedded terminal.
- **Screenshot express** — take a system screenshot and a card pops up in the corner: feed it to the terminal agent, file it into the project's `素材/` (assets) folder, or annotate before sending.
- **AI organize** — AI proposes a cleanup plan from metadata only (it never reads content or touches the filesystem); you approve each move; FanBox executes with a rollback log and one-click undo. Engine selectable (Claude Code / Codex), strategy prompt fully editable.
- **Release wizard** — for node projects: version bump, CHANGELOG promotion, build, push and GitHub Release composed into one command sequence that runs visibly in the embedded terminal.
- **Skills X-ray** — every agent skill on your machine in one view: trigger statistics, health checks (description truncation, missing frontmatter), context budget, enable/disable without deleting.
- **Agent usage** — Claude Code official 5h window / weekly quota (same source as `/usage`) plus local token statistics; Codex window snapshots with reset detection.
- **Disk usage lens** — `du`-accurate bars per folder, drill-down, for the "my disk is full again" moments.

### Terminal · command the agent

- **A real embedded terminal** — node-pty + xterm.js (WebGL). Claude Code / vim / htop render correctly, CJK wide characters included.
- **Drag files in** — drop a file or folder into the terminal to insert its path as agent context.
- **Clickable paths** — file paths appearing in terminal output open in FanBox on click; macOS screenshot names with spaces, Chinese filenames and wrapped long paths are all recognized (space boundaries verified by stat, not guessed).
- **Send selection** — select text in a preview and fling it into the terminal with file provenance + fencing (bracketed paste, never executed line by line).
- **Situational awareness** — tab dots show running/idle/exited; when the agent hands the ball back, the terminal edge breathes; long tasks fire a system notification.

### Editing · WYSIWYG

- **Markdown** — Milkdown Crepe, Notion-style WYSIWYG; opens in edit mode, auto-saves 0.8s after you stop typing.
- **Code/JSON** — Monaco (the VS Code core), themed per skin.
- **Image annotation** — pen/arrow/text/redaction, format conversion, compression, resizing; overwriting the original asks first.
- **Unsaved guard** — all three editors intercept unsaved exits, including the Esc bypass.

## Install

### Desktop (recommended)

Download the latest `.dmg` from [**Releases**](https://github.com/alchaincyf/fanbox/releases/latest) and drag it into Applications. Native Apple Silicon (arm64).

> Signed with an Apple Development certificate + hardened runtime. If macOS warns about an unverified developer on first launch: **right-click → Open → confirm**.
>
> Built-in **update notifications**: when a new release lands on GitHub, a capsule appears at the bottom right. Never forced; individual versions can be muted.

### Web (no packaging)

```bash
node server.js
```

Open `http://localhost:4567`. Zero dependencies, zero build — clone and run. The web version covers browsing/search/preview (the embedded terminal and editors need Electron).

### Development

```bash
npm install
npm run app          # electron . — full desktop app
npm run dist         # build & sign the .dmg (output in dist/, distributed via Releases)
```

> If the Electron download is blocked: `ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" npm run dist`

## Shortcuts

| Action | Key | Action | Key |
|---|---|---|---|
| Global search | `⌘K` | Open in editor | `⌘↵` |
| Toggle sidebar | `⌘B` | Back | `⌘[` |
| Filter current folder | `/` | Open/preview | `↵` |
| Navigate results | `↑` `↓` | Close | `Esc` |

## Privacy & security

- The backend listens on loopback only and validates the Host header (anti DNS-rebinding). **Data never leaves your machine.**
- All frontend assets (including renderers and fonts) are vendored locally — no network requests at runtime, **fully usable offline**. The only outbound calls: the Claude usage API (optional) and the GitHub release check.
- HTML previews render in a sandboxed iframe with an opaque origin; an untrusted page can never reach terminal capabilities.
- Config writes are serialized read-modify-write with atomic persistence (temp + fsync + rename) — no data loss, no truncated JSON.
- Deletions go to the system Trash (recoverable); the thumbnail cache prunes oldest-first with a 400MB cap.

## Design & acceptance

The UI was designed with **[huashu-design](https://github.com/alchaincyf/huashu-design)** — skin direction exploration, component polish and anti-AI-slop review all come from its workflow. The icon is a terracotta archive box on a rice-paper squircle, generated from SVG all the way to icns.

Each development phase is reviewed by **5 independent subagents** playing different roles (heavy vibe coder / native-taste designer / zero-docs newcomer / ten-year terminal veteran / destructive QA), scoring the product + live screenshots + code. **Everything ships at ≥90 with zero red lines.** See `docs/05-验收角色与评分标准.md`.

## Standing on the shoulders of giants

FanBox's core capabilities come from these excellent open-source projects:

| Project | Used for | License |
|---|---|---|
| [Electron](https://www.electronjs.org/) | The desktop shell that gives a zero-dependency Node backend a real terminal and native powers | MIT |
| [node-pty](https://github.com/microsoft/node-pty) | The pseudo-terminal behind the embedded "real shell" | MIT |
| [xterm.js](https://xtermjs.org/) | Terminal rendering ([addon-webgl](https://github.com/xtermjs/xterm.js) GPU acceleration, addon-fit, addon-unicode11 for CJK) | MIT |
| [Monaco Editor](https://microsoft.github.io/monaco-editor/) | Code/JSON editing and Git diff view, the VS Code core | MIT |
| [Milkdown](https://milkdown.dev/) (Crepe) | Markdown WYSIWYG editing | MIT |
| [marked](https://marked.js.org/) | Markdown preview rendering | MIT |
| [highlight.js](https://highlightjs.org/) | Syntax highlighting | BSD-3-Clause |
| [esbuild](https://esbuild.github.io/) | Bundling Milkdown into a single local vendor file, keeping runtime no-build | MIT |
| [electron-builder](https://www.electron.build/) | Packaging and signing the dmg | MIT |
| [Playwright](https://playwright.dev/) | Driving Electron for README screenshots + UI verification | Apache-2.0 |

Every frontend dependency is vendored locally (`public/vendor/`) — that's what makes "fully usable offline" true, and it means each project above actually runs on your machine. Thank you.

## Architecture

| Layer | Stack |
|---|---|
| Backend | Zero-dependency Node.js `server.js` (file APIs + static serving + thumbnails) |
| Desktop shell | Electron 33 + node-pty (asarUnpack native module) |
| Terminal | xterm.js + WebGL + unicode11 |
| Editors | Monaco (code) + Milkdown Crepe (Markdown) |
| Packaging | electron-builder → signed arm64 .dmg |

<details>
<summary>Project layout</summary>

```
fanbox/
├── server.js               # Zero-dependency Node backend (file APIs + thumbnails + static)
├── electron/
│   ├── main.js             # Main process (window/pty/clipboard/fs.watch/menu)
│   └── preload.js          # Exposes fanboxPty / fanboxFs / fanboxClipboard
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js              # Frontend single-page app
│   └── vendor/             # xterm / monaco / milkdown local assets
├── src-vendor/             # esbuild entries producing public/vendor/milkdown
├── build/                  # Icons + entitlements
├── docs/                   # Concepts/PRD/roadmap/acceptance criteria
└── experiments/            # Experiment scripts (incl. README screenshot script)
```

</details>

## Author

**Huashu (花叔)** — AI Native Coder, indie developer. Known for Cat Light (App Store paid chart Top 1).

| Platform | Link |
|------|------|
| 🌐 Web | [bookai.top](https://bookai.top) · [huasheng.ai](https://www.huasheng.ai) |
| 𝕏 Twitter | [@AlchainHust](https://x.com/AlchainHust) |
| 📺 Bilibili | [花叔](https://space.bilibili.com/14097567) |
| 📕 Xiaohongshu | [花叔](https://www.xiaohongshu.com/user/profile/5abc6f17e8ac2b109179dfdf) |
| 💬 WeChat | Search "花叔" |

More AI creations: [Nuwa.skill](https://github.com/alchaincyf/nuwa-skill) (distill anyone's way of thinking) · [huashu-design](https://github.com/alchaincyf/huashu-design) (a deliverable design from one sentence)

---

# 简体中文

## 为什么要做 FanBox

AI 帮你一个下午起十个项目，但它们散在各处、名字认不出、改了啥看不见。每天的真实流程是：Finder 里翻半天 → 切到 iTerm 启 agent → 再切浏览器看效果，三个窗口来回跳。

FanBox 把这条链路收进一个窗口：**左边文件 × 右边/下边终端 × 原地预览**，一个有机整体。它不跟 Finder 拼文件操作，不跟 VS Code 拼编辑，专注「找回 + 预览 + 轻改 + 指挥 agent」这一条链路做到顺手。

不做云、不做远程、不做账号。本地、零配置、运行时零依赖。

## 三套皮肤

界面在 [huashu-design](https://github.com/alchaincyf/huashu-design) 辅助下完成设计，三套皮肤不是换个主题色——配色、字体、图标、代码高亮、终端 ANSI 主题整体随之变化：

| | |
|---|---|
| <img src="assets/screenshot-volt.png" alt="终端皮肤"> | **终端** · Volt 荧光绿 × 炭黑 × 等宽字，工业仪器面板感（默认） |
| <img src="assets/screenshot-archive.png" alt="档案皮肤"> | **档案** · 奶油纸 × 赤陶橙 × 衬线，温暖纸感档案馆 |
| <img src="assets/screenshot-index.png" alt="索引皮肤"> | **索引** · 黑白 × 信号红/绿 × 巨号字，编辑式索引日报 |

## 能做什么

### 文件 · 找回与预览

- **⌘K 全局模糊搜索**——记得名字片段就行；`⌘↵` 用编辑器整包打开项目；`内容:关键词` 切全文搜索。
- **强色实体图标**——每种文件「长得像它自己」：PDF 红、JS 黄、Markdown 蓝，照片视频按真实比例呈现，扫一眼就认出来。
- **原地预览**——Markdown 渲染、HTML 实时成品、代码语法高亮、图片/视频/PDF 内嵌（HEIC 直接显示）、压缩包内容清单、透明图棋盘格垫底。
- **缩略图加速**——大文件夹滚动和点击都在 0.1 秒内。
- **项目徽章**——文件夹卡片标 node / web / py / rs / go 徽章，一下午起的十个项目一眼认出类型。

### 看 agent 改了什么

- **活的仪表盘**——agent 每写一个文件，那张卡片当场荡开涟漪、按改动频率发光呼吸，agent 写到哪光走到哪。
- **会话回放**——像刷视频一样拖时间轴，重现这段时间 agent 一步步改了哪些文件。
- **变更收件箱**——跨多个项目汇总本会话所有被改动的文件，多项目并行跑 agent 不再各看各的。
- **Git 改动 diff**——Monaco 只读 DiffEditor 并排展示 HEAD vs 当前工作区，看清 agent 到底改了哪几行。

### Agent 驾驶舱

- **项目记忆**——点开任何项目文件夹，看 AI 在这里干过什么：历史会话（你的第一句话当标题）、每次会话改过的文件、触发过的 skill；「▶ 续上」一键在内嵌终端 `claude --resume` / `codex resume` 接上当时的上下文。
- **截图直通车**——系统截屏落盘即浮出直通卡：喂给终端里的 agent、收进项目 `素材/`、或先标注再发。
- **AI 整理**——AI 只看元数据出整理提案（不读内容、不碰文件系统），每条建议带理由、逐条勾选过人，FanBox 执行并写回滚日志、一键整体撤销。引擎可选（Claude Code / Codex），策略提示词随便改。
- **发版向导**——node 项目一键串起版本号、CHANGELOG、打包、推送、GitHub Release，整条命令序列在内嵌终端可见地跑。
- **Skills 透视**——本机全部 agent skills 一个视图：触发统计、健康检查、context 预算、不删文件的启停开关。
- **Agent 用量**——Claude Code 官方 5h 窗口/周配额（和 `/usage` 同源）+ 本地 token 统计；Codex 限额快照 + 窗口重置识别。
- **磁盘占用透视**——du 口径的真实占用条形榜，可下钻，专治「电脑空间又满了」。

### 终端 · 指挥 agent

- **真实内嵌终端**——node-pty + xterm.js（WebGL 渲染），跑 Claude Code / vim / htop 不花屏，中文宽字符正确。
- **拖文件进终端**——从文件列表拖文件/文件夹进终端，自动插入路径喂给 agent 当上下文。
- **路径可点击**——终端里出现的文件路径直接点击在 FanBox 打开；带空格的 macOS 截屏名、中文文件名、折行的长路径都能识别（空格边界由文件系统 stat 验证，不靠猜）。
- **选中即甩给终端**——预览里选一段文字，一键以「文件出处 + 围栏」格式发进终端（bracketed paste 包裹，不会被逐行误执行）。
- **态势感知**——标签圆点显示 agent 运行/空闲/退出；agent 把球踢回给你时终端边缘呼吸提示「轮到你」，长任务完成发系统通知。

### 编辑 · 所见即所得

- **Markdown**——Milkdown Crepe 提供 Notion 式所见即所得，打开就是编辑态，停笔 0.8 秒自动保存。
- **代码/JSON**——Monaco 编辑器（VS Code 同款内核），随皮肤切换主题。
- **图片标注**——画笔/箭头/文字/打码、格式转换、压缩、调分辨率，覆盖原图前有确认。
- **未保存守卫**——三种编辑器统一拦截未保存退出，Esc 旁路也堵死。

## 安装

### 桌面版（推荐）

从 [**Releases**](https://github.com/alchaincyf/fanbox/releases/latest) 下载最新 `.dmg`，拖进「应用程序」即可。Apple Silicon (arm64) 原生。

> 已用 Apple Development 证书签名 + hardened runtime。首次打开若提示「未验证的开发者」：**右键 → 打开 → 确认**即可。
>
> 应用内置**更新提醒**：检测到 GitHub 上有新 Release 时，右下角会弹一条提示引导下载，不强更、可对单个版本「不再提醒」。

### 网页版（不打包，直接跑）

```bash
node server.js
```

浏览器打开 `http://localhost:4567`。零依赖、零 build，clone 下来就能跑。网页版只有文件浏览/搜索/预览（内嵌终端和编辑器靠 Electron 提供）。

### 开发模式

```bash
npm install
npm run app          # electron . 启动完整桌面版
npm run dist         # 打包签名 .dmg（产物在 dist/，不入 git，统一走 Releases 分发）
```

> 打包遇到 Electron 下载被墙：`ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" npm run dist`

## 快捷键

| 操作 | 键 | 操作 | 键 |
|---|---|---|---|
| 全局搜索 | `⌘K` | 用编辑器打开 | `⌘↵` |
| 折叠侧栏 | `⌘B` | 后退 | `⌘[` |
| 当前目录筛选 | `/` | 打开/预览 | `↵` |
| 结果上下选择 | `↑` `↓` | 关闭 | `Esc` |

## 隐私与安全

- 后端只在本机回环地址监听 + 校验 Host 头（挡 DNS rebinding），**数据不出本机**。
- 全部前端资源（含渲染器、字体）本地内置，**离线完全可用**。仅有的出网请求：Claude 用量接口（可选）和 GitHub 更新检查。
- HTML 预览在隔离 origin 的沙箱 iframe 里渲染，预览不可信网页也碰不到终端能力。
- 配置写入走串行化读-改-写 + 原子写（temp + fsync + rename），不丢数据、不留半截 JSON。
- 删除走系统废纸篓（可恢复）；缩略图缓存按最旧优先自动裁剪，上限 400MB。

## 设计与验收

界面设计在 **[huashu-design](https://github.com/alchaincyf/huashu-design)** 辅助下完成——三套皮肤的方向探索、组件质感、反 AI slop 审查都出自它的工作流。图标是档案暖色陶土箱体 + 米纸 squircle，从 SVG 一路生成到 icns。

每个开发阶段由 **5 个独立 subagent** 扮演不同角色（重度 vibe coder / 原生审美设计师 / 零文档新用户 / 终端十年老兵 / 破坏性质量官），审「成品 + 真机截图 + 代码」打分，**全部 ≥90 分且无红线才算达标**。评分标准见 `docs/05-验收角色与评分标准.md`。

## 建在巨人肩膀上

FanBox 的核心能力来自这些出色的开源项目：

| 项目 | 用在哪 | License |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 桌面壳，让零依赖 Node 后端长出真实终端和原生能力 | MIT |
| [node-pty](https://github.com/microsoft/node-pty) | 伪终端，内嵌终端的「真 shell」来源 | MIT |
| [xterm.js](https://xtermjs.org/) | 终端渲染（含 [addon-webgl](https://github.com/xtermjs/xterm.js) GPU 加速、addon-fit 自适应、addon-unicode11 CJK 宽字符） | MIT |
| [Monaco Editor](https://microsoft.github.io/monaco-editor/) | 代码/JSON 编辑与 Git diff 视图，VS Code 同款内核 | MIT |
| [Milkdown](https://milkdown.dev/)（Crepe） | Markdown 所见即所得编辑 | MIT |
| [marked](https://marked.js.org/) | Markdown 预览渲染 | MIT |
| [highlight.js](https://highlightjs.org/) | 代码语法高亮 | BSD-3-Clause |
| [esbuild](https://esbuild.github.io/) | 把 Milkdown 打成单文件本地 vendor，运行时保持 no-build | MIT |
| [electron-builder](https://www.electron.build/) | 打包签名 dmg | MIT |
| [Playwright](https://playwright.dev/) | 驱动 Electron 实拍本 README 截图 + UI 验证 | Apache-2.0 |

所有前端依赖都 vendor 到本地（`public/vendor/`），这是「离线完全可用」的底气，也意味着上面每个项目的代码真实地跑在你机器上。谢谢它们。

## 技术架构

| 层 | 用什么 |
|---|---|
| 后端 | 零依赖 Node.js `server.js`（文件 API + 静态服务 + 缩略图） |
| 桌面壳 | Electron 33 + node-pty（asarUnpack 原生模块） |
| 终端 | xterm.js + WebGL + unicode11 |
| 编辑器 | Monaco（代码）+ Milkdown Crepe（Markdown） |
| 打包 | electron-builder → 签名 arm64 .dmg |

<details>
<summary>项目结构</summary>

```
fanbox/
├── server.js               # 零依赖 Node 后端（文件 API + 缩略图 + 静态服务）
├── electron/
│   ├── main.js             # 主进程（窗口/pty/剪贴板/fs.watch/菜单）
│   └── preload.js          # 暴露 fanboxPty / fanboxFs / fanboxClipboard
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js              # 前端单页应用
│   └── vendor/             # xterm / monaco / milkdown 本地资源
├── src-vendor/             # esbuild 入口，产出 public/vendor/milkdown
├── build/                  # 图标 + entitlements
├── docs/                   # 概念/PRD/路线图/验收标准
└── experiments/            # 实验脚本（含 README 截图脚本）
```

</details>

## 关于作者

**花叔 Huashu**——AI Native Coder，独立开发者。代表作：小猫补光灯（App Store 付费榜 Top1）。

| 平台 | 链接 |
|------|------|
| 🌐 官网 | [bookai.top](https://bookai.top) · [huasheng.ai](https://www.huasheng.ai) |
| 𝕏 Twitter | [@AlchainHust](https://x.com/AlchainHust) |
| 📺 B站 | [花叔](https://space.bilibili.com/14097567) |
| 📕 小红书 | [花叔](https://www.xiaohongshu.com/user/profile/5abc6f17e8ac2b109179dfdf) |
| 💬 公众号 | 微信搜「花叔」 |

更多 AI 造物：[女娲.skill](https://github.com/alchaincyf/nuwa-skill)（蒸馏任何人的思维方式）· [huashu-design](https://github.com/alchaincyf/huashu-design)（一句话拿回一份能交付的设计）

---

<div align="center">

**Finder** manages your files. **IDEs** write your code.<br>
**FanBox** shows you what AI did on your machine.<br><br>

**Finder** 帮你管理文件。**IDE** 帮你写代码。<br>
**FanBox** 帮你看清 AI 在你机器上干了什么。<br><br>

MIT License © [花叔 Huashu](https://github.com/alchaincyf)

</div>
