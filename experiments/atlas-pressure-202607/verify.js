// 图集压力监视 + 真重建（2.6.2）的自动化验收：Playwright 驱动 Electron（假 HOME，不碰真实数据）。
// 覆盖：①watchAtlas 已挂 ②大量彩色 CJK 输出推动页数计数增长 ③计数到 12 触发 recycleWebgl
// （所有标签 WebGL 插件换新、计数归零）④重建后终端内容完好、还能继续渲染中文 ⑤同一页事件多次
// 转发被 WeakSet 去重 ⑥调字号后所有标签同 tick 清图集不炸。含中文截图供人工目检。
const { _electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const HOME = '/tmp/fb-verify-atlas-home';
let fails = 0;
const check = (ok, name, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ' — ' + detail : '')); if (!ok) fails++; };
setTimeout(() => { console.error('FAIL: watchdog 超时'); process.exit(2); }, 180000);

(async () => {
  for (const d of ['Desktop', 'Documents', 'Downloads']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules/electron')), args: [ROOT], cwd: ROOT, env: { ...process.env, HOME, FANBOX_PORT: '4642' } });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1560, 950); w.center(); });
  await win.waitForTimeout(2200);
  await win.evaluate(() => { localStorage.setItem('fb_guided', '1'); localStorage.setItem('fb_term_open', '1'); localStorage.setItem('fb_term_dock', 'bottom'); });
  await win.evaluate(() => location.reload()).catch(() => {});
  await win.waitForTimeout(2500);
  await win.evaluate(() => { window.playChime = () => {}; term.notify = () => {}; });

  // ---------- ① watchAtlas 已挂（订阅时初始化 _atlasSeen） ----------
  const r1 = await win.evaluate(() => ({ seen: term._atlasSeen instanceof WeakSet, wg: !!term.sessions.find((x) => x.id === term.active)?.webgl }));
  check(r1.wg && r1.seen, 'WebGL 挂载且 watchAtlas 已订阅', JSON.stringify(r1));

  // 再开一个标签，验证多标签共享图集下的计数与重建
  await win.evaluate(() => term.newTab());
  await win.waitForTimeout(1200);

  // ---------- ② 大量彩色 CJK 直接灌进 xterm，推动图集开新页 ----------
  const r2 = await win.evaluate(async () => {
    const s = term.sessions.find((x) => x.id === term.active);
    const before = term._atlasPages || 0;
    // 4000 个不同汉字 × 8 种前景色：每个 (字, 色) 组合都是一个新字形，足够撑开多页图集
    for (let batch = 0; batch < 8; batch++) {
      let out = '';
      for (let i = 0; i < 4000; i++) {
        const ch = String.fromCharCode(0x4e00 + ((batch * 4000 + i) % 20000));
        if (i % 80 === 0) out += `\r\n\x1b[3${(i / 80 + batch) % 8}m`;
        out += ch;
      }
      s.xterm.write(out);
      await new Promise((r) => setTimeout(r, 350));
    }
    await new Promise((r) => setTimeout(r, 800));
    return { before, after: term._atlasPages || 0 };
  });
  check(r2.after > r2.before, 'CJK 输出推动图集页数计数增长', JSON.stringify(r2));

  // ---------- ③ 计数到 12 触发真重建：所有标签 WebGL 插件换新、计数归零 ----------
  const r3 = await win.evaluate(async () => {
    const ids = term.sessions.map((s) => s.id);
    const oldWg = new Map(term.sessions.map((s) => [s.id, s.webgl]));
    // 借 watchAtlas 的公开入口喂假事件：伪造 addon 只提供事件订阅，喂 12 张新 canvas 模拟页数顶格
    let fire;
    term.watchAtlas({ onAddTextureAtlasCanvas: (cb) => { fire = cb; } });
    term._atlasPages = 0;
    const cvs = [];
    for (let i = 0; i < 12; i++) { const c = document.createElement('canvas'); cvs.push(c); fire(c); }
    const dedupBefore = term._atlasPages;
    fire(cvs[0]); fire(cvs[5]); // 同一页被其他标签重复转发的场景
    const dedupAfter = term._atlasPages;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300)));
    const swapped = term.sessions.filter((s) => s.webgl && s.webgl !== oldWg.get(s.id)).length;
    return { tabs: ids.length, swapped, pagesReset: term._atlasPages, dedupBefore, dedupAfter, recycling: term._atlasRecycling };
  });
  check(r3.tabs >= 2 && r3.swapped === r3.tabs, '页数顶格触发全标签 WebGL 真重建', JSON.stringify(r3));
  // 重建瞬间计数先归零，新图集重画满屏又会立刻数进几页真实新页——只要求远低于阈值且闸门复位
  check(r3.pagesReset < 12 && !r3.recycling, '重建后计数重置、闸门复位', JSON.stringify(r3));
  check(r3.dedupBefore === 12 && r3.dedupAfter === 12, '同一页多标签转发被 WeakSet 去重', `before=${r3.dedupBefore} after=${r3.dedupAfter}`);

  // ---------- ④ 重建后内容完好、还能继续渲染中文 ----------
  const r4 = await win.evaluate(async () => {
    const s = term.sessions.find((x) => x.id === term.active);
    s.xterm.write('\r\n\x1b[0m重建后的中文渲染检查：翻箱倒柜找乱码\r\n');
    await new Promise((r) => setTimeout(r, 600));
    const b = s.xterm.buffer.active;
    for (let i = b.length - 1; i >= 0; i--) {
      const t = b.getLine(i)?.translateToString(true).trim();
      if (t && t.includes('翻箱倒柜找乱码')) return { ok: true, webgl: !!s.webgl };
    }
    return { ok: false, webgl: !!s.webgl };
  });
  check(r4.ok && r4.webgl, '重建后 WebGL 在位且中文正常写入渲染', JSON.stringify(r4));

  // ---------- ⑤ 调字号：全标签同 tick 清图集不炸、字号生效 ----------
  const r5 = await win.evaluate(async () => {
    const s = term.sessions.find((x) => x.id === term.active);
    term.adjustFont(s, 1);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300)));
    return { size: s.xterm.options.fontSize, alive: term.sessions.every((x) => !x.dead) };
  });
  check(r5.size === 14 && r5.alive, '调字号触发全局清图集后各标签存活', JSON.stringify(r5));

  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  await win.screenshot({ path: path.join(__dirname, 'shots', 'atlas-pressure-cjk.png') });

  console.log(fails === 0 ? '\n全部通过 ✅' : '\n有 ' + fails + ' 项失败 ❌');
  await win.evaluate(() => term.sessions.slice().forEach((s) => { try { window.fanboxPty.kill(s.id); } catch { /* */ } }));
  await win.waitForTimeout(400);
  await app.close().catch(() => {});
  setTimeout(() => process.exit(fails === 0 ? 0 : 1), 1200);
})().catch((e) => { console.error('FAIL: 脚本异常 — ' + (e && e.stack || e)); process.exit(2); });
