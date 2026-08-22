# 網頁版 PTY 與檔案事件傳輸通道

Type: grilling
Status: resolved
Blocked by: 03

## Question

網頁版終端與檔案事件的傳輸通道設計:

1. 通道:單一 WebSocket(`ws` 依賴)vs 原生 SSE(輸出)+ POST(輸入 / 命令)零新依賴?延遲 / 緩衝 / 連線恢復考量
2. 契約:現有 `window.fanboxPty` 橋(spawn / input / resize / kill / onData / onExit / cwd / proc)+ `fanboxFs.watchSet / onChanged` 的 WebSocket 對等介面;一個通道承載 pty 流 + fs 事件 + agent 控制?
3. 多 tab / 重連(瀏覽器刷新後 pty 存活策略:session 歸屬 server,前端重掛)
4. 安全:WebSocket 的認證(cookie 傳輸?token?)、CSRF over WS
5. node-pty 移到 server.js 後,與 Electron 版共用程式碼(shared module?)還是平行實作?

## Answer

grilling 全走推薦。網頁版傳輸通道決策如下:

1. **通道 = WebSocket(`ws` 依賴,8.21.3)**:雙向低延遲;零依賴哲學在網頁完整模式已放行(ws/chokidar,map Notes)。SSE+POST 被否(契約碎、連線數限制、輸入延遲)。
2. **單一連線 + 訊框 type**:`{type:'pty-data'|'pty-exit'|'fs-changed'|'ack',...}`;spawn/input/resize/kill/cwd/proc 請求-回應帶 id;前端 shim 對映回 `onData/onExit/onChanged` 回調。
3. **Session 歸屬 server,前端重掛**:pty 是 server 進程,瀏覽器斷線不殺;刷新依 session id 續掛;無連線 30 分鐘回收 pty(agent 控制介面 doc 12 精神的延伸)。
4. **WS 認證 = 同源 cookie + Origin 校驗**:04 已定 session cookie,同源 WS 自動帶;server 校驗 Origin(WS 無 CORS,Origin 是防 CSRF 唯一抓手)。
5. **抽 shared module**:pty 管理核心(terminals/termBufs/termWaiters)純化共用,Electron 走 IPC 橋、web 走 WS 橋,同一份底層;桌面冒煙驗回歸。這是 05 最大技術風險(main.js 重構),接受。

前端 shim 契約 = preload.js 的 `fanboxPty`(spawn/input/resize/kill/cwd/proc/onData/onExit)+ `fanboxFs`(watch/watchSet/onChanged)同介面,`term.available()` 檢查 `window.fanboxPty` 即過,app.js 零改動。
