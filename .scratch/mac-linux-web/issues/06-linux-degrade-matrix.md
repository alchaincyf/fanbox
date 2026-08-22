# Linux v1 功能降級矩陣

Type: grilling
Status: resolved
Blocked by: 02

## Question

依 02 冒煙結果,定 Linux v1 的功能降級矩陣 — 逐項:**重寫等價物 / 降級 / 砍**:

- 全域同名搜尋(mdfind 只有 mac)— locate?GNOME tracker?降級只在已遍歷範圍搜?
- 桌面 app 探測(`open -Ra` 只有 mac)— 只測 bins(`command -v`,已覆蓋 claude / codex)?掃 `.desktop`?
- 開外部終端(`x-terminal-emulator` 分支已存在 — 冒煙結果?)
- ffmpeg 路徑(`/usr/bin` 已覆蓋?)
- pty spawn shell fallback(zsh → SHELL / bash)
- `command -v` via `/bin/zsh` → `/bin/sh`
- 其他 02 冒出的壞點

## Answer

grilling 全數走推薦,決策如下(**= Linux v1 修補規格,可直接移交實作**):

1. **縮圖 → 平台分派**:darwin 維持 sips/qlmanage;Linux 用 `ffmpeg`(圖片縮放 + 影片抽幀)+ `pdftoppm`(PDF 首頁→圖);工具缺失維持現有 415 降級。改點:`server.js:1396` `generateThumb`。
2. **agent 探測 → 平台分派**:Linux 走 `process.env.SHELL` → 兜底 `/bin/bash` → `/bin/sh` 的 login shell `command -v`;darwin 維持 zsh。改點:`server.js:514` `findAgentBin`。
3. **pty/wechat shell fallback → fallback 鏈補 `/bin/bash`**:`SHELL || (/bin/bash || /bin/sh)`,`-l` 照用;三處同源 — `electron/main.js:581`、`electron/wechat/env.js:11`、`electron/wechat/driver.js:7`。
4. **mdfind 全域同名搜尋 → Linux 降級接受**:只靠 walk,docs 註記「全域同名搜尋僅 macOS」;不引 locate/tracker。改點:無(現狀),僅文件。
5. **桌面 app 探測 → Linux 掃 `.desktop`**:掃 `/usr/share/applications` + `~/.local/share/applications` 比對 Name/Exec;bins 維持 command -v。改點:`server.js:2690` `/api/agents/which` 的 apps 分支。

已定不需決:開外部終端維持 `x-terminal-emulator → gnome-terminal → xterm` 鏈(環境依賴,非 bug);ffmpeg `/usr/bin` 已被 findFfmpeg 覆蓋;gio trash 家目錄正常。
