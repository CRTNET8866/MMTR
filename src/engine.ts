/* ============================================================================
 * 门面 (engine.ts)
 *
 * 对外只有这一个类。所有主张都从这里暴露：
 *   ingest      写入即决策
 *   retrieve    链式联想检索
 *   wake        唤醒态（关系通道 → system prompt）
 *   sleep       会话结算（整体情绪判断 + 关系更新 + 会话记忆）
 *   consolidate 睡眠巩固（压缩阶梯 + 边衰减 + 关系回归）
 * ==========================================================================*/

import type { MMTRConfig, LoadConfigOptions } from './config.ts';
import { loadConfig, logger } from './config.ts';
import { Db } from './db.ts';
import { VectorCache, createEmbeddingProvider, type EmbeddingProvider } from './embeddings.ts';
import { createBrain, type Brain } from './llm.ts';
import type {
  Affect,
  ConsolidationReport,
  CoreBlock,
  Exchange,
  IngestOptions,
  IngestResult,
  MemoryRecord,
  MemoryView,
  Owner,
  RelationDelta,
  RelationDims,
  RelationState,
  RetrievalQuery,
  RetrievalResult,
  SkippedMemory,
  StatsReport,
  WakeState,
} from './types.ts';
import { matchAnchor } from './calendar.ts';
import { activateAll, computeWeights, strengthLabel, timelineLabel, toView } from './decay.ts';
import { deriveMood } from './mood.ts';
import { duePhrase, promiseInfo, promiseRelationDelta, promiseMentionsPromise, shouldSurfacePromise } from './promise.ts';
import { countEdges } from './graph.ts';
import { consolidate, type ConsolidateOptions } from './consolidate.ts';
import {
  buildRecord,
  candidateEmbeddingText,
  buildSessionSummaryRecord,
  embedQuery,
  embedRecord,
  invalidateByContradiction,
  linkMemory,
  mergeInto,
  type CreateDeps,
} from './create.ts';
import {
  allValidIds,
  applyImportance,
  countMemories,
  getMemory,
  getMemories,
  insertMemory,
  invalidateMemory,
  queryMemories,
  recordActivation,
  updateMemory,
} from './memory.ts';
import {
  applyRelationDeltas,
  getRelationState,
  mergeDeltas,
  regressRelation,
  saveRelationState,
} from './relation.ts';
import {
  appendTurn,
  buildTranscript,
  getOpenSession,
  getTurns,
  openSession,
  rowToSession,
  saveSession,
  type SessionTurn,
} from './session.ts';
import { assembleContext, retrieve, type AssembleOptions, type RetrieveOptions } from './retrieve.ts';
import type { AssembledContext } from './types.ts';
import { calendarLine, renderWake } from './wake.ts';
import { MS_DAY, MS_HOUR, clamp, clamp01, nowMs, round, truncate } from './util.ts';

export interface MMTROptions extends LoadConfigOptions {
  /** 直接给一份配置对象，跳过文件加载 */
  configOverride?: Partial<MMTRConfig>;
}

export interface SleepResult {
  session: ReturnType<typeof rowToSession> | null;
  summaryMemoryId: string | null;
  relation: RelationState;
  openThread: string | null;
}

export interface ExplainResult {
  memory: MemoryView;
  edges: Array<{ toId: string; type: string; weight: number; hits: number }>;
  activations: Array<{ at: number; kind: string; sessionId: string | null }>;
  since: { created: string; lastFired: string | null };
}

const DEFAULT_CORE_BLOCKS: Array<{ key: string; title: string; content: string; mutable: boolean }> = [
  { key: 'identity', title: '我是谁', content: '', mutable: true },
  { key: 'user', title: 'TA 是谁', content: '', mutable: true },
  { key: 'pact', title: '我们之间的约定', content: '', mutable: true },
];

export class MMTR {
  readonly config: MMTRConfig;
  readonly db: Db;
  readonly vectors: VectorCache;
  readonly embed: EmbeddingProvider;
  readonly brain: Brain;
  private log: (lvl: 'debug' | 'info' | 'warn' | 'error' | 'silent', msg: string, extra?: unknown) => void;
  private deps: CreateDeps;
  private closed = false;

  constructor(config: MMTRConfig, dbPath: string) {
    this.config = config;
    this.log = logger(config);
    this.db = new Db(dbPath);
    this.vectors = new VectorCache(this.db);
    this.embed = createEmbeddingProvider(config);
    this.brain = createBrain(config);
    this.deps = { db: this.db, config, vectors: this.vectors, embed: this.embed };

    this.db.setMeta('schema', '1');
    this.db.setMeta('last_open', String(nowMs()));
    this.seedCore();
  }

  static open(options: MMTROptions = {}): MMTR {
    const { configOverride, ...rest } = options;
    const resolved = loadConfig({
      cwd: rest.cwd,
      configPath: rest.configPath,
      patch: (configOverride ?? rest.patch) as Record<string, unknown> | undefined,
    });
    return new MMTR(resolved.config, resolved.resolvedDbPath);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /* ========================= 写入 ========================= */

  async ingest(exchange: Exchange, options: IngestOptions = {}): Promise<IngestResult> {
    const at = exchange.at ?? nowMs();
    const session = await this.ensureSession(at);
    const turn = this.nextTurn(session.id);
    const personaName = this.config.wake.personaName;
    const userName = this.config.wake.userName;

    const candidates = await this.brain.extract({
      user: exchange.user,
      assistant: exchange.assistant,
      at,
      personaName,
      userName,
      maxCandidates: this.config.write.maxCandidatesPerExchange,
    });

    const stored: MemoryView[] = [];
    const merged: MemoryView[] = [];
    const skipped: SkippedMemory[] = [];
    const minImportance = options.minImportance ?? this.config.write.minImportance;
    const rawText = userName + '：' + exchange.user + '\n' + personaName + '：' + exchange.assistant;

    for (const candidate of candidates) {
      if (!candidate.remember) {
        skipped.push({
          reason: candidate.reason || 'not-worth-remembering',
          importance: candidate.importance,
          preview: truncate(candidate.gist || candidate.fact, 40),
        });
        continue;
      }
      if (!candidate.gist && !candidate.fact) {
        skipped.push({ reason: 'empty', importance: candidate.importance, preview: '' });
        continue;
      }
      if (!exchange.pin && candidate.importance < minImportance) {
        skipped.push({
          reason: 'below-min-importance(' + minImportance + ')',
          importance: candidate.importance,
          preview: truncate(candidate.gist || candidate.fact, 40),
        });
        continue;
      }

      // 稳定事实（生日/年龄/学校/家人这类「他是谁」）写进常驻块：不进衰减、不进压缩、每轮都在。
      // 普通记忆表只留「事件」，绝不用新说法去覆盖旧正文（曾经因此把生日日期覆盖掉过）。
      if (candidate.themeKey && candidate.themeKey.startsWith("profile_")) {
        const factText = candidate.fact || candidate.gist;
        if (this.isStableFact(factText)) this.upsertCoreFact(factText, at);
      }
      const duplicate = await this.findDuplicate(candidateEmbeddingText(candidate), at);
      if (duplicate) {
        const { record } = mergeInto(this.deps, duplicate, candidate, at);
        await embedRecord(this.deps, record);
        merged.push(toView(record, this.config, at));
        continue;
      }

      const record = buildRecord(
        {
          candidate,
          at,
          sessionId: session.id,
          rawText,
          pin: exchange.pin,
          source: 'new_experience',
        },
        this.config,
      );

      this.db.tx(() => {
        insertMemory(this.db, record);
      });
      await embedRecord(this.deps, record);
      await linkMemory(this.deps, record, at);

      if (candidate.contradicts) {
        const fresh = getMemory(this.db, record.id);
        if (fresh) {
          const invalidated = invalidateByContradiction(this.deps, fresh, candidate.contradicts, at);
          if (invalidated) this.log('info', '旧事实已失效: ' + invalidated + ' (被 ' + record.id + ' 推翻)');
        }
      }

      const after = getMemory(this.db, record.id) || record;
      stored.push(toView(after, this.config, at));
    }

    appendTurn(this.db, {
      sessionId: session.id,
      turn,
      at,
      userText: exchange.user,
      assistantText: exchange.assistant,
      memoryIds: stored.map((m) => m.id),
    });

    // 这一轮如果在说「我们那天真的去了」，就把对应的约定判成兑现
    const promisesKept = this.settlePromisesByText(exchange.user + '\n' + exchange.assistant, at);

    return {
      stored,
      merged,
      skipped,
      promisesKept,
      relationDelta: mergeDeltas(candidates.map((c) => c.relationDelta)),
      sessionId: session.id,
    };
  }

  /** 用户明确说「记住这个」时用这个入口：直接锁死、永不压缩。 */
  async remember(text: string, options: { owner?: Owner; importance?: number; at?: number } = {}): Promise<MemoryView> {
    const at = options.at ?? nowMs();
    const session = await this.ensureSession(at);
    const importance = options.importance ?? this.config.write.pinImportance;
    const candidate = {
      remember: true,
      importance,
      owner: options.owner ?? ('shared' as Owner),
      fact: truncate(text, 400),
      gist: truncate(text, 120),
      tag: '钉住',
      affect: null,
      relationDelta: null,
      tags: ['钉住'],
      entities: [],
      themeKey: null,
      calendarAnchor: null,
      eventAt: null,
      eventPrecision: 'unknown' as const,
      contradicts: null,
      reason: '用户钉住',
    };
    const record = buildRecord({ candidate, at, sessionId: session.id, rawText: text, pin: true }, this.config);
    this.db.tx(() => insertMemory(this.db, record));
    await embedRecord(this.deps, record);
    await linkMemory(this.deps, record, at);
    return toView(getMemory(this.db, record.id) || record, this.config, at);
  }

  /* ========================= 检索 ========================= */

  async retrieve(query: RetrievalQuery, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    const at = nowMs();
    const session = getOpenSession(this.db);
    const sessionId = options.sessionId ?? query.sessionId ?? (session ? session.id : null);
    const turn = sessionId ? this.currentTurn(sessionId) : 0;
    return retrieve(
      { db: this.db, config: this.config, vectors: this.vectors, embed: this.embed },
      query,
      at,
      { ...options, sessionId, turn },
    );
  }

  async getContext(
    query: RetrievalQuery,
    options: RetrieveOptions & AssembleOptions & { style?: 'quiet' | 'full' } = {},
  ): Promise<AssembledContext> {
    const at = nowMs();
    const result = await this.retrieve(query, options);
    const assembled = assembleContext(result.hits, this.config, at, { ...options, style: options.style ?? 'quiet' });
    return {
      block: assembled.block,
      hits: assembled.used,
      tokenEstimate: assembled.tokenEstimate,
    };
  }

  /* ========================= 唤醒 ========================= */

  async wake(at: number = nowMs(), options: { format?: 'quiet' | 'full' } = {}): Promise<WakeState> {
    const session = await this.ensureSession(at);
    const relation = getRelationState(this.db, this.config, at);

    const lastRow = this.db.get(
      'SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1',
    );
    const lastSession = lastRow ? rowToSession(lastRow) : null;
    const lastTurnRow = this.db.get(
      'SELECT MAX(at) AS t FROM session_turns WHERE session_id = ?',
      [session.id],
    );
    const previousTurnRow = this.db.get(
      'SELECT MAX(at) AS t FROM session_turns WHERE session_id != ?',
      [session.id],
    );
    const lastTurnAt =
      lastTurnRow && lastTurnRow.t != null
        ? Number(lastTurnRow.t)
        : previousTurnRow && previousTurnRow.t != null
          ? Number(previousTurnRow.t)
          : null;

    /* 近因池：最近的 + 重要的 */
    const recentRecords = queryMemories(this.db, {
      createdAfter: at - this.config.session.wakeRecentHours * MS_HOUR,
      limit: 40,
      orderBy: 'created_at',
    });
    const strongRecords = queryMemories(this.db, {
      minImportance: 0.55,
      limit: 30,
      orderBy: 'importance',
    });
    const poolMap = new Map<string, MemoryRecord>();
    for (const r of [...recentRecords, ...strongRecords]) poolMap.set(r.id, r);
    const ranked = this.rankRecords([...poolMap.values()], at);

    /* 日历共鸣 */
    const anchored = queryMemories(this.db, { limit: 2000, orderBy: 'created_at' }).filter(
      (r) => r.calendarAnchor !== null,
    );
    const calendarLines: string[] = [];
    const calendarHits: typeof ranked = [];
    const lookahead = this.config.session.wakeCalendarLookaheadDays;
    for (const record of anchored) {
      const match = matchAnchor(record.calendarAnchor, at, this.config, lookahead);
      if (!match.matched) continue;
      calendarLines.push(
        calendarLine({
          relationLabel: match.label,
          inDays: match.inDays,
          gist: '那次：' + truncate(record.gist || record.tag, 40),
        }),
      );
      const weights = computeWeights(record, this.config, at);
      calendarHits.push({
        memory: { ...record, weights, ageDays: round((at - record.createdAt) / MS_DAY, 2), frozen: record.readOnly },
        score: match.boost,
        similarity: 0,
        reasons: ['日历唤醒:' + match.label],
        hop: 0,
      });
    }

    /* 未散开的张力 */
    const openThreads = this.rankRecords(
      queryMemories(this.db, { limit: 200 }).filter(
        (r) => r.affect !== null && r.affect.valence <= -0.2 && computeWeights(r, this.config, at).affect > 0.2,
      ),
      at,
    ).slice(0, this.config.session.wakeOpenThreads);

    /* 前瞻记忆：她还在等的约定 —— 唯一会「越靠近越清晰」的一类记忆 */
    const promiseLines: string[] = [];
    const promiseHits: typeof ranked = [];
    for (const record of queryMemories(this.db, { limit: 1000 })) {
      if (record.promiseState !== 'pending' || record.dueAt === null) continue;
      if (!shouldSurfacePromise(record.dueAt, record.promiseState, at, this.config)) continue;
      promiseLines.push(duePhrase(record.dueAt, at, record.calendarAnchor?.label ?? record.tag ?? null));
      const info = promiseInfo(record.dueAt, record.promiseState, at, this.config);
      const weights = computeWeights(record, this.config, at);
      promiseHits.push({
        memory: {
          ...record,
          weights,
          ageDays: round((at - record.createdAt) / MS_DAY, 2),
          frozen: record.readOnly || record.level >= 2,
          promiseClarity: info.clarity,
        },
        score: round(0.55 + 0.45 * info.clarity, 4),
        similarity: 0,
        reasons: ['前瞻记忆' + (info.overdue ? '（已到期）' : '')],
        hop: 0,
      });
    }
    promiseHits.sort((a, b) => b.score - a.score);

    const coreBlocks = this.getCore();

    /* 此刻的心情：近期加权 + 分位数 + 情绪预算（不是求平均） */
    const moodSamples = [];
    for (const hit of ranked) {
      const a = hit.memory.affect;
      if (!a) continue;
      moodSamples.push({
        valence: a.valence,
        arousal: a.arousal,
        weight: hit.memory.weights.affect,
        at: hit.memory.createdAt,
        calendar: false,
      });
    }
    for (const hit of calendarHits) {
      const a = hit.memory.affect;
      if (!a) continue;
      moodSamples.push({
        valence: a.valence,
        arousal: a.arousal,
        weight: hit.memory.weights.affect,
        at: hit.memory.createdAt,
        calendar: true,
      });
    }
    const mood = deriveMood(moodSamples, relation.dims, this.config, at);

    const rendered = renderWake({
      now: at,
      format: options.format ?? 'quiet',
      lastTurnAt,
      relation,
      mood,
      coreBlocks,
      recalls: ranked,
      promiseLines,
      calendarLines,
      openThread: null,
      sessionOpenThreadBlock: lastSession ? lastSession.openThread : null,
      config: this.config,
    });

    /* 唤醒 = 一次集体复习（会回血，但 importance 不动） */
    const used = [
      ...ranked.slice(0, this.config.wake.maxRecallLines),
      ...promiseHits.slice(0, 3),
      ...calendarHits.slice(0, 3),
    ];
    if (used.length > 0) {
      this.activateMemories(used.map((h) => h.memory.id), session.id, 0, at);
    }

    return {
      systemBlock: rendered.systemBlock,
      relation,
      coreBlocks,
      recent: ranked.slice(0, this.config.session.wakeStrongCount),
      calendar: calendarHits,
      promises: promiseHits,
      promiseLines,
      openThreads,
      strong: this.rankRecords(
        queryMemories(this.db, { limit: 300, orderBy: 'importance' }),
        at,
      ).slice(0, 5),
      tokenEstimate: rendered.tokenEstimate,
      generatedAt: at,
    };
  }

  /* ========================= 睡去 / 巩固 ========================= */

  async sleep(reason = 'manual', at: number = nowMs()): Promise<SleepResult> {
    const open = getOpenSession(this.db);
    if (!open) {
      return { session: null, summaryMemoryId: null, relation: getRelationState(this.db, this.config, at), openThread: null };
    }
    const turns = getTurns(this.db, open.id);
    const transcript = buildTranscript(turns, this.config.wake.personaName, this.config.wake.userName);

    const judge = transcript
      ? await this.brain.judgeSession({
          transcript,
          personaName: this.config.wake.personaName,
          userName: this.config.wake.userName,
          turnCount: turns.length,
        })
      : { affect: null, relationDelta: null, openThread: null, summary: null };

    /* 关系：本会话所有记忆的关系增量 + 整体判断，一次性、有上限地施加 */
    const sessionMemories = queryMemories(this.db, { sessionId: open.id, limit: 500 });
    const aggregate = mergeDeltas([...sessionMemories.map((m) => m.relationDelta), judge.relationDelta]);
    const state = getRelationState(this.db, this.config, at);
    const applied = applyRelationDeltas(state, aggregate, this.config, at);
    const saved =
      applied.applied !== null
        ? saveRelationState(this.db, { ...state, dims: applied.dims }, at, 'sleep:' + reason, null)
        : state;

    /* 会话记忆 */
    let summaryMemoryId: string | null = null;
    if (
      this.config.session.alwaysSummarize &&
      judge.summary &&
      turns.length >= this.config.session.minTurnsToSummarize
    ) {
      const magnitude = judge.affect ? Math.abs(judge.affect.valence) : 0;
      const importance = clamp(0.22 + 0.2 * magnitude + 0.03 * Math.min(turns.length, 10), 0.18, 0.72);
      const record = buildSessionSummaryRecord(
        this.config,
        open.id,
        at,
        judge.summary,
        judge.affect,
        round(importance, 4),
      );
      this.db.tx(() => insertMemory(this.db, record));
      await embedRecord(this.deps, record);
      await linkMemory(this.deps, record, at);
      summaryMemoryId = record.id;
    }

    const updated = {
      ...open,
      endedAt: at,
      turnCount: turns.length,
      affect: judge.affect,
      relationAfter: applied.dims,
      summaryMemoryId,
      openThread: judge.openThread,
    };
    saveSession(this.db, updated);

    return { session: updated, summaryMemoryId, relation: saved, openThread: judge.openThread };
  }

  async consolidate(options: ConsolidateOptions = {}, at: number = nowMs()): Promise<ConsolidationReport> {
    return consolidate(
      { db: this.db, config: this.config, brain: this.brain, embed: this.embed, vectors: this.vectors },
      at,
      options,
    );
  }

  /* ========================= 会话管理 ========================= */

  async ensureSession(at: number): Promise<ReturnType<typeof rowToSession> & { id: string }> {
    const open = getOpenSession(this.db);
    if (open) {
      const row = this.db.get('SELECT last_turn_at FROM sessions WHERE id = ?', [open.id]);
      const last = row && row.last_turn_at != null ? Number(row.last_turn_at) : open.startedAt;
      const gapHours = (at - last) / MS_HOUR;
      if (gapHours <= this.config.session.gapHours && at >= last) {
        return open;
      }
      await this.sleep('auto-gap', Math.max(last, at - 1));
    }
    const session = openSession(this.db, at);
    const relation = getRelationState(this.db, this.config, at);
    saveSession(this.db, { ...session, relationBefore: relation.dims }, session.startedAt);
    this.log('debug', '新会话开始: ' + session.id);
    return session;
  }

  private nextTurn(sessionId: string): number {
    const row = this.db.get('SELECT MAX(turn) AS t FROM session_turns WHERE session_id = ?', [sessionId]);
    const max = row && row.t != null ? Number(row.t) : -1;
    return max + 1;
  }

  private currentTurn(sessionId: string): number {
    const row = this.db.get('SELECT MAX(turn) AS t FROM session_turns WHERE session_id = ?', [sessionId]);
    return row && row.t != null ? Number(row.t) : 0;
  }

  /* ========================= 内部工具 ========================= */

  private rankRecords(records: MemoryRecord[], at: number): Array<{
    memory: MemoryView;
    score: number;
    similarity: number;
    reasons: string[];
    hop: number;
  }> {
    const scored = records.map((record) => {
      const weights = computeWeights(record, this.config, at);
      const score =
        0.42 * weights.gist + 0.26 * weights.affect + 0.2 * record.importance + 0.12 * weights.fact;
      return {
        memory: {
          ...record,
          weights,
          ageDays: round((at - record.createdAt) / MS_DAY, 2),
          frozen: record.readOnly || record.level >= 2,
        },
        score: round(score, 4),
        similarity: 0,
        reasons: ['唤醒评分'],
        hop: 0,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  private activateMemories(ids: string[], sessionId: string | null, turn: number, at: number): void {
    if (ids.length === 0) return;
    const records = getMemories(this.db, ids);
    this.db.tx(() => {
      for (const record of records) {
        const channels = activateAll(record, this.config, at, record.recallCount);
        const next: MemoryRecord = {
          ...record,
          channels,
          recallCount: record.recallCount + 1,
          lastFiredAt: at,
          fireCount24h: record.fireCount24h + 1,
        };
        updateMemory(this.db, next);
        recordActivation(this.db, { memoryId: record.id, sessionId, turn, at, kind: 'recall' });
      }
    });
  }

  private async findDuplicate(text: string, at: number): Promise<MemoryRecord | null> {
    if (this.embed.name === 'none' || !text.trim()) return null;
    const vec = await embedQuery(this.deps, text);
    if (!vec) return null;
    const allow = allValidIds(this.db);
    const hits = this.vectors.search(vec, 5, allow);
    for (const hit of hits) {
      if (hit.score < this.config.write.dedupSimilarity) continue;
      const record = getMemory(this.db, hit.id);
      if (!record) continue;
      if (at - record.createdAt > this.config.write.dedupWindowDays * MS_DAY) continue;
      return record;
    }
    return null;
  }

  /* ========================= 常驻记忆 ========================= */

  private seedCore(): void {
    const row = this.db.get('SELECT COUNT(*) AS c FROM core_memory');
    if (row && Number(row.c) > 0) return;
    for (const block of DEFAULT_CORE_BLOCKS) {
      this.db.run('INSERT INTO core_memory(key, title, content, updated_at, mutable) VALUES(?, ?, ?, ?, ?)', [
        block.key,
        block.title,
        block.content,
        nowMs(),
        block.mutable ? 1 : 0,
      ]);
    }
  }

  getCore(): CoreBlock[] {
    const rows = this.db.all('SELECT * FROM core_memory ORDER BY key ASC');
    return rows.map((row) => ({
      key: String(row.key),
      title: String(row.title),
      content: String(row.content ?? ''),
      updatedAt: Number(row.updated_at),
      mutable: Number(row.mutable) === 1,
    }));
  }

  /**
   * 稳定事实入库：写进「TA 是谁」这块常驻记忆，而不是普通记忆。
   * 常驻块不进衰减、不进压缩、每轮都在 prompt 里；普通记忆是「事件」，两者职责不同。
   */
  upsertCoreFact(line: string, at: number = nowMs()): { added: boolean; content: string } {
    // 一行一件事：把换行压成空格，别让一条事实占两行
    const text = String(line || "").replace(/\s+/g, " ").trim();
    if (!text) return { added: false, content: this.getCoreContent("user") };
    const old = this.getCoreContent("user");
    const lines = old ? old.split("\n").filter((x) => x.trim()) : [];
    // 已经是同一条事实就别再记一遍：先比数字（日期/年龄不能糊），再比字符覆盖率
    const digits = (s: string): string[] => s.match(/\d+/g) || [];
    const poolRaw = lines.join(" ");
    const poolDigits = digits(poolRaw);
    const missingDigit = digits(text).some((n) => !poolDigits.includes(n));
    const strip = (s: string): string => s.replace(/[\s，。；、：:,.()（）「」《》"'"'!?!?—-]/g, "");
    const fresh = new Set(Array.from(strip(text)));
    const known = new Set(Array.from(strip(poolRaw)));
    let same = 0;
    for (const ch of fresh) if (known.has(ch)) same += 1;
    // 0.6：同一件事换个说法就该被认成同一条；日期不同由 missingDigit 兜住
    const covered = !missingDigit && fresh.size > 0 && same / fresh.size >= 0.6;
    if (covered) return { added: false, content: old };
    const next = [...lines, text].slice(-8).join("\n");
    this.setCore("user", "TA 是谁", next, true);
    this.log("debug", "常驻事实 + " + truncate(text, 30));
    void at;
    return { added: true, content: next };
  }

  /** 只有「事实」才配进常驻块：一次「她忘了」不是事实，是事件。 */
  private isStableFact(text: string): boolean {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (!s) return false;
    // 1. 事实是短的；超过 40 字基本都是事件叙述
    if (s.length > 40) return false;
    // 2. 带动作/转述的是事件，不是身份
    if (/(说|问|表示|提到|告诉|来找|做了|答应|叮嘱|发现|觉得|担心|试探|聊|哭了|笑了|离开|回来)/.test(s)) return false;
    if (/(没记住|忘了|问起|考我|考他|考我|盘问|考了|记不清|答对|答错|记得自己|那天|当时|后来)/.test(s)) return false;
    // 3. 必须命中「身份型」的硬格式
    const hard = [
      /生日[：:是]?\s*\d{1,2}\s*月\s*\d{1,2}/,
      /\d{4}\s*年(出生|生)/,
      /\d{1,2}\s*岁/,
      /^(高三|高二|高一|初三|初二|初一|大一|大二|大三|大四|研究生|本科|硕士|博士)/,
      /(在读|学生|专业是|学的是)/,
      /(老家|住在|家在|户口)/,
    ];
    return hard.some((re) => re.test(s));
  }

  private getCoreContent(key: string): string {
    const row = this.db.get("SELECT content FROM core_memory WHERE key = ?", [key]);
    return row ? String(row.content || "") : "";
  }

  setCore(key: string, title: string, content: string, mutable = true): CoreBlock {
    const existing = this.db.get('SELECT mutable FROM core_memory WHERE key = ?', [key]);
    const allow = existing ? Number(existing.mutable) === 1 : true;
    if (!allow) throw new Error('该常驻记忆块是只读的: ' + key);
    this.db.run(
      'INSERT INTO core_memory(key, title, content, updated_at, mutable) VALUES(?, ?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = excluded.updated_at',
      [key, title, content, nowMs(), mutable ? 1 : 0],
    );
    return { key, title, content, updatedAt: nowMs(), mutable };
  }

  /* ========================= 维护操作 ========================= */

  /** 回溯式重加权：重要性往往是事后才知道的。这是唯一的「手动抬升」入口。 */
  reweight(memoryId: string, delta: number, why = 'user_initiated'): MemoryView | null {
    const record = getMemory(this.db, memoryId);
    if (!record) return null;
    const updated = applyImportance(record, {
      record,
      to: clamp01(record.importance + delta),
      by: 'retrospective',
      why,
      at: nowMs(),
    });
    updateMemory(this.db, updated);
    return toView(updated, this.config, nowMs());
  }

  /**
   * 兑现 / 判定落空一条约定。
   * 兑现要奖励（亲近、信任、温度都涨，张力松一口气）；
   * 落空的代价小得多，而且张力消退更快 —— 她会失望，然后和解。
   */
  resolvePromise(memoryId: string, outcome: 'kept' | 'broken'): MemoryView | null {
    const record = getMemory(this.db, memoryId);
    if (!record || record.promiseState === 'none') return null;
    const at = nowMs();
    const kept = outcome === 'kept';
    const updated: MemoryRecord = {
      ...record,
      promiseState: outcome,
      note: (record.note ? record.note + ' | ' : '') + (kept ? '约定兑现' : '约定落空'),
      importance: kept ? clamp01(record.importance + 0.1 * (1 - record.importance)) : record.importance,
      importanceUpdatedAt: at,
    };
    this.db.tx(() => {
      updateMemory(this.db, updated);
      recordActivation(this.db, {
        memoryId,
        sessionId: record.sessionId,
        turn: 0,
        at,
        kind: 'manual',
      });
    });
    const state = getRelationState(this.db, this.config, at);
    const delta = promiseRelationDelta(outcome, this.config) as RelationDelta;
    const applied = applyRelationDeltas(state, delta, this.config, at);
    if (applied.applied !== null) {
      saveRelationState(this.db, { ...state, dims: applied.dims }, at, 'promise:' + outcome, memoryId);
    }
    return toView(getMemory(this.db, memoryId) || updated, this.config, at);
  }

  /** 列出还在等 / 已经落空的约定，供 CLI 与调试面板用。 */
  listPromises(state: 'pending' | 'kept' | 'broken' | 'all' = 'pending', limit = 50): MemoryView[] {
    const at = nowMs();
    return queryMemories(this.db, { limit: 2000 })
      .filter((r) => (state === 'all' ? r.promiseState !== 'none' : r.promiseState === state))
      .slice(0, limit)
      .map((r) => toView(r, this.config, at))
      .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  }

  /** 这一轮里说的话，可能已经把某条约定兑现了 —— 自动判定并结算。 */
  private settlePromisesByText(text: string, at: number): string[] {
    if (!text.trim()) return [];
    const settled: string[] = [];
    for (const record of queryMemories(this.db, { limit: 1000 })) {
      if (record.promiseState !== 'pending' || record.dueAt === null) continue;
      // 只在到期日前后判定，太早说的话不算兑现
      const daysFromDue = (at - record.dueAt) / MS_DAY;
      // 允许提前 3 天就兑现（"上学前说一声"这种，早上做完中午才聊到）
      if (daysFromDue < -3 || daysFromDue > this.config.promise.graceDays) continue;
      if (!promiseMentionsPromise(record.gist || record.fact, record.themeKey, text)) continue;
      if (this.resolvePromise(record.id, 'kept')) settled.push(record.id);
    }
    return settled;
  }

  /** 把一条记忆锁死：永不压缩。 */
  pin(memoryId: string, importance?: number): MemoryView | null {
    const record = getMemory(this.db, memoryId);
    if (!record) return null;
    const target = importance ?? Math.max(record.importance, this.config.write.lockImportance);
    const updated: MemoryRecord = {
      ...record,
      locked: true,
      floorLevel: 0,
      importance: clamp01(target),
      importanceUpdatedAt: nowMs(),
      readOnly: false,
      importanceLog: [
        ...record.importanceLog.slice(-19),
        { at: nowMs(), from: record.importance, to: clamp01(target), by: 'user_pin', why: '钉住' },
      ],
    };
    updateMemory(this.db, updated);
    return toView(updated, this.config, nowMs());
  }

  /** 忘记：soft = 只标记失效（可审计），hard = 物理删除。 */
  forget(memoryId: string, hard = false): boolean {
    const record = getMemory(this.db, memoryId);
    if (!record) return false;
    if (hard) {
      this.db.tx(() => {
        this.db.run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [memoryId, memoryId]);
        this.db.run('DELETE FROM embeddings WHERE memory_id = ?', [memoryId]);
        this.db.run('DELETE FROM activations WHERE memory_id = ?', [memoryId]);
        this.db.run('DELETE FROM memories WHERE id = ?', [memoryId]);
      });
      this.vectors.markDirty();
      return true;
    }
    const ok = invalidateMemory(this.db, memoryId, 'manual', nowMs());
    return ok;
  }

  reindexAll(): Promise<number> {
    return this.vectors.reindexAll(this.embed, (id) => {
      const record = getMemory(this.db, id);
      return record ? record.gist || record.fact : null;
    });
  }

  /* ========================= 报表 ========================= */

  stats(): StatsReport {
    const total = countMemories(this.db);
    const byLevel: Record<string, number> = {};
    for (const row of this.db.all('SELECT level, COUNT(*) AS c FROM memories GROUP BY level')) {
      byLevel[String(row.level)] = Number(row.c);
    }
    const byOwner: Record<string, number> = {};
    for (const row of this.db.all('SELECT owner, COUNT(*) AS c FROM memories GROUP BY owner')) {
      byOwner[String(row.owner)] = Number(row.c);
    }
    const bySource: Record<string, number> = {};
    for (const row of this.db.all('SELECT source, COUNT(*) AS c FROM memories GROUP BY source')) {
      bySource[String(row.source)] = Number(row.c);
    }
    const locked = this.db.get('SELECT COUNT(*) AS c FROM memories WHERE locked = 1');
    const frozen = this.db.get('SELECT COUNT(*) AS c FROM memories WHERE read_only = 1');
    const invalid = this.db.get('SELECT COUNT(*) AS c FROM memories WHERE valid_to IS NOT NULL');
    const avg = this.db.get('SELECT AVG(importance) AS a FROM memories');
    const maxRecall = this.db.get('SELECT MAX(recall_count) AS m FROM memories');
    const sessions = this.db.get('SELECT COUNT(*) AS c FROM sessions');
    const range = this.db.get('SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM memories');
    const anchorRow = this.db.get(
      "SELECT COUNT(*) AS c FROM memories WHERE calendar_anchor IS NOT NULL AND calendar_anchor != '' AND valid_to IS NULL",
    );

    return {
      total,
      byLevel,
      byOwner,
      bySource,
      locked: locked ? Number(locked.c) : 0,
      frozen: frozen ? Number(frozen.c) : 0,
      invalidated: invalid ? Number(invalid.c) : 0,
      edges: countEdges(this.db),
      avgImportance: avg && avg.a != null ? round(Number(avg.a), 4) : 0,
      maxRecallCount: maxRecall && maxRecall.m != null ? Number(maxRecall.m) : 0,
      sessions: sessions ? Number(sessions.c) : 0,
      oldestAt: range && range.a != null ? Number(range.a) : null,
      newestAt: range && range.b != null ? Number(range.b) : null,
      calendarAnchored: anchorRow ? Number(anchorRow.c) : 0,
    };
  }

  explain(memoryId: string): ExplainResult | null {
    const record = getMemory(this.db, memoryId);
    if (!record) return null;
    const at = nowMs();
    const edges = this.db
      .all(
        'SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY w0 DESC LIMIT 50',
        [memoryId, memoryId],
      )
      .map((row) => ({
        toId: String(row.from_id) === memoryId ? String(row.to_id) : String(row.from_id),
        type: String(row.type),
        weight: Number(row.w0),
        hits: Number(row.hits),
      }));
    const activations = this.db
      .all('SELECT at, kind, session_id FROM activations WHERE memory_id = ? ORDER BY at DESC LIMIT 50', [memoryId])
      .map((row) => ({
        at: Number(row.at),
        kind: String(row.kind),
        sessionId: row.session_id == null ? null : String(row.session_id),
      }));
    return {
      memory: toView(record, this.config, at),
      edges,
      activations,
      since: {
        created: new Date(record.createdAt).toISOString(),
        lastFired: record.lastFiredAt ? new Date(record.lastFiredAt).toISOString() : null,
      },
    };
  }

  /** 全量导出（JSON）。备份最稳的方式仍然是直接复制 .db 文件。 */
  exportAll(): string {
    const dump = {
      format: 'mmtr-snapshot',
      version: 1,
      exportedAt: new Date().toISOString(),
      memories: this.db.all('SELECT * FROM memories'),
      edges: this.db.all('SELECT * FROM edges'),
      sessions: this.db.all('SELECT * FROM sessions'),
      sessionTurns: this.db.all('SELECT * FROM session_turns'),
      relation: this.db.all('SELECT * FROM relation_state'),
      relationLog: this.db.all('SELECT * FROM relation_log'),
      core: this.db.all('SELECT * FROM core_memory'),
      meta: this.db.all('SELECT * FROM meta'),
    };
    return JSON.stringify(dump, null, 2);
  }

  /** 人读的近期记忆列表，供 CLI / 调试面板用。 */
  list(limit = 20, includeInvalid = false): MemoryView[] {
    const at = nowMs();
    return queryMemories(this.db, { limit, includeInvalid }).map((r) => toView(r, this.config, at));
  }

  describeMemory(memoryId: string): string {
    const record = getMemory(this.db, memoryId);
    if (!record) return '(没有这条记忆)';
    const at = nowMs();
    const weights = computeWeights(record, this.config, at);
    const lines = [
      'id        ' + record.id,
      '时间      ' + timelineLabel(record, this.config, at) + '（L' + record.level + ' / 下限 L' + record.floorLevel + '）',
      '强度      fact ' + weights.fact.toFixed(3) + ' | gist ' + weights.gist.toFixed(3) + ' | affect ' + weights.affect.toFixed(3) + '（' + strengthLabel(weights) + '）',
      '重要性    ' + record.importance.toFixed(3) + (record.locked ? ' [锁定]' : '') + (record.readOnly ? ' [只读压缩态]' : ''),
      '归属      ' + record.owner + ' / 来源 ' + record.source,
      '回想次数  ' + record.recallCount,
      'gist      ' + (record.gist || '—'),
      'fact      ' + (record.fact || '—'),
    ];
    if (record.affect) lines.push('情绪      ' + record.affect.label + ' v=' + record.affect.valence + ' a=' + record.affect.arousal);
    if (record.calendarAnchor) lines.push('日历锚点  ' + JSON.stringify(record.calendarAnchor));
    if (record.validTo) lines.push('失效于    ' + new Date(record.validTo).toISOString() + '（被 ' + record.invalidatedBy + ' 推翻）');
    return lines.join('\n');
  }
}