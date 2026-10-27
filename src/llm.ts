/* ============================================================================
 * 大脑层 (llm.ts)
 *
 * Brain 是「判断与生成」的统一接口，有两个实现：
 *   LLMBrain       —— 走 chat 接口（DeepSeek / 任何 OpenAI 兼容服务）
 *   HeuristicBrain —— 纯规则，离线可跑
 * LLMBrain 在每次调用失败或返回不可解析时会自动降级到 HeuristicBrain，
 * 保证系统永不因为模型抖动而丢记忆。
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type {
  Affect,
  CalendarAnchor,
  Channel,
  MemoryCandidate,
  MemoryLevel,
  Owner,
  RelationDelta,
  TimePrecision,
} from './types.ts';
import { RELATION_DIMS } from './types.ts';
import { clamp, clamp01, extractJsonObject, round, truncate, uniqueStrings } from './util.ts';
import {
  detectAnchor,
  detectPromise,
  normalizeTag,
  profileThemeKey,
  resolveRelativeDate,
  estimateAffect,
  estimateImportance,
  estimateRelationDelta,
  extractEntities,
  extractTags,
  guessOwner,
  guessTheme,
  heuristicCompress,
  inferEventTime,
  summarizeSession,
} from './heuristic.ts';

/* ---------- chat 客户端 ---------- */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export class ChatClient {
  private config: MMTRConfig;
  readonly name: string;

  constructor(config: MMTRConfig) {
    this.config = config;
    this.name = config.llm.provider + ':' + config.llm.model;
  }

  get available(): boolean {
    return this.config.llm.provider !== 'heuristic' && this.config.llm.apiKey.length > 0;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (!this.available) throw new Error('LLM 未配置');
    const cfg = this.config.llm;
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: options.temperature ?? cfg.temperature,
      max_tokens: options.maxTokens ?? cfg.maxTokens,
      stream: false,
    };
    if (options.json !== false && cfg.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('LLM 返回 ' + res.status + ': ' + truncate(text, 300));
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回空内容');
    return content;
  }
}

/* ---------- Brain 接口 ---------- */

export interface ExtractContext {
  user: string;
  assistant: string;
  at: number;
  personaName: string;
  userName: string;
  maxCandidates: number;
}

export interface CompressInput {
  fact: string;
  gist: string;
  tag: string;
  targetLevel: MemoryLevel;
  affect: Affect | null;
}

export interface CompressOutput {
  fact: string;
  gist: string;
  tag: string;
}

export interface SessionJudgeInput {
  transcript: string;
  personaName: string;
  userName: string;
  turnCount: number;
}

export interface SessionJudgeOutput {
  affect: Affect | null;
  relationDelta: RelationDelta | null;
  openThread: string | null;
  summary: string | null;
}

export interface Brain {
  readonly name: string;
  readonly llmBacked: boolean;
  extract(ctx: ExtractContext): Promise<MemoryCandidate[]>;
  compress(input: CompressInput): Promise<CompressOutput>;
  judgeSession(input: SessionJudgeInput): Promise<SessionJudgeOutput>;
}

/* ---------- 启发式大脑 ---------- */

export class HeuristicBrain implements Brain {
  readonly name = 'heuristic';
  readonly llmBacked = false;

  async extract(ctx: ExtractContext): Promise<MemoryCandidate[]> {
    const user = ctx.user || '';
    const assistant = ctx.assistant || '';
    const imp = estimateImportance(user, assistant);
    // 前瞻记忆：只在用户这一侧许的约定才算数（她自己应下来的也算，但权重低）
    // 只有算得出具体日子的承诺才算约定；模糊的一律当普通记忆
    const guess = detectPromise(user, ctx.at) || detectPromise(assistant, ctx.at);
    const promise = guess && !guess.vague ? guess : null;
    // 约定不能被「吃饭 / 睡觉」这类琐事词误伤 —— 它本来就常跟这些词一起出现
    if (imp.trivial && imp.importance < 0.18 && promise === null) {
      return [
        {
          remember: false,
          importance: imp.importance,
          owner: 'shared',
          fact: '',
          gist: '',
          tag: '',
          affect: null,
          relationDelta: null,
          tags: [],
          entities: [],
          themeKey: null,
          calendarAnchor: null,
          eventAt: null,
          eventPrecision: 'unknown',
          contradicts: null,
          reason: imp.reasons.join('/'),
        },
      ];
    }

    const text = user + '\n' + assistant;
    const affect = estimateAffect(user, assistant);
    const tags = extractTags(text);
    const anchor = detectAnchor(text, ctx.at);
    const { at, precision } = inferEventTime(text, ctx.at);

    return [
      {
        remember: true,
        // 约定是最重要的一类记忆：不许因为词面上像琐事就被打低分
        importance: promise ? Math.max(imp.importance, 0.82) : imp.importance,
        owner: guessOwner(user, assistant),
        fact: truncate(
          // 事实通道：保持原话密度，不美化
          [user.trim(), assistant.trim()].filter((s) => s.length > 0).join(' / '),
          320,
        ),
        gist: truncate(firstSentence(user) || firstSentence(assistant) || truncate(text, 60), 90),
        tag: (imp.topTag || tags[0] || '').slice(0, 6),
        affect,
        relationDelta: estimateRelationDelta(user, assistant, affect),
        tags,
        entities: extractEntities(text),
        themeKey: profileThemeKey(text) ?? guessTheme(text, tags, imp.topTag),
        calendarAnchor: anchor,
        eventAt: at,
        eventPrecision: precision,
        dueAt: promise ? promise.dueAt : null,
        promiseState: promise ? 'pending' : 'none',
        contradicts: null,
        reason: imp.reasons.join('/') + (promise ? '/前瞻记忆' : ''),
      },
    ];
  }

  async compress(input: CompressInput): Promise<CompressOutput> {
    return heuristicCompress(input.fact, input.gist, input.targetLevel, input.tag, input.affect);
  }

  async judgeSession(input: SessionJudgeInput): Promise<SessionJudgeOutput> {
    const lines = input.transcript.split('\n');
    const userLines: string[] = [];
    const assistantLines: string[] = [];
    for (const line of lines) {
      const m = line.match(/^([^\s:：]{1,12})[:：]\s*(.*)$/);
      if (!m) continue;
      if (m[1] === input.userName) userLines.push(m[2]);
      if (m[1] === input.personaName) assistantLines.push(m[2]);
    }
    const user = userLines.join('\n');
    const assistant = assistantLines.join('\n');
    const affect = estimateAffect(user, assistant);
    return {
      affect,
      relationDelta: estimateRelationDelta(user, assistant, affect),
      openThread: null,
      summary: summarizeSession(user, assistant, affect),
    };
  }
}

function firstSentence(text: string): string {
  if (!text) return '';
  const m = text.match(/^[\s\S]{0,80}?[。！？!?…\n]/);
  return (m ? m[0] : text).trim();
}

/* ---------- LLM 大脑 ---------- */

const EXTRACT_SYSTEM = [
  '你是「MMTR」的写入决策器。',
  '你的工作不是记录一切，而是判断这一轮对话有没有值得留下的东西，并把它拆成三条独立通道：事实、要点、情绪。',
  '',
  '【值得记住的】情感表达、承诺、冲突、脆弱时刻、身份信息、重要时间节点（生日/纪念日/第一次）、共同经历的具体细节、关系状态的变化、用户明确要求记住的东西。',
  '',
  '【前瞻记忆 · 特别注意】如果这段对话里出现「约好 / 答应 / 说好 / 下次一起 / 等你忙完」这类指向未来的承诺，',
  '必须把 promise 填上：dueAt 用绝对的 ISO 时间（能算出来才算），说不清哪天就填 null 并把 vague 设为 true。',
  '没有承诺时 promise 为 null。承诺是最重要的一类记忆，importance 至少给 0.8。',
  '【什么才算承诺】只有双方明确应下了一件未来的具体事（有日期或明确场合）才算。',
  '叮嘱（路上看车/多穿点）、道别（去睡了/先去忙）、日常安排（先吃饭/去洗漱/写作业）一律不算承诺。',
  '说不出具体日子就别硬说是承诺——vague=true 会被当成普通记忆。',
  '【相对时间必须换算成绝对日期】明天=+1天，后天=+2天，周末=最近的周六，下周X=下个星期的X，',
  '下个月=下一个月同一天，明年=下一年的同一天，明年X月X日=下一年的那一天。算得出就一定填 ISO，不要偷懒填 vague。',

  '【稳定事实用固定主题键】关于 TA 这个人的生日与年龄 → profile_birthday；学校/年级 → profile_school；',
  '工作 → profile_work；城市 → profile_city；家人 → profile_family。同一主题键会被合并成一条，',
  '所以 fact 要写成「目前已知的全部信息」，不要只写这一轮新冒出来的碎片。',
  '【必须丢弃的】寒暄、应答词、纯表情、上厕所/吃饭/喝水这类日常琐事、纯链接、天气闲谈。',
  '【拿不准时】给 0.2~0.35 的低分并 remember=true，让衰减机制自己处理；只有明确没有实质内容才 remember=false。',
  '',
  '【铁律】',
  '1. 只写对话里真实出现的信息。不要补全细节，不要"合理推测"。缺失就留空字符串或 null。',
  '2. gist 与 fact 必须来自对话本身，不得引入对话之外的想象。',
  '3. owner：关于「你」自己的经历填 self；关于 TA 的填 user；共同经历填 shared。',
  '4. 没有实质内容时返回 {"memories": []}。',
  '5. gist 是能唤起感觉的一句话（保留画面与情绪），fact 是冷静的客观记录。',
  '',
  '只输出 JSON，不要任何解释、不要 ``` 围栏。',
].join('\n');

function extractUserPrompt(ctx: ExtractContext): string {
  return [
    '【对话时间】' + new Date(ctx.at).toISOString(),
    '【AI 自称】' + ctx.personaName,
    '【用户称呼】' + ctx.userName,
    '',
    '【TA 说】',
    ctx.user,
    '',
    '【你（' + ctx.personaName + '）说】',
    ctx.assistant,
    '',
    '【今天是】' + new Date(ctx.at).toISOString().slice(0, 10),
    '',
    '请输出 JSON：',
    '{"memories":[{"remember":true,"importance":0.0,"owner":"shared",',
    '"gist":"能唤起感觉的一句话","fact":"客观事实记录","tag":"不超过6个字",',
    '"affect":{"valence":0.0,"arousal":0.0,"label":"平静"},',
    '"relationDelta":{"closeness":0.0,"trust":0.0,"playfulness":0.0,"warmth":0.0,"tension":0.0,"familiarity":0.0},',
    '"tags":["主题词"],"entities":["人名/地点/物件"],"theme":"主题键",',
    '"calendarAnchor":null,"eventTime":{"iso":null,"precision":"unknown"},"contradicts":null,',
    '"promise":{"is":false,"what":"答应/约好的事，一句话","dueAt":null,"dueText":"跨年夜","vague":false}或null}]}',
    '',
    '最多 ' + ctx.maxCandidates + ' 条，通常 1 条就够。importance 是 0~1 的小数。',
  ].join('\n');
}

const COMPRESS_SYSTEM = [
  '你是记忆压缩器。压缩 = 丢掉细节、留住能唤起感觉的东西，不是改写、不是美化、不是总结升华。',
  '铁律：不许添加原文没有的信息；不许把模糊的东西写具体；不许把"记不清"写成确定的细节。',
  '只输出 JSON，不要解释。',
].join('\n');

function levelInstruction(level: MemoryLevel): string {
  if (level === 1) {
    return '目标 L1 详细摘要：保留时间地点、关键动作、说了什么，90 字以内。fact 保留客观记录，gist 压到 40 字以内。';
  }
  if (level === 2) {
    return '目标 L2 一句话要点：只留这件事的核心，gist 40 字以内，fact 必须为 ""（空字符串），tag 6 字以内。';
  }
  return '目标 L3 只剩标签：gist 12 字以内，形如"开心的某一次生日"；fact 必须为 ""（空字符串）；tag 不超过 6 字。';
}

const SESSION_SYSTEM = [
  '你是关系状态观察者。请对整段对话做一次整体判断，不要逐句判断。',
  '情绪基调看整体，关系温度看变化。数值要有克制：单次会话的正常波动不应超过 0.06。',
  '只输出 JSON，不要解释。',
].join('\n');

export class LLMBrain implements Brain {
  readonly name: string;
  readonly llmBacked = true;
  private client: ChatClient;
  private config: MMTRConfig;
  private fallback = new HeuristicBrain();

  constructor(config: MMTRConfig) {
    this.config = config;
    this.client = new ChatClient(config);
    this.name = 'llm:' + config.llm.model;
  }

  async extract(ctx: ExtractContext): Promise<MemoryCandidate[]> {
    try {
      const raw = await this.client.chat([
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: extractUserPrompt(ctx) },
      ]);
      const parsed = extractJsonObject(raw);
      if (!parsed) throw new Error('抽取结果不是 JSON');
      const list = Array.isArray(parsed.memories) ? (parsed.memories as unknown[]) : [];
      const out: MemoryCandidate[] = [];
      for (const item of list) {
        const c = normalizeCandidate(item, ctx);
        if (c) out.push(c);
      }
      if (out.length === 0 && list.length === 0) {
        return [
          {
            remember: false,
            importance: 0,
            owner: 'shared',
            fact: '',
            gist: '',
            tag: '',
            affect: null,
            relationDelta: null,
            tags: [],
            entities: [],
            themeKey: null,
            calendarAnchor: null,
            eventAt: null,
            eventPrecision: 'unknown',
            contradicts: null,
            reason: 'llm:no-content',
          },
        ];
      }
      return out.slice(0, Math.max(1, ctx.maxCandidates));
    } catch (err) {
      this.warn('extract 降级到启发式: ' + (err as Error).message);
      return this.fallback.extract(ctx);
    }
  }

  async compress(input: CompressInput): Promise<CompressOutput> {
    try {
      const payload = {
        targetLevel: 'L' + input.targetLevel,
        instruction: levelInstruction(input.targetLevel),
        fact: input.fact,
        gist: input.gist,
        tag: input.tag,
        affectLabel: input.affect ? input.affect.label : null,
      };
      const raw = await this.client.chat([
        { role: 'system', content: COMPRESS_SYSTEM },
        { role: 'user', content: JSON.stringify(payload) },
      ]);
      const parsed = extractJsonObject(raw);
      if (!parsed) throw new Error('压缩结果不是 JSON');
      const out: CompressOutput = {
        fact: typeof parsed.fact === 'string' ? parsed.fact : '',
        gist: typeof parsed.gist === 'string' ? parsed.gist : '',
        tag: typeof parsed.tag === 'string' ? parsed.tag : input.tag,
      };
      if (!out.gist.trim()) throw new Error('压缩结果 gist 为空');
      if (input.targetLevel >= 2) out.fact = '';
      return {
        fact: truncate(out.fact, 200),
        gist: truncate(out.gist, 120),
        tag: truncate(out.tag, 12),
      };
    } catch (err) {
      this.warn('compress 降级到启发式: ' + (err as Error).message);
      return this.fallback.compress(input);
    }
  }

  async judgeSession(input: SessionJudgeInput): Promise<SessionJudgeOutput> {
    try {
      const raw = await this.client.chat([
        { role: 'system', content: SESSION_SYSTEM },
        {
          role: 'user',
          content:
            '【AI 自称】' + input.personaName + '\n【用户】' + input.userName + '\n【轮次】' + input.turnCount +
            '\n\n【完整对话】\n' + truncate(input.transcript, 6000) +
            '\n\n请输出 JSON：{"affect":{"valence":0,"arousal":0,"label":"平静"},' +
            '"relationDelta":{"closeness":0,"trust":0,"playfulness":0,"warmth":0,"tension":0,"familiarity":0},' +
            '"openThread":null,"summary":"60字以内概括"}',
        },
      ]);
      const parsed = extractJsonObject(raw);
      if (!parsed) throw new Error('会话判断结果不是 JSON');
      return {
        affect: normalizeAffect(parsed.affect),
        relationDelta: normalizeRelationDelta(parsed.relationDelta),
        openThread:
          typeof parsed.openThread === 'string' && parsed.openThread.trim().length > 0
            ? truncate(parsed.openThread, 60)
            : null,
        summary:
          typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
            ? truncate(parsed.summary, 120)
            : null,
      };
    } catch (err) {
      this.warn('judgeSession 降级到启发式: ' + (err as Error).message);
      return this.fallback.judgeSession(input);
    }
  }

  private warn(msg: string): void {
    if (this.config.logLevel === 'debug' || this.config.logLevel === 'info') {
      console.log('[mmtr:warn] ' + msg);
    }
  }
}

/* ---------- 归一化 ---------- */

const OWNERS: Owner[] = ['self', 'user', 'shared'];
const PRECISIONS: TimePrecision[] = ['exact', 'day', 'month', 'year', 'unknown'];

function numOr(v: unknown, d: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

export function normalizeAffect(v: unknown): Affect | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    valence: round(clamp(numOr(o.valence, 0), -1, 1), 3),
    arousal: round(clamp01(numOr(o.arousal, 0.4)), 3),
    label: typeof o.label === 'string' && o.label.trim() ? truncate(o.label.trim(), 8) : '平静',
  };
}

export function normalizeRelationDelta(v: unknown, maxAbs = 0.06): RelationDelta | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out: RelationDelta = {};
  let any = false;
  for (const dim of RELATION_DIMS) {
    const raw = o[dim];
    if (raw === undefined || raw === null) continue;
    const n = clamp(numOr(raw, 0), -maxAbs, maxAbs);
    if (Math.abs(n) < 1e-6) continue;
    out[dim] = round(n, 4);
    any = true;
  }
  return any ? out : null;
}

function normalizeAnchor(v: unknown): CalendarAnchor | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? o.kind : 'none';
  if (kind === 'none') return null;
  const anchor: CalendarAnchor = {
    kind: kind as CalendarAnchor['kind'],
    label: typeof o.label === 'string' ? truncate(o.label, 12) : undefined,
    repeat: o.repeat === false ? false : true,
  };
  if (o.month !== undefined) anchor.month = clamp(numOr(o.month, 1), 1, 12);
  if (o.day !== undefined) anchor.day = clamp(numOr(o.day, 1), 1, 31);
  if (o.weekday !== undefined) anchor.weekday = clamp(numOr(o.weekday, 0), 0, 6);
  if (o.festival !== undefined) anchor.festival = String(o.festival);
  if (o.sinceYear !== undefined) anchor.sinceYear = numOr(o.sinceYear, 0);
  if (o.fromHour !== undefined) anchor.fromHour = clamp(numOr(o.fromHour, 23), 0, 23);
  if (o.toHour !== undefined) anchor.toHour = clamp(numOr(o.toHour, 4), 0, 24);
  return anchor;
}

export function normalizeCandidate(v: unknown, ctx: ExtractContext): MemoryCandidate | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const remember = o.remember !== false;
  const fact = typeof o.fact === 'string' ? o.fact.trim() : '';
  const gist = typeof o.gist === 'string' ? o.gist.trim() : '';
  if (!remember) {
    return {
      remember: false,
      importance: clamp01(numOr(o.importance, 0)),
      owner: 'shared',
      fact: '',
      gist: '',
      tag: '',
      affect: null,
      relationDelta: null,
      tags: [],
      entities: [],
      themeKey: null,
      calendarAnchor: null,
      eventAt: null,
      eventPrecision: 'unknown',
      contradicts: null,
      reason: typeof o.reason === 'string' ? o.reason : 'llm:skipped',
    };
  }
  if (!fact && !gist) return null;

  let eventAt: number | null = null;
  let eventPrecision: TimePrecision = 'unknown';
  const et = o.eventTime;
  if (et && typeof et === 'object') {
    const eo = et as Record<string, unknown>;
    if (typeof eo.iso === 'string' && eo.iso.trim()) {
      const t = Date.parse(eo.iso);
      if (!Number.isNaN(t)) eventAt = t;
    }
    const p = typeof eo.precision === 'string' ? eo.precision : 'unknown';
    if (PRECISIONS.indexOf(p as TimePrecision) >= 0) eventPrecision = p as TimePrecision;
  }

  // 前瞻记忆
  let dueAt: number | null = null;
  const pr = o.promise;
  if (pr && typeof pr === 'object' && (pr as Record<string, unknown>).is !== false) {
    const po = pr as Record<string, unknown>;
    const rawDue = typeof po.dueAt === 'string' ? Date.parse(po.dueAt) : NaN;
    if (Number.isFinite(rawDue) && rawDue > 0) {
      dueAt = rawDue;
    } else if (po.vague === true) {
      // 说不出具体日子的，一律不当约定：它就是一条普通记忆。
      // （以前给 30 天观察期，结果"叮嘱路上看车""先去洗漱"全变成还欠着的事）
      const promiseText = [po.what, po.dueText]
        .filter((x): x is string => typeof x === "string")
        .join(" ");
      const guess = resolveRelativeDate(promiseText, ctx.at);
      dueAt = guess && !guess.vague ? guess.dueAt : null;
    }
  }

  const ownerRaw = typeof o.owner === 'string' ? o.owner : 'shared';
  const owner = OWNERS.indexOf(ownerRaw as Owner) >= 0 ? (ownerRaw as Owner) : 'shared';

  return {
    remember: true,
    importance: round(clamp01(numOr(o.importance, 0.3)), 4),
    owner,
    fact: truncate(fact, 400),
    gist: truncate(gist, 160),
    tag: typeof o.tag === 'string' ? normalizeTag(truncate(o.tag.trim(), 12)) : '',
    affect: normalizeAffect(o.affect),
    relationDelta: normalizeRelationDelta(o.relationDelta),
    tags: Array.isArray(o.tags)
      ? uniqueStrings(o.tags.filter((x): x is string => typeof x === 'string').map((x) => truncate(x, 12))).slice(0, 8)
      : [],
    entities: Array.isArray(o.entities)
      ? uniqueStrings(o.entities.filter((x): x is string => typeof x === 'string').map((x) => truncate(x, 20))).slice(0, 8)
      : [],
    themeKey: (() => {
      // 稳定事实优先用固定主题键，保证同一个人的同一件事只有一条
      const stable = profileThemeKey([fact, gist, typeof o.tag === "string" ? o.tag : ""].join(" "));
      if (stable) return stable;
      return typeof o.theme === "string" && o.theme.trim().length > 0 ? truncate(o.theme.trim(), 16) : null;
    })(),
    calendarAnchor: normalizeAnchor(o.calendarAnchor),
    eventAt,
    eventPrecision,
    dueAt,
    promiseState: dueAt === null ? 'none' : 'pending',
    contradicts:
      typeof o.contradicts === 'string' && o.contradicts.trim().length > 0
        ? truncate(o.contradicts.trim(), 200)
        : null,
  };
}

/* ---------- 工厂 ---------- */

export function createBrain(config: MMTRConfig): Brain {
  const client = new ChatClient(config);
  if (client.available && config.llm.enableScoring) return new LLMBrain(config);
  return new HeuristicBrain();
}