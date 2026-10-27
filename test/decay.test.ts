import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { ChannelState, MemoryRecord } from '../src/types.ts';
import {
  activateAll,
  applyActivation,
  channelWeight,
  computeWeights,
  evaluateCompression,
  floorLevelForImportance,
  levelIsFrozen,
  nextLevel,
  strengthLabel,
  toView,
} from '../src/decay.ts';
import { MS_DAY } from '../src/util.ts';

const cfg = DEFAULT_CONFIG;
const NOW = new Date(2026, 5, 1, 12, 0, 0).getTime();

function state(strength: number, updatedAt: number): ChannelState {
  return { strength, updatedAt };
}

function fakeMemory(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_test',
    owner: 'shared',
    sessionId: 's1',
    createdAt: NOW - 10 * MS_DAY,
    eventAt: null,
    eventPrecision: 'unknown',
    level: 0,
    floorLevel: 2,
    locked: false,
    fact: '事实',
    gist: '要点',
    tag: '标签',
    raw: '原文',
    rawRetained: false,
    channels: {
      fact: state(0.8, NOW - 10 * MS_DAY),
      gist: state(0.8, NOW - 10 * MS_DAY),
      affect: state(0.8, NOW - 10 * MS_DAY),
    },
    affect: null,
    relationDelta: null,
    importance: 0.5,
    importanceUpdatedAt: NOW - 10 * MS_DAY,
    recallCount: 0,
    lastFiredAt: null,
    fireCount24h: 0,
    source: 'new_experience',
    readOnly: false,
    validFrom: NOW - 10 * MS_DAY,
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

test('通道权重随时间单调下降', () => {
  const s = state(0.9, NOW);
  let prev = Infinity;
  for (const days of [0, 1, 3, 10, 30, 100, 365, 3650]) {
    const w = channelWeight(s, cfg.channels.fact, NOW + days * MS_DAY);
    assert.ok(w <= prev + 1e-9, days + ' 天');
    prev = w;
  }
});

test('分通道衰减速度不同：事实最快，情绪最慢', () => {
  const s = state(0.9, NOW);
  const later = NOW + 60 * MS_DAY;
  const fact = channelWeight(s, cfg.channels.fact, later);
  const gist = channelWeight(s, cfg.channels.gist, later);
  const affect = channelWeight(s, cfg.channels.affect, later);
  assert.ok(fact < gist, '事实应比要点掉得快: ' + fact + ' vs ' + gist);
  assert.ok(gist < affect, '要点应比情绪掉得快: ' + gist + ' vs ' + affect);
  assert.ok(affect > 0.4, '情绪半年后应仍然明显: ' + affect);
});

test('floorFactor 保证永远留底', () => {
  const s = state(1, NOW);
  const far = NOW + 100000 * MS_DAY;
  for (const key of ['fact', 'gist', 'affect'] as const) {
    const w = channelWeight(s, cfg.channels[key], far);
    assert.ok(w >= cfg.channels[key].floorFactor - 1e-9, key + ' 不应低于地板');
  }
});

test('回血：增益随被想起次数递减', () => {
  const s = state(0.3, NOW);
  const first = applyActivation(s, cfg.channels.fact, NOW, 0);
  const second = applyActivation(s, cfg.channels.fact, NOW, 5);
  const gain1 = first.strength - 0.3;
  const gain2 = second.strength - 0.3;
  assert.ok(gain1 > gain2, '第一次回血应多于第 N 次: ' + gain1 + ' vs ' + gain2);
  assert.ok(first.strength <= 1 && first.strength > 0.3);
});

test('activateAll 不动 importance', () => {
  const m = fakeMemory();
  const ch = activateAll(m, cfg, NOW, 0);
  assert.ok(ch.fact.strength > 0);
  assert.equal(m.importance, 0.5);
});

test('压缩下限映射', () => {
  assert.equal(floorLevelForImportance(0.95, cfg), 0);
  assert.equal(floorLevelForImportance(0.7, cfg), 1);
  assert.equal(floorLevelForImportance(0.45, cfg), 2);
  assert.equal(floorLevelForImportance(0.1, cfg), 3);
});

test('nextLevel 与冻结', () => {
  assert.equal(nextLevel(0), 1);
  assert.equal(nextLevel(3), 3);
  assert.equal(levelIsFrozen(1), false);
  assert.equal(levelIsFrozen(2), true);
});

test('压缩判定：锁死的不压', () => {
  const m = fakeMemory({ locked: true, importance: 0.95, floorLevel: 0 });
  const d = evaluateCompression(m, cfg, NOW, null);
  assert.equal(d.compress, false);
  assert.equal(d.reason, 'locked');
});

test('压缩判定：已到下限不压', () => {
  const m = fakeMemory({ level: 1, floorLevel: 1, channels: { fact: state(0.01, NOW - 90 * MS_DAY), gist: state(0.5, NOW), affect: state(0.5, NOW) } });
  const d = evaluateCompression(m, cfg, NOW, null);
  assert.equal(d.compress, false);
  assert.equal(d.reason, 'at-floor');
});

test('压缩判定：事实还亮着不压', () => {
  const m = fakeMemory({ channels: { fact: state(0.9, NOW), gist: state(0.9, NOW), affect: state(0.9, NOW) } });
  const d = evaluateCompression(m, cfg, NOW, null);
  assert.equal(d.compress, false);
  assert.equal(d.reason, 'fact-alive');
});

test('压缩判定：刚压过不久不压', () => {
  const m = fakeMemory({
    level: 1,
    floorLevel: 2,
    channels: { fact: state(0.01, NOW - 90 * MS_DAY), gist: state(0.4, NOW), affect: state(0.4, NOW) },
  });
  const d = evaluateCompression(m, cfg, NOW, NOW - 1 * MS_DAY);
  assert.equal(d.compress, false);
  assert.equal(d.reason, 'too-soon');
});

test('压缩判定：跌破阈值且够久则压一级', () => {
  const m = fakeMemory({ floorLevel: 2, channels: { fact: state(0.9, NOW - 400 * MS_DAY), gist: state(0.5, NOW), affect: state(0.5, NOW) } });
  const d = evaluateCompression(m, cfg, NOW, null);
  assert.equal(d.compress, true);
  assert.equal(d.from, 0);
  assert.equal(d.to, 1);
});

test('toView 附带权重与年龄', () => {
  const v = toView(fakeMemory({ level: 2, readOnly: true }), cfg, NOW);
  assert.ok(v.weights.affect > 0);
  assert.equal(v.frozen, true);
  assert.ok(v.ageDays > 9.9 && v.ageDays < 10.1);
});

test('strengthLabel 单调', () => {
  assert.equal(strengthLabel({ fact: 0, gist: 0.9, affect: 0.9 }), '清晰');
  assert.equal(strengthLabel({ fact: 0, gist: 0.05, affect: 0.05 }), '几乎忘了');
});

test('computeWeights 三通道都返回 0..1', () => {
  const w = computeWeights(fakeMemory(), cfg, NOW);
  for (const key of ['fact', 'gist', 'affect'] as const) {
    assert.ok(w[key] >= 0 && w[key] <= 1);
  }
});