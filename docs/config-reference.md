# Jarvis Configuration Reference

Configuration file location: `~/.gemini-jarvis/config.json`

---

````jsonc
{
  // ─────────────────────────────────────────────
  // API — Google / Gemini credentials
  // ─────────────────────────────────────────────
  "api": {
    // Gemini API key. Can also be set via GOOGLE_API_KEY or GEMINI_API_KEY env vars.
    // Required when using Google API for embedding or distillation.
    "key": "",

    // HTTP/HTTPS proxy URL, e.g. "http://127.0.0.1:7890"
    // Can also be set via HTTPS_PROXY env var.
    "proxy": "",

    // Force API key auth (generativelanguage.googleapis.com) instead of Google Login.
    // Requires api.key to be set. Default: false
    "forceApiKey": false,
  },

  // ─────────────────────────────────────────────
  // Models — LLM model selection
  // ─────────────────────────────────────────────
  "models": {
    // Chat model. "auto" lets Gemini CLI choose the best available model.
    "chat": "auto",

    // Embedding model used when embeddingService.provider = "google".
    "embedding": "models/gemini-embedding-001",

    // Embedding vector dimension. Must match the model output.
    // Google gemini-embedding-001: 3072 (or 1024 with task_type truncation)
    // Ollama bge-m3: 1024
    "embeddingDimension": 1024,

    // Model used for fact distillation (BackgroundDistiller).
    // Also used for consolidateFacts/reflect when reflection.provider = "gemini".
    // When reflection.provider = "ollama", this field is ignored for reflection.
    "distillation": "gemini-2.5-flash",
  },

  // ─────────────────────────────────────────────
  // Embedding Service — vector generation backend
  // ─────────────────────────────────────────────
  "embeddingService": {
    // "google": use Gemini API key (requires api.key)
    // "ollama": use local Ollama service (no internet required)
    "provider": "google",

    // Ollama service URL. Only used when provider = "ollama".
    "baseUrl": "http://localhost:11434",

    // Ollama embedding model name, e.g. "bge-m3", "nomic-embed-text".
    // Only used when provider = "ollama".
    "model": "bge-m3",
  },

  // ─────────────────────────────────────────────
  // Summarizer — session history compression on startup
  // ─────────────────────────────────────────────
  "summarizer": {
    // "gemini": use CLI auth generateText (default)
    // "ollama": use local Ollama model (recommended when using Code Assist)
    "provider": "ollama",

    // Ollama service URL. Default: "http://localhost:11434"
    "baseUrl": "http://localhost:11434",

    // Ollama model for summarization. Default: "gemma4:e2b".
    // Larger models produce better summaries (e.g. "gemma4:27b") but are slower.
    // If empty, falls back to gemini provider.
    "model": "gemma4:e2b",

    // Timeout per Ollama call in milliseconds. Default: 120000 (2 min)
    "timeoutMs": 120000,

    // Max messages per summarization chunk.
    // When new messages > chunkSize, they are processed in rolling batches:
    //   chunk1 → summary1 → chunk2 + summary1 → summary2 → ...
    // This keeps token count manageable for smaller models.
    // 0 = no chunking (process all at once). Default: 100
    "chunkSize": 100,

    // Only process session files from the last N days for summary updates.
    // Sessions older than this are covered by facts/vec_memories, not summary.
    // This prevents summary from growing unboundedly.
    // 0 = no limit (process all). Default: 0
    "summaryWindowDays": 30,

    // Max characters for the session summary. If exceeded, trigger re-compression.
    // Prevents "Lost in the Middle" degradation from oversized summaries.
    // 0 = no limit. Default: 3000
    "maxSummaryLength": 3000,
  },

  // ─────────────────────────────────────────────
  // Routing — local model routing via Ollama complexity classifier
  // Classifies each request (1-100) and selects proModel or flashModel.
  // ─────────────────────────────────────────────
  "routing": {
    // Enable local model routing. Default: true (inactive until model is set)
    "enabled": true,

    // Currently only "ollama" is supported.
    "provider": "ollama",

    // Ollama model for complexity classification, e.g. "gemma4:e2b".
    // Leave empty ("") to disable routing even when enabled = true.
    "model": "gemma4:e2b",

    // Complexity score threshold (1-100).
    // Score >= threshold → proModel; Score < threshold → flashModel.
    // Default: 70
    "threshold": 70,

    // Model used for complex requests (score >= threshold). Default: "gemini-2.5-pro"
    "proModel": "gemini-2.5-pro",

    // Model used for simple requests (score < threshold). Default: "gemini-2.5-flash"
    "flashModel": "gemini-2.5-flash",

    // Timeout in milliseconds for the classification call. Default: 30000 (30s)
    "timeoutMs": 30000,

    // Number of recent conversation turns included in the classifier prompt
    // for context-aware scoring (e.g. "continue the analysis"). Default: 5
    "historyTurns": 5,

    // Rewrite the user query into an optimized memory search query before prewarm.
    // Uses the same Ollama model. Only applies to personal queries.
    // Default: false
    "queryRewrite": false,

    // Detect topic shifts via the local classifier. When the new message is
    // unrelated to recent history, chat history is cleared before the turn
    // (equivalent to !clear). Skipped on the first turn of a session.
    // Default: true
    "topicShiftDetection": true,
  },

  // ─────────────────────────────────────────────
  // Reranker — cross-encoder precision reranking
  // A local FastAPI service (jarvis/reranker/reranker_service.py) re-scores
  // bi-encoder candidates with ms-marco-MiniLM-L6-v2 via ONNX Runtime.
  // Start with: RERANKER_MODEL_DIR=/path/to/onnx_model ./jarvis/reranker/start_reranker.sh
  // ─────────────────────────────────────────────
  "reranker": {
    // Enable cross-encoder reranking for searchFacts and prewarm memories.
    // When enabled, bi-encoder importance/decay signals are bypassed for
    // candidate selection — the cross-encoder handles final ranking instead.
    // Default: false
    "enabled": false,

    // URL of the reranker service. Default: "http://localhost:7700"
    "baseUrl": "http://localhost:7700",

    // Request timeout per attempt in milliseconds. Default: 15000
    "timeoutMs": 15000,

    // Max retry attempts on timeout or network error.
    // Each retry uses the same timeoutMs. Default: 2 (3 total attempts)
    "maxRetries": 2,

    // Number of candidates to fetch from bi-encoder before reranking.
    // Higher = better recall but more candidates for the cross-encoder to score.
    // The reranker returns the top factRelevanceLimit from this pool.
    // Default: 20
    "candidatePool": 20,

    // Minimum cross-encoder logit score for a memory to be injected into context.
    // Results below this threshold are discarded entirely (not injected as low-confidence).
    // BAAI/bge-reranker-large (recommended): relevant ~-2 to 3, irrelevant ~-10. Recommended: -2
    // BAAI/bge-reranker-base: similar range. Recommended: -2
    // ms-marco-MiniLM-L6-v2: >5 high relevance, 0-5 relevant, <0 irrelevant. Recommended: 6
    // Default: -2 (tuned for bge-reranker-large/base)
    "memoryRelevanceThreshold": -2,
  },

  // ─────────────────────────────────────────────
  // Reflection — model for consolidateFacts, nightly reflect, AND fact distillation
  // ─────────────────────────────────────────────
  // NOTE: This setting now also controls BackgroundDistiller (fact extraction
  // after each conversation turn). Set model to use a local Ollama model for
  // all memory-related LLM calls without sending data to Google.
  "reflection": {
    // "gemini": use existing CLI auth / generateTextFn
    // "ollama": use local Ollama model (default, works offline)
    "provider": "ollama",

    // Ollama service URL. Only used when provider = "ollama".
    "baseUrl": "http://localhost:11434",

    // Ollama model name, e.g. "gemma4:e2b". Only used when provider = "ollama".
    // If empty, falls back to gemini provider automatically.
    // REQUIRED to use local model for fact extraction and reflection.
    "model": "gemma4:e2b",

    // Timeout in milliseconds. Reflection prompts are long — use a generous value.
    // Default: 120000 (2 minutes)
    "timeoutMs": 120000,
  },

  // ─────────────────────────────────────────────
  // Entity Extraction — knowledge graph (Neural Link)
  // Extracts (subject, relation, object) triples from facts
  // to enable graph-based context expansion in searchFacts.
  // ─────────────────────────────────────────────
  "entityExtraction": {
    // Enable entity extraction. Default: true
    "enabled": true,

    // "ollama": use local Ollama model (recommended, fast, no internet)
    // "gemini": reuse the existing generateTextFn (shares distillation model)
    "provider": "ollama",

    // Ollama service URL. Only used when provider = "ollama".
    "baseUrl": "http://localhost:11434",

    // Ollama model for entity extraction, e.g. "gemma4:e2b", "gemma4:e4b".
    // Smaller models are faster and sufficient for this structured task.
    "model": "gemma4:e2b",

    // Request timeout in milliseconds for each Ollama call.
    // Increase for larger/slower models. Default: 30000 (30s)
    "timeoutMs": 30000,

    // Number of facts per batch during backfill.
    // 1 = one fact per call (best accuracy for small models, more calls)
    // 5 = five facts per call (faster but may reduce accuracy)
    // Default: 1
    "batchSize": 1,
  },

  // ─────────────────────────────────────────────
  // Network — retry and error handling
  // ─────────────────────────────────────────────
  "network": {
    // Max retry attempts on network errors (fetch failed, ECONNRESET, etc.).
    // Default: 3
    "maxRetries": 3,

    // Remove orphaned user turn from chat history after all retries fail.
    // Prevents stuck conversation state. Default: true
    "cleanOrphanedTurnOnFailure": true,

    // Max tool-call iterations per processMessage.
    // Aborts and reports to the user if the tool-call loop exceeds this limit,
    // preventing runaway agents on complex or looping tasks. Default: 30
    "maxToolIterations": 30,

    // Abort after this many consecutive rounds where every tool call fails.
    // Surfaces silent failures instead of letting the LLM quietly give up.
    // Default: 3
    "maxConsecutiveToolFailures": 3,
  },

  // ─────────────────────────────────────────────
  // Server — HTTP server settings
  // ─────────────────────────────────────────────
  "server": {
    // Port for the web UI and WebSocket server.
    // Can also be set via JARVIS_PORT env var. Default: 3000
    "port": 3000,
  },

  // ─────────────────────────────────────────────
  // Memory — DNI memory system tuning
  // ─────────────────────────────────────────────
  "memory": {
    // Delay (ms) between each conversation ingestion into vec_memories.
    // Prevents burst embedding calls after long conversations. Default: 800
    "ingestionDelayMs": 800,

    // Max number of similar past conversations returned by search().
    // Used by recall_memory tool. Default: 5
    "retrievalLimit": 5,

    // Number of new facts that triggers consolidateFacts().
    // Lower = more frequent LLM consolidation calls. Default: 3
    "consolidationThreshold": 3,

    // Dedup strategy when saving a new fact:
    // "jaccard": local token overlap (fast, no network)
    // "embedding": semantic cosine similarity (requires embedding service)
    // Default: "embedding"
    "dedupStrategy": "embedding",

    // Strategy for selecting relevant facts to inject into system prompt:
    // "jaccard": keyword overlap ranking
    // "embedding": vector similarity + BM25 hybrid (requires embedding service)
    // Default: "jaccard"
    "factRelevanceStrategy": "embedding",

    // Max number of ranked facts injected per turn.
    // preference and insight facts are always injected regardless of this limit.
    // Default: 5
    "factRelevanceLimit": 5,

    // Number of semantically similar memory items pre-warmed into context
    // each turn via vec_memories (events prioritized over conversations). 0 = disabled. Default: 3
    "prewarmLimit": 3,

    // prewarmLimit override for mixed queries (personal + external intent).
    // Mixed queries carry higher noise risk; a tighter limit reduces context adhesion.
    // Default: 1
    "prewarmLimitMixed": 1,

    // Stricter memoryMaxDistance for mixed queries.
    // Only memories with distance < this value are injected when querySubject=mixed.
    // Default: 0.6
    "prewarmMaxDistanceMixed": 0.6,

    // Max number of skills to inject into the system prompt per turn via semantic retrieval.
    // When total installed skills exceed this limit, only the most relevant are injected.
    // 0 = inject all skills. Default: 5
    "skillSearchLimit": 5,

    // Maximum vector distance for skill retrieval.
    // Skills with distance >= this threshold are not injected.
    // Default: 0.9
    "skillMaxDistance": 0.9,

    // Whether to store raw conversation pairs (user+assistant) in vec_memories.
    // With events extraction enabled, raw conversations add low signal.
    // Default: false
    "ingestConversations": false,

    // Trigger backfillSessionEvents() every N conversation turns (async, non-blocking).
    // Ensures current session events are extracted without requiring a restart.
    // 0 = disabled. Default: 20
    "eventsExtractionInterval": 20,

    // Skip backfillSessionEvents() during startup warmup for faster startup.
    // When false (default), Jarvis waits for all session files to be processed before serving.
    // Set to true on low-end machines when startup speed is more important than events coverage.
    // Default: false
    "skipStartupEventsBackfill": false,

    // L1 physical layer write mode for MEMORIES.md:
    // "realtime": append each fact immediately after saveFact (always up-to-date)
    // "batch": full rewrite only after consolidateFacts or reflect (cleaner file)
    // Default: "batch"
    "l1WriteMode": "batch",

    // ── L3 Fused Ranking Weights ──────────────────
    // Final score = vectorSimilarityWeight * rrfScore
    //             + importanceWeight * (importance / 10)
    //             + accessWeight * decay(last_accessed)
    // Weights do not need to sum to 1.0.

    // Weight for RRF vector+BM25 similarity score. Default: 0.7
    "vectorSimilarityWeight": 0.7,

    // Weight for fact importance (1–10 scale, normalized). Default: 0.2
    "importanceWeight": 0.2,

    // Weight for recency decay. Default: 0.1
    "accessWeight": 0.1,

    // Decay rate λ: decay = e^(-λ × days_since_last_access)
    // 0.1 → ~37% after 10 days, ~5% after 30 days. Default: 0.1
    "decayLambda": 0.1,

    // Enable hybrid search (BM25 + vector via RRF fusion).
    // Only applies when factRelevanceStrategy = "embedding". Default: true
    "hybridSearch": true,

    // RRF parameter k. Higher k reduces the dominance of top-ranked results.
    // Standard value is 60. Default: 60
    "rrfK": 60,

    // Maximum L2 distance for vec_facts KNN candidate filtering.
    // Facts with distance >= this value are excluded at the KNN stage,
    // before RRF fusion — keeps relevance signal clean from importance/decay.
    // bge-m3 guide: <0.5 high relevance, <1.0 medium, >1.5 noise.
    // Only applies when factRelevanceStrategy = "embedding". Default: 1.0
    "factMaxDistance": 1.0,

    // Maximum L2 distance for vec_memories filtering (prewarm + recall_memory).
    // Memories with distance >= this value are excluded from prewarm injection,
    // preventing semantically irrelevant history from polluting context.
    // Uses same distance scale as factMaxDistance. Default: 1.0
    "memoryMaxDistance": 1.0,
  },

  // ─────────────────────────────────────────────
  // Security
  // ─────────────────────────────────────────────
  "security": {
    // Bypass Gemini CLI policy engine (allow all tool calls without confirmation).
    // WARNING: disables safety guardrails. Default: false
    "jailbreak": false,
  },

  // ─────────────────────────────────────────────
  // Feishu (Lark) — messaging channel
  // ─────────────────────────────────────────────
  "feishu": {
    // Enable Feishu integration. Default: false
    "enabled": false,

    // Feishu app credentials (from Feishu Open Platform).
    "appId": "",
    "appSecret": "",

    // Show LLM thinking process in Feishu messages. Default: false
    "showThoughts": false,
  },

  // ─────────────────────────────────────────────
  // WeChat — messaging channel
  // ─────────────────────────────────────────────
  "wechat": {
    // Enable WeChat integration. Default: false
    "enabled": false,

    // WeChat API server base URL.
    "apiBaseUrl": "https://ilinkai.weixin.qq.com",
  },

  // ─────────────────────────────────────────────
  // Session — conversation history management
  // ─────────────────────────────────────────────
  "session": {
    // Route all conversations to a single shared session.
    // Useful for WeChat/Feishu where multiple users share one Jarvis instance.
    // Default: false
    "useGlobalSession": false,

    // Session ID used when useGlobalSession = true.
    "globalSessionId": "jarvis-global-master",

    // Restore previous conversation history on startup (summary + recent turns).
    // Default: true
    "resumeOnStart": true,

    // Number of recent raw message turns to include after the compressed summary.
    // Higher = more context but more tokens per request. Default: 3
    "recentTurnsOnResume": 3,

    // Compress in-memory chat history when it exceeds this many turns.
    // Uses summarizer.model; keeps only historyKeepRecentTurns raw turns.
    // 0 = disabled. Default: 30
    "historyCompressionThreshold": 30,

    // Number of recent turns to keep as raw messages after compression. Default: 5
    "historyKeepRecentTurns": 5,

    // When code density (messages with ```) is high (>15%), multiply
    // historyCompressionThreshold by this factor to preserve context.
    // Default: 2.0
    "codeHeavyThresholdMultiplier": 2.0,
  },

  // ─────────────────────────────────────────────
  // Tasks — proactive task scheduler
  // ─────────────────────────────────────────────
  "tasks": {
    // Default channel for proactive task output: "feishu", "wechat", or "websocket".
    "defaultChannel": "feishu",

    // Default chat/user ID for the default channel.
    "defaultChatId": "",
  },
}
````
