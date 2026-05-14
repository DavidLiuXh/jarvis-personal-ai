# Jarvis 配置参考文档

配置文件路径：`~/.gemini-jarvis/config.json`

---

````jsonc
{
  // ─────────────────────────────────────────────
  // API — Google / Gemini 凭证
  // ─────────────────────────────────────────────
  "api": {
    // Gemini API Key。也可通过环境变量 GOOGLE_API_KEY 或 GEMINI_API_KEY 设置。
    // 使用 Google API 做 embedding 或 distillation 时必填。
    "key": "",

    // HTTP/HTTPS 代理地址，例如 "http://127.0.0.1:7890"
    // 也可通过环境变量 HTTPS_PROXY 设置。
    "proxy": "",

    // 强制使用 API Key 认证（generativelanguage.googleapis.com），而非 Google 登录。
    // 需要设置 api.key。默认：false
    "forceApiKey": false,
  },

  // ─────────────────────────────────────────────
  // Models — LLM 模型选择
  // ─────────────────────────────────────────────
  "models": {
    // 对话模型。"auto" 表示由 Gemini CLI 自动选择最优模型。
    "chat": "auto",

    // embeddingService.provider = "google" 时使用的 embedding 模型。
    "embedding": "models/gemini-embedding-001",

    // Embedding 向量维度，需与模型输出一致。
    // Google gemini-embedding-001：3072（或截断为 1024）
    // Ollama bge-m3：1024
    "embeddingDimension": 1024,

    // 用于事实提炼（BackgroundDistiller）的模型。
    // 当 reflection.provider = "gemini" 时，也用于 consolidateFacts/reflect。
    // 当 reflection.provider = "ollama" 时，此字段不影响反思任务。
    "distillation": "gemini-2.5-flash",
  },

  // ─────────────────────────────────────────────
  // Embedding Service — 向量生成服务
  // ─────────────────────────────────────────────
  "embeddingService": {
    // "google"：使用 Gemini API Key（需要 api.key）
    // "ollama"：使用本地 Ollama 服务（无需联网）
    "provider": "google",

    // Ollama 服务地址。仅 provider = "ollama" 时生效。
    "baseUrl": "http://localhost:11434",

    // Ollama embedding 模型名称，例如 "bge-m3"、"nomic-embed-text"。
    // 仅 provider = "ollama" 时生效。
    "model": "bge-m3",
  },

  // ─────────────────────────────────────────────
  // Summarizer — 启动时的会话历史压缩
  // ─────────────────────────────────────────────
  "summarizer": {
    // "gemini"：使用 CLI 认证（默认）
    // "ollama"：使用本地 Ollama 模型（Code Assist 模式推荐）
    "provider": "ollama",

    // Ollama 服务地址。默认："http://localhost:11434"
    "baseUrl": "http://localhost:11434",

    // Ollama 摘要模型。默认："gemma4:e2b"。
    // 较大模型（如 "gemma4:27b"）摘要质量更好但速度更慢。
    // 留空时自动 fallback 到 gemini。
    "model": "gemma4:e2b",

    // 每次 Ollama 调用的超时时间（毫秒）。默认：120000（2分钟）
    "timeoutMs": 120000,

    // 每批处理的最大消息数。
    // 当新消息数 > chunkSize 时，分批滚动处理：
    //   第1批 → 摘要1 → 第2批 + 摘要1 → 摘要2 → ...
    // 适合小模型，避免单次 token 过多。
    // 0 = 不分段（一次处理全部）。默认：100
    "chunkSize": 100,

    // 只处理最近 N 天的 session 文件用于摘要更新。
    // 更早的历史由 facts/vec_memories 覆盖，不再进入摘要，防止摘要无限膨胀。
    // 0 = 不限制（处理全部）。默认：0
    "summaryWindowDays": 30,

    // 摘要最大字符数。超过则触发再压缩。
    // 防止摘要过长导致"中间信息丢失"问题。
    // 0 = 不限制。默认：3000
    "maxSummaryLength": 3000,
  },

  // ─────────────────────────────────────────────
  // Routing — 基于 Ollama 的本地模型路由
  // 对每条请求进行复杂度打分（1-100），自动选择 proModel 或 flashModel。
  // ─────────────────────────────────────────────
  "routing": {
    // 启用本地模型路由。默认：true（设置 model 后生效）
    "enabled": true,

    // 目前仅支持 "ollama"。
    "provider": "ollama",

    // 用于复杂度分类的 Ollama 模型，例如 "gemma4:e2b"。
    // 留空（""）时即使 enabled = true 路由也不会生效。
    "model": "gemma4:e2b",

    // 复杂度分数阈值（1-100）。
    // 分数 >= 阈值 → proModel；分数 < 阈值 → flashModel。默认：70
    "threshold": 70,

    // 复杂请求使用的模型（分数 >= 阈值）。默认："gemini-2.5-pro"
    "proModel": "gemini-2.5-pro",

    // 简单请求使用的模型（分数 < 阈值）。默认："gemini-2.5-flash"
    "flashModel": "gemini-2.5-flash",

    // 分类调用的超时时间（毫秒）。默认：30000（30秒）
    "timeoutMs": 30000,

    // 传入分类器 prompt 的最近对话轮数，用于上下文感知打分
    // （例如"继续上面的分析"这类依赖上下文的请求）。默认：5
    "historyTurns": 5,

    // 在 prewarm 之前将用户 query 改写为优化后的记忆搜索关键词。
    // 使用与分类器相同的 Ollama 模型。仅对 personal 类型请求生效。默认：false
    "queryRewrite": false,

    // 通过本地分类器检测话题切换。当新消息与近期历史无关时，
    // 在本轮开始前自动清空对话历史（等效于 !clear）。第一轮不触发。
    // 默认：true
    "topicShiftDetection": true,
  },

  // ─────────────────────────────────────────────
  // Reranker — cross-encoder 精排服务
  // 通过本地 FastAPI 服务（jarvis/reranker/reranker_service.py）对 bi-encoder 候选
  // 使用 ms-marco-MiniLM-L6-v2（ONNX Runtime）进行精确重排序。
  // 启动方式：RERANKER_MODEL_DIR=/path/to/onnx_model ./jarvis/reranker/start_reranker.sh
  // ─────────────────────────────────────────────
  "reranker": {
    // 是否启用 cross-encoder 精排（用于 searchFacts 和 prewarm 记忆）。
    // 启用后，bi-encoder 阶段仅使用纯语义相关性选候选（importance/decay 不参与），
    // 最终排序由 cross-encoder 完成。默认：false
    "enabled": false,

    // 精排服务地址。默认："http://localhost:7700"
    "baseUrl": "http://localhost:7700",

    // 每次请求的超时时间（毫秒）。默认：5000
    "timeoutMs": 15000,

    // 超时或网络错误时的最大重试次数。
    // 每次重试使用相同的 timeoutMs。默认：2（共尝试 3 次）
    "maxRetries": 2,

    // bi-encoder 阶段获取的候选数量（在 cross-encoder 精排之前）。
    // 越大则召回率越高，但 cross-encoder 需要评分的候选越多。
    // cross-encoder 最终从中返回 factRelevanceLimit 条。默认：20
    "candidatePool": 20,

    // 记忆注入的最低 cross-encoder logit 分数门槛。
    // 低于此值的结果直接丢弃，不以"低置信度"形式注入。
    // BAAI/bge-reranker-large（推荐）：相关 ~-2 到 3，不相关 ~-10。推荐值：-2
    // BAAI/bge-reranker-base：范围相近。推荐值：-2
    // ms-marco-MiniLM-L6-v2：> 5 高度相关，0-5 相关，< 0 不相关。推荐值：6
    // 默认：-2（针对 bge-reranker-large/base 调校）
    "memoryRelevanceThreshold": -2,
  },

  // ─────────────────────────────────────────────
  // Reflection — consolidateFacts、夜间反思任务，以及 Fact 提取（BackgroundDistiller）使用的模型
  // ─────────────────────────────────────────────
  // 注意：此配置现在同时控制 BackgroundDistiller（每轮对话后的事实提取）。
  // 设置 model 后，所有记忆相关的 LLM 调用都将使用本地 Ollama，无需将数据发送给 Google。
  "reflection": {
    // "gemini"：使用现有 CLI 认证 / generateTextFn
    // "ollama"：使用本地 Ollama 模型（默认，离线可用）
    "provider": "ollama",

    // Ollama 服务地址。仅 provider = "ollama" 时生效。
    "baseUrl": "http://localhost:11434",

    // Ollama 模型名称，例如 "gemma4:e2b"。仅 provider = "ollama" 时生效。
    // 留空时自动 fallback 到 gemini provider。
    // 若要在本地完成事实提取和反思，此字段必填。
    "model": "gemma4:e2b",

    // 超时时间（毫秒）。反思 prompt 较长，建议设置较大值。默认：120000（2分钟）
    "timeoutMs": 120000,
  },

  // ─────────────────────────────────────────────
  // Entity Extraction — 知识图谱（神经关联）
  // 从 facts 中提取（主体, 关系, 客体）三元组，
  // 用于 searchFacts 时的图扩展，补充相关上下文。
  // ─────────────────────────────────────────────
  "entityExtraction": {
    // 是否启用实体提取。默认：true
    "enabled": true,

    // "ollama"：使用本地 Ollama 模型（推荐，速度快，无需联网）
    // "gemini"：复用现有 generateTextFn（与 distillation 共用模型）
    "provider": "ollama",

    // Ollama 服务地址。仅 provider = "ollama" 时生效。
    "baseUrl": "http://localhost:11434",

    // 用于实体提取的 Ollama 模型，例如 "gemma4:e2b"、"gemma4:e4b"。
    // 较小的模型速度更快，对此结构化任务已足够。
    "model": "gemma4:e2b",

    // 每次 Ollama 调用的超时时间（毫秒）。
    // 模型越大越慢，可适当增大。默认：30000（30秒）
    "timeoutMs": 30000,

    // backfill 时每批处理的 facts 数量。
    // 1 = 每次只处理一条（精度最高，调用次数多）
    // 5 = 每次处理五条（更快，但小模型精度可能下降）
    // 默认：1
    "batchSize": 1,
  },

  // ─────────────────────────────────────────────
  // Network — 网络重试与错误处理
  // ─────────────────────────────────────────────
  "network": {
    // 网络错误（fetch failed、ECONNRESET 等）时的最大重试次数。默认：3
    "maxRetries": 3,

    // 所有重试失败后，自动清除对话历史中的孤立 user turn，
    // 防止对话状态卡死。默认：true
    "cleanOrphanedTurnOnFailure": true,

    // 单次 processMessage 中工具调用的最大轮次。
    // 超过此限制时主动终止并向用户报告，防止复杂任务或死循环导致 Agent 失控。
    // 默认：30
    "maxToolIterations": 30,

    // 连续 N 轮工具调用全部失败后终止任务。
    // 将静默失败转化为主动报告，而不是让 LLM 悄悄放弃。
    // 默认：3
    "maxConsecutiveToolFailures": 3,
  },

  // ─────────────────────────────────────────────
  // Server — HTTP 服务器设置
  // ─────────────────────────────────────────────
  "server": {
    // Web UI 和 WebSocket 服务器端口。
    // 也可通过环境变量 JARVIS_PORT 设置。默认：3000
    "port": 3000,
  },

  // ─────────────────────────────────────────────
  // Memory — DNI 记忆系统调优
  // ─────────────────────────────────────────────
  "memory": {
    // 每次对话写入 vec_memories 的延迟（毫秒）。
    // 避免长对话结束后集中触发大量 embedding 调用。默认：800
    "ingestionDelayMs": 800,

    // search() 返回的最大相似历史对话数量。
    // 用于 recall_memory 工具。默认：5
    "retrievalLimit": 5,

    // 触发 consolidateFacts() 的新增 facts 数量阈值。
    // 越小则 LLM 合并调用越频繁。默认：3
    "consolidationThreshold": 3,

    // 保存新 fact 时的去重策略：
    // "jaccard"：本地词元重叠（快，无需网络）
    // "embedding"：语义余弦相似度（需要 embedding 服务）
    // 默认："embedding"
    "dedupStrategy": "embedding",

    // 注入 system prompt 时的 facts 检索策略：
    // "jaccard"：关键词重叠排名
    // "embedding"：向量相似度 + BM25 混合检索（需要 embedding 服务）
    // 默认："jaccard"
    "factRelevanceStrategy": "embedding",

    // 每轮对话注入的最大 facts 数量。
    // preference 和 insight 类别始终注入，不受此限制。默认：5
    "factRelevanceLimit": 5,

    // 每轮对话从 vec_memories 预热的相似记忆条数（events 优先于 conversation）。
    // 0 = 禁用。默认：3
    "prewarmLimit": 3,

    // mixed 类型请求的 prewarmLimit 覆盖值（personal + external 混合意图）。
    // mixed 请求噪声风险更高，收紧此值可减少 Context Adhesion 问题。默认：1
    "prewarmLimitMixed": 1,

    // mixed 类型请求时更严格的 memoryMaxDistance 门槛。
    // 距离 >= 此值的记忆在 mixed 请求时不注入。默认：0.6
    "prewarmMaxDistanceMixed": 0.6,

    // 每轮通过语义检索注入 system prompt 的最大 skills 数量。
    // 安装的 skills 超过此数时，只注入最相关的几个。0 = 全部注入。默认：5
    "skillSearchLimit": 5,

    // skill 检索的最大向量距离门槛。
    // 距离 >= 此值的 skills 不注入。默认：0.9
    "skillMaxDistance": 0.9,

    // 是否将原始对话对（user+assistant）存入 vec_memories。
    // 启用事件提取后，原始对话信噪比低，建议关闭。默认：false
    "ingestConversations": false,

    // 每 N 轮对话触发一次 backfillSessionEvents()（异步，不阻塞交互）。
    // 确保长期运行时当天的对话能及时提取为 events，无需重启。
    // 0 = 禁用。默认：20
    "eventsExtractionInterval": 20,

    // 启动时跳过 backfillSessionEvents()，加快启动速度。
    // false（默认）：等待所有 session 文件处理完成后再对外服务。
    // true：跳过，适合配置较低的机器或不关心 events 覆盖率的场景。
    // 默认：false
    "skipStartupEventsBackfill": false,

    // L1 物理层（MEMORIES.md）写入模式：
    // "realtime"：每次 saveFact 后立即追加（实时，可能有轻微冗余）
    // "batch"：仅在 consolidateFacts 或 reflect 后全量重写（文件更整洁）
    // 默认："batch"
    "l1WriteMode": "batch",

    // ── L3 融合排名权重 ───────────────────────────
    // 最终分数 = vectorSimilarityWeight × rrfScore
    //           + importanceWeight × (importance / 10)
    //           + accessWeight × decay(last_accessed)
    // 三个权重不需要加和为 1.0。

    // RRF 向量+BM25 相似度分数的权重。默认：0.7
    "vectorSimilarityWeight": 0.7,

    // fact 重要性（1-10 分，归一化）的权重。默认：0.2
    "importanceWeight": 0.2,

    // 访问时间衰减的权重。默认：0.1
    "accessWeight": 0.1,

    // 时间衰减率 λ：decay = e^(-λ × 距上次访问天数)
    // 0.1 → 10天后约37%，30天后约5%。默认：0.1
    "decayLambda": 0.1,

    // 启用混合检索（BM25 + 向量，通过 RRF 融合）。
    // 仅在 factRelevanceStrategy = "embedding" 时生效。默认：true
    "hybridSearch": true,

    // RRF 参数 k。越大则顶部排名的优势越小，结果更均匀。
    // 标准值为 60。默认：60
    "rrfK": 60,

    // vec_facts KNN 候选过滤的最大 L2 距离门槛。
    // 距离 >= 此值的 facts 在 KNN 阶段直接过滤，不进入 RRF 融合，
    // 保证相关性信号不被 importance/decay 污染。
    // bge-m3 参考值：< 0.5 高相关，< 1.0 中等相关，> 1.5 基本无关。
    // 仅在 factRelevanceStrategy = "embedding" 时生效。默认：1.0
    "factMaxDistance": 1.0,

    // vec_memories 过滤的最大 L2 距离门槛（prewarm 预热 + recall_memory 工具）。
    // 距离 >= 此值的历史记忆不注入 prewarm 上下文，
    // 防止语义无关的历史片段污染当前对话上下文，缓解 Context Adhesion 问题。
    // 与 factMaxDistance 使用相同的距离尺度。默认：1.0
    "memoryMaxDistance": 1.0,
  },

  // ─────────────────────────────────────────────
  // Security — 安全设置
  // ─────────────────────────────────────────────
  "security": {
    // 绕过 Gemini CLI 策略引擎（允许所有工具调用，无需确认）。
    // 警告：会禁用安全防护机制。默认：false
    "jailbreak": false,
  },

  // ─────────────────────────────────────────────
  // Feishu — 飞书消息通道
  // ─────────────────────────────────────────────
  "feishu": {
    // 启用飞书集成。默认：false
    "enabled": false,

    // 飞书应用凭证（从飞书开放平台获取）。
    "appId": "",
    "appSecret": "",

    // 在飞书消息中显示 LLM 思考过程。默认：false
    "showThoughts": false,
  },

  // ─────────────────────────────────────────────
  // WeChat — 微信消息通道
  // ─────────────────────────────────────────────
  "wechat": {
    // 启用微信集成。默认：false
    "enabled": false,

    // 微信 API 服务器地址。
    "apiBaseUrl": "https://ilinkai.weixin.qq.com",
  },

  // ─────────────────────────────────────────────
  // Session — 对话历史管理
  // ─────────────────────────────────────────────
  "session": {
    // 将所有对话路由到同一个共享 session。
    // 适合微信/飞书等多用户共用一个 Jarvis 实例的场景。默认：false
    "useGlobalSession": false,

    // useGlobalSession = true 时使用的 session ID。
    "globalSessionId": "jarvis-global-master",

    // 启动时恢复历史对话（摘要 + 最近几轮）。默认：true
    "resumeOnStart": true,

    // 压缩摘要之后追加的原始消息轮数。
    // 越大上下文越完整，但每次请求的 token 消耗越多。默认：3
    "recentTurnsOnResume": 3,

    // 当内存中的对话历史超过此轮数时，自动压缩旧历史。
    // 使用 summarizer.model 生成摘要，只保留最近 historyKeepRecentTurns 轮原始消息。
    // 0 = 禁用。默认：30
    "historyCompressionThreshold": 30,

    // 压缩后保留的最近原始消息轮数。默认：5
    "historyKeepRecentTurns": 5,

    // 当对话中代码密度较高（包含 ``` 的消息占比 >15%）时，
    // 将压缩门槛乘以该倍率，以保留更多工程上下文。
    // 默认：2.0
    "codeHeavyThresholdMultiplier": 2.0,
  },

  // ─────────────────────────────────────────────
  // Tasks — 定时任务调度器
  // ─────────────────────────────────────────────
  "tasks": {
    // 定时任务输出的默认通道："feishu"、"wechat" 或 "websocket"。
    "defaultChannel": "feishu",

    // 默认通道的目标 chat/user ID。
    "defaultChatId": "",
  },
}
````
