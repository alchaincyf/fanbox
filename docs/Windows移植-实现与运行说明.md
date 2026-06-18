# FanBox Windows 移植 · 实现记录与运行说明

> 分支 `windows-port` · 完成于 2026-06-18 · 基于 v1.13.0
> 配套审计见 [Windows移植-平台审计.md](./Windows移植-平台审计.md)

## TL;DR

FanBox 原为 macOS 专属（arm64 dmg）。本分支在 **mac 零回归**前提下补齐 Windows 支持：
- 网页模式（`node server.js`）：浏览/搜索/预览/缩略图/磁盘透视 全可用
- 桌面模式（`electron .`）：内嵌终端（node-pty conpty）、Monaco/Milkdown 编辑器、剪贴板、文件监听 全可用
- 可打包成 Windows NSIS 安装包（`npm run dist:win`）

实测环境：Windows 11 / Node 23.2 / Electron 33.4.11。

## 关键技术决策（非显然的坑）

### 1. node-pty 无需 `npm run rebuild`（最大误区）
node-pty 1.x 用 **N-API**（`node-addon-api`），`prebuilds/win32-x64/` 里带预编译的 N-API `.node`，ABI 稳定，**Electron 33 直接加载，不需要编译**。原 README 的 `npm run rebuild` 是 Mac 习惯遗留——在 Windows 上没装 VS Build Tools 时会失败，但**完全不影响终端工作**。

实测：`experiments/test-pty-win.js` 在 Electron 主进程 runtime 里 spawn cmd.exe，命令回显正常。

### 2. electron 版本必须钉死才能打包
electron-builder 下载平台专属二进制，要求 `package.json` 里 electron 是**精确版本**（不能是 `^33.2.0` range）。已钉 `33.4.11` + build 配置 `electronVersion` 兜底。

### 3. 大量跨平台分支「原作者已写好」
移植前最担心，实际审计后发现 trash（PowerShell 回收站）、opener（start）、open-in-terminal（cmd /K）、pty shell（powershell.exe）、路径面包屑（盘符）**都已有 win32 分支**。真正缺的只是：sips（缩略图）、qlmanage、du、findAgentBin、lsof、osascript，外加几处前端硬编码 `/`。

## 后端 server.js 改动

| 功能 | Mac | Windows 实现 |
|------|-----|-------------|
| 磁盘占用 | `du -sk` | 纯 Node 递归 `dirSize`（du 口径算全，deadline 截断带 truncated 标记）|
| 图片缩略图 | `sips -Z` | PowerShell `System.Drawing` 缩放（落盘式 `_thumb.ps1` + `-File` argv，规避 quoting）|
| 视频/PDF 缩略图 | `qlmanage` | 视频走 ffmpeg 抽帧；PDF 无原生工具→图标兜底（PDF 预览本身走浏览器原生 viewer）|
| HEIC 转码 | `sips` | ffmpeg(heif)→System.Drawing→415 三级兜底（依赖系统 HEVC 解码器）|
| 找 agent bin | `/bin/zsh -lc command -v` | `where.exe` |
| `/fs/` 路由 | `slice(3)` 巧合保留开头 / | **修了真实 bug**：Win 上 `/fs/D:/x` slice(3)=`/D:/x` 被当相对路径→404；改 slice(4)+POSIX 补回 / |

## Electron main.js 改动

| 功能 | Mac | Windows 实现 |
|------|-----|-------------|
| 窗口外观 | hiddenInset+vibrancy | 原生标题栏（macFrame 三元收敛）|
| 终端当前目录 | `lsof -a -p PID -d cwd` | 存 spawn 起始目录兜底（conpty 拿不到 shell 实时 cwd）|
| 复制文件到剪贴板 | `osascript` POSIX file | PowerShell STA `Clipboard.SetFileDropList`（路径经环境变量，剪贴板被占用自动重试）|
| ffmpeg 查找 | homebrew 路径 | `where.exe` |

## 前端 app.js 改动

- 加跨平台路径工具：`pathSplit`（认 `/` 和 `\`）、`pathBase`、`isAbsPath`（POSIX/UNC/盘符）、`joinPath`（空值守卫）
- 所有硬编码 `split('/')` 改 `pathSplit`：fsUrl、md 图片兜底、终端进程名、变更过滤、du 下钻、follow、外部编辑器重载
- 相对路径判断 `!startsWith('/')` 改 `isAbsPath`（`C:\` 不再误判为相对）
- `state` 默认 platform/sep 按 `navigator.userAgent` 嗅探（首屏即对）
- shell 白名单两处补 `pwsh/powershell.exe/cmd.exe`
- `CHANGE_IGNORE` 补 `AppData/$Recycle.Bin/ProgramData`
- 截图「收进素材」子目录拼接改 `joinPath`

## 新增 platform-l10n.js

照搬 i18n.js 的 MutationObserver 模式，**仅 Windows 启用**：集中改写文本节点 + title/placeholder/aria-label/data-tip 里的 `⌘`→`Ctrl`、`废纸篓`→`回收站`、`访达`→`资源管理器`、`Finder`→`Explorer`。与 i18n 互补、幂等、不死循环。单点覆盖所有静态+动态文案。

CSS：`.desktop #sidebar { padding-top: 40px }` 收敛为 `.desktop.platform-darwin`（Windows 原生标题栏不需红绿灯留白）。

## 运行 / 打包

```bash
npm install
# 国内：electron postinstall 下载需配镜像
ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" npm install

# 网页模式（零依赖，立即跑）
node server.js            # → http://localhost:4567

# 桌面模式（完整功能）
npm run app               # = electron .

# 打包 Windows 安装包
ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/" \
npm run dist:win          # → dist/FanBox-Setup-1.13.0-x64.exe
```

**注意**：Windows 上**不要跑** `npm run rebuild`（会因无 VS Build Tools 失败，且无必要——node-pty N-API 预编译可直接用）。

## 已知限制（非阻断）

1. **HEIC 预览**依赖系统是否装了 HEVC 图像扩展（Win10/11 多数装了，iPhone 用户基本都有）；没装则显示文件图标，不影响其它。（本机 ffmpeg 无 `heif` demuxer，救不了；若用户装了带 libheif 的 ffmpeg 会自动走它。）
2. **合盖不休眠**（pmset）、**微信 ClawBot**（依赖 itchat/openclaw mac 插件生态）是 mac 专属能力，Windows 上整块跳过（优雅降级，不报错）。
3. **HTML 预览 iframe** 的图片受预览端口 HOME 作用域限制：项目若不在主目录所在盘（如项目在 D:、主目录在 C:），iframe 里的本地图片会被安全策略挡。markdown 图片走主端口 /fs/ 不受此限。
4. Windows 版**未签名**（SmartScreen 首次会警告）——需 Windows 代码签名证书才干净，得作者自己来。

## 本轮（push 前最后一轮）补的

- **终端里的 Windows 路径可点了**：原来 scrollback 链接检测只认 `/`，`C:\code\app.js` 点不开。加了盘符路径专用检测（lookbehind 挡 `http://` 的 `p:` 误伤）+ 修了 `termVerify` 给绝对路径乱拼 cwd 的 bug。regex 单测 + term-verify 接口单测都过。
- **截图直通车支持 Windows**：原来 mac 专属。现监听 `~/Pictures/Screenshots`（Win+PrintScreen）+ `~/OneDrive/Pictures/Screenshots`（OneDrive 接管），新截图同样推 shot:new 浮出直通卡。实测：丢文件进去渲染层收到事件（含空格+括号文件名）。

## 验证矩阵

| 能力 | 验证方式 | 结果 |
|------|---------|------|
| 网页模式 roots/list/du | curl + node probe | ✓ win32 / node_modules 正确 769MB |
| 缩略图 jpg/png/中文空格/视频 | /api/thumb | ✓ 全 200 |
| 回收站删除 | POST /api/trash | ✓ 文件真进回收站 |
| agent bin 检测 | /api/organize/launch | ✓ 找到 claude |
| /fs/ Windows 路径 | node probe | ✓ 修 bug 后 200 |
| Electron 启动 | npx electron . | ✓ 无 node-pty 报错、后端 200 |
| 终端 PTY | experiments/test-pty-win.js | ✓ cmd.exe spawn + 回显 |
| 渲染层 | --enable-logging | ✓ 零 JS 报错 |
| 复制文件剪贴板 | PowerShell 单测 | ✓ SetFileDropList 读回正确 |
| ffmpeg 查找 | where | ✓ D:\Scoop\shims\ffmpeg.exe |
| NSIS 打包 | npm run dist:win | （见构建输出）|
