/* ============================================================================
 * 巩固 / 睡眠任务 (consolidate.ts)
 *
 * 「你的压缩阶梯，其实就是在做睡眠。」
 *
 * 这是一个离线任务：不该占用对话时的延迟，建议每天凌晨跑一次。
 * 它做四件事：
 *   1. 关系通道向基线回归（张力回落更快 —— 人会和解）
 *   2. 边衰减物化 + 清理死边
 *   3. 把跌破阈值的记忆压缩到下一级（事件驱动，不是全表刷）
 *   4. 冻结进入只读态的压缩记忆
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { Db } from './db.ts';
import type { EmbeddingProvider, VectorCache } from './embeddings.ts';
import type { Brain } from './llm.ts';
import type { ConsolidationReport, MemoryLevel, MemoryRecord, RelationDelta } from './types.ts';
import { evaluateCompression, levelIsFrozen } from './decay.ts';
import { decayEdges } from './graph.ts';
import { applyRelationDeltas, getRelationState, regressRelation, saveRelationState } from './relation.ts';
import { promiseRelationDelta, shouldBreakPromise } from './promise.ts';
import {
  getMemories,
  lastCompressionTimes,
  recordActivation,
  updateMemory,
} from './memory.ts';
import { round, truncate } from './util.ts';

export interface ConsolidateDeps {
  db: Db;
  config: MMTRConfig;
  brain: Brain;
  embed?: EmbeddingProvider;
  vectors?: VectorCache;
}

export interface ConsolidateOptions {
  /** 本次最多压缩多少条，防止一次跑爆 */
  maxCompressions?: number;
  /** 只跑某一部分：'compress' | 'edges' | 'relation' */
  only?: 'compress' | 'edges' | 'relation';
}

export async function consolidate(
  deps: ConsolidateDeps,
  now: number,
  options: ConsolidateOptions = {},
): Promise<ConsolidationReport> {
  const { db, config, brain } = deps;
  const report: ConsolidationReport = {
    ranAt: now,
    compressed: [],
    frozen: 0,
    promisesBroken: 0,
    edgesDecayed: 0,
    relationRegressed: false,
    calendarChecked: 0,
    skippedReasons: {},
  };

  /* 1. 关系回归 */
  if (config.consolidation.relationRegression && options.only !== 'compress' && options.only !== 'edges') {
    const state = getRelationState(db, config, now);
    const { dims, changed } = regressRelation(state, config, now);
    if (changed) {
      saveRelationState(db, { ...state, dims }, now, 'consolidation:regress', null);
      report.relationRegressed = true;
    }
  }

  /* 2. 边衰减 */
  if (config.consolidation.edgeDecay && options.only !== 'compress' && options.only !== 'relation') {
    const res = decayEdges(db, config, now);
    report.edgesDecayed = res.decayed + res.removed;
  }

  /* 3. 压缩 */
  if (options.only !== 'edges' && options.only !== 'relation') {
    const maxCompressions = options.maxCompressions ?? config.consolidation.maxCompressionsPerRun;
    const candidates = db.all(
      'SELECT * FROM memories WHERE valid_to IS NULL AND locked = 0 AND level < floor_level AND level < 3 ' +
        'ORDER BY s_fact ASC LIMIT ?',
      [maxCompressions * 3],
    );
    const lastCompress = lastCompressionTimes(db);
    const ids = candidates.map((row) => String(row.id));
    const records = getMemories(db, ids);

    let done = 0;
    for (const record of records) {
      if (done >= maxCompressions) break;
      const decision = evaluateCompression(record, config, now, lastCompress.get(record.id) ?? null);
      if (!decision.compress) {
        report.skippedReasons[decision.reason] = (report.skippedReasons[decision.reason] || 0) + 1;
        continue;
      }
      const updated = await compressOne(deps, record, decision.to, now);
      report.compressed.push({
        id: record.id,
        from: decision.from,
        to: decision.to,
        preview: truncate(updated.gist || updated.tag || '', 40),
      });
      if (levelIsFrozen(updated.level)) report.frozen++;
      done++;
    }
  }

  /* 3.5 前瞻记忆：到点没兑现的约定判「落空」，并给她一次失望（但张力消退更快） */
  if (options.only !== 'edges' && options.only !== 'relation') {
    const pending = getMemories(
      db,
      db
        .all("SELECT id FROM memories WHERE valid_to IS NULL AND promise_state = 'pending' AND due_at IS NOT NULL LIMIT 500")
        .map((row) => String(row.id)),
    );
    for (const record of pending) {
      if (record.dueAt === null) continue;
      if (!shouldBreakPromise(record.dueAt, record.promiseState, now, config)) continue;
      db.tx(() => {
        updateMemory(db, {
          ...record,
          promiseState: 'broken',
          note: (record.note ? record.note + ' | ' : '') + '约定落空',
        });
        recordActivation(db, { memoryId: record.id, sessionId: record.sessionId, turn: 0, at: now, kind: 'manual' });
      });
      const state = getRelationState(db, config, now);
      const delta = promiseRelationDelta('broken', config) as RelationDelta;
      const applied = applyRelationDeltas(state, delta, config, now);
      if (applied.applied !== null) {
        saveRelationState(db, { ...state, dims: applied.dims }, now, 'promise:broken', record.id);
      }
      report.promisesBroken += 1;
    }
  }

  /* 4. 日历锚点体检 */
  if (config.consolidation.calendarRefresh) {
    const row = db.get(
      "SELECT COUNT(*) AS c FROM memories WHERE valid_to IS NULL AND calendar_anchor IS NOT NULL AND calendar_anchor != ''",
    );
    report.calendarChecked = row ? Number(row.c) : 0;
  }

  return report;
}

/** 把一条记忆压到目标档位。压缩 = 再巩固，会留下轻微损伤。 */
export async function compressOne(
  deps: ConsolidateDeps,
  record: MemoryRecord,
  target: MemoryLevel,
  now: number,
): Promise<MemoryRecord> {
  const { db, config, brain } = deps;
  const out = await brain.compress({
    fact: record.fact,
    gist: record.gist,
    tag: record.tag,
    targetLevel: target,
    affect: record.affect,
  });

  const factor = config.levels.perStepStrengthFactor;
  const channels = {
    fact: {
      // 压缩后重新起算，并保留一次轻微损伤
      strength: round(Math.min(record.channels.fact.strength, config.levels.compressThresholds[String(record.level) as '0' | '1' | '2']) * factor, 6),
      updatedAt: now,
    },
    gist: { strength: record.channels.gist.strength, updatedAt: record.channels.gist.updatedAt },
    affect: { strength: record.channels.affect.strength, updatedAt: record.channels.affect.updatedAt },
  };

  const updated: MemoryRecord = {
    ...record,
    level: target,
    fact: target >= 2 ? '' : out.fact,
    gist: out.gist || record.gist,
    tag: out.tag || record.tag,
    // 原始对话只在「够重要且还没被压到摘要级」时保留
    raw: target >= 1 && !record.locked ? null : record.raw,
    rawRetained: target >= 1 && !record.locked ? false : record.rawRetained,
    channels,
    readOnly: levelIsFrozen(target),
    compressionCount: record.compressionCount + 1,
    note: (record.note ? record.note + ' | ' : '') + 'L' + record.level + '→L' + target,
  };

  db.tx(() => {
    updateMemory(db, updated);
    recordActivation(db, { memoryId: record.id, sessionId: record.sessionId, turn: 0, at: now, kind: 'compress' });
  });

  // gist 变了，向量要跟着变，否则检索会漂
  if (deps.embed && deps.vectors && deps.embed.name !== 'none') {
    try {
      const [vec] = await deps.embed.embed([updated.gist || updated.tag || updated.fact]);
      deps.vectors.put(updated.id, vec, deps.embed.name);
    } catch {
      /* 向量更新失败不影响记忆本身 */
    }
  }

  return updated;
}