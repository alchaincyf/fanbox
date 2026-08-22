# Linux 現版冒煙與移植修補清單

Type: task
Status: open
Blocked by: —

## Question

在 Linux 上對現版 FanBox 做冒煙,產出「現況壞點 / 降級點」清單,餵 ticket 06 Linux 降級矩陣決策:

1. `node server.js` 起服務,驗證 `/api/roots`、`/api/search`、`/api/content`、`/api/write`、`/api/trash`(gio trash 分支)、縮圖
2. 前端 assets 載入、三皮膚、預覽(Markdown / HTML / 圖 / PDF / video)
3. Electron 打包前檢查:node-pty linux 依賴、有 display 時 `npm run app` 是否可起
4. 逐條驗證移植清單(來自 `docs/10` + 已知):pty spawn shell fallback(無 SHELL 時 `/bin/zsh` 缺失)、`server.js` `command -v` via `/bin/zsh`、mdfind 分支行為、`open -Ra` app 探測行為、ffmpeg 路徑、claude 憑證路徑、`$SHELL -ilc env`(wechat)、fs.watch recursive 降級
5. 記錄 Arch 以外的預期差異(Ubuntu 24.04 需另測或標註)

產出:逐項 PASS / FAIL / DEGRADE + 證據。完成後把結果寫進本 ticket 的 Answer。
