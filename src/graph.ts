/* ============================================================================
 * 联想图 (graph.ts)
 *
 * 「说到过节，就能想到一起过的每个节日，但只要找到其中一个，就能串到整条链。」
 *
 * 关键设计：
 *   1. 边也有权重，也会衰减 —— 只让节点衰减会导致枢纽永远亮着。
 *   2. 扩散时对高连接度节点做阻尼 —— 抗枢纽污染，防「过节」这种超级节点
 *      在每次检索里都强行插一脚。
 *   3. 边是双向的：一条链接就是一条链接。
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { Db } from './db.ts';
import type { EdgeRecord, EdgeType, EdgeView } from './types.ts';
import { MS_DAY, clamp01, newId, powerDecay, round } from './util.ts';

export interface EdgeInput {
  fromId: string;
  toId: string;
  type: EdgeType;
  weight: number;
  at: number;
}

export function upsertEdge(db: Db, input: EdgeInput): void {
  if (input.fromId === input.toId) return;
  const existing = db.get('SELECT id, w0 FROM edges WHERE from_id = ? AND to_id = ? AND type = ?', [
    input.fromId,
    input.toId,
    input.type,
  ]);
  if (existing) {
    db.run('UPDATE edges SET w0 = ?, t0 = ?, hits = hits + 1 WHERE id = ?', [
      round(clamp01(Math.max(Number(existing.w0), input.weight)), 4),
      input.at,
      String(existing.id),
    ]);
    return;
  }
  db.run('INSERT INTO edges(id, from_id, to_id, type, w0, t0, hits, created_at) VALUES(?, ?, ?, ?, ?, ?, 1, ?)', [
    newId('e'),
    input.fromId,
    input.toId,
    input.type,
    round(clamp01(input.weight), 4),
    input.at,
    input.at,
  ]);
}

export function edgeWeight(edge: EdgeRecord, config: MMTRConfig, now: number): number {
  const cfg = config.graph.edge;
  const ageDays = Math.max(0, now - edge.t0) / MS_DAY;
  const ageInTau = ageDays / Math.max(0.0001, cfg.tauDays);
  const decay = powerDecay(ageInTau, cfg.power);
  const factor = Math.max(cfg.floorFactor, decay);
  return clamp01(edge.w0 * factor);
}

function rowToEdge(row: Record<string, unknown>): EdgeRecord {
  return {
    id: String(row.id),
    fromId: String(row.from_id),
    toId: String(row.to_id),
    type: String(row.type) as EdgeType,
    w0: Number(row.w0),
    t0: Number(row.t0),
    hits: Number(row.hits),
    createdAt: Number(row.created_at),
  };
}

/** 取某个节点全部邻接边（双向）。 */
export function edgesOf(db: Db, id: string): EdgeRecord[] {
  const rows = db.all('SELECT * FROM edges WHERE from_id = ? OR to_id = ?', [id, id]);
  return rows.map(rowToEdge);
}

export function allEdges(db: Db, limit = 100000): EdgeRecord[] {
  const rows = db.all('SELECT * FROM edges ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows.map(rowToEdge);
}

export function toEdgeViews(edges: EdgeRecord[], config: MMTRConfig, now: number): EdgeView[] {
  return edges.map((e) => ({ ...e, weight: edgeWeight(e, config, now) }));
}

/* ---------- 连接度（用于枢纽阻尼） ---------- */

export function buildDegreeMap(db: Db): Map<string, number> {
  const map = new Map<string, number>();
  const out = db.all('SELECT from_id AS id, COUNT(*) AS c FROM edges GROUP BY from_id');
  for (const row of out) map.set(String(row.id), Number(row.c));
  const inc = db.all('SELECT to_id AS id, COUNT(*) AS c FROM edges GROUP BY to_id');
  for (const row of inc) {
    const id = String(row.id);
    map.set(id, (map.get(id) || 0) + Number(row.c));
  }
  return map;
}

export function hubDampingFactor(degree: number): number {
  // log 阻尼：连接度 1 → 1.0；10 → 0.5；100 → 0.34；1000 → 0.25
  return 1 / (1 + Math.log(1 + Math.max(0, degree)));
}

/* ---------- 扩散激活 ---------- */

export interface ExpansionNode {
  score: number;
  hop: number;
  via: string;
  edgeType: EdgeType | null;
}

export interface ExpansionResult {
  nodes: Map<string, ExpansionNode>;
  visited: number;
  edgesTouched: number;
}

/**
 * 从种子节点扩散。这是「只要找到其中一个记忆，就能串到整条链」的实现。
 * 注意：不遍历全库，只走边。
 */
export function expandFromSeeds(
  db: Db,
  seeds: Map<string, number>,
  config: MMTRConfig,
  now: number,
  allow: Set<string> | null,
  maxHops?: number,
  maxExpanded?: number,
): ExpansionResult {
  const cfg = config.graph;
  const hops = maxHops ?? cfg.maxHops;
  const cap = maxExpanded ?? cfg.maxExpanded;
  const minPath = cfg.minPathScore;
  const degree = cfg.hubDamping ? buildDegreeMap(db) : null;

  const nodes = new Map<string, ExpansionNode>();
  for (const [id, score] of seeds) {
    nodes.set(id, { score, hop: 0, via: id, edgeType: null });
  }

  let frontier = new Map<string, number>(seeds);
  let visited = 0;
  let edgesTouched = 0;

  for (let hop = 1; hop <= hops; hop++) {
    const next = new Map<string, number>();
    for (const [id, score] of frontier) {
      const edges = edgesOf(db, id);
      edgesTouched += edges.length;
      for (const edge of edges) {
        const otherId = edge.fromId === id ? edge.toId : edge.fromId;
        if (allow && !allow.has(otherId)) continue;
        const w = edgeWeight(edge, config, now);
        const damp = degree ? hubDampingFactor(degree.get(otherId) || 0) : 1;
        const pathScore = score * w * cfg.hopDecay * damp;
        if (pathScore < minPath) continue;
        const prev = nodes.get(otherId);
        if (prev && prev.score >= pathScore) continue;
        nodes.set(otherId, { score: pathScore, hop, via: id, edgeType: edge.type });
        next.set(otherId, pathScore);
        visited++;
        if (nodes.size > cap * 4) break;
      }
      if (nodes.size > cap * 4) break;
    }
    if (next.size === 0) break;
    // 只保留最强的 cap 个继续扩散
    const sorted = [...next.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap);
    frontier = new Map(sorted);
  }

  // 只保留 hop >= 1 的新节点，并按分数裁剪到 cap
  const hits = [...nodes.entries()].filter(([, n]) => n.hop > 0);
  hits.sort((a, b) => b[1].score - a[1].score);
  const kept = new Set(hits.slice(0, cap).map(([id]) => id));

  const result = new Map<string, ExpansionNode>();
  for (const [id, node] of nodes) {
    if (node.hop === 0 || kept.has(id)) result.set(id, node);
  }
  return { nodes: result, visited, edgesTouched };
}

/* ---------- 边的共同强化与衰减 ---------- */

/** 同一次检索里被一起用到的记忆，之间的边被强化 —— 强化的是「这条联想好用」。 */
export function reinforceCoRetrieval(
  db: Db,
  ids: string[],
  config: MMTRConfig,
  now: number,
): number {
  if (ids.length < 2) return 0;
  const idSet = new Set(ids);
  let count = 0;
  for (const fromId of ids) {
    const edges = edgesOf(db, fromId);
    for (const edge of edges) {
      const otherId = edge.fromId === fromId ? edge.toId : edge.fromId;
      if (!idSet.has(otherId)) continue;
      if (edge.fromId !== fromId) continue; // 每条边只处理一次
      const w = edgeWeight(edge, config, now);
      const next = clamp01(w + config.graph.edge.reinforce * (1 - w));
      db.run('UPDATE edges SET w0 = ?, t0 = ?, hits = hits + 1 WHERE id = ?', [round(next, 4), now, edge.id]);
      count++;
    }
  }
  return count;
}

/** 把边的衰减物化一次，并清掉已经退到地板的弱边。由巩固任务调用。 */
export function decayEdges(db: Db, config: MMTRConfig, now: number): { decayed: number; removed: number } {
  const cfg = config.graph.edge;
  const stale = cfg.tauDays * MS_DAY;
  const rows = db.all('SELECT * FROM edges WHERE t0 <= ? LIMIT 5000', [now - stale]);
  let decayed = 0;
  let removed = 0;
  for (const row of rows) {
    const edge = rowToEdge(row);
    const w = edgeWeight(edge, config, now);
    if (w < cfg.pruneBelow && edge.hits <= 1) {
      db.run('DELETE FROM edges WHERE id = ?', [edge.id]);
      removed++;
      continue;
    }
    db.run('UPDATE edges SET w0 = ?, t0 = ? WHERE id = ?', [round(w, 5), now, edge.id]);
    decayed++;
  }
  return { decayed, removed };
}

export function countEdges(db: Db): number {
  const row = db.get('SELECT COUNT(*) AS c FROM edges');
  return row ? Number(row.c) : 0;
}

export function deleteEdgesOf(db: Db, id: string): void {
  db.run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [id, id]);
}