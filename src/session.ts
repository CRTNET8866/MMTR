/* ============================================================================
 * 会话 (session.ts)
 *
 * 一次「醒来 → 聊 → 睡去」就是一个会话。
 * 会话结束时结算关系通道，并把整段对话交给 LLM 做一次整体情绪判断
 * —— 逐句判断情绪是不可靠的，整体判断稳得多，也更省 token。
 * ==========================================================================*/

import type { Db } from './db.ts';
import type { Affect, RelationDims, SessionRecord } from './types.ts';
import { newId, safeJsonParse, truncate } from './util.ts';

export function rowToSession(row: Record<string, unknown>): SessionRecord {
  const optNum = (v: unknown): number | null => (v == null ? null : Number(v));
  const valence = optNum(row.affect_valence);
  const affect: Affect | null =
    valence === null
      ? null
      : { valence, arousal: Number(row.affect_arousal ?? 0), label: String(row.affect_label ?? '') };
  return {
    id: String(row.id),
    startedAt: Number(row.started_at),
    endedAt: optNum(row.ended_at),
    turnCount: Number(row.turn_count ?? 0),
    affect,
    relationBefore: row.relation_before ? safeJsonParse<RelationDims | null>(String(row.relation_before), null) : null,
    relationAfter: row.relation_after ? safeJsonParse<RelationDims | null>(String(row.relation_after), null) : null,
    summaryMemoryId: row.summary_memory_id == null ? null : String(row.summary_memory_id),
    openThread: row.open_thread == null ? null : String(row.open_thread),
  };
}

export function getSession(db: Db, id: string): SessionRecord | null {
  const row = db.get('SELECT * FROM sessions WHERE id = ?', [id]);
  return row ? rowToSession(row) : null;
}

export function getOpenSession(db: Db): SessionRecord | null {
  const row = db.get('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1');
  return row ? rowToSession(row) : null;
}

export function openSession(db: Db, now: number): SessionRecord {
  const session: SessionRecord = {
    id: newId('s'),
    startedAt: now,
    endedAt: null,
    turnCount: 0,
    affect: null,
    relationBefore: null,
    relationAfter: null,
    summaryMemoryId: null,
    openThread: null,
  };
  db.run(
    'INSERT INTO sessions(id, started_at, ended_at, turn_count, relation_before, last_turn_at) VALUES(?, ?, NULL, 0, NULL, ?)',
    [session.id, now, now],
  );
  return session;
}

export function saveSession(db: Db, session: SessionRecord, lastTurnAtOverride?: number): void {
  db.run(
    'UPDATE sessions SET ended_at = ?, turn_count = ?, affect_valence = ?, affect_arousal = ?, affect_label = ?, ' +
      'relation_before = ?, relation_after = ?, summary_memory_id = ?, open_thread = ?, last_turn_at = ? WHERE id = ?',
    [
      session.endedAt,
      session.turnCount,
      session.affect ? session.affect.valence : null,
      session.affect ? session.affect.arousal : null,
      session.affect ? session.affect.label : null,
      session.relationBefore ? JSON.stringify(session.relationBefore) : null,
      session.relationAfter ? JSON.stringify(session.relationAfter) : null,
      session.summaryMemoryId,
      session.openThread,
      session.endedAt ?? lastTurnAtOverride ?? session.startedAt,
      session.id,
    ],
  );
}

export interface SessionTurn {
  turn: number;
  at: number;
  userText: string;
  assistantText: string;
  memoryIds: string[];
}

export function appendTurn(
  db: Db,
  input: { sessionId: string; turn: number; at: number; userText: string; assistantText: string; memoryIds: string[] },
): void {
  db.run(
    'INSERT INTO session_turns(session_id, turn, at, user_text, assistant_text, memory_ids) VALUES(?, ?, ?, ?, ?, ?)',
    [input.sessionId, input.turn, input.at, input.userText, input.assistantText, JSON.stringify(input.memoryIds)],
  );
  db.run('UPDATE sessions SET last_turn_at = ?, turn_count = MAX(turn_count, ?) WHERE id = ?', [
    input.at,
    input.turn + 1,
    input.sessionId,
  ]);
}

export function getTurns(db: Db, sessionId: string): SessionTurn[] {
  const rows = db.all('SELECT * FROM session_turns WHERE session_id = ? ORDER BY turn ASC', [sessionId]);
  return rows.map((row) => ({
    turn: Number(row.turn),
    at: Number(row.at),
    userText: String(row.user_text ?? ''),
    assistantText: String(row.assistant_text ?? ''),
    memoryIds: safeJsonParse<string[]>(String(row.memory_ids ?? '[]'), []),
  }));
}

export function buildTranscript(
  turns: SessionTurn[],
  personaName: string,
  userName: string,
  maxChars = 6000,
): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.userText) lines.push(userName + '：' + t.userText);
    if (t.assistantText) lines.push(personaName + '：' + t.assistantText);
  }
  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  // 超长时保留头尾，中间省略
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.35));
  return head + '\n…（中间省略）…\n' + tail;
}

export function lastTurnAt(db: Db, sessionId: string): number | null {
  const row = db.get('SELECT last_turn_at FROM sessions WHERE id = ?', [sessionId]);
  return row && row.last_turn_at != null ? Number(row.last_turn_at) : null;
}

export function sessionOpenThread(db: Db): string | null {
  const row = db.get(
    'SELECT open_thread FROM sessions WHERE ended_at IS NOT NULL AND open_thread IS NOT NULL AND open_thread != "" ORDER BY ended_at DESC LIMIT 1',
  );
  return row ? truncate(String(row.open_thread), 80) : null;
}