# 網頁版瀏覽器端能力事實研究

Type: research
Status: resolved
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

## Answer

LAN http(非安全上下文)下:`navigator.clipboard`、Notification、Service Worker 不可用(secure-context 限制),Fullscreen / WebGL2 / WebSocket / SSE 可用;xterm 內建複製貼上(textarea + execCommand)是剪貼板降級路。Node 無原生 WS server(內建 WebSocket 是 client-only 實驗功能),要 `ws` 8.21.3 或手寫 upgrade 握手;SSE 純 HTTP 可行。insecure→insecure 非 mixed content,local→local 不受 LNA gate。**TLS(自簽 HTTPS)是解鎖 clipboard / Notification 的關鍵開關** → 直接餵 ticket 04。完整細節:docs/14-網頁版瀏覽器能力研究.md(研究分支 research/browser-capabilities)。
