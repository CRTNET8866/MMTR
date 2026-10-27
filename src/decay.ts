/* ============================================================================
 * 衰减与压缩阶梯引擎 (decay.ts)
 *
 * 三条独立通道：
 *   fact   事实细节 —— 走得最快
 *   gist   语义要点 —— 中间
 *   affect 情绪残响 —— 极慢，永远留底
 *
 * 公式（惰性求值，读时才算，平时一条记录都不用动）：
 *   w_c(now) = s_c × max(floorFactor_c, (1 + age_c/τ_c)^(-p_c))
 * 其中 s_c 是上次重算时刻的强度，age_c = now - t_c。
 *
 * 被想起 = 一次复习：s_c 回血，t_c 重置，但回血随次数递减、且永不抬升 importance。
 * ==========================================================================*/

import type { MMTRConfig, ChannelConfig } from './config.ts';
import type {
  Channel,
  ChannelState,
  ChannelWeights,
  MemoryLevel,
  MemoryRecord,
  MemoryView,
} from './types.ts';
import { MAX_LEVEL } from './types.ts';
import { promiseClarity, promiseInfo } from './promise.ts';
import { MS_DAY, clamp01, daysBetween, fuzzyWhen, powerDecay, round } from './util.ts';

/** 单通道当前有效权重。 */
export function channelWeight(state: ChannelState, cfg: ChannelConfig, now: number): number {
  const ageDays = Math.max(0, now - state.updatedAt) / MS_DAY;
  const ageInTau = ageDays / Math.max(0.0001, cfg.tauDays);
  const decay = powerDecay(ageInTau, cfg.power);
  const factor = Math.max(cfg.floorFactor, decay);
  return clamp01(state.strength * factor);
}

export function computeWeights(
  record: MemoryRecord,
  config: MMTRConfig,
  now: number,
): ChannelWeights {
  const raw = {
    fact: channelWeight(record.channels.fact, config.channels.fact, now),
    gist: channelWeight(record.channels.gist, config.channels.gist, now),
    affect: channelWeight(record.channels.affect, config.channels.affect, now),
  };

  // 前瞻记忆是全部衰减曲线的唯一例外：不随时间变淡，反而越贴近到期越清晰。
  // 这不是「衰减得更慢」，是「方向相反」——所以在这里直接抬高地板，
  // 而不是去调某个 tau。
  if (record.promiseState === 'pending' && record.dueAt !== null) {
    const clarity = promiseClarity(record.dueAt, now, config);
    return {
      fact: Math.max(raw.fact, 0.2 + 0.45 * clarity),
      gist: Math.max(raw.gist, 0.42 + 0.58 * clarity),
      affect: Math.max(raw.affect, 0.5 + 0.5 * clarity),
    };
  }
  if (record.promiseState === 'kept' || record.promiseState === 'broken') {
    // 兑现/落空之后回到普通记忆的规律，但「那件事本身」仍然值得留着
    return { fact: raw.fact, gist: Math.max(raw.gist, 0.4), affect: Math.max(raw.affect, 0.45) };
  }

  return raw;
}

/**
 * 复习回血。
 * damping 让第 N 次被想起的增益越来越小 —— 这是防「检索自增强」的第一道闸。
 */
export function applyActivation(
  state: ChannelState,
  cfg: ChannelConfig,
  now: number,
  recallCount: number,
  strengthScale = 1,
): ChannelState {
  const current = channelWeight(state, cfg, now);
  const damping = 1 / (1 + Math.max(0, recallCount) * 0.6);
  const boost = cfg.gain * (1 - current) * damping * strengthScale;
  const next = clamp01(Math.max(current, current + boost));
  return {
    strength: round(next, 6),
    updatedAt: now,
  };
}

export function activateAll(
  record: MemoryRecord,
  config: MMTRConfig,
  now: number,
  recallCount: number,
  affects: Partial<Record<Channel, number>> = {},
): Record<Channel, ChannelState> {
  return {
    fact: applyActivation(record.channels.fact, config.channels.fact, now, recallCount, affects.fact ?? 1),
    gist: applyActivation(record.channels.gist, config.channels.gist, now, recallCount, affects.gist ?? 1),
    affect: applyActivation(
      record.channels.affect,
      config.channels.affect,
      now,
      recallCount,
      affects.affect ?? 1,
    ),
  };
}

/* ---------- 压缩下限 ---------- */

/**
 * 写入时由 importance 一次性决定「这条记忆最多被压到哪一级」。
 * 表白那类锁死在 L0，永远不会被压缩。
 */
export function floorLevelForImportance(importance: number, config: MMTRConfig): MemoryLevel {
  const t = config.levels.floorThresholds;
  if (importance >= t.l0) return 0;
  if (importance >= t.l1) return 1;
  if (importance >= t.l2) return 2;
  return 3;
}

export function nextLevel(level: MemoryLevel): MemoryLevel {
  if (level >= MAX_LEVEL) return MAX_LEVEL;
  return (level + 1) as MemoryLevel;
}

export function levelIsFrozen(level: MemoryLevel): boolean {
  return level >= 2;
}

export function toView(record: MemoryRecord, config: MMTRConfig, now: number): MemoryView {
  const weights = computeWeights(record, config, now);
  const info = record.dueAt === null ? null : promiseInfo(record.dueAt, record.promiseState, now, config);
  return {
    ...record,
    weights,
    ageDays: round(Math.max(0, daysBetween(record.createdAt, now)), 3),
    frozen: levelIsFrozen(record.level) || record.readOnly,
    promiseClarity: record.promiseState === 'none' || info === null ? null : info.clarity,
  };
}

/* ---------- 压缩判定 ---------- */

export interface CompressionDecision {
  compress: boolean;
  from: MemoryLevel;
  to: MemoryLevel;
  reason: string;
  /** 触发时的 fact 通道权重 */
  factWeight: number;
}

/**
 * 是否该往下压一级。三条闸门：
 *   1. 已到自己的下限      → 不压
 *   2. 已锁定              → 不压
 *   3. fact 通道还够亮      → 不压
 *   4. 距上次压缩太近       → 不压（防止一次巩固任务里连环压缩）
 */
export function evaluateCompression(
  record: MemoryRecord,
  config: MMTRConfig,
  now: number,
  lastCompressAt: number | null,
): CompressionDecision {
  const from = record.level;
  const factWeight = channelWeight(record.channels.fact, config.channels.fact, now);

  if (record.locked) {
    return { compress: false, from, to: from, reason: 'locked', factWeight };
  }
  if (from >= MAX_LEVEL) {
    return { compress: false, from, to: from, reason: 'bottom', factWeight };
  }
  if (from >= record.floorLevel) {
    return { compress: false, from, to: from, reason: 'at-floor', factWeight };
  }

  const key = String(from) as '0' | '1' | '2';
  const threshold = config.levels.compressThresholds[key];
  if (factWeight >= threshold) {
    return { compress: false, from, to: from, reason: 'fact-alive', factWeight };
  }

  const minIntervalDays = config.levels.minIntervalDays[key] ?? 0;
  if (lastCompressAt !== null && daysBetween(lastCompressAt, now) < minIntervalDays) {
    return { compress: false, from, to: from, reason: 'too-soon', factWeight };
  }

  return {
    compress: true,
    from,
    to: nextLevel(from),
    reason: 'below-threshold',
    factWeight,
  };
}

/* ---------- 时间感 ---------- */

/**
 * 记忆注入 prompt 时用的时间描述。
 * 越压缩说得越模糊 —— 防止她把三个月前的事说成刚发生。
 */
export function timelineLabel(record: MemoryRecord, config: MMTRConfig, now: number): string {
  const base = record.eventAt ?? record.createdAt;
  const precision = record.eventAt ? record.eventPrecision : 'day';
  const fuzzy = fuzzyWhen(base, record.level, config.clock.dayStartHour);
  if (precision === 'unknown' && record.level >= 2) return '记不清什么时候，大概' + fuzzy;
  if (precision === 'year') return String(new Date(base).getFullYear()) + '年前后';
  if (precision === 'month') return new Date(base).getFullYear() + '年' + (new Date(base).getMonth() + 1) + '月';
  return fuzzy;
}

/** 记忆当前强度的一句话描述，用于唤醒态与调试。 */
export function strengthLabel(weights: ChannelWeights): string {
  const top = Math.max(weights.gist, weights.affect);
  if (top >= 0.75) return '清晰';
  if (top >= 0.5) return '还记得';
  if (top >= 0.3) return '模糊';
  if (top >= 0.18) return '只剩轮廓';
  return '几乎忘了';
}