// 微信 ClawBot 链路测试端口：把 bridge.js 直接挂到 HTTP 上，不开 Electron 也能测。
//   桌面聊天（sendDesktop）= 手机微信消息共用的同一条 runAgent 大脑路径，所以测它 = 测了整条 claude/codex 驱动。
//   二维码登录 / 收发也能测：用一个假 win 把 bridge.emit 的事件转成 SSE 推给网页。
//   跑法：node electron/wechat/test-server.js  →  打开 http://localhost:8848
const http = require('http');
const { URL } = require('url');
const path = require('path');
const bridge = require('./bridge');

const PORT = Number(process.env.WX_TEST_PORT) || 8848;

// SSE 客户端池：bridge 的 emit 事件（qr / connected / message / expired）广播到所有网页
const sseClients = new Set();
function broadcast(channel, payload) {
  const line = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { /* */ } }
}
// 假 win：bridge.emit() 调 this.win.webContents.send(ch,m)——这里转成 SSE
const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, m) => broadcast(ch, m) } };

bridge.init(fakeWin);

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => { buf += d; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  try {
    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (p === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/env' && req.method === 'GET') { return json(res, await bridge.env()); }
    if (p === '/api/conversation' && req.method === 'GET') { return json(res, bridge.conversation(u.searchParams.get('id') || '')); }
    if (p === '/api/send' && req.method === 'POST') {
      const { text } = await readBody(req);
      const t0 = Date.now();
      const r = await bridge.sendDesktop(String(text || ''));
      return json(res, { ...r, ms: Date.now() - t0 });
    }
    if (p === '/api/setTarget' && req.method === 'POST') { const { target } = await readBody(req); return json(res, bridge.setTarget(target)); }
    if (p === '/api/setCwd' && req.method === 'POST') { const { dir } = await readBody(req); return json(res, bridge.setCwd(dir)); }
    if (p === '/api/setPersona' && req.method === 'POST') { const { persona } = await readBody(req); return json(res, bridge.setPersona(persona)); }
    if (p === '/api/login' && req.method === 'POST') { bridge.login(); return json(res, { ok: true, started: true }); }
    if (p === '/api/disconnect' && req.method === 'POST') { return json(res, bridge.disconnect()); }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, { ok: false, error: String(e && e.message || e) }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  🧪 微信 ClawBot 测试端口已启动`);
  console.log(`     打开  http://localhost:${PORT}`);
  console.log(`     大脑：claude / codex 无头模式（本机已登录凭据）\n`);
});

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信 ClawBot · 链路测试</title>
<style>
  :root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e6e8ec;--mut:#8b909a;--acc:#3b82f6;--ok:#22c55e;--warn:#f59e0b}
  *{box-sizing:border-box} body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
  .wrap{max-width:880px;margin:0 auto;padding:20px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:var(--mut);font-size:12px;margin-bottom:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  label{color:var(--mut);font-size:12px}
  input,select,textarea{background:#11141a;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px;font:inherit}
  input[type=text]{flex:1;min-width:120px}
  button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
  button.ghost{background:#252a33} button:disabled{opacity:.5;cursor:default}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
  .pill.on{color:var(--ok);border-color:var(--ok)} .pill.off{color:var(--mut)}
  .chat{height:46vh;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:4px}
  .msg{max-width:78%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
  .msg.user{align-self:flex-end;background:var(--acc)} .msg.assistant{align-self:flex-start;background:#252a33}
  .msg .t{font-size:10px;color:rgba(255,255,255,.5);margin-top:3px}
  .meta{color:var(--mut);font-size:11px;margin-top:6px}
  #qr img{width:200px;height:200px;background:#fff;border-radius:8px;padding:6px}
  .grid{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center}
  code{background:#11141a;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
  <h1>微信 ClawBot · 链路测试端口</h1>
  <div class="sub">桌面聊天 = 手机微信消息共用同一条 <code>runAgent</code> 大脑路径，测这里 = 测整条 claude/codex 驱动。</div>

  <div class="card"><div class="grid">
    <label>大脑</label>
    <div class="row" id="targets"></div>
    <label>工作目录</label>
    <div class="row"><input type="text" id="cwd" placeholder="agent 的 cwd"><button class="ghost" onclick="saveCwd()">设为 cwd</button></div>
    <label>微信</label>
    <div class="row"><span id="wxpill" class="pill off">未连接</span>
      <button class="ghost" onclick="login()">扫码登录</button>
      <button class="ghost" onclick="disconnect()">断开</button></div>
  </div><div class="meta" id="env"></div></div>

  <div id="qrcard" class="card" style="display:none"><div class="row"><div id="qr"></div>
    <div class="meta">手机微信扫码 → 确认。状态：<span id="qrst">等待二维码…</span></div></div></div>

  <div class="card">
    <div class="chat" id="chat"></div>
    <div class="row" style="margin-top:10px">
      <input type="text" id="inp" placeholder="给大脑发消息…（Enter 发送）" onkeydown="if(event.key==='Enter')send()">
      <button id="sendbtn" onclick="send()">发送</button>
    </div>
    <div class="meta" id="lat"></div>
  </div>
</div>
<script>
const $=s=>document.querySelector(s);
let cur='claude';
async function api(path,opts){const r=await fetch(path,opts);return r.json()}
function renderTargets(env){
  cur=env.target;
  $('#targets').innerHTML=env.targets.map(t=>{
    const on=t.id===env.target;
    return '<button class="'+(on?'':'ghost')+'" '+(t.available?'':'disabled title="本机未检测到该 CLI"')+' onclick="setTarget(\\''+t.id+'\\')">'+t.label+(t.available?'':' ⚠️')+'</button>';
  }).join('');
}
async function loadEnv(){
  const env=await api('/api/env');
  renderTargets(env);
  $('#cwd').value=env.cwd||'';
  $('#env').textContent='大脑='+env.target+'　目录='+env.cwdName+'　微信='+(env.connected?('已连接 '+env.account):'未连接');
  $('#wxpill').className='pill '+(env.connected?'on':'off');
  $('#wxpill').textContent=env.connected?('已连接 '+(env.account||'')):'未连接';
}
async function setTarget(t){await api('/api/setTarget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:t})});loadEnv()}
async function saveCwd(){await api('/api/setCwd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:$('#cwd').value})});loadEnv()}
function bubble(m){const d=document.createElement('div');d.className='msg '+m.role;d.innerHTML='';d.textContent=m.text;const t=document.createElement('div');t.className='t';t.textContent=(m.role==='user'?'我':cur)+' · '+(m.time||'');d.appendChild(t);return d}
function renderChat(msgs){const c=$('#chat');c.innerHTML='';for(const m of msgs)c.appendChild(bubble(m));c.scrollTop=c.scrollHeight}
async function loadChat(){const r=await api('/api/conversation?id=desktop');renderChat(r.messages||[])}
async function send(){
  const inp=$('#inp');const text=inp.value.trim();if(!text)return;
  inp.value='';$('#sendbtn').disabled=true;$('#lat').textContent='思考中…';
  const c=$('#chat');const u={role:'user',text,time:''};c.appendChild(bubble(u));c.scrollTop=c.scrollHeight;
  try{
    const r=await api('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    renderChat(r.messages||[]);
    $('#lat').textContent='耗时 '+(r.ms||0)+' ms（'+cur+'）';
  }catch(e){$('#lat').textContent='出错：'+e}
  $('#sendbtn').disabled=false;inp.focus();
}
async function login(){$('#qrcard').style.display='';$('#qrst').textContent='取二维码中…';await api('/api/login',{method:'POST'})}
async function disconnect(){await api('/api/disconnect',{method:'POST'});loadEnv()}
// SSE：二维码 / 连接成功 / 新消息
const ev=new EventSource('/events');
ev.onmessage=(e)=>{
  const {channel,payload}=JSON.parse(e.data);
  if(channel==='wechat:qr'){
    if(payload.expired){$('#qrst').textContent='二维码已过期，重新点扫码登录'}
    else if(payload.dataUrl){$('#qr').innerHTML='<img src="'+payload.dataUrl+'">';$('#qrst').textContent='请用手机微信扫码'}
  }
  if(channel==='wechat:connected'){$('#qrcard').style.display='none';loadEnv()}
  if(channel==='wechat:expired'){$('#qrst').textContent='token 失效，请重新登录';loadEnv()}
  if(channel==='wechat:message'){loadChat()}
};
loadEnv();loadChat();
</script></body></html>`;
