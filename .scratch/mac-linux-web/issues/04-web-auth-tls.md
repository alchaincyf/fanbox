# 網頁版認證與傳輸安全設計

Type: grilling
Status: resolved
Blocked by: 01

## Question

網頁完整版的認證與傳輸安全設計:

1. 密碼:首次啟動生成隨機密碼存 `~/.fanbox/webpass`(原子寫,同 config)?設定頁可改?長度 / 格式?
2. Session:HttpOnly + SameSite cookie?過期策略?
3. CSRF:同源檢查 + 自訂 header?
4. Host 校驗現狀(擋 DNS rebinding)在 LAN 模式怎麼放寬(允許 127.0.0.1 + 本機 LAN IP + Host 白名單)?
5. TLS:LAN 明文 http + 密碼(傳輸裸奔)vs 自簽 HTTPS(瀏覽器警告)vs mkcert / 受信任 CA(要使用者裝根憑證)?依 01 的非安全上下文事實決
6. 失敗鎖定 / 暴力破解防護(本地服務需要嗎?)

## Answer

grilling 全走推薦。網頁版認證與傳輸安全設計如下:

1. **分層密碼**:loopback 免密(現狀);開啟 LAN 模式強制密碼 — 首次自動生成 12 位隨機存 `~/.fanbox/webpass`(原子寫,同 config 做法),設定頁可改/可顯示。
2. **Session = HttpOnly + SameSite=Lax cookie,30 天 sliding 過期 + 登出即失效**;CSRF 靠 SameSite + Origin 校驗(現有 originAllowed 延伸,POST/WS 都驗)+ 登入後要求自訂 header `X-Fanbox-Auth`。
3. **Host 校驗白名單擴展**:本機網卡 IP 集(`os.networkInterfaces()`,執行時枚舉)+ localhost;任意域名(含解析到本機 IP 的)仍拒 — DNS rebinding 防護保留;設定頁顯示當前 LAN 地址。
4. **TLS = v1 明文 http + 密碼**:03 的降級已接受;自家 LAN 嗅探風險低;自簽 HTTPS 警告體驗更勸退。LAN HTTPS 化(自簽/mkcert)進 Not yet specified。
5. **失敗鎖定 = 輕量**:5 次失敗鎖 5 分鐘 + 失敗日誌。

執行註記:設定頁新增「安全」區(顯示/改密碼、開關 LAN、顯示 LAN 地址);`hostAllowed`/`originAllowed` 是改造點;webpass 寫入走現有 updateConfig 原子寫。
