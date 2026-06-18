## 一句话

基于 v1.13.0 完整移植到 **Windows**（x64），mac 行为零回归，已能产出可用安装包。想问问花叔愿不愿意收，愿意的话我立刻提 PR。

## 为什么

FanBox 的核心链路（文件找回 → 预览 → 内嵌终端跑 agent → 看改了什么）在 Windows 上同样刚需，但目前只发了 macOS arm64 dmg。我手上是 Windows 机器，就照着源码做了 Windows 版。

## 做法（尽量顺着作者已有的设计）

读源码时发现 **作者其实已经埋了大量 win32 分支**（`trashPath` 的 PowerShell 回收站、`openInOS` 的 `start`、`openInOS terminal` 的 `cmd /K`、`pty:spawn` 的 `powershell.exe`、路径面包屑的盘符处理、`claudeOAuthToken` 的凭证文件兜底、`contentSearch` 的 grep 兜底）。所以移植主要是补缺口，不是重写：

| 缺口 | macOS | Windows 方案 |
|------|-------|------------|
| 磁盘占用 | `du -sk` | 纯 Node 递归求和（du 口径，算全含 node_modules） |
| 图片缩略图 | `sips -Z` | PowerShell `System.Drawing` 缩放 |
| 视频缩略图 | `qlmanage` | ffmpeg 抽帧 |
| HEIC 转码 | `sips` | ffmpeg(heif)→System.Drawing→415 三级兜底 |
| 找 agent bin | `/bin/zsh -lc command -v` | `where.exe` |
| 终端当前目录 | `lsof -a -p PID -d cwd` | spawn 起始目录兜底（conpty 拿不到 shell 实时 cwd） |
| 复制文件到剪贴板 | `osascript` | PowerShell STA `Clipboard.SetFileDropList` |
| 前端路径 | 硬编码 `split('/')` | 加跨平台工具 `pathSplit/isAbsPath/joinPath` |
| `⌘` / 「废纸篓」「访达」文案 | mac 习惯 | 照搬 i18n 的 MutationObserver 做 platform-l10n，win32 下 ⌘→Ctrl、废纸篓→回收站 |

另外**修了一个原代码里的真实 Windows bug**：`/fs/` 路由的 `p.slice(3)` 在 mac 上巧合保留开头 `/`，在 Windows 上 `/fs/D:/code/x` 被切成 `/D:/code/x` 当相对路径拼到主目录 → 所有 md/html 预览的本地图片 404。改成 `slice(4)` + POSIX 补回开头 `/`。

## 测试（不是嘴说，都跑了）

写了个 Playwright 脚本驱动**真实 app**（不是 mock）逐项验证，**15/15 通过**：
平台识别 / 9 个 IPC 桥接 / 文件列表渲染 / 盘符面包屑 / platform-l10n(⌘→Ctrl 实际生效) / **assets 缩略图 4/4 解码不裂图** / **终端 spawn→收数据→echo 回显全链路** / Monaco / Milkdown / 渲染层零 console error。

后端 API（git diff、内容搜索、agent 项目/记忆/用量、skills、release、回收站删除）也都在 Win 上逐个 curl 过。

打包：`electron-builder --win` 产出 `FanBox-Setup-1.13.0-x64.exe`（NSIS），启动验证后端 + 终端 + 缩略图都正常。

## 已知限制（诚实交代）

1. **HEIC 预览**依赖系统是否装了 HEVC 图像扩展（多数 iPhone 用户的 Win 已有），没装则显示图标。
2. **终端 scrollback 里 `C:\code\x` 路径**点不开（链接检测 regex 强依赖 `/`，且 `C:` 的冒号在切断集里）—— `/` 形式的 agent 路径正常可点。这个我能继续调。
3. **合盖不休眠 / 系统截屏直通车 / 微信 ClawBot** 是 mac 专属能力，Windows 上整块优雅跳过。
4. Windows 版**未签名**（SmartScreen 会首次警告）——这个得花叔你有 Windows 代码签名证书才干净。

## 关于 node-pty（顺便提一句）

发现 `node-pty` 1.x 是 **N-API 预编译**，Electron 直接加载、**不需要 `npm run rebuild`**。README 里那条 `npm run rebuild` 在 Windows 上没装 VS Build Tools 时会失败，但其实不影响终端工作——要不要顺手在 README 给 Windows 用户加个说明？

## 请求

- 这套 Windows 支持你愿意收吗？
- 愿意的话我立刻 fork + 提 PR（带完整描述、测试脚本、文档）。
- 改动量：6 个原子提交，约 +567 行，跨 server.js / electron/main.js / public(app.js + 新增 platform-l10n.js + index.html + style.css) / package.json / README / docs。mac 专属路径全部用平台分支保留，未动 mac 行为。

谢谢花叔造的这个工具，真挺好用。
