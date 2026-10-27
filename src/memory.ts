/* ============================================================================
 * 记忆存取 (memory.ts)
 *
 * 纯数据访问层：增删改查、失效、激活记录。不含任何「判断」，判断都在上层。
 * ==========================================================================*/

import type { Db, SqlParam } from './db.ts';
import { MEMORY_INSERT_SQL, MEMORY_UPDATE_SQL, memoryParams, memoryUpdateParams, rowToMemory } from './db.ts';
import type { MemoryLevel, MemoryRecord, Owner } from './types.ts';
import { clamp, daysBetween, MS_DAY, newId, round } from './util.ts';

export interface MemoryQuery {
  ids?: string[];
  owners?: Owner[];
  sessionId?: string;
  minImportance?: number;
  maxImportance?: number;
  levels?: MemoryLevel[];
  includeInvalid?: boolean;
  createdAfter?: number;
  createdBefore?: number;
  themeKey?: string;
  onlyFrozen?: boolean;
  onlyLocked?: boolean;
  excludeIds?: string[];
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'importance' | 'last_fired_at' | 'recall_count';
  order?: 'asc' | 'desc';
}

export function insertMemory(db: Db, record: MemoryRecord): void {
  db.run(MEMORY_INSERT_SQL, memoryParams(record));
}

export function updateMemory(db: Db, record: MemoryRecord): void {
  db.run(MEMORY_UPDATE_SQL, memoryUpdateParams(record));
}

export function getMemory(db: Db, id: string): MemoryRecord | null {
  const row = db.get('SELECT * FROM memories WHERE id = ?', [id]);
  return row ? rowToMemory(row) : null;
}

export function getMemories(db: Db, ids: string[]): MemoryRecord[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.all('SELECT * FROM memories WHERE id IN (' + placeholders + ')', ids);
  return rows.map(rowToMemory);
}

export function queryMemories(db: Db, q: MemoryQuery = {}): MemoryRecord[] {
  const where: string[] = [];
  const params: SqlParam[] = [];

  if (q.ids && q.ids.length > 0) {
    where.push('id IN (' + q.ids.map(() => '?').join(', ') + ')');
    params.push(...q.ids);
  }
  if (q.excludeIds && q.excludeIds.length > 0) {
    where.push('id NOT IN (' + q.excludeIds.map(() => '?').join(', ') + ')');
    params.push(...q.excludeIds);
  }
  if (q.owners && q.owners.length > 0) {
    where.push('owner IN (' + q.owners.map(() => '?').join(', ') + ')');
    params.push(...q.owners);
  }
  if (q.sessionId) {
    where.push('session_id = ?');
    params.push(q.sessionId);
  }
  if (typeof q.minImportance === 'number') {
    where.push('importance >= ?');
    params.push(q.minImportance);
  }
  if (typeof q.maxImportance === 'number') {
    where.push('importance <= ?');
    params.push(q.maxImportance);
  }
  if (q.levels && q.levels.length > 0) {
    where.push('level IN (' + q.levels.map(() => '?').join(', ') + ')');
    params.push(...q.levels);
  }
  if (!q.includeInvalid) {
    where.push('valid_to IS NULL');
  }
  if (typeof q.createdAfter === 'number') {
    where.push('created_at >= ?');
    params.push(q.createdAfter);
  }
  if (typeof q.createdBefore === 'number') {
    where.push('created_at <= ?');
    params.push(q.createdBefore);
  }
  if (q.themeKey) {
    where.push('theme_key = ?');
    params.push(q.themeKey);
  }
  if (q.onlyFrozen) where.push('read_only = 1');
  if (q.onlyLocked) where.push('locked = 1');

  const orderBy = q.orderBy || 'created_at';
  const order = (q.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const limit = typeof q.limit === 'number' ? Math.max(1, Math.floor(q.limit)) : 200;
  const offset = typeof q.offset === 'number' ? Math.max(0, Math.floor(q.offset)) : 0;

  const sql =
    'SELECT * FROM memories' +
    (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY ' + orderBy + ' ' + order + ' LIMIT ? OFFSET ?';

  return db.all(sql, [...params, limit, offset]).map(rowToMemory);
}

export function allValidIds(db: Db): Set<string> {
  const rows = db.all('SELECT id FROM memories WHERE valid_to IS NULL');
  const set = new Set<string>();
  for (const row of rows) set.add(String(row.id));
  return set;
}

/** 按固定主题键找那条稳定事实（不受去重时间窗限制）。 */
export function findByThemeKey(db: Db, themeKey: string): MemoryRecord | null {
  if (!themeKey) return null;
  const row = db.get(
    'SELECT * FROM memories WHERE theme_key = ? AND valid_to IS NULL ORDER BY created_at ASC LIMIT 1',
    [themeKey],
  );
  return row ? rowToMemory(row) : null;
}

export function countMemories(db: Db, includeInvalid = false): number {
  const row = db.get(
    'SELECT COUNT(*) AS c FROM memories' + (includeInvalid ? '' : ' WHERE valid_to IS NULL'),
  );
  return row ? Number(row.c) : 0;
}

/* ---------- 失效（矛盾消解） ---------- */

export function invalidateMemory(db: Db, id: string, byId: string, at: number): boolean {
  const res = db.run('UPDATE memories SET valid_to = ?, invalidated_by = ? WHERE id = ? AND valid_to IS NULL', [
    at,
    byId,
    id,
  ]);
  return res.changes > 0;
}

/* ---------- 激活记录 ---------- */

export interface ActivationInput {
  memoryId: string;
  sessionId: string | null;
  turn: number;
  at: number;
  kind: 'recall' | 'compress' | 'merge' | 'manual';
}

export function recordActivation(db: Db, input: ActivationInput): void {
  db.run('INSERT INTO activations(memory_id, session_id, turn, at, kind) VALUES(?, ?, ?, ?, ?)', [
    input.memoryId,
    input.sessionId,
    input.turn,
    input.at,
    input.kind,
  ]);
}

/** 每个记忆最后一次压缩的时间，供 consolidation 判断最小间隔。 */
export function lastCompressionTimes(db: Db): Map<string, number> {
  const rows = db.all(
    "SELECT memory_id, MAX(at) AS last FROM activations WHERE kind = 'compress' GROUP BY memory_id",
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.last != null) map.set(String(row.memory_id), Number(row.last));
  }
  return map;
}

/** 当前会话里最近 N 轮被用过的记忆，用于横向抑制。 */
export function recentlyFiredIds(
  db: Db,
  sessionId: string | null,
  fromTurn: number,
  toTurn = Number.MAX_SAFE_INTEGER,
): Set<string> {
  const set = new Set<string>();
  if (!sessionId) return set;
  const rows = db.all(
    'SELECT DISTINCT memory_id FROM activations WHERE session_id = ? AND kind = ? AND turn >= ? AND turn < ?',
    [sessionId, 'recall', Math.max(0, fromTurn), toTurn],
  );
  for (const row of rows) set.add(String(row.memory_id));
  return set;
}

export function recentActivationCount(db: Db, memoryId: string, since: number): number {
  const row = db.get('SELECT COUNT(*) AS c FROM activations WHERE memory_id = ? AND at >= ?', [memoryId, since]);
  return row ? Number(row.c) : 0;
}

/* ---------- 重要性更新 ---------- */

export interface ImportanceUpdate {
  record: MemoryRecord;
  to: number;
  by: string;
  why: string;
  at: number;
}

/**
 * importance 的唯一修改入口。
 * 只有新经历、用户主动提起、用户钉住才能进来 —— 检索路径永远拿不到这个入口。
 */
export function applyImportance(record: MemoryRecord, update: ImportanceUpdate): MemoryRecord {
  const to = clamp(update.to, 0, 1);
  if (Math.abs(to - record.importance) < 1e-6) return record;
  return {
    ...record,
    importance: round(to, 4),
    importanceUpdatedAt: update.at,
    importanceLog: [
      ...record.importanceLog.slice(-19),
      { at: update.at, from: record.importance, to: round(to, 4), by: update.by, why: update.why },
    ],
  };
}

/** 记忆活跃度衰减的一个便捷函数（供 relation / 日历等模块用）。 */
export function ageInDays(createdAt: number, now: number): number {
  return Math.max(0, daysBetween(createdAt, now));
}

export function makeId(): string {
  return newId('mem');
}

export function emptyDayKeyBase(now: number): number {
  return now - (now % MS_DAY);
}