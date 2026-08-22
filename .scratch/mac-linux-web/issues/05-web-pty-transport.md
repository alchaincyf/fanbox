# 網頁版 PTY 與檔案事件傳輸通道

Type: grilling
Status: claimed
Blocked by: 03

## Question

網頁版終端與檔案事件的傳輸通道設計:

1. 通道:單一 WebSocket(`ws` 依賴)vs 原生 SSE(輸出)+ POST(輸入 / 命令)零新依賴?延遲 / 緩衝 / 連線恢復考量
2. 契約:現有 `window.fanboxPty` 橋(spawn / input / resize / kill / onData / onExit / cwd / proc)+ `fanboxFs.watchSet / onChanged` 的 WebSocket 對等介面;一個通道承載 pty 流 + fs 事件 + agent 控制?
3. 多 tab / 重連(瀏覽器刷新後 pty 存活策略:session 歸屬 server,前端重掛)
4. 安全:WebSocket 的認證(cookie 傳輸?token?)、CSRF over WS
5. node-pty 移到 server.js 後,與 Electron 版共用程式碼(shared module?)還是平行實作?
