import test from 'node:test';
import assert from 'node:assert/strict';
import { MMTR } from '../src/engine.ts';
import { retrieve, assembleContext } from '../src/retrieve.ts';
import { getMemory, recordActivation } from '../src/memory.ts';
import { MS_DAY, nowMs } from '../src/util.ts';

function fresh(): MMTR {
  return MMTR.open({
    patch: { dbPath: ':memory:', logLevel: 'silent', llm: { provider: 'heuristic' }, embedding: { provider: 'local' } },
  });
}

test('空库检索不报错', async () => {
  const ag = fresh();
  const res = await ag.retrieve({ text: '随便什么' });
  assert.deepEqual(res.hits, []);
  ag.close();
});

test('语义检索能命中相关记忆', async () => {
  const ag = fresh();
  const t = nowMs() - 10 * MS_DAY;
  await ag.ingest({ user: '今天加班到十一点，人都麻了', assistant: '辛苦了，别硬撑。', at: t });
  await ag.ingest({ user: '跨年那天我们一起倒数好不好', assistant: '好，到点了我会在。', at: t + 3600000 });
  const res = await ag.retrieve({ text: '加班 工作 累', topK: 5 });
  assert.ok(res.hits.length > 0);
  assert.ok(res.hits[0].memory.gist.includes('加班'), '最相关的应排第一: ' + res.hits[0].memory.gist);
  ag.close();
});

test('关键不变量：检索绝不改变 importance', async () => {
  const ag = fresh();
  const t = nowMs() - 3 * MS_DAY;
  const ing = await ag.ingest({ user: '我跟你说个事，其实我最近一直在想辞职', assistant: '你在怕什么？', at: t });
  const id = ing.stored[0].id;
  const before = getMemory(ag.db, id)!;
  for (let i = 0; i < 5; i++) await ag.retrieve({ text: '辞职 工作' });
  const after = getMemory(ag.db, id)!;
  assert.equal(after.importance, before.importance, 'importance 必须纹丝不动');
  assert.equal(after.floorLevel, before.floorLevel, '压缩下限也不能动');
  assert.ok(after.recallCount > before.recallCount, '但回想次数应该增加');
  assert.ok(after.channels.gist.strength >= before.channels.gist.strength, '通道强度应回血');
  ag.close();
});

test('importance 只能通过 reweight 手动抬升', async () => {
  const ag = fresh();
  const t = nowMs() - 2 * MS_DAY;
  const ing = await ag.ingest({ user: '今天加班到十一点', assistant: '辛苦了。', at: t });
  const id = ing.stored[0].id;
  const before = getMemory(ag.db, id)!.importance;
  const up = ag.reweight(id, 0.2, '用户三个月后又提起');
  assert.ok(up);
  assert.ok(up!.importance > before);
  assert.equal(up!.importanceLog.at(-1)?.by, 'retrospective');
  ag.close();
});

test('pin 之后永不压缩', async () => {
  const ag = fresh();
  const t = nowMs() - 2 * MS_DAY;
  const ing = await ag.ingest({ user: '今天加班到十一点', assistant: '辛苦了。', at: t });
  const id = ing.stored[0].id;
  const pinned = ag.pin(id);
  assert.ok(pinned?.locked);
  assert.equal(pinned?.floorLevel, 0);
  ag.close();
});

test('横向抑制：刚用过的记忆会被压分', async () => {
  const ag = fresh();
  const t = nowMs() - 1 * MS_DAY;
  const ing = await ag.ingest({ user: '今天加班到十一点', assistant: '辛苦了。', at: t });
  const id = ing.stored[0].id;
  const deps = { db: ag.db, config: ag.config, vectors: ag.vectors, embed: ag.embed };

  const fresh1 = await retrieve(deps, { text: '加班', topK: 3 }, nowMs(), { sessionId: 'sess', turn: 10 });
  assert.ok(fresh1.hits.some((h) => h.memory.id === id));
  assert.ok(!fresh1.hits.find((h) => h.memory.id === id)!.reasons.includes('刚用过(抑制)'));

  recordActivation(ag.db, { memoryId: id, sessionId: 'sess', turn: 0, at: nowMs(), kind: 'recall' });
  const inhibited = await retrieve(deps, { text: '加班', topK: 3 }, nowMs(), { sessionId: 'sess', turn: 5 });
  const hit = inhibited.hits.find((h) => h.memory.id === id);
  assert.ok(hit);
  assert.ok(hit!.reasons.includes('刚用过(抑制)'), '应被标记为抑制');
  ag.close();
});

test('注入块带时间线，压缩态带「细节已不可考」提示', async () => {
  const ag = fresh();
  const t = nowMs() - 200 * MS_DAY;
  await ag.ingest({ user: '今天加班到十一点，人都麻了', assistant: '辛苦了。', at: t });
  await ag.consolidate({}, nowMs() - 100 * MS_DAY);
  await ag.consolidate({}, nowMs() - 90 * MS_DAY);
  const res = await ag.retrieve({ text: '加班' });
  const frozenHit = res.hits.find((h) => h.memory.readOnly);
  assert.ok(frozenHit, '应有压缩态记忆');
  const assembled = assembleContext(res.hits, ag.config, nowMs(), { style: 'full' });
  assert.ok(assembled.block.includes('不是这一轮说的'), '必须标注不是本轮内容');
  assert.ok(assembled.block.includes('细节已不可考'), '压缩态必须有不可考提示');
  assert.ok(/· \[/.test(assembled.block), '每条都要带时间线标签');
  const quiet = assembleContext(res.hits, ag.config, nowMs(), { style: 'quiet' });
  assert.ok(quiet.block.includes('脑子里浮上来的'), '安静版有自己的抬头');
  assert.ok(!/\d+\.\d+/.test(quiet.block), '安静版不许出现任何数值');
  assert.ok(!quiet.block.includes('细节已不可考'), '安静版不摆标签');
  ag.close();
});

test('共享日历锚点的记忆会被连成一条链', async () => {
  const ag = fresh();
  const t = nowMs() - 300 * MS_DAY;
  await ag.ingest({ user: '跨年那天我们一起倒数好不好', assistant: '好。', at: t });
  await ag.ingest({ user: '又是跨年了，你还记得去年吗', assistant: '记得一点点。', at: t + 3600000 });
  const rows = ag.db.all("SELECT * FROM edges WHERE type = 'same_anchor'");
  assert.ok(rows.length >= 1, '应建立 same_anchor 边');
  ag.close();
});