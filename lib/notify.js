'use strict';
// 叫人：任何终端里的 agent（或一条普通命令）请 FanBox 给用户发一条消息。
// 这里只有判断和文案，纯函数；通道（微信、飞书）和发件箱在 electron/wechat/bridge.js，接线在 electron/main.js 的 agentNotify。
const crypto = require('crypto');

const MAX_LEN = 600;             // 一条消息的长度上限：手机上一屏读完
const AT_DESK_S = 120;           // 系统 2 分钟内有键鼠输入 = 人在电脑前，不往手机发
const DUP_MS = 30 * 60000;       // 同一个窗口 30 分钟内说过一模一样的话不再发
const TERM_GAP_MS = 60000;       // 同一个窗口两条之间至少隔 1 分钟：挡住写错了的循环

function clean(text) {
  const t = String(text == null ? '' : text).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN - 1) + '…' : t;
}

// 这一条怎么处理。ctx：{ on 值守开着, channel 有通道, idleS 系统空闲秒数, last 这个窗口上一条 { at, text } }
// 返回 { action: 'reject'|'desktop'|'skip'|'phone', why, note }。note 是给调用它的 agent 看的一句话
function decide(text, ctx, now) {
  if (!text) return { action: 'reject', why: 'empty', note: '没有内容。用法：fanbox-notify "一两句话，带结论和需要用户回什么"' };
  if (!ctx.on) return { action: 'reject', why: 'off', note: '用户关掉了值守，消息没有发。不要重试，把话留在这个窗口里' };
  if (!ctx.channel) return { action: 'reject', why: 'no_channel', note: '用户没有连微信或飞书，消息没有发。不要重试，把话留在这个窗口里' };
  const last = ctx.last;
  if (last && last.text === text && now - last.at < DUP_MS) return { action: 'skip', why: 'dup', note: '这句话半小时内已经发过，没有重复发' };
  if (last && now - last.at < TERM_GAP_MS) return { action: 'skip', why: 'too_soon', note: '这个窗口一分钟内刚发过一条，这条没有发。要说的话并成一条再发' };
  if (ctx.idleS < AT_DESK_S) return { action: 'desktop', why: 'at_desk', note: '用户正在电脑前，已经在 FanBox 里提示，没有发到手机' };
  return { action: 'phone', why: 'away', note: '已交给发件箱，会发到用户手机（夜里 23 点到早上 8 点会攒到早上）' };
}

// 发到手机的那一条：开头标明是哪个窗口说的，用户回话时微信那头的 agent 才知道转给谁
function label(text, term, name) { return `「${name || '终端'} ${term}」${text}`; }

// 告诉 agent 有这个能力、什么时候用。每个会话只说一次（见 main.js agentRelay）
const BRIEF = [
  '[FanBox 叫人] 用户连了手机（微信或飞书）。你可以在终端里运行 fanbox-notify "要说的话" 给他发一条消息。',
  '你不用判断他在不在电脑前，FanBox 会判断：他在，就只在界面上提示一下；不在，才发到手机；夜里会攒到早上。',
  '这一轮收尾前，下面任何一条成立就发一条：这一轮里有命令或任务跑了几分钟以上，现在有结果了（成了或败了）；卡住了，要他做决定才能往下走；出了他必须马上知道的事（发布失败、数据可能丢）。',
  '不发：几秒钟就答完的问答；中间进度；你自己能定的事；刚发过的同一件事。',
  '写法：一两句话，先说结论，再说需要他回什么。不要贴日志和长路径。发完照常把完整的回答写在这里。',
].join('\n');

// 只连了飞书、没有微信那头的 agent 来判断时：机器生成的两类事件直接写成一句话发出去
function plainEvent(kind, p) {
  p = p || {};
  const who = `「${p.name || '终端'} ${p.id || ''}」`.replace(' 」', '」');
  if (kind === 'term_waiting') {
    const tail = String(p.tail || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' / ').slice(-200);
    return `${who}停下来等你 ${p.minutes} 分钟了（${p.state === 'needs_permission' ? '等你确认一个操作' : '等你输入'}）。${tail ? '它最后说：' + tail : ''}`.trim();
  }
  if (kind === 'resume_failed') return `${who}断线了，${p.action === 'give_up' ? '自动续跑试了 3 次没续上' : '这类故障不会自动续跑'}，要你回电脑前看一眼。`;
  return '';
}

// ---------- 飞书自定义机器人（群里加一个机器人拿到的 webhook 地址）----------
const FEISHU_RE = /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[\w-]{8,}$/;
const isFeishuUrl = (url) => FEISHU_RE.test(String(url || '').trim());
// 请求体。机器人开了「签名校验」时带 timestamp + sign（HMAC-SHA256，密钥是 `${timestamp}\n${secret}`，消息为空）
function feishuBody(text, secret, now) {
  const body = { msg_type: 'text', content: { text } };
  if (secret) {
    const ts = String(Math.floor(now / 1000));
    body.timestamp = ts;
    body.sign = crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
  }
  return body;
}
// 飞书的回包：成功是 { code: 0 }（旧版是 { StatusCode: 0 }）
const feishuOk = (json) => !!json && (json.code === 0 || json.StatusCode === 0);

module.exports = { clean, decide, label, plainEvent, BRIEF, isFeishuUrl, feishuBody, feishuOk, MAX_LEN, AT_DESK_S, DUP_MS, TERM_GAP_MS };
