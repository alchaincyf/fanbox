'use strict';
// 回归：旧登录失效后重新扫码，必须重新开始收消息。
// 2.20.0 的现象：启动时带着过期 token 轮询，被拒后循环退出但「在跑」标记没清，重新扫码后 startPolling 直接返回——能发不能收
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-wx-relogin-'));
process.env.HOME = home;
const ilink = require('../electron/wechat/ilink');
const driver = require('../electron/wechat/driver');
const bridge = require('../electron/wechat/bridge');

const polled = [];
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return fn(); };
driver.warmEnv = () => {};
ilink.getUpdates = async (account, buf, timeout, signal) => {
  polled.push(account.token);
  if (account.token === 'old') return { ret: -14 };
  await new Promise((r) => { const t = setTimeout(r, 50); signal.addEventListener('abort', () => { clearTimeout(t); r(); }); });
  return { ret: 0, msgs: [], get_updates_buf: 'b1' };
};
ilink.fetchQrcode = async () => ({ qrcode: 'q' });
ilink.pollQrStatus = async () => ({ status: 'confirmed', bot_token: 'new', baseurl: 'http://127.0.0.1:9', ilink_bot_id: 'bot' });

test('过期 token 被拒后轮询退出，重新扫码后用新 token 接着收', async () => {
  const dir = path.join(home, '.fanbox', 'wechat');
  fs.mkdirSync(dir, { recursive: true });
  bridge.init({ isDestroyed: () => false, webContents: { send() {} } });
  clearInterval(bridge.aoTimer);
  bridge.account = { token: 'old', baseUrl: 'http://127.0.0.1:9', accountId: 'bot' };
  bridge.startPolling();
  assert.ok(await until(() => bridge.expired), '旧 token 被判失效');
  assert.ok(await until(() => !bridge.pollAbort), '循环退出后「在跑」标记要放开');
  const r = await bridge.login();
  assert.equal(r.ok, true);
  assert.ok(await until(() => polled.includes('new')), '重新扫码后必须用新 token 开始收消息');
  bridge.disconnect();
});
