# Jarvis DNI 记忆系统技术文档

**版本**：v1.0（2026-04-14）
**涉及文件**：`jarvis/src/core/memory.ts`、`jarvis/src/core/configManager.ts`、`jarvis/src/core/agent.ts`

---

## 一、背景与目标

传统 AI Agent 记忆系统依赖静态向量数据库，存在三个核心瓶颈：

1. **索引污染**：无法区分"关于用户的事实"、"关于系统的指令"和"纯粹的技术讨论"
2. **认知黑盒**：记忆存储在数据库中，用户无法直观查看和纠正
3. **权重均等**：无法根据时间、频率动态调整记忆的"活跃度"

**DNI（Dynamic Neural Index）** 的目标是让记忆系统具备生命力，通过多层解耦与动态权重复合，实现记忆的主动演进。

---

## 二、三层架构

### L1：物理层（MEMORIES.md）

**路径**：`~/.gemini-jarvis/memory/MEMORIES.md`

**格式**：

```markdown
# Jarvis Memory

## identity

- [9] user is named David
- [8] user is a software engineer

## behavior

- [7] user runs 3 times a week

## preference

- [10] prefers concise answers

## specification

- [9] project uses TypeScript
```

每行格式：`- [importance] content`，按 category 分节。

**写入时机**：

- `batch` 模式（默认）：`consolidateFacts()` 和 `reflect()` 成功后全量重写
- `realtime` 模式：每次 `saveFact()` 后立即追加

**写入实现**（`flushToPhysicalLayer`）：

- 先写临时文件 `MEMORIES.md.tmp`，再 `rename` 原子替换，避免写入中断导致文件损坏
- 写入后记录 mtime 到 `memory_meta.json`

**配置项**：

```json
"memory": {
  "l1WriteMode": "batch"
}
```

---

### L2：神经层（SQLite + sqlite-vec）

**数据库**：`~/.gemini-jarvis/memory/memory.db`

**表结构**：

```sql
-- 结构化事实
CREATE TABLE facts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT,        -- identity/behavior/preference/specification/insight
  content      TEXT,
  importance   INTEGER DEFAULT 5,
  timestamp    INTEGER,
  embedding    BLOB,        -- float32 向量（序列化）
  last_accessed INTEGER,   -- 最后被 searchFacts 命中的时间戳（ms）
  access_count INTEGER DEFAULT 0  -- 被命中的累计次数
);

-- 向量索引（sqlite-vec 虚拟表）
CREATE VIRTUAL TABLE vec_facts USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]    -- 维度由 models.embeddingDimension 配置
);

-- FTS5 全文索引（BM25）
CREATE VIRTUAL TABLE facts_fts USING fts5(
  content,
  fact_id UNINDEXED,
  tokenize = 'unicode61'
);

-- 完整对话记录
CREATE TABLE memories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT,
  text      TEXT,
  timestamp INTEGER
);

-- 对话向量索引
CREATE VIRTUAL TABLE vec_memories USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);
```

**三表同步原则**：`facts`、`vec_facts`、`facts_fts` 在所有写入点保持一致：

| 操作                              | facts         | vec_facts     | facts_fts         |
| --------------------------------- | ------------- | ------------- | ----------------- |
| `saveFact`                        | INSERT        | INSERT        | INSERT            |
| `consolidateFacts`                | DELETE+INSERT | DELETE+INSERT | DELETE+INSERT     |
| `reflect` (insight)               | DELETE+INSERT | 清理孤立行    | 清理孤立行+INSERT |
| `syncFromPhysicalLayerIfModified` | DELETE+INSERT | DELETE+INSERT | DELETE+INSERT     |

---

### L3：逻辑层（动态权重融合）

**融合分数公式**（embedding 策略）：

```
fusedScore = RRF(rank_vec, rank_bm25) + β·(importance/10) + γ·decay(last_accessed)
```

其中：

- `RRF(rank_vec, rank_bm25) = 1/(k+rank_vec) + 1/(k+rank_bm25)`，k=60
- `decay = e^(-λ · days_since_accessed)`，λ=0.1
- `β = importanceWeight = 0.2`
- `γ = accessWeight = 0.1`

**配置项**：

```json
"memory": {
  "vectorSimilarityWeight": 0.7,
  "importanceWeight": 0.2,
  "accessWeight": 0.1,
  "decayLambda": 0.1,
  "hybridSearch": true,
  "rrfK": 60
}
```

---

## 三、核心机制详解

### 3.1 Embedding 服务

支持两种 provider，通过配置切换：

**Google API**（默认）：

```json
"embeddingService": {
  "provider": "google"
},
"models": {
  "embedding": "models/gemini-embedding-001",
  "embeddingDimension": 1024
}
```

**本地 Ollama**（推荐，无地区限制）：

```json
"embeddingService": {
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "model": "bge-m3"
},
"models": {
  "embeddingDimension": 1024
}
```

**切换 provider 时的自动迁移**：启动时 `rebuildVecTablesIfDimensionMismatch()` 检测 `vec_facts` 的实际维度与配置是否一致，不一致则自动重建虚拟表并清空旧 embedding，由 `backfillVecFacts()` 重新生成。

**实现**（`embedWithApiKey`）：

```typescript
public async embedWithApiKey(text: string): Promise<number[]> {
  const provider = this.jarvisConfig.embeddingService?.provider ?? 'google';
  if (provider === 'ollama') return this.embedWithOllama(text);
  return this.embedWithGoogle(text);
}
```

---

### 3.2 混合检索（Hybrid Search）

`searchFacts` 在 embedding 策略下并行执行向量检索和 BM25 检索，用 RRF 融合：

```
用户输入
    ↓
并行执行
    ├── vec_facts MATCH → {id, distance}（向量近邻）
    └── facts_fts MATCH → {fact_id, rank}（BM25 关键词）
    ↓
RRF 融合
    rrfScore = 1/(k+rank_vec) + 1/(k+rank_bm25)
    ↓
加入 importance 和时间衰减
    fusedScore = rrfScore + β·(importance/10) + γ·decay
    ↓
排序取 top N，异步更新 last_accessed + access_count
```

**为什么用 RRF 而不是加权求和**：向量距离和 BM25 分数量纲不同，无法直接加权。RRF 只用排名位置，天然解决量纲问题。

**BM25 的优势场景**：专有名词（函数名、项目名、技术术语）精确匹配，向量检索对此类查询效果较差。

**优化细节**：`searchFacts` 只读一次 `facts` 表，建立 `id → fact` Map，`vec_facts` 只查 `id + distance`（不 JOIN），`facts_fts` 只查 `fact_id + rank`，避免重复 DB 读取。

---

### 3.3 时间衰减（Time Decay）

模拟艾宾浩斯遗忘曲线：

```
decay = e^(-λ · days_since_accessed)
```

| 距上次访问 | decay（λ=0.1） |
| ---------- | -------------- |
| 0 天       | 1.00           |
| 7 天       | 0.50           |
| 10 天      | 0.37           |
| 30 天      | 0.05           |

- `last_accessed` 在每次 `searchFacts` 命中后异步更新（`setImmediate`，不阻塞主流程）
- `access_count` 同步更新，目前作为辅助信息记录，未来可用于 `consolidateFacts` 的 importance 重新评分

---

### 3.4 L1→L2 同步（手动纠错自愈）

**触发条件**：启动时检测 `MEMORIES.md` 的 mtime 是否比 `memory_meta.json` 记录的 `lastFlushMtime` 更新。

**流程**：

```
启动
    ↓
autoBackfill()
    ↓
syncFromPhysicalLayerIfModified()
    ├── 读取 memory_meta.json → lastFlushMtime
    ├── stat(MEMORIES.md) → currentMtime
    ├── currentMtime > lastFlushMtime？
    │       ↓ 是
    │   parseMemoriesMd() → [{category, content, importance}]
    │       ↓
    │   事务：DELETE facts + vec_facts + facts_fts → INSERT 解析结果
    │       ↓
    │   writeMeta({lastFlushMtime: currentMtime})
    │       ↓
    │   返回 true（跳过 backfillPhysicalLayer，避免覆盖用户编辑）
    └── 否 → 返回 false
```

**MEMORIES.md 解析规则**：

```typescript
// ## category → currentCategory
// - [importance] content → fact
const categoryMatch = line.match(/^##\s+(.+)$/);
const factMatch = line.match(/^-\s+\[(\d+)\]\s+(.+)$/);
```

**使用方式**：

1. 手动编辑 `~/.gemini-jarvis/memory/MEMORIES.md`
2. 重启 Jarvis
3. 看到日志：`📖 MEMORIES.md modified since last flush — syncing L1 → L2...`

---

### 3.5 Auto-Backfill（启动自愈）

`setEmbedContent()` 注入后自动触发 `autoBackfill()`，执行以下步骤：

1. **`rebuildVecTablesIfDimensionMismatch()`** — 检测维度变化，必要时重建虚拟表
2. **`syncFromPhysicalLayerIfModified()`** — L1→L2 同步
3. **`backfillVecFacts()`** — 修复 `vec_facts` 缺失：
   - 有 embedding 但不在 `vec_facts` 的 → 直接插入
   - 没有 embedding 的 → 批量生成（每批 20 条）
4. **`backfillFts()`** — 修复 `facts_fts` 缺失：不在 FTS 索引的 fact → 批量插入
5. **`backfillPhysicalLayer()`** — 如果 `MEMORIES.md` 缺失或为空 → 从 SQLite 重建

---

### 3.6 夜间反思任务

**任务配置**（自动创建，不可删除）：

```json
{
  "id": "nightly-reflection",
  "cron": "0 22 * * *",
  "type": "reflect",
  "enabled": true
}
```

`type: "reflect"` 触发 `proactiveTaskRunner` 直接调用 `memoryService.reflect()`，不经过 LLM 解析。

`reflect()` 流程：

1. 读取所有非 insight facts
2. 调用 LLM 生成 2-5 条高阶 insights
3. 原子替换旧 insights
4. 刷写 L1（`flushToPhysicalLayer`）

---

## 四、数据流总览

```
每次对话
    ↓
refreshContext(userPrompt)
    ├── searchFacts(userPrompt)
    │     ├── 全表读 facts → Map<id, fact>
    │     ├── alwaysFacts（preference + insight，始终注入）
    │     ├── vec_facts MATCH → 向量近邻
    │     ├── facts_fts MATCH → BM25（hybridSearch=true）
    │     ├── RRF + importance + decay → 排序取 top N
    │     └── 异步更新 last_accessed + access_count
    └── search(userPrompt, prewarmLimit)
          └── vec_memories MATCH → 相似历史对话预热
    ↓
LLM 处理
    ↓
对话结束
    ├── enqueue() → vec_memories 异步写入
    └── distiller.distill() → 提取新 facts → saveFact()
          ├── 精确去重 + Jaccard/embedding 语义去重
          ├── insertFactWithVec() → facts + vec_facts + facts_fts 同步写入
          └── 触发 consolidateFacts()（facts 数超过阈值）
                ├── LLM 语义合并去重
                ├── 重建 facts + vec_facts + facts_fts
                └── flushToPhysicalLayer() → MEMORIES.md
```

---

## 五、配置参考

`~/.gemini-jarvis/config.json` 完整 memory 相关配置：

```json
{
  "models": {
    "embedding": "models/gemini-embedding-001",
    "embeddingDimension": 1024
  },
  "embeddingService": {
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "bge-m3"
  },
  "memory": {
    "ingestionDelayMs": 800,
    "retrievalLimit": 5,
    "consolidationThreshold": 3,
    "dedupStrategy": "jaccard",
    "factRelevanceStrategy": "embedding",
    "factRelevanceLimit": 5,
    "prewarmLimit": 3,
    "l1WriteMode": "batch",
    "vectorSimilarityWeight": 0.7,
    "importanceWeight": 0.2,
    "accessWeight": 0.1,
    "decayLambda": 0.1,
    "hybridSearch": true,
    "rrfK": 60
  }
}
```

---

## 六、已实现 vs 未实现的 DNI 特性

| 特性                         | 状态 | 说明                              |
| ---------------------------- | ---- | --------------------------------- |
| L1 物理层（MEMORIES.md）     | ✅   | 写入 + 手动编辑自愈               |
| L2 神经层（vec_facts）       | ✅   | 向量存储 + 自动 backfill          |
| L3 动态权重（importance）    | ✅   | LLM 评分 + consolidation          |
| L3 时间衰减                  | ✅   | 指数衰减，λ=0.1                   |
| L3 访问频率记录              | ✅   | access_count 记录，未参与融合分数 |
| 混合检索（BM25 + 向量）      | ✅   | FTS5 + RRF                        |
| 本地 Ollama embedding        | ✅   | bge-m3 等模型                     |
| 主体归属防火墙               | ✅   | distiller prompt 严格限制         |
| 夜间反思任务                 | ✅   | 每日 22:00 自动执行               |
| 神经关联/知识图谱            | ❌   | 规划中（实体识别 + 关联表）       |
| 时间图谱（Graph 融合）       | ❌   | 规划中                            |
| access_count 参与融合分数    | ❌   | 待评估（与 importance 重叠）      |
| 自动遗忘（低访问 fact 删除） | ❌   | 规划中                            |
