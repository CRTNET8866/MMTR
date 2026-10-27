/* ============================================================================
 * 记忆创建 / 建链 / 合并 (create.ts)
 *
 * 写入即决策的落地环节：
 *   - 决定这条记忆的压缩下限（由 importance 一次性决定）
 *   - 决定三条通道的初始强度
 *   - 决定它跟谁连边（链式联想的原料）
 *   - 决定它是否让某条旧事实失效（矛盾消解）
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { Db } from './db.ts';
import type { EmbeddingProvider, VectorCache } from './embeddings.ts';
import type {
  CalendarAnchor,
  Channel,
  ChannelState,
  MemoryCandidate,
  MemoryRecord,
  MemoryLevel,
  MemorySource,
  RelationDelta,
} from './types.ts';
import { applyActivation, floorLevelForImportance } from './decay.ts';
import { allValidIds, getMemory, getMemories, recordActivation, updateMemory } from './memory.ts';
import { upsertEdge } from './graph.ts';
import { clamp01, MS_DAY, MS_HOUR, newId, round, truncate, uniqueStrings } from './util.ts';
import { promiseAnchor } from './promise.ts';
import { normalizeTag } from './heuristic.ts';

export interface CreateDeps {
  db: Db;
  config: MMTRConfig;
  vectors: VectorCache;
  embed: EmbeddingProvider;
}

export interface BuildSpec {
  candidate: MemoryCandidate;
  at: number;
  sessionId: string | null;
  rawText: string;
  pin?: boolean;
  source?: MemorySource;
}

/* ---------- 通道初值 ---------- */

export function initialChannels(c: MemoryCandidate, at: number): Record<Channel, ChannelState> {
  const imp = clamp01(c.importance);
  const affectStrength = c.affect
    ? clamp01(0.3 + 0.7 * clamp01((Math.abs(c.affect.valence) + c.affect.arousal) / 2))
    : 0.16;
  return {
    fact: { strength: round(clamp01(0.28 + 0.62 * imp), 4), updatedAt: at },
    gist: { strength: round(clamp01(0.34 + 0.6 * imp), 4), updatedAt: at },
    affect: { strength: round(affectStrength, 4), updatedAt: at },
  };
}

/* ---------- 记录构建 ---------- */

export function buildRecord(spec: BuildSpec, config: MMTRConfig): MemoryRecord {
  const c = spec.candidate;
  const importance = clamp01(spec.pin ? Math.max(c.importance, config.write.pinImportance) : c.importance);
  // 承诺/约定一律锁死原文：她不能忘掉自己答应过什么，那是关系的地基
  const isPromise = c.dueAt !== null && c.dueAt !== undefined;
  const locked = spec.pin === true || importance >= config.write.lockImportance || isPromise;
  // 约定没有压缩下限可言：它永远是 L0
  const floorLevel: MemoryLevel = isPromise ? 0 : floorLevelForImportance(importance, config);
  const rawRetained = locked || importance >= config.write.rawRetainMin;

  return {
    id: newId('mem'),
    owner: c.owner,
    sessionId: spec.sessionId,
    createdAt: spec.at,
    eventAt: c.eventAt,
    eventPrecision: c.eventPrecision,
    level: 0,
    floorLevel,
    locked,
    fact: c.fact,
    gist: c.gist,
    tag: normalizeTag(c.tag),
    raw: rawRetained ? truncate(spec.rawText, 4000) : truncate(spec.rawText, 400),
    rawRetained,
    channels: initialChannels(c, spec.at),
    affect: c.affect,
    relationDelta: c.relationDelta,
    importance: round(importance, 4),
    importanceUpdatedAt: spec.at,
    recallCount: 0,
    lastFiredAt: null,
    fireCount24h: 0,
    source: spec.source ?? 'new_experience',
    readOnly: false,
    validFrom: spec.at,
    validTo: null,
    invalidatedBy: null,
    // 承诺与日历是两条独立的通道：跨年那天约好一起倒数，既是「过节」也是「约好的事」。
    // 有日历锚点就保留它；没有才退化成 due 锚点。
    calendarAnchor: c.calendarAnchor ?? (isPromise ? promiseAnchor(c.dueAt as number, c.tag || null) : null),
    dueAt: isPromise ? (c.dueAt as number) : null,
    promiseState: isPromise ? 'pending' : 'none',
    tags: c.tags,
    entities: c.entities,
    themeKey: c.themeKey,
    embeddingModel: null,
    compressionCount: 0,
    importanceLog: [
      {
        at: spec.at,
        from: 0,
        to: round(importance, 4),
        by: 'new_experience',
        why: c.reason || '写入决策',
      },
    ],
    note: null,
  };
}

/* ---------- 向量 ---------- */

export function embeddingText(record: MemoryRecord): string {
  const parts = [record.gist, record.fact, record.tag, record.themeKey || '', record.tags.join(' ')];
  return truncate(parts.filter((p) => p && p.length > 0).join(' · '), 1200);
}

/** 候选记忆的向量文本：必须与 embeddingText 保持完全一致，否则去重会失真。 */
export function candidateEmbeddingText(c: MemoryCandidate): string {
  const parts = [c.gist, c.fact, c.tag, c.themeKey || '', c.tags.join(' ')];
  return truncate(parts.filter((p) => p && p.length > 0).join(' · '), 1200);
}
export async function embedRecord(deps: CreateDeps, record: MemoryRecord): Promise<Float32Array | null> {
  if (deps.embed.name === 'none') return null;
  try {
    const [vec] = await deps.embed.embed([embeddingText(record)]);
    if (!vec) return null;
    deps.vectors.put(record.id, vec, deps.embed.name);
    return vec;
  } catch {
    return null;
  }
}

export async function embedQuery(deps: CreateDeps, text: string): Promise<Float32Array | null> {
  if (deps.embed.name === 'none') return null;
  try {
    const [vec] = await deps.embed.embed([truncate(text, 1200)]);
    return vec ?? null;
  } catch {
    return null;
  }
}

/* ---------- 去重合并 ---------- */

export interface MergeResult {
  record: MemoryRecord;
  before: MemoryRecord;
}

/**
 * 新的一段经历和旧记忆几乎一样 → 不新增记录，而是把它「再经历一次」。
 * 这是复习，不是检索：所以可以完整回血，且可以抬升 importance。
 */

export function mergeInto(deps: CreateDeps, existing: MemoryRecord, c: MemoryCandidate, now: number): MergeResult {
  const { config } = deps;
  const channels = {
    fact: applyActivation(existing.channels.fact, config.channels.fact, now, 0),
    gist: applyActivation(existing.channels.gist, config.channels.gist, now, 0),
    affect: applyActivation(existing.channels.affect, config.channels.affect, now, 0),
  };

  // 新证据可以把重要性顶上去（不是检索路径，允许）
  const bumped = round(clamp01(existing.importance + 0.08 * (1 - existing.importance)), 4);
  const importance = Math.max(existing.importance, bumped);
  const locked = existing.locked || importance >= config.write.lockImportance;
  const floorLevel = locked ? 0 : Math.min(existing.floorLevel, floorLevelForImportance(importance, config));

  // 情绪取更强烈的那个
  let affect = existing.affect;
  if (c.affect) {
    if (!affect) affect = c.affect;
    else {
      const oldMag = Math.abs(affect.valence) + affect.arousal;
      const newMag = Math.abs(c.affect.valence) + c.affect.arousal;
      if (newMag > oldMag) affect = c.affect;
    }
  }

  const updated: MemoryRecord = {
    ...existing,
    channels,
    affect,
    importance,
    importanceUpdatedAt: now,
    importanceLog: [
      ...existing.importanceLog.slice(-19),
      { at: now, from: existing.importance, to: importance, by: 'new_experience', why: '重复经历，回溯重加权' },
    ],
    floorLevel,
    locked,
    tags: uniqueStrings([...existing.tags, ...c.tags]).slice(0, 12),
    entities: uniqueStrings([...existing.entities, ...c.entities]).slice(0, 12),
    raw: existing.rawRetained ? existing.raw : truncate((existing.raw || '') + '\n---\n' + (c.fact || c.gist), 800),
    rawRetained: existing.rawRetained || importance >= config.write.rawRetainMin,
    relationDelta: mergeRelationDeltas(existing.relationDelta, c.relationDelta),
    calendarAnchor: existing.calendarAnchor ?? c.calendarAnchor,
    eventAt: existing.eventAt ?? c.eventAt,
    recallCount: existing.recallCount,
    lastFiredAt: now,
    themeKey: existing.themeKey || c.themeKey,
  };

  deps.db.tx(() => {
    updateMemory(deps.db, updated);
    recordActivation(deps.db, { memoryId: existing.id, sessionId: updated.sessionId, turn: 0, at: now, kind: 'merge' });
  });

  return { record: updated, before: existing };
}

function mergeRelationDeltas(a: RelationDelta | null, b: RelationDelta | null): RelationDelta | null {
  if (!a) return b;
  if (!b) return a;
  const out: RelationDelta = { ...a };
  for (const key of Object.keys(b) as Array<keyof RelationDelta>) {
    out[key] = round((out[key] || 0) + (b[key] || 0), 4);
  }
  return out;
}

/* ---------- 建链 ---------- */

function anchorFragments(anchor: CalendarAnchor): string[] {
  if (anchor.kind === 'annual' || anchor.kind === 'anniversary') {
    if (anchor.month && anchor.day) return ['%"month":' + anchor.month + '%', '%"day":' + anchor.day + '%'];
    return [];
  }
  if (anchor.kind === 'festival' && anchor.festival) return ['%"festival":"' + anchor.festival + '"%'];
  if (anchor.kind === 'weekly' && anchor.weekday !== undefined) return ['%"weekday":' + anchor.weekday + '%'];
  return [];
}

export interface LinkReport {
  edges: number;
  contradicted: string | null;
  invalidated: string | null;
}

/**
 * 给新记忆建边。这是「链式联想」的原料：
 *   same_theme   语义相近
 *   temporal     时间邻近（同一次长谈里的两件事）
 *   entity       共享实体（同一个人/地点/物件）
 *   same_anchor  共享日历锚点（同属「过节」那条链）
 *   contradicts  与旧事实冲突
 */
export async function linkMemory(
  deps: CreateDeps,
  record: MemoryRecord,
  now: number,
): Promise<LinkReport> {
  const { db, config, vectors } = deps;
  const link = config.graph.link;
  let edges = 0;

  // 按「边类型 + 目标」去重：同一对记忆可以同时有 temporal 和 same_anchor 两种关系
  const seen = new Set<string>();
  const key = (type: string, id: string): string => type + '|' + id;
  const already = (type: string, id: string): boolean => seen.has(key(type, id));
  const mark = (type: string, id: string): void => {
    seen.add(key(type, id));
  };

  /* 语义近邻 */
  if (deps.embed.name !== 'none') {
    const vec = vectors.get(record.id);
    if (vec) {
      const allow = allValidIds(db);
      const near = vectors.search(vec, link.themeTopK, allow);
      for (const item of near) {
        if (already('same_theme', item.id) || item.score < link.themeSimMin) continue;
        upsertEdge(db, {
          fromId: record.id,
          toId: item.id,
          type: 'same_theme',
          weight: clamp01(0.2 + 0.6 * item.score),
          at: now,
        });
        mark('same_theme', item.id);
        edges++;
      }
    }
  }

  /* 时间邻近 */
  const temporalRow = db.get(
    'SELECT id, created_at FROM memories WHERE valid_to IS NULL AND id != ? ORDER BY ABS(created_at - ?) ASC LIMIT 1',
    [record.id, record.createdAt],
  );
  if (temporalRow) {
    const otherId = String(temporalRow.id);
    const gapHours = Math.abs(Number(temporalRow.created_at) - record.createdAt) / MS_HOUR;
    if (gapHours <= link.temporalWindowHours) {
      upsertEdge(db, { fromId: record.id, toId: otherId, type: 'temporal', weight: 0.35, at: now });
      mark('temporal', otherId);
      edges++;
    }
  }

  /* 共享实体 */
  let entityLinks = 0;
  for (const entity of record.entities.slice(0, link.entityMax)) {
    if (entityLinks >= link.entityMax) break;
    const rows = db.all(
      'SELECT id FROM memories WHERE valid_to IS NULL AND id != ? AND entities LIKE ? LIMIT 2',
      [record.id, '%"' + entity + '"%'],
    );
    for (const row of rows) {
      const otherId = String(row.id);
      if (already('entity', otherId)) continue;
      upsertEdge(db, { fromId: record.id, toId: otherId, type: 'entity', weight: 0.45, at: now });
      mark('entity', otherId);
      edges++;
      entityLinks++;
      if (entityLinks >= link.entityMax) break;
    }
  }

  /* 共享日历锚点 —— 「过节」那条链 */
  if (record.calendarAnchor) {
    const fragments = anchorFragments(record.calendarAnchor);
    if (fragments.length > 0) {
      const where = fragments.map(() => 'calendar_anchor LIKE ?').join(' AND ');
      const rows = db.all(
        'SELECT id FROM memories WHERE valid_to IS NULL AND id != ? AND calendar_anchor IS NOT NULL AND ' + where + ' LIMIT ?',
        [record.id, ...fragments, link.anchorTopK],
      );
      for (const row of rows) {
        const otherId = String(row.id);
        if (already('same_anchor', otherId)) continue;
        upsertEdge(db, { fromId: record.id, toId: otherId, type: 'same_anchor', weight: 0.5, at: now });
        mark('same_anchor', otherId);
        edges++;
      }
    }
  }

  return { edges, contradicted: null, invalidated: null };
}
/**
 * 处理抽取器报出的矛盾：让旧的、与之冲突的事实失效。
 * 旧记忆不会被删除 —— valid_to 打上时间戳，仍然可查，只是不再是「现在的事实」。
 */
export function invalidateByContradiction(
  deps: CreateDeps,
  newRecord: MemoryRecord,
  contradictionPhrase: string,
  now: number,
): string | null {
  const { db, config } = deps;
  const rows = db.all(
    'SELECT * FROM memories WHERE valid_to IS NULL AND id != ? AND (fact LIKE ? OR gist LIKE ?) LIMIT 5',
    [newRecord.id, '%' + contradictionPhrase.slice(0, 24) + '%', '%' + contradictionPhrase.slice(0, 24) + '%'],
  );
  if (rows.length === 0) return null;
  const target = getMemories(db, [String(rows[0].id)])[0];
  if (!target) return null;

  db.tx(() => {
    db.run('UPDATE memories SET valid_to = ?, invalidated_by = ? WHERE id = ?', [now, newRecord.id, target.id]);
    upsertEdge(db, {
      fromId: newRecord.id,
      toId: target.id,
      type: 'contradicts',
      weight: 0.6,
      at: now,
    });
    // 新事实本身值得留下来
    const bumped = round(clamp01(newRecord.importance + 0.1 * (1 - newRecord.importance)), 4);
    updateMemory(db, {
      ...newRecord,
      importance: Math.max(newRecord.importance, bumped),
      importanceUpdatedAt: now,
      importanceLog: [
        ...newRecord.importanceLog.slice(-19),
        { at: now, from: newRecord.importance, to: bumped, by: 'new_experience', why: '推翻旧事实' },
      ],
      floorLevel: Math.min(newRecord.floorLevel, floorLevelForImportance(bumped, config)),
    });
  });

  return target.id;
}

/* ---------- 会话摘要记忆 ---------- */

export function buildSessionSummaryRecord(
  config: MMTRConfig,
  sessionId: string,
  at: number,
  summary: string,
  affect: MemoryCandidate['affect'],
  importance: number,
): MemoryRecord {
  const candidate: MemoryCandidate = {
    remember: true,
    importance,
    owner: 'shared',
    fact: truncate(summary, 300),
    gist: truncate(summary, 100),
    tag: '会话',
    affect,
    relationDelta: null,
    tags: ['会话'],
    entities: [],
    themeKey: '会话',
    calendarAnchor: null,
    eventAt: at,
    eventPrecision: 'day',
    contradicts: null,
    reason: '会话摘要',
  };
  const record = buildRecord(
    { candidate, at, sessionId, rawText: summary, source: 'consolidated' },
    config,
  );
  return record;
}