'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CLAUDE_CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const DEFAULT_CODEX_AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

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

function codexProvider(configPath = DEFAULT_CODEX_CONFIG) {
  const root = {};
  const profiles = {};
  const providers = {};
  let target = root;

  try {
    // ponytail: parse only the simple string keys Codex uses here; add a TOML parser if multiline values become relevant.
    for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
      if (section) {
        target = section[1].startsWith('profiles.')
          ? (profiles[section[1].slice(9)] ||= {})
          : section[1].startsWith('model_providers.')
            ? (providers[section[1].slice(16)] ||= {})
            : null;
        continue;
      }
      if (!target) continue;
      const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)')/);
      if (!pair || !['profile', 'model_provider', 'name', 'base_url'].includes(pair[1])) continue;
      let value = pair[2] === undefined ? pair[3] : pair[2];
      if (pair[2] !== undefined) {
        try { value = JSON.parse(`"${pair[2]}"`); } catch {}
      }
      target[pair[1]] = value;
    }
  } catch {}

  const selected = profiles[root.profile]?.model_provider || root.model_provider || '';
  const provider = providers[selected] || {};
  const baseUrl = text(provider.base_url, 2048);
  let label = text(provider.name) || text(selected) || 'api.openai.com';
  if (baseUrl) {
    try { label = new URL(baseUrl).host || label; } catch {}
  }
  return { id: selected, baseUrl, label };
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

function detectCodexIdentity(filePath = DEFAULT_CODEX_AUTH, configPath = DEFAULT_CODEX_CONFIG) {
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
    if (account) return { ...account, label: `Codex ${codexProvider(configPath).label}`, authMode };
    return subscription ? { ...subscription, authMode: authMode || 'chatgpt' } : null;
  } catch {
    return null;
  }
}

function detectIdentities(options = {}) {
  return {
    claude: detectClaudeIdentity(options.claudeCredentialsPath),
    codex: detectCodexIdentity(options.codexAuthPath, options.codexConfigPath),
  };
}

module.exports = {
  detectClaudeIdentity,
  detectCodexIdentity,
  detectIdentities,
  DEFAULT_CLAUDE_CREDENTIALS,
  DEFAULT_CODEX_AUTH,
};
