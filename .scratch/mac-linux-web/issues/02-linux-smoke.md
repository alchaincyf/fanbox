# Linux 現版冒煙與移植修補清單

Type: task
Status: resolved
Blocked by: —

## Question

在 Linux 上對現版 FanBox 做冒煙,產出「現況壞點 / 降級點」清單,餵 ticket 06 Linux 降級矩陣決策:

1. `node server.js` 起服務,驗證 `/api/roots`、`/api/search`、`/api/content`、`/api/write`、`/api/trash`(gio trash 分支)、縮圖
2. 前端 assets 載入、三皮膚、預覽(Markdown / HTML / 圖 / PDF / video)
3. Electron 打包前檢查:node-pty linux 依賴、有 display 時 `npm run app` 是否可起
4. 逐條驗證移植清單(來自 `docs/10` + 已知):pty spawn shell fallback(無 SHELL 時 `/bin/zsh` 缺失)、`server.js` `command -v` via `/bin/zsh`、mdfind 分支行為、`open -Ra` app 探測行為、ffmpeg 路徑、claude 憑證路徑、`$SHELL -ilc env`(wechat)、fs.watch recursive 降級
5. 記錄 Arch 以外的預期差異(Ubuntu 24.04 需另測或標註)

產出:逐項 PASS / FAIL / DEGRADE + 證據。完成後把結果寫進本 ticket 的 Answer。

## Answer

冒煙於 Arch(glibc、headless、node v26.7.0、zsh 未裝、node_modules 未裝)實跑。**PASS**:server.js 零依賴啟動,`/api/roots`(中文本地化 roots)/`list`/`read`/`search`/`content`(全文)/`du`/`agents`/`agent-usage`/`term-verify` 全正常;Host 校驗 403 生效;前端全資產 200、頁面渲染 12 列、xterm/marked/hljs vendor 全載、三皮膚切換正常(dataset.theme + hljs 主題連動);家目錄 trash 走 gio 成功(進 ~/.local/share/Trash);`$SHELL -ilc env`(bash)正常;claude 憑證走非 darwin 路徑(~/.claude/.credentials.json,缺席時優雅回 null);ffmpeg 在 /usr/bin(被 findFfmpeg 覆蓋);node-pty 編譯工具鏈齊(python3/make/g++)。

**FAIL(進 06 降級矩陣,需修)**:
1. **縮圖全掛**:`generateThumb`(server.js:1396)硬綁 macOS `sips`(圖片)+ `qlmanage`(影片/PDF)— Linux 上 /api/thumb 全 415,前端降級成向量圖示(不崩但無縮圖)。修法:平台分派,Linux 用 ffmpeg(在)縮圖 + pdftoppm(在)抽 PDF 幀。
2. **which 探測全 false**:`findAgentBin`(server.js:514)硬編 `/bin/zsh -lc command -v`,zsh 缺失 → bash/git/node/claude/codex 全測不到,agent 啟動面板顯示「全未安裝」。修法:走 `$SHELL` 或 `/bin/sh -lc`。
3. **pty spawn shell fallback**(electron/main.js:581):GUI 啟動 SHELL 常缺 → 落到 `/bin/zsh`(Linux 無)→ 終端起不來。修法:fallback 鏈加 `/bin/bash`。

**DEGRADE(已知/可接受)**:mdfind Spotlight 兜底僅 darwin(Linux 只靠 walk 搜尋,無 crash);`open -Ra` app 探測 Linux 全 false(bins 才是真探測);fs.watch recursive 在 Linux 已降級非遞迴(main.js:1082,跟隨模式漏子目錄);外部終端開啟需 x-terminal-emulator/gnome-terminal/xterm(本機全無,桌面發行版有 gnome-terminal,環境依賴);gio 拒 trash tmpfs 掛載點(/tmp,掛載策略屬預期,家目錄正常)。**未測**:Electron app 本體(headless 無 DISPLAY + node_modules 未裝,需 npm install ~百 MB)— 打包/安裝鏈另由 08/09 覆蓋。

環境註記:Arch 與目標 Ubuntu 24.04 同為 glibc,上述 FAIL/DEGRADE 結論對 Ubuntu 同樣成立(工具存在性以 Ubuntu 預設套件為準,如 gnome-terminal、gio)。
