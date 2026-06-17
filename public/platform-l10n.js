'use strict';
/**
 * FanBox 平台本地化 —— 把 macOS 习惯的措辞/键符改成 Windows 习惯。
 * 仅在 Windows 上启用；照搬 i18n.js 的 MutationObserver 模式，集中改写文本节点 +
 * title/placeholder/aria-label/data-tip 属性，app.js 不需要散布平台判断（与 i18n 互补、互不冲突）。
 *
 * 改写规则（幂等，改过一次的文本再访问是 no-op，不会和 i18n 的观察器互相触发死循环）：
 *   键符：⌘→Ctrl、⇧→Shift、↵→Enter，并在连续键名间补 '+'（⌘K→Ctrl+K、⇧⌘Z→Ctrl+Shift+Z、⌘↵→Ctrl+Enter）
 *   词汇：废纸篓→回收站、访达→资源管理器、Finder→Explorer、Trash→Recycle Bin（EN 模式下 i18n 已译成英文，这里接着翻成 Win 习惯）
 * 用户内容区（预览正文 / 编辑器 / 终端 / 灯箱）一律不碰——同 i18n 的 SKIP。
 */
(() => {
  if (!/Windows/.test(navigator.userAgent)) return; // 非 Windows 完全不启用

  const KEYS = /[⌘⇧↵]/;
  const TERMS = /废纸篓|访达|\bFinder\b|\bTrash\b/;
  function winText(s) {
    if (!s || (!KEYS.test(s) && !TERMS.test(s))) return s;
    // 键符：先替换字符，再在「修饰键/Enter 紧跟字母」处插 '+' 分隔
    if (KEYS.test(s)) {
      s = s.replace(/⌘/g, 'Ctrl').replace(/⇧/g, 'Shift').replace(/↵/g, 'Enter')
        .replace(/(Ctrl|Shift|Enter)(?=[A-Za-z])/g, '$1+');
    }
    // 词汇：用 split/join 避免 regex 转义问题；Finder/Trash 用词边界避免误伤
    if (s.indexOf('废纸篓') >= 0) s = s.split('废纸篓').join('回收站');
    if (s.indexOf('访达') >= 0) s = s.split('访达').join('资源管理器');
    s = s.replace(/\bFinder\b/g, 'Explorer').replace(/\bTrash\b/g, 'Recycle Bin');
    return s;
  }

  // 用户内容区不碰（与 i18n 完全一致的边界）
  const SKIP = '#preview-body, #ed-host, .xterm, .milkdown, .lightbox, .cp-name, .cp-dir';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip'];
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const p = node.parentElement;
      if (p && p.closest(SKIP)) return;
      const out = winText(node.nodeValue);
      if (out !== node.nodeValue) node.nodeValue = out;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest(SKIP)) return;
    for (const a of ATTRS) {
      const v = node.getAttribute(a);
      if (v) { const out = winText(v); if (out !== v) node.setAttribute(a, out); }
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
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
