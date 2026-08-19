'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CLAUDE_CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const DEFAULT_CODEX_AUTH = path.join(os.homedir(), '.codex', 'auth.json');

function identity(provider, source, value, detail = '') {
  if (typeof value !== 'string' || !value) return null;
  const hash = crypto.createHash('sha256').update(`${provider}\0${source}\0${value}`).digest('hex');
  return {
    id: `${provider}:${hash}`,
    provider,
    source,
    label: `${provider === 'claude' ? 'Claude' : 'Codex'}${detail ? ` ${detail}` : ''} #${hash.slice(0, 6)}`,
  };
}

function jwtPayload(token) {
  try {
    const parts = typeof token === 'string' ? token.split('.') : [];
    return parts.length === 3 ? JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

function text(value, limit = 254) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function detectClaudeIdentity(filePath = DEFAULT_CLAUDE_CREDENTIALS) {
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const oauth = saved.claudeAiOauth || {};
    const detail = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType.trim().slice(0, 24) : '';
    return typeof saved.organizationUuid === 'string' && saved.organizationUuid
      ? identity('claude', 'organization', saved.organizationUuid, detail)
      : identity('claude', 'credential', oauth.refreshToken, detail);
  } catch {
    return null;
  }
}

function detectCodexIdentity(filePath = DEFAULT_CODEX_AUTH) {
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const authMode = text(saved.auth_mode, 24);
    const apiMode = authMode === 'api' || authMode === 'apikey';
    const tokens = saved.tokens && typeof saved.tokens === 'object' ? saved.tokens : {};
    const idClaims = jwtPayload(tokens.id_token);
    const accessClaims = jwtPayload(tokens.access_token);
    const authClaims = accessClaims['https://api.openai.com/auth'] || idClaims['https://api.openai.com/auth'] || {};
    const profileClaims = accessClaims['https://api.openai.com/profile'] || {};
    const accountId = text(tokens.account_id || authClaims.chatgpt_account_id || authClaims.account_id || idClaims.sub);
    const subscription = identity('codex', 'account', accountId);

    if (!apiMode && subscription) {
      const email = text(idClaims.email || profileClaims.email);
      const plan = text(authClaims.chatgpt_plan_type || authClaims.plan_type, 24);
      const planLabel = plan ? `${plan[0].toUpperCase()}${plan.slice(1)}` : 'ChatGPT';
      return {
        ...subscription,
        label: `Codex ${planLabel}${email ? ` ${email}` : ` #${subscription.id.slice(-6)}`}`,
        authMode: authMode || 'chatgpt',
      };
    }

    const account = identity('codex', 'credential', saved.OPENAI_API_KEY, authMode);
    if (account) return { ...account, authMode };
    return subscription ? { ...subscription, authMode: authMode || 'chatgpt' } : null;
  } catch {
    return null;
  }
}

function detectIdentities(options = {}) {
  return {
    claude: detectClaudeIdentity(options.claudeCredentialsPath),
    codex: detectCodexIdentity(options.codexAuthPath),
  };
}

module.exports = {
  detectClaudeIdentity,
  detectCodexIdentity,
  detectIdentities,
  DEFAULT_CLAUDE_CREDENTIALS,
  DEFAULT_CODEX_AUTH,
};
