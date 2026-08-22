# 網頁版功能邊界矩陣

Type: grilling
Status: claimed
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
