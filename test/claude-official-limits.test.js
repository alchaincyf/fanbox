const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CLAUDE_PROVIDER_ENV_KEYS,
  createClaudeOfficialLimitsClient,
  normalizeCachedLimits,
  stripClaudeProviderEnv,
} = require('../lib/claude-official-limits');

test('stripClaudeProviderEnv removes provider routing without mutating the original env', () => {
  const original = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'deepseek-key',
    ANTHROPIC_AUTH_TOKEN: 'deepseek-token',
    ANTHROPIC_BASE_URL: 'https://deepseek.example',
    ANTHROPIC_MODEL: 'deepseek-model',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-small',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    KEEP_ME: 'yes',
  };

  const stripped = stripClaudeProviderEnv(original);

  for (const key of CLAUDE_PROVIDER_ENV_KEYS) assert.equal(stripped[key], undefined);
  assert.equal(stripped.PATH, '/usr/bin');
  assert.equal(stripped.KEEP_ME, 'yes');
  assert.equal(original.ANTHROPIC_BASE_URL, 'https://deepseek.example');
});

test('limits returns stale cache when live usage fails after isolated refresh', async () => {
  const calls = [];
  const files = new Map([
    ['/home/user/.fanbox/claude-official-limits-cache.json', JSON.stringify({
      at: 1783000000000,
      limits: {
        fiveHour: { usedPercent: 33, resetsAt: 1783001000 },
        sevenDay: { usedPercent: 44, resetsAt: 1783600000 },
      },
    })],
  ]);
  const fakeFsp = {
    readFile: async (file) => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFile: async (file, value) => { files.set(file, value); },
    mkdir: async () => {},
  };
  const fakeExecFile = (cmd, args, options, cb) => {
    calls.push({ cmd, args, env: options.env });
    if (cmd.endsWith('/claude')) return cb(null, '{"loggedIn":true,"authMethod":"claude.ai"}');
    if (cmd === 'security') return cb(new Error('no keychain'), '');
    if (cmd === 'curl') return cb(new Error('network down'), '');
    return cb(new Error('unexpected command'), '');
  };

  const client = createClaudeOfficialLimitsClient({
    home: '/home/user',
    platform: 'darwin',
    execFile: fakeExecFile,
    fsp: fakeFsp,
    env: {
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://deepseek.example',
      ANTHROPIC_AUTH_TOKEN: 'token',
    },
    now: () => 1783000100000,
  });

  const result = await client.fetch({ force: true });

  assert.equal(result.limits.fiveHour.usedPercent, 33);
  assert.equal(result.meta.source, 'cache');
  assert.equal(result.meta.stale, true);
  const refresh = calls.find((c) => c.cmd.endsWith('/claude'));
  assert.ok(refresh);
  assert.deepEqual(refresh.args.slice(0, 6), ['-p', '--no-session-persistence', '--safe-mode', '--tools', '', '--model']);
  assert.equal(refresh.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(refresh.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('expired oauth token is refreshed with a minimal official Claude request before fetching usage', async () => {
  const calls = [];
  let securityReads = 0;
  const expiredCredential = {
    claudeAiOauth: {
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      expiresAt: 1783000000000,
    },
  };
  const refreshedCredential = {
    claudeAiOauth: {
      accessToken: 'fresh-access',
      refreshToken: 'refresh-token',
      expiresAt: 1783007200000,
    },
  };
  const fakeFsp = {
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFile: async () => {},
    mkdir: async () => {},
  };
  const fakeExecFile = (cmd, args, options, cb) => {
    calls.push({ cmd, args, env: options.env });
    if (cmd === 'security') {
      securityReads++;
      return cb(null, JSON.stringify(securityReads === 1 ? expiredCredential : refreshedCredential));
    }
    if (cmd.endsWith('/claude')) {
      return cb(null, JSON.stringify({ type: 'result', result: 'OK' }));
    }
    if (cmd === 'curl') {
      assert.match(args.join(' '), /api\/oauth\/usage/);
      return cb(null, JSON.stringify({
        five_hour: { utilization: 12, resets_at: '2026-07-09T18:00:00.000Z' },
        seven_day: { utilization: 34, resets_at: '2026-07-12T18:00:00.000Z' },
      }) + '\n200');
    }
    return cb(new Error(`unexpected command ${cmd}`), '');
  };

  const client = createClaudeOfficialLimitsClient({
    home: '/home/user',
    platform: 'darwin',
    execFile: fakeExecFile,
    fsp: fakeFsp,
    env: {
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://deepseek.example',
      ANTHROPIC_AUTH_TOKEN: 'token',
    },
    now: () => 1783000100000,
  });

  const result = await client.fetch({ force: true });

  assert.equal(result.meta.source, 'live');
  assert.equal(result.limits.fiveHour.usedPercent, 12);
  const refresh = calls.find((c) => c.cmd.endsWith('/claude'));
  assert.ok(refresh);
  assert.deepEqual(refresh.args.slice(0, 6), ['-p', '--no-session-persistence', '--safe-mode', '--tools', '', '--model']);
  assert.equal(refresh.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(refresh.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('normalizeCachedLimits zeroes windows that already reset', () => {
  const limits = normalizeCachedLimits({
    fiveHour: { usedPercent: 80, resetsAt: 100 },
    sevenDay: { usedPercent: 45, resetsAt: 300 },
  }, 200000);

  assert.equal(limits.fiveHour.usedPercent, 0);
  assert.equal(limits.fiveHour.resetsAt, 0);
  assert.equal(limits.sevenDay.usedPercent, 45);
  assert.equal(limits.sevenDay.resetsAt, 300);
});
