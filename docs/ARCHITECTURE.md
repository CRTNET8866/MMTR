# MMTR 架构说明

本文描述 MMTR 的内部结构与可调点，面向要改它或要判断「它是否适合我」的人。

---

## 1. 数据模型

单表族，SQLite（WAL）。核心表：

| 表 | 一行是什么 | 关键列 |
|---|---|---|
| `memories` | 一条记忆 | 三通道强度 `s_fact/s_gist/s_affect`、`level`/`floor_level`、`importance`、`affect`、`relation_delta`、`calendar_anchor`、`due_at`/`promise_state`、`theme_key`、`valid_to` |
| `edges` | 一条联想边 | `from_id`、`to_id`、`type`、`weight`、`hits` |
| `activations` | 一次被想起的记录 | 只用于统计回血与横向抑制，不参与打分溯源 |
| `sessions` | 一次会话 | `started_at`、`ended_at`、`turn_count`、`affect`、`open_thread`、`relation_before/after` |
| `session_turns` | 一轮对话 | `session_id`、`turn`、`user_text`、`assistant_text` |
| `core_memory` | 常驻块 | `key`、`title`、`content`、`mutable` |
| `relation_state` / `relation_log` | 关系向量当前值与变更史 | 六维 + 修订号 |
| `embeddings` | 向量 | `memory_id`、`dim`、`model`、`vec`（BLOB） |

`valid_to IS NULL` 表示有效；`invalidated_by` 记录被谁顶替（矛盾检测用 `contradicts`）。

---

## 2. 一条记忆的生命周期

```
对话
 └─ extract（模型 / 启发式）
     └─ candidate：owner + fact + gist + affect + importance + tags + themeKey + promise?
         ├─ 稳定事实？ → 写 core_memory（不衰减）
         ├─ 承诺？     → 锁 L0 + dueAt + promise_state=pending
         └─ 普通记忆   → 去重（向量 0.93 / 主题键 / 时间窗）
                       ├─ 命中 → mergeInto（强化 + 重要性上抬）
                       └─ 未命中 → buildRecord（算 floorLevel、建边、写向量）
 └─ 会话结束（sleep / 间隔超限）
     └─ 关系结算（该会话所有记忆的 relationDelta 聚合 + 一次整体判断，带上限施加）
     └─ 会话摘要记忆 + open_thread
 └─ consolidate（周期性）
     └─ 关系回归 / 边衰减 / 压缩 / 约定到期 / 日历体检
```

---

## 3. 关键公式

**通道权重**

```
w = clamp01( s × max(floorFactor, (1 + ageDays / tauDays) ^ -power) )
```

**激活回血**（递减）

```
s' = s + gain × (1 − s) × decayFactor(recallCount)
```

**压缩门槛**：`level < floorLevel` 且通过年龄判定，才允许压一级；`locked` 与 `promiseState=pending` 永不压缩。

**约定清晰度**（方向与正常衰减相反）

```
clarity = clamp01( clarityFloor + (1 − clarityFloor) × (1 − min(daysToDue / horizonDays, 1)) ^ clarityCurve )
```

**关系施加**

```
applied = clamp( deltaAggregate, ±maxDeltaPerSession ) × (1 − rateLimitFactor × 当前值距上限的比例)
dims' = dims + applied − 回归项(regressionHalfLifeDays)
```

---

## 4. 检索管线

1. **向量召回**：`topK × overFetch` 个候选，允许 `owners` / 时间窗过滤；
2. **沿边扩散**：从种子出发，路径分 `pathScore = seedScore × hopDecay^hop`，低于 `minPathScore` 截断；
3. **日历唤醒**：`calendar_anchor` 命中窗口的记忆强制进入候选；
4. **重排**：`w × importanceBoost × recencyBoost × 横向抑制`；
5. **多样性裁剪**：同一 `themeKey` / 同一会话占比受限，避免一次检索全是同一天的碎事；
6. **组装**：`assembleContext()`，`quiet` 只给「事 + 时间的人话」，`full` 带强度与标签。

---

## 5. 扩展点

| 想加什么 | 改哪里 |
|---|---|
| 新的嵌入后端 | `src/embeddings.ts` 实现 `EmbeddingProvider`（`embed` / `name` / `dim`） |
| 换模型做抽取/压缩 | `src/llm.ts` 的 `LLMBrain`，或实现 `Brain` 接口 |
| 新的记忆通道 | `types.ts` 的 `Channel` + `db.ts` 表结构 + `decay.ts` 权重 |
| 新的边类型 | `types.ts` 的 `EdgeType` + `create.ts` 的 `linkMemory` |
| 新的事件形态 | `calendar.ts` 的锚点识别 + `wake.ts` 的渲染 |

---

## 6. 调参指南

| 现象 | 调什么 |
|---|---|
| 忘得太快 | 降 `power` 或升 `tauDays` |
| 什么都记住、库膨胀 | 升 `write.minImportance`，降 `levels.floorThresholds` |
| 联想太发散 | 降 `graph.hopDecay`，升 `graph.minPathScore` |
| 关系变化太快 | 降 `relation.maxDeltaPerSession`，升 `rateLimitFactor` |
| 约定太吵闹 | 升 `promise.surfaceLookaheadDays` 的门槛或只保留 `maxHorizonDays` 内的 |
| 上下文太长 | 降 `wake.maxRecallLines`，`retrieval.maxContextChars` |

---

## 7. 测试

`npm test` 覆盖：衰减曲线与层级、去重与合并、联想扩散、关系上限与回归、会话边界与睡眠、前瞻记忆的清晰度/兑现/落空、稳定事实与常驻块。

新加行为时优先补「不变量」而不是「快照」：例如「约定永不压缩」「检索不改变 importance」「quiet 输出不含数值」。