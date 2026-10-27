/* ============================================================================
 * 通用工具 (util.ts)
 * ==========================================================================*/

export const MS_SECOND = 1000;
export const MS_MINUTE = 60 * MS_SECOND;
export const MS_HOUR = 60 * MS_MINUTE;
export const MS_DAY = 24 * MS_HOUR;

export function nowMs(): number {
  return Date.now();
}

export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

export function round(x: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

export function daysBetween(a: number, b: number): number {
  return (b - a) / MS_DAY;
}

export function hoursBetween(a: number, b: number): number {
  return (b - a) / MS_HOUR;
}

/** 幂律衰减核心：永远 >0，永远单调递减，永远不会到 0 以下。 */
export function powerDecay(ageInTau: number, power: number): number {
  const t = Math.max(0, ageInTau);
  return Math.pow(1 + t, -power);
}

/* ---------- 时间格式化（本地时区，不引入任何依赖） ---------- */

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function localParts(ts: number, dayStartHour = 4): LocalParts {
  // dayStartHour 让「凌晨两点」仍然归属前一天，符合人的直觉
  const d = new Date(ts - dayStartHour * MS_HOUR);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: new Date(ts).getHours(),
    minute: new Date(ts).getMinutes(),
    weekday: new Date(ts).getDay(),
  };
}

/** 逻辑日 key，例如 2026-02-03。dayStartHour 之前的时刻算前一天。 */
export function dayKey(ts: number, dayStartHour = 4): string {
  const p = localParts(ts, dayStartHour);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
}

export function formatDateTime(ts: number, dayStartHour = 4): string {
  const p = localParts(ts, dayStartHour);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + ' ' + pad2(p.hour) + ':' + pad2(p.minute);
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 把时间差说成人话。 */
export function humanDelta(fromTs: number, toTs: number): string {
  const diff = toTs - fromTs;
  if (diff < 0) {
    const up = -diff;
    if (up < MS_HOUR) return Math.max(1, Math.round(up / MS_MINUTE)) + ' 分钟后';
    if (up < MS_DAY) return Math.round(up / MS_HOUR) + ' 小时后';
    return Math.round(up / MS_DAY) + ' 天后';
  }
  if (diff < MS_MINUTE) return '刚刚';
  if (diff < MS_HOUR) return Math.round(diff / MS_MINUTE) + ' 分钟前';
  if (diff < MS_DAY) return Math.round(diff / MS_HOUR) + ' 小时前';
  const days = Math.round(diff / MS_DAY);
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days < 30) return days + ' 天前';
  const months = Math.round(days / 30);
  if (months < 12) return '大约 ' + months + ' 个月前';
  const years = Math.floor(days / 365);
  const restMonths = Math.round((days - years * 365) / 30);
  if (restMonths <= 0) return years + ' 年前';
  return years + ' 年 ' + restMonths + ' 个月前';
}

/**
 * 记忆的「模糊时间感」——压缩得越狠，系统越只敢说模糊的话。
 * 这是防止模型把检索来的旧事说成本轮刚发生的关键。
 */
export function fuzzyWhen(ts: number, level: number, dayStartHour = 4): string {
  const p = localParts(ts, dayStartHour);
  if (level <= 0) return formatDateTime(ts, dayStartHour) + ' ' + WEEKDAYS[p.weekday];
  if (level === 1) {
    return p.year + '年' + p.month + '月' + p.day + '日';
  }
  if (level === 2) {
    const days = daysBetween(ts, nowMs());
    if (days < 1) return '今天';
    if (days < 2) return '昨天';
    if (days < 8) return '这几天';
    if (days < 32) return '这个月早些时候';
    if (days < 100) return '一两个月前';
    if (days < 400) return '今年早些时候';
    return '一年多以前';
  }
  const years = Math.floor(daysBetween(ts, nowMs()) / 365);
  if (years < 1) return '某一段时间里';
  if (years === 1) return '一年多以前';
  return '好几年前';
}

/* ---------- 字符串 ---------- */

export function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function squash(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** 中文友好的粗略 token 估算：CJK 约 1.5 字/token，其他约 4 字符/token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0;
    if (
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0x3000 && cp <= 0x303f)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function uniqueStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

/* ---------- JSON ---------- */

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 从任意模型输出里挖出第一个完整的 JSON 对象。
 * 模型经常加 ```json 围栏、前后废话、尾逗号，这里一并处理。
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let s = String(text).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        const fixed = slice.replace(/,\s*([}\]])/g, '$1');
        const parsed = safeJsonParse<Record<string, unknown> | null>(fixed, null);
        if (parsed) return parsed;
        return null;
      }
    }
  }
  return null;
}

/* ---------- 哈希 / 向量 ---------- */

/** 32 位 FNV-1a，用于确定性哈希（字符 n-gram → 向量维度）。 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hashHex(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function newId(prefix = 'm'): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto && g.crypto.randomUUID ? g.crypto.randomUUID() : hashHex(String(Math.random()) + String(Date.now()));
  return prefix + '_' + uuid.replace(/-/g, '').slice(0, 20);
}

export function normalizeVector(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** 向量已归一化时就是点积。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function cosineRaw(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* ---------- 配置合并 ---------- */

export type PlainObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深合并，数组整体替换。 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;
  const out: PlainObject = { ...base };
  for (const key of Object.keys(patch)) {
    const bv = (base as PlainObject)[key];
    const pv = patch[key];
    if (isPlainObject(bv) && isPlainObject(pv)) {
      out[key] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out as T;
}

/* ---------- 日志 ---------- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export function makeLogger(level: LogLevel): (lvl: LogLevel, msg: string, extra?: unknown) => void {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const threshold = order[level] ?? 20;
  return (lvl: LogLevel, msg: string, extra?: unknown) => {
    if ((order[lvl] ?? 20) < threshold) return;
    const prefix = '[mmtr:' + lvl + '] ';
    if (extra === undefined) console.log(prefix + msg);
    else console.log(prefix + msg, extra);
  };
}
/** 把若干句子压进指定条数与字数，用于启发式压缩。 */
export function squeezeList(list: string[], maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  let budget = maxChars;
  for (const item of list) {
    if (out.length >= maxItems || budget <= 0) break;
    const s = squash(item);
    if (!s) continue;
    if (s.length <= budget) {
      out.push(s);
      budget -= s.length;
    } else {
      out.push(truncate(s, budget));
      budget = 0;
    }
  }
  if (out.length === 0) {
    const fallback = squash(list.join(' '));
    return fallback ? [truncate(fallback, maxChars)] : [];
  }
  return out;
}
/** 人自己的说法：不说时间戳，只说「今天 / 昨天 / 前几天」。 */
export function naturalWhen(ts: number, now: number, dayStartHour = 4): string {
  const a = Date.parse(dayKey(ts, dayStartHour) + 'T00:00:00Z');
  const b = Date.parse(dayKey(now, dayStartHour) + 'T00:00:00Z');
  const days = Math.round((b - a) / 86400000);
  if (!Number.isFinite(days)) return '前阵子';
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days <= 6) return '前几天';
  if (days <= 13) return '上周';
  if (days <= 31) return '这个月早些时候';
  if (days <= 120) return '前几个月';
  return '很久以前';
}
