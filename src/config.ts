/* ============================================================================
 * 配置 (config.ts)
 *
 * 所有行为参数集中在这里。写进 mmtr.config.json 的部分会深合并覆盖默认值。
 * 参数含义见 docs/01-开发文档.md 的「参数速查表」。
 * ==========================================================================*/

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { deepMerge, makeLogger, type LogLevel } from './util.ts';
import type { Channel } from './types.ts';

export interface ChannelConfig {
  /** 衰减时间尺度（天）。越大衰减越慢。 */
  tauDays: number;
  /** 幂律指数。越大前期掉得越快。 */
  power: number;
  /** 永远褪不掉的残余比例（0..1）。 */
  floorFactor: number;
  /** 被想起时的回血增益（0..1）。 */
  gain: number;
}

export interface FestivalDef {
  label: string;
  /** 公历固定日期 */
  month?: number;
  day?: number;
  /** 农历类节日：按年份给出公历日期，例如 {"2026":"2026-02-17"} */
  dates?: Record<string, string>;
}

export interface MMTRConfig {
  /** SQLite 文件路径。相对路径基于配置文件所在目录。 */
  dbPath: string;
  logLevel: LogLevel;
  clock: {
    /** 逻辑日的分界小时。默认 4 点，让「聊到凌晨两点」仍属同一天。 */
    dayStartHour: number;
  };
  llm: {
    provider: 'heuristic' | 'deepseek' | 'openai-compatible';
    baseUrl: string;
    apiKeyEnv: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    jsonMode: boolean;
    enableScoring: boolean;
    enableCompression: boolean;
    enableSessionAffect: boolean;
  };
  embedding: {
    provider: 'local' | 'openai-compatible' | 'none';
    baseUrl: string;
    apiKeyEnv: string;
    apiKey: string;
    model: string;
    dim: number;
    timeoutMs: number;
    /** 批量请求条数 */
    batchSize: number;
  };
  write: {
    /** 低于此值不写入数据库 —— 「我刚才上了个厕所」就该被丢掉 */
    minImportance: number;
    /** 高于此值直接锁死原文 */
    lockImportance: number;
    /** 高于此值完整保留原文 */
    rawRetainMin: number;
    /** 单轮对话最多产出几条记忆 */
    maxCandidatesPerExchange: number;
    /** 去重相似度阈值 */
    dedupSimilarity: number;
    /** 去重时间窗（天） */
    dedupWindowDays: number;
    /** 用户说了「记住」时直接置为锁定的重要度 */
    pinImportance: number;
  };
  levels: {
    /** importance → 压缩下限的记忆档位分界 */
    floorThresholds: { l0: number; l1: number; l2: number };
    /** 各档位触发下一级压缩的 fact 通道阈值 */
    compressThresholds: Record<'0' | '1' | '2', number>;
    /** 相邻两级压缩之间的最小间隔（天），防止一次巩固任务里连环压缩 */
    minIntervalDays: Record<'0' | '1' | '2', number>;
    /** 压缩后 fact 通道强度的保留系数（再巩固会轻微损伤） */
    perStepStrengthFactor: number;
  };
  channels: Record<Channel, ChannelConfig>;
  graph: {
    maxHops: number;
    maxExpanded: number;
    minPathScore: number;
    hubDamping: boolean;
    /** 每跳的通用衰减 */
    hopDecay: number;
    edge: {
      tauDays: number;
      power: number;
      initialMin: number;
      initialMax: number;
      reinforce: number;
      floorFactor: number;
      pruneBelow: number;
    };
    link: {
      themeSimMin: number;
      themeTopK: number;
      temporalWindowHours: number;
      entityMax: number;
      anchorTopK: number;
    };
  };
  retrieval: {
    vectorTopK: number;
    finalTopK: number;
    weights: {
      similarity: number;
      gist: number;
      fact: number;
      affect: number;
      importance: number;
      calendar: number;
      theme: number;
    };
    penaltys: {
      /** 最近几轮刚用过的记忆降权，避免同一段记忆霸占每次对话 */
      lateralInhibition: number;
      /** 只读压缩态轻微降权（信息少，别占位置） */
      readOnly: number;
      /** 内容冗余降权（MMR 用） */
      redundant: number;
    };
    lateralWindowTurns: number;
    mmrLambda: number;
    maxContextMemories: number;
    /** 组装 prompt 时的记忆块字符上限 */
    maxContextChars: number;
  };
  relation: {
    dims: Record<'closeness' | 'trust' | 'playfulness' | 'warmth' | 'tension' | 'familiarity', number>;
    ceiling: number;
    /** 单次会话单个维度最大变化量，防人格跳变 */
    maxDeltaPerSession: number;
    /** 变化率递减系数：越接近上限，同样的互动推动越小 */
    rateLimitFactor: number;
    /** 向基线回归的半衰期（天）；tension 单独更快 */
    regressionHalfLifeDays: number;
    tensionHalfLifeDays: number;
  };
  session: {
    wakeRecentHours: number;
    wakeCalendarLookaheadDays: number;
    wakeStrongCount: number;
    wakeOpenThreads: number;
    /** 距上次对话超过这么多小时，自动结束旧会话并结算关系 */
    gapHours: number;
    /** 至少聊这么多轮才生成会话摘要记忆，避免单句会话产生噪音 */
    minTurnsToSummarize: number;
    /** 每次 sleep 都生成一条会话记忆 */
    alwaysSummarize: boolean;
  };
  consolidation: {
    enabled: boolean;
    maxCompressionsPerRun: number;
    relationRegression: boolean;
    edgeDecay: boolean;
    calendarRefresh: boolean;
  };
  /** 前瞻记忆（约定/承诺）参数 */
  promise: {
    /** 进入「越来越清晰」区间的天数：离到期还有这么多天时开始爬升 */
    horizonDays: number;
    /** 距离很远时的清晰度地板 */
    clarityFloor: number;
    /** 爬升曲线的幂次，越大越晚才想起 */
    clarityCurve: number;
    /** 到期前几天开始在唤醒态里提出来 */
    surfaceLookaheadDays: number;
    /** 过期多少天后判定落空（给对方留的余地） */
    graceDays: number;
    /** 没有具体日期的约定，默认给多少天的观察期 */
    defaultDays: number;
    /** 允许的最远到期天数 */
    maxHorizonDays: number;
    /** 兑现的关系奖励 */
    keptCloseness: number;
    keptTrust: number;
    keptWarmth: number;
    keptTensionRelief: number;
    /** 落空的关系代价 */
    brokenTrust: number;
    brokenWarmth: number;
    brokenTension: number;
  };
  /** 心情推导参数（近期加权 + 分位数 + 情绪预算） */
  mood: {
    /** 取哪个分位数作为基调，0.65 = 偏乐观但不被单条极端绑架 */
    quantile: number;
    /** 情绪预算：有效情绪质量超过此值时做饱和压缩，防止节日过冲 */
    emotionBudget: number;
    /** 日历唤醒的记忆在心情里额外乘的权重 */
    calendarWeight: number;
  };
  wake: {
    personaName: string;
    userName: string;
    /** 唤醒态里最多列几条「隐约记得」 */
    maxRecallLines: number;
  };
  festivals: Record<string, FestivalDef>;
}

export const DEFAULT_CONFIG: MMTRConfig = {
  dbPath: './data/mmtr.db',
  logLevel: 'info',
  clock: {
    dayStartHour: 4,
  },
  llm: {
    provider: 'heuristic',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'MMTR_API_KEY',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 1600,
    timeoutMs: 45000,
    jsonMode: true,
    enableScoring: true,
    enableCompression: true,
    enableSessionAffect: true,
  },
  embedding: {
    provider: 'local',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'EMBEDDING_API_KEY',
    apiKey: '',
    model: 'BAAI/bge-m3',
    dim: 512,
    timeoutMs: 30000,
    batchSize: 16,
  },
  write: {
    minImportance: 0.18,
    lockImportance: 0.9,
    rawRetainMin: 0.68,
    maxCandidatesPerExchange: 3,
    dedupSimilarity: 0.93,
    dedupWindowDays: 7,
    pinImportance: 1,
  },
  levels: {
    floorThresholds: { l0: 0.9, l1: 0.62, l2: 0.38 },
    compressThresholds: { '0': 0.42, '1': 0.18, '2': 0.07 },
    minIntervalDays: { '0': 1, '1': 7, '2': 30 },
    perStepStrengthFactor: 0.9,
  },
  channels: {
    fact: { tauDays: 4, power: 0.9, floorFactor: 0.02, gain: 0.55 },
    gist: { tauDays: 12, power: 0.75, floorFactor: 0.12, gain: 0.4 },
    affect: { tauDays: 180, power: 0.28, floorFactor: 0.55, gain: 0.22 },
  },
  graph: {
    maxHops: 2,
    maxExpanded: 64,
    minPathScore: 0.035,
    hubDamping: true,
    hopDecay: 0.85,
    edge: {
      tauDays: 180,
      power: 0.5,
      initialMin: 0.2,
      initialMax: 0.65,
      reinforce: 0.08,
      floorFactor: 0.2,
      /** 低于此权重且只被用过一次的边直接清掉 */
      pruneBelow: 0.08,
    },
    link: {
      themeSimMin: 0.6,
      themeTopK: 3,
      temporalWindowHours: 8,
      entityMax: 4,
      anchorTopK: 2,
    },
  },
  retrieval: {
    vectorTopK: 24,
    finalTopK: 8,
    weights: {
      similarity: 0.42,
      gist: 0.18,
      fact: 0.08,
      affect: 0.14,
      importance: 0.1,
      calendar: 0.12,
      theme: 0.08,
    },
    penaltys: {
      lateralInhibition: 0.18,
      readOnly: 0.04,
      redundant: 0.25,
    },
    lateralWindowTurns: 6,
    mmrLambda: 0.72,
    maxContextMemories: 8,
    maxContextChars: 2400,
  },
  relation: {
    dims: {
      closeness: 0.28,
      trust: 0.3,
      playfulness: 0.35,
      warmth: 0.32,
      tension: 0.1,
      familiarity: 0.25,
    },
    ceiling: 0.95,
    maxDeltaPerSession: 0.06,
    rateLimitFactor: 0.55,
    regressionHalfLifeDays: 21,
    tensionHalfLifeDays: 4,
  },
  session: {
    wakeRecentHours: 36,
    wakeCalendarLookaheadDays: 3,
    wakeStrongCount: 4,
    wakeOpenThreads: 3,
    gapHours: 6,
    minTurnsToSummarize: 2,
    alwaysSummarize: true,
  },
  consolidation: {
    enabled: true,
    maxCompressionsPerRun: 200,
    relationRegression: true,
    edgeDecay: true,
    calendarRefresh: true,
  },
  promise: {
    horizonDays: 45,
    clarityFloor: 0.42,
    clarityCurve: 1.25,
    surfaceLookaheadDays: 7,
    graceDays: 3,
    defaultDays: 30,
    maxHorizonDays: 400,
    keptCloseness: 0.03,
    keptTrust: 0.02,
    keptWarmth: 0.025,
    keptTensionRelief: 0.02,
    brokenTrust: 0.012,
    brokenWarmth: 0.01,
    brokenTension: 0.018,
  },
  mood: {
    quantile: 0.65,
    emotionBudget: 6,
    calendarWeight: 1.35,
  },
  wake: {
    personaName: '她',
    userName: 'TA',
    maxRecallLines: 6,
  },
  festivals: {
    yuandan: { label: '元旦', month: 1, day: 1 },
    qingren: { label: '情人节', month: 2, day: 14 },
    laodong: { label: '劳动节', month: 5, day: 1 },
    ertong: { label: '儿童节', month: 6, day: 1 },
    guoqing: { label: '国庆', month: 10, day: 1 },
    pinganye: { label: '平安夜', month: 12, day: 24 },
    shengdan: { label: '圣诞', month: 12, day: 25 },
    kuannian: { label: '跨年', month: 12, day: 31 },
    chunjie: { label: '春节', dates: {} },
    yuanxiao: { label: '元宵', dates: {} },
    duanwu: { label: '端午', dates: {} },
    qixi: { label: '七夕', dates: {} },
    zhongqiu: { label: '中秋', dates: {} },
  },
};

export interface LoadConfigOptions {
  /** 显式指定配置文件路径 */
  configPath?: string;
  /** 直接覆盖的补丁（优先级最高） */
  patch?: Record<string, unknown>;
  /** 调用方 cwd，用于解析相对 dbPath */
  cwd?: string;
}

export interface ResolvedConfig {
  config: MMTRConfig;
  configDir: string;
  resolvedDbPath: string;
}

const CONFIG_FILENAMES = ['mmtr.config.json', 'mmtr.config.jsonc'];

export function findConfigFile(cwd: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const cwd = options.cwd || process.cwd();
  const configPath = options.configPath || findConfigFile(cwd);
  let merged: MMTRConfig = DEFAULT_CONFIG;
  let configDir = configPath ? dirname(configPath) : cwd;

  if (configPath && existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    const text = configPath.endsWith('.jsonc') ? stripJsonComments(raw) : raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error('配置文件解析失败: ' + configPath + ' -> ' + (err as Error).message);
    }
    merged = deepMerge(merged, parsed);
  }

  if (options.patch) {
    merged = deepMerge(merged, options.patch);
  }

  // 环境变量兜底
  if (!merged.llm.apiKey) {
    const env = process.env[merged.llm.apiKeyEnv];
    if (env) merged.llm.apiKey = env;
  }
  if (!merged.embedding.apiKey) {
    const env = process.env[merged.embedding.apiKeyEnv];
    if (env) merged.embedding.apiKey = env;
  }

  // SQLite 的特殊路径不能被 resolve，否则 :memory: 会变成真实文件名
  const special = [":memory:", ""].includes(merged.dbPath) || merged.dbPath.startsWith("file:");
  const resolvedDbPath = special ? merged.dbPath : resolve(configDir, merged.dbPath);
  return { config: merged, configDir, resolvedDbPath };
}

export function logger(config: MMTRConfig): (lvl: LogLevel, msg: string, extra?: unknown) => void {
  return makeLogger(config.logLevel);
}