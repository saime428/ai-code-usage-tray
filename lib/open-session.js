'use strict';

const SAFE_ID = /^[a-zA-Z0-9._-]{1,200}$/;
const SAFE_BRIDGE_ID = /^(?:session_|cse_)[a-zA-Z0-9._-]{1,200}$/;

function sessionTarget(session) {
  if (!session || session.client !== 'Desktop') throw new Error('只能打开 Desktop 会话');
  if (session.provider === 'codex') {
    if (!SAFE_ID.test(session.sessionId || '')) throw new Error('Codex 会话 ID 无效');
    return { uri: `codex://threads/${encodeURIComponent(session.sessionId)}`, exact: true };
  }
  if (session.provider !== 'claude') throw new Error('未知会话来源');
  if (SAFE_BRIDGE_ID.test(session.bridgeSessionId || '')) {
    return {
      uri: `claude://claude.ai/code/${encodeURIComponent(session.bridgeSessionId)}`,
      exact: true,
    };
  }
  const title = String(session.title || session.project || '').trim().slice(0, 500);
  if (!title) throw new Error('Claude 会话标题不可用');
  return { uri: 'claude://', exact: false, copyText: title };
}

module.exports = { sessionTarget };
