
/* ============================================================================
 * 心情推导 (mood.ts)
 *
 * 「你此刻的心情」不是把一堆 valence 求平均。
 * 求平均的陷阱：记忆越多情绪越被稀释，攒了一百条开心记忆的她反而不开心了。
 * 取最大值的陷阱：一次极端情绪会永久绑架基调。
 *
 * 这里用两件事解决：
 *   1. 近期加权 + 分位数 —— 近 7 天占满权重，其余按时间衰减；取分位数而不是均值
 *   2. 情绪预算 —— 同一天被大量记忆同时点亮时（跨年夜、纪念日），
 *      对偏离中性的部分做饱和压缩，避免「节日情绪过冲」
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { RelationDims } from './types.ts';
import { MS_DAY, clamp, clamp01, round } from './util.ts';

export interface MoodSample {
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  /** 这条记忆当前的通道强度（0..1），用作基础权重 */
  weight: number;
  /** 记忆产生时间戳 */
  at: number;
  /** 是否由日历锚点唤醒 */
  calendar?: boolean;
}

export interface MoodEstimate {
  valence: number;
  arousal: number;
  label: string;
  samples: number;
  /** 有效情绪质量（权重之和） */
  mass: number;
  /** 是否触发过饱和压缩 */
  saturated: boolean;
}

/** 近期加权：7 天内满权，之后按 30 天半衰期回落，且有底。 */
function recencyWeight(at: number, now: number): number {
  const days = Math.max(0, (now - at) / MS_DAY);
  if (days <= 7) return 1;
  const decay = Math.pow(0.5, (days - 7) / 30);
  return clamp(decay, 0.05, 1);
}

/** 加权分位数（0..1 的分位点），输入按 value 排序。 */
function weightedQuantile(values: Array<{ value: number; weight: number }>, q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)].value;
  let acc = 0;
  const target = total * clamp01(q);
  for (const item of sorted) {
    acc += item.weight;
    if (acc >= target) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * 从一组记忆样本推导「此刻的心情」。
 *
 * @param samples 候选记忆（近期、强记忆、日历唤醒的）
 * @param relation 关系向量，用来给心情一层底色
 * @param config 配置
 * @param now 当前时间
 */
export function deriveMood(
  samples: MoodSample[],
  relation: RelationDims,
  config: MMTRConfig,
  now: number,
): MoodEstimate {
  const usable = samples.filter((s) => Number.isFinite(s.valence));
  if (usable.length === 0) {
    const base = (relation.warmth - 0.5) * 0.3 + (relation.playfulness - 0.5) * 0.1;
    return {
      valence: round(clamp(base, -0.35, 0.35), 3),
      arousal: 0.35,
      label: labelFor(base, 0.35),
      samples: 0,
      mass: 0,
      saturated: false,
    };
  }

  const budget = config.mood.emotionBudget;
  const quantile = config.mood.quantile;

  const weighted = usable.map((s) => {
    const rw = recencyWeight(s.at, now);
    const calBoost = s.calendar === true ? config.mood.calendarWeight : 1;
    return { sample: s, weight: Math.max(0.01, clamp01(s.weight)) * rw * calBoost };
  });

  const mass = weighted.reduce((sum, w) => sum + w.weight, 0);
  // 情绪预算：质量超出预算时做开方压缩，越超折扣越狠，但不会归零
  const saturation = mass <= budget ? 1 : Math.sqrt(budget / mass);

  const rawValence = weightedQuantile(
    weighted.map((w) => ({ value: w.sample.valence, weight: w.weight })),
    quantile,
  );

  let weightedArousal = 0;
  let weightSum = 0;
  for (const w of weighted) {
    weightedArousal += w.sample.arousal * w.weight;
    weightSum += w.weight;
  }
  const rawArousal = weightSum > 0 ? weightedArousal / weightSum : 0.4;

  // 关系底色：她对这些事的整体感受会轻微着色，但只占 25%
  const relationTint = (relation.warmth - 0.5) * 0.4 + (relation.closeness - 0.5) * 0.2;

  const valence = clamp(rawValence * 0.75 * saturation + relationTint * 0.25, -1, 1);
  const arousal = clamp01(rawArousal * Math.pow(saturation, 0.5));

  return {
    valence: round(valence, 3),
    arousal: round(arousal, 3),
    label: labelFor(valence, arousal),
    samples: usable.length,
    mass: round(mass, 3),
    saturated: saturation < 0.999,
  };
}

function labelFor(valence: number, arousal: number): string {
  if (valence >= 0.55) return arousal >= 0.65 ? '很亮，有点按不住' : '亮堂堂的';
  if (valence >= 0.2) return '偏暖';
  if (valence >= 0.05) return '还算舒坦';
  if (valence <= -0.55) return arousal >= 0.6 ? '心里有火' : '沉在下面';
  if (valence <= -0.2) return '有点闷';
  if (valence <= -0.05) return '淡淡的';
  return '不冷不热，挺平';
}

/** 一句话描述，供唤醒态使用。 */
export function moodLine(mood: MoodEstimate): string {
  if (mood.samples === 0) return '心情平稳，没什么特别的起伏';
  const head = '心情' + mood.label;
  if (mood.saturated) return head + '（那些事一起涌上来了，有点压不太住）';
  if (mood.samples >= 6) return head + '（但也不是只有这一件事）';
  return head;
}