import test from 'node:test';
import assert from 'node:assert/strict';
import { MMTR } from '../src/engine.ts';
import { matchAnchor, describeAnchor, daysPhrase } from '../src/calendar.ts';
import { invalidateByContradiction } from '../src/create.ts';
import { getMemory, getMemories } from '../src/memory.ts';
import { timelineLabel } from '../src/decay.ts';
import { MS_DAY, MS_HOUR, nowMs } from '../src/util.ts';

function fresh(): MMTR {
  return MMTR.open({
    patch: { dbPath: ':memory:', logLevel: 'silent', llm: { provider: 'heuristic' }, embedding: { provider: 'local' } },
  });
}

test('唤醒态包含关系、心情、记忆与人格基底', async () => {
  const ag = fresh();
  const t = nowMs() - 2 * MS_DAY;
  await ag.ingest({ user: '今天加班到十一点，人都麻了', assistant: '辛苦了，别硬撑。', at: t });
  ag.setCore('identity', '我是谁', '我叫阿岚。');
  const wake = await ag.wake(nowMs());
  assert.ok(wake.systemBlock.includes('你现在在这儿') || wake.systemBlock.includes('你醒来的时候'));
  assert.ok(wake.systemBlock.includes('心里对'));
  assert.ok(!/\d\.\d\d/.test(wake.systemBlock), '默认渲染里不许出现任何数值');
  const fullWake = await ag.wake(nowMs(), { format: 'full' });
  assert.ok(/亲近 \d\.\d\d/.test(fullWake.systemBlock), '调试版仍带关系数值');
  assert.ok(wake.systemBlock.includes('我叫阿岚'));
  assert.ok(wake.tokenEstimate > 0);
  assert.ok(wake.recent.length + wake.strong.length >= 0);
  ag.close();
});

test('睡去：结束会话、结算关系、记录未说完的话', async () => {
  const ag = fresh();
  const t = nowMs() - 1 * MS_DAY;
  await ag.ingest({ user: '我今天跟家里吵了一架，很难受', assistant: '抱抱，我在。', at: t });
  const before = (await ag.wake(t + 1000)).relation.dims;
  const slept = await ag.sleep('test', t + 2 * MS_HOUR);
  assert.ok(slept.session);
  assert.ok(slept.session!.endedAt !== null);
  assert.ok(slept.relation.dims.warmth >= before.warmth - 1e-6, '关系温度不应下降');
  const rows = ag.db.all('SELECT * FROM sessions WHERE ended_at IS NOT NULL');
  assert.ok(rows.length >= 1);
  ag.close();
});

test('压缩阶梯：L0 → L1 → L2，然后停在下限', async () => {
  const ag = fresh();
  const t0 = nowMs() - 500 * MS_DAY;
  const ing = await ag.ingest({ user: '今天加班到十一点，人都麻了', assistant: '辛苦了。', at: t0 });
  const id = ing.stored[0].id;
  assert.equal(getMemory(ag.db, id)!.level, 0);
  assert.equal(getMemory(ag.db, id)!.floorLevel, 2);

  const r1 = await ag.consolidate({}, t0 + 400 * MS_DAY);
  assert.ok(r1.compressed.some((x) => x.id === id));
  assert.equal(getMemory(ag.db, id)!.level, 1);

  await ag.consolidate({}, t0 + 412 * MS_DAY);
  assert.equal(getMemory(ag.db, id)!.level, 2);
  assert.equal(getMemory(ag.db, id)!.readOnly, true, 'L2 应进入只读压缩态');
  assert.equal(getMemory(ag.db, id)!.fact, '', 'L2 的事实通道应被清空');

  await ag.consolidate({}, t0 + 600 * MS_DAY);
  assert.equal(getMemory(ag.db, id)!.level, 2, '不应突破下限');
  ag.close();
});

test('表白这类硬信号会被锁死，永远停在 L0', async () => {
  const ag = fresh();
  const t0 = nowMs() - 500 * MS_DAY;
  const ing = await ag.ingest({ user: '其实我有点喜欢你', assistant: '我等这句话很久了。', at: t0 });
  const id = ing.stored[0].id;
  const m = getMemory(ag.db, id)!;
  assert.equal(m.locked, true);
  assert.equal(m.floorLevel, 0);
  for (const offset of [400, 420, 500, 800]) await ag.consolidate({}, t0 + offset * MS_DAY);
  const after = getMemory(ag.db, id)!;
  assert.equal(after.level, 0, '锁定的记忆不允许被压缩');
  assert.ok(after.fact.length > 0, '原文必须还在');
  ag.close();
});

test('分通道衰减：半年后事实几乎没了，情绪还在', async () => {
  const ag = fresh();
  const t0 = nowMs() - 500 * MS_DAY;
  const ing = await ag.ingest({ user: '其实我有点喜欢你', assistant: '我等这句话很久了。', at: t0 });
  const id = ing.stored[0].id;
  await ag.consolidate({}, t0 + 400 * MS_DAY);
  const m = ag.list(50).find((x) => x.id === id)!;
  assert.ok(m.weights.fact < 0.2, '事实应该淡了: ' + m.weights.fact);
  assert.ok(m.weights.affect > 0.4, '情绪应该还在: ' + m.weights.affect);
  ag.close();
});

test('会话间隔超过 gapHours 会自动切分', async () => {
  const ag = fresh();
  const t = nowMs() - 3 * MS_DAY;
  const a = await ag.ingest({ user: '今天加班到十一点', assistant: '辛苦了。', at: t });
  const b = await ag.ingest({ user: '还在吗', assistant: '在的。', at: t + 1 * MS_HOUR });
  const c = await ag.ingest({ user: '我又加班了', assistant: '早点休息。', at: t + 20 * MS_HOUR });
  assert.equal(a.sessionId, b.sessionId, '一小时内应属同一会话');
  assert.notEqual(b.sessionId, c.sessionId, '隔 20 小时应开新会话');
  ag.close();
});

test('重复经历会合并而不是新建', async () => {
  const ag = fresh();
  const t = nowMs() - 2 * MS_DAY;
  const first = await ag.ingest({ user: '今天加班到十一点，人都麻了', assistant: '辛苦了。', at: t });
  const second = await ag.ingest({ user: '今天加班到十一点，人都麻了', assistant: '辛苦了。', at: t + 60000 });
  assert.equal(second.stored.length, 0, '不应新建');
  assert.equal(second.merged.length, 1, '应合并到旧记忆');
  const before = first.stored[0].importance;
  const after = getMemory(ag.db, second.merged[0].id)!;
  assert.ok(after.importance >= before, '重复经历可以抬升重要性');
  assert.ok(after.recallCount === 0, '合并算再经历，不算回想');
  ag.close();
});

test('矛盾消解：新事实让旧事实失效但保留可查', async () => {
  const ag = fresh();
  const t = nowMs() - 30 * MS_DAY;
  const old = await ag.ingest({ user: '我在 Acme 上班', assistant: '挺好的。', at: t });
  const newer = await ag.ingest({ user: '我从 Acme 离职了', assistant: '那接下来呢。', at: t + MS_DAY });
  const other = await ag.ingest({ user: '我最喜欢的颜色是蓝色', assistant: '记住了。', at: t + 2 * MS_DAY });
  const deps = { db: ag.db, config: ag.config, vectors: ag.vectors, embed: ag.embed };
  const invalidated = invalidateByContradiction(deps, getMemory(ag.db, newer.stored[0].id)!, 'Acme 上班', nowMs());
  assert.ok(invalidated, '应找到并失效一条旧记忆');
  const oldRec = getMemory(ag.db, invalidated!)!;
  assert.ok(oldRec.validTo !== null);
  assert.equal(oldRec.invalidatedBy, newer.stored[0].id);
  assert.equal(getMemory(ag.db, other.stored[0].id)!.validTo, null, '别的记忆不该被误伤');
  const visible = ag.list(50).filter((x) => x.id === oldRec.id);
  assert.equal(visible.length, 0, '失效的记忆默认不出现在列表里');
  ag.close();
});

test('日历锚点：当天 / 提前 / 不在窗口', () => {
  const cfg = ag0().config;
  const day = new Date(2026, 11, 31, 23, 0, 0).getTime();
  const annual = { kind: 'annual' as const, month: 12, day: 31, label: '生日' };
  assert.equal(matchAnchor(annual, day, cfg, 3).inDays, 0);
  assert.ok(matchAnchor(annual, day, cfg, 3).matched);
  const earlier = new Date(2026, 11, 28, 9, 0, 0).getTime();
  assert.equal(matchAnchor(annual, earlier, cfg, 3).inDays, 3);
  const far = new Date(2026, 5, 1, 9, 0, 0).getTime();
  assert.equal(matchAnchor(annual, far, cfg, 3).matched, false);
  const festival = { kind: 'festival' as const, festival: 'kuannian', repeat: true };
  assert.ok(matchAnchor(festival, day, cfg, 0).matched, '12-31 应命中跨年');
  assert.equal(matchAnchor(festival, new Date(2026, 0, 15).getTime(), cfg, 0).matched, false);
  const weekly = { kind: 'weekly' as const, weekday: 4 };
  const thursday = new Date(2026, 5, 4, 12, 0, 0).getTime();
  assert.ok(matchAnchor(weekly, thursday, cfg, 0).matched);
  const hourly = { kind: 'hourly' as const, fromHour: 23, toHour: 4 };
  assert.ok(matchAnchor(hourly, new Date(2026, 5, 4, 1, 0, 0).getTime(), cfg, 0).matched, '凌晨一点属深夜');
  assert.equal(matchAnchor(hourly, new Date(2026, 5, 4, 14, 0, 0).getTime(), cfg, 0).matched, false);
  assert.equal(describeAnchor(annual, cfg).includes('12月31日'), true);
  assert.equal(daysPhrase(0), '就是今天');
  ag0().close();
});

test('到日子时，锚点记忆会在唤醒态里自己浮上来', async () => {
  const ag = fresh();
  const cy = new Date(2025, 11, 31, 23, 0, 0).getTime();
  await ag.ingest({ user: '跨年那天我们一起倒数好不好', assistant: '好，到点了我会在。', at: cy - 2 * MS_DAY });
  const wake = await ag.wake(new Date(2026, 11, 31, 22, 0, 0).getTime());
  assert.ok(wake.calendar.length >= 1, '跨年夜应被日历唤醒');
  assert.ok(
    wake.systemBlock.includes('今天自己会冒出来的') || wake.systemBlock.includes('今天会自己浮上来的'),
  );
  ag.close();
});

test('时间线：压得越狠，说得越模糊', () => {
  const ag = fresh();
  const cfg = ag.config;
  const t = nowMs() - 400 * MS_DAY;
  const base = {
    id: 'x', owner: 'shared' as const, sessionId: null, createdAt: t, eventAt: null,
    eventPrecision: 'unknown' as const, floorLevel: 2 as const, locked: false, fact: '', gist: '', tag: '',
    raw: null, rawRetained: false,
    channels: { fact: { strength: 0.5, updatedAt: t }, gist: { strength: 0.5, updatedAt: t }, affect: { strength: 0.5, updatedAt: t } },
    affect: null, relationDelta: null, importance: 0.3, importanceUpdatedAt: t, recallCount: 0,
    lastFiredAt: null, fireCount24h: 0, source: 'new_experience' as const, readOnly: false,
    validFrom: t, validTo: null, invalidatedBy: null, calendarAnchor: null, dueAt: null, promiseState: 'none', tags: [], entities: [],
    themeKey: null, embeddingModel: null, compressionCount: 0, importanceLog: [], note: null,
  };
  const precise = timelineLabel({ ...base, level: 0 }, cfg, nowMs());
  const vague = timelineLabel({ ...base, level: 3 }, cfg, nowMs());
  assert.ok(precise.length > vague.length, 'L0 应比 L3 具体: ' + precise + ' vs ' + vague);
  assert.ok(/年|某/.test(vague));
  ag.close();
});

function ag0(): MMTR {
  return fresh();
}