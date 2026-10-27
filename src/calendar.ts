/* ============================================================================
 * 日历锚点 (calendar.ts)
 *
 * 记忆不只能被语义触发，还能被日历触发 —— 到了冬至，"过节"那条链自己浮上来。
 * 这是按对话轮次衰减永远做不到的能力。
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { CalendarAnchor } from './types.ts';
import { MS_DAY, clamp, daysBetween, localParts } from './util.ts';

export interface AnchorMatch {
  matched: boolean;
  /** due 锚点：约定的日子已经过去了 */
  overdue?: boolean;
  /** 距今还差几天：0 = 今天，1 = 明天 …；Infinity = 不在窗口内 */
  inDays: number;
  label: string;
  /** 0..1 的唤醒强度 */
  boost: number;
}

function festivalMonthDay(
  key: string,
  year: number,
  config: MMTRConfig,
): { month: number; day: number; label: string } | null {
  const def = config.festivals[key];
  if (!def) return null;
  const dated = def.dates ? def.dates[String(year)] : undefined;
  if (dated) {
    const m = dated.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return { month: Number(m[2]), day: Number(m[3]), label: def.label };
  }
  if (def.month && def.day) return { month: def.month, day: def.day, label: def.label };
  return null;
}

/** 某个公历日期距离「今天」还有几天（可为 0）。 */
function dayDiff(fromTs: number, targetMonth: number, targetDay: number, dayStartHour: number): number {
  const p = localParts(fromTs, dayStartHour);
  const base = new Date(p.year, p.month - 1, p.day).getTime();
  let target = new Date(p.year, targetMonth - 1, targetDay).getTime();
  if (target < base) {
    target = new Date(p.year + 1, targetMonth - 1, targetDay).getTime();
  }
  return Math.round(daysBetween(base, target));
}

export function matchAnchor(
  anchor: CalendarAnchor | null,
  now: number,
  config: MMTRConfig,
  lookaheadDays = 0,
): AnchorMatch {
  const empty: AnchorMatch = { matched: false, inDays: Infinity, label: '', boost: 0 };
  if (!anchor || anchor.kind === 'none') return empty;
  const dayStartHour = config.clock.dayStartHour;
  const p = localParts(now, dayStartHour);

  if (anchor.kind === 'annual' || anchor.kind === 'anniversary') {
    if (!anchor.month || !anchor.day) return empty;
    const diff = dayDiff(now, anchor.month, anchor.day, dayStartHour);
    if (diff > lookaheadDays) return empty;
    const isAnniversary = anchor.kind === 'anniversary' && anchor.sinceYear;
    const years = isAnniversary ? p.year - (anchor.sinceYear || p.year) : 0;
    const label =
      (anchor.label || (anchor.kind === 'anniversary' ? '纪念日' : '那个日子')) +
      (years > 0 ? '（第 ' + years + ' 年）' : '');
    return { matched: true, inDays: diff, label, boost: diff === 0 ? 1 : Math.max(0.3, 1 - diff * 0.22) };
  }

  if (anchor.kind === 'monthly') {
    if (!anchor.day) return empty;
    const diff = dayDiff(now, p.month, anchor.day, dayStartHour) % 31;
    if (diff > lookaheadDays) return empty;
    return { matched: true, inDays: diff, label: anchor.label || '每月这个时候', boost: diff === 0 ? 0.8 : 0.4 };
  }

  if (anchor.kind === 'weekly') {
    if (anchor.weekday === undefined) return empty;
    const diff = (anchor.weekday - p.weekday + 7) % 7;
    if (diff > lookaheadDays) return empty;
    return { matched: true, inDays: diff, label: anchor.label || '每周那个时候', boost: diff === 0 ? 0.7 : 0.35 };
  }

  if (anchor.kind === 'festival') {
    if (!anchor.festival) return empty;
    const resolved = festivalMonthDay(anchor.festival, p.year, config) || festivalMonthDay(anchor.festival, p.year + 1, config);
    if (!resolved) return empty;
    const diff = dayDiff(now, resolved.month, resolved.day, dayStartHour);
    if (diff > lookaheadDays) return empty;
    return {
      matched: true,
      inDays: diff,
      label: resolved.label,
      boost: diff === 0 ? 1 : Math.max(0.35, 1 - diff * 0.2),
    };
  }

  if (anchor.kind === 'due') {
    if (!anchor.dueAt) return empty;
    const days = daysBetween(now, anchor.dueAt);
    if (days > lookaheadDays) return empty;
    if (days < -Math.max(0, config.promise.graceDays)) return empty;
    const overdue = days < 0;
    return {
      matched: true,
      overdue,
      inDays: Math.max(0, Math.round(days)),
      label: anchor.label || '约好的事',
      // 到期当天最亮；过了日子仍然亮着（她还在等），直到宽限期结束
      boost: days <= 0 ? 1 : Math.max(0.35, 1 - days * 0.11),
    };
  }

  if (anchor.kind === 'hourly') {
    const from = anchor.fromHour ?? 23;
    const to = anchor.toHour ?? 4;
    const h = p.hour;
    const inside = from <= to ? h >= from && h < to : h >= from || h < to;
    if (!inside) return empty;
    return { matched: true, inDays: 0, label: anchor.label || '深夜', boost: 0.55 };
  }

  return empty;
}

/** 让人读得懂的锚点描述。 */
export function describeAnchor(anchor: CalendarAnchor | null, config: MMTRConfig): string {
  if (!anchor || anchor.kind === 'none') return '';
  if (anchor.kind === 'annual' || anchor.kind === 'anniversary') {
    return (anchor.label || '每年') + ' ' + (anchor.month || '?') + '月' + (anchor.day || '?') + '日';
  }
  if (anchor.kind === 'monthly') return (anchor.label || '每月') + ' ' + (anchor.day || '?') + '日';
  if (anchor.kind === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return anchor.label || names[anchor.weekday ?? 0];
  }
  if (anchor.kind === 'festival') {
    const def = config.festivals[anchor.festival || ''];
    return def ? def.label : anchor.festival || '节日';
  }
  if (anchor.kind === 'hourly') return anchor.label || '深夜时段';
  if (anchor.kind === 'due') return anchor.label || '约好的事';
  return '';
}

/** 把 days 折算成「还有几天」，用于唤醒态文案。 */
export function daysPhrase(inDays: number): string {
  if (inDays <= 0) return '就是今天';
  if (inDays === 1) return '明天';
  if (inDays === 2) return '后天';
  return inDays + ' 天后';
}

/** 供 consolidate 用：判断锚点是否已经「过期」（非循环锚点）。 */
export function anchorIsStale(anchor: CalendarAnchor | null, now: number): boolean {
  if (!anchor) return false;
  if (anchor.repeat !== false) return false;
  if (anchor.kind !== 'annual') return false;
  if (!anchor.month || !anchor.day) return false;
  const p = localParts(now, 4);
  const target = new Date(p.year, anchor.month - 1, anchor.day).getTime();
  return now - target > 60 * MS_DAY;
}

export function clampLookahead(days: number): number {
  return clamp(Math.round(days), 0, 60);
}