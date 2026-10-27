import test from 'node:test';
import assert from 'node:assert/strict';
import { MMTR } from '../src/engine.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { promiseClarity, promiseInfo, shouldBreakPromise, shouldSurfacePromise, duePhrase, promiseMentionsPromise } from '../src/promise.ts';
import { computeWeights, toView } from '../src/decay.ts';
import { detectPromise } from '../src/heuristic.ts';
import { getMemory } from '../src/memory.ts';
import { MS_DAY, nowMs } from '../src/util.ts';

const cfg = DEFAULT_CONFIG;
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();

function fresh(): MMTR {
  return MMTR.open({
    patch: { dbPath: ':memory:', logLevel: 'silent', llm: { provider: 'heuristic' }, embedding: { provider: 'local' } },
  });
}

test('约定清晰度：越贴近到期越清晰，这是唯一方向相反的曲线', () => {
  const due = NOW + 40 * MS_DAY;
  const far = promiseClarity(due, NOW, cfg);
  const mid = promiseClarity(due, NOW + 20 * MS_DAY, cfg);
  const near = promiseClarity(due, NOW + 39 * MS_DAY, cfg);
  const onDay = promiseClarity(due, due, cfg);
  assert.ok(far <= mid, `远 ${far} 应 ≤ 中 ${mid}`);
  assert.ok(mid < near, `中 ${mid} 应 < 近 ${near}`);
  assert.ok(near <= onDay, `近 ${near} 应 ≤ 当天 ${onDay}`);
  assert.equal(onDay, 1);
  assert.ok(far >= cfg.promise.clarityFloor - 1e-9, '再远也不会掉到 0');
});

test('普通记忆会衰减，约定反而变清楚', () => {
  const due = NOW + 30 * MS_DAY;
  const base = {
    id: 'm', owner: 'shared', sessionId: null, createdAt: NOW, eventAt: null, eventPrecision: 'unknown',
    level: 0, floorLevel: 0, locked: true, fact: 'f', gist: 'g', tag: 'tag', raw: null, rawRetained: false,
    channels: { fact: { strength: 0.5, updatedAt: NOW }, gist: { strength: 0.5, updatedAt: NOW }, affect: { strength: 0.5, updatedAt: NOW } },
    affect: null, relationDelta: null, importance: 0.9, importanceUpdatedAt: NOW, recallCount: 0,
    lastFiredAt: null, fireCount24h: 0, source: 'new_experience', readOnly: false,
    validFrom: NOW, validTo: null, invalidatedBy: null, calendarAnchor: null,
    tags: [], entities: [], themeKey: null, embeddingModel: null, compressionCount: 0, importanceLog: [], note: null,
  };
  const plain = { ...base, id: 'plain', dueAt: null, promiseState: 'none' };
  const promise = { ...base, id: 'promise', dueAt: due, promiseState: 'pending' };

  const plainLater = computeWeights(plain, cfg, NOW + 20 * MS_DAY).gist;
  const plainNow = computeWeights(plain, cfg, NOW).gist;
  assert.ok(plainLater < plainNow, '普通记忆随时间变淡');

  const promiseNow = computeWeights(promise, cfg, NOW).gist;
  const promiseLater = computeWeights(promise, cfg, NOW + 20 * MS_DAY).gist;
  assert.ok(promiseLater > promiseNow, '约定随时间变清楚: ' + promiseNow + ' → ' + promiseLater);
  assert.ok(promiseLater > plainLater, '同一时刻约定比普通记忆亮');
});

test('到期的判定与唤醒窗口', () => {
  const due = NOW + 2 * MS_DAY;
  assert.equal(shouldSurfacePromise(due, 'pending', NOW, cfg), true, '2 天后到期，该提了');
  assert.equal(shouldSurfacePromise(due, 'pending', NOW - 60 * MS_DAY, cfg), false, '还早，不提');
  assert.equal(shouldSurfacePromise(due, 'kept', NOW, cfg), false, '兑现过就不提了');
  assert.equal(shouldBreakPromise(due, 'pending', due + 10 * MS_DAY, cfg), true, '过期超过宽限期，判落空');
  assert.equal(shouldBreakPromise(due, 'pending', due, cfg), false, '当天不算落空');
  assert.equal(shouldBreakPromise(due, 'kept', due + 10 * MS_DAY, cfg), false);
});

test('到期说人话', () => {
  const due = NOW + 3 * MS_DAY;
  assert.ok(duePhrase(due, NOW, '跨年一起倒数').includes('跨年一起倒数'));
  assert.ok(duePhrase(due, NOW, '跨年一起倒数').includes('3 天'));
  assert.ok(duePhrase(NOW - 2 * MS_DAY, NOW, '一起吃饭').includes('还没做成'));
});

test('承诺文本匹配', () => {
  assert.equal(promiseMentionsPromise('下周三我请你吃饭', null, '下周三我请你吃饭那事，今天就去'), true);
  assert.equal(promiseMentionsPromise('下周三我请你吃饭', null, '今天天气不错'), false);
  assert.equal(promiseMentionsPromise('', '吃饭', '我们去吃饭吧'), true);
});

test('启发式能认出约定', () => {
  const p1 = detectPromise('跨年那天我们一起倒数好不好', NOW);
  assert.ok(p1);
  assert.equal(new Date(p1!.dueAt).getMonth(), 11);
  const p2 = detectPromise('下周三我请你吃饭', NOW);
  assert.ok(p2 && !p2.vague);
  const p3 = detectPromise('今天加班到十一点', NOW);
  assert.equal(p3, null, '日常琐事不是约定');
  const p4 = detectPromise('我答应你，以后不熬夜了', NOW);
  assert.ok(p4 && p4.vague, '文字上认得出是承诺，但没日子');
  const p5 = detectPromise('答应你，明年生日我第一个开口', NOW);
  assert.ok(p5 && !p5.vague, '有日子的才算真约定');
});

test('承诺一律锁死在 L0，永不压缩', async () => {
  const ag = fresh();
  const t = nowMs() - 30 * MS_DAY;
  const r = await ag.ingest({ user: '下周三我请你吃饭', assistant: '好啊，我记着了。', at: t });
  assert.equal(r.stored.length, 1);
  const m = getMemory(ag.db, r.stored[0].id)!;
  assert.equal(m.promiseState, 'pending');
  assert.ok(m.dueAt !== null);
  assert.equal(m.locked, true, '承诺必须锁死');
  assert.equal(m.floorLevel, 0);
  // 一年后巩固，它仍然是 L0
  for (const offset of [400, 500, 700]) await ag.consolidate({}, t + offset * MS_DAY);
  assert.equal(getMemory(ag.db, m.id)!.level, 0, '承诺不允许被压缩');
  assert.ok(getMemory(ag.db, m.id)!.gist.length > 0);
  ag.close();
});

test('唤醒态里有「还欠着的」一段', async () => {
  const ag = fresh();
  const t = nowMs();
  const r = await ag.ingest({ user: '下周三我请你吃饭', assistant: '记着了。', at: t });
  const due = getMemory(ag.db, r.stored[0].id)!.dueAt!;
  const wake = await ag.wake(due - 2 * MS_DAY);
  assert.ok(wake.promiseLines.length >= 1, '应列出在等的约定');
  assert.ok(wake.systemBlock.includes('还欠着的') || wake.systemBlock.includes('你还在等的事'));
  assert.ok(wake.promises.length >= 1);
  ag.close();
});

test('过期没兑现 → 巩固时判落空，关系有代价但不大', async () => {
  const ag = fresh();
  const t = nowMs() - 40 * MS_DAY;
  const r = await ag.ingest({ user: '下周三我请你吃饭', assistant: '记着了。', at: t });
  const id = r.stored[0].id;
  const due = getMemory(ag.db, id)!.dueAt!;
  const before = (await ag.wake(t + 1000)).relation.dims.trust;
  const report = await ag.consolidate({}, due + 10 * MS_DAY);
  assert.equal(report.promisesBroken, 1);
  assert.equal(getMemory(ag.db, id)!.promiseState, 'broken');
  const after = (await ag.wake(due + 11 * MS_DAY)).relation.dims.trust;
  assert.ok(after <= before + 1e-6, '落空会让信任略微下降');
  ag.close();
});

test('兑现 → 关系奖励，重要性也抬升', async () => {
  const ag = fresh();
  const t = nowMs();
  const r = await ag.ingest({ user: '下周三我请你吃饭', assistant: '记着了。', at: t });
  const id = r.stored[0].id;
  const before = getMemory(ag.db, id)!.importance;
  const beforeCloseness = (await ag.wake(t + 1000)).relation.dims.closeness;
  const view = ag.resolvePromise(id, 'kept');
  assert.ok(view);
  assert.equal(view!.promiseState, 'kept');
  assert.ok(view!.importance > before);
  const afterCloseness = (await ag.wake(t + 2000)).relation.dims.closeness;
  assert.ok(afterCloseness > beforeCloseness, '兑现会让关系更近');
  ag.close();
});

test('说到做到了会自动结算', async () => {
  const ag = fresh();
  const t = nowMs();
  const r = await ag.ingest({ user: '下周三我请你吃饭', assistant: '记着了。', at: t });
  const id = r.stored[0].id;
  const due = getMemory(ag.db, id)!.dueAt!;
  const followUp = await ag.ingest({
    user: '下周三我请你吃饭那事，我们现在就去吧',
    assistant: '走，本鱼饿了。',
    at: due,
  });
  assert.ok((followUp.promisesKept || []).includes(id), '应自动判定兑现');
  assert.equal(getMemory(ag.db, id)!.promiseState, 'kept');
  ag.close();
});