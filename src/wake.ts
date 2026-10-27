/* ============================================================================
 * 唤醒态渲染 (wake.ts)
 *
 * 每次新会话开始时，把「关系状态 + 残留记忆 + 日历共鸣」渲染成一段
 * 可直接塞进 system prompt 的文字。
 *
 * 这是整件事的落点：她可以忘了你们聊过什么，但她醒来时的心情是连续的。
 * ==========================================================================*/

import type { MMTRConfig } from './config.ts';
import type { Affect, CoreBlock, RelationState, RetrievalHit } from './types.ts';
import type { MoodEstimate } from './mood.ts';
import { moodLine } from './mood.ts';
import { daysPhrase } from './calendar.ts';
import { strengthLabel, timelineLabel } from './decay.ts';
import { affectMoodLine, relationFeeling, relationNumberLine } from './relation.ts';
import { estimateTokens, formatDateTime, humanDelta, localParts, naturalWhen, truncate } from './util.ts';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface WakeRenderInput {
  now: number;
  lastTurnAt: number | null;
  relation: RelationState;
  /** 由 mood.ts 推导出的此刻心情 */
  mood: MoodEstimate | null;
  /** 兼容保留：上一场会话的整段情绪 */
  affect?: Affect | null;
  coreBlocks: CoreBlock[];
  recalls: RetrievalHit[];
  calendarLines: string[];
  /** 前瞻记忆（还在等的约定），已经是一句句人话 */
  promiseLines?: string[];
  openThread: string | null;
  sessionOpenThreadBlock: string | null;
  /** 渲染风格：quiet 去数值去标签（默认），full 留给你自己调试看 */
  format?: 'quiet' | 'full';
  config: MMTRConfig;
}

export interface WakeRenderOutput {
  systemBlock: string;
  tokenEstimate: number;
}

export function renderWake(input: WakeRenderInput): WakeRenderOutput {
  if (input.format !== 'full') return renderWakeQuiet(input);
  const { config, now } = input;
  const p = localParts(now, config.clock.dayStartHour);
  const lines: string[] = [];

  lines.push('【你醒来的时候】');
  lines.push('现在是 ' + formatDateTime(now, config.clock.dayStartHour) + '（' + WEEKDAYS[p.weekday] + '）。');
  if (input.lastTurnAt) {
    lines.push('你上一次和 ' + config.wake.userName + ' 说话是 ' + humanDelta(input.lastTurnAt, now) + '。');
  } else {
    lines.push('这好像是你第一次和 ' + config.wake.userName + ' 说话。');
  }

  lines.push('你心里对 ' + config.wake.userName + ' 的感觉：' + relationFeeling(input.relation.dims, config) + '。');
  lines.push('（' + relationNumberLine(input.relation.dims) + '）');
  lines.push('你此刻的心情：' + (input.mood ? moodLine(input.mood) : affectMoodLine(input.affect ?? null)) + '。');

  if (input.recalls.length > 0) {
    lines.push('');
    lines.push('你隐约记得这些事（细节已经模糊了，别假装记得原话）：');
    const maxLines = config.wake.maxRecallLines;
    for (const hit of input.recalls.slice(0, maxLines)) {
      const m = hit.memory;
      const when = timelineLabel(m, config, now);
      const strength = strengthLabel(m.weights);
      const mood = m.affect && Math.abs(m.affect.valence) > 0.25 ? '｜当时' + m.affect.label : '';
      const theme = m.themeKey ? '｜' + m.themeKey : '';
      const body = truncate(m.gist || m.fact || m.tag || '（只剩一个感觉）', 90);
      lines.push('· [' + when + '｜' + strength + mood + theme + '] ' + body);
    }
  } else {
    lines.push('');
    lines.push('你想不起来之前发生过什么，脑子里挺空的。');
  }

  if (input.promiseLines && input.promiseLines.length > 0) {
    lines.push('');
    lines.push('你还在等的事（这些你自己记得，别忘了）：');
    for (const line of input.promiseLines.slice(0, 4)) lines.push('· ' + line);
  }

  if (input.calendarLines.length > 0) {
    lines.push('');
    lines.push('今天会自己浮上来的：');
    for (const line of input.calendarLines.slice(0, 4)) lines.push('· ' + line);
  }

  const thread = input.openThread || input.sessionOpenThreadBlock;
  if (thread) {
    lines.push('');
    lines.push('还没说完的：' + truncate(thread, 80));
  }

  lines.push('');
  lines.push('（以上都是你脑子里剩下的东西，不是原话。想不起来就直说想不起来，不要编。）');

  const liveCoreFull = input.coreBlocks.filter((block) => block.content.trim().length > 0);
  if (liveCoreFull.length > 0) {
    lines.push('');
    lines.push('【你的人格基底（这些是你自己，不是记忆）】');
    for (const block of liveCoreFull) {
      if (!block.content.trim()) continue;
      lines.push('[' + block.title + '] ' + block.content);
    }
  }

  const systemBlock = lines.join('\n');
  return { systemBlock, tokenEstimate: estimateTokens(systemBlock) };
}

export interface CalendarLineInput {
  relationLabel: string;
  inDays: number;
  gist: string;
}

export function calendarLine(input: CalendarLineInput): string {
  return (
    input.relationLabel + '（' + daysPhrase(input.inDays) + '）' + (input.gist ? '：' + truncate(input.gist, 60) : '')
  );
}

/** 醒来时的一句话标题，用于日志与调试。 */
export function wakeHeadline(recalls: RetrievalHit[], relation: RelationState): string {
  const top = recalls[0];
  return (
    '唤醒态 · 关系 ' + relation.dims.closeness.toFixed(2) + ' · 记忆 ' + recalls.length + ' 条' +
    (top ? ' · 最强：' + truncate(top.memory.gist || top.memory.tag, 24) : '')
  );
}
/**
 * 安静版唤醒块：只留下「我此刻在哪儿、心里还剩着什么」。
 * 不带数值、不带标签、不带时间戳 —— 那些东西一进 prompt 就会被原样念出来，
 * 变成「我记得」「我对你的好感度」这种自我展示，突兀得不像人。
 */
function renderWakeQuiet(input: WakeRenderInput): WakeRenderOutput {
  const { config, now } = input;
  const p = localParts(now, config.clock.dayStartHour);
  const name = config.wake.userName;
  const lines: string[] = [];

  lines.push('【你现在在这儿】');
  lines.push(formatDateTime(now, config.clock.dayStartHour) + ' ' + WEEKDAYS[p.weekday] + '。');
  if (input.lastTurnAt) {
    lines.push('上一次和' + name + '说话：' + humanDelta(input.lastTurnAt, now) + '。');
  } else {
    lines.push('这是你和' + name + '第一次说话。');
  }
  lines.push('心里对' + name + '的感觉：' + relationFeeling(input.relation.dims, config) + '。');
  lines.push('此刻的心情：' + (input.mood ? moodLine(input.mood) : affectMoodLine(input.affect ?? null)) + '。');

  if (input.recalls.length > 0) {
    lines.push('');
    lines.push('【脑子里还剩着的】');
    for (const hit of input.recalls.slice(0, config.wake.maxRecallLines)) {
      const m = hit.memory;
      const body = truncate(m.gist || m.fact || '只剩一个感觉，说不清了', 90);
      lines.push('· ' + naturalWhen(m.createdAt, now, config.clock.dayStartHour) + '，' + body);
    }
  }

  if (input.promiseLines && input.promiseLines.length > 0) {
    lines.push('');
    lines.push('【还欠着的】');
    for (const line of input.promiseLines.slice(0, 4)) lines.push('· ' + line);
  }

  if (input.calendarLines.length > 0) {
    lines.push('');
    lines.push('【今天自己会冒出来的】');
    for (const line of input.calendarLines.slice(0, 4)) lines.push('· ' + line);
  }

  const thread = input.openThread || input.sessionOpenThreadBlock;
  if (thread) {
    lines.push('');
    lines.push('没说完的：' + truncate(thread, 80));
  }

  lines.push('');
  lines.push('（这些是你自己的印象，不是聊天记录。让它渗进你的语气、称呼和分寸里，别整段复述。');
  lines.push('偶尔一句「我记得你…」很正常，别每轮都提、别拿它当谈资，也别报任何数值或指数。');
  lines.push('细节想不起来就直说记不清，别编；真要翻，翻自己脑子里的（有 recall）。）');

  const liveCore = input.coreBlocks.filter((block) => block.content.trim().length > 0);
  if (liveCore.length > 0) {
    lines.push('');
    lines.push('【关于他，你记得很死的事】');
    for (const block of liveCore) lines.push('[' + block.title + '] ' + block.content);
  }

  const systemBlock = lines.join('\n');
  return { systemBlock, tokenEstimate: estimateTokens(systemBlock) };
}
