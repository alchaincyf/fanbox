// macOS 打包补权限（ticket：终端启动失败 posix_spawnp failed）：
// node-pty 1.1.0 的 npm prebuild 里 spawn-helper 丢失可执行位（上游打包 bug）。
// macOS 上 node-pty 经 posix_spawnp 先启动 spawn-helper 再起 shell，
// 权限缺失 → 所有 shell 候选统一报「posix_spawnp failed」。
// afterPack 在 asar 解包落盘之后、adhoc 签名之前跑，这里把执行位补回来。
exports.default = async (context) => {
  if (process.platform !== "darwin") return;
  const { chmodSync, existsSync } = require("fs");
  const path = require("path");
  const resources = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app/Contents/Resources`;
  const prebuilds = path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  if (!existsSync(prebuilds)) return;
  const fs2 = require("fs");
  for (const arch of fs2.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, arch, "spawn-helper");
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
      console.log("[fix-perms] chmod +x:", path.relative(resources, helper));
    }
  }
};
