# 📝 Jarvis DNI (动态神经索引) 架构设计文档

**版本**：v1.0 (2026.04.13)  
**状态**：实现中 (In-progress)  
**目标**：将 Jarvis 从“静态 RAG 存储”进化为具备“生命力”与“自我意识”的动态记忆系统。

---

## 1. 设计背景 (Background)

传统的 AI Agent 记忆通常依赖静态向量数据库（如 `vec_memories`），这种模式存在三个核心瓶颈：

1.  **索引污染**：无法区分“关于用户的事实”、“关于系统的指令”和“纯粹的技术讨论”。
2.  **认知黑盒**：记忆存储在 SQLite/Vector 库中，用户看不见摸不着，无法直观纠偏。
3.  **权重均等**：无法根据时间、频率或反馈动态调整记忆的“活跃度”。

**DNI (Dynamic Neural Index)** 的核心理念是**让索引具有生命力**，通过多层解耦与动态权重复合，实现记忆的主动演进。

---

## 2. 三层解耦架构 (3-Layer Architecture)

Jarvis 的 DNI 方案采用了物理、神经、逻辑三层解耦设计：

### L1: 物理层 (Physical Layer) - `MEMORIES.md`

- **介质**：人类可读的 Markdown 文件。
- **路径**：`~/.gemini-jarvis/memory/MEMORIES.md`
- **作用**：作为系统的“终极事实来源 (Truth Source)”。
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

- **介质**：SQLite `importance` 字段 + LRU 缓存。
- **作用**：控制记忆的“热度”与“优先级”。
- **特性**：
  - **权重融合**：检索分数 = $\alpha \cdot 向量相似度 \times \beta \cdot 核心重要度$。
  - **场景激活**：根据当前任务（如金融分析、代码编写）自动激活特定神经簇。

---

## 3. 核心机制 (Core Mechanisms)

### 3.1 主体归属防火墙 (Entity Attribution)

- **逻辑**：在后台提炼（Distillation）阶段，通过 Prompt 强制执行主体校验。
- **预防目标**：明确区分“用户”、“Jarvis 系统”与“外部实体（如 OpenClaw）”。
- **规则**：非关于用户习惯或系统约束的事实，一律不予入库。

### 3.2 自动回填与对齐 (Auto-Backfill)

- **触发**：系统启动、AI 引擎就绪时自动执行。
- **流程**：
  1.  扫描 `facts` 表 vs `vec_facts` 数量。
  2.  扫描物理文件 `MEMORIES.md` 是否存在。
  3.  缺失则调用代理通道（Proxy-enabled Channel）补全向量与文件记录。

### 3.3 认知反思 (The "Dreaming" Phase)

- **执行**：每日 22:00 准时触发。
- **任务**：
  - **压缩**：合并重复的、琐碎的对话事实。
  - **升华**：从日常交互中总结出高阶洞察（Meta-Insights）。
  - **刷写 (Flush)**：将总结结果同步更新至 L1 物理文件顶部。

---

## 4. 技术栈实现 (Implementation Details)

| 组件          | 实现技术                                      |
| :------------ | :-------------------------------------------- |
| **向量引擎**  | `sqlite-vec` (Loadable Extension)             |
| **数据库**    | `better-sqlite3`                              |
| **Embedding** | Google Gemini `text-embedding-004`            |
| **本地 I/O**  | Node.js `fs.appendFileSync`                   |
| **网络层**    | `HttpsProxyAgent` 注入 + CLI `generator` 代理 |

---

## 5. 未来演进 (Roadmap)

1.  **Graph 融合**：在 DNI 逻辑中引入图数据库（或基于 SQLite 的三元组存储），建立实体间的显式逻辑链路。
2.  **时间衰减函数**：引入记忆随时间自动降低权重的算法，模拟真实人类的遗忘规律。
3.  **Hybrid Fusion**：实现 `Vector + BM25` 的混合检索，提升对代码片段和专有名词的搜索精度。
