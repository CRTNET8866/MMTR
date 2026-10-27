/* 稳定事实合并 + 相对日期：防止同一个人的同一件事散成碎片、防止「明年」被算成 30 天 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MMTR } from '../src/engine.ts';
import { profileThemeKey, resolveRelativeDate, detectPromise } from '../src/heuristic.ts';
import { MS_DAY, nowMs } from '../src/util.ts';

function fresh(): MMTR {
  return MMTR.open({
    patch: { dbPath: ':memory:', logLevel: 'silent', llm: { provider: 'heuristic' }, embedding: { provider: 'local' } },
  });
}

function liveCount(ag: MMTR, themeKey: string): number {
  const row = ag.db.get('SELECT COUNT(*) AS c FROM memories WHERE theme_key = ? AND valid_to IS NULL', [themeKey]);
  return row ? Number(row.c) : 0;
}

test('「明年」必须跨年，不能退回 30 天兜底', () => {
  const now = new Date(2026, 9, 25, 17, 0, 0).getTime();
  const guess = resolveRelativeDate('明年能不能陪我过生日', now);
  assert.ok(guess);
  const due = new Date(guess.dueAt);
  assert.equal(due.getFullYear(), 2027);
  assert.equal(due.getMonth(), 9);
  assert.equal(due.getDate(), 25);
});

test('「明年10月24日」落到明年的那一天', () => {
  const now = new Date(2026, 9, 25, 17, 0, 0).getTime();
  const guess = resolveRelativeDate('明年10月24日一起过生日', now);
  assert.ok(guess);
  const due = new Date(guess.dueAt);
  assert.equal(due.getFullYear(), 2027);
  assert.equal(due.getMonth(), 9);
  assert.equal(due.getDate(), 24);
  assert.equal(guess.vague, false);
});

test('「下个月」加一个月，不是加 30 天', () => {
  const now = new Date(2026, 0, 31, 12, 0, 0).getTime();
  const guess = resolveRelativeDate('下个月一起去看海', now);
  assert.ok(guess);
  const due = new Date(guess.dueAt);
  assert.equal(due.getMonth(), 2, '1 月 31 日的下个月应落到 3 月');
});

test('有承诺动词才算约定，纯日期不算', () => {
  const now = nowMs();
  assert.ok(detectPromise('说好明年一起过生日', now));
  assert.equal(detectPromise('明年十月要考试了', now), null);
});

test('生日这类稳定事实用固定主题键', () => {
  assert.equal(profileThemeKey('他昨天过生日了'), 'profile_birthday');
  assert.equal(profileThemeKey('我十八岁了'), 'profile_birthday');
  assert.equal(profileThemeKey('高三好累'), 'profile_school');
  assert.equal(profileThemeKey('今天加班到十一点'), null, '一次具体的加班是事件，不是稳定事实');
  assert.equal(profileThemeKey('我在字节上班，做后端'), null, '工作只在明确写成身份时才值得合并，这里交给普通去重');
});

test('稳定事实写进常驻块，事件照常各存一条', async () => {
  const ag = fresh();
  const now = nowMs();
  await ag.ingest({ user: '我的生日是10月24日', assistant: '噢？', at: now - 3 * MS_DAY });
  await ag.ingest({ user: '我是2008年出生的，今年满18岁', assistant: '成年了啊。', at: now - 2 * MS_DAY });
  const core = ag.getCore().find((b) => b.key === 'user');
  assert.ok(core, 'TA 是谁这块必须在');
  assert.ok(core.content.includes('生日'), '生日这类硬信息要进常驻块: ' + core.content);
  assert.ok(core.content.split('\n').length >= 1, '常驻块至少一行: ' + core.content);
  // 事件仍然各存一条：常驻块不是事件仓库
  const rows = ag.db.all('SELECT COUNT(*) AS c FROM memories WHERE valid_to IS NULL');
  assert.ok(Number(rows[0].c) >= 2);
  ag.close();
});

test('生日和年级都进常驻块，互不覆盖', async () => {
  const ag = fresh();
  const now = nowMs();
  await ag.ingest({ user: '我的生日是10月24日', assistant: '噢？', at: now - 2 * MS_DAY });
  await ag.ingest({ user: '我是高三学生，作业还没写完', assistant: '别硬撑。', at: now - 1 * MS_DAY });
  const core = ag.getCore().find((b) => b.key === 'user');
  assert.ok(core);
  assert.ok(core.content.includes('生日'), core.content);
  assert.ok(core.content.includes('高三'), core.content);
  ag.close();
});