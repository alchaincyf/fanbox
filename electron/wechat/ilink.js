// iLink 客户端：微信 ClawBot 底层是腾讯官方的 iLink HTTP JSON 协议（ilinkai.weixin.qq.com）。
// 这里自研实现那几个接口，彻底脱离 openclaw。协议规范参考见 docs/08-微信ClawBot-参考与署名.md。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOGIN_BASE = 'https://ilinkai.weixin.qq.com'; // 二维码登录恒用主域名
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'; // 媒体字节流上传到 CDN（不是主域名）
const BOT_TYPE = '3';
const CHANNEL_VERSION = '1.0.11';
// 按扩展名判定走图片消息还是文件消息（微信里图片能直接预览，其余当文件附件）
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

// uint32 版本号 0x00MMNNPP → 十进制字符串
function clientVersion(v) {
  const [maj = 0, min = 0, pat = 0] = String(v).split('.').map((x) => parseInt(x, 10) || 0);
  return String(((maj & 0xff) << 16) | ((min & 0xff) << 8) | (pat & 0xff));
}
// 每次请求重算：随机 uint32 → 十进制字符串 → utf8 → base64
function wechatUin() {
  const n = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), 'utf-8').toString('base64');
}
function commonHeaders() {
  return { 'iLink-App-ClientVersion': clientVersion(CHANNEL_VERSION) };
}
function postHeaders(token) {
  const h = { ...commonHeaders(), 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': wechatUin() };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: 'FanBox' });

async function httpJson(url, { method = 'POST', headers, body, timeoutMs = 15000, signal } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
    return { ok: res.ok, status: res.status, json };
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); }
}

// ---------- 登录 ----------
// 取二维码：官方实现是 POST，body 带本地已存 token（没有就空数组）
async function fetchQrcode() {
  const url = `${LOGIN_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const r = await httpJson(url, { method: 'POST', headers: postHeaders(), body: { local_token_list: [] }, timeoutMs: 15000 });
  if (!r.ok) throw new Error(`get_bot_qrcode 失败 HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json; // { qrcode, qrcode_img_content }
}
// 轮询扫码状态（长轮询，单轮 35s）。返回 raw status 对象，由调用方按 status 分支。
async function pollQrStatus(baseUrl, qrcode, verifyCode, signal) {
  let url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) url += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const r = await httpJson(url, { method: 'GET', headers: commonHeaders(), timeoutMs: 35000, signal });
    return r.json || { status: 'wait' };
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return { status: 'wait' }; // 客户端超时当继续等
  }
}

// ---------- 收发 ----------
async function getUpdates(account, getUpdatesBuf, timeoutMs, signal) {
  const url = `${account.baseUrl}/ilink/bot/getupdates`;
  const r = await httpJson(url, { headers: postHeaders(account.token), body: { get_updates_buf: getUpdatesBuf || '', base_info: baseInfo() }, timeoutMs: timeoutMs || 35000, signal });
  return r.json || { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
}
function buildTextReq(toUserId, text, contextToken) {
  return { msg: {
    from_user_id: '', to_user_id: toUserId,
    client_id: crypto.randomBytes(8).toString('hex'),
    message_type: 2, message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: contextToken || '',
  }, base_info: baseInfo() };
}
async function sendText(account, toUserId, text, contextToken) {
  const url = `${account.baseUrl}/ilink/bot/sendmessage`;
  return httpJson(url, { headers: postHeaders(account.token), body: buildTextReq(toUserId, text, contextToken), timeoutMs: 15000 });
}
// 正在输入指示（可选体验）
async function sendTyping(account, userId, on) {
  try {
    const cfg = await httpJson(`${account.baseUrl}/ilink/bot/getconfig`, { headers: postHeaders(account.token), body: { ilink_user_id: userId, base_info: baseInfo() }, timeoutMs: 8000 });
    const ticket = cfg.json && cfg.json.typing_ticket;
    if (!ticket) return;
    await httpJson(`${account.baseUrl}/ilink/bot/sendtyping`, { headers: postHeaders(account.token), body: { ilink_user_id: userId, typing_ticket: ticket, status: on ? 1 : 2, base_info: baseInfo() }, timeoutMs: 8000 });
  } catch { /* 输入指示失败无所谓 */ }
}

// 轻量探活：用 getconfig（带凭证、返回快）确认连接/token 是否仍有效。返回 { ok, status, json }。
async function ping(account) {
  return httpJson(`${account.baseUrl}/ilink/bot/getconfig`, {
    headers: postHeaders(account.token),
    body: { ilink_user_id: account.userId || '', base_info: baseInfo() },
    timeoutMs: 8000,
  });
}

// ---------- 发媒体（图片 / 文件）----------
// 三段式：getuploadurl 拿上传参数 → 把 AES 密文 POST 到 CDN → sendmessage 带 media 引用。
//  AES-128-ECB + PKCS7，key 自己随机生成；同一 key 既加密字节、又（hex）填 getuploadurl、又（base64(hex)）填消息。
function md5hex(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function aesEncryptEcb(plain, keyBuf) { const c = crypto.createCipheriv('aes-128-ecb', keyBuf, null); return Buffer.concat([c.update(plain), c.final()]); }

async function getUploadUrl(account, body) {
  const r = await httpJson(`${account.baseUrl}/ilink/bot/getuploadurl`, { headers: postHeaders(account.token), body, timeoutMs: 15000 });
  if (!r.ok) throw new Error(`getuploadurl HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json || {};
}
// 把密文 POST 到 CDN，从响应头 x-encrypted-param 拿下载参数（发消息要用）
async function cdnUpload(uploadFullUrl, fallbackUrl, ciphertext) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(uploadFullUrl || fallbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext, signal: ac.signal });
    const enc = res.headers.get('x-encrypted-param');
    if (!enc) throw new Error(`CDN 上传失败 ${res.headers.get('x-error-message') || ('HTTP ' + res.status)}`);
    return enc;
  } finally { clearTimeout(t); }
}
// 发一个本地文件（按扩展名自动走图片或文件消息）给某用户
async function sendMedia(account, toUserId, filePath, contextToken) {
  const plain = fs.readFileSync(filePath);
  const rawsize = plain.length;
  if (!rawsize) throw new Error('空文件');
  const isImg = IMG_EXT.has((path.extname(filePath).slice(1) || '').toLowerCase());
  const keyBuf = crypto.randomBytes(16);
  const aeskeyHex = keyBuf.toString('hex');
  const filekey = crypto.randomBytes(16).toString('hex');
  const cipher = aesEncryptEcb(plain, keyBuf); // PKCS7：密文长度 = ceil((rawsize+1)/16)*16
  const up = await getUploadUrl(account, {
    filekey, media_type: isImg ? 1 : 3, to_user_id: toUserId,
    rawsize, rawfilemd5: md5hex(plain), filesize: cipher.length,
    no_need_thumb: true, aeskey: aeskeyHex, base_info: baseInfo(),
  });
  const fallback = `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param || '')}&filekey=${encodeURIComponent(filekey)}`;
  const enc = await cdnUpload(up.upload_full_url, fallback, cipher);
  const media = { encrypt_query_param: enc, aes_key: Buffer.from(aeskeyHex).toString('base64'), encrypt_type: 1 };
  const item = isImg
    ? { type: 2, image_item: { media, mid_size: cipher.length } }
    : { type: 4, file_item: { media, file_name: path.basename(filePath), len: String(rawsize) } };
  const body = { msg: {
    from_user_id: '', to_user_id: toUserId, client_id: crypto.randomBytes(8).toString('hex'),
    message_type: 2, message_state: 2, item_list: [item], context_token: contextToken || '',
  }, base_info: baseInfo() };
  const r = await httpJson(`${account.baseUrl}/ilink/bot/sendmessage`, { headers: postHeaders(account.token), body, timeoutMs: 20000 });
  if (!r.ok) throw new Error(`sendmessage(media) HTTP ${r.status}`);
  return r.json;
}

// ---------- 收媒体（图片 / 文件）----------
// 发媒体的逆运算：从入站 item 里拿下载地址 + 密钥 → GET 密文 → AES-128-ECB 解密去 PKCS7 → 落盘。
//  密钥来源：item.aeskey（hex，已验证）优先；退回 base64(hex) 的 media.aes_key。
//  下载地址：media.full_url（已验证）优先；退回用 encrypt_query_param 拼 CDN download。
function imgExtFromMagic(buf) {
  const h = buf.slice(0, 4).toString('hex');
  if (h.startsWith('ffd8')) return 'jpg';
  if (h.startsWith('89504e47')) return 'png';
  if (h.startsWith('47494638')) return 'gif';
  if (h.startsWith('52494646')) return 'webp';
  return 'bin';
}
async function downloadMedia(item, destDir) {
  const media = item.media || {};
  const url = media.full_url || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param || '')}`;
  let keyHex = item.aeskey || '';
  if (!/^[0-9a-fA-F]{32}$/.test(keyHex) && media.aes_key) { try { keyHex = Buffer.from(media.aes_key, 'base64').toString('utf8'); } catch { /* */ } }
  if (!/^[0-9a-fA-F]{32}$/.test(keyHex)) throw new Error('拿不到解密密钥');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  let cipher;
  try { const res = await fetch(url, { signal: ac.signal }); if (!res.ok) throw new Error(`下载 HTTP ${res.status}`); cipher = Buffer.from(await res.arrayBuffer()); }
  finally { clearTimeout(t); }
  const d = crypto.createDecipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null); // setAutoPadding 默认 true，自动去 PKCS7
  const plain = Buffer.concat([d.update(cipher), d.final()]);
  if (!plain.length) throw new Error('解密后为空');
  // 文件名：file_item 用原名（去路径分隔防穿越）；图片按 magic 猜扩展名
  let name = item.file_name ? path.basename(String(item.file_name)) : `wx-image-${Date.now()}.${imgExtFromMagic(plain)}`;
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, name);
  if (fs.existsSync(dest)) { const e = path.extname(name); dest = path.join(destDir, `${path.basename(name, e)}-${Date.now()}${e}`); } // 防重名
  fs.writeFileSync(dest, plain);
  return dest;
}

// 从一条收到的消息里提取内容：纯文本（文本/语音转写）+ 媒体附件（图片/文件）。
// 媒体的真实下载/解密待 downloadMedia 实现（入站字段结构需真实样本确认，先把 item 原样带出）。
function contentFromMsg(msg) {
  let text = '';
  const medias = [];
  for (const it of msg.item_list || []) {
    if (it.type === 1 && it.text_item && it.text_item.text != null) text = it.text_item.text;
    else if (it.type === 3 && it.voice_item && it.voice_item.text) text = it.voice_item.text;
    else if (it.type === 2 && it.image_item) medias.push({ kind: 'image', name: it.image_item.file_name || '图片', item: it.image_item });
    else if (it.type === 4 && it.file_item) medias.push({ kind: 'file', name: it.file_item.file_name || '文件', item: it.file_item });
  }
  return { text, medias };
}

// ---------- 本地持久化 ----------
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch { /* */ } }

module.exports = {
  LOGIN_BASE, fetchQrcode, pollQrStatus, getUpdates, sendText, sendTyping, sendMedia, downloadMedia, contentFromMsg, readJson, writeJson, ping,
};
