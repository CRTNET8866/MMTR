import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import {
  applyRelationDeltas,
  affectMoodLine,
  baselineDims,
  emptyRelationState,
  getRelationState,
  mergeDeltas,
  openTensionLevel,
  regressRelation,
  relationFeeling,
  relationNumberLine,
  saveRelationState,
} from '../src/relation.ts';
import { RELATION_DIMS } from '../src/types.ts';
import { MS_DAY } from '../src/util.ts';

const cfg = DEFAULT_CONFIG;
const NOW = new Date(2026, 5, 1, 12, 0, 0).getTime();

test('关系状态从基线开始并落库', () => {
  const db = new Db(':memory:');
  const state = getRelationState(db, cfg, NOW);
  const base = baselineDims(cfg);
  for (const dim of RELATION_DIMS) assert.equal(state.dims[dim], base[dim]);
  assert.equal(state.revision, 1);
  const saved = saveRelationState(db, state, NOW, 'test', null);
  assert.equal(saved.revision, 2);
  const again = getRelationState(db, cfg, NOW);
  assert.deepEqual(again.dims, state.dims);
  db.close();
});

test('增量累积，但单次受 maxDeltaPerSession 限制', () => {
  const state = emptyRelationState(cfg, NOW);
  const big = applyRelationDeltas(state, { closeness: 5 }, cfg, NOW);
  const delta = big.dims.closeness - state.dims.closeness;
  assert.ok(delta > 0);
  assert.ok(delta <= cfg.relation.maxDeltaPerSession + 1e-6, '单次不能超过上限: ' + delta);
});

test('越接近上限，同样的互动推动越小（变化率递减）', () => {
  const low = { dims: { ...baselineDims(cfg), closeness: 0.35 }, updatedAt: NOW, revision: 1 };
  const high = { dims: { ...baselineDims(cfg), closeness: 0.9 }, updatedAt: NOW, revision: 1 };
  const a = applyRelationDeltas(low, { closeness: 0.05 }, cfg, NOW).dims.closeness - 0.35;
  const b = applyRelationDeltas(high, { closeness: 0.05 }, cfg, NOW).dims.closeness - 0.9;
  assert.ok(a > b, '低处推动更大: ' + a + ' > ' + b);
});

test('不会突破天花板', () => {
  let state = { dims: { ...baselineDims(cfg), closeness: cfg.relation.ceiling - 0.001 }, updatedAt: NOW, revision: 1 };
  for (let i = 0; i < 50; i++) {
    state = { ...state, dims: applyRelationDeltas(state, { closeness: 0.06 }, cfg, NOW).dims, updatedAt: NOW };
  }
  assert.ok(state.dims.closeness <= cfg.relation.ceiling + 1e-9);
});

test('向基线回归，但回不到零（会留一个温柔的底）', () => {
  const state = { dims: { ...baselineDims(cfg), closeness: 0.95 }, updatedAt: NOW, revision: 1 };
  const after1 = regressRelation(state, cfg, NOW + 30 * MS_DAY).dims.closeness;
  const after2 = regressRelation(state, cfg, NOW + 300 * MS_DAY).dims.closeness;
  const base = baselineDims(cfg).closeness;
  assert.ok(after1 < 0.95 && after1 > base, '一个月后应回落但不归零: ' + after1);
  assert.ok(after2 < after1, '越久越接近基线');
  assert.ok(after2 > 0, '永远不为零');
});

test('张力消退比亲近更快（人会和解）', () => {
  const state = {
    dims: { ...baselineDims(cfg), closeness: 0.9, tension: 0.9 },
    updatedAt: NOW,
    revision: 1,
  };
  const later = NOW + 14 * MS_DAY;
  const reg = regressRelation(state, cfg, later).dims;
  const closenessDrop = 0.9 - reg.closeness;
  const tensionDrop = 0.9 - reg.tension;
  assert.ok(tensionDrop > closenessDrop, '张力掉得更快: ' + tensionDrop + ' vs ' + closenessDrop);
});

test('负面增量能把张力顶上去', () => {
  const state = emptyRelationState(cfg, NOW);
  const out = applyRelationDeltas(state, { tension: 0.05, warmth: -0.02 }, cfg, NOW);
  assert.ok(out.dims.tension > state.dims.tension);
  assert.ok(out.dims.warmth < state.dims.warmth);
  assert.ok(out.applied?.tension);
});

test('mergeDeltas 会按维度求和', () => {
  const merged = mergeDeltas([{ closeness: 0.01 }, { closeness: 0.02, trust: 0.03 }, null, undefined]);
  assert.ok(merged);
  assert.equal(merged?.closeness, 0.03);
  assert.equal(merged?.trust, 0.03);
  assert.equal(mergeDeltas([null, {}]), null);
});

test('渲染成人话', () => {
  const warm = { ...baselineDims(cfg), closeness: 0.8, trust: 0.75, playfulness: 0.7 };
  const text = relationFeeling(warm, cfg);
  assert.ok(text.length > 0);
  assert.ok(text.includes('亲近'));
  const numbers = relationNumberLine(warm);
  assert.ok(numbers.includes('亲近 0.80'));
  assert.ok(affectMoodLine({ valence: 0.8, arousal: 0.8, label: '兴奋' }).length > 0);
  assert.ok(affectMoodLine(null).length > 0);
  assert.ok(openTensionLevel({ ...baselineDims(cfg), tension: 0.9 }, cfg) > 0.8);
  assert.equal(openTensionLevel(baselineDims(cfg), cfg), 0);
});

test('关系日志可追溯', () => {
  const db = new Db(':memory:');
  const s1 = getRelationState(db, cfg, NOW);
  saveRelationState(db, s1, NOW, 'first', null);
  const rows = db.all('SELECT reason FROM relation_log ORDER BY id ASC');
  assert.ok(rows.length >= 2);
  assert.equal(String(rows[0].reason), 'init');
  assert.equal(String(rows[1].reason), 'first');
  db.close();
});