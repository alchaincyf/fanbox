# 打包與發布矩陣確認

Type: grilling
Status: resolved
Blocked by: 08

## Question

依 08 研究結果確認發布矩陣:

1. 產物:Linux AppImage + deb;macOS 未簽名 arm64 dmg — 確認?
2. 發布渠道:GitHub Releases(fork repo)— 確認?
3. CI:GitHub Actions 建置 — 用 / 不用?
4. fork 品牌:productName 沿用「FanBox」還是改名?圖示沿用?
5. 版本號:fork 從 2.13.0 續還是另起(如 0.1.0)?
6. 更新檢查:指 fork releases;與上游分叉後版本對比邏輯如何不誤導

## Answer

grilling 全走推薦;fork repo = **github.com/botio/fanbox**。決策如下(= fork 發布鏈規格,可移交實作):

1. **產物**:Linux AppImage + deb;macOS 未簽名 arm64 dmg。執行項:package.json 補 `author`(deb 必需,08 研究實測缺了直接報錯)。
2. **渠道**:GitHub Releases on botio/fanbox;`main.js` L174/179/253 三處 `alchaincyf/fanbox` → `botio/fanbox`,抽成頂部常數 `FORK_REPO`。
3. **CI**:GitHub Actions — ubuntu-latest 出 AppImage+deb、macos-14(arm64)出 dmg,自動掛 Release;cache `~/.cache/electron`。
4. **品牌**:productName「FanBox」沿用、圖示沿用(零連動修改)。
5. **版本號**:從 2.13.0 續,fork 首版 **2.14.0**;`cmpVer`(main.js:210)零改動,資產名 `FanBox-2.14.0-arm64.dmg` 與 artifactName 模板天然對上。
6. **Linux 更新 UX**:v1 平台化文案 + 開發布頁(AppImage 用戶下載換檔、deb 走套件管理);自動下載替換留未來 → 進 Not yet specified。
