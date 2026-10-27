/* ============================================================================
 * 离线启发式引擎 (heuristic.ts)
 *
 * 没有 API Key 也能把整套系统跑通：重要性打分、情绪识别、实体/标签/锚点抽取、
 * 关系增量估计、摘要压缩，全部用规则实现。
 * 它的定位不是「接近 LLM」，而是「保证系统在任何环境下都能运转并可复现」。
 * ==========================================================================*/

import type {
  Affect,
  CalendarAnchor,
  MemoryLevel,
  Owner,
  RelationDelta,
  TimePrecision,
} from './types.ts';
import { clamp, clamp01, round, squeezeList, truncate } from './util.ts';

/* ---------- 词典 ---------- */

interface Signal {
  pattern: RegExp;
  weight: number;
  reason: string;
  tag?: string;
  /** 硬信号：命中即锁死原文，不需要靠分数 */
  hard?: boolean;
}

/** 高价值信号：恋爱、诀别、脆弱、承诺、纪念、身份 */
const IMPORTANCE_SIGNALS: Signal[] = [
  { pattern: /表白|喜欢你|爱你|在一起|做我女朋友|做我男朋友|想你|舍不得|离不开|心动|暗恋/, weight: 0.5, reason: '亲密表达', tag: '关系', hard: true },
  { pattern: /分手|离开|再见|最后一面|告别|诀别|不联系了|删了我|走了再也不/, weight: 0.42, reason: '关系转折', tag: '关系', hard: true },
  { pattern: /生病|发烧|医院|住院|手术|抑郁|崩溃|哭|难过|焦虑|自杀|想死|失眠/, weight: 0.36, reason: '脆弱时刻', tag: '情绪' },
  { pattern: /生日|纪念日|周年|跨年|第一次|初遇|相识|一周年|两周年/, weight: 0.36, reason: '时间锚点', tag: '纪念' },
  { pattern: /答应|承诺|约定|保证|发誓|一直陪|不会离开|说好了/, weight: 0.32, reason: '承诺', tag: '承诺', hard: true },
  { pattern: /秘密|只告诉你|别告诉别人|第一次跟人说|从没跟人说过/, weight: 0.32, reason: '私密分享', tag: '秘密' },
  { pattern: /我叫|我的名字|我是谁|你是我的|我叫你|给我起个名字/, weight: 0.3, reason: '身份定义', tag: '身份', hard: true },
  { pattern: /辞职|面试|录取|offer|考试|挂科|加班|项目上线|升职|被裁|毕业/, weight: 0.22, reason: '人生节点', tag: '工作' },
  { pattern: /妈妈|爸爸|父母|家里|妹妹|哥哥|姐姐|弟弟|外婆|奶奶|爷爷/, weight: 0.16, reason: '真实生活', tag: '家人' },
  { pattern: /你会记得吗|你还记得|记得我们|别忘了我|不要忘记/, weight: 0.3, reason: '记忆焦虑', tag: '记忆' },
  { pattern: /喜欢什么样|为什么对我|你喜不喜欢|你在想什么|你有感情吗|你会想我吗/, weight: 0.2, reason: '关系探询', tag: '关系' },
];

/** 低价值信号：这些内容不该进记忆库 */
const TRIVIAL_PATTERNS: Array<{ pattern: RegExp; penalty: number; reason: string }> = [
  { pattern: /^(在吗|在么|在不在|你好|您好|hi|hello|嗨|早|早安|早上好|午安|晚安|拜拜|886)[\s!！。.~～]*$/i, penalty: 0.5, reason: '纯问候' },
  { pattern: /^(嗯+|哦+|噢|好+|好的|行|可以|收到|知道了|ok|okay|嗯嗯|对对对|是是是|666|草|笑死|233+)[\s!！。.~～]*$/i, penalty: 0.5, reason: '无内容应答' },
  { pattern: /^(哈+|hhh+|嘿嘿|桀桀|呵呵)[\s!！。.~～]*$/i, penalty: 0.45, reason: '纯笑声' },
  { pattern: /上厕所|去个厕所|洗手间|倒杯水|喝水|刷牙|洗脸|洗澡|吃饭|吃了吗|点外卖|午睡|睡个觉|打了个哈欠|伸个懒腰|摸鱼|发呆|网卡|卡了|断网/, penalty: 0.32, reason: '日常琐事' },
  { pattern: /^(https?:\/\/|www\.)/i, penalty: 0.3, reason: '纯链接' },
  { pattern: /^(天气|下雨了|好热|好冷|今天几号|几点了)/, penalty: 0.3, reason: '闲聊天气时间' },
];

const POSITIVE_WORDS = /开心|高兴|快乐|喜欢|爱你|谢谢|幸福|温暖|好棒|太好了|舒服|安心|满足|惊喜|可爱|温柔|抱抱|hhh|哈哈|嘿嘿|嘻嘻|笑|甜|想你/;
const NEGATIVE_WORDS = /难过|伤心|哭|烦|累|痛|生气|委屈|孤独|害怕|焦虑|崩溃|失望|讨厌|滚|烦死|没意思|绝望|想死|失眠|难受|冷淡|敷衍/;
const HIGH_AROUSAL = /[!！]{1,}|哈{3,}|啊{2,}|呜{2,}|啊啊|激动|兴奋|炸|疯|疯掉|救命|天啊|卧槽|我靠|！？|？！/;
const LOW_AROUSAL = /平静|安静|淡淡的|还好|大概|随便|无所谓|嗯\.\.\.|……/;

const SELF_DISCLOSURE = /我跟你说|其实我|说实话|我一直|我小时候|我从来|没跟人说过|只告诉你|我最近|我今天|我昨天|我刚刚|我现在/;
const COMFORT = /抱抱|别难过|没关系|我在|陪你|辛苦了|别怕|慢慢来|安慰|心疼/;
const TEASE = /傲娇|哼|才不|谁要|笨蛋|傻瓜|讨厌啦|怼|调皮|逗你|欠揍|嘴上说/;
const CONFLICT = /生气|不高兴|你错了|你说的不对|吵架|别理我|烦|闭嘴|滚|冷淡|敷衍|不理你了/;
const SHARED_REF = /又是|还是|老样子|记得上次|像上次|和以前一样|约好的|照旧|一如既往/;

const DOMAIN_WORDS = [
  '工作', '加班', '考试', '学习', '面试', '项目', '辞职', '毕业', '论文', '代码',
  '生日', '纪念日', '跨年', '圣诞', '中秋', '春节', '新年', '七夕', '情人节',
  '表白', '分手', '吵架', '和好', '约定', '承诺', '秘密', '名字',
  '电影', '音乐', '游戏', '小说', '动漫', '旅行', '海边', '雪山', '演唱会',
  '失眠', '生病', '发烧', '医院', '难过', '开心', '孤独', '焦虑', '抑郁',
  '妈妈', '爸爸', '家里', '妹妹', '哥哥', '猫', '狗', '咖啡', '酒', '烟',
];

const STOPCHARS = '的了是我你他她它们这那么什怎样吗呢吧啊呀哦嗯和与就都也很还要会有没不在一个上下来去说想着过得好';

/* ---------- 基础文本处理 ---------- */

export function splitSentences(text: string): string[] {
  return (text || '')
    .split(/(?<=[。！？!?；;…~～\n])|(?<=\.)(?=\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function combinedText(user: string, assistant: string): string {
  return (user || '') + '\n' + (assistant || '');
}

/* ---------- 重要性 ---------- */

export interface ImportanceEstimate {
  importance: number;
  reasons: string[];
  trivial: boolean;
  topTag: string | null;
}

export function estimateImportance(user: string, assistant: string): ImportanceEstimate {
  const text = combinedText(user, assistant);
  const userText = user || '';
  const reasons: string[] = [];
  let score = 0.2;
  let hard = false;

  for (const sig of IMPORTANCE_SIGNALS) {
    if (sig.pattern.test(text)) {
      // 用户说的话比 AI 说的话更有价值
      const bonus = sig.pattern.test(userText) ? sig.weight : sig.weight * 0.7;
      score += bonus;
      reasons.push(sig.reason);
      if (sig.hard === true) hard = true;
    }
  }

  // 硬信号：这类事不由分数决定，必须留下来（表白、诀别、承诺、身份）
  if (hard) {
    score = Math.max(score, 0.92);
    reasons.push('硬信号');
  }

  let trivial = false;
  for (const t of TRIVIAL_PATTERNS) {
    if (t.pattern.test(userText.trim()) || t.pattern.test(text.trim())) {
      score -= t.penalty;
      reasons.push('-' + t.reason);
      if (t.penalty >= 0.3) trivial = true;
    }
  }

  // 有实质内容的长度加分
  const len = userText.length;
  if (len >= 40) score += 0.08;
  if (len >= 120) score += 0.06;
  if (len < 8) score -= 0.1;
  if (HIGH_AROUSAL.test(text)) score += 0.05;

  // 双方来回数量（多轮长谈）
  const turns = splitSentences(text).length;
  if (turns >= 8) score += 0.05;

  const topTag = DOMAIN_WORDS.find((w) => text.includes(w)) || null;

  return {
    importance: round(clamp01(score), 4),
    reasons: reasons.length > 0 ? reasons : ['普通对话'],
    trivial: trivial && score < 0.3,
    topTag,
  };
}
/* ---------- 情绪 ---------- */

export function estimateAffect(user: string, assistant: string): Affect | null {
  const text = combinedText(user, assistant);
  let pos = 0;
  let neg = 0;
  const posMatches = text.match(new RegExp(POSITIVE_WORDS.source, 'g'));
  const negMatches = text.match(new RegExp(NEGATIVE_WORDS.source, 'g'));
  pos = posMatches ? posMatches.length : 0;
  neg = negMatches ? negMatches.length : 0;

  if (pos === 0 && neg === 0) {
    // 没有明显情绪词时，如果对话很平淡就不记录情绪
    if (!HIGH_AROUSAL.test(text)) return null;
    return { valence: 0, arousal: 0.55, label: '激动' };
  }

  const total = pos + neg;
  const valence = round(clamp((pos - neg) / total, -1, 1), 3);

  let arousal = 0.4 + Math.min(0.4, total * 0.06);
  if (HIGH_AROUSAL.test(text)) arousal += 0.2;
  if (LOW_AROUSAL.test(text)) arousal -= 0.15;

  let label = '平静';
  if (valence >= 0.5) label = arousal >= 0.65 ? '兴奋' : '开心';
  else if (valence > 0.1) label = '温暖';
  else if (valence <= -0.5) label = arousal >= 0.65 ? '激烈' : '低落';
  else if (valence < -0.1) label = '心事';
  else if (COMFORT.test(text)) label = '温柔';

  return {
    valence,
    arousal: round(clamp01(arousal), 3),
    label,
  };
}

/* ---------- 关系增量 ---------- */

export function estimateRelationDelta(user: string, assistant: string, affect: Affect | null): RelationDelta | null {
  const text = combinedText(user, assistant);
  const delta: RelationDelta = {};
  const bump = (k: keyof RelationDelta, v: number): void => {
    delta[k] = round((delta[k] || 0) + v, 4);
  };

  if (SELF_DISCLOSURE.test(user)) {
    bump('trust', 0.012);
    bump('closeness', 0.01);
  }
  // 亲密表达：这是关系推进最直接的一种
  if (/喜欢你|爱你|想你|在一起|舍不得|离不开|抱抱|亲一下/.test(text)) {
    bump('closeness', 0.03);
    bump('warmth', 0.02);
    bump('trust', 0.008);
  }
  if (COMFORT.test(text)) {
    bump('warmth', 0.012);
    bump('trust', 0.004);
  }
  if (TEASE.test(text)) {
    bump('playfulness', 0.012);
    bump('closeness', 0.004);
  }
  if (CONFLICT.test(text)) {
    bump('tension', 0.02);
    bump('warmth', -0.01);
  }
  if (SHARED_REF.test(text)) {
    bump('familiarity', 0.014);
  }
  if (affect) {
    if (affect.valence > 0.4) {
      bump('warmth', 0.008);
      bump('closeness', 0.006);
    } else if (affect.valence < -0.4) {
      bump('tension', 0.01);
    }
  }

  const keys = Object.keys(delta) as Array<keyof RelationDelta>;
  if (keys.length === 0) return null;
  return delta;
}

/* ---------- 前瞻记忆：约定 / 承诺 ---------- */

/** 承诺动词。命中说明「他在许一个未来」，但还需要一个时间才成立。 */
/**
 * 只有「明确应下了一件未来的具体事」才算承诺。
 * 叮嘱（路上看车）、告别（去睡了）、日常安排（先吃饭/去洗漱）都不是。
 */
const PROMISE_VERBS =
  /答应|说好|约好|讲好|承诺|保证|发誓|一言为定|说定了|讲定了|请你(?:吃|喝|看|玩)|陪你|带你|一起去|一块去|一起过|一起倒|好不好|行不行/;

export interface PromiseGuess {
  /** 到期时间戳；没给具体日子就给一个观察期 */
  dueAt: number;
  /** 人话里的时间描述，例如「跨年」「下周三」 */
  label: string;
  /** 有没有说清是哪天 */
  vague: boolean;
}

/**
 * 从一段话里判断有没有「约定」，并尽量算出到期时间。
 * 时间解析是启发式的：给了具体日子就用具体日子，只有模糊说法就给一个观察期。
 */
/**
 * 只解日期，不问「这是不是承诺」。
 * 抽出来是给 LLM 路径兜底用的：模型说不出日子时，我们按文字自己算。
 */
export function resolveRelativeDate(text: string, now: number, defaultDays = 30, maxDays = 400): PromiseGuess | null {
  const t = (text || "").trim();
  if (!t) return null;

  const clampDays = (d: number): number => Math.min(Math.max(d, 0.02), maxDays);
  const at8pm = (d: Date): number => {
    d.setHours(20, 0, 0, 0);
    return d.getTime();
  };

  // 1) 绝对日期：2026-12-31 / 12月31日 / 12月31号
  const iso = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/);
  if (iso) {
    const due = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 20, 0, 0).getTime();
    if (Number.isFinite(due)) return { dueAt: due, label: iso[0], vague: false };
  }
  /* 1.5) 跨年 / 跨月的相对说法：明年、下个月、这个月底、过几天 */
  const nextYearMd = t.match(/明年\s*(\d{1,2})\s*月\s*(\d{1,2})[日号]?/);
  if (nextYearMd) {
    const d = new Date(now);
    const due = new Date(d.getFullYear() + 1, Number(nextYearMd[1]) - 1, Number(nextYearMd[2]), 20, 0, 0).getTime();
    if (Number.isFinite(due)) return { dueAt: due, label: nextYearMd[0], vague: false };
  }
  if (/明年/.test(t)) {
    // 「明年生日」这类：方向必须跨年；具体哪一天说不清，就算模糊
    const d = new Date(now);
    const due = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), 20, 0, 0).getTime();
    // 「明年生日」也算得出来（就是明年的这一天），别当模糊的丢掉——生日约定最不能丢
    const hasDate = /生日|纪念日/.test(t);
    return { dueAt: due, label: hasDate ? "明年的这一天" : "明年", vague: false };
  }
  if (/下\s*个?月/.test(t)) {
    const d = new Date(now);
    const due = new Date(d.getFullYear(), d.getMonth() + 1, d.getDate(), 20, 0, 0).getTime();
    return { dueAt: due, label: "下个月", vague: false };
  }
  if (/这个?月(?:底|末|内)/.test(t)) {
    const d = new Date(now);
    const due = new Date(d.getFullYear(), d.getMonth() + 1, 0, 20, 0, 0).getTime();
    return { dueAt: due, label: "这个月月底", vague: false };
  }
  if (/过几天|过两天/.test(t)) {
    return { dueAt: now + clampDays(3) * 86400000, label: "过几天", vague: true };
  }

  const md = t.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (md) {
    const d = new Date(now);
    let due = new Date(d.getFullYear(), Number(md[1]) - 1, Number(md[2]), 20, 0, 0).getTime();
    if (due < now) due = new Date(d.getFullYear() + 1, Number(md[1]) - 1, Number(md[2]), 20, 0, 0).getTime();
    return { dueAt: due, label: md[0], vague: false };
  }

  // 2) 节日锚点
  if (/跨年/.test(t)) {
    const d = new Date(now);
    let due = new Date(d.getFullYear(), 11, 31, 23, 0, 0).getTime();
    if (due < now) due = new Date(d.getFullYear() + 1, 11, 31, 23, 0, 0).getTime();
    return { dueAt: due, label: '跨年', vague: false };
  }
  if (/生日/.test(t)) {
    // 没说具体日子的生日：给 30 天观察期，别硬编一个日期
    return { dueAt: now + clampDays(defaultDays) * 86400000, label: '生日', vague: true };
  }
  if (/周末/.test(t)) {
    const d = new Date(now);
    const delta = (6 - d.getDay() + 7) % 7 || 7;
    return { dueAt: at8pm(new Date(d.getTime() + delta * 86400000)), label: '周末', vague: false };
  }
  const weekdayMap: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const wd = t.match(/(下+)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (wd) {
    const target = weekdayMap[wd[2] === '天' ? '日' : wd[2]];
    const d = new Date(now);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    const isNext = wd[1] === '下';
    if (isNext && delta < 7) delta += 7;
    return { dueAt: at8pm(new Date(d.getTime() + delta * 86400000)), label: wd[0], vague: false };
  }

  // 3) 相对说法
  if (/明天|明晚/.test(t)) return { dueAt: at8pm(new Date(new Date(now).getTime() + 86400000)), label: '明天', vague: false };
  if (/后天/.test(t)) return { dueAt: at8pm(new Date(new Date(now).getTime() + 2 * 86400000)), label: '后天', vague: false };
  const daysLater = t.match(/(\d{1,3})\s*天(?:之)?后/);
  if (daysLater) {
    return { dueAt: now + Number(daysLater[1]) * 86400000, label: daysLater[0], vague: false };
  }
  const monthsLater = t.match(/(\d{1,2})\s*个月后/);
  if (monthsLater) {
    return { dueAt: now + Number(monthsLater[1]) * 30 * 86400000, label: monthsLater[0], vague: false };
  }

  // 4) 只说了「下次 / 等你忙完」——留着，但没定日子
  return { dueAt: now + clampDays(defaultDays) * 86400000, label: "没定死日子的事", vague: true };
}

export function detectPromise(text: string, now: number, defaultDays = 30, maxDays = 400): PromiseGuess | null {
  const t = (text || "").trim();
  if (!t) return null;
  if (!PROMISE_VERBS.test(t)) return null;
  // 反问/否定不算承诺
  if (/(不答应|没答应|不会答应|才不|不约|谁要跟你约|开玩笑的)/.test(t)) return null;
  return resolveRelativeDate(t, now, defaultDays, maxDays);
}

/* ---------- 稳定事实的主题键 ---------- */

/**
 * 关于「TA 这个人」的稳定事实（生日、年龄、学校、工作、城市、家人）一律用固定主题键：
 * 这样同一个人的同一件事只会留下一条，而不是散成一地碎片。
 */
const PROFILE_RULES: Array<[RegExp, string]> = [
  [/生日|出生|几岁|年纪|\d{1,2}\s*岁|十[七八九]岁|二十岁/, "profile_birthday"],
  [/高三|高一|高二|初三|初一|大[一二三四]|研究生|读研|上学|开学|毕业|年级/, "profile_school"],
  [/搬家|住在|老家|城市|回国/, "profile_city"],
  [/妈妈|爸爸|家里|姐姐|哥哥|妹妹|弟弟|家人/, "profile_family"],
];

/* ---------- 标签归一：同一件事不要散成五个标签 ---------- */

const TAG_RULES: Array<[RegExp, string]> = [
  [/生日|出生|年龄|几岁|岁/, "生日"],
  [/约定|承诺|之约|答应/, "约定"],
  [/会话|摘要|整体/, "会话"],
  [/时间|几点|作息/, "时间"],
  [/吃|饭|饺子|三明治|茶/, "吃饭"],
  [/上学|作业|高三|学校|上课/, "上学"],
  [/睡|晚安|熬夜|打盹/, "睡觉"],
  [/服务器|部署|云端|记忆库|架构/, "折腾电脑"],
  [/斗嘴|打趣|拌嘴|玩笑|调情|炸毛/, "斗嘴"],
  [/记忆|忘记|记错/, "记性"],
];

/** 把标签压到一个稳定的词上，压不住就原样返回。 */
export function normalizeTag(tag: string): string {
  const t = String(tag || "").trim();
  if (!t) return t;
  for (const rule of TAG_RULES) {
    if (rule[0].test(t)) return rule[1];
  }
  return t.length > 8 ? t.slice(0, 8) : t;
}

export function profileThemeKey(text: string): string | null {
  const t = (text || "").trim();
  if (!t) return null;
  for (const rule of PROFILE_RULES) {
    if (rule[0].test(t)) return rule[1];
  }
  return null;
}

/* ---------- 实体 / 标签 / 主题 ---------- */

export function extractEntities(text: string): string[] {
  const out: string[] = [];
  const quoted = text.match(/[「『""']([^」』""']{1,20})[」』""']/g);
  if (quoted) {
    for (const q of quoted) out.push(q.replace(/[「『""'」』]/g, '').trim());
  }
  const atMentions = text.match(/@[\w\u4e00-\u9fa5]{1,20}/g);
  if (atMentions) for (const m of atMentions) out.push(m.slice(1));
  const latin = text.match(/\b[A-Z][A-Za-z0-9_\-]{1,20}\b/g);
  if (latin) for (const m of latin) out.push(m);
  const dates = text.match(/\d{1,2}月\d{1,2}[日号]|\d{4}年/g);
  if (dates) for (const m of dates) out.push(m);
  return squeezeList(out, 8, 20);
}

export function extractTags(text: string, limit = 6): string[] {
  const out: string[] = [];
  for (const w of DOMAIN_WORDS) {
    if (text.includes(w)) out.push(w);
  }
  // 高频二元组补充
  const counts = new Map<string, number>();
  const chars = Array.from(text);
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i];
    const b = chars[i + 1];
    if (!/[\u4e00-\u9fa5]/.test(a) || !/[\u4e00-\u9fa5]/.test(b)) continue;
    if (STOPCHARS.includes(a) || STOPCHARS.includes(b)) continue;
    const bigram = a + b;
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  for (const item of sorted) {
    if (out.length >= limit) break;
    if (item[1] < 2) break;
    if (!out.includes(item[0])) out.push(item[0]);
  }
  return out.slice(0, limit);
}

export function guessTheme(text: string, tags: string[], topTag: string | null): string | null {
  if (topTag) return topTag;
  if (tags.length > 0) return tags[0];
  return null;
}

/* ---------- 日历锚点 ---------- */

const FESTIVAL_WORDS: Record<string, string> = {
  元旦: 'yuandan',
  新年: 'yuandan',
  情人节: 'qingren',
  劳动节: 'laodong',
  儿童节: 'ertong',
  国庆: 'guoqing',
  平安夜: 'pinganye',
  圣诞: 'shengdan',
  跨年: 'kuannian',
  除夕: 'chunjie',
  春节: 'chunjie',
  过年: 'chunjie',
  元宵: 'yuanxiao',
  端午: 'duanwu',
  七夕: 'qixi',
  中秋: 'zhongqiu',
};

export function detectAnchor(text: string, nowMsValue: number): CalendarAnchor | null {
  for (const [word, key] of Object.entries(FESTIVAL_WORDS)) {
    if (text.includes(word)) {
      return { kind: 'festival', festival: key, label: word, repeat: true };
    }
  }
  if (/生日/.test(text)) {
    const m = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
    if (m) {
      return {
        kind: 'annual',
        month: Number(m[1]),
        day: Number(m[2]),
        label: '生日',
        repeat: true,
      };
    }
    return { kind: 'annual', label: '生日', repeat: true };
  }
  if (/纪念日|周年/.test(text)) {
    const m = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
    const d = new Date(nowMsValue);
    return {
      kind: 'annual',
      month: m ? Number(m[1]) : d.getMonth() + 1,
      day: m ? Number(m[2]) : d.getDate(),
      label: '纪念日',
      repeat: true,
    };
  }
  if (/每个?周|每星期|周一|周二|周三|周四|周五|周六|周日|周末/.test(text)) {
    const map: Record<string, number> = { 周日: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周末: 6 };
    for (const [w, v] of Object.entries(map)) {
      if (text.includes(w)) return { kind: 'weekly', weekday: v, label: w, repeat: true };
    }
  }
  if (/深夜|凌晨|半夜|夜里聊/.test(text)) {
    return { kind: 'hourly', fromHour: 23, toHour: 4, label: '深夜长谈', repeat: true };
  }
  return null;
}

/* ---------- 事件时间与精度 ---------- */

export function inferEventTime(text: string, now: number): { at: number | null; precision: TimePrecision } {
  const iso = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/);
  if (iso) {
    const t = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0).getTime();
    if (!Number.isNaN(t)) return { at: t, precision: 'day' };
  }
  const md = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (md) {
    const d = new Date(now);
    const t = new Date(d.getFullYear(), Number(md[1]) - 1, Number(md[2]), 12, 0, 0).getTime();
    if (!Number.isNaN(t)) return { at: t, precision: 'day' };
  }
  if (/去年/.test(text)) {
    const d = new Date(now);
    return { at: new Date(d.getFullYear() - 1, d.getMonth(), d.getDate(), 12).getTime(), precision: 'year' };
  }
  if (/昨天/.test(text)) return { at: now - 86400000, precision: 'day' };
  if (/前天/.test(text)) return { at: now - 2 * 86400000, precision: 'day' };
  return { at: null, precision: 'unknown' };
}

/* ---------- 归属 ---------- */

export function guessOwner(user: string, assistant: string): Owner {
  const u = user || '';
  const a = assistant || '';
  const userSelfFact = /我(叫|是|在|有|刚|今天|昨天|最近|住在|想做|喜欢)|我的/.test(u);
  const selfState = /我(也|很|有点|觉得|刚|今天|现在|吃了|去了|在家)/.test(a);
  if (selfState && !userSelfFact) return 'self';
  if (userSelfFact) return 'user';
  return 'shared';
}

/* ---------- 压缩 ---------- */

const LEVEL_TARGET_CHARS: Record<number, number> = { 1: 90, 2: 32, 3: 12 };

export function summarizeSession(user: string, assistant: string, affect: Affect | null): string | null {
  const topics = extractTags(user + "\n" + assistant, 3);
  const head = topics.length > 0 ? "聊了" + topics.join("、") : "闲聊了一段";
  const tail = affect && affect.label ? "，整体" + affect.label : "";
  const out = (head + tail).trim();
  if (out && out !== "闲聊了一段") return out;
  return truncate((user || assistant).replace(/\s+/g, " "), 60) || null;
}

export function heuristicCompress(
  fact: string,
  gist: string,
  targetLevel: MemoryLevel,
  tag: string,
  affect: Affect | null,
): { fact: string; gist: string; tag: string } {
  const target = LEVEL_TARGET_CHARS[targetLevel] ?? 16;
  const sentences = splitSentences(fact || gist);
  const first = sentences[0] || gist || fact || '';
  const trimmed = squeezeList([first], 1, target)[0] || '';

  if (targetLevel >= 3) {
    const label = affect && affect.label ? affect.label : '某一次';
    const t = tag || '往事';
    return {
      fact: '',
      gist: label + '的' + t,
      tag: t.slice(0, 6),
    };
  }
  if (targetLevel === 2) {
    return {
      fact: '',
      gist: trimmed,
      tag: (tag || trimmed.slice(0, 6)).slice(0, 6),
    };
  }
  return {
    fact: squeezeList(sentences, 2, 140).join(' ').slice(0, 140),
    gist: trimmed,
    tag: (tag || '').slice(0, 8),
  };
}