import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import {
  getMemory,
  getMemories,
  insertMemory,
  invalidateMemory,
  queryMemories,
  recentlyFiredIds,
  recordActivation,
  updateMemory,
  applyImportance,
} from '../src/memory.ts';
import {
  buildDegreeMap,
  countEdges,
  decayEdges,
  edgesOf,
  edgeWeight,
  expandFromSeeds,
  hubDampingFactor,
  reinforceCoRetrieval,
  upsertEdge,
} from '../src/graph.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { MemoryRecord } from '../src/types.ts';
import { MS_DAY } from '../src/util.ts';

const cfg = DEFAULT_CONFIG;
const NOW = new Date(2026, 5, 1, 12, 0, 0).getTime();

function rec(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    owner: 'shared',
    sessionId: 's1',
    createdAt: NOW,
    eventAt: null,
    eventPrecision: 'unknown',
    level: 0,
    floorLevel: 2,
    locked: false,
    fact: '事实 ' + id,
    gist: '要点 ' + id,
    tag: 't',
    raw: null,
    rawRetained: false,
    channels: {
      fact: { strength: 0.7, updatedAt: NOW },
      gist: { strength: 0.7, updatedAt: NOW },
      affect: { strength: 0.7, updatedAt: NOW },
    },
    affect: null,
    relationDelta: null,
    importance: 0.5,
    importanceUpdatedAt: NOW,
    recallCount: 0,
    lastFiredAt: null,
    fireCount24h: 0,
    source: 'new_experience',
    readOnly: false,
    validFrom: NOW,
    validTo: null,
    invalidatedBy: null,
    calendarAnchor: null,
    dueAt: null,
    promiseState: 'none',
    tags: [],
    entities: [],
    themeKey: null,
    embeddingModel: null,
    compressionCount: 0,
    importanceLog: [],
    note: null,
    ...over,
  };
}

function freshDb(): Db {
  return new Db(':memory:');
}

test('记忆写入 / 读取 / 往返保真', () => {
  const db = freshDb();
  const m = rec('mem_a', {
    affect: { valence: 0.8, arousal: 0.6, label: '开心' },
    tags: ['跨年', '倒数'],
    entities: ['阿岚'],
    calendarAnchor: { kind: 'annual', month: 12, day: 31, label: '跨年' },
    relationDelta: { closeness: 0.02 },
  });
  insertMemory(db, m);
  const back = getMemory(db, 'mem_a');
  assert.ok(back);
  assert.equal(back?.gist, '要点 mem_a');
  assert.equal(back?.affect?.label, '开心');
  assert.deepEqual(back?.tags, ['跨年', '倒数']);
  assert.equal(back?.calendarAnchor?.month, 12);
  assert.equal(back?.relationDelta?.closeness, 0.02);
  db.close();
});

test('更新会持久化通道强度', () => {
  const db = freshDb();
  const m = rec('mem_b');
  insertMemory(db, m);
  updateMemory(db, { ...m, channels: { ...m.channels, fact: { strength: 0.123, updatedAt: NOW + 1000 } } });
  const back = getMemory(db, 'mem_b');
  assert.ok(back);
  assert.ok(Math.abs(back!.channels.fact.strength - 0.123) < 1e-9);
  assert.equal(back!.channels.fact.updatedAt, NOW + 1000);
  db.close();
});

test('queryMemories 支持过滤 / 排序 / 分页', () => {
  const db = freshDb();
  insertMemory(db, rec('m1', { importance: 0.2, owner: 'user', createdAt: NOW - 3 * MS_DAY }));
  insertMemory(db, rec('m2', { importance: 0.9, owner: 'shared', createdAt: NOW - 2 * MS_DAY }));
  insertMemory(db, rec('m3', { importance: 0.5, owner: 'self', createdAt: NOW - 1 * MS_DAY }));

  assert.equal(queryMemories(db, {}).length, 3);
  assert.equal(queryMemories(db, { minImportance: 0.5 }).length, 2);
  assert.equal(queryMemories(db, { owners: ['user'] }).length, 1);
  const byImportance = queryMemories(db, { orderBy: 'importance', order: 'desc' });
  assert.equal(byImportance[0].id, 'm2');
  const page = queryMemories(db, { limit: 1, offset: 1, order: 'desc', orderBy: 'created_at' });
  assert.equal(page.length, 1);
  assert.equal(page[0].id, 'm2');
  db.close();
});

test('失效是软删除：仍可查，但默认不再出现', () => {
  const db = freshDb();
  insertMemory(db, rec('mem_c'));
  assert.equal(queryMemories(db, {}).length, 1);
  const ok = invalidateMemory(db, 'mem_c', 'mem_x', NOW + 1000);
  assert.equal(ok, true);
  assert.equal(queryMemories(db, {}).length, 0);
  assert.equal(queryMemories(db, { includeInvalid: true }).length, 1);
  const back = getMemory(db, 'mem_c');
  assert.equal(back?.invalidatedBy, 'mem_x');
  assert.equal(back?.validTo, NOW + 1000);
  assert.equal(invalidateMemory(db, 'mem_c', 'mem_y', NOW + 2000), false, '重复失效应无效');
  db.close();
});

test('applyImportance 会写审计日志且钳制到 0..1', () => {
  const db = freshDb();
  const m = rec('mem_d', { importance: 0.4 });
  insertMemory(db, m);
  const up = applyImportance(m, { record: m, to: 1.8, by: 'retrospective', why: '用户主动提起', at: NOW + 5 });
  assert.equal(up.importance, 1);
  assert.equal(up.importanceLog.length, 1);
  assert.equal(up.importanceLog[0].by, 'retrospective');
  db.close();
});

test('激活记录 + 横向抑制窗口', () => {
  const db = freshDb();
  insertMemory(db, rec('m1'));
  recordActivation(db, { memoryId: 'm1', sessionId: 's1', turn: 0, at: NOW, kind: 'recall' });
  recordActivation(db, { memoryId: 'm1', sessionId: 's1', turn: 3, at: NOW, kind: 'recall' });
  assert.deepEqual([...recentlyFiredIds(db, 's1', 0, 0)], []);
  assert.deepEqual([...recentlyFiredIds(db, 's1', 0, 4)], ['m1']);
  assert.deepEqual([...recentlyFiredIds(db, 's1', 3, 4)], ['m1']);
  assert.deepEqual([...recentlyFiredIds(db, 'other', 0, 10)], []);
  db.close();
});

test('一条记忆可以一次取回多条', () => {
  const db = freshDb();
  insertMemory(db, rec('x1'));
  insertMemory(db, rec('x2'));
  const list = getMemories(db, ['x1', 'x2', 'nope']);
  assert.equal(list.length, 2);
  db.close();
});

test('边：同一对节点同类型只有一条，重复写入会强化', () => {
  const db = freshDb();
  insertMemory(db, rec('a'));
  insertMemory(db, rec('b'));
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'same_theme', weight: 0.3, at: NOW });
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'same_theme', weight: 0.6, at: NOW + 10 });
  assert.equal(countEdges(db), 1);
  const edge = edgesOf(db, 'a')[0];
  assert.equal(edge.w0, 0.6);
  assert.equal(edge.hits, 2);
  upsertEdge(db, { fromId: 'a', toId: 'a', type: 'same_theme', weight: 1, at: NOW });
  assert.equal(countEdges(db), 1, '自环应被忽略');
  db.close();
});

test('边权重会衰减并保留地板', () => {
  const db = freshDb();
  insertMemory(db, rec('a'));
  insertMemory(db, rec('b'));
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'temporal', weight: 0.5, at: NOW });
  const edge = edgesOf(db, 'a')[0];
  const near = edgeWeight(edge, cfg, NOW);
  const far = edgeWeight(edge, cfg, NOW + 100000 * MS_DAY);
  assert.ok(near > far, '越久越弱');
  assert.ok(far >= 0.5 * cfg.graph.edge.floorFactor - 1e-9, '不应衰减到 0');
  db.close();
});

test('枢纽阻尼随连接度下降', () => {
  assert.equal(hubDampingFactor(0), 1);
  assert.ok(hubDampingFactor(10) < hubDampingFactor(1));
  assert.ok(hubDampingFactor(1000) < hubDampingFactor(10));
});

test('扩散激活：能顺着边串成一条链', () => {
  const db = freshDb();
  for (const id of ['a', 'b', 'c', 'd']) insertMemory(db, rec(id));
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'same_theme', weight: 0.6, at: NOW });
  upsertEdge(db, { fromId: 'b', toId: 'c', type: 'same_anchor', weight: 0.6, at: NOW });
  upsertEdge(db, { fromId: 'c', toId: 'd', type: 'same_theme', weight: 0.6, at: NOW });

  const seeds = new Map([['a', 1]]);
  const one = expandFromSeeds(db, seeds, cfg, NOW, null, 1);
  assert.ok(one.nodes.has('b'), '1 跳应到 b');
  assert.ok(!one.nodes.has('c'), '1 跳不该到 c');

  const two = expandFromSeeds(db, seeds, cfg, NOW, null, 3);
  assert.ok(two.nodes.has('b'));
  assert.ok(two.nodes.has('c'), '2 跳应到 c');
  assert.ok(!two.nodes.has('d'), '3 跳在默认 minPathScore 下应已被削掉');
  assert.equal(two.nodes.get('b')?.hop, 1);
  assert.equal(two.nodes.get('c')?.hop, 2);
  db.close();
});

test('扩散激活尊重白名单（失效记忆不参与）', () => {
  const db = freshDb();
  insertMemory(db, rec('a'));
  insertMemory(db, rec('b'));
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'same_theme', weight: 0.9, at: NOW });
  const allow = new Set(['a']);
  const res = expandFromSeeds(db, new Map([['a', 1]]), cfg, NOW, allow, 2);
  assert.ok(!res.nodes.has('b'));
  db.close();
});

test('连接度统计把出入边都算上', () => {
  const db = freshDb();
  for (const id of ['a', 'b', 'c']) insertMemory(db, rec(id));
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'temporal', weight: 0.5, at: NOW });
  upsertEdge(db, { fromId: 'a', toId: 'c', type: 'temporal', weight: 0.5, at: NOW });
  const deg = buildDegreeMap(db);
  assert.equal(deg.get('a'), 2);
  assert.equal(deg.get('b'), 1);
  db.close();
});

test('共同检索会强化它们之间的边', () => {
  const db = freshDb();
  insertMemory(db, rec('a'));
  insertMemory(db, rec('b'));
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'same_theme', weight: 0.3, at: NOW });
  const before = edgesOf(db, 'a')[0].w0;
  reinforceCoRetrieval(db, ['a', 'b'], cfg, NOW);
  const after = edgesOf(db, 'a')[0].w0;
  assert.ok(after > before);
  db.close();
});

test('边衰减会清理弱边', () => {
  const db = freshDb();
  insertMemory(db, rec('a'));
  insertMemory(db, rec('b'));
  upsertEdge(db, { fromId: 'a', toId: 'b', type: 'entity', weight: 0.09, at: NOW - 1000 * MS_DAY });
  const res = decayEdges(db, cfg, NOW);
  assert.ok(res.removed >= 1);
  assert.equal(countEdges(db), 0);
  db.close();
});