#!/usr/bin/env node
/* ============================================================================
 * 命令行 (cli.ts)
 *
 * 用法：
 *   node --experimental-strip-types src/cli.ts <命令> [参数]
 *   或 npm run cli -- <命令>
 *
 * 命令一览：
 *   init                               初始化目录与示例配置
 *   chat                               交互式聊天（需要配置 LLM），自动记忆
 *   ingest --user X --assistant Y      写入一轮对话
 *   wake [--json]                      打印唤醒态
 *   query <文本> [--topk N]            检索并打印可注入的记忆块
 *   sleep                              结算当前会话
 *   consolidate                        跑一次巩固（睡眠任务）
 *   list [--limit N] [--invalid]       列出记忆
 *   show <id>                          看一条记忆的全部细节
 *   pin <id>                           锁死一条记忆（永不压缩）
 *   reweight <id> <delta> [--why 原因]  回溯式重加权
 *   forget <id> [--hard]               忘记（默认只失效，--hard 物理删除）
 *   core [show] | core set <key> <标题> <内容>
 *   promises [pending|kept|broken|all]  列出约定（前瞻记忆）
 *   resolve <id> [kept|broken]         标记约定兑现/落空
 *   stats                              统计
 *   export <路径>                      导出 JSON 快照
 *   reindex                            重建向量（换嵌入模型后用）
 *   config                             打印解析后的配置
 *   doctor                             环境自检
 * ==========================================================================*/

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { MMTR } from './engine.ts';
import { ChatClient } from './llm.ts';
import { describeAnchor } from './calendar.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { MS_DAY, formatDateTime, truncate } from './util.ts';

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const args = argv.slice(2);
  const command = args.shift() || 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function openEngine(): MMTR {
  return MMTR.open({ cwd: process.cwd() });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/* ---------- init ---------- */

function cmdInit(): void {
  const cwd = process.cwd();
  mkdirSync(resolve(cwd, 'data'), { recursive: true });
  const configPath = resolve(cwd, 'mmtr.config.json');
  if (!existsSync(configPath)) {
    const example = {
      dbPath: './data/mmtr.db',
      logLevel: 'info',
      llm: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        model: 'deepseek-chat',
      },
      embedding: {
        provider: 'local',
        dim: 512,
      },
      wake: {
        personaName: '她',
        userName: 'TA',
      },
      clock: { dayStartHour: 4 },
    };
    writeFileSync(configPath, JSON.stringify(example, null, 2), 'utf8');
    console.log('已生成配置文件: ' + configPath);
    console.log('  把 llm.provider 改成 deepseek 并设置环境变量 DEEPSEEK_API_KEY 即可接入真实模型。');
  } else {
    console.log('配置文件已存在: ' + configPath);
  }
  const ag = openEngine();
  console.log('数据库已就绪: ' + ag.db.path);
  console.log('记忆条数: ' + ag.stats().total);
  ag.close();
}

/* ---------- chat ---------- */

const CHAT_SYSTEM_PREFIX = [
  '你要扮演一个人，不是助手。',
  '下面是你此刻的状态和你记得的事。它们不是这一轮对话的内容。',
  '你可以忘了细节，但不能凭空编造细节；想不起来就直说想不起来。',
].join('\n');

async function cmdChat(flags: Record<string, string | boolean>): Promise<void> {
  const ag = openEngine();
  const client = new ChatClient(ag.config);
  if (!client.available) {
    console.error('聊天模式需要配置 LLM（mmtr.config.json 里 llm.provider + API Key 环境变量）。');
    console.error('如果只想记录对话，请用: npm run cli -- ingest --user "..." --assistant "..."');
    ag.close();
    process.exitCode = 2;
    return;
  }

  const wake = await ag.wake();
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const persona = ag.config.wake.personaName;

  console.log('=== 唤醒态 ===');
  console.log(wake.systemBlock);
  console.log('');
  console.log('输入 /bye 结束并结算本次会话，/wake 重新打印唤醒态，/context <文本> 看检索结果。');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string | null> =>
    new Promise((res) => {
      rl.question(q, (answer) => res(answer));
      rl.once('close', () => res(null));
    });

  let running = true;
  while (running) {
    const raw = await ask('你: ');
    if (raw === null) break;
    const text = raw.trim();
    if (!text) continue;
    if (text === '/bye' || text === '/exit') {
      running = false;
      break;
    }
    if (text === '/wake') {
      const w = await ag.wake();
      console.log(w.systemBlock);
      continue;
    }
    if (text.startsWith('/context ')) {
      const ctx = await ag.getContext({ text: text.slice(9) });
      console.log(ctx.block || '(没有相关记忆)');
      continue;
    }

    const ctx = await ag.getContext({ text });
    const system = [CHAT_SYSTEM_PREFIX, '', wake.systemBlock, '', ctx.block].filter(Boolean).join('\n');
    history.push({ role: 'user', content: text });
    if (history.length > 20) history.splice(0, history.length - 20);

    const reply = await client.chat([
      { role: 'system', content: system },
      ...history.map((h) => ({ role: h.role, content: h.content })),
    ]);
    history.push({ role: 'assistant', content: reply });
    console.log(persona + ': ' + reply);

    const result = await ag.ingest({ user: text, assistant: reply });
    const parts: string[] = [];
    if (result.stored.length > 0) parts.push('记住 ' + result.stored.length + ' 条');
    if (result.merged.length > 0) parts.push('强化 ' + result.merged.length + ' 条');
    if (result.skipped.length > 0) parts.push('忽略 ' + result.skipped.length + ' 条');
    console.log('  [记忆] ' + (parts.join('，') || '无') + '  (' + truncate(text, 20) + ')');
  }

  rl.close();
  const slept = await ag.sleep('cli-chat');
  console.log('\n本次会话结束。关系: ' + JSON.stringify(slept.relation.dims));
  if (slept.openThread) console.log('未说完的: ' + slept.openThread);
  ag.close();
}

/* ---------- 其它命令 ---------- */

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  if (command === 'help' || flags.help) {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const doc = src.slice(0, src.indexOf('=*'.repeat(0) + '*/'));
    console.log(doc.replace(/^#!.*\n/, ''));
    return;
  }

  if (command === 'init') {
    cmdInit();
    return;
  }

  if (command === 'doctor') {
    console.log('node        ' + process.version);
    console.log('cwd         ' + process.cwd());
    const ag = openEngine();
    console.log('db          ' + ag.db.path);
    console.log('llm         ' + ag.config.llm.provider + ' / ' + ag.config.llm.model + (ag.brain.llmBacked ? '（已连接）' : '（未连接，走启发式）'));
    console.log('embedding   ' + ag.embed.name + ' dim=' + ag.embed.dim);
    console.log('记忆        ' + ag.stats().total + ' 条');
    ag.close();
    return;
  }

  if (command === 'chat') {
    await cmdChat(flags);
    return;
  }

  const ag = openEngine();

  try {
    switch (command) {
      case 'ingest': {
        const user = String(flags.user ?? positional[0] ?? '');
        const assistant = String(flags.assistant ?? positional[1] ?? '');
        if (!user && !assistant) throw new Error('需要 --user 与 --assistant');
        const at = flags.at ? Number(flags.at) : undefined;
        const result = await ag.ingest({ user, assistant, at, pin: flags.pin === true });
        printJson({
          sessionId: result.sessionId,
          stored: result.stored.map((m) => ({ id: m.id, importance: m.importance, gist: m.gist, locked: m.locked, floorLevel: m.floorLevel })),
          merged: result.merged.map((m) => ({ id: m.id, gist: m.gist })),
          skipped: result.skipped,
        });
        break;
      }

      case 'wake': {
        const at = flags.at ? Number(flags.at) : undefined;
        const state = await ag.wake(at, { format: flags.full ? 'full' : 'quiet' });
        if (flags.json) printJson(state);
        else {
          console.log(state.systemBlock);
          console.log('\n[tokens ≈ ' + state.tokenEstimate + ']');
        }
        break;
      }

      case 'query': {
        const text = positional.join(' ') || String(flags.text ?? '');
        if (!text) throw new Error('需要检索文本');
        const topK = flags.topk ? Number(flags.topk) : undefined;
        const ctx = await ag.getContext({ text, topK });
        if (flags.json) printJson(ctx);
        else {
          console.log(ctx.block || '(没有相关记忆)');
          console.log('\n[tokens ≈ ' + ctx.tokenEstimate + '，命中 ' + ctx.hits.length + ' 条]');
        }
        break;
      }

      case 'sleep': {
        const r = await ag.sleep('cli');
        printJson({ relation: r.relation.dims, openThread: r.openThread, summaryMemoryId: r.summaryMemoryId });
        break;
      }

      case 'consolidate': {
        const report = await ag.consolidate();
        printJson(report);
        break;
      }

      case 'list': {
        const limit = flags.limit ? Number(flags.limit) : 20;
        const list = ag.list(limit, flags.invalid === true);
        for (const m of list) {
          console.log(
            m.id + '  L' + m.level + '/L' + m.floorLevel +
            '  重要 ' + m.importance.toFixed(2) +
            (m.locked ? ' [锁定]' : '') +
            '  f' + m.weights.fact.toFixed(2) + ' g' + m.weights.gist.toFixed(2) + ' a' + m.weights.affect.toFixed(2) +
            '  ' + formatDateTime(m.createdAt, ag.config.clock.dayStartHour) +
            '  ' + truncate((m.gist || m.tag || '').replace(/\n/g, ' '), 46)
          );
        }
        console.log('\n共 ' + list.length + ' 条');
        break;
      }

      case 'show': {
        const id = positional[0];
        if (!id) throw new Error('需要记忆 id');
        console.log(ag.describeMemory(id));
        const ex = ag.explain(id);
        if (ex) {
          console.log('\n联想边 ' + ex.edges.length + ' 条：');
          for (const e of ex.edges.slice(0, 10)) console.log('  ' + e.type + ' → ' + e.toId + ' (w=' + e.weight.toFixed(3) + ', hits=' + e.hits + ')');
          console.log('最近激活：' + ex.activations.slice(0, 5).map((a) => a.kind + '@' + new Date(a.at).toISOString().slice(0, 16)).join(', '));
        }
        break;
      }

      case 'pin': {
        const id = positional[0];
        if (!id) throw new Error('需要记忆 id');
        const v = ag.pin(id);
        console.log(v ? '已锁定：' + v.gist : '没找到');
        break;
      }

      case 'reweight': {
        const id = positional[0];
        const delta = Number(positional[1] ?? 0.1);
        if (!id) throw new Error('需要记忆 id 与增量');
        const v = ag.reweight(id, delta, String(flags.why ?? 'user_initiated'));
        console.log(v ? '现在的重要度: ' + v.importance : '没找到');
        break;
      }

      case 'forget': {
        const id = positional[0];
        if (!id) throw new Error('需要记忆 id');
        const ok = ag.forget(id, flags.hard === true);
        console.log(ok ? (flags.hard === true ? '已物理删除' : '已标记失效（可审计）') : '没找到');
        break;
      }

      case 'core': {
        const sub = positional[0] || 'show';
        if (sub === 'show') {
          for (const b of ag.getCore()) console.log('[' + b.key + '] ' + b.title + '：' + (b.content || '(空)'));
        } else if (sub === 'set') {
          const key = positional[1];
          const title = positional[2];
          const content = positional.slice(3).join(' ');
          if (!key || !title) throw new Error('用法: core set <key> <标题> <内容>');
          ag.setCore(key, title, content);
          console.log('已写入常驻记忆: ' + key);
        } else {
          throw new Error('未知子命令: ' + sub);
        }
        break;
      }

      case 'promises': {
        const state = String(positional[0] ?? 'pending') as 'pending' | 'kept' | 'broken' | 'all';
        const list = ag.listPromises(state);
        if (list.length === 0) {
          console.log('（没有' + (state === 'all' ? '' : state + ' 的') + '约定）');
          break;
        }
        const now = Date.now();
        for (const p of list) {
          const days = p.dueAt === null ? NaN : (p.dueAt - now) / 86400000;
          const when = Number.isNaN(days)
            ? '—'
            : days >= 0
              ? Math.round(days) + ' 天后'
              : Math.abs(Math.round(days)) + ' 天前';
          console.log(
            p.id + '  [' + p.promiseState + ']  清晰度 ' + (p.promiseClarity ?? 0).toFixed(2) +
            '  到期 ' + when + '  ' + (p.calendarAnchor?.label || p.tag || '') + '  ' + p.gist,
          );
        }
        console.log('\\n共 ' + list.length + ' 条');
        break;
      }

      case 'resolve': {
        const id = positional[0];
        const outcome = (positional[1] || 'kept') as 'kept' | 'broken';
        if (!id) throw new Error('用法: resolve <id> [kept|broken]');
        const v = ag.resolvePromise(id, outcome);
        console.log(v ? '已记作「' + outcome + '」：' + v.gist : '没找到这条约定');
        break;
      }

      case 'stats': {
        printJson(ag.stats());
        break;
      }

      case 'export': {
        const path = positional[0] || 'mmtr-export.json';
        writeFileSync(resolve(process.cwd(), path), ag.exportAll(), 'utf8');
        console.log('已导出: ' + path);
        break;
      }

      case 'reindex': {
        const n = await ag.reindexAll();
        console.log('已重建 ' + n + ' 条向量（' + ag.embed.name + '）');
        break;
      }

      case 'config': {
        printJson(ag.config);
        break;
      }

      case 'festivals': {
        for (const [key, def] of Object.entries(ag.config.festivals)) {
          const anchor = { kind: 'festival' as const, festival: key };
          console.log(key.padEnd(12) + def.label.padEnd(8) + (describeAnchor(anchor, ag.config) || ''));
        }
        break;
      }

      default:
        console.error('未知命令: ' + command + '（试试 help）');
        process.exitCode = 2;
    }
  } finally {
    ag.close();
  }
}

main().catch((err) => {
  console.error('出错: ' + (err as Error).message);
  process.exitCode = 1;
});