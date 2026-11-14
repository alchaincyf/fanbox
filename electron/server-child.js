'use strict';
/**
 * FanBox — 后端子进程入口（utilityProcess.fork 的目标，不是给人直接跑的）
 *
 * server.js 从前 require 进主进程，文件扫描/缩略图和 node-pty 抢同一个事件循环，
 * 主进程一忙终端就卡。现在它跑在这里；唯一还留在主进程的能力是 agent 控制
 * （pty 全活在那边），用 parentPort RPC 代理回去：global.__fanboxAgent 的每个
 * 方法调用发一条 {type:'agent:call'} 消息，主进程真执行后按 id 回包。
 * 代价是 read/send/kill 从同步变成了 Promise——server.js 的调用点都补了 await
 * （await 一个普通对象是 no-op，所以裸跑 node server.js 不受影响）。
 */
const pending = new Map(); // id -> resolve
let seq = 0;
const port = process.parentPort;
port.on('message', (e) => {
  const m = (e && e.data) || {};
  if (m.type !== 'agent:reply') return;
  const resolve = pending.get(m.id);
  if (resolve) { pending.delete(m.id); resolve(m.result); }
});
const call = (method) => (...args) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  port.postMessage({ type: 'agent:call', id, method, args });
});
global.__fanboxAgent = {
  token: process.env.FANBOX_AGENT_TOKEN, // 主进程生成后经 fork env 注入，不落盘
  list: call('list'), read: call('read'), send: call('send'),
  create: call('create'), wait: call('wait'), kill: call('kill'),
  relay: call('relay'), // 窗口互通（/api/agent/relay）
  notify: call('notify'), // 叫人（/api/agent/notify）
  event: call('event'), // agent 官方 hook 事件（/api/agent/event）→ 主进程事实表
};
require('../server.js');
