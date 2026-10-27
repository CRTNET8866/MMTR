/* ============================================================================
 * 关系通道 (relation.ts)
 *
 * 这是本系统最看重的一条通道，也是「大肥鱼」那个好感条真正该长的样子。
 *
 * 它是一等公民，不是 profile 里的一行字：
 *   - 有上限，越接近上限越难推（变化率递减）
 *   - 向基线缓慢回落，但永远回不到零（久别重逢还有那份熟稔）
 *   - 不随对话重置，每次醒来都作为「此刻的心情」注入
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { Db } from './db.ts';
import type { RelationDelta, RelationDim, RelationDims, RelationState } from './types.ts';
import { RELATION_DIMS, RELATION_LABELS } from './types.ts';
import { MS_DAY, clamp, clamp01, round, safeJsonParse } from './util.ts';

export const RELATION_ID = 'global';

export function baselineDims(config: MMTRConfig): RelationDims {
  const base = config.relation.dims;
  return {
    closeness: base.closeness,
    trust: base.trust,
    playfulness: base.playfulness,
    warmth: base.warmth,
    tension: base.tension,
    familiarity: base.familiarity,
  };
}

export function emptyRelationState(config: MMTRConfig, now: number): RelationState {
  return { dims: baselineDims(config), updatedAt: now, revision: 1 };
}

export function getRelationState(db: Db, config: MMTRConfig, now: number): RelationState {
  const row = db.get('SELECT dims, updated_at, revision FROM relation_state WHERE id = ?', [RELATION_ID]);
  if (!row) {
    const fresh = emptyRelationState(config, now);
    saveRelationState(db, fresh, now, 'init', null);
    return fresh;
  }
  const parsed = safeJsonParse<RelationDims | null>(String(row.dims), null);
  const base = baselineDims(config);
  const dims: RelationDims = { ...base };
  if (parsed) {
    for (const dim of RELATION_DIMS) {
      const v = (parsed as Record<string, unknown>)[dim];
      if (typeof v === 'number' && Number.isFinite(v)) dims[dim] = clamp(v, 0, config.relation.ceiling);
    }
  }
  return {
    dims,
    updatedAt: Number(row.updated_at),
    revision: Number(row.revision),
  };
}

export function saveRelationState(
  db: Db,
  state: RelationState,
  now: number,
  reason: string,
  memoryId: string | null,
): RelationState {
  const prev = db.get('SELECT dims FROM relation_state WHERE id = ?', [RELATION_ID]);
  const next: RelationState = { dims: state.dims, updatedAt: now, revision: state.revision + 1 };
  db.run(
    'INSERT INTO relation_state(id, dims, updated_at, revision) VALUES(?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET dims = excluded.dims, updated_at = excluded.updated_at, revision = excluded.revision',
    [RELATION_ID, JSON.stringify(next.dims), next.updatedAt, next.revision],
  );
  db.run('INSERT INTO relation_log(at, reason, before, after, memory_id) VALUES(?, ?, ?, ?, ?)', [
    now,
    reason,
    prev ? String(prev.dims) : '{}',
    JSON.stringify(next.dims),
    memoryId,
  ]);
  return next;
}

/* ---------- 时间回归 ---------- */

/**
 * 向基线缓慢回落。tension 半衰期更短 —— 人会和解，会记仇的 AI 不是人。
 */
export function regressRelation(
  state: RelationState,
  config: MMTRConfig,
  now: number,
): { dims: RelationDims; changed: boolean } {
  const base = baselineDims(config);
  const dtDays = Math.max(0, now - state.updatedAt) / MS_DAY;
  if (dtDays < 0.02) return { dims: state.dims, changed: false };

  const dims: RelationDims = { ...state.dims };
  let changed = false;
  for (const dim of RELATION_DIMS) {
    const halfLife =
      dim === 'tension'
        ? Math.max(0.5, config.relation.tensionHalfLifeDays)
        : Math.max(1, config.relation.regressionHalfLifeDays);
    const keep = Math.pow(0.5, dtDays / halfLife);
    const prev = dims[dim];
    const next = base[dim] + (prev - base[dim]) * keep;
    if (Math.abs(next - prev) > 1e-4) changed = true;
    dims[dim] = round(clamp01(next), 4);
  }
  return { dims, changed };
}

/* ---------- 增量施加 ---------- */

/**
 * 施加关系增量：
 *   1. 单次幅度受 maxDeltaPerSession 限制，防人格跳变
 *   2. 越接近上限，同样的互动推动越小（变化率递减）
 *   3. 张力单独限制，不能一次炸到顶
 */
export function applyRelationDeltas(
  state: RelationState,
  delta: RelationDelta | null,
  config: MMTRConfig,
  now: number,
  scale = 1,
): { dims: RelationDims; applied: RelationDelta | null } {
  if (!delta) return { dims: state.dims, applied: null };
  const regressed = regressRelation(state, config, now);
  const dims: RelationDims = { ...regressed.dims };
  const base = baselineDims(config);
  const ceiling = config.relation.ceiling;
  const applied: RelationDelta = {};
  let any = false;

  for (const dim of RELATION_DIMS) {
    const raw = delta[dim];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) < 1e-6) continue;
    const capped = clamp(raw * scale, -config.relation.maxDeltaPerSession, config.relation.maxDeltaPerSession);
    const span = Math.max(0.0001, ceiling - base[dim]);
    const room = clamp01((ceiling - dims[dim]) / span);
    const squeeze = 1 - config.relation.rateLimitFactor * clamp01((dims[dim] - base[dim]) / span);
    const effective = capped * (capped > 0 ? squeeze : 1) * (capped > 0 ? Math.max(0.15, room) : 1);
    const next = clamp(dims[dim] + effective, 0, ceiling);
    if (Math.abs(next - dims[dim]) < 1e-6) continue;
    applied[dim] = round(next - dims[dim], 4);
    dims[dim] = round(next, 4);
    any = true;
  }

  return { dims, applied: any ? applied : null };
}

export function mergeDeltas(list: Array<RelationDelta | null | undefined>): RelationDelta | null {
  const out: RelationDelta = {};
  let any = false;
  for (const d of list) {
    if (!d) continue;
    for (const dim of RELATION_DIMS) {
      const v = d[dim];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[dim] = round((out[dim] || 0) + v, 4);
      any = true;
    }
  }
  return any ? out : null;
}

/* ---------- 渲染 ---------- */

const HIGH_PHRASES: Record<RelationDim, string> = {
  closeness: '很亲近',
  trust: '很信任',
  playfulness: '爱闹',
  warmth: '暖暖的',
  tension: '有点别扭',
  familiarity: '很熟',
};

const LOW_PHRASES: Record<RelationDim, string> = {
  closeness: '有点距离',
  trust: '还在观察',
  playfulness: '比较正经',
  warmth: '平稳',
  tension: '没什么芥蒂',
  familiarity: '还有些陌生',
};

export function relationNumberLine(dims: RelationDims): string {
  return RELATION_DIMS.map((d) => RELATION_LABELS[d] + ' ' + dims[d].toFixed(2)).join('｜');
}

/** 「你心里的感觉」—— 只给形状，不给数字。数字留给调试面板。 */
export function relationFeeling(dims: RelationDims, config: MMTRConfig): string {
  const base = baselineDims(config);
  const parts: string[] = [];
  const strong: string[] = [];
  const weak: string[] = [];

  for (const dim of RELATION_DIMS) {
    const v = dims[dim];
    const b = base[dim];
    if (dim === 'tension') {
      if (v >= b + 0.15) strong.push('心里还有点没散开的东西');
      continue;
    }
    if (v >= 0.62) strong.push(HIGH_PHRASES[dim]);
    else if (v <= Math.max(0.16, b - 0.12)) weak.push(LOW_PHRASES[dim]);
  }

  if (strong.length > 0) parts.push(strong.slice(0, 3).join('、'));
  if (weak.length > 0) parts.push(weak.slice(0, 2).join('、'));
  if (parts.length === 0) parts.push('跟平时一样');
  return parts.join('；');
}

export function affectMoodLine(affect: AffectLike | null): string {
  if (!affect) return '心情平稳，没什么特别的起伏';
  const v = affect.valence;
  const a = affect.arousal;
  if (v >= 0.55) return a >= 0.65 ? '心情很亮，有点按不住' : '心情是亮的';
  if (v >= 0.15) return '心情偏暖';
  if (v <= -0.55) return a >= 0.65 ? '心里有火，还没压下去' : '情绪沉在下面';
  if (v <= -0.15) return '有点闷';
  return '心情平，不冷不热';
}

export interface AffectLike {
  valence: number;
  arousal: number;
  label: string;
}

/** 张力是否到了该被看见的程度。 */
export function openTensionLevel(dims: RelationDims, config: MMTRConfig): number {
  const base = config.relation.dims.tension;
  return clamp01((dims.tension - base) / Math.max(0.01, config.relation.ceiling - base));
}

export function relationSnapshot(dims: RelationDims): string {
  return JSON.stringify(dims);
}