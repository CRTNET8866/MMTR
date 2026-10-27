/* ============================================================================
 * 检索 (retrieve.ts)
 *
 * 混合检索流程：
 *   向量召回 → 沿边扩散（链式联想）→ 日历唤醒 → 重排 → 多样性裁剪 → 注入组装
 *
 * 三个防「检索自增强」的闸门：
 *   1. 回血增益随被想起次数递减
 *   2. 横向抑制：本轮刚用过的记忆降权
 *   3. importance 完全不受检索影响（这里根本拿不到写 importance 的入口）
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { Db } from './db.ts';
import type { EmbeddingProvider, VectorCache } from './embeddings.ts';
import type {
  Channel,
  MemoryRecord,
  MemoryView,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
} from './types.ts';
import { matchAnchor } from './calendar.ts';
import { activateAll, computeWeights, strengthLabel, timelineLabel } from './decay.ts';
import { expandFromSeeds, reinforceCoRetrieval } from './graph.ts';
import { applyImportance, getMemories, allValidIds, recentlyFiredIds, recordActivation, updateMemory } from './memory.ts';
import { estimateTokens, clamp01, naturalWhen, round, truncate } from './util.ts';

export interface RetrieveDeps {
  db: Db;
  config: MMTRConfig;
  vectors: VectorCache;
  embed: EmbeddingProvider;
}

export interface RetrieveOptions {
  sessionId?: string | null;
  turn?: number;
  /** 是否把「被想起」写回衰减状态，缺省 true */
  persistActivation?: boolean;
  /** 是否给共现的边做强化，缺省 true */
  reinforceEdges?: boolean;
}

/** 图扩散命中带来的加分权重 */
const GRAPH_BONUS = 0.18;

export async function retrieve(
  deps: RetrieveDeps,
  query: RetrievalQuery,
  now: number,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const { db, config, vectors, embed } = deps;
  const cfg = config.retrieval;
  const allow = allValidIds(db);
  const excluded = new Set(query.exclude || []);

  /* 1. 向量召回 */
  const topK = query.topK ?? cfg.vectorTopK;
  let seeds: Array<{ id: string; score: number }> = [];
  let queryVec: Float32Array | null = null;
  if (embed.name !== 'none' && query.text.trim().length > 0) {
    const [vec] = await embed.embed([query.text]);
    queryVec = vec;
    const allowFiltered = new Set<string>();
    for (const id of allow) if (!excluded.has(id)) allowFiltered.add(id);
    seeds = vectors.search(vec, topK, allowFiltered);
  }

  const seedMap = new Map<string, number>();
  const seedScoreRaw = new Map<string, number>();
  for (const s of seeds) {
    seedMap.set(s.id, s.score);
    seedScoreRaw.set(s.id, s.score);
  }

  /* 2. 图扩散 */
  let expansionNodes = new Map<string, { score: number; hop: number; via: string; edgeType: string | null }>();
  let expandedCount = 0;
  const doExpand = query.expand !== false && seedMap.size > 0;
  if (doExpand) {
    const expansion = expandFromSeeds(db, seedMap, config, now, allow, config.graph.maxHops, config.graph.maxExpanded);
    expansionNodes = expansion.nodes as typeof expansionNodes;
    expandedCount = expansion.visited;
  }

  /* 3. 收集候选并过滤 */
  let candidateIds = new Set<string>();
  if (!doExpand || seedMap.size === 0) {
    // 纯向量模式 / 无向量模式：回落到最近记忆
    for (const id of seedMap.keys()) candidateIds.add(id);
    if (candidateIds.size === 0) {
      const rows = db.all(
        'SELECT id FROM memories WHERE valid_to IS NULL ORDER BY created_at DESC LIMIT ?',
        [Math.max(8, Math.floor(topK / 2))],
      );
      for (const row of rows) candidateIds.add(String(row.id));
    }
  } else {
    for (const id of expansionNodes.keys()) candidateIds.add(id);
  }
  for (const id of excluded) candidateIds.delete(id);
  if (query.owners && query.owners.length > 0) {
    // 先粗筛，后面还会再按 owner 过滤
  }

  const records = getMemories(db, [...candidateIds]);
  const filtered = records.filter((m) => {
    if (m.validTo !== null) return false;
    if (query.owners && query.owners.length > 0 && query.owners.indexOf(m.owner) < 0) return false;
    if (query.before !== undefined && m.createdAt > query.before) return false;
    if (query.after !== undefined && m.createdAt < query.after) return false;
    return true;
  });

  /* 4. 打分 */
  const currentTurnIndex = options.turn ?? 0;
  const inhibitedIds = recentlyFiredIds(
    db,
    options.sessionId ?? query.sessionId ?? null,
    currentTurnIndex - cfg.lateralWindowTurns,
    currentTurnIndex,
  );
  const queryLower = query.text.toLowerCase();
  const calendarActivated: string[] = [];
  const hits: RetrievalHit[] = [];

  for (const record of filtered) {
    const weights = computeWeights(record, config, now);
    const reasons: string[] = [];
    const seedScore = seedScoreRaw.get(record.id) ?? 0;
    const node = expansionNodes.get(record.id);
    const hop = node ? node.hop : 0;
    const sim = clamp01(seedScore);

    if (sim > 0.02) reasons.push('语义命中');
    if (hop > 0) reasons.push('联想扩散' + hop + '跳');

    const calMatch = matchAnchor(record.calendarAnchor, now, config, config.session.wakeCalendarLookaheadDays);
    let calendarBoost = 0;
    if (calMatch.matched) {
      calendarBoost = calMatch.boost;
      calendarActivated.push(record.id);
      reasons.push('日历唤醒:' + calMatch.label);
    }

    let themeMatch = 0;
    if (record.themeKey && queryLower.includes(record.themeKey.toLowerCase())) themeMatch = 1;
    else if (record.tags.length > 0) {
      const hitTags = record.tags.filter((t) => t.length >= 2 && queryLower.includes(t.toLowerCase()));
      themeMatch = Math.min(1, hitTags.length / 2);
      if (hitTags.length > 0) reasons.push('主题吻合:' + hitTags.slice(0, 2).join(','));
    }

    const w = cfg.weights;
    let score =
      w.similarity * sim +
      w.gist * weights.gist +
      w.fact * weights.fact +
      w.affect * weights.affect +
      w.importance * record.importance +
      w.calendar * calendarBoost +
      w.theme * themeMatch;

    if (hop > 0) {
      score += GRAPH_BONUS * (node ? node.score : 0);
    }

    const penalties = cfg.penaltys;
    if (inhibitedIds.has(record.id)) {
      score -= penalties.lateralInhibition;
      reasons.push('刚用过(抑制)');
    }
    if (record.readOnly) {
      score -= penalties.readOnly;
      reasons.push('压缩态');
    }

    if (record.locked) reasons.push('锁定');
    if (weights.affect >= 0.55 && weights.fact < 0.15) reasons.push('只剩情绪残响');

    hits.push({
      memory: { ...record, weights, ageDays: round((now - record.createdAt) / 86400000, 2), frozen: record.readOnly || record.level >= 2 },
      score: round(score, 4),
      similarity: round(sim, 4),
      reasons,
      hop,
    });
  }

  hits.sort((a, b) => b.score - a.score);

  /* 5. 多样性裁剪（MMR） */
  const finalTopK = query.topK ?? cfg.finalTopK;
  const selected = mmrSelect(hits, finalTopK, cfg.mmrLambda, vectors);

  /* 6. 写回激活（复习回血）——注意这里永远不会碰 importance */
  if (options.persistActivation !== false && selected.length > 0) {
    persistActivations(deps, selected, now, options);
  }

  return {
    hits: selected,
    seeds: seeds.length,
    expanded: expandedCount,
    calendarActivated,
    tokensSpent: 0,
  };
}

function mmrSelect(hits: RetrievalHit[], k: number, lambda: number, vectors: VectorCache): RetrievalHit[] {
  if (hits.length <= k) return hits;
  const pool = hits.slice(0, Math.max(k * 3, 12));
  const selected: RetrievalHit[] = [];
  const vecCache = new Map<string, Float32Array | null>();
  const getVec = (id: string): Float32Array | null => {
    if (vecCache.has(id)) return vecCache.get(id) as Float32Array | null;
    const v = vectors.get(id);
    vecCache.set(id, v);
    return v;
  };
  const maxScore = Math.max(...pool.map((h) => h.score), 0.0001);

  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const relevance = cand.score / maxScore;
      let maxSim = 0;
      if (selected.length > 0) {
        const cv = getVec(cand.memory.id);
        if (cv) {
          for (const sel of selected) {
            const sv = getVec(sel.memory.id);
            if (!sv) continue;
            let dot = 0;
            const n = Math.min(cv.length, sv.length);
            for (let d = 0; d < n; d++) dot += cv[d] * sv[d];
            if (dot > maxSim) maxSim = dot;
          }
        }
      }
      const val = lambda * relevance - (1 - lambda) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    selected.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return selected;
}

function persistActivations(
  deps: RetrieveDeps,
  hits: RetrievalHit[],
  now: number,
  options: RetrieveOptions,
): void {
  const { db, config } = deps;
  const sessionId = options.sessionId ?? null;
  const turn = options.turn ?? 0;

  db.tx(() => {
    for (const hit of hits) {
      const record = hit.memory;
      const fresh = getMemories(db, [record.id])[0];
      if (!fresh) continue;
      const nextChannels = activateAll(fresh, config, now, fresh.recallCount);
      const updated: MemoryRecord = {
        ...fresh,
        channels: nextChannels,
        recallCount: fresh.recallCount + 1,
        lastFiredAt: now,
        fireCount24h: fresh.fireCount24h + 1,
        // 检索路径：这里只可能复制 importance，绝不可能修改它
        importance: fresh.importance,
      };
      updateMemory(db, updated);
      recordActivation(db, { memoryId: fresh.id, sessionId, turn, at: now, kind: 'recall' });
    }
    if (options.reinforceEdges !== false) {
      reinforceCoRetrieval(db, hits.map((h) => h.memory.id), config, now);
    }
  });
}

/* ---------- 注入组装 ---------- */

export interface AssembleOptions {
  personaName?: string;
  /** 标题行，缺省「记忆」 */
  title?: string;
  /** 是否附带「细节已不可考」的提示 */
  warnFrozen?: boolean;
  /** 渲染风格：quiet 只给事和感觉（默认），full 保留标签与强度 */
  style?: 'quiet' | 'full';
}

/**
 * 把检索结果组装成可直接拼进 prompt 的文本块。
 * 时间线显式标注是硬要求：不标时间，她就会把三个月前的事说成刚发生。
 */
export function assembleContext(
  hits: RetrievalHit[],
  config: MMTRConfig,
  now: number,
  options: AssembleOptions = {},
): { block: string; tokenEstimate: number; used: RetrievalHit[] } {
  const maxChars = config.retrieval.maxContextChars;
  const warn = options.warnFrozen !== false;
  const lines: string[] = [];
  const used: RetrievalHit[] = [];
  let chars = 0;

  const quiet = options.style !== 'full';

  for (const hit of hits) {
    const m: MemoryView = hit.memory;
    const when = timelineLabel(m, config, now);
    const strength = strengthLabel(m.weights);
    const mood = m.affect && Math.abs(m.affect.valence) > 0.25 ? '｜当时' + m.affect.label : '';
    const theme = m.themeKey ? '｜' + m.themeKey : '';
    const note = warn && (m.readOnly || m.level >= 2) ? '｜（摘要，细节已不可考，不要补全）' : '';
    const body = quiet
      ? m.gist || m.fact || '（只剩一个感觉，说不清了）'
      : m.gist || m.fact || m.tag || '（已只留下感觉）';
    const line = quiet
      ? '· ' + naturalWhen(m.createdAt, now, config.clock.dayStartHour) + '，' + truncate(body, 160)
      : '· [' + when + '｜' + strength + mood + theme + '] ' + truncate(body, 160) + note;
    if (chars + line.length > maxChars && used.length > 0) break;
    lines.push(line);
    used.push(hit);
    chars += line.length;
  }

  if (lines.length === 0) {
    return { block: '', tokenEstimate: 0, used };
  }

  const header = options.title || (quiet
    ? '【这会儿脑子里浮上来的】'
    : '【你记得的事（不是这一轮说的，别当成刚发生）】');
  const footer = quiet
    ? '（不是聊天记录，别整段复述；贴得上就顺着说，贴不上别提。偶尔一句「我记得…」正常，别每轮都强调。）'
    : '（以上都是你脑子里剩下的东西，不是原话。想不起来就直说想不起来，不要编。）';
  const block = header + '\n' + lines.join('\n') + '\n' + footer;

  return { block, tokenEstimate: estimateTokens(block), used };
}