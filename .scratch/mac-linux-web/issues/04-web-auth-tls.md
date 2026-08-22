# 網頁版認證與傳輸安全設計

Type: grilling
Status: open
Blocked by: 01

## Question

網頁完整版的認證與傳輸安全設計:

1. 密碼:首次啟動生成隨機密碼存 `~/.fanbox/webpass`(原子寫,同 config)?設定頁可改?長度 / 格式?
2. Session:HttpOnly + SameSite cookie?過期策略?
3. CSRF:同源檢查 + 自訂 header?
4. Host 校驗現狀(擋 DNS rebinding)在 LAN 模式怎麼放寬(允許 127.0.0.1 + 本機 LAN IP + Host 白名單)?
5. TLS:LAN 明文 http + 密碼(傳輸裸奔)vs 自簽 HTTPS(瀏覽器警告)vs mkcert / 受信任 CA(要使用者裝根憑證)?依 01 的非安全上下文事實決
6. 失敗鎖定 / 暴力破解防護(本地服務需要嗎?)
