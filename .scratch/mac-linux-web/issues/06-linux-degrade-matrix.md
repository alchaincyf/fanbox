# Linux v1 功能降級矩陣

Type: grilling
Status: open
Blocked by: 02

## Question

依 02 冒煙結果,定 Linux v1 的功能降級矩陣 — 逐項:**重寫等價物 / 降級 / 砍**:

- 全域同名搜尋(mdfind 只有 mac)— locate?GNOME tracker?降級只在已遍歷範圍搜?
- 桌面 app 探測(`open -Ra` 只有 mac)— 只測 bins(`command -v`,已覆蓋 claude / codex)?掃 `.desktop`?
- 開外部終端(`x-terminal-emulator` 分支已存在 — 冒煙結果?)
- ffmpeg 路徑(`/usr/bin` 已覆蓋?)
- pty spawn shell fallback(zsh → SHELL / bash)
- `command -v` via `/bin/zsh` → `/bin/sh`
- 其他 02 冒出的壞點
