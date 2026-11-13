'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, decide } = require('../lib/auto-resume');
const CHROME = '\n─────────────────────────────\n❯ \n─────────────────────────────\n  周 13%  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';
const kind = (s) => classify(s + CHROME).kind;

test('瞬时故障：断线、休眠、超时、解析不到、证书', () => {
  assert.equal(kind('正在把部署脚本换成rclone：按文件内容的校验和比对。\n  ⎿ API Error: Connection dropped (ECONNRESET)'), 'transient');
  assert.equal(kind('⏺ 上传中\n  ⎿ API Error: Your computer went to sleep mid-response. The response above may be incomplete.'), 'transient');
  assert.equal(kind('  ⎿ API Error: No response from API (waited 3m, then 10m on the retry). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS'), 'transient');
  assert.equal(kind("  ⎿ API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"), 'transient');
  assert.equal(kind('  ⎿ API Error: Unable to connect to API: SSL certificate hostname mismatch'), 'transient');
  assert.equal(kind('  ⎿ API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), 'transient');
});

test('要人处理的：额度用完、要重新登录', () => {
  assert.equal(kind("  ⎿ You've hit your weekly limit · resets 7pm (Asia/Shanghai)"), 'needs_human');
  assert.equal(kind('  ⎿ Please run /login · API Error: 403 Request not allowed'), 'needs_human');
  assert.equal(kind('  ⎿ OAuth token revoked · Please run /login'), 'needs_human');
});

test('不该动的：已经续上、正常收尾、正文里只是提到这个词、空屏、认不出的报错', () => {
  assert.equal(kind('  ⎿ API Error: Connection dropped (ECONNRESET)\n❯ 继续\n⏺ 好的，接着上传。四个资源包已经按最新素材库上传完成，构建29正在处理，预计十分钟后可以在TestFlight里看到。'), 'ok');
  assert.equal(kind('⏺ 两件事都改好了，索引断链检查是0。\n✻ Sautéed for 1m 34s · done 18:55\n※ recap: 为那篇文章，我们在整理你的记忆库。'), 'ok');
  assert.equal(kind('⏺ 我查了日志，上周共出现 28 次 API Error，其中连接类最多；接下来我把重试逻辑写进脚本，并补上测试，写完后会在这里给出改动清单和验证结果，请稍等几分钟。'), 'ok');
  assert.equal(classify('').kind, 'empty');
  assert.equal(kind('  ⎿ API Error: 400 {"type":"invalid_request_error"}'), 'unknown_error');
});

test('输入框里有你打了一半的字：不动（否则会连同那半句一起提交）', () => {
  assert.equal(classify('  ⎿ API Error: Connection dropped (ECONNRESET)\n─────────────\n❯ 先别继续，我想改\n─────────────\n').kind, 'ok');
});

test('退避 1、5、15 分钟，一小时最多 3 次，之后交给人且只说一次', () => {
  const M = 60000, e = {}, ev = 'API Error: Connection dropped (ECONNRESET)';
  assert.equal(decide(e, 'transient', ev, 0), null);
  assert.equal(decide(e, 'transient', ev, 59000), null);
  assert.deepEqual(decide(e, 'transient', ev, 1 * M), { action: 'send', attempt: 1 });
  assert.equal(decide(e, 'transient', ev, 5 * M), null);
  assert.deepEqual(decide(e, 'transient', ev, 6 * M), { action: 'send', attempt: 2 });
  assert.equal(decide(e, 'transient', ev, 20 * M), null);
  assert.deepEqual(decide(e, 'transient', ev, 21 * M), { action: 'send', attempt: 3 });
  assert.deepEqual(decide(e, 'transient', ev, 40 * M), { action: 'give_up' });
  assert.equal(decide(e, 'transient', ev, 41 * M), null);
  assert.equal(decide(e, 'transient', ev, 90 * M), null); // 早先几次滑出一小时窗口也不再重试
});

test('要人处理的只提醒一次；换了一次新故障重新计时', () => {
  const e = {};
  assert.deepEqual(decide(e, 'needs_human', 'limit', 0), { action: 'report' });
  assert.equal(decide(e, 'needs_human', 'limit', 60000), null);
  assert.equal(decide(e, 'transient', 'API Error: ETIMEDOUT', 61000), null);
  assert.deepEqual(decide(e, 'transient', 'API Error: ETIMEDOUT', 121000), { action: 'send', attempt: 1 });
});
