/* ============================================================================
 * MMTR · 类型契约 (types.ts)
 *
 * 这里定义系统的全部数据形状。所有模块共享这一份契约，改动必须同步文档。
 * ==========================================================================*/

/* ---------- 通道 ---------- */

/** 一条记忆由三条独立衰减的通道构成，这是本系统的核心主张。 */
export type Channel = 'fact' | 'gist' | 'affect';
export const CHANNELS: readonly Channel[] = ['fact', 'gist', 'affect'];

/** 单条通道的状态：强度 + 上次重算时间。惰性求值，读时才算。 */
export interface ChannelState {
  /** 0..1，上次重算时刻的强度。 */
  strength: number;
  /** 毫秒时间戳（真实时钟），该通道强度最后一次被重算的时刻。 */
  updatedAt: number;
}

export type ChannelWeights = Record<Channel, number>;

/* ---------- 压缩阶梯 ---------- */

/**
 * L0 原始对话 / L1 详细摘要 / L2 一句话要点 / L3 只剩标签与情绪残响。
 * 记忆只会向下降到自己的 floorLevel，绝不越界。
 */
export type MemoryLevel = 0 | 1 | 2 | 3;
export const MAX_LEVEL = 3 as MemoryLevel;

/* ---------- 归属与来源 ---------- */

/** 第一人称归属：这是「她」的经历、用户的经历，还是共同的。 */
export type Owner = 'self' | 'user' | 'shared';

/**
 * 来源标记 —— 防自增强的核心字段。
 * 只有 new_experience 才能抬升 importance；retrieved / generated 一律不能。
 */
export type MemorySource =
  | 'new_experience'
  | 'retrieved'
  | 'generated'
  | 'consolidated'
  | 'manual';

/** 故事内时间的精度。缺省 unknown，绝不允许假装精确。 */
export type TimePrecision = 'exact' | 'day' | 'month' | 'year' | 'unknown';

/* ---------- 图 ---------- */

export type EdgeType = 'same_theme' | 'temporal' | 'entity' | 'same_anchor' | 'contradicts';

/* ---------- 日历锚点 ---------- */

export type AnchorKind = 'none' | 'annual' | 'monthly' | 'weekly' | 'festival' | 'hourly' | 'due';

/**
 * 前瞻记忆（promise）的状态。
 * 未来指向的记忆 —— 约定、承诺、约好的事 —— 是唯一不随时间衰减、
 * 反而随到期临近越来越清晰的一类。
 */
export type PromiseState = 'none' | 'pending' | 'kept' | 'broken';

export interface CalendarAnchor {
  kind: AnchorKind;
  /** annual / anniversary 用 */
  month?: number;
  day?: number;
  /** weekly 用，0=周日 */
  weekday?: number;
  /** festival 用，指向 config.festivals 的 key */
  festival?: string;
  /** anniversary 用 */
  sinceYear?: number;
  /** hourly 用，深夜时段 */
  fromHour?: number;
  toHour?: number;
  /** due 用：到期时间戳（前瞻记忆自己也算一个锚点） */
  dueAt?: number;
  label?: string;
  repeat?: boolean;
}

/* ---------- 情绪 ---------- */

export interface Affect {
  /** -1..1 */
  valence: number;
  /** 0..1 */
  arousal: number;
  /** 开心 / 低落 / 暧昧 / 拌嘴 / 平静 … */
  label: string;
}

/* ---------- 关系通道 ---------- */

export const RELATION_DIMS = [
  'closeness',
  'trust',
  'playfulness',
  'warmth',
  'tension',
  'familiarity',
] as const;

export type RelationDim = (typeof RELATION_DIMS)[number];
export type RelationDims = Record<RelationDim, number>;
export type RelationDelta = Partial<RelationDims>;

export const RELATION_LABELS: Record<RelationDim, string> = {
  closeness: '亲近',
  trust: '信任',
  playfulness: '俏皮',
  warmth: '温度',
  tension: '张力',
  familiarity: '熟悉',
};

export interface RelationState {
  dims: RelationDims;
  updatedAt: number;
  revision: number;
}

/* ---------- 记忆 ---------- */

export interface ImportanceLogEntry {
  at: number;
  from: number;
  to: number;
  /** new_experience / retrospective / user_pin / system */
  by: string;
  why: string;
}

export interface MemoryRecord {
  id: string;
  owner: Owner;
  sessionId: string | null;

  /** 真实时钟：写入时刻 */
  createdAt: number;
  /** 故事内时间，可空 */
  eventAt: number | null;
  eventPrecision: TimePrecision;

  level: MemoryLevel;
  /** 压缩下限，由 importance 在写入时决定 */
  floorLevel: MemoryLevel;
  /** 锁死：永不压缩 */
  locked: boolean;

  fact: string;
  gist: string;
  tag: string;
  raw: string | null;
  /** raw 是否完整保留（仅高权重记忆为 true） */
  rawRetained: boolean;

  channels: Record<Channel, ChannelState>;

  affect: Affect | null;
  relationDelta: RelationDelta | null;

  /** 0..1，只由新经历与回溯重加权改变，检索永远不碰 */
  importance: number;
  importanceUpdatedAt: number;

  /** 与 importance 正交：只影响「想不想得起来」，不影响「重不重要」 */
  recallCount: number;
  lastFiredAt: number | null;
  fireCount24h: number;

  source: MemorySource;
  /** 压缩态默认只读，禁止被当作事实源二次抽取 */
  readOnly: boolean;

  /** 双时态：事实的有效区间 */
  validFrom: number;
  validTo: number | null;
  invalidatedBy: string | null;

  calendarAnchor: CalendarAnchor | null;
  /** 前瞻记忆：承诺/约定的到期时刻，null = 不是承诺 */
  dueAt: number | null;
  /** 前瞻记忆状态 */
  promiseState: PromiseState;
  tags: string[];
  entities: string[];
  themeKey: string | null;

  embeddingModel: string | null;

  compressionCount: number;
  importanceLog: ImportanceLogEntry[];
  note: string | null;
}

/** 带实时衰减权重的记忆视图。 */
export type MemoryView = MemoryRecord & {
  weights: ChannelWeights;
  /** 该记忆的存活天数 */
  ageDays: number;
  /** 是否已进入只读压缩态 */
  frozen: boolean;
  /** 前瞻记忆的清晰度 0..1（越接近到期越清晰，非承诺为 null） */
  promiseClarity: number | null;
};

export interface EdgeRecord {
  id: string;
  fromId: string;
  toId: string;
  type: EdgeType;
  /** 初始权重 */
  w0: number;
  /** 权重基准时刻 */
  t0: number;
  hits: number;
  createdAt: number;
}

export interface EdgeView extends EdgeRecord {
  /** 边也有权重，也会衰减 —— 抗枢纽污染 */
  weight: number;
}

/* ---------- 会话 ---------- */

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  turnCount: number;
  affect: Affect | null;
  relationBefore: RelationDims | null;
  relationAfter: RelationDims | null;
  summaryMemoryId: string | null;
  openThread: string | null;
}

/* ---------- 常驻记忆（人格基底 / 程序性记忆） ---------- */

export interface CoreBlock {
  key: string;
  title: string;
  content: string;
  updatedAt: number;
  /** 是否允许 LLM 自动改写 */
  mutable: boolean;
}

/* ---------- 抽取 ---------- */

export interface MemoryCandidate {
  remember: boolean;
  importance: number;
  owner: Owner;
  fact: string;
  gist: string;
  tag: string;
  affect: Affect | null;
  relationDelta: RelationDelta | null;
  tags: string[];
  entities: string[];
  themeKey: string | null;
  calendarAnchor: CalendarAnchor | null;
  eventAt: number | null;
  eventPrecision: TimePrecision;
  /** 前瞻记忆：这是一条约定/承诺时，到期时间戳 */
  dueAt?: number | null;
  /** 前瞻记忆状态，缺省 none */
  promiseState?: PromiseState;
  /** 与该旧记忆冲突的事实描述（由抽取器给出，用于建 contradicts 边） */
  contradicts: string | null;
  reason?: string;
}

/* ---------- 写入 ---------- */

export interface Exchange {
  user: string;
  assistant: string;
  /** 缺省 now() */
  at?: number;
  sessionId?: string | null;
  /** 用户明确说「记住这个」时为 true，直接锁 L0 */
  pin?: boolean;
}

export interface IngestOptions {
  /** 覆盖本次写入的最小重要性阈值 */
  minImportance?: number;
  /** 强制不调用 LLM */
  offline?: boolean;
}

export interface SkippedMemory {
  reason: string;
  importance: number;
  preview: string;
}

export interface IngestResult {
  stored: MemoryView[];
  /** 这一轮里被自动判定为「兑现」的约定 id */
  promisesKept?: string[];
  merged: MemoryView[];
  skipped: SkippedMemory[];
  relationDelta: RelationDelta | null;
  sessionId: string;
}

/* ---------- 检索 ---------- */

export interface RetrievalQuery {
  text: string;
  sessionId?: string | null;
  topK?: number;
  /** 只在这些 owner 里找，缺省全部 */
  owners?: Owner[];
  /** 只看某个时间之前/之后的记忆 */
  before?: number;
  after?: number;
  /** 是否做图扩散，缺省 true */
  expand?: boolean;
  /** 不参与本次检索的记忆 id */
  exclude?: string[];
}

export interface RetrievalHit {
  memory: MemoryView;
  score: number;
  similarity: number;
  /** 命中原因，便于调试与可解释性 */
  reasons: string[];
  /** 通过图扩散命中时的路径长度 */
  hop: number;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  seeds: number;
  expanded: number;
  calendarActivated: string[];
  tokensSpent: number;
}

export interface AssembledContext {
  /** 可直接拼进 prompt 的记忆块 */
  block: string;
  hits: RetrievalHit[];
  tokenEstimate: number;
}

/* ---------- 唤醒态 ---------- */

export interface WakeState {
  /** 可直接塞进 system prompt 的一段话 */
  systemBlock: string;
  relation: RelationState;
  coreBlocks: CoreBlock[];
  /** 近期想起的 */
  recent: RetrievalHit[];
  /** 被日历唤醒的 */
  calendar: RetrievalHit[];
  /** 前瞻记忆：她还在等的事 */
  promises: RetrievalHit[];
  /** 前瞻记忆的人话描述，直接渲染进唤醒态 */
  promiseLines: string[];
  /** 还没解决的张力 */
  openThreads: RetrievalHit[];
  /** 强度最高的残留 */
  strong: RetrievalHit[];
  tokenEstimate: number;
  generatedAt: number;
}

/* ---------- 巩固 ---------- */

export interface ConsolidationReport {
  ranAt: number;
  compressed: Array<{
    id: string;
    from: MemoryLevel;
    to: MemoryLevel;
    preview: string;
  }>;
  frozen: number;
  /** 这次巩固里判定「落空」的约定数 */
  promisesBroken: number;
  edgesDecayed: number;
  relationRegressed: boolean;
  calendarChecked: number;
  skippedReasons: Record<string, number>;
}

/* ---------- 统计 ---------- */

export interface StatsReport {
  total: number;
  byLevel: Record<string, number>;
  byOwner: Record<string, number>;
  bySource: Record<string, number>;
  locked: number;
  frozen: number;
  invalidated: number;
  edges: number;
  avgImportance: number;
  maxRecallCount: number;
  sessions: number;
  oldestAt: number | null;
  newestAt: number | null;
  calendarAnchored: number;
}