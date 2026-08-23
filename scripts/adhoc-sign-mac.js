// macOS 无签名构建的 ad-hoc 签名（ticket 09：等 Developer ID 升级前，先解决
// 浏览器下载带 quarantine 的 app 被判「damaged and can't be opened」直接进废纸篓的问题——
// ad-hoc 签名后降级为可覆写的 Gatekeeper 提示（系统设置 → 隐私与安全性 → 仍要打开）。
exports.default = async function (context) {
  if (process.platform !== 'darwin') return;
  const { execSync } = require('child_process');
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('[adhoc] ad-hoc 签名完成:', appPath);
  } catch (e) {
    console.warn('[adhoc] 签名失败（构建继续；用户首启需 xattr -cr 解锁）:', e.message);
  }
};
