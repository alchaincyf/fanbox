# 图集压力监视 + 真重建验收（2026-07）

2.6.1 之后中文乱码仍频繁复发的根治轮。两个新根因：

1. **`clearTextureAtlas` 是假重置**：上游实现只清空每页内容（`page.clear()`），`_pages.length` 只增不减；分页合并产出的大页不在 `_activePages` 里，清空后永久占坑不可写。图集用久了必然退化到页数顶格（`maxAtlasPages = min(32, MAX_TEXTURE_IMAGE_UNITS)`，Mac 上是 16），之后每次开新页都走合并分支——合并正是画出别字碎片的上游 bug 引爆点。定时保养救不了当下也回不了血。
2. **合并随时可能发生在两次保养之间**，多标签共享图集时其他标签的字瞬间悬空。

修法：监听 `WebglAddon.onAddTextureAtlasCanvas`（每开一页新图集触发一次，同一页被共享它的每个标签各转发一次，WeakSet 去重后计数≈真实页数），页数到 12 就 `recycleWebgl()`——所有标签的 WebGL 插件**先全部销毁再全部重装**（图集按引用计数存活，边销毁边重装会捡回退化的旧图集）。合并从机制上不再可能发生。

跑验收：`node experiments/atlas-pressure-202607/verify.js`（Playwright 驱动 Electron，假 HOME）。
实测数据点：4000 汉字 × 8 色（3.2 万字形）把页数推到 10——真实的中文重度会话轻松逼近 16 页合并线。
