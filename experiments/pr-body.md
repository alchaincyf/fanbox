完整把 FanBox 移植到 Windows 了，从 master 出发独立做的，mac 那边的逻辑都用平台判断保留着，没动。

看到已经有 #10 和 #24 两个 Windows 的 PR，这俩主要覆盖了桌面壳（标题栏、剪贴板、截图目录）和打包。不过它们都没动 `server.js`，所以装上虽然能开，但**后端那几样还是坏的**——图片/视频缩略图走的 sips/qlmanage、磁盘占用的 du、AI 整理找 claude/codex 用的 `/bin/zsh command -v`，这些 Windows 上都没有，会静默失败。这个 PR 把后端也一起补了，整个工具在 Windows 上是真的能用，不只是「能打开」。

补的几块：

- **缩略图**：sips 换 PowerShell 的 System.Drawing，视频/PDF 换 ffmpeg 抽帧（PDF 没原生工具就走图标兜底）
- **HEIC**：ffmpeg → System.Drawing → 415 三级兜底，能不能解看系统装没装 HEVC 解码器
- **磁盘占用**：du 换纯 Node 递归（du 口径，算全，含 node_modules）
- **找 agent**：`command -v` 换 `where.exe`
- **终端当前目录**：lsof 那套 Windows 没有，拿 spawn 起始目录兜着（conpty 拿不到 shell 实时 cwd）
- **复制文件到剪贴板**：PowerShell 的 SetFileDropList（被别的程序占着剪贴板会重试一次）
- **前端**：一堆 `split('/')` 改成同时认反斜杠，⌘→Ctrl、废纸篓→回收站（写了个跟 i18n 一样的 observer），相对路径判断补了盘符
- **截图直通车**：监听 `Pictures\Screenshots` 和 OneDrive 下，Win+PrintScreen 的截图照样能浮出直通卡

过程中还踩到一个 master 里的 bug：`/fs/` 路由的 `slice(3)` 在 mac 上凑巧能用，在 Windows 上把 `/fs/D:/code/x` 切成 `/D:/code/x` 当相对路径，导致 md 和 html 预览里的本地图片全 404。改成 `slice(4)` 加按平台补回开头斜杠。

测试我没只测接口——用 Playwright 驱动真 app 跑了一遍，15 项全过：平台识别、9 个 IPC 桥接、文件列表、缩略图实际解码（4/4 不裂图）、终端 spawn 到回显的全链路、Monaco、Milkdown、零渲染报错，截图直通车也单独测了。打包也试了，`npm run dist:win` 出 NSIS 安装包，装上能跑。

还有几个没搞定的，老实说一下：
- HEIC 靠系统 HEVC 解码器，没装就显示图标（本机 ffmpeg 也没 heif demuxer，救不了）
- 合盖不休眠、微信 ClawBot 太 mac 了，跳过没动
- Windows 版没签名，SmartScreen 第一次会弹（这个得有证书才干净）
- 终端里打印的 Windows 路径现在能点了（之前只能点 / 形式的）

node-pty 我发现 1.x 是 N-API 预编译的，Electron 直接加载、不用 rebuild，README 里那条 `npm run rebuild` 在 Windows 上反而会失败（但不影响），顺手在文档里说明了。

改动大概 +600 行，跨 server.js / electron/main.js / 前端 / 打包配置。要是 #10 或 #24 你更想合并，我这边后端那部分（server.js）也可以单独拆出来给它们补，都行。
