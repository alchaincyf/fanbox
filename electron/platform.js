'use strict';
// 平台化 login shell 選擇（main / wechat 共用，單一改點）：
// GUI 啟動的 app 繼承的環境極簡，必須走用戶 login shell 帶回 .zprofile/.bash_profile 的
// PATH / 代理 / 全域工具（Homebrew、nvm、npm 等）。macOS 預設 zsh；Linux 未必裝 zsh，
// 依序兜底 $SHELL → /bin/bash → /bin/sh。Windows 無 login shell 機制，走 PowerShell。
function loginShell() {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return 'powershell.exe';
  if (process.platform === 'darwin') return '/bin/zsh';
  try { if (require('fs').existsSync('/bin/bash')) return '/bin/bash'; } catch { /* 兜底 /bin/sh */ }
  return '/bin/sh';
}

module.exports = { loginShell };
