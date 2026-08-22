# Linux 防休眠 / 合蓋續跑機制

Type: grilling
Status: claimed
Blocked by: —

## Question

Linux 版「防休眠 / 合蓋續跑」機制(charting 已定進 map,排最後):

1. 機制:`systemd-inhibit`(用戶層、無 root,`--what=handle-lid-switch:handle-suspend-key` 能擋 lid-close 嗎?需先查事實)vs logind `HandleLidSwitch=ignore`(系統層、要 root)— 先查清再選
2. 權限:pkexec 一次性提權 vs 寫 `/etc/systemd/logind.conf.d/`?vs 只做「不待機」(inhibit 擋 idle suspend)、不做合蓋?
3. 智能模式語義:沿用「開關開 且 有終端忙」才 inhibit,退出即恢復?
4. 與 wechatStayAwake 的關係
5. 桌面環境差異(GNOME / KDE;目標是主流 glibc + systemd,可限定範圍)

備註:`docs/10` 點破 7×24 場景最穩是常駐小主機;Linux 恰好是這場景的天然後台 — 討論時一併考慮。
