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
    const detail = typeof saved.auth_mode === 'string' ? saved.auth_mode.trim().slice(0, 24) : '';
    return identity('codex', 'credential', saved.OPENAI_API_KEY, detail);
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
