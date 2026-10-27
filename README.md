# MMTR — Memorable Memory To Remember

> 一个仿人脑的记忆层：**会忘，但忘得对。**

MMTR 不是向量数据库，也不是 RAG 管线。它试图回答一个更窄的问题：

**一段关系里，什么该留下，什么该淡掉，什么该在某个时间点自己浮上来。**

它把「记忆」当成一个有物理量的东西——有强度、有半衰期、有情绪色、会互相牵连、会被想起而变亮、会因为太久没被想起而塌缩成一句感觉。核心命题是：**记忆的价值不在存住多少，而在忘掉之后还剩下什么。**

零依赖，Node ≥ 22.5（用内置 `node:sqlite`），单文件数据库，可以被任意 agent / 应用嵌进去。

---

## 一、模型：三条通道，四个层级

每一段经历入库时被拆成三条独立通道，它们以不同速度衰减：

| 通道 | 记的是 | `tauDays`（半衰期量级） | `power`（曲线陡度） | `floorFactor`（地板） |
|---|---|---|---|---|
| `fact` | 客观事实 | 4 | 0.9 | 0.02 |
| `gist` | 能唤起感觉的一句话 | 12 | 0.75 | 0.12 |
| `affect` | 当时的情绪 | 180 | 0.28 | 0.55 |

事实最先烂掉，感觉最后一个走。这就是「记得那天下雨，但不记得说了什么」的结构化表达。

**层级** `L0 → L3` 是压缩深度：`L0` 是原文，`L1` 摘要，`L2` 更模糊，`L3` 只剩一个感觉。
**地板** `floorLevel` 由重要性推出，是「这条记忆最多能被压到哪一层」——重要的事不允许被压成雾。

> 有意思的地方在 `affect` 的地板 0.55：情绪通道几乎不会归零。所以一次强烈的经历，即使事实全没了，她仍然会对某个人、某个地点、某句话保留一种说不清的偏向。

### 强度公式

```
w(channel) = clamp01( s × max( floorFactor, (1 + age/τ) ^ -power ) )
```

`s` 是该通道的存储强度，`age` 以天计。被想起会让 `s` 回升（`gain`），但**增益随被想起次数递减**——见下文「防自增强」。

---

## 二、联想图：记忆不是一个列表

记忆之间有四类边：

| 边 | 何时建立 | 作用 |
|---|---|---|
| `entity` | 共享实体（人、地点、物件） | 提到一个人，会带出与这个人相关的全部 |
| `temporal` | 时间接近 | 那段时间发生的事会一起回来 |
| `same_anchor` | 同一日历锚点（生日、节日、纪念日） | 一年一次的事会串成链 |
| `same_theme` | 主题相同 | 同类事件形成一条线 |

检索时沿边扩散（`hopDecay`，默认 0.85），所以「翻饺子」能顺带把「生日约定」带回来。这就是**联想**，而不是关键词命中。

---

## 三、关系向量：关系的状态是一个六维向量

```
closeness 亲近 · trust 信任 · playfulness 俏皮 · warmth 温度 · tension 张力 · familiarity 熟悉
```

三条约束让它不会因为一次温柔就飙升：

1. **单场上限** `maxDeltaPerSession`：一次会话最多推动多少。
2. **速率衰减** `rateLimitFactor`：越靠近上限越推不动。
3. **回归半衰期** `regressionHalfLifeDays`：长期不互动会缓慢回落到基线；张力单独有更短的半衰期（`tensionHalfLifeDays`），所以吵架更容易好。

关系只在**会话结束时**结算（`sleep`），不在每轮结算——这是刻意的：关系是一次交谈之后的印象，不是每句话的即时积分。

---

## 四、前瞻记忆：唯一指向未来的那一类

承诺、约定、答应过的事被单独当一类记忆：

- 入库即 **锁定 L0**（永不压缩，事实必须完整）；
- 权重曲线**方向相反**：离到期越近越清晰（`promiseClarity`），不是越久越淡；
- 到窗口内会自己浮到「还欠着」那一段（`shouldSurfacePromise`）；
- 过期超过宽限期仍未兑现 → 自动判 `broken`，并**付一次关系代价**（信任、温度下降，张力上升）；
- 兑现 → `kept`，关系有**小幅正向**回报。

它回答的是：**答应过的事，为什么不能像其他记忆一样淡掉。**

---

## 五、常驻块：不会被衰减触碰的那一块

`core_memory` 是少量「他是谁 / 我是谁 / 我们约定过什么」的结构化事实，**不衰减、不压缩、每次都在上下文里**。

只有「身份型」的陈述才允许进来（短句 + 硬格式：生日带日期、出生年、几岁、在读年级、居住地）。像「他今天问我记不记得」这种**事件**会被拒绝——事件属于记忆表，身份属于常驻块，两者的生命周期完全不同。

---

## 六、检索：六步，三道闸门

```
向量召回 → 沿边扩散 → 日历唤醒 → 重排 → 多样性裁剪 → 组装
```

以及三个防止「检索自增强」的闸门（否则常用的记忆会越来越亮，最后只剩那几条）：

1. **回血增益随被想起次数递减**；
2. **横向抑制**：本轮刚用过的记忆在下一轮降权；
3. **`importance` 完全不受检索影响**——检索路径拿不到写 `importance` 的入口。

组装有 `quiet` / `full` 两种风格：`quiet` 提供给模型的是「印象」，不带数值、不带标签、不带时间戳；`full` 保留全部调试信息。

---

## 七、睡眠与巩固

| 动作 | 做什么 |
|---|---|
| `sleep` | 结束一次会话：结算关系、写会话摘要、记下「没说完的话」 |
| `consolidate` | 关系回归 → 边衰减 → 压缩（按年龄与地板筛） → 约定到期判定 → 日历锚点体检 |

会话边界由间隔定义（`session.gapHours`）：超过这个间隔后的第一条消息，会先把上一场睡过去，再开新的一场。

---

## 八、快速开始

```bash
git clone https://github.com/<you>/MMTR.git && cd MMTR
node --experimental-strip-types src/cli.ts init          # 建库
node --experimental-strip-types src/cli.ts ingest --user "今天面试砸了" --assistant "辛苦了。"
node --experimental-strip-types src/cli.ts wake          # 看「醒来时她还记得什么」
node --experimental-strip-types src/cli.ts query "面试"
node --experimental-strip-types src/cli.ts sleep         # 结束会话、结算关系
node --experimental-strip-types src/cli.ts stats
```

跑测试：

```bash
npm test        # 88 个用例
```

以服务方式跑（给别的进程调用）：

```bash
node --experimental-strip-types src/server.ts --port 7411
```

```ts
import { MMTR } from './src/engine.ts';

const mm = MMTR.open({ configPath: './mmtr.config.json' });
await mm.ingest({ user: '……', assistant: '……' });
const wake = await mm.wake();          // 提供给模型的上下文块
const ctx = await mm.getContext({ text: '面试' });
```

---

## 九、HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活与规模 |
| GET | `/wake` | 唤醒块（`?format=full` 取调试版） |
| POST | `/ingest` | `{user, assistant, at?, pin?}` 写入一段对话 |
| POST | `/remember` | `{text, owner?, importance?}` 直接写入一条 |
| POST | `/context` | `{text, topK?}` 检索并组装 |
| POST | `/sleep` | 结束会话 |
| POST | `/consolidate` | 跑一次巩固 |
| GET | `/list` | 列出记忆 |
| GET | `/memory/:id` | 单条详情（含边、激活记录、权重） |
| POST | `/pin/:id` · `/reweight/:id` · `/forget/:id` | 钉住 / 回溯重加权 / 忘记 |
| GET | `/promises?state=` | 约定（`pending` / `kept` / `broken` / `all`） |
| POST | `/promise/:id` | `{outcome: kept \| broken}` 结算约定 |
| GET | `/core` · POST `/core` | 常驻块读写 |
| GET | `/stats` · `/export` | 统计 / 全量导出 |

请求带 `Authorization: Bearer <token>` 或 `?token=`（设 `MMTR_TOKEN` 环境变量后启用）。

---

## 十、配置

配置文件 `mmtr.config.json` 与默认值深合并，只需要写你要改的部分：

```json
{
  "dbPath": "./data/mmtr.db",
  "channels": {
    "fact":  { "tauDays": 4,   "power": 0.9,  "floorFactor": 0.02, "gain": 0.55 },
    "gist":  { "tauDays": 12,  "power": 0.75, "floorFactor": 0.12, "gain": 0.4 },
    "affect":{ "tauDays": 180, "power": 0.28, "floorFactor": 0.55, "gain": 0.22 }
  },
  "levels":   { "floorThresholds": { "l0": 0.9, "l1": 0.62, "l2": 0.38 } },
  "graph":    { "minPathScore": 0.035, "hopDecay": 0.85 },
  "relation": { "maxDeltaPerSession": 0.06, "rateLimitFactor": 0.55, "regressionHalfLifeDays": 21 },
  "session":  { "gapHours": 3 },
  "promise":  { "surfaceLookaheadDays": 7, "graceDays": 3, "maxHorizonDays": 400 },
  "mood":     { "quantile": 0.65, "emotionBudget": 6 },
  "wake":     { "maxRecallLines": 2 }
}
```

`llm` 留空时使用内置启发式（纯规则，不联网）；填 `provider: "deepseek"` 等则启用模型抽取与压缩，失败自动回退启发式。

---

## 十一、它不做什么

- **不做 embedding 存全部原文**的暴力检索。向量只是入口，判断靠权重与图。
- **不做「永不忘」**。所有普通记忆都会衰减，只有承诺与常驻块例外——例外本身就是设计。
- **不假装自己是数据库**。它面向一个 agent 的上下文预算：输出永远是「一小段能读的东西」，不是一堆断言。
- **不内置任何人格**。这里只有记忆的形状，不说一句话该怎么讲。

---

## 十二、已知边界

- 压缩按时间门控，刚写入的记忆不会被立即压缩（会丢细节）；
- 关系与约定的结算依赖会话边界，边界由 `gapHours` 定义，不是真实日历日；
- 稳定事实进常驻块靠格式判定，是一种保守的启发式，不追求召回率；
- 单机 SQLite，不面向多写并发。

---

## License

MIT