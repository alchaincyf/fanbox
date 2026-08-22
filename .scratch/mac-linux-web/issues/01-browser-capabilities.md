# 網頁版瀏覽器端能力事實研究

Type: research
Status: open
Blocked by: —

## Question

網頁完整版在瀏覽器(LAN `http://` 非安全上下文)的能力事實,供 ticket 03 功能邊界與 ticket 04 認證 / TLS 決策使用:

1. `navigator.clipboard` 在非安全上下文(`http://192.168.x.x`,非 localhost)是否可用?需要什麼條件(secure context / permission)?降級方案(execCommand 等)?
2. Notification API / Fullscreen API 在非安全上下文的限制?
3. xterm.js 在純瀏覽器環境的已知注意事項:WebGL addon 可用性、IME / 中文輸入、剪貼板事件、scrollback 效能
4. Node.js http 模組原生做 SSE 的可行性與緩衝行為;Node 原生 WebSocket server 是否內建(預期:無)?`ws` 套件現狀
5. 瀏覽器 WebSocket 連 LAN 的 mixed-content / CORS 考量
6. Service Worker / PWA 在非安全上下文不可用?對本專案是否相關

產出:事實清單 + 每條出處(MDN / 官方文件 / 源碼)。
