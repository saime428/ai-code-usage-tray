'use strict';

const SAFE_ID = /^[a-zA-Z0-9._-]{1,200}$/;
const SAFE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function sessionTarget(session) {
  if (!session || session.client !== 'Desktop') throw new Error('只能打开 Desktop 会话');
  if (session.provider === 'codex') {
    if (!SAFE_ID.test(session.sessionId || '')) throw new Error('Codex 会话 ID 无效');
    return { uri: `codex://threads/${encodeURIComponent(session.sessionId)}`, exact: true };
  }
  if (session.provider !== 'claude') throw new Error('未知会话来源');
  if (!SAFE_UUID.test(session.sessionId || '')) throw new Error('Claude 会话 ID 无效');
  return { uri: `claude://resume?session=${encodeURIComponent(session.sessionId)}`, exact: true };
}

module.exports = { sessionTarget };
