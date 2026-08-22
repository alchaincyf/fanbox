# FanBox 跨平台 + 網頁完整版 · 路線圖(map)

## Destination

FanBox 全功能跨平台:macOS(arm64)+ Linux(主流 glibc)官方桌面版,加上功能完整的網頁版(真實終端 + 編輯器 + agent 控制,LAN 可達、密碼認證)。map 走完時,跨平台與網頁版的實作決策全部鎖定,可直接移交實作。

## Notes

領域:零依賴 Node `server.js` + Electron 33 + node-pty + xterm.js / Monaco / Milkdown(vendor 在 `public/vendor/`)。skills:有疑慮一律先讀 grilling + domain-modeling;研究型 ticket 用 research;需要具體物再上 prototype。

Charting 期間用戶已拍板的決策(不再重開):

- 網頁完整版 = 真實終端 + 編輯器 + agent 控制(`/api/agent/*` 帶進網頁版,登入 session 即門票)
- 網頁版可 LAN 訪問;認證 = 登入密碼 + session cookie;預設只綁 loopback,設定頁可開 LAN(帶警告);傳輸安全方案未定 → ticket 04
- Linux:主流 glibc 發行版,AppImage + deb;Ubuntu 24.04 主驗證,Debian / Arch 冒煙
- macOS:只 arm64,未簽名 dmg(無 Apple Developer 帳號,使用者右鍵開啟)
- Linux 檔案監聽引 chokidar;截圖用 inotify 盯常見截圖目錄;防休眠進 map(排最後)
- 更新提示指到 fork 的 GitHub Releases
- 個人 fork,自己發布;不 merge 上游
- 文件語言:全轉繁體
- Windows / Intel Mac / 公網訪問:out of scope

既定偏好:

- 驗收沿用 `docs/05`:五角色 subagent 評分 ≥90 且無紅線
- 零依賴哲學:網頁完整模式允許新增 runtime 依賴(ws / chokidar),但維持「本地、離線可用、資料不出網(除 LAN 模式)」
- repo 無 CONTEXT.md;出現新領域詞彙時依 domain-modeling 就地建立

## Decisions so far

<!-- 每條 closed ticket 一行:gist + 連結。research subagent 完成後由它們補上 -->

- [網頁版瀏覽器端能力事實研究](issues/01-browser-capabilities.md):LAN http 下 Clipboard API / Notification / Service Worker 不可用、Fullscreen / WebGL2 / WS / SSE 可用;Node 無原生 WS server(要 `ws` 8.21.3 或手寫握手);TLS 是解鎖 secure context 的關鍵開關。詳見 docs/14
- [打包與發布矩陣事實研究](issues/08-linux-packaging.md):AppImage+deb 可行(deb 需補 author、AppImage 要 FUSE);node-pty 無 Linux prebuild 但 N-API 免重編;macOS 未簽名=拔 identity/notarize;更新檢查改 fork 的改點在 main.js L174/179/253。配置草案詳見 docs/15
- [Linux 現版冒煙與移植修補清單](issues/02-linux-smoke.md):Linux 上 server/前端/trash/usage 全 PASS;三處硬 macOS 依賴需修 — 縮圖(sips/qlmanage→ffmpeg/pdftoppm)、which 探測(/bin/zsh→$SHELL)、pty shell fallback(補 /bin/bash);mdfind/遞迴 watch/open -Ra 屬已知降級。詳見 ticket Answer

## Not yet specified

- 網頁版編輯器寫盤路徑(Monaco / Milkdown 保存走 `/api/write` 還是保留 fanboxFs 橋)— 待 ticket 03 邊界定
- 微信 ClawBot 遠程控制(wechat 層)在網頁版 / Linux 的搬遷 — 依賴 03 邊界 + 02 冒煙結果
- 終端錄影黑匣子(asciinema)在網頁版的重放 / 錄製落點 — 依賴 03
- fork 品牌與命名(productName / 圖示沿用?)與版本號策略 — 併入 ticket 09 打包確認

## Out of scope

- Windows 官方支援(社區移植繼續)— charting Q4 拍板
- Intel Mac(`docs/10` 已評低風險,但用戶選擇只維護 arm64)— charting Q1B
- 公網 / 雲端訪問(超出 LAN)— charting Q2 拍板;若未來要做,是全新 effort
- 多使用者 / 帳號系統 / 雲同步 — 超出本地-first 哲學
- 手機原生 app — 無人要求
