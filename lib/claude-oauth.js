'use strict';
const crypto = require('crypto');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const FALLBACK_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

const base64Url = (value) =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createAuthorization() {
  const verifier = base64Url(crypto.randomBytes(32));
  const state = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url: url.toString(), verifier, state };
}

function parseAuthorizationCode(value, expectedState) {
  const text = String(value || '').trim();
  if (!text) throw new Error('请粘贴完整的 Claude 授权码');
  let code = text;
  let state = null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const callback = new URL(text);
      code = callback.searchParams.get('code');
      state = callback.searchParams.get('state');
    } catch {
      throw new Error('Claude 授权码无效或不完整');
    }
  } else if (text.includes('#')) {
    [code, state] = text.split('#', 2);
  }
  if (!code || (state && state !== expectedState)) throw new Error('Claude 授权码无效或不完整');
  return code;
}

function httpError(status, payload, response) {
  const detail = payload && (payload.error_description || payload.message || (payload.error && payload.error.message));
  const error = new Error(typeof detail === 'string' ? detail : `Claude HTTP ${status}`);
  error.status = status;
  const retryAfter = response && response.headers && response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    error.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }
  return error;
}

async function readJson(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw httpError(response.status, null, response);
    throw new Error('Claude 返回了无法解析的数据');
  }
  if (!response.ok) throw httpError(response.status, payload, response);
  return payload;
}

async function tokenRequest(body, fetchImpl = fetch) {
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ai-code-usage-tray' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  };
  let response = await fetchImpl(TOKEN_URL, options);
  if (response.status === 429) response = await fetchImpl(FALLBACK_TOKEN_URL, options);
  const payload = await readJson(response);
  if (typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') {
    throw new Error('Claude 登录凭证不完整');
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 28_800) * 1000,
  };
}

function exchangeAuthorizationCode(code, verifier, state, fetchImpl) {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
    },
    fetchImpl,
  );
}

function refreshAccessToken(refreshToken, fetchImpl) {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
    fetchImpl,
  );
}

function parseReset(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function parseWindow(window) {
  if (!window) return null;
  const used = Number.isFinite(window.utilization) ? window.utilization : window.used_percent;
  if (!Number.isFinite(used)) return null;
  return {
    usedPercentage: Math.min(100, Math.max(0, used)),
    resetsAt: parseReset(window.resets_at),
  };
}

function parseUsage(payload, updatedAt = Date.now()) {
  if (payload && payload.error && payload.error.type === 'rate_limit_error') throw httpError(429);
  const fiveHour = parseWindow(payload && payload.five_hour);
  const sevenDay = parseWindow(payload && payload.seven_day);
  if (!fiveHour && !sevenDay) throw new Error('Claude 额度数据不完整');
  return { fiveHour, sevenDay, updatedAt, source: 'oauth', stale: false };
}

async function fetchUsage(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      'User-Agent': 'claude-code/2.1.121',
    },
    signal: AbortSignal.timeout(15_000),
  });
  return parseUsage(await readJson(response));
}

module.exports = {
  createAuthorization,
  parseAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchUsage,
  parseUsage,
  REDIRECT_URI,
};
