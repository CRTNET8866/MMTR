/* ============================================================================
 * 嵌入层 (embeddings.ts)
 *
 * 两种模式：
 *   local              —— 零依赖字符 n-gram 哈希向量，开箱即用，质量一般但够跑通
 *   openai-compatible  —— 任何兼容 /v1/embeddings 的服务（bge-m3、text-embedding-3）
 * 向量一律 L2 归一化，检索时点积即余弦。
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { Db } from './db.ts';
import { fromFloat32, toFloat32 } from './db.ts';
import { cosine, fnv1a, normalizeVector, truncate } from './util.ts';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** 把文本切成用于哈希向量的 token（中文按字/二元组，英文按词）。 */
export function tokenizeForEmbedding(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const s = (text || '').toLowerCase();
  let latin = '';
  const flushLatin = (): void => {
    if (latin.length > 0) {
      out.push([latin, 1.3]);
      if (latin.length > 3) {
        // 便于词形相近时仍有重叠
        out.push([latin.slice(0, 4) + '*', 0.6]);
      }
      latin = '';
    }
  };
  const isCjk = (cp: number): boolean =>
    (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);

  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0) || 0;
    if (isCjk(cp)) {
      flushLatin();
      out.push([ch, 1]);
      const nextCh = chars[i + 1];
      const nextCp = nextCh ? nextCh.codePointAt(0) || 0 : 0;
      if (nextCh && isCjk(nextCp)) {
        out.push([ch + nextCh, 1.8]);
      }
      continue;
    }
    if (/[a-z0-9_]/.test(ch)) {
      latin += ch;
      continue;
    }
    flushLatin();
    if (ch.trim().length > 0 && !/[，。！？、；：""''（）《》…—,.!?;:"'()\[\]{}]/.test(ch)) {
      out.push([ch, 0.4]);
    }
  }
  flushLatin();
  return out;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-ngram';
  readonly dim: number;

  constructor(dim: number) {
    this.dim = Math.max(64, Math.floor(dim));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = tokenizeForEmbedding(truncate(text || '', 2000));
    for (const [tok, w] of tokens) {
      const h = fnv1a(tok);
      const idx = h % this.dim;
      const sign = (h >>> 16) & 1 ? -1 : 1;
      v[idx] += sign * w;
    }
    return normalizeVector(v);
  }
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private batchSize: number;

  constructor(config: MMTRConfig) {
    this.baseUrl = config.embedding.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.embedding.apiKey;
    this.model = config.embedding.model;
    this.timeoutMs = config.embedding.timeoutMs;
    this.batchSize = Math.max(1, config.embedding.batchSize);
    this.dim = config.embedding.dim;
    this.name = 'http:' + this.model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.callBatch(batch);
      for (const v of vectors) out.push(normalizeVector(v));
    }
    return out;
  }

  private async callBatch(batch: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;

    const res = await fetch(this.baseUrl + '/embeddings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input: batch, encoding_format: 'float' }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('嵌入服务返回 ' + res.status + ': ' + truncate(body, 300));
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = json.data || [];
    const result: Float32Array[] = new Array(batch.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const idx = typeof row.index === 'number' ? row.index : i;
      result[idx] = Float32Array.from(row.embedding || []);
    }
    for (let i = 0; i < batch.length; i++) {
      if (!result[i]) result[i] = new Float32Array(this.dim);
    }
    return result;
  }
}

export function createEmbeddingProvider(config: MMTRConfig): EmbeddingProvider {
  if (config.embedding.provider === 'openai-compatible') {
    return new HttpEmbeddingProvider(config);
  }
  if (config.embedding.provider === 'none') {
    return new NullEmbeddingProvider(config.embedding.dim);
  }
  return new LocalEmbeddingProvider(config.embedding.dim);
}

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly dim: number;

  constructor(dim: number) {
    this.dim = Math.max(64, Math.floor(dim));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dim));
  }
}

/* ============================================================================
 * 向量缓存 —— 全库 embedding 常驻内存的连续矩阵，暴力余弦检索
 *
 * 单机陪伴场景的记忆量级（十年也到不了十万条），暴力扫描比引入 ANN 索引
 * 更简单、更准、更好调试。10 万条 × 512 维 ≈ 205MB，可控。
 * ==========================================================================*/

export interface VectorHit {
  id: string;
  score: number;
}

export class VectorCache {
  private db: Db;
  private ids: string[] = [];
  private matrix: Float32Array | null = null;
  private dim = 0;
  private index = new Map<string, number>();
  private dirty = true;

  constructor(db: Db) {
    this.db = db;
  }

  markDirty(): void {
    this.dirty = true;
  }

  get size(): number {
    this.ensure();
    return this.ids.length;
  }

  private ensure(): void {
    if (!this.dirty && this.matrix) return;
    const rows = this.db.all('SELECT memory_id, dim, vec FROM embeddings');
    const count = rows.length;
    const first = rows[0];
    const dim = first ? Number(first.dim) : 0;
    const matrix = new Float32Array(count * Math.max(1, dim));
    const ids: string[] = new Array(count);
    const index = new Map<string, number>();
    let offset = 0;
    for (let i = 0; i < count; i++) {
      const row = rows[i];
      const rowDim = Number(row.dim);
      const buf = row.vec as Uint8Array;
      const vec = toFloat32(buf);
      ids[i] = String(row.memory_id);
      index.set(ids[i], i);
      if (rowDim === dim) {
        matrix.set(vec, offset);
      }
      offset += dim;
    }
    this.ids = ids;
    this.matrix = matrix;
    this.dim = dim;
    this.index = index;
    this.dirty = false;
  }

  put(id: string, vec: Float32Array, model: string): void {
    const dim = vec.length;
    this.db.run(
      'INSERT INTO embeddings(memory_id, dim, model, vec) VALUES(?, ?, ?, ?) ' +
        'ON CONFLICT(memory_id) DO UPDATE SET dim = excluded.dim, model = excluded.model, vec = excluded.vec',
      [id, dim, model, fromFloat32(normalizeVector(vec))],
    );
    this.dirty = true;
  }

  get(id: string): Float32Array | null {
    const row = this.db.get('SELECT dim, vec FROM embeddings WHERE memory_id = ?', [id]);
    if (!row) return null;
    return toFloat32(row.vec as Uint8Array);
  }

  remove(id: string): void {
    this.db.run('DELETE FROM embeddings WHERE memory_id = ?', [id]);
    this.dirty = true;
  }

  /** 暴力扫描，返回 top-K。allow 为可选白名单（通常是「未失效」的记忆集合）。 */
  search(query: Float32Array, topK: number, allow?: Set<string>): VectorHit[] {
    this.ensure();
    if (!this.matrix || this.ids.length === 0) return [];
    const dim = this.dim;
    if (dim === 0 || query.length !== dim) {
      // 维度不匹配（换过嵌入模型）：退化为全零，由调用方决定是否 reindex
      return [];
    }
    const q = normalizeVector(query);
    const hits: VectorHit[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      if (allow && !allow.has(this.ids[i])) continue;
      let dot = 0;
      const base = i * dim;
      for (let d = 0; d < dim; d++) dot += q[d] * this.matrix[base + d];
      if (dot > 0.001) hits.push({ id: this.ids[i], score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  /** 给已有记忆重新算向量（换模型后 reindex 用）。 */
  async reindexAll(
    provider: EmbeddingProvider,
    fetchText: (id: string) => string | null,
    batchSize = 32,
  ): Promise<number> {
    const rows = this.db.all('SELECT id FROM memories');
    const ids = rows.map((r) => String(r.id));
    let done = 0;
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const texts = chunk.map((id) => fetchText(id) || '');
      const vectors = await provider.embed(texts);
      this.db.tx(() => {
        for (let j = 0; j < chunk.length; j++) {
          this.put(chunk[j], vectors[j] || new Float32Array(provider.dim), provider.name);
        }
      });
      done += chunk.length;
    }
    this.dirty = true;
    return done;
  }
}