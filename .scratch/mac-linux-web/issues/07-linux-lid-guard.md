# Linux 防休眠 / 合蓋續跑機制

Type: grilling
Status: resolved
Blocked by: —

## Question

Linux 版「防休眠 / 合蓋續跑」機制(charting 已定進 map,排最後):

1. 機制:`systemd-inhibit`(用戶層、無 root,`--what=handle-lid-switch:handle-suspend-key` 能擋 lid-close 嗎?需先查事實)vs logind `HandleLidSwitch=ignore`(系統層、要 root)— 先查清再選
2. 權限:pkexec 一次性提權 vs 寫 `/etc/systemd/logind.conf.d/`?vs 只做「不待機」(inhibit 擋 idle suspend)、不做合蓋?
3. 智能模式語義:沿用「開關開 且 有終端忙」才 inhibit,退出即恢復?
4. 與 wechatStayAwake 的關係
5. 桌面環境差異(GNOME / KDE;目標是主流 glibc + systemd,可限定範圍)

備註:`docs/10` 點破 7×24 場景最穩是常駐小主機;Linux 恰好是這場景的天然後台 — 討論時一併考慮。

## Answer

grilling 全走推薦。Linux 防休眠決策如下:

1. **機制 = `systemd-inhibit --what=handle-lid-switch:handle-suspend-key --mode=block`**:進程持有、退出自動釋放、無系統級改動;GNOME 合蓋走 logind,已被查證會擋(systemd.io/INHIBITOR_LOCKS + unix.SE)。實測若某 GNOME 版本繞過,降級 C(只擋 idle)或加 gsettings。
2. **權限 = 零提權**:無 sudo、無 sudoers/osascript 那套 — 相對 macOS 的簡化,記進 README Linux 段。
3. **智能模式語義沿用**:開關開 且(終端忙 || wechatStayAwake 且 wechat 連線)才 inhibit,全退釋放,app 退出釋放;對齊現有 `refreshLidGuard`,平台分派改寫。
4. **wechatStayAwake 沿用**:同一 inhibitor 綁 wechatConnected(wechat 層 Linux POSIX 已驗證)。
5. **範圍 = GNOME 主驗 + KDE 冒煙**;headless 常駐小主機無 lid 事件,只處理 idle 抑制(同一 systemd-inhibit 路)。

執行註記:改點 = `electron/main.js` 的 `trySetDisableSleep`/`refreshLidGuard`/`installSudoers` 平台分派(Linux 走 systemd-inhibit,`--mode=block` 常駐進程持 handle);與 06 的 shell fallback 修補同批。
