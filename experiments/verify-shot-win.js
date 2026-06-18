// 验证 Windows 截图直通车：往 ~/Pictures/Screenshots 丢一张 png，渲染层应收到 shot:new
const { _electron } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const os = require('os');
const ROOT = path.resolve(__dirname, '..');
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 60000);
(async () => {
  const shotDir = path.join(os.homedir(), 'Pictures', 'Screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, FANBOX_PORT: '4633', FANBOX_NO_OPEN: '1' } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000); // 让 startShotWatch 起来
  await win.evaluate(() => { window.__shot = null; if (window.fanboxShot) window.fanboxShot.onNew((m) => { window.__shot = m; }); });
  const fname = `Screenshot (verify-${Date.now()}).png`; // 含空格+括号，测路径处理
  const fp = path.join(shotDir, fname);
  fs.copyFileSync(path.join(ROOT, 'build', 'icon-1024.png'), fp);
  await win.waitForTimeout(3800); // watch + waitStable(350ms起 + 首次stat稳定即发)
  const got = await win.evaluate(() => window.__shot);
  try { fs.unlinkSync(fp); } catch (e) {}
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  try { await app.close(); } catch (e) {}
  if (got && got.path && got.path.replace(/\//g, '\\').endsWith(fname)) {
    console.log('✓ 截图直通车 Windows：丢文件后渲染层收到 shot:new —', JSON.stringify(got));
    process.exit(0);
  }
  console.log('✗ 未收到 shot:new（fanboxShot=' + (got === null ? 'null/未注册' : JSON.stringify(got)) + '）');
  process.exit(1);
})().catch((e) => { console.error('CRASH', e.message); process.exit(2); });
