# 網頁版功能邊界矩陣

Type: grilling
Status: resolved
Blocked by: 01

## Question

網頁完整版(瀏覽器連 LAN 或 localhost 的 FanBox)要包含哪些能力?逐項三選一:**完整 / 降級 / 不進網頁版**:

- 真實終端(PTY over 網路通道)— charting 已定「進」,通道形式待 05
- 編輯器:Monaco / Milkdown 寫盤路徑(fanboxFs 橋 → `/api/write`?原子寫與 guardDirty 語義)
- 檔案監聽 / 跟隨模式(agent 改檔即時刷新)— 網頁版用哪種推送?
- agent 控制介面(`/api/agent/*`)— charting 已定「進」;session 即門票
- 截圖直通卡(瀏覽器無法監聽系統截圖 → 手動上傳?)
- 終端錄影:錄製與回放(黑匣子搬 server?)
- 系統通知(非安全上下文限制,見 01)
- 拖放存盤(File API / 目錄寫入)
- 剪貼板複製圖片 / 檔案(受限,見 01)
- 電源 / 防休眠:桌面 only,不進
- 微信 ClawBot 遠程控制(wechat 層搬 server.js?或網頁版不做)

依 01 的事實 + 你的工作流偏好,給每項定案並說明理由。

## Answer

grilling 全走推薦。網頁完整版功能邊界如下(三項 charting 已定:真實終端「進」、agent 控制介面「進」、電源/防休眠「不進」):

| 功能 | 決策 | 備註 |
|---|---|---|
| 編輯器 | **進(完整)** | 寫盤走 `/api/write`(expectedMtime 衝突偵測保留);Milkdown 插圖降級 `<input type=file>` → `/api/image-save` |
| 檔案監聽/跟隨模式 | **進(完整)** | server.js 起 chokidar 監聽 + 事件推送(通道歸 05) |
| 截圖直通卡 | **降級** | 手動選圖/拖圖 → 存 `素材/` → 直通卡 → 餵終端;缺自動偵測 |
| 終端錄影 | **進,排後** | 錄製搬 server(pty 位元組天然過它);回放 xterm 自繪 .cast,不引新 vendor |
| 系統通知 | **降級** | 非安全上下文頁內 toast;HTTPS 後 Notification 自動恢復(零改碼) |
| 拖放存盤 | **進** | fetch 上傳;可能新增通用二進位上傳端點(現 `/api/write` 文字、`/api/image-save` 圖片) |
| 剪貼板 | **降級** | 文字複製貼上可用(xterm 內建 + execCommand);圖片/檔案複製桌面 only |
| 微信 ClawBot | **不搬** | 手機瀏覽器開網頁版(LAN + 04 認證)即遠程控制路徑;wechat 層維持桌面 |

執行註記:多項降級/新增端點是實作細節,進 handoff 規格;05 解除阻塞(PTY 通道形式待定)。
