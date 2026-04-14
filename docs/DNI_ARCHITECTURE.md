# 📝 Jarvis DNI (动态神经索引) 架构设计文档

**版本**：v2.0 (2026.04.14)
**状态**：已实现核心功能
**目标**：将 Jarvis 从"静态 RAG 存储"进化为具备"生命力"与"自我意识"的动态记忆系统。

---

## 1. 设计背景 (Background)

传统的 AI Agent 记忆通常依赖静态向量数据库（如 `vec_memories`），这种模式存在三个核心瓶颈：

1. **索引污染**：无法区分"关于用户的事实"、"关于系统的指令"和"纯粹的技术讨论"。
2. **认知黑盒**：记忆存储在 SQLite/Vector 库中，用户看不见摸不着，无法直观纠偏。
3. **权重均等**：无法根据时间、频率或反馈动态调整记忆的"活跃度"。

**DNI (Dynamic Neural Index)** 的核心理念是**让索引具有生命力**，通过多层解耦与动态权重复合，实现记忆的主动演进。

---

## 2. 三层解耦架构 (3-Layer Architecture)

Jarvis 的 DNI 方案采用了物理、神经、逻辑三层解耦设计：

### L1: 物理层 (Physical Layer) - `MEMORIES.md`

- **介质**：人类可读的 Markdown 文件。
- **路径**：`~/.gemini-jarvis/memory/MEMORIES.md`
- **作用**：作为系统的"终极事实来源 (Truth Source)"。
- **特性**：
  - **透明性**：用户可随时查看 Jarvis 记住了什么。
  - **可修正性**：支持通过手动编辑文件来纠正 AI 幻觉（如 DNI 归属错误）。
  - **自愈性**：当 L2/L3 索引损坏时，通过重扫 Markdown 即可重建整个认知。

### L2: 神经层 (Neural Layer) - `vec_facts` & `vec_memories`

- **介质**：基于 `sqlite-vec` 的虚拟表。
- **作用**：存储语义向量（Embeddings），实现高性能模糊匹配。
- **特性**：
  - **分片映射**：每一个 Fact 或对话片段都有唯一的神经索引。
  - **神经水合 (Hydration)**：系统启动时自动通过 Embedding 模型填充缺失的向量。

### L3: 逻辑层 (Logical Layer) - 动态激活权重

- **介质**：SQLite `importance` + `last_accessed` + `access_count` 字段。
- **作用**：控制记忆的"热度"与"优先级"。
- **特性**：
  - **权重融合**：`fusedScore = RRF(rank_vec, rank_bm25) + β·(importance/10) + γ·decay`
  - **时间衰减**：`decay = e^(-λ · days_since_accessed)`，模拟艾宾浩斯遗忘曲线。
  - **混合检索**：向量检索 + BM25 关键词检索，通过 RRF 融合排名。

---

## 3. memory.db 核心表说明

数据库路径：`~/.gemini-jarvis/memory/memory.db`

---

### 3.1 `facts` 表 — 结构化知识

**定义**：

```sql
CREATE TABLE facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category      TEXT,            -- identity/behavior/preference/specification/insight
  content       TEXT,
  importance    INTEGER DEFAULT 5,
  timestamp     INTEGER,
  embedding     BLOB,            -- float32 向量（序列化），用于语义去重和内存 fallback
  last_accessed INTEGER,         -- 最后被 searchFacts 命中的时间戳（ms）
  access_count  INTEGER DEFAULT 0 -- 被命中的累计次数
);
```

**写入时机**：

| 操作            | 触发条件                                                                | 说明                                      |
| --------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| INSERT          | 每次对话结束后 `distiller.distill()` 提取到新事实                       | 经过精确/Jaccard/embedding 三层去重后写入 |
| DELETE + INSERT | `consolidateFacts()` 触发（facts 数超过阈值）                           | LLM 语义合并去重后全量替换                |
| DELETE + INSERT | `reflect()` 每日 22:00 执行                                             | 仅替换 `category='insight'` 的行          |
| DELETE + INSERT | `syncFromPhysicalLayerIfModified()` 启动时检测到 MEMORIES.md 被手动编辑 | 从 L1 全量重建                            |

**使用时机**：

| 操作   | 调用方                                        | 说明                                               |
| ------ | --------------------------------------------- | -------------------------------------------------- |
| 全表读 | `searchFacts()` 每次对话前                    | 读入内存建 Map，分离 alwaysFacts 和 candidateFacts |
| 全表读 | `consolidateFacts()`                          | 读取所有 facts 生成 LLM prompt                     |
| 全表读 | `reflect()`                                   | 读取非 insight facts 生成洞见                      |
| 全表读 | `flushToPhysicalLayer()`                      | 读取所有 facts 写入 MEMORIES.md                    |
| UPDATE | `updateAccessStats()` 每次 searchFacts 命中后 | 异步更新 last_accessed 和 access_count             |

---

### 3.2 `vec_facts` 表 — 事实向量索引

**定义**：

```sql
CREATE VIRTUAL TABLE vec_facts USING vec0(
  id        INTEGER PRIMARY KEY,  -- 与 facts.id 对应
  embedding FLOAT[1024]           -- 维度由 models.embeddingDimension 配置
);
```

**写入时机**：

| 操作            | 触发条件                                  | 说明                                                                          |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| INSERT          | `insertFactWithVec()` — 与 facts 同一事务 | 新 fact 写入时同步插入向量                                                    |
| DELETE + INSERT | `consolidateFacts()` 全量替换             | 先清空再重建，与 facts 保持一致                                               |
| 清理孤立行      | `reflect()` insight 替换后                | `DELETE WHERE id NOT IN (SELECT id FROM facts)`                               |
| DELETE + INSERT | `syncFromPhysicalLayerIfModified()`       | L1→L2 同步时全量重建                                                          |
| INSERT（修复）  | `backfillVecFacts()` 启动时               | 补全有 embedding 但不在 vec_facts 的行；为 embedding IS NULL 的 fact 生成向量 |

**使用时机**：

| 操作               | 调用方                                         | 说明                                                      |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------- |
| MATCH 向量近邻查询 | `searchFacts()` embedding 策略                 | 返回 `{id, distance}`，不 JOIN facts（从内存 Map 取文本） |
| 维度探测           | `rebuildVecTablesIfDimensionMismatch()` 启动时 | 读取 `sqlite_master` 中的建表 SQL 检测维度                |

---

### 3.3 `facts_fts` 表 — BM25 全文索引

**定义**：

```sql
CREATE VIRTUAL TABLE facts_fts USING fts5(
  content,
  fact_id   UNINDEXED,   -- 关联 facts.id
  tokenize = 'unicode61' -- 支持中英文分词
);
```

**写入时机**：

| 操作            | 触发条件                                  | 说明                                                 |
| --------------- | ----------------------------------------- | ---------------------------------------------------- |
| INSERT          | `insertFactWithVec()` — 与 facts 同一事务 | 新 fact 写入时同步插入 FTS                           |
| DELETE + INSERT | `consolidateFacts()` 全量替换             | 先 `DELETE FROM facts_fts` 再重建                    |
| 清理孤立行      | `reflect()` insight 替换后                | `DELETE WHERE fact_id NOT IN (SELECT id FROM facts)` |
| DELETE + INSERT | `syncFromPhysicalLayerIfModified()`       | L1→L2 同步时全量重建                                 |
| INSERT（修复）  | `backfillFts()` 启动时                    | 补全不在 FTS 索引中的 facts                          |

**使用时机**：

| 操作            | 调用方                               | 说明                                          |
| --------------- | ------------------------------------ | --------------------------------------------- |
| MATCH BM25 查询 | `searchFacts()` hybridSearch=true 时 | 返回 `{fact_id, rank}`，与向量结果做 RRF 融合 |

---

### 3.4 `memories` 表 — 完整对话记录

**定义**：

```sql
CREATE TABLE memories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT,
  text      TEXT,    -- "User: ...\nAssistant: ..." 格式
  timestamp INTEGER
);
```

**写入时机**：

| 操作   | 触发条件                                           | 说明                                                                                |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| INSERT | `ingestMemory()` 每次对话结束后异步写入            | 通过 `enqueue()` 入队，`processQueue()` 消费，延迟 `ingestionDelayMs`（默认 800ms） |
| DELETE | `rebuildVecTablesIfDimensionMismatch()` 维度变更时 | 清空旧对话记录，由 `syncHistoricalSessions()` 重新入队                              |

**使用时机**：

| 操作              | 调用方     | 说明                                      |
| ----------------- | ---------- | ----------------------------------------- |
| JOIN vec_memories | `search()` | 通过向量近邻找到 id 后，JOIN 取出对话文本 |

---

### 3.5 `vec_memories` 表 — 对话向量索引

**定义**：

```sql
CREATE VIRTUAL TABLE vec_memories USING vec0(
  id        INTEGER PRIMARY KEY,  -- 与 memories.id 对应
  embedding FLOAT[1024]
);
```

**写入时机**：

| 操作   | 触发条件                                           | 说明                          |
| ------ | -------------------------------------------------- | ----------------------------- |
| INSERT | `ingestMemory()` 与 memories 同步写入              | 对话文本生成 embedding 后写入 |
| DELETE | `rebuildVecTablesIfDimensionMismatch()` 维度变更时 | 与 vec_facts 同步重建         |

**使用时机**：

| 操作               | 调用方                 | 说明                                                                         |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------- |
| MATCH 向量近邻查询 | `search(query, limit)` | 被 `refreshContext()` 预热调用（prewarmLimit 条）和 `recall_memory` 工具调用 |

---

### 3.6 `processed_files` 表 — 历史会话处理记录

**定义**：

```sql
CREATE TABLE processed_files (
  filename   TEXT PRIMARY KEY,
  last_mtime INTEGER
);
```

**写入时机**：

| 操作              | 触发条件                                             | 说明                             |
| ----------------- | ---------------------------------------------------- | -------------------------------- |
| INSERT OR REPLACE | `syncHistoricalSessions()` 处理完每个 session 文件后 | 记录文件名和 mtime，避免重复处理 |

**使用时机**：

| 操作   | 调用方                     | 说明                                |
| ------ | -------------------------- | ----------------------------------- |
| SELECT | `syncHistoricalSessions()` | 对比 mtime 判断文件是否需要重新处理 |

---

## 4. 三表同步原则

`facts`、`vec_facts`、`facts_fts` 必须在所有写入点保持一致，id 一一对应：

```
facts.id ←→ vec_facts.id ←→ facts_fts.fact_id
```

任何对 facts 的全量替换（consolidateFacts、syncFromPhysicalLayerIfModified）都必须同时清空并重建另外两张表，避免孤立行导致检索结果错乱。

---

## 5. 核心机制 (Core Mechanisms)

### 5.1 主体归属防火墙 (Entity Attribution)

- **逻辑**：在后台提炼（Distillation）阶段，通过 Prompt 强制执行主体校验。
- **预防目标**：明确区分"用户"、"Jarvis 系统"与"外部实体（如 OpenClaw）"。
- **规则**：非关于用户习惯或系统约束的事实，一律不予入库。

### 5.2 自动回填与对齐 (Auto-Backfill)

启动时 `setEmbedContent()` 注入后自动触发，按顺序执行：

1. `rebuildVecTablesIfDimensionMismatch()` — 检测维度变化，必要时重建虚拟表
2. `syncFromPhysicalLayerIfModified()` — L1→L2 同步（检测 MEMORIES.md 手动编辑）
3. `backfillVecFacts()` — 修复 vec_facts 缺失的向量
4. `backfillFts()` — 修复 facts_fts 缺失的索引
5. `backfillPhysicalLayer()` — MEMORIES.md 缺失时从 SQLite 重建

### 5.3 认知反思 (The "Dreaming" Phase)

- **执行**：每日 22:00 准时触发（`nightly-reflection` 任务，type=reflect）。
- **任务**：
  - **压缩**：`consolidateFacts()` 合并重复的、琐碎的对话事实。
  - **升华**：`reflect()` 从日常交互中总结出高阶洞察（Meta-Insights）。
  - **刷写**：将总结结果同步更新至 L1 物理文件。

### 5.4 混合检索 (Hybrid Search)

```
向量检索（vec_facts MATCH）→ {id, distance, rank_vec}
        +
BM25 检索（facts_fts MATCH）→ {fact_id, rank_bm25}
        ↓
RRF 融合：rrfScore = 1/(k+rank_vec) + 1/(k+rank_bm25)
        ↓
加入 importance 和时间衰减：
fusedScore = rrfScore + β·(importance/10) + γ·e^(-λ·days)
```

### 5.5 L1→L2 同步（手动纠错自愈）

用户手动编辑 `MEMORIES.md` → 重启 Jarvis → 启动时检测 mtime 变化 → 解析 Markdown → 全量重建 facts + vec_facts + facts_fts。

---

## 6. 技术栈实现 (Implementation Details)

| 组件                  | 实现技术                                  |
| :-------------------- | :---------------------------------------- |
| **向量引擎**          | `sqlite-vec` (Loadable Extension)         |
| **全文检索**          | SQLite FTS5（unicode61 tokenizer）        |
| **数据库**            | `better-sqlite3`                          |
| **Embedding（云端）** | Google Gemini `gemini-embedding-001`      |
| **Embedding（本地）** | Ollama（bge-m3 等，1024 维）              |
| **本地 I/O**          | Node.js `fs`（原子写入：tmp + rename）    |
| **异步更新**          | `setImmediate`（access stats 非阻塞更新） |

---

## 7. 未来演进 (Roadmap)

1. **Graph 融合**：在 DNI 逻辑中引入图数据库（或基于 SQLite 的三元组存储），建立实体间的显式逻辑链路。
2. **access_count 参与评分**：在 `consolidateFacts` 时将访问频率作为 importance 重新评分的参考信号（对数处理避免频率霸权）。
3. **自动遗忘**：`access_count = 0` 且超过 N 天未访问的 fact 自动降级或删除。
4. **场景激活**：根据当前任务类型（金融、编程、健康等）自动激活特定 fact 神经簇。
