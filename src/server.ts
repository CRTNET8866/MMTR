#!/usr/bin/env node
/* ============================================================================
 * HTTP 服务 (server.ts)
 *
 * 零依赖，只监听本机。启动：
 *   npm run server
 *   node --experimental-strip-types src/server.ts --port 7411 --host 127.0.0.1
 *
 * 鉴权：设置环境变量 MMTR_TOKEN 后，所有请求需带
 *       Authorization: Bearer <token>  或  ?token=<token>
 *
 * 所有接口都返回 JSON；出错时返回 { error: "..." } 与非 200 状态码。
 * 接口清单见 docs/02-接入文档.md
 * ==========================================================================*/

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MMTR } from './engine.ts';
import type { Owner, RetrievalQuery } from './types.ts';
import { formatDateTime, truncate } from './util.ts';

const HOST = String(process.env.MMTR_HOST || argOf('--host') || '127.0.0.1');
const PORT = Number(argOf('--port') || process.env.MMTR_PORT || 7411);
const TOKEN = String(process.env.MMTR_TOKEN || '');

function argOf(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

const ag = MMTR.open({ cwd: process.cwd() });

interface JsonBody {
  [key: string]: unknown;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<JsonBody> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw) as JsonBody);
      } catch (err) {
        reject(new Error('JSON 解析失败: ' + (err as Error).message));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true;
  const header = String(req.headers['authorization'] || '');
  if (header === 'Bearer ' + TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/* ---------- 路由 ---------- */

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method || 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }
  if (!authorized(req, url)) {
    send(res, 401, { error: '未授权：需要 Bearer token' });
    return;
  }

  /* 状态页 */
  if (path === '/' && method === 'GET') {
    const s = ag.stats();
    send(res, 200, {
      name: 'mmtr',
      version: 1,
      db: ag.db.path,
      llm: ag.brain.name,
      embedding: ag.embed.name,
      memories: s.total,
      sessions: s.sessions,
      endpoints: [
        'GET  /health',
        'GET  /wake?at=',
        'POST /ingest      {user, assistant, at?, pin?}',
        'POST /remember    {text, owner?, importance?}',
        'POST /context     {text, topK?}',
        'POST /retrieve    {text, topK?, owners?}',
        'POST /sleep       {reason?}',
        'POST /consolidate {}',
        'GET  /memory/:id',
        'GET  /list?limit=&invalid=',
        'POST /pin/:id     {importance?}',
        'POST /reweight/:id {delta, why?}',
        'POST /forget/:id  {hard?}',
        'GET  /core   |  POST /core  {key, title, content, mutable?}',
        'GET  /promises?state=pending|kept|broken|all',
        'POST /promise/:id {outcome: kept|broken}',
        'GET  /stats',
        'GET  /export',
      ],
    });
    return;
  }

  if (path === '/health' && method === 'GET') {
    send(res, 200, { ok: true, memories: ag.stats().total, llm: ag.brain.llmBacked, embedding: ag.embed.name });
    return;
  }

  if (path === '/wake' && method === 'GET') {
    const at = num(url.searchParams.get('at'));
    const state = await ag.wake(at ?? undefined, {
      format: url.searchParams.get('format') === 'full' ? 'full' : 'quiet',
    });
    send(res, 200, state);
    return;
  }

  if (path === '/ingest' && method === 'POST') {
    const body = await readBody(req);
    const user = str(body.user);
    const assistant = str(body.assistant);
    if (!user && !assistant) {
      send(res, 400, { error: '缺少 user / assistant' });
      return;
    }
    const result = await ag.ingest({
      user,
      assistant,
      at: num(body.at),
      sessionId: body.sessionId ? str(body.sessionId) : null,
      pin: body.pin === true,
    });
    send(res, 200, result);
    return;
  }

  if (path === '/remember' && method === 'POST') {
    const body = await readBody(req);
    const text = str(body.text);
    if (!text) {
      send(res, 400, { error: '缺少 text' });
      return;
    }
    const view = await ag.remember(text, {
      owner: (body.owner ? str(body.owner) : 'shared') as Owner,
      importance: num(body.importance),
      at: num(body.at),
    });
    send(res, 200, view);
    return;
  }

  if ((path === '/context' || path === '/retrieve') && method === 'POST') {
    const body = await readBody(req);
    const query: RetrievalQuery = {
      text: str(body.text),
      topK: num(body.topK),
      owners: Array.isArray(body.owners) ? (body.owners as Owner[]) : undefined,
      before: num(body.before),
      after: num(body.after),
      expand: body.expand === undefined ? undefined : body.expand === true,
    };
    if (path === '/context') {
      const ctx = await ag.getContext(query, { style: body.style === 'full' ? 'full' : 'quiet' });
      send(res, 200, ctx);
    } else {
      const result = await ag.retrieve(query);
      send(res, 200, result);
    }
    return;
  }

  if (path === '/sleep' && method === 'POST') {
    const body = await readBody(req);
    const r = await ag.sleep(body.reason ? str(body.reason) : 'api');
    send(res, 200, r);
    return;
  }

  if (path === '/consolidate' && method === 'POST') {
    const body = await readBody(req);
    const report = await ag.consolidate({ maxCompressions: num(body.maxCompressions) }, num(body.at));
    send(res, 200, report);
    return;
  }

  if (path.startsWith('/memory/') && method === 'GET') {
    const id = path.slice('/memory/'.length);
    const explain = ag.explain(id);
    if (!explain) {
      send(res, 404, { error: '没有这条记忆' });
      return;
    }
    send(res, 200, explain);
    return;
  }

  if (path === '/list' && method === 'GET') {
    const limit = num(url.searchParams.get('limit')) ?? 20;
    const includeInvalid = url.searchParams.get('invalid') === '1';
    const items = ag.list(limit, includeInvalid).map((m) => ({
      id: m.id,
      level: m.level,
      floorLevel: m.floorLevel,
      importance: m.importance,
      locked: m.locked,
      readOnly: m.readOnly,
      owner: m.owner,
      weights: m.weights,
      createdAt: m.createdAt,
      createdAtText: formatDateTime(m.createdAt, ag.config.clock.dayStartHour),
      gist: m.gist,
      tag: m.tag,
    }));
    send(res, 200, { count: items.length, items });
    return;
  }

  if (path.startsWith('/pin/') && method === 'POST') {
    const id = path.slice('/pin/'.length);
    const body = await readBody(req);
    const v = ag.pin(id, num(body.importance));
    send(res, v ? 200 : 404, v || { error: '没有这条记忆' });
    return;
  }

  if (path.startsWith('/reweight/') && method === 'POST') {
    const id = path.slice('/reweight/'.length);
    const body = await readBody(req);
    const v = ag.reweight(id, num(body.delta) ?? 0.1, body.why ? str(body.why) : 'api');
    send(res, v ? 200 : 404, v || { error: '没有这条记忆' });
    return;
  }

  if (path.startsWith('/forget/') && method === 'POST') {
    const id = path.slice('/forget/'.length);
    const body = await readBody(req);
    const ok = ag.forget(id, body.hard === true);
    send(res, ok ? 200 : 404, { ok });
    return;
  }

  if (path === '/core') {
    if (method === 'GET') {
      send(res, 200, { blocks: ag.getCore() });
      return;
    }
    const body = await readBody(req);
    const key = str(body.key);
    const title = str(body.title) || key;
    if (!key) {
      send(res, 400, { error: '缺少 key' });
      return;
    }
    const block = ag.setCore(key, title, str(body.content), body.mutable !== false);
    send(res, 200, block);
    return;
  }

  if (path === '/promises' && method === 'GET') {
    const state = (url.searchParams.get('state') || 'pending') as 'pending' | 'kept' | 'broken' | 'all';
    const items = ag.listPromises(state).map((p) => ({
      id: p.id,
      state: p.promiseState,
      dueAt: p.dueAt,
      clarity: p.promiseClarity,
      label: p.calendarAnchor?.label || p.tag || '',
      gist: p.gist,
      locked: p.locked,
    }));
    send(res, 200, { count: items.length, items });
    return;
  }

  if (path.startsWith('/promise/') && method === 'POST') {
    const id = path.slice('/promise/'.length);
    const body = await readBody(req);
    const outcome = str(body.outcome) === 'broken' ? 'broken' : 'kept';
    const v = ag.resolvePromise(id, outcome);
    if (!v) {
      send(res, 404, { error: '没有这条约定' });
      return;
    }
    send(res, 200, { id: v.id, state: v.promiseState, gist: v.gist, importance: v.importance });
    return;
  }

  if (path === '/stats' && method === 'GET') {
    send(res, 200, ag.stats());
    return;
  }

  if (path === '/export' && method === 'GET') {
    send(res, 200, JSON.parse(ag.exportAll()) as unknown);
    return;
  }

  send(res, 404, { error: '没有这个接口: ' + method + ' ' + path });
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || HOST + ':' + PORT));
  route(req, res, url).catch((err) => {
    const message = (err as Error).message || String(err);
    console.error('[mmtr:error] ' + truncate(message, 200));
    send(res, 500, { error: message });
  });
});

server.listen(PORT, HOST, () => {
  console.log('MMTR已启动: http://' + HOST + ':' + PORT);
  console.log('  数据库   ' + ag.db.path);
  console.log('  LLM      ' + ag.brain.name + (ag.brain.llmBacked ? '' : '（未连接，走启发式）'));
  console.log('  嵌入     ' + ag.embed.name);
  console.log('  鉴权     ' + (TOKEN ? '已启用' : '未启用（仅监听本机时建议保持关闭）'));
});

function shutdown(): void {
  console.log('\n正在关闭...');
  server.close();
  ag.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);