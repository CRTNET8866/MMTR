/* ============================================================================
 * 存储层 (db.ts)
 *
 * 只用 Node 内置的 node:sqlite —— 零原生依赖，无需 npm install。
 * ==========================================================================*/

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Affect,
  CalendarAnchor,
  ChannelState,
  ImportanceLogEntry,
  MemoryLevel,
  MemoryRecord,
  Owner,
  PromiseState,
  RelationDelta,
  TimePrecision,
  MemorySource,
} from './types.ts';
import { safeJsonParse } from './util.ts';

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  event_at INTEGER,
  event_precision TEXT NOT NULL DEFAULT 'unknown',
  level INTEGER NOT NULL DEFAULT 0,
  floor_level INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  fact TEXT NOT NULL DEFAULT '',
  gist TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  raw TEXT,
  raw_retained INTEGER NOT NULL DEFAULT 0,
  s_fact REAL NOT NULL DEFAULT 0,
  t_fact INTEGER NOT NULL DEFAULT 0,
  s_gist REAL NOT NULL DEFAULT 0,
  t_gist INTEGER NOT NULL DEFAULT 0,
  s_affect REAL NOT NULL DEFAULT 0,
  t_affect INTEGER NOT NULL DEFAULT 0,
  affect_valence REAL,
  affect_arousal REAL,
  affect_label TEXT,
  relation_delta TEXT,
  importance REAL NOT NULL DEFAULT 0,
  importance_updated_at INTEGER NOT NULL DEFAULT 0,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER,
  fire_count_24h INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'new_experience',
  read_only INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER NOT NULL DEFAULT 0,
  valid_to INTEGER,
  invalidated_by TEXT,
  calendar_anchor TEXT,
  due_at INTEGER,
  promise_state TEXT NOT NULL DEFAULT 'none',
  tags TEXT NOT NULL DEFAULT '[]',
  entities TEXT NOT NULL DEFAULT '[]',
  theme_key TEXT,
  embedding_model TEXT,
  compression_count INTEGER NOT NULL DEFAULT 0,
  importance_log TEXT NOT NULL DEFAULT '[]',
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_mem_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_mem_theme ON memories(theme_key);
CREATE INDEX IF NOT EXISTS idx_mem_level ON memories(level);
CREATE INDEX IF NOT EXISTS idx_mem_valid ON memories(valid_to);
CREATE INDEX IF NOT EXISTS idx_mem_fired ON memories(last_fired_at);

CREATE TABLE IF NOT EXISTS embeddings (
  memory_id TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  w0 REAL NOT NULL,
  t0 INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edge_from ON edges(from_id, type);
CREATE INDEX IF NOT EXISTS idx_edge_to ON edges(to_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_unique ON edges(from_id, to_id, type);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  turn_count INTEGER NOT NULL DEFAULT 0,
  affect_valence REAL,
  affect_arousal REAL,
  affect_label TEXT,
  relation_before TEXT,
  relation_after TEXT,
  summary_memory_id TEXT,
  open_thread TEXT,
  last_turn_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relation_state (
  id TEXT PRIMARY KEY,
  dims TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS relation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  memory_id TEXT
);

CREATE TABLE IF NOT EXISTS core_memory (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  mutable INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  session_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recall'
);

CREATE INDEX IF NOT EXISTS idx_act_session ON activations(session_id, turn);
CREATE INDEX IF NOT EXISTS idx_act_memory ON activations(memory_id, at);

CREATE TABLE IF NOT EXISTS session_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  at INTEGER NOT NULL,
  user_text TEXT NOT NULL DEFAULT '',
  assistant_text TEXT NOT NULL DEFAULT '',
  memory_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_turn_session ON session_turns(session_id, turn);
`;

export type SqlParam = string | number | null | Uint8Array;

export class Db {
  readonly handle: DatabaseSync;
  readonly path: string;
  private closed = false;

  constructor(filePath: string) {
    this.path = filePath;
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.handle = new DatabaseSync(filePath);
    this.handle.exec(SCHEMA_SQL);
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  all(sql: string, params: SqlParam[] = []): Record<string, unknown>[] {
    const stmt = this.handle.prepare(sql);
    return stmt.all(...params) as Record<string, unknown>[];
  }

  get(sql: string, params: SqlParam[] = []): Record<string, unknown> | undefined {
    const stmt = this.handle.prepare(sql);
    const row = stmt.get(...params);
    return row as Record<string, unknown> | undefined;
  }

  run(sql: string, params: SqlParam[] = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.handle.prepare(sql);
    const res = stmt.run(...params);
    return {
      changes: Number(res.changes || 0),
      lastInsertRowid: Number(res.lastInsertRowid || 0),
    };
  }

  tx<T>(fn: () => T): T {
    this.handle.exec('BEGIN');
    try {
      const out = fn();
      this.handle.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    this.handle.close();
  }

  /* ---------- meta ---------- */

  getMeta(key: string): string | null {
    const row = this.get('SELECT v FROM meta WHERE k = ?', [key]);
    return row ? String(row.v) : null;
  }

  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      [key, value],
    );
  }
}

/* ---------- 行 <-> 记录 ---------- */

export function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : v == null ? d : Number(v));
  const str = (v: unknown, d = ''): string => (v == null ? d : String(v));
  const optNum = (v: unknown): number | null => (v == null ? null : Number(v));

  const channels: Record<'fact' | 'gist' | 'affect', ChannelState> = {
    fact: { strength: num(row.s_fact), updatedAt: num(row.t_fact) },
    gist: { strength: num(row.s_gist), updatedAt: num(row.t_gist) },
    affect: { strength: num(row.s_affect), updatedAt: num(row.t_affect) },
  };

  const affectValence = optNum(row.affect_valence);
  const affect: Affect | null =
    affectValence === null
      ? null
      : {
          valence: affectValence,
          arousal: num(row.affect_arousal),
          label: str(row.affect_label),
        };

  const anchorRaw = row.calendar_anchor ? safeJsonParse<CalendarAnchor | null>(String(row.calendar_anchor), null) : null;
  const relationDelta = row.relation_delta
    ? safeJsonParse<RelationDelta | null>(String(row.relation_delta), null)
    : null;
  const importanceLog = row.importance_log
    ? safeJsonParse<ImportanceLogEntry[]>(String(row.importance_log), [])
    : [];

  return {
    id: str(row.id),
    owner: str(row.owner, 'shared') as Owner,
    sessionId: row.session_id == null ? null : String(row.session_id),
    createdAt: num(row.created_at),
    eventAt: optNum(row.event_at),
    eventPrecision: str(row.event_precision, 'unknown') as TimePrecision,
    level: num(row.level) as MemoryLevel,
    floorLevel: num(row.floor_level) as MemoryLevel,
    locked: num(row.locked) === 1,
    fact: str(row.fact),
    gist: str(row.gist),
    tag: str(row.tag),
    raw: row.raw == null ? null : String(row.raw),
    rawRetained: num(row.raw_retained) === 1,
    channels,
    affect,
    relationDelta,
    importance: num(row.importance),
    importanceUpdatedAt: num(row.importance_updated_at),
    recallCount: num(row.recall_count),
    lastFiredAt: optNum(row.last_fired_at),
    fireCount24h: num(row.fire_count_24h),
    source: str(row.source, 'new_experience') as MemorySource,
    readOnly: num(row.read_only) === 1,
    validFrom: num(row.valid_from),
    validTo: optNum(row.valid_to),
    invalidatedBy: row.invalidated_by == null ? null : String(row.invalidated_by),
    calendarAnchor: anchorRaw,
    dueAt: optNum(row.due_at),
    promiseState: (str(row.promise_state, 'none') || 'none') as PromiseState,
    tags: row.tags ? safeJsonParse<string[]>(String(row.tags), []) : [],
    entities: row.entities ? safeJsonParse<string[]>(String(row.entities), []) : [],
    themeKey: row.theme_key == null ? null : String(row.theme_key),
    embeddingModel: row.embedding_model == null ? null : String(row.embedding_model),
    compressionCount: num(row.compression_count),
    importanceLog,
    note: row.note == null ? null : String(row.note),
  };
}

export const MEMORY_INSERT_SQL = `
INSERT INTO memories (
  id, owner, session_id, created_at, event_at, event_precision,
  level, floor_level, locked, fact, gist, tag, raw, raw_retained,
  s_fact, t_fact, s_gist, t_gist, s_affect, t_affect,
  affect_valence, affect_arousal, affect_label, relation_delta,
  importance, importance_updated_at, recall_count, last_fired_at, fire_count_24h,
  source, read_only, valid_from, valid_to, invalidated_by,
  calendar_anchor, due_at, promise_state, tags, entities, theme_key, embedding_model,
  compression_count, importance_log, note
) VALUES (
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?
)`;

export function memoryParams(m: MemoryRecord): SqlParam[] {
  return [
    m.id,
    m.owner,
    m.sessionId,
    m.createdAt,
    m.eventAt,
    m.eventPrecision,
    m.level,
    m.floorLevel,
    m.locked ? 1 : 0,
    m.fact,
    m.gist,
    m.tag,
    m.raw,
    m.rawRetained ? 1 : 0,
    m.channels.fact.strength,
    m.channels.fact.updatedAt,
    m.channels.gist.strength,
    m.channels.gist.updatedAt,
    m.channels.affect.strength,
    m.channels.affect.updatedAt,
    m.affect ? m.affect.valence : null,
    m.affect ? m.affect.arousal : null,
    m.affect ? m.affect.label : null,
    m.relationDelta ? JSON.stringify(m.relationDelta) : null,
    m.importance,
    m.importanceUpdatedAt,
    m.recallCount,
    m.lastFiredAt,
    m.fireCount24h,
    m.source,
    m.readOnly ? 1 : 0,
    m.validFrom,
    m.validTo,
    m.invalidatedBy,
    m.calendarAnchor ? JSON.stringify(m.calendarAnchor) : null,
    m.dueAt,
    m.promiseState,
    JSON.stringify(m.tags || []),
    JSON.stringify(m.entities || []),
    m.themeKey,
    m.embeddingModel,
    m.compressionCount,
    JSON.stringify(m.importanceLog || []),
    m.note,
  ];
}

export const MEMORY_UPDATE_SQL = `
UPDATE memories SET
  owner = ?, session_id = ?, created_at = ?, event_at = ?, event_precision = ?,
  level = ?, floor_level = ?, locked = ?, fact = ?, gist = ?, tag = ?, raw = ?, raw_retained = ?,
  s_fact = ?, t_fact = ?, s_gist = ?, t_gist = ?, s_affect = ?, t_affect = ?,
  affect_valence = ?, affect_arousal = ?, affect_label = ?, relation_delta = ?,
  importance = ?, importance_updated_at = ?, recall_count = ?, last_fired_at = ?, fire_count_24h = ?,
  source = ?, read_only = ?, valid_from = ?, valid_to = ?, invalidated_by = ?,
  calendar_anchor = ?, due_at = ?, promise_state = ?, tags = ?, entities = ?, theme_key = ?, embedding_model = ?,
  compression_count = ?, importance_log = ?, note = ?
WHERE id = ?`;

export function memoryUpdateParams(m: MemoryRecord): SqlParam[] {
  const base = memoryParams(m);
  const id = base[0];
  const rest = base.slice(1);
  return [...rest, id];
}

export function toFloat32(buf: Uint8Array): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function fromFloat32(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer.slice(0) as ArrayBuffer);
}