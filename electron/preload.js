'use strict';
/**
 * 安全桥接：把终端 IPC 暴露给渲染进程（contextIsolation 下唯一的通道）。
 * 渲染进程通过 window.fanboxPty 控制 node-pty，window.fanboxEnv 判断是否在桌面 app 内。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fanboxPty', {
  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  input: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  cwd: (id) => ipcRenderer.invoke('pty:cwd', { id }),
  proc: (id) => ipcRenderer.invoke('pty:proc', { id }),
  onData: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('pty:data', h); return () => ipcRenderer.removeListener('pty:data', h); },
  onExit: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('pty:exit', h); return () => ipcRenderer.removeListener('pty:exit', h); },
});

contextBridge.exposeInMainWorld('fanboxRec', {
  list: () => ipcRenderer.invoke('rec:list'),
  read: (path) => ipcRenderer.invoke('rec:read', { path }),
  remove: (path) => ipcRenderer.invoke('rec:delete', { path }),
  reveal: (path) => ipcRenderer.invoke('rec:reveal', { path }),
  saveExport: (name, buf) => ipcRenderer.invoke('rec:save-export', { name, buf }),
  export: (name, buf, format) => ipcRenderer.invoke('rec:export', { name, buf, format }), // WebM 字节 → 按 format 转 mp4/gif（无 ffmpeg 退回 webm）
});

contextBridge.exposeInMainWorld('fanboxFs', {
  watch: (dir) => ipcRenderer.invoke('fs:watch', { dir }),
  watchSet: (dirs) => ipcRenderer.invoke('fs:watch-set', { dirs }),
  onChanged: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('fs:changed', h); return () => ipcRenderer.removeListener('fs:changed', h); },
});

contextBridge.exposeInMainWorld('fanboxClipboard', {
  copyImage: (path) => ipcRenderer.invoke('clip:image', { path }),
  copyFile: (path) => ipcRenderer.invoke('clip:file', { path }),
  // 终端粘贴用：剪贴板里是文字/图片/文件？图片和文件都换成本机路径（navigator.clipboard 只看得见文字）
  readForPaste: () => ipcRenderer.invoke('clip:read'),
});

contextBridge.exposeInMainWorld('fanboxDrop', {
  // 系统拖入的 File → 真实路径（Electron 32+ 移除了 File.path，须走 webUtils）
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  // file-promise 类拖拽（如 macOS 截图浮窗缩略图）没有现成路径：把内容落盘到临时目录换一个路径
  saveTemp: (name, buf) => ipcRenderer.invoke('drop:save', { name, buf }),
  // 拖进文件区：没路径的拖入内容（截图浮窗等）直接存进目标目录
  saveInto: (dir, name, buf) => ipcRenderer.invoke('drop:save-into', { dir, name, buf }),
  // 拖进文件区：已有路径的文件（Finder 文件）复制进目标目录
  copyInto: (srcPath, dir) => ipcRenderer.invoke('drop:copy-into', { srcPath, dir }),
  // md 编辑器「插入图片」按钮：原生选图对话框，defaultPath 控制默认打开的目录
  pickImages: (defaultPath) => ipcRenderer.invoke('drop:pick-images', { defaultPath }),
});

contextBridge.exposeInMainWorld('fanboxShot', {
  // 系统截屏落盘事件（截图直通车）
  onNew: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('shot:new', h); return () => ipcRenderer.removeListener('shot:new', h); },
});

contextBridge.exposeInMainWorld('fanboxUpdate', {
  onAvailable: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('update:available', h); return () => ipcRenderer.removeListener('update:available', h); },
  get: () => ipcRenderer.invoke('update:get'), // 拉一把启动早期可能错过的推送
  open: (url) => ipcRenderer.invoke('update:open', { url }),
  download: process.platform === 'darwin' ? (version) => ipcRenderer.invoke('update:download', { version }) : undefined, // #26 应用内下载对应架构 dmg（Linux 无 dmg，走发布页，见 docs/15）
  onProgress: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('update:progress', h); return () => ipcRenderer.removeListener('update:progress', h); },
});

contextBridge.exposeInMainWorld('fanboxWin', {
  focus: () => ipcRenderer.invoke('win:focus'), // 点通知拉回前台
  trafficLights: (show) => ipcRenderer.invoke('win:traffic', { show }), // 全屏预览时藏/显左上角系统按钮
});

// Agent 控制接口（/api/agent/*）的渲染侧配合：main 请求开新终端 tab + 被控 tab 闪标记
contextBridge.exposeInMainWorld('fanboxAgentCtl', {
  onCreate: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('agent:term-create', h); return () => ipcRenderer.removeListener('agent:term-create', h); },
  created: (m) => ipcRenderer.send('agent:term-created', m),
  onTouch: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('agent:touch', h); return () => ipcRenderer.removeListener('agent:touch', h); },
});

contextBridge.exposeInMainWorld('fanboxEnv', {
  isDesktopApp: true,
  platform: process.platform,
});

// 电源守卫：侧栏「离开电脑」两个开关（合盖继续干活 / 微信遥控不断线），macOS 专属
contextBridge.exposeInMainWorld('fanboxPower', {
  state: () => ipcRenderer.invoke('power:state'),            // { platform, lid, wechat, active, busy, terms, wechatConnected }
  setLid: (on) => ipcRenderer.invoke('power:setLid', { on }),
  setWechat: (on) => ipcRenderer.invoke('power:setWechat', { on }),
  onChange: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('power:changed', h); return () => ipcRenderer.removeListener('power:changed', h); },
});

// 微信 ClawBot：不经 openclaw，直连 iLink + 本机 claude/codex；桌面输入框也能直接和本机大脑聊
contextBridge.exposeInMainWorld('fanboxWechat', {
  env: () => ipcRenderer.invoke('wechat:env'),            // { connected, account, target, targets, cwd, cwdName }
  login: () => ipcRenderer.invoke('wechat:login'),        // 取二维码→轮询扫码（二维码/成功走事件）
  setTarget: (target) => ipcRenderer.invoke('wechat:setTarget', { target }), // 切换大脑 codex / claude
  setCwd: (dir) => ipcRenderer.invoke('wechat:setCwd', { dir }), // agent 工作目录跟随当前项目
  setPersona: (persona) => ipcRenderer.invoke('wechat:setPersona', { persona }), // 自定义微信 bot 人格
  send: (text) => ipcRenderer.invoke('wechat:send', { text }),   // 桌面输入框→本机大脑（不经微信）
  conversation: (id) => ipcRenderer.invoke('wechat:conversation', { id }), // 取某会话消息（默认当前活跃）+ token 用量
  newConversation: (id) => ipcRenderer.invoke('wechat:newConversation', { id }), // 新对话（硬重置 session，靠记忆续）
  compact: (id) => ipcRenderer.invoke('wechat:compact', { id }),         // 整理对话（flush 记忆 + 摘要续场 + 换 session）
  disconnect: () => ipcRenderer.invoke('wechat:disconnect'),
  cancel: () => ipcRenderer.invoke('wechat:cancel'),
  check: () => ipcRenderer.invoke('wechat:check'),                     // 主动探活 → { state: connected/expired/unreachable/disconnected }
  onQr: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('wechat:qr', h); return () => ipcRenderer.removeListener('wechat:qr', h); },
  onConnected: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('wechat:connected', h); return () => ipcRenderer.removeListener('wechat:connected', h); },
  onMessage: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('wechat:message', h); return () => ipcRenderer.removeListener('wechat:message', h); },
  onExpired: (cb) => { const h = (e, m) => cb(m); ipcRenderer.on('wechat:expired', h); return () => ipcRenderer.removeListener('wechat:expired', h); },
});
