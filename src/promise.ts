/* ============================================================================
 * 前瞻记忆 (promise.ts)
 *
 * 记忆库里所有东西都指向过去，只有这一类指向未来：
 * 「跨年那天我们一起倒数」「等你忙完这阵我们好好聊聊」「你答应我要早点睡」。
 *
 * 它有两条跟其它记忆完全相反的规律：
 *   1. 不随时间衰减 —— 反而越贴近到期越清晰，这是全部衰减曲线的唯一例外；
 *   2. 到期那天会自己浮上来 —— 兑现了变成高权重的共同经历，落空了变成一次失望，
 *      但负面情绪消退更快，所以她会失望，然后和解。
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { CalendarAnchor, PromiseState } from './types.ts';
import { MS_DAY, clamp, clamp01, daysBetween, round } from './util.ts';

export interface PromiseInfo {
  /** 还在等 */
  pending: boolean;
  /** 约定的日子过去了 */
  overdue: boolean;
  /** 距到期还有几天；负数表示已经过了几天 */
  daysUntilDue: number;
  /** 0..1 清晰度，越贴近到期越高 —— 这就是「不衰减反而更清晰」 */
  clarity: number;
  /** 0..1 紧急度，用于排序与措辞 */
  urgency: number;
}

/**
 * 约定清晰度：离到期越近越清楚。
 *
 * - 距离 ≥ horizon 天：停在 floor（隐约记着，但还早）
 * - 0 ≤ 距离 < horizon：按幂次升高，到当天为 1
 * - 已过期（还在宽限期内）：保持 1，她正惦记着
 */
export function promiseClarity(dueAt: number, now: number, config: MMTRConfig): number {
  const cfg = config.promise;
  const days = daysBetween(now, dueAt);
  if (days <= 0) return 1;
  const horizon = Math.max(1, cfg.horizonDays);
  if (days >= horizon) return clamp01(cfg.clarityFloor);
  const t = 1 - days / horizon; // 0 → 刚进入视野，1 → 到期
  return round(clamp01(cfg.clarityFloor + (1 - clamp01(cfg.clarityFloor)) * Math.pow(t, cfg.clarityCurve)), 4);
}

export function promiseInfo(
  dueAt: number,
  state: PromiseState,
  now: number,
  config: MMTRConfig,
): PromiseInfo {
  const daysUntilDue = round(daysBetween(now, dueAt), 2);
  const clarity = state === 'pending' ? promiseClarity(dueAt, now, config) : state === 'kept' ? 0.2 : 0.35;
  const urgency =
    state !== 'pending'
      ? 0
      : daysUntilDue <= 0
        ? 1
        : clamp01(1 - daysUntilDue / Math.max(1, config.promise.horizonDays));
  return {
    pending: state === 'pending',
    overdue: state === 'pending' && daysUntilDue < 0,
    daysUntilDue,
    clarity,
    urgency,
  };
}

/** 该不该在 consolidate 里判它「落空」。 */
export function shouldBreakPromise(dueAt: number, state: PromiseState, now: number, config: MMTRConfig): boolean {
  if (state !== 'pending') return false;
  return now > dueAt + Math.max(0, config.promise.graceDays) * MS_DAY;
}

/** 该不该在这次醒来时把她叫起来看这件事。 */
export function shouldSurfacePromise(
  dueAt: number,
  state: PromiseState,
  now: number,
  config: MMTRConfig,
): boolean {
  if (state !== 'pending') return false;
  const days = daysBetween(now, dueAt);
  if (days > config.promise.surfaceLookaheadDays) return false;
  if (days < -Math.max(0, config.promise.graceDays)) return false;
  return true;
}

/** 把到期时间说成人话（给唤醒态用）。 */
export function duePhrase(dueAt: number, now: number, label: string | null): string {
  const days = daysBetween(now, dueAt);
  const what = label && label.length > 0 ? label : '约好的事';
  const abs = Math.abs(days);
  let when: string;
  if (abs < 0.05) when = '就是今天';
  else if (abs < 1) when = Math.round(abs * 24) + ' 小时' + (days > 0 ? '后' : '前');
  else if (abs < 2) when = days > 0 ? '明天' : '昨天';
  else if (abs < 30) when = Math.round(abs) + ' 天' + (days > 0 ? '后' : '前');
  else when = Math.round(abs / 30) + ' 个月' + (days > 0 ? '后' : '前');
  if (days >= 0) return what + '（' + when + '）';
  return what + '（' + when + '就该做了，还没做成）';
}

/** 承诺的日历锚点（用来走日历唤醒那条链）。 */
export function promiseAnchor(dueAt: number, label: string | null): CalendarAnchor {
  return {
    kind: 'due',
    dueAt,
    label: label || '约好的事',
    repeat: false,
  };
}

/** 关系上的后果：兑现要奖励，落空要失望（但幅度小、且张力消退更快）。 */
export function promiseRelationDelta(
  outcome: 'kept' | 'broken',
  config: MMTRConfig,
): Record<string, number> {
  const cfg = config.promise;
  if (outcome === 'kept') {
    return {
      closeness: cfg.keptCloseness,
      trust: cfg.keptTrust,
      warmth: cfg.keptWarmth,
      tension: -cfg.keptTensionRelief,
    };
  }
  return {
    trust: -cfg.brokenTrust,
    warmth: -cfg.brokenWarmth,
    tension: cfg.brokenTension,
  };
}

/** 判定「新的这一轮对话是否兑现了某条约定」的粗略文本匹配。 */
const PROMISE_STOP = /^(他|她|我|你|的|了|说|就|还|也|很|一|个|这|那|是|要|会|把|给|着|过|下|上|里|和|跟|去|来)$/;

function promiseTokens(text: string): string[] {
  const raw = String(text || '')
    .toLowerCase()
    .split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)
    .filter((x) => x.length >= 2 && !PROMISE_STOP.test(x));
  const out: string[] = [];
  for (const x of raw) if (!out.includes(x)) out.push(x);
  return out;
}

export function promiseMentionsPromise(
  promiseText: string,
  promiseTheme: string | null,
  newText: string,
): boolean {
  if (!newText) return false;
  const haystack = newText.toLowerCase();
  if (promiseTheme && promiseTheme.length >= 2 && haystack.includes(promiseTheme.toLowerCase())) return true;

  const pt = String(promiseText || '').toLowerCase();
  const probe = pt.slice(0, 8);
  if (probe.length >= 2 && haystack.includes(probe)) return true;

  // 关键词重叠 + 「已经做了」的语气：这才是日常里真正对得上的情形
  const tokens = promiseTokens(pt);
  if (tokens.length === 0) return false;
  const hit = tokens.filter((tk) => haystack.includes(tk)).length;
  const doneTone = /(告诉|说了|说了声|做了|去了|到了|发了|买了|完成|办好了|弄好了|已经|我做到了)/.test(haystack);
  if (hit >= 2) return true;
  if (doneTone && hit >= 1) return true;
  return tokens.length <= 2 && hit >= 1;
}

export function clampPromiseDays(days: number, config: MMTRConfig): number {
  return clamp(days, 1, Math.max(7, config.promise.maxHorizonDays));
}