// 深度功能验证：Playwright 驱动真实 Electron app（main.js+preload+IPC 全真），逐功能验证 Windows 版完整性。
// 用法：node experiments/verify-features-win.js   （需先 npm install playwright-core --no-save）
const { _electron } = require('playwright-core');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PORT = '4631';
setTimeout(() => { console.log('WATCHDOG TIMEOUT — 强制退出'); process.exit(3); }, 90000); // 兜底防 hang

(async () => {
  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });

  const app = await _electron.launch({
    args: [ROOT], cwd: ROOT,
    env: { ...process.env, FANBOX_PORT: PORT, FANBOX_NO_OPEN: '1' },
  });
  const win = await app.firstWindow();
  const errs = [];
  win.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { try { localStorage.setItem('fb_guided', '1'); } catch (e) {} }); // 跳过首启引导
  await win.waitForTimeout(3500);

  // 1. 平台 / 桥接 / class
  const env = await win.evaluate(() => ({
    platform: window.fanboxEnv && window.fanboxEnv.platform,
    bridges: {
      pty: !!window.fanboxPty, fs: !!window.fanboxFs, clip: !!window.fanboxClipboard,
      drop: !!window.fanboxDrop, rec: !!window.fanboxRec, shot: !!window.fanboxShot,
      win: !!window.fanboxWin, wechat: !!window.fanboxWechat, update: !!window.fanboxUpdate,
    },
    htmlClass: document.documentElement.className,
    statePlatform: typeof state !== 'undefined' ? state.platform : null,
    stateSep: typeof state !== 'undefined' ? JSON.stringify(state.sep) : null,
  }));
  check('平台识别 win32', env.platform === 'win32', env.platform);
  check('9 个 IPC 桥接全暴露', Object.values(env.bridges).every(Boolean), JSON.stringify(env.bridges));
  check('html 有 platform-win32 class', env.htmlClass.includes('platform-win32'), env.htmlClass);
  check('state.platform=win32', env.statePlatform === 'win32', env.statePlatform);
  check('state.sep=\\\\', env.stateSep === '"\\\\"', env.stateSep);

  // 2. 导航到仓库根，看文件列表/缩略图渲染
  await win.evaluate((p) => { try { navigate(p); } catch (e) {} }, ROOT);
  await win.waitForTimeout(1800);
  const rendered = await win.evaluate(() => ({
    entries: (state.entries || []).length,
    project: state.project,
    thumbImgs: document.querySelectorAll('img[src*="/api/thumb"]').length,
    cmdResidual: (document.body.innerText.match(/⌘/g) || []).length,
    ctrlCount: (document.body.innerText.match(/Ctrl/g) || []).length,
    breadcrumb: ($('#breadcrumb') || { innerText: '' }).innerText,
  }));
  check('文件列表渲染(>5项)', rendered.entries > 5, rendered.entries + '项 project=' + rendered.project);
  check('面包屑含盘符 D:', /D:/.test(rendered.breadcrumb), rendered.breadcrumb.slice(0, 40));
  check('platform-l10n: 无残留⌘', rendered.cmdResidual === 0, '残留⌘ ' + rendered.cmdResidual + ' / Ctrl出现 ' + rendered.ctrlCount);

  // 2b. 导航进 assets/（有图片文件），验证缩略图 <img> 真渲染
  await win.evaluate((p) => { try { navigate(p); } catch (e) {} }, ROOT + '\\assets');
  await win.waitForTimeout(1500);
  const thumbRendered = await win.evaluate(() => ({
    imgs: document.querySelectorAll('img[src*="/api/thumb"]').length,
    // 缩略图是否真加载成功（naturalWidth>0 表示图片解码成功，非裂图）
    loaded: [...document.querySelectorAll('img[src*="/api/thumb"]')].filter((i) => i.naturalWidth > 0).length,
  }));
  check('assets 缩略图渲染', thumbRendered.imgs >= 3, thumbRendered.imgs + '个 img');
  check('缩略图加载成功(非裂图)', thumbRendered.loaded >= 3, thumbRendered.loaded + '/' + thumbRendered.imgs + ' 解码成功');

  // 3. 终端：spawn + 输入命令 + 验证回显（UI→IPC→node-pty→IPC→UI 全链路）
  await win.evaluate(() => { const b = $('#btn-terminal'); if (b) b.click(); });
  await win.waitForTimeout(1500);
  const termResult = await win.evaluate(async () => {
    try {
      if (!window.fanboxPty) return { ok: false, err: 'no bridge' };
      const id = 'vf-' + Date.now();
      const r = await window.fanboxPty.spawn({ id, cwd: '', cols: 90, rows: 24 });
      if (!r.ok) return { ok: false, err: r.error };
      const waitData = (pred, ms = 3000) => new Promise((res) => {
        let buf = ''; const off = window.fanboxPty.onData((m) => { if (m.id === id) { buf += m.data; if (pred(buf)) { off(); res(buf); } } });
        setTimeout(() => { off(); res(buf); }, ms);
      });
      const first = await waitData((b) => b.length > 30);
      window.fanboxPty.input(id, 'echo VERIFY_OK_MARKER_42\r');
      const echoed = await waitData((b) => b.includes('VERIFY_OK_MARKER_42'));
      window.fanboxPty.kill(id);
      return { ok: true, firstBytes: first.length, echoed: echoed.includes('VERIFY_OK_MARKER_42'), sample: first.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(0, 60) };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  check('终端spawn+收到输出', termResult.ok && termResult.firstBytes > 0, JSON.stringify(termResult).slice(0, 140));
  check('终端命令回显(echo)', termResult.echoed, '');

  // 4. Monaco / Milkdown 编辑器加载
  const monacoOk = await win.evaluate(async () => { try { return !!(await mona.load()); } catch (e) { return 'err:' + e.message; } });
  check('Monaco 编辑器加载', monacoOk === true, String(monacoOk));
  const crepeOk = await win.evaluate(async () => { try { return !!(await crepe.load()); } catch (e) { return 'err:' + e.message; } });
  check('Milkdown 编辑器加载', crepeOk === true, String(crepeOk));

  // 截图存证
  await win.screenshot({ path: path.join(ROOT, 'experiments', 'verify-win-files.png') }).catch(() => {});

  check('渲染层零 console error', errs.length === 0, errs.slice(0, 3).join(' | '));

  // app.exit 直接退出，绕过 before-quit 的「还有终端在跑」同步确认框（否则 hang）
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  try { await app.close(); } catch (e) {}
  console.log('\n========== Windows 深度功能验证 ==========');
  let pass = 0;
  for (const r of results) { console.log((r.ok ? '✓' : '✗') + ' ' + r.name + (r.detail ? '  — ' + r.detail : '')); if (r.ok) pass++; }
  console.log('\n' + pass + '/' + results.length + ' 通过');
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('VERIFY CRASH:', e.message); process.exit(2); });
