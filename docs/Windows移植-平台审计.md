# FanBox Windows 移植 · 平台审计报告

> 审计日期 2026-06-17 · 分支 `windows-port` · 基于 v1.13.0 (master @ 3d091ba)
> 目标：让 FanBox 在 Windows 上真实、完整、可用。

## 0. 架构与移植边界

FanBox 双运行模式，给了移植清晰边界：

| 模式 | 启动 | 能力 | 跨平台难度 |
|------|------|------|-----------|
| **网页** | `node server.js` | 浏览/搜索/预览/缩略图（零依赖，纯 Node） | 中 |
| **桌面** | `electron .` | 网页全部 + 内嵌终端 + 编辑器 + 原生能力 | 高（node-pty 原生模块） |

**好消息**：作者写代码时已经埋了大量跨平台分支（trash / opener / open-terminal / pty-shell / 路径面包屑 / OAuth 凭证文件兜底 / content-search grep 兜底）。剩余缺口是明确的、可枚举的。

## 1. 本机环境实测（2026-06-17）

| 项 | 状态 | 说明 |
|----|------|------|
| Node / npm | v23.2.0 / 11.2.0 | 满足 `>=18` |
| `node_modules` | 需 `npm install` | server.js 零依赖，网页模式不用等 |
| `sips` | ❌ 缺 | 图片缩略图 + HEIC 转码会断 |
| `qlmanage` | ❌ 缺 | 视频/PDF 缩略图会断（前端有图标兜底） |
| `du` | ⚠️ 仅 Git Bash `/usr/bin/du` | **打包后双击启动 PATH 里没有**，需 Node 兜底 |
| `mdfind` | ❌ 缺 | 内容搜索退 grep（已实现，OK） |
| `lsof` | ❌ 缺 | 终端当前目录定位会断 |
| `osascript` | ❌ 缺 | 复制文件到剪贴板（mac 实现）会断 |
| `magick` | ❌ 缺 | 无 ImageMagick 兜底 |
| **`ffmpeg`** | ✅ Scoop shim（系统 PATH） | 视频缩略图 + 导出可用，可试 HEIC |
| **`powershell` + `pwsh`** | ✅ 都在 | 缩略图/剪贴板/回收站全走 PowerShell |
| **`claude` + `codex`** | ✅ Scoop nodejs | agent 驾驶舱可用（但 `findAgentBin` 找不到） |
| `git`/`tar`/`unzip`/`curl` | ✅ Git Bash 提供 | 打包后 `tar` 走 System32 自带 bsdtar，OK |

**PATH 关键约束**：开发时从 Git Bash 跑，PATH 含 `/usr/bin`（du/tar/unzip）；打包成 exe 双击启动，PATH 只有 Windows 系统 PATH（无 `/usr/bin`）。Scoop shim（ffmpeg/claude/codex）在系统 PATH，可靠。**移植代码必须假设只有 PowerShell/cmd 是必定可用的**。

## 2. 后端 server.js 缺口清单

| # | 功能 | 位置 | Mac 实现 | Win32 现状 | 修法 |
|---|------|------|----------|-----------|------|
| B1 | 磁盘占用 `du` | L786-808 `diskUsage` | `du -sk` | 无分支，execFile 失败 | 加 win32 分支：纯 Node 递归求和（复用 walk 思路 + 截止时间） |
| B2 | 图片缩略图 | L1174 `generateThumb` | `sips -Z` | 无分支，抛错→415 | win32：PowerShell `System.Drawing` 缩放存 jpeg/png |
| B3 | 视频/PDF 缩略图 | L1180-1188 | `qlmanage` | 无分支 | win32：视频走 ffmpeg 抽帧；PDF 跳过（前端显示图标，PDF 预览本身走浏览器原生） |
| B4 | HEIC 转码 | L1234 `serveHeicAsJpeg` | `sips` | 无分支 | win32：ffmpeg（若带 heif）→ 失败回 415 |
| B5 | 找 agent bin | L511 `findAgentBin` | `/bin/zsh -lc command -v` | 失败 | win32：`where.exe name` |
| B6 | 发版检测 gh | L602 `releaseInspect` | `/bin/sh -lc command -v gh` | 失败 | win32：`where.exe gh` |
| B7 | findAgentBin 兜底 | — | — | — | 退回到 PATH 直查 `name`/`name.cmd` |

已就绪（无需改）：B-OK1 `trashPath`（已有 PowerShell `Microsoft.VisualBasic ...SendToRecycleBin`）、B-OK2 `openInOS`/`openDefault`（已有 `start`/`explorer /select,`）、B-OK3 路径面包屑（已有盘符）、B-OK4 `contentSearch`（mdfind 失败退 grep）、B-OK5 `claudeOAuthToken`（Keychain 失败退 `~/.claude/.credentials.json`）、B-OK6 opener。

## 3. Electron main.js 缺口清单

| # | 功能 | 位置 | Mac 实现 | Win32 现状 | 修法 |
|---|------|------|----------|-----------|------|
| E1 | 终端当前目录 | L690 `pty:cwd` | `lsof -a -p PID -d cwd` | 失败（无 lsof） | win32：返回 spawn 时的 startCwd（尽力而为；conpty 拿不到 shell 实时 cwd，已记录限制） |
| E2 | 复制文件到剪贴板 | L490 `clip:file` | `osascript` POSIX file | 失败 | win32：PowerShell STA + `System.Windows.Forms.Clipboard.SetFileDropList` |
| E3 | ffmpeg 查找 | L603 `findFfmpeg` | homebrew 路径 | 返回 null | 加 Scoop/choco/`where ffmpeg` |
| E4 | 窗口外观 | L42-54 | `titleBarStyle:'hiddenInset'` + `vibrancy:'sidebar'` | mac-only 选项被忽略/异常 | win32：用默认标题栏（最稳）；CSS 去掉 40px 红绿灯留白 |
| E5 | 截屏直通车 | L106 `startShotWatch` | darwin-guarded | 整块跳过 | win32：可选，监听「图片/屏幕截图」文件夹（Win+PrintScreen 落 `%USERPROFILE%\Videos\Captures` 或 OneDrive/图片）；v1 先留接口不强求 |

已就绪：E-OK1 `pty:spawn` shell（已有 `powershell.exe` + 空参数）、E-OK2 dock icon（darwin-guarded）、E-OK3 pmset 合盖（darwin-guarded）、E-OK4 菜单（已有 isMac 分支）、E-OK5 录像 .cast（纯 Node）。

## 4. 前端 app.js / index.html / style.css 缺口清单

> 前端**完全不做平台探测**，平台/sep 全靠后端 `/api/roots` 返回；快捷键逻辑全用 `metaKey||ctrlKey` 双兼容。这两点是大好事。剩余是硬编码 `/` 与 mac 文案。

| # | 类别 | 位置 | 问题 | 修法 |
|---|------|------|------|------|
| F1 | 路径 | app.js:677 `fsUrl` | `split('/')` 拼 `/fs/` URL，Win 绝对路径切片错、盘符 encode 异常 | 按 sep 切分并 encodeURI |
| F2 | 路径 | app.js:4337-4341 md 图片 src | 全用 `/`，Win 上 md 相对图片全 404 | 同上 + 处理盘符 |
| F3 | 路径 | app.js:2868/3604 进程名 | `split('/').pop()` 取不到 Win basename；shell 白名单漏 `pwsh/powershell.exe/cmd.exe` | `split(/[\\/]/)`；补白名单 |
| F4 | 路径 | app.js:3714/3882 变更过滤 | `filename.split('/')` + mac 噪声目录 | 兼容 `\` + 补 Win 噪声（AppData/$Recycle.Bin 等） |
| F5 | 路径 | app.js:2905 相对路径判断 | `!startsWith('/')&&!startsWith('~')` 把 `C:\` 误判为相对 | 加 `^[A-Za-z]:[\\/]?` 判断 |
| F6 | 默认值 | app.js:186 | `platform:'darwin', sep:'/'` | 改 `sep:''` 让 loadRoots 尽快覆盖（首屏） |
| F7 | 文案 ⌘ | index.html:25,70,148 + app.js 多处 + i18n-dict | 静态 ⌘ 字面量 | `modKey()` 渲染：mac→⌘，win→Ctrl |
| F8 | 文案 | app.js 访达/废纸篓 多处 | 「访达/Finder/废纸篓」 | 平台化：win→「资源管理器/回收站」 |
| F9 | 视觉 | style.css:911-921 + app.js:947 | 40px 红绿灯留白 + trafficLights | win 不留 40px |
| F10 | 素材路径 | app.js:1562/1603 | `state.cwd + '/素材'` | `state.sep + '素材'` |

## 5. 打包缺口

| # | 项 | 修法 |
|---|----|------|
| P1 | package.json `build` 只有 `mac` | 加 `build.win`（nsis x64）|
| P2 | 图标只有 `icon.icns` | electron-builder 可从 256×256+ png 自动生成 .ico（复用 `build/icon-1024.png`） |
| P3 | `dist` script 硬 `--mac` | 加 `dist:win`；保留 `dist`(mac) |
| P4 | node-pty 原生模块 | `npm run rebuild` 在 win 上需 electron ABI 重编；node-pty 1.0.0 可能带预编译，需验证；无编译器则终端不可用（最大风险点） |

## 6. 移植优先级与里程碑

1. **M1 后端 server.js**（B1-B7）→ 网页模式完整可用。**零依赖，立即可测。**
2. **M2 前端 app.js**（F1-F10）→ 路径/文案/快捷键正确显示。
3. **M3 Electron**（E1-E4）→ 终端、剪贴板、ffmpeg、窗口。需 `npm install` 完成。
4. **M4 打包**（P1-P4）→ 产出可用 .exe。
5. **M5 全功能实测** + code review + 文档 + 记忆。

每个里程碑完成即自测 + commit + code review。
