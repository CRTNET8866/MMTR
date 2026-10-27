import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01,
  cosine,
  dayKey,
  deepMerge,
  estimateTokens,
  extractJsonObject,
  humanDelta,
  normalizeVector,
  powerDecay,
  squeezeList,
  truncate,
  MS_DAY,
  MS_HOUR,
} from '../src/util.ts';

test('clamp01 边界', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(Number.NaN), 0);
});

test('truncate 会加省略号且不超长', () => {
  assert.equal(truncate('你好世界', 10), '你好世界');
  const cut = truncate('你好世界你好世界', 5);
  assert.equal(cut.length, 5);
  assert.ok(cut.endsWith('…'));
});

test('powerDecay 单调递减且恒为正', () => {
  let prev = Infinity;
  for (let age = 0; age < 200; age += 7) {
    const v = powerDecay(age, 0.9);
    assert.ok(v > 0, 'age=' + age);
    assert.ok(v < prev, 'age=' + age + ' 应比上一档更小');
    prev = v;
  }
});

test('estimateTokens 对中文与英文都给正数', () => {
  assert.ok(estimateTokens('这是一句中文') > 0);
  assert.ok(estimateTokens('hello world') > 0);
  assert.equal(estimateTokens(''), 0);
});

test('extractJsonObject 能穿过围栏与尾逗号', () => {
  const raw = '好的，这是结果：\n```json\n{"a":1,"b":[1,2,],}\n```\n希望有用';
  const parsed = extractJsonObject(raw);
  assert.ok(parsed);
  assert.equal(parsed?.a, 1);
  assert.deepEqual(parsed?.b, [1, 2]);
});

test('extractJsonObject 对坏输入返回 null', () => {
  assert.equal(extractJsonObject('完全没有 JSON'), null);
  assert.equal(extractJsonObject('{"a":1'), null);
});

test('normalizeVector + cosine 自相似为 1', () => {
  const v = normalizeVector(Float32Array.from([3, 4, 0]));
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  const w = normalizeVector(Float32Array.from([0, 0, 5]));
  assert.ok(Math.abs(cosine(v, w)) < 1e-6, '正交向量余弦应为 0');
  const same = normalizeVector(Float32Array.from([6, 8, 0]));
  assert.ok(Math.abs(cosine(v, same) - 1) < 1e-6, '同向向量余弦应为 1');
});

test('deepMerge 深合并且数组整体替换', () => {
  const base = { a: 1, b: { c: 2, d: 3 }, arr: [1, 2] };
  const out = deepMerge(base, { b: { c: 9 }, arr: [7] });
  assert.equal(out.a, 1);
  assert.equal(out.b.c, 9);
  assert.equal(out.b.d, 3);
  assert.deepEqual(out.arr, [7]);
});

test('squeezeList 遵守预算', () => {
  const out = squeezeList(['一二三四五', '六七八九十'], 2, 6);
  assert.equal(out.length, 2, '第二条应被截断而不是丢弃');
  const total = out.join('').length;
  assert.ok(total <= 7, '总长度应受预算约束: ' + total);
});

test('dayKey：凌晨两点算作前一个逻辑日', () => {
  const night = new Date(2026, 0, 2, 2, 0, 0).getTime();
  const morning = new Date(2026, 0, 2, 10, 0, 0).getTime();
  assert.equal(dayKey(night, 4), '2026-01-01', '凌晨两点属于前一天');
  assert.equal(dayKey(morning, 4), '2026-01-02');
  assert.equal(dayKey(night, 0), '2026-01-02', 'dayStartHour=0 时不跨日');
});

test('humanDelta 说人话', () => {
  const base = new Date(2026, 5, 10, 12, 0, 0).getTime();
  assert.equal(humanDelta(base, base + 30 * 1000), '刚刚');
  assert.equal(humanDelta(base, base + 3 * MS_HOUR), '3 小时前');
  assert.equal(humanDelta(base, base + MS_DAY), '昨天');
  assert.ok(humanDelta(base, base + 200 * MS_DAY).includes('个月'));
});