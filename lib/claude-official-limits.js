'use strict';

const path = require('path');

const CLAUDE_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

function stripClaudeProviderEnv(env) {
  const out = { ...(env || {}) };
  for (const key of CLAUDE_PROVIDER_ENV_KEYS) delete out[key];
  return out;
}

function safeError(err) {
  const msg = String((err && err.message) || err || 'unknown');
  return msg.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]').slice(0, 240);
}

function execFileP(execFile, cmd, args, options, stdin) {
  return new Promise((resolve, reject) => {
    const cp = execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr ? `${err.message}: ${String(stderr).slice(0, 240)}` : err.message;
        reject(new Error(msg));
        return;
      }
      resolve(String(stdout || ''));
    });
    if (stdin != null && cp && cp.stdin) cp.stdin.end(stdin);
  });
}

function pickClaudeAccessToken(raw, now) {
  let o;
  try { o = JSON.parse(raw).claudeAiOauth; } catch { return null; }
  if (!o || !o.accessToken) return null;
  if (o.expiresAt && o.expiresAt <= now) return null;
  return o.accessToken;
}

function parseUsageBody(body) {
  let payload = String(body || '');
  let status = 0;
  const idx = payload.lastIndexOf('\n');
  const tail = idx >= 0 ? payload.slice(idx + 1).trim() : '';
  if (/^\d{3}$/.test(tail)) {
    status = Number(tail);
    payload = payload.slice(0, idx);
  }
  if (status >= 400) throw new Error(`usage_http_${status}`);
  const d = JSON.parse(payload);
  const win = (w) => (w && w.utilization != null)
    ? { usedPercent: w.utilization, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : 0 }
    : null;
  const fiveHour = win(d.five_hour), sevenDay = win(d.seven_day);
  return (fiveHour || sevenDay) ? { fiveHour, sevenDay } : null;
}

function normalizeCachedLimits(limits, nowMs) {
  if (!limits) return null;
  const normalize = (w) => {
    if (!w) return null;
    if (w.resetsAt && w.resetsAt * 1000 < nowMs) return { ...w, usedPercent: 0, resetsAt: 0 };
    return w;
  };
  return { fiveHour: normalize(limits.fiveHour), sevenDay: normalize(limits.sevenDay) };
}

function createClaudeOfficialLimitsClient(opts) {
  const home = opts.home;
  const platform = opts.platform || process.platform;
  const execFile = opts.execFile;
  const fsp = opts.fsp;
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const cacheFile = opts.cacheFile || path.join(opts.configDir || path.join(home, '.fanbox'), 'claude-official-limits-cache.json');
  const claudeBin = opts.claudeBin || path.join(home, '.local', 'bin', 'claude');
  let memoryCache = null;

  async function readCache() {
    try {
      const c = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      return c && c.limits ? c : null;
    } catch { return null; }
  }

  async function writeCache(limits) {
    if (!limits) return;
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true }).catch(() => {});
    await fsp.writeFile(cacheFile, JSON.stringify({ at: now(), limits }, null, 2));
  }

  async function readToken() {
    const pick = (raw) => pickClaudeAccessToken(raw, now());
    if (platform === 'darwin') {
      try {
        const out = await execFileP(execFile, 'security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 3000 });
        const t = pick(out);
        if (t) return t;
      } catch { /* fall back to credentials file */ }
    }
    try { return pick(await fsp.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8')); }
    catch { return null; }
  }

  async function curlSysProxyLine() {
    if (['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'].some((k) => env[k])) return '';
    if (platform !== 'darwin') return '';
    try {
      const out = await execFileP(execFile, 'scutil', ['--proxy'], { timeout: 3000 });
      const grab = (k) => (out.match(new RegExp(`\\b${k} : (\\S+)`)) || [])[1];
      if (grab('HTTPSEnable') === '1') return `proxy = "http://${grab('HTTPSProxy')}:${grab('HTTPSPort')}"\n`;
      if (grab('HTTPEnable') === '1') return `proxy = "http://${grab('HTTPProxy')}:${grab('HTTPPort')}"\n`;
      if (grab('SOCKSEnable') === '1') return `proxy = "socks5h://${grab('SOCKSProxy')}:${grab('SOCKSPort')}"\n`;
    } catch { /* direct connection fallback */ }
    return '';
  }

  async function refreshClaudeAuthStatus() {
    const childEnv = stripClaudeProviderEnv(env);
    await execFileP(execFile, claudeBin, ['auth', 'status'], { timeout: 20000, env: childEnv });
  }

  async function fetchLive() {
    const token = await readToken();
    if (!token) throw new Error('claude_oauth_token_missing');
    const proxyLine = await curlSysProxyLine();
    const body = await execFileP(
      execFile,
      'curl',
      ['-sS', '--max-time', '8', '-K', '-', '-w', '\n%{http_code}', 'https://api.anthropic.com/api/oauth/usage'],
      { timeout: 10000 },
      `${proxyLine}header = "Authorization: Bearer ${token}"\nheader = "anthropic-beta: oauth-2025-04-20"\n`,
    );
    const limits = parseUsageBody(body);
    if (!limits) throw new Error('claude_usage_payload_empty');
    await writeCache(limits);
    return { limits, meta: { source: 'live', stale: false, at: now() } };
  }

  async function fetch(options) {
    const force = !!(options && options.force);
    if (!force && memoryCache && now() - memoryCache.meta.at < 30000) return memoryCache;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await fetchLive();
        memoryCache = result;
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          try { await refreshClaudeAuthStatus(); }
          catch (refreshErr) { lastErr = refreshErr; }
          continue;
        }
      }
    }
    const cached = await readCache();
    if (cached && cached.limits) {
      const limits = normalizeCachedLimits(cached.limits, now());
      memoryCache = {
        limits,
        meta: { source: 'cache', stale: true, at: cached.at || 0, error: safeError(lastErr) },
      };
      return memoryCache;
    }
    memoryCache = { limits: null, meta: { source: 'none', stale: true, at: now(), error: safeError(lastErr) } };
    return memoryCache;
  }

  return { fetch, refreshClaudeAuthStatus, readToken };
}

module.exports = {
  CLAUDE_PROVIDER_ENV_KEYS,
  createClaudeOfficialLimitsClient,
  normalizeCachedLimits,
  parseUsageBody,
  pickClaudeAccessToken,
  stripClaudeProviderEnv,
};
