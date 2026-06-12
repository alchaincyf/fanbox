'use strict';
/**
 * FanBox i18n —— 集中式翻译层。
 * 词典在 i18n-dict.js（英文原文为键 → 简中译文）；英文是源语言，en 模式下本文件几乎不做事。
 * lang 取值：'en'（源语言，恒等）/ 'zh'（内建简中词典）/ 'custom:<id>'（用户匯入的语言包，en 键空间）。
 * 翻译机制：MutationObserver 在微任务时机翻译新增/变更的文本节点和 title/placeholder 属性，
 * 绘制前完成、无闪烁，app.js 不需要散布翻译调用。用户内容区（预览/编辑器/终端）一律不碰。
 */
(() => {
  const saved = localStorage.getItem('fb_lang');
  const sys = (navigator.language || 'en').toLowerCase();
  const isCustom = (l) => typeof l === 'string' && /^custom:[a-z0-9-]{1,40}$/.test(l);
  const lang = saved === 'zh' || saved === 'en' || isCustom(saved) ? saved : (sys.startsWith('zh') ? 'zh' : 'en');
  window.fanboxLang = lang;

  // 语言切换：记到 localStorage（渲染层）+ config.json（Electron 菜单读），刷新生效
  // langTag：custom 语言包声明的 BCP-47 标签，写入 config 供 Electron 原生菜单判断 zh/en
  window.fanboxSetLang = (l, langTag) => {
    const nextId = isCustom(l) ? l.slice(7) : null;
    // 切到非 custom，或切到的包与已缓存的包不同 id：清掉旧缓存，避免下次启动用错词典
    if (nextId === null) {
      localStorage.removeItem('fb_custom_pack');
    } else {
      try {
        const c = JSON.parse(localStorage.getItem('fb_custom_pack') || 'null');
        if (!c || c.id !== nextId) localStorage.removeItem('fb_custom_pack');
      } catch { localStorage.removeItem('fb_custom_pack'); }
    }
    localStorage.setItem('fb_lang', l);
    fetch('/api/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l, langTag }) })
      .catch(() => {}).finally(() => location.reload());
  };

  // ---------- 词典/规则来源参数化 ----------
  // zh：内建词典（i18n-dict.js）；custom：导入的语言包（先用缓存，后台刷新）；en：恒等，不需要词典
  let dict = () => ({});
  let rules = () => [];
  let pendingPackFetch = null;
  let packLangTag = ''; // custom 语言包声明的 BCP-47 标签，写入 documentElement.lang
  let packName = ''; // custom 语言包显示名，toggle 短标签用

  const compileRules = (rawRules) => (rawRules || []).map(([src, rep]) => {
    try { return [new RegExp(src), rep]; } catch { return null; }
  }).filter(Boolean);

  const applyPack = (pack) => {
    const d = (pack && pack.dict) || {};
    const r = compileRules(pack && pack.rules);
    dict = () => d;
    rules = () => r;
    packLangTag = (pack && pack.lang) || '';
    packName = (pack && pack.name) || '';
  };

  const fetchPack = (id) => fetch('/api/lang-pack?id=' + encodeURIComponent(id))
    .then((r) => r.json())
    .then((pack) => {
      if (pack && pack.id === id && pack.dict) {
        localStorage.setItem('fb_custom_pack', JSON.stringify({ id: pack.id, name: pack.name, lang: pack.lang, dict: pack.dict, rules: pack.rules || [] }));
        return pack;
      }
      return null;
    })
    .catch(() => null);

  if (lang === 'zh') {
    dict = () => window.FANBOX_DICT || {};
    rules = () => window.FANBOX_DICT_RULES || [];
  } else if (isCustom(lang)) {
    const id = lang.slice(7);
    let cached = null;
    try {
      const c = JSON.parse(localStorage.getItem('fb_custom_pack') || 'null');
      if (c && c.id === id) cached = c;
    } catch { /* 缓存损坏，走 fetch */ }
    if (cached) {
      applyPack(cached);
      // 后台刷新缓存，下次 reload 生效
      fetchPack(id);
    } else {
      // 无匹配缓存：先 fetch 再启动 observer（一次性闪烁可接受）
      pendingPackFetch = fetchPack(id).then((pack) => {
        if (pack) applyPack(pack);
        // fetch 失败时 dict/rules 维持空 → tr() 对未命中词条原样返回，等同 zh 回退
      });
    }
  }

  // ---------- 语言菜单：弹出选单 + 匯入语言包 ----------
  const LANG_NAMES = { zh: '简体中文', en: 'English' };
  // toggle 短标签：当前语言名缩写（简 / EN / 已匯入包名前两字）
  const shortLabel = () => {
    if (lang === 'zh') return '简';
    if (lang === 'en') return 'EN';
    return (packName || packLangTag || '简').slice(0, 2);
  };

  let menuEl = null;
  const closeMenu = () => { if (menuEl) { menuEl.remove(); menuEl = null; } document.removeEventListener('click', onOutsideClick); document.removeEventListener('keydown', onEscKey); };
  const onOutsideClick = (ev) => { if (menuEl && !menuEl.contains(ev.target) && ev.target.id !== 'lang-toggle') closeMenu(); };
  const onEscKey = (ev) => { if (ev.key === 'Escape') closeMenu(); };

  // alert 不在 DOM 里，MutationObserver 翻不到：自带词条用 window.t（此时已就绪），服务端报错原样显示
  const tt = (s) => (typeof window.t === 'function' ? window.t(s) : s);

  const doImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let pack;
        try { pack = JSON.parse(String(reader.result)); } catch { alert(tt('Import failed: not a valid JSON file')); return; }
        if (!pack || typeof pack !== 'object' || !pack.id || !pack.name || !pack.lang || !pack.dict || typeof pack.dict !== 'object') {
          alert(tt('Import failed: language pack is missing id / name / lang / dict fields'));
          return;
        }
        fetch('/api/lang-pack/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pack) })
          .then((r) => r.json())
          .then((res) => {
            if (!res.ok) { alert(tt('Import failed: ') + (res.error || tt('Unknown error'))); return; }
            localStorage.setItem('fb_custom_pack', JSON.stringify({ id: pack.id, name: pack.name, lang: pack.lang, dict: pack.dict, rules: pack.rules || [] }));
            window.fanboxSetLang('custom:' + pack.id, pack.lang);
          })
          .catch(() => alert(tt('Import failed: network error')));
      };
      reader.readAsText(file);
    };
    document.body.appendChild(input);
    input.click();
  };

  const buildMenu = (toggle, packs) => {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'lang-menu';
    const addItem = (label, value, langTag) => {
      const item = document.createElement('div');
      item.className = 'lang-menu-item' + (value === lang ? ' active' : '');
      item.textContent = label;
      item.onclick = () => { closeMenu(); window.fanboxSetLang(value, langTag); };
      menu.appendChild(item);
    };
    addItem(LANG_NAMES.zh, 'zh');
    addItem(LANG_NAMES.en, 'en');
    for (const pack of packs) addItem(pack.name, 'custom:' + pack.id, pack.lang);
    const sep = document.createElement('div');
    sep.className = 'lang-menu-sep';
    menu.appendChild(sep);
    const importItem = document.createElement('div');
    importItem.className = 'lang-menu-item';
    importItem.textContent = 'Import language pack…';
    importItem.onclick = () => { closeMenu(); doImport(); };
    menu.appendChild(importItem);

    document.body.appendChild(menu);
    const rect = toggle.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    menuEl = menu;
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onEscKey);
  };

  const wireToggle = () => {
    const el = document.getElementById('lang-toggle');
    if (!el) return;
    el.title = 'Switch interface language';
    el.textContent = shortLabel();
    el.onclick = (ev) => {
      ev.stopPropagation();
      if (menuEl) { closeMenu(); return; }
      fetch('/api/lang-packs').then((r) => r.json()).then((res) => {
        const packs = (res && res.ok && res.packs) || [];
        buildMenu(el, packs);
      }).catch(() => buildMenu(el, []));
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireToggle);
  else wireToggle();

  if (lang === 'en') { window.t = (s) => s; return; }

  const trOne = (core) => {
    const hit = dict()[core];
    if (hit !== undefined) return hit;
    for (const [re, rep] of rules()) {
      const m = core.match(re);
      if (m) {
        try { return typeof rep === 'function' ? rep(m) : core.replace(re, rep); } catch { /* 规则异常不挡显示 */ }
      }
    }
    return null;
  };
  const tr = (s) => {
    if (!s) return s;
    const core = s.trim();
    if (!core) return s; // 纯空白/空字符串：提前返回，省一次查表
    const whole = trOne(core);
    if (whole !== null) return s.replace(core, whole);
    // 复合文案（「just now · 12 messages · changed 16 files」）整段匹配不上：按 · 分段逐段翻
    if (core.includes('·')) {
      const segs = core.split('·').map((x) => x.trim()).filter(Boolean);
      const parts = segs.map((x) => trOne(x) ?? x);
      if (parts.some((x, i) => x !== segs[i])) {
        const joined = parts.join(' · ') + (/·\s*$/.test(core) ? ' · ' : '');
        return s.replace(core, joined);
      }
    }
    return s;
  };
  window.t = tr;

  // 用户内容区不翻译：文件预览正文、三种编辑器、终端、灯箱
  const SKIP = '#preview-body, #ed-host, .xterm, .milkdown, .lightbox, .cp-name, .cp-dir';
  const ATTRS = ['title', 'placeholder'];
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const p = node.parentElement;
      if (p && p.closest(SKIP)) return;
      const out = tr(node.nodeValue);
      if (out !== node.nodeValue) node.nodeValue = out;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest(SKIP)) return;
    for (const a of ATTRS) {
      const v = node.getAttribute(a);
      if (v) { const out = tr(v); if (out !== v) node.setAttribute(a, out); }
    }
    for (const c of [...node.childNodes]) visit(c);
  };
  const ob = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData' || m.type === 'attributes') visit(m.target.nodeType ? m.target : m.target);
      else m.addedNodes.forEach(visit);
    }
  });
  const start = () => {
    visit(document.body);
    ob.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : (packLangTag || lang.slice(7));
  };
  const startWhenReady = () => {
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  };
  if (pendingPackFetch) pendingPackFetch.then(startWhenReady);
  else startWhenReady();
})();
