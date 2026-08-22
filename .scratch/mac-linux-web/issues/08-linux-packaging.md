# 打包與發布矩陣事實研究

Type: research
Status: resolved
Blocked by: —

## Question

打包與發布矩陣的事實研究,供 09 確認:

1. electron-builder Linux target:AppImage + deb 的配置(icon、category、artifactName、asarUnpack node-pty 在 linux 的寫法);Ubuntu 24.04 / Debian / Arch 上 AppImage 的 FUSE 需求(新版 AppImage 還需 FUSE?)
2. node-pty 在 Linux 的 prebuild 是否覆蓋 Electron 33 ABI,還是要 electron-rebuild;x64 / arm64
3. macOS 未簽名 dmg:electron-builder mac 配置去掉 identity / notarize 的寫法;arm64 only;Gatekeeper 右鍵開啟的實際行為
4. GitHub Actions 矩陣:ubuntu-latest + macos-14(arm64)建置;electron-builder 在 CI 的 cache(node-pty rebuild);artifact 上傳 releases
5. 更新機制現況(`main.js` checkUpdate 讀哪個 repo)改成 fork repo 的配置點
6. Wayland:Electron 33 的 ozone 現況、xterm WebGL 在 Wayland 的已知問題
7. 圖示:linux 需要哪些尺寸;現有 `build/icon.png` 可用?

產出:事實 + 推薦的 build 配置草案(electron-builder 配置片段)。

## Answer

Linux AppImage + deb 可行,配置草案在 docs/15;唯一實質坑是 **node-pty 無 Linux prebuild**(1.0.0 零 prebuild、1.1.0 只有 darwin/win32),但它是 N-API,用系統 Node 編一次 Electron 直接能用,`rebuild:pty` 在 Linux 是多餘的;使用者需編譯工具鏈(python3/make/g++),README 要寫。deb 需補 package.json `author`;AppImage 在 Ubuntu 24.04 要 `libfuse2t64`、Arch 要 `fuse2`。macOS 未簽名 = 移除 identity/notarize/hardenedRuntime/gatekeeperAssess,右鍵開啟體驗。更新檢查改 fork:main.js 三處硬編碼(L174/179/253)換 repo。Wayland 需 `ELECTRON_OZONE_PLATFORM_HINT=auto`(預設 x11);xterm WebGL2 在 Wayland 有渲染損壞 issue,保留 DOM renderer 降級。完整:docs/15-打包與發布矩陣研究.md(研究分支 research/linux-packaging)。
