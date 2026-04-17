# Jarvis Configuration Reference

Configuration file location: `~/.gemini-jarvis/config.json`

---

```jsonc
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
  },

  // ─────────────────────────────────────────────
  // Reflection — model for consolidateFacts and nightly reflect
  // ─────────────────────────────────────────────
  "reflection": {
    // "gemini": use existing CLI auth / generateTextFn
    // "ollama": use local Ollama model (default, works offline)
    "provider": "ollama",

    // Ollama service URL. Only used when provider = "ollama".
    "baseUrl": "http://localhost:11434",

    // Ollama model name, e.g. "gemma4:e2b". Only used when provider = "ollama".
    // If empty, falls back to gemini provider automatically.
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

    // Whether to store raw conversation pairs (user+assistant) in vec_memories.
    // With events extraction enabled, raw conversations add low signal.
    // Default: false
    "ingestConversations": false,

    // Trigger backfillSessionEvents() every N conversation turns (async, non-blocking).
    // Ensures current session events are extracted without requiring a restart.
    // 0 = disabled. Default: 20
    "eventsExtractionInterval": 20,

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
```
