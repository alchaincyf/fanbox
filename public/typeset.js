// 排版：把 md 排成公众号 / X Articles 能直接粘进去的富文本。
// 主题表在 typeset-styles.js（与 editor.huasheng.ai 同源）。公众号编辑器只认内联样式、
// 会丢掉所有 <style> 和 class，所以这里全程 DOM + setAttribute('style')，不走 CSS 类。
// 关键取舍：预览产物和粘出去的产物是同一份 HTML——所见即所得，没有「预览好看、粘过去变样」。
window.typeset = (() => {
  const KEY = 'fanbox.typeset.style';
  const DEFAULT_ID = 'wechat-default';
  const all = () => window.TYPESET_STYLES || {};
  const has = (id) => !!(id && all()[id]);
  const current = () => { try { const v = localStorage.getItem(KEY); return has(v) ? v : DEFAULT_ID; } catch { return DEFAULT_ID; } };
  const setCurrent = (id) => { try { if (has(id)) localStorage.setItem(KEY, id); } catch { /* 隐私模式写不进去，无所谓 */ } };
  const list = () => Object.keys(all()).map((id) => ({ id, name: all()[id].name || id }));

  // YAML frontmatter 是给 agent 和静态站看的元数据，不是正文——排版时剥掉，别渲染成一堆横线
  const stripFrontMatter = (md) => String(md || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

  // 代码块：微信对嵌套结构不稳，统一压成「一个 pre + 一个 code」的深色块。
  // 不做语法高亮——高亮靠 class，粘到公众号必然掉色，那样预览就成了骗人的。
  function simplifyCode(doc) {
    doc.querySelectorAll('pre').forEach((pre) => {
      const text = (pre.querySelector('code') || pre).textContent || '';
      const np = doc.createElement('pre');
      np.setAttribute('style',
        'background: #282c34; padding: 0; border-radius: 6px; overflow: hidden; margin: 24px 0;'
        + ' box-shadow: 0 2px 8px rgba(0,0,0,0.15);');
      const code = doc.createElement('code');
      code.setAttribute('style',
        'color: #abb2bf; font-family: "SF Mono", Consolas, Monaco, "Courier New", monospace;'
        + ' font-size: 14px; line-height: 1.7; display: block; white-space: pre; padding: 16px 20px;'
        + ' -webkit-font-smoothing: antialiased;');
      code.textContent = text.replace(/\n$/, '');
      np.appendChild(code);
      pre.parentNode.replaceChild(np, pre);
    });
  }

  // 连续多图排成表格网格（2 张两列、3 张三列、4 张 2×2、5 张以上三列）。
  // 直接生成 table 而不是 CSS grid：公众号不认 grid，table 是唯一能活下来的多列布局。
  function gridImages(doc) {
    const kids = Array.from(doc.body.children);
    // 收集「独占一段的图片」，按段落序号相邻判定连续（中间隔了文字或空行就断开）
    const items = [];
    kids.forEach((el, i) => {
      if (el.tagName === 'IMG') { items.push({ el, imgs: [el], i }); return; }
      if (el.tagName !== 'P') return;
      const imgs = Array.from(el.querySelectorAll('img'));
      if (!imgs.length) return;
      if ((el.textContent || '').trim()) return; // 图文混排的段落不动它
      items.push({ el, imgs, i });
    });
    const groups = [];
    items.forEach((it, k) => {
      const prev = items[k - 1];
      if (k && prev && it.i - prev.i <= 1) groups[groups.length - 1].push(it);
      else groups.push([it]);
    });
    groups.forEach((g) => {
      const imgs = g.flatMap((it) => it.imgs);
      if (imgs.length < 2) return;
      const cols = imgs.length === 2 || imgs.length === 4 ? 2 : 3;
      const table = doc.createElement('table');
      table.setAttribute('style',
        'width: 100% !important; border-collapse: collapse !important; margin: 20px auto !important;'
        + ' table-layout: fixed !important; border: none !important; background: transparent !important;');
      for (let r = 0; r < Math.ceil(imgs.length / cols); r++) {
        const tr = doc.createElement('tr');
        for (let c = 0; c < cols; c++) {
          const td = doc.createElement('td');
          td.setAttribute('style',
            `padding: 4px !important; vertical-align: top !important; width: ${(100 / cols).toFixed(2)}% !important;`
            + ' border: none !important; background: transparent !important;');
          const im = imgs[r * cols + c];
          if (im) {
            const cl = im.cloneNode(true);
            cl.setAttribute('style', 'width: 100% !important; height: auto !important; display: block !important; border-radius: 6px !important;');
            cl.setAttribute('data-grid', '1'); // 打标记：后面统一套 img 主题样式时跳过它
            td.appendChild(cl);
          }
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      table.setAttribute('data-grid', '1');
      g[0].el.parentNode.insertBefore(table, g[0].el);
      g.forEach((it) => it.el.remove());
    });
  }

  // 标题里的行内元素（加粗/链接/行内码）继承标题自己的颜色，
  // 否则主题给 strong 的强调色会盖掉标题色，标题变成花的
  const HEAD_INLINE = {
    strong: 'font-weight: 700;', b: 'font-weight: 700;', em: 'font-style: italic;', i: 'font-style: italic;',
    a: 'text-decoration: none !important; border-bottom: 1px solid currentColor !important;',
    code: 'border: none !important; padding: 0 !important;', span: '', del: '', s: '', mark: '',
  };

  function inlineStyles(doc, style) {
    Object.keys(style).forEach((tag) => {
      if (tag === 'container' || tag === 'pre' || tag === 'code' || tag === 'pre code') return; // 代码块已经自带样式
      doc.querySelectorAll(tag).forEach((el) => {
        if (el.closest('[data-grid]')) return; // 网格里的图片/表格用自己的尺寸，不套主题
        el.setAttribute('style', (el.getAttribute('style') || '') + '; ' + style[tag]);
      });
    });
    doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
      h.querySelectorAll(Object.keys(HEAD_INLINE).join(',')).forEach((node) => {
        const tag = node.tagName.toLowerCase();
        const cleaned = (node.getAttribute('style') || '')
          .replace(/(?:^|;)\s*(?:color|background|background-color|border|border-bottom|text-decoration|box-shadow|padding)\s*:[^;]*/gi, '')
          .replace(/;\s*;/g, ';').replace(/^\s*;|;\s*$/g, '').trim();
        node.setAttribute('style',
          cleaned + '; ' + HEAD_INLINE[tag]
          + ' color: inherit !important; background-color: transparent !important;');
      });
    });
    // 首个块级元素的上外边距不与容器 padding 折叠，正文开头会凭空多出一行空白
    const first = doc.body.firstElementChild;
    if (first) first.setAttribute('style', (first.getAttribute('style') || '') + '; margin-top: 0 !important;');
  }

  // 生成排好版的容器元素。预览直接挂它，复制走它的克隆——两边同一份产物。
  function build(md, srcPath, styleId) {
    const cfg = all()[has(styleId) ? styleId : DEFAULT_ID];
    const doc = new DOMParser().parseFromString(
      typeof mdHtml === 'function' ? mdHtml(stripFrontMatter(md)) : '', 'text/html');
    simplifyCode(doc);
    if (typeof fixLocalImages === 'function') fixLocalImages(doc.body, srcPath); // 本地配图接到 /api/raw，不然一律裂图
    gridImages(doc);
    inlineStyles(doc, cfg.styles);
    const box = document.createElement('div');
    box.setAttribute('style', cfg.styles.container);
    box.innerHTML = doc.body.innerHTML;
    return box;
  }

  // ---- 复制 ----

  // 图片必须变成 data: 才能粘进公众号：剪贴板里的 HTML 一旦带本机 URL，微信那边只会看到裂图。
  async function inlineImages(root, onStep) {
    const imgs = Array.from(root.querySelectorAll('img'));
    let failed = 0;
    for (let i = 0; i < imgs.length; i++) {
      const src = imgs[i].getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;
      if (onStep) onStep(i + 1, imgs.length);
      try { imgs[i].setAttribute('src', await toDataUrl(src)); } catch { failed++; }
    }
    return { total: imgs.length, failed };
  }

  async function fetchImage(src) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(src, { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return await r.blob();
    } catch { /* 外链多半是被 CORS 挡了，下面走本机代理再试一次 */ }
    if (/^https?:/i.test(src)) {
      const r = await fetch('/api/img-proxy?url=' + encodeURIComponent(src));
      if (r.ok) return await r.blob();
    }
    throw new Error('取不到图片: ' + src);
  }

  async function toDataUrl(src) {
    let blob = await fetchImage(src);
    // 大图二次压缩：base64 比原文件还大三分之一，一篇几张 3MB 的截图能把剪贴板撑爆
    if (blob.type !== 'image/gif' && blob.size > 1024 * 1024) {
      try { blob = await shrink(blob); } catch { /* 压不动就用原图 */ }
    }
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读图失败'));
      fr.readAsDataURL(blob);
    });
  }

  // GIF 不走这里：canvas 只会留下静止的第一帧
  function shrink(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        try {
          const k = Math.min(1600 / im.naturalWidth, 1600 / im.naturalHeight, 1);
          const cv = document.createElement('canvas');
          cv.width = Math.round(im.naturalWidth * k);
          cv.height = Math.round(im.naturalHeight * k);
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); // 透明 png 转 jpeg 会变黑底
          ctx.drawImage(im, 0, 0, cv.width, cv.height);
          cv.toBlob((out) => { URL.revokeObjectURL(url); resolve(out && out.size < blob.size ? out : blob); }, 'image/jpeg', 0.82);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解不开')); };
      im.src = url;
    });
  }

  // 主题带底色时（金融时报的米色、档案馆的暖纸），得额外包一层 section 把底色铺满，
  // 否则公众号只会给正文块上色，两侧留白还是白的
  function wrapBackground(root, style) {
    const bg = (style.container.match(/background-color:\s*([^;!]+)/) || [])[1];
    if (!bg) return root;
    const color = bg.trim();
    if (/^(#fff|#ffffff|white)$/i.test(color)) return root;
    const pad = (style.container.match(/padding:\s*([^;!]+)/) || [])[1] || '20px 16px';
    const maxw = (style.container.match(/max-width:\s*([^;!]+)/) || [])[1] || '100%';
    const sec = document.createElement('section');
    sec.setAttribute('style',
      `background-color: ${color}; padding: ${pad.trim()}; max-width: ${maxw.trim()}; margin: 0 auto;`
      + ' box-sizing: border-box; word-wrap: break-word;');
    sec.innerHTML = root.innerHTML;
    return sec;
  }

  async function writeClipboard(html, text) {
    if (navigator.clipboard && window.ClipboardItem && document.hasFocus()) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
        return true;
      } catch { /* 权限或焦点问题，落到 execCommand */ }
    }
    // 降级：把内容塞进一个屏幕外元素、选中、execCommand。老办法，但富文本能保住
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0;');
    document.body.appendChild(tmp);
    const range = document.createRange();
    range.selectNodeContents(tmp);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    sel.removeAllRanges();
    tmp.remove();
    return ok;
  }

  // 复制到公众号：内联样式 + 图片转 base64 + 底色兜底。粘进微信编辑器即成稿。
  async function copyWechat(md, srcPath, styleId, onStep) {
    const cfg = all()[has(styleId) ? styleId : DEFAULT_ID];
    const root = build(md, srcPath, styleId);
    const stat = await inlineImages(root, onStep);
    // 引用块用半透明黑：微信深色模式会自动反色，写死的浅灰底在深色下会糊成一团
    root.querySelectorAll('blockquote').forEach((bq) => {
      const s = (bq.getAttribute('style') || '')
        .replace(/(?:^|;)\s*(?:background|background-color|color)\s*:[^;]*/gi, '')
        .replace(/;\s*;/g, ';').trim();
      bq.setAttribute('style', s + '; background: rgba(0,0,0,0.05) !important; color: rgba(0,0,0,0.8) !important');
    });
    const out = wrapBackground(root, cfg.styles);
    const ok = await writeClipboard(out.outerHTML, root.innerText || root.textContent || '');
    return { ok, ...stat };
  }

  // X Articles 只认一小撮语义标签，样式全被它自己的编辑器接管——
  // 所以这条路径不是「排版」，是「清洗」：把 md 洗成 X 吃得下的骨架。
  const X_ALLOWED = new Set(['h2', 'h3', 'p', 'strong', 'em', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'br', 'b', 'i', 's']);

  async function copyX(md, srcPath) {
    const doc = new DOMParser().parseFromString(
      typeof mdHtml === 'function' ? mdHtml(stripFrontMatter(md)) : '', 'text/html');
    const body = doc.body;
    // h1 让给文章标题，h4 以下 X 不认，统一降到 h3
    body.querySelectorAll('h1').forEach((h) => swapTag(doc, h, 'h2'));
    body.querySelectorAll('h4, h5, h6').forEach((h) => swapTag(doc, h, 'h3'));
    // 代码块和表格没有对应结构，退成引用块保住内容
    body.querySelectorAll('pre').forEach((pre) => pre.parentNode.replaceChild(linesToQuote(doc, (pre.textContent || '').split('\n')), pre));
    body.querySelectorAll('table').forEach((tb) => {
      const rows = Array.from(tb.querySelectorAll('tr')).map((tr) =>
        '| ' + Array.from(tr.querySelectorAll('th, td')).map((c) => (c.textContent || '').trim()).join(' | ') + ' |');
      tb.parentNode.replaceChild(linesToQuote(doc, rows), tb);
    });
    // 图片粘不进 X 的正文，留一行占位提醒自己回去补图。
    // 占位插在所在段落之前、图片本身删掉：同一段里的多张图才能各留一行（就地替换会让第二张的父节点已脱离文档）
    body.querySelectorAll('img').forEach((im) => {
      const host = im.closest('p') || im;
      if (!host.parentNode) return;
      const p = doc.createElement('p');
      p.textContent = '[' + (im.getAttribute('alt') || '图片') + ']';
      host.parentNode.insertBefore(p, host);
      im.remove();
    });
    body.querySelectorAll('hr').forEach((hr) => {
      const p = doc.createElement('p');
      p.textContent = '———';
      hr.parentNode.replaceChild(p, hr);
    });
    strip(doc, body);
    body.querySelectorAll('blockquote, p').forEach((el) => { if (!el.textContent.trim() && !el.querySelector('br')) el.remove(); });
    const ok = await writeClipboard(body.innerHTML, body.innerText || body.textContent || '');
    return { ok };
  }

  function swapTag(doc, el, tag) {
    const n = doc.createElement(tag);
    n.innerHTML = el.innerHTML;
    el.parentNode.replaceChild(n, el);
  }

  function linesToQuote(doc, lines) {
    const bq = doc.createElement('blockquote');
    lines.forEach((line, i) => {
      if (i) bq.appendChild(doc.createElement('br'));
      bq.appendChild(doc.createTextNode(line || ' '));
    });
    return bq;
  }

  // 扒掉所有属性（a 保 href），非白名单标签解包但留住里面的文字
  function strip(doc, node) {
    Array.from(node.childNodes).forEach((c) => { if (c.nodeType === 1) strip(doc, c); });
    if (node.nodeType !== 1 || node.tagName === 'BODY') return;
    const tag = node.tagName.toLowerCase();
    const href = tag === 'a' ? node.getAttribute('href') : null;
    while (node.attributes.length) node.removeAttribute(node.attributes[0].name);
    if (href) node.setAttribute('href', href);
    if (!X_ALLOWED.has(tag)) {
      const frag = doc.createDocumentFragment();
      while (node.firstChild) frag.appendChild(node.firstChild);
      node.parentNode.replaceChild(frag, node);
    }
  }

  // ---- 导出长图 ----
  // 小红书 / 朋友圈 / 即刻要的是图不是文（docs/13 第二层「内建导出」）。
  // 纯前端零依赖：排好版的 DOM 序列化进 SVG foreignObject → 画上 canvas → PNG 落回文章旁边。
  // 图片必须先转 data:——SVG 当图片渲染时是隔离环境，不允许再发任何网络请求，不转必然白框。

  const EXPORT_W = 750; // 移动端长图惯例宽度：主题容器 680~740 居中其内，底色由外层铺满

  // 落盘走 /api/image-save（图片编辑器的原子写回，这里借用）：path 传 md 自己，newName 落同目录。
  // 不覆盖旧图：同名就顺延 -2、-3……导出历史都留着，要清理让人自己清
  async function savePng(dataUrl, srcPath) {
    const base = (String(srcPath).split(/[/\\]/).pop() || '文章').replace(/\.[^.]+$/, '');
    for (let i = 1; i <= 99; i++) {
      const name = `${base}-长图${i > 1 ? '-' + i : ''}.png`;
      const r = await fetch('/api/image-save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: srcPath, dataUrl, newName: name }),
      }).then((x) => x.json());
      if (r.ok) return r.path;
      if (!/已存在/.test(r.error || '')) throw new Error(r.error || '写盘失败');
    }
    throw new Error('同名长图太多，清理一下再导');
  }

  // 主题容器上抠底色和正文色：长图要把底色铺到 750 全宽（容器只有 680~740），页码要跟着正文色走
  const themeBg = (cfg) => ((cfg.styles.container.match(/background-color:\s*([^;!]+)/) || [])[1] || '#fff').trim();
  const themeFg = (cfg) => (((cfg.styles.container.match(/(?:^|;)\s*color:\s*([^;!]+)/) || [])[1]) || '#333').trim();

  // 一片排好版的 DOM → PNG dataUrl。整篇一张和分节多张共用这段，保证两条路产物完全同质。
  // 注意 node 会被搬进临时容器，调用方别指望它还留在原处。
  async function renderPng(node, bg) {
    // 屏外量高：SVG 里没有滚动，得先知道排完有多高。量与画同一引擎同一宽度，结果一致
    const wrap = document.createElement('div');
    wrap.setAttribute('style', `width: ${EXPORT_W}px; background-color: ${bg}; box-sizing: border-box;`);
    wrap.appendChild(node);
    const meas = document.createElement('div');
    meas.setAttribute('style', 'position: fixed; left: -10000px; top: 0;');
    meas.appendChild(wrap);
    document.body.appendChild(meas);
    const height = Math.ceil(wrap.getBoundingClientRect().height);
    const xhtml = new XMLSerializer().serializeToString(wrap); // 序列化成良构 XML，<br> 这类空标签自动闭合
    meas.remove();
    if (!height) throw new Error('文章排出来是空的');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${EXPORT_W}" height="${height}">`
      + `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    // 必须走 data:，不能走 blob:——Chromium 里 blob: 装载的 foreignObject SVG 画上 canvas 会把
    // canvas 判成被污染（tainted），toDataURL 直接抛错；data: 则干净
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const im = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('长图渲染失败'));
      img.src = url;
    });
    await im.decode().catch(() => { /* 已 onload，decode 报错不拦路 */ });
    // 清晰度 2x；超长文章自动降倍率——Chromium canvas 单边上限 65535，越界会静默给空图
    const k = Math.min(2, 65000 / height);
    const cv = document.createElement('canvas');
    cv.width = Math.round(EXPORT_W * k);
    cv.height = Math.round(height * k);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height); // foreignObject 外的边缘是透明的，先铺一层底色
    ctx.scale(k, k);
    ctx.drawImage(im, 0, 0);
    return { dataUrl: cv.toDataURL('image/png'), height };
  }

  async function exportImage(md, srcPath, styleId, onStep) {
    const cfg = all()[has(styleId) ? styleId : DEFAULT_ID];
    const root = build(md, srcPath, styleId);
    const stat = await inlineImages(root, onStep);
    const { dataUrl } = await renderPng(root, themeBg(cfg));
    const outPath = await savePng(dataUrl, srcPath);
    return { ok: true, path: outPath, ...stat };
  }

  // ---- 导出长图（分节多图）----
  // 朋友圈发单张，小红书发多图（一条笔记最多 18 张），是两个场景不是两种实现，所以两个入口都留着。
  //
  // 切点取 h2：`##` 是作者自己在 md 里划的分节线，比按像素高度盲切靠谱得多。最小不可分单位是
  // 顶层块元素（p / h2 / pre / blockquote / ul / 图片网格 table），所以切点永远落在两个块之间，
  // 一段话不会被拦腰截断——这是本功能唯一的硬约束，上下限规则都得给它让路。
  // 文章没写 h2 时算法天然退化成「按高度在块边界切」，仍然不切断段落。
  const SLICE_MIN_H = EXPORT_W;     // 1:1。比这还矮的小节并进下一节——一张三行字的图发出去太小气
  const SLICE_MAX_H = EXPORT_W * 4; // 1:4。再长手机上就得反复捏合缩放，在块边界强制断开

  // 页码角标：多图是滑着看的，读者需要知道现在第几张、一共几张。只加这一条——
  // 不重复文章标题（每片开头本来就是它自己的 h2，上下文已经在了，重复标题白占首屏），不加水印。
  function pageMark(n, total, fg) {
    const d = document.createElement('div');
    d.setAttribute('style',
      `margin: 32px 0 0; text-align: center; font-size: 13px; letter-spacing: 2px; color: ${fg}; opacity: .4;`);
    d.textContent = `${n} / ${total}`;
    return d;
  }

  // 分节多图要「整组连号」：1/2/3…… 中间跳号读者没法知道哪张接哪张。所以先读一眼目录挑一组
  // 完全空着的名字，而不是像单张那样逐个顺延。和单张共用 `-长图` 命名空间，撞上就整组改挂
  // `-长图2-1`、`-长图3-1`……旧图一张不覆盖。
  async function savePngSet(dataUrls, srcPath) {
    const base = (String(srcPath).split(/[/\\]/).pop() || '文章').replace(/\.[^.]+$/, '');
    const dir = String(srcPath).replace(/[/\\][^/\\]*$/, '') || '/';
    let taken = new Set();
    try {
      const r = await fetch('/api/list?path=' + encodeURIComponent(dir)).then((x) => x.json());
      taken = new Set((r.entries || []).map((x) => x.name));
    } catch { /* 目录读不到就先写第一张探路，image-save 撞名会明确报「已存在」 */ }
    for (let g = 1; g <= 20; g++) {
      const names = dataUrls.map((_, i) => `${base}-长图${g > 1 ? g : ''}-${i + 1}.png`);
      if (names.some((n) => taken.has(n))) continue;
      const paths = [];
      for (let i = 0; i < names.length; i++) {
        const r = await fetch('/api/image-save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: srcPath, dataUrl: dataUrls[i], newName: names[i] }),
        }).then((x) => x.json());
        if (!r.ok && /已存在/.test(r.error || '') && !i) break; // 第一张就撞名：这组不干净，整组换个号
        if (!r.ok) throw new Error(r.error || '写盘失败');
        paths.push(r.path);
      }
      if (paths.length === names.length) return paths;
    }
    throw new Error('同名长图太多，清理一下再导');
  }

  async function exportSlices(md, srcPath, styleId, onStep) {
    const cfg = all()[has(styleId) ? styleId : DEFAULT_ID];
    const root = build(md, srcPath, styleId);
    const stat = await inlineImages(root, onStep);
    const bg = themeBg(cfg);
    const blocks = Array.from(root.children);
    if (!blocks.length) throw new Error('文章排出来是空的');

    // 屏外量一次：每个顶层块的起点用 offsetTop，外边距折叠后的真实位置都算进去了
    const wrap = document.createElement('div');
    wrap.setAttribute('style', `width: ${EXPORT_W}px; box-sizing: border-box;`);
    wrap.appendChild(root);
    const meas = document.createElement('div');
    meas.setAttribute('style', 'position: fixed; left: -10000px; top: 0;');
    meas.appendChild(wrap);
    document.body.appendChild(meas);
    const tops = blocks.map((el) => el.offsetTop);
    const totalH = wrap.getBoundingClientRect().height;
    meas.remove();
    const edge = (i) => (i < blocks.length ? tops[i] : totalH); // 第 i 块的起点，i 越界就是全文底

    // ① 按 h2 划节。第一个 h2 之前的东西（h1 标题、导语、题图）归第一节
    const heads = [0, ...blocks.map((el, i) => (el.tagName === 'H2' && i > 0 ? i : -1)).filter((i) => i > 0)];
    // ② 太矮的并进下一节；末节太矮没有下一节，回头并进上一节
    const merged = [];
    heads.forEach((s, k) => {
      const end = k + 1 < heads.length ? heads[k + 1] : blocks.length;
      const prev = merged[merged.length - 1];
      if (prev && edge(prev.end) - edge(prev.start) < SLICE_MIN_H) prev.end = end;
      else merged.push({ start: s, end });
    });
    if (merged.length > 1) {
      const last = merged[merged.length - 1];
      if (edge(last.end) - edge(last.start) < SLICE_MIN_H) { merged[merged.length - 2].end = last.end; merged.pop(); }
    }
    // ③ 太长的在块边界强制断开，且均分而不是贪心塞满——贪心会在末尾剩一条只有两行字的窄条，
    //    均分让 n 片各约 h/n。单块本身就超上限（比如一张超高截图）时宁可让它超，也不切开它
    const groups = [];
    merged.forEach((g) => {
      const h = edge(g.end) - edge(g.start);
      const n = Math.ceil(h / SLICE_MAX_H);
      if (n <= 1) { groups.push(g); return; }
      let s = g.start, made = 0;
      for (let i = g.start + 1; i < g.end && made < n - 1; i++) {
        if (edge(i) - edge(s) >= h / n) { groups.push({ start: s, end: i }); s = i; made++; }
      }
      groups.push({ start: s, end: g.end });
    });

    const fg = themeFg(cfg);
    const outs = [];
    for (let k = 0; k < groups.length; k++) {
      if (onStep) onStep(k + 1, groups.length, 'slice');
      const box = root.cloneNode(false); // 浅克隆：主题容器的 padding / 底色 / 字号原样带过来
      for (let i = groups[k].start; i < groups[k].end; i++) box.appendChild(blocks[i].cloneNode(true));
      // inlineStyles 只给整篇的第一个元素清了 margin-top，其余片开头的 h2 会顶出一大段空白
      const first = box.firstElementChild;
      if (first) first.setAttribute('style', (first.getAttribute('style') || '') + '; margin-top: 0 !important;');
      if (groups.length > 1) box.appendChild(pageMark(k + 1, groups.length, fg));
      outs.push(await renderPng(box, bg));
    }
    const paths = await savePngSet(outs.map((o) => o.dataUrl), srcPath);
    return { ok: true, paths, count: paths.length, heights: outs.map((o) => o.height), ...stat };
  }

  // 「x 字 · 约 y 分钟」：按排好版的可见文字算，md 语法符号和 frontmatter 都不进数。
  // 中文按字数、英文按词数（公众号后台就是这么数的）；400 字/分钟是中文长文的常见语速。
  function stat(el) {
    const t = (el.innerText || el.textContent || '').trim();
    const cjk = (t.match(/[一-鿿぀-ヿ]/g) || []).length;
    const words = (t.replace(/[一-鿿぀-ヿ]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;
    const n = cjk + words;
    return n ? `${n.toLocaleString()} 字 · 约 ${Math.max(1, Math.round(n / 400))} 分钟` : '';
  }

  // 借道 agent 的去向：FanBox 不内建任何第三方 SDK，也不保管任何平台凭证——
  // 只把一条明文指令递进终端，让装了对应 skill 的 agent 去跑。
  // 好处是去向能力随 skill 生态自己生长，不用发版；且整个过程用户看得见、能改能拒。
  // 指令里文件路径单独成行：花叔在终端里点路径能直接打开，前后跟标点就失效了。
  const HANDOFF = [
    {
      id: 'feishu',
      label: '飞书文档 · 交给 agent',
      prompt: (p) => `用 lark-doc skill 把这篇 md 发成飞书文档：\n${p}\n标题取文章的一级标题，正文里的本地图片一并上传，发完把文档链接贴回来。`,
    },
    {
      id: 'dukou-x',
      label: 'X Articles · 渡口',
      prompt: (p) => `用 dukou skill 把这篇 md 渡到 X Articles：\n${p}\n跑 send --dest x --autofill，填完就停，发布我自己来。`,
    },
    {
      id: 'dukou-bili',
      label: 'B站专栏 · 渡口',
      prompt: (p) => `用 dukou skill 把这篇 md 渡到 B站专栏：\n${p}\n跑 send --dest bili --autofill，填完就停，发布我自己来。`,
    },
  ];

  return { list, current, setCurrent, build, copyWechat, copyX, exportImage, exportSlices, stat, handoffs: () => HANDOFF };
})();
