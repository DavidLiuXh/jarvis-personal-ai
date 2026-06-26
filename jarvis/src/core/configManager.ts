/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface JarvisConfig {
  api: {
    key: string;
    proxy?: string;
    /** Force API Key auth (generativelanguage.googleapis.com) instead of Google Login. Requires api.key to be set. */
    forceApiKey?: boolean;
  };
  models: {
    chat: string;
    embedding: string;
    embeddingDimension: number;
    distillation: string;
  };
  /**
   * Global Ollama service configuration.
   * All Ollama-based features (embedding, routing, reflection, entity extraction,
   * summarizer, intent resolution) use these as defaults.
   */
  ollama: {
    /** Ollama service base URL. Default: "http://localhost:11434". */
    baseUrl: string;
    /** Default request timeout in milliseconds. Default: 30000. */
    defaultTimeoutMs: number;
    /**
     * Max retry attempts on timeout or network errors. Each retry increases
     * timeout up to 3x the base. Default and enforced minimum: 2
     * (total 3 attempts).
     */
    maxRetries: number;
  };
  /**
   * Embedding service configuration.
   * provider 'google': use Gemini API key (requires api.key).
   * provider 'ollama': use local Ollama service.
   */
  embeddingService: {
    provider: "google" | "ollama";
    /** Ollama model name, e.g. "bge-m3". Only used when provider='ollama'. */
    model?: string;
  };
  /**
   * Local model routing: classify request complexity via Ollama,
   * then select the configured pro or flash runtime target accordingly.
   */
  routing?: {
    /** Enable local routing. Default: false. */
    enabled: boolean;
    /** 'ollama': use local Ollama model (default). */
    provider?: "ollama";
    /** Ollama model for complexity classification, e.g. "gemma4:e2b". */
    model: string;
    /** Complexity score threshold (1-100). Score >= threshold → pro target. Default: 70. */
    threshold?: number;
    /**
     * Backend-neutral runtime model targets. These values must be valid for
     * the selected main-chat backend, e.g. Gemini model names for Gemini CLI
     * or OpenAI-compatible model IDs for OpenAI-compatible backends.
     */
    targets?: {
      /** Model to use for complex requests. */
      pro?: string;
      /** Model to use for simple requests. */
      flash?: string;
    };
    /** Legacy Gemini compatibility alias for targets.pro. */
    proModel?: string;
    /** Legacy Gemini compatibility alias for targets.flash. */
    flashModel?: string;
    /** Override global ollama.defaultTimeoutMs for classification calls. */
    timeoutMs?: number;
    /** Number of recent conversation turns to include for context. Default: 5. */
    historyTurns?: number;
    /**
     * Rewrite the user query into an optimized memory search query before prewarm.
     * Uses the same Ollama model. Only applies to personal queries.
     * Default: false.
     */
    queryRewrite?: boolean;
    /**
     * Detect topic shifts via local Ollama model. When the new message is
     * unrelated to recent history, chat history is cleared before the turn
     * so the LLM starts with a clean context (equivalent to !clear).
     * Skipped on the first turn of a session (already cleared on startup).
     * Default: true.
     */
    topicShiftDetection?: boolean;
    /**
     * Emit structured clarification-policy traces to stderr.
     * Useful for debugging why Jarvis did or did not ask a follow-up question.
     * Default: false.
     */
    clarificationObservability?: boolean;
    /**
     * Emit structured intent-policy traces to stderr.
     * Useful for debugging which deterministic policy rules changed the
     * local-model intent frame. Default: false.
     */
    intentPolicyObservability?: boolean;
  };
  /**
   * Runtime intent feedback collector.
   * When enabled, high-signal real usage cases are appended as JSONL eval
   * candidates for manual review. Default: disabled.
   */
  intentFeedback?: {
    enabled?: boolean;
    outputPath?: string;
    captureAll?: boolean;
    redact?: boolean;
    maxPromptChars?: number;
    maxHistoryTurns?: number;
    maxHistoryChars?: number;
  };
  /**
   * Unified AgentRuntime facade.
   * When enabled, Jarvis uses the package-level runtime context for
   * intent/memory/skill/execution contracts while preserving the Gemini CLI
   * backend loop as an application adapter.
   */
  agentRuntime?: {
    enabled?: boolean;
    executionMode?: "execute" | "plan_only" | "skip";
    observability?: boolean;
    autonomousTaskRuntime?: {
      /**
       * Enable TaskGraph planning/execution inside the unified AgentRuntime.
       * Default: false. When disabled, Jarvis keeps the legacy multi-intent
       * tool-loop planner behavior.
       */
      enabled?: boolean;
      /**
       * plan_only: build and log TaskGraph without executing deterministic nodes.
       * execute: run deterministic Jarvis-native capability nodes before the LLM loop.
       * skip: do not build a TaskGraph.
       */
      mode?: "execute" | "plan_only" | "skip";
      /** Emit TaskGraph node transition and acceptance logs. Default: false. */
      observability?: boolean;
      /** Directory for durable TaskGraph execution snapshots. */
      stateDir?: string;
      /** Recovery/replan attempts before returning a blocked result. Default: 2. */
      maxRecoveryAttempts?: number;
    };
  };
  /**
   * Browser UI diagnostics and rendering controls.
   */
  ui?: {
    /**
     * Emit Markdown rendering diagnostics to browser console and server stderr.
     * Useful for debugging stream assembly, Markdown parsing, and KaTeX math
     * rendering issues. Default: false.
     */
    markdownDiagnostics?: boolean;
    /** Max characters included in diagnostic snippets. Default: 240. */
    markdownDiagnosticsMaxChars?: number;
    /**
     * Log/send every Nth content chunk while Markdown diagnostics are enabled.
     * 0 disables per-chunk diagnostics. Default: 0.
     */
    markdownDiagnosticsChunkSampleRate?: number;
  };
  /**
   * Main chat LLM backend. Gemini remains the default compatibility backend;
   * non-Gemini backends run through the standalone runtime.
   */
  llmBackend?: {
    provider?: "gemini" | "openai" | "deepseek";
    /**
     * Emit the exact compiled LLM backend prompt/messages before each backend
     * request. This can include personal memory and should be enabled only for
     * local debugging. Default: false.
     */
    promptDiagnostics?: boolean;
    /**
     * JSONL file for compiled prompt diagnostics. Default:
     * ~/.gemini-jarvis/logs/llm-prompt-diagnostics.jsonl.
     */
    promptDiagnosticsFile?: string;
    /** Include full tool schemas in prompt diagnostics. Default: true. */
    promptDiagnosticsIncludeTools?: boolean;
    /** Include runtime metadata in prompt diagnostics. Default: false. */
    promptDiagnosticsIncludeMetadata?: boolean;
    openai?: {
      apiKey?: string;
      apiKeyEnv?: string;
      baseUrl?: string;
      /** Default OpenAI-compatible model when routing is disabled or no routing target is configured. */
      model?: string;
      organization?: string;
      project?: string;
      timeoutMs?: number;
    };
    deepseek?: {
      apiKey?: string;
      apiKeyEnv?: string;
      baseUrl?: string;
      /** Default DeepSeek model when routing is disabled or no routing target is configured. */
      model?: string;
      timeoutMs?: number;
      /** DeepSeek thinking toggle. Omit to use provider default. */
      thinking?: "enabled" | "disabled";
      /** DeepSeek reasoning effort, e.g. high or max. */
      reasoningEffort?: string;
    };
  };
  /**
   * Session summarizer configuration.
   * Used by resumeFromDisk() to compress conversation history on startup.
   */
  summarizer?: {
    /** 'gemini': use CLI auth generateText (default). 'ollama': use local Ollama. */
    provider?: "gemini" | "ollama";
    /** Ollama model name. Summarization benefits from larger models, e.g. "gemma4:27b". */
    model?: string;
    /** Override global ollama.defaultTimeoutMs for summarization calls. Default: 120000. */
    timeoutMs?: number;
    /**
     * Max messages per summarization chunk. When newMessages > chunkSize,
     * they are processed in batches with rolling summary accumulation.
     * 0 = no chunking (process all at once). Default: 100.
     */
    chunkSize?: number;
    /**
     * Only process session files from the last N days for summary updates.
     * Older sessions are covered by facts/vec_memories, not summary.
     * 0 = no limit. Default: 0.
     */
    summaryWindowDays?: number;
    /**
     * Max characters for session summary. If exceeded, trigger re-compression.
     * 0 = no limit. Default: 1200.
     */
    maxSummaryLength?: number;
  };
  /**
   * Reflection (consolidateFacts + reflect) model configuration.
   * provider 'gemini': use existing generateTextFn (default, requires CLI auth or api.key).
   * provider 'ollama': use local Ollama model (works offline, no API key needed).
   */
  reflection: {
    provider: "gemini" | "ollama";
    /** Ollama model name, e.g. "gemma4:e2b". Only used when provider='ollama'. */
    model?: string;
    /** Override global ollama.defaultTimeoutMs. Default: 120000 (2 min). */
    timeoutMs?: number;
  };
  /**
   * Entity extraction configuration for knowledge graph (Neural Link).
   * Extracts entities and relations from facts to build entity_links.
   */
  entityExtraction: {
    /** Enable entity extraction. Default: true. */
    enabled: boolean;
    /** 'ollama': use local Ollama model. 'gemini': reuse existing generateTextFn. */
    provider: "ollama" | "gemini";
    /** Ollama model name, e.g. "gemma4:e2b". Only used when provider='ollama'. */
    model?: string;
    /** Override global ollama.defaultTimeoutMs. Default: 30000. */
    timeoutMs?: number;
    /**
     * Number of facts per model call during entity extraction.
     * Smaller values improve per-fact success rate but increase total calls.
     * Default: 4.
     */
    batchSize?: number;
  };
  /**
   * Cross-encoder reranker for precision re-scoring of retrieval candidates.
   * When enabled, candidates from bi-encoder search are re-ranked by a
   * cross-encoder model before top-K selection.
   */
  reranker?: {
    /** Enable cross-encoder reranking. Default: false. */
    enabled: boolean;
    /** HTTP endpoint of the reranker service. Default: "http://localhost:7700". */
    baseUrl?: string;
    /**
     * Model name passed to the reranker service.
     * Required when using onnx-manager (POST /v1/rerank expects a "model" field).
     * Ignored by the legacy reranker_service.py. Default: "BAAI/bge-reranker-large".
     */
    model?: string;
    /** Request timeout per attempt in milliseconds. Default: 5000. */
    timeoutMs?: number;
    /**
     * Max retry attempts on timeout or network error.
     * Each retry uses the same timeoutMs. Default: 2 (3 total attempts).
     */
    maxRetries?: number;
    /**
     * Number of candidates to fetch from bi-encoder before reranking.
     * Higher = better recall but slower reranking. Default: 20.
     */
    candidatePool?: number;
    /**
     * Minimum cross-encoder logit score for a memory to be injected into context.
     * Results below this threshold are discarded rather than injected as low-confidence.
     * Score range varies by model:
     *   BAAI/bge-reranker-large: +1 to +3 highly relevant, -1 to -2 related, -9 irrelevant.
     *     Recommended: -2
     *   BAAI/bge-reranker-base:  similar range but lower absolute scores.
     *     Recommended: -2
     *   cross-encoder/ms-marco-MiniLM-L6-v2: ~0 to 10 for relevant, <0 for irrelevant.
     *     Recommended: 6
     * Default: -2 (tuned for bge-reranker-large/base)
     */
    memoryRelevanceThreshold?: number;
  };
  network: {
    /** Max retry attempts for network errors (fetch failed, ECONNRESET, etc.). Default: 3. */
    maxRetries: number;
    /** Remove orphaned user turn from history after all retries fail. Default: true. */
    cleanOrphanedTurnOnFailure: boolean;
    /** Max tool-call iterations per processMessage to prevent infinite loops. Default: 30. */
    maxToolIterations: number;
    /** Abort after this many consecutive all-failed tool rounds. Default: 3. */
    maxConsecutiveToolFailures: number;
  };
  server: {
    port: number;
  };
  memory: {
    ingestionDelayMs: number;
    /** Log runtime memory writes (fact/entry/session decisions and result summaries). Default: true. */
    writeObservability: boolean;
    retrievalLimit: number;
    consolidationThreshold: number;
    /** Dedup strategy for saveFact: 'jaccard' (local, no network) or 'embedding' (semantic, requires CLI auth). Default: 'jaccard'. */
    dedupStrategy: "jaccard" | "embedding";
    /** Strategy for selecting relevant facts to inject into system prompt. Default: 'jaccard'. */
    factRelevanceStrategy: "jaccard" | "embedding";
    /** Max number of identity/specification facts to inject per turn (preference/behavior always injected). Default: 5. */
    factRelevanceLimit: number;
    /** Number of semantically similar past conversations to pre-warm into context each turn. 0 = disabled. Default: 3. */
    prewarmLimit: number;
    /**
     * prewarmLimit override for mixed queries (personal + external intent).
     * Mixed queries have higher noise risk, so a tighter limit reduces context adhesion.
     * Default: 1.
     */
    prewarmLimitMixed: number;
    /**
     * Stricter memoryMaxDistance override for mixed queries.
     * Only memories with distance < this value are injected when querySubject=mixed.
     * Default: 0.6 (vs memoryMaxDistance=1.0 for personal).
     */
    prewarmMaxDistanceMixed: number;
    /**
     * Maximum number of skills to inject into the system prompt per turn via
     * semantic retrieval. When total installed skills exceed this limit, only the
     * most relevant skills are injected. 0 or unset = inject all skills (legacy).
     * Default: 5.
     */
    skillSearchLimit: number;
    /**
     * Maximum vector distance for skill retrieval. Skills with distance >=
     * this threshold are considered irrelevant and not injected into the prompt.
     * Uses the same L2 distance scale as factMaxDistance (bge-m3).
     * Default: 0.9 (stricter than facts/memories at 1.0).
     */
    skillMaxDistance: number;
    /** Total character budget for injected facts + summary + prewarm context. */
    injectionMaxTotalChars: number;
    /** Character budget for injected persistent facts. */
    injectionMaxFactChars: number;
    /** Character budget for injected session summary chunks. */
    injectionMaxSummaryChars: number;
    /** Character budget for injected prewarm memories. */
    injectionMaxPrewarmChars: number;
    /** Max chars per injected fact. */
    injectionMaxFactItemChars: number;
    /** Max chars per injected summary chunk. */
    injectionMaxSummaryItemChars: number;
    /** Max chars per injected prewarm memory. */
    injectionMaxPrewarmItemChars: number;
    /** Max injected facts for personal queries. */
    injectionMaxFactItemsPersonal: number;
    /** Max injected facts for mixed queries. */
    injectionMaxFactItemsMixed: number;
    /**
     * Whether to store raw conversation pairs (user+assistant) in vec_memories.
     * With events extraction enabled, raw conversations add low signal.
     * Default: false (only events are stored).
     */
    ingestConversations: boolean;
    /**
     * Trigger backfillSessionEvents() every N conversation turns (async, non-blocking).
     * Ensures current session events are extracted without requiring a restart.
     * 0 = disabled. Default: 20.
     */
    eventsExtractionInterval: number;
    /**
     * Skip backfillSessionEvents() during startup warmup.
     * Set to true for faster startup on low-end machines when events are not critical.
     * Default: false (wait for all session files to be processed before serving).
     */
    skipStartupEventsBackfill: boolean;
    /**
     * L1 physical layer write mode for MEMORIES.md.
     * 'realtime': append each fact immediately after saveFact (always up-to-date, may have minor redundancy).
     * 'batch': full rewrite only after consolidateFacts or reflect (clean file, but lags between consolidations).
     * Default: 'batch'.
     */
    l1WriteMode: "realtime" | "batch";
    /**
     * L3 weight for vector similarity in fused ranking score.
     * fusedScore = vectorSimilarityWeight * cosineSim + importanceWeight * (importance / 10)
     * Default: 0.7
     */
    vectorSimilarityWeight: number;
    /**
     * L3 weight for fact importance in fused ranking score.
     * Default: 0.2
     */
    importanceWeight: number;
    /**
     * Enable hybrid search (BM25 + vector via RRF fusion).
     * Only applies when factRelevanceStrategy = 'embedding'. Default: true.
     */
    hybridSearch: boolean;
    /**
     * RRF parameter k. Higher k reduces the impact of top ranks.
     * Standard value is 60. Default: 60.
     */
    rrfK: number;
    /**
     * L3 weight for recency/access decay in fused ranking score.
     * fusedScore = α·sim + β·(importance/10) + γ·decay(last_accessed)
     * Default: 0.1
     */
    accessWeight: number;
    /**
     * Decay rate λ for time-based forgetting: decay = e^(-λ · days_since_accessed).
     * Higher λ = faster forgetting. Default: 0.1 (~37% after 10 days, ~5% after 30 days).
     */
    decayLambda: number;
    /**
     * Maximum L2 distance for vec_facts KNN candidate filtering.
     * Facts with distance >= this value are excluded before RRF fusion,
     * keeping the relevance signal clean from importance/decay noise.
     * bge-m3 guide: <0.5 high relevance, <1.0 medium, >1.5 noise.
     * Only applies when factRelevanceStrategy = 'embedding'. Default: 1.0.
     */
    factMaxDistance: number;
    /**
     * Maximum L2 distance for vec_memories (prewarm + recall_memory) filtering.
     * Memories with distance >= this value are excluded from injection,
     * preventing semantically irrelevant history from being injected as context.
     * Uses same distance scale as factMaxDistance (bge-m3 L2).
     * Default: 1.0.
     */
    memoryMaxDistance: number;
  };
  security: {
    jailbreak: boolean;
    shell: {
      /**
       * Allow shell-based network fetch commands such as curl/wget.
       * Default: true. When enabled, Jarvis maps these commands into the
       * Gemini CLI shell allowlist and also permits them in native workspace
       * tools. Destructive/system commands remain blocked.
       */
      allowNetworkFetchCommands: boolean;
      /**
       * Shell command prefixes to allow when allowNetworkFetchCommands=true.
       * Default: ["curl", "wget"].
       */
      networkFetchCommands: string[];
    };
  };
  feishu: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    showThoughts: boolean;
  };
  wechat: {
    enabled: boolean;
    apiBaseUrl: string;
  };
  session: {
    useGlobalSession: boolean;
    globalSessionId: string;
    /** Whether to restore previous conversation history on startup. Default: true. */
    resumeOnStart: boolean;
    /** Number of recent raw message turns to include after the summary. Default: 20. */
    recentTurnsOnResume: number;
    /**
     * Compress in-memory chat history when it exceeds this many turns.
     * Older turns are summarized; only the most recent historyKeepRecentTurns are kept raw.
     * 0 = disabled. Default: 30.
     */
    historyCompressionThreshold: number;
    /**
     * Number of recent turns to keep as raw messages after compression.
     * Default: 5.
     */
    historyKeepRecentTurns: number;
    /**
     * When code density is high, multiply the threshold by this factor.
     * Default: 2.0 (effectively 60 turns if threshold is 30).
     */
    codeHeavyThresholdMultiplier: number;
  };
  tasks?: {
    /** Default channel for proactive task output. */
    defaultChannel?: string;
  };
}

const JARVIS_HOME = path.join(os.homedir(), ".gemini-jarvis");
const CONFIG_PATH = path.join(JARVIS_HOME, "config.json");

export class ConfigManager {
  private static instance: ConfigManager;
  private config!: JarvisConfig;

  private constructor() {
    this.load();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private load() {
    if (!fs.existsSync(JARVIS_HOME)) {
      fs.mkdirSync(JARVIS_HOME, { recursive: true });
    }

    const defaults: JarvisConfig = {
      api: {
        key: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "",
        proxy: process.env.HTTPS_PROXY || process.env.https_proxy || "",
      },
      models: {
        chat: "auto",
        embedding: "models/gemini-embedding-001",
        embeddingDimension: 1024,
        distillation: "gemini-2.5-flash",
      },
      ollama: {
        baseUrl: "http://localhost:11434",
        defaultTimeoutMs: 30_000,
        maxRetries: 2,
      },
      embeddingService: {
        provider: "google" as const,
      },
      reflection: {
        provider: "ollama" as const,
      },
      entityExtraction: {
        enabled: true,
        provider: "gemini" as const,
        batchSize: 4,
      },
      network: {
        maxRetries: 3,
        cleanOrphanedTurnOnFailure: true,
        maxToolIterations: 30,
        maxConsecutiveToolFailures: 3,
      },
      server: {
        port: Number(process.env.JARVIS_PORT) || 3000,
      },
      memory: {
        ingestionDelayMs: 800,
        writeObservability: true,
        retrievalLimit: 5,
        consolidationThreshold: 3,
        dedupStrategy: "embedding" as const,
        factRelevanceStrategy: "jaccard" as const,
        factRelevanceLimit: 5,
        prewarmLimit: 3,
        prewarmLimitMixed: 1,
        prewarmMaxDistanceMixed: 0.6,
        skillSearchLimit: 5,
        skillMaxDistance: 0.9,
        injectionMaxTotalChars: 1800,
        injectionMaxFactChars: 900,
        injectionMaxSummaryChars: 520,
        injectionMaxPrewarmChars: 1100,
        injectionMaxFactItemChars: 220,
        injectionMaxSummaryItemChars: 180,
        injectionMaxPrewarmItemChars: 500,
        injectionMaxFactItemsPersonal: 8,
        injectionMaxFactItemsMixed: 4,
        ingestConversations: false,
        eventsExtractionInterval: 20,
        skipStartupEventsBackfill: false,
        l1WriteMode: "batch" as const,
        vectorSimilarityWeight: 0.7,
        importanceWeight: 0.2,
        accessWeight: 0.1,
        decayLambda: 0.1,
        hybridSearch: true,
        rrfK: 60,
        factMaxDistance: 1.0,
        memoryMaxDistance: 1.0,
      },
      security: {
        jailbreak: false,
        shell: {
          allowNetworkFetchCommands: true,
          networkFetchCommands: ["curl", "wget"],
        },
      },
      summarizer: {
        provider: "gemini" as const,
        timeoutMs: 120_000,
        chunkSize: 100,
        summaryWindowDays: 30,
        maxSummaryLength: 1200,
      },
      feishu: {
        enabled: false,
        appId: "",
        appSecret: "",
        showThoughts: false,
      },
      wechat: {
        enabled: false,
        apiBaseUrl: "https://ilinkai.weixin.qq.com",
      },
      session: {
        useGlobalSession: false,
        globalSessionId: "jarvis-global-master",
        resumeOnStart: true,
        recentTurnsOnResume: 0,
        historyCompressionThreshold: 20,
        historyKeepRecentTurns: 3,
        codeHeavyThresholdMultiplier: 1.2,
      },
      routing: {
        enabled: true,
        model: "",
        clarificationObservability: false,
        intentPolicyObservability: false,
      },
      intentFeedback: {
        enabled: false,
        captureAll: false,
        redact: true,
        maxPromptChars: 800,
        maxHistoryTurns: 6,
        maxHistoryChars: 240,
      },
      agentRuntime: {
        enabled: true,
        executionMode: "skip",
        observability: false,
        autonomousTaskRuntime: {
          enabled: false,
          mode: "plan_only",
          observability: false,
          maxRecoveryAttempts: 2,
        },
      },
      ui: {
        markdownDiagnostics: false,
        markdownDiagnosticsMaxChars: 240,
        markdownDiagnosticsChunkSampleRate: 0,
      },
      llmBackend: {
        provider: "gemini",
        promptDiagnostics: false,
        promptDiagnosticsFile: path.join(
          JARVIS_HOME,
          "logs",
          "llm-prompt-diagnostics.jsonl",
        ),
        promptDiagnosticsIncludeTools: true,
        promptDiagnosticsIncludeMetadata: false,
        openai: {
          apiKeyEnv: "OPENAI_API_KEY",
          model: "gpt-4.1",
          baseUrl: "https://api.openai.com/v1",
          timeoutMs: 120_000,
        },
        deepseek: {
          apiKeyEnv: "DEEPSEEK_API_KEY",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com",
          timeoutMs: 120_000,
          thinking: "disabled",
          reasoningEffort: "high",
        },
      },
    };

    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        this.config = {
          ...defaults,
          ...saved,
          api: { ...defaults.api, ...saved.api },
          models: { ...defaults.models, ...saved.models },
          network: { ...defaults.network, ...saved.network },
          server: { ...defaults.server, ...saved.server },
          memory: { ...defaults.memory, ...saved.memory },
          ollama: { ...defaults.ollama, ...saved.ollama },
          embeddingService: {
            ...defaults.embeddingService,
            ...saved.embeddingService,
          },
          reflection: {
            ...defaults.reflection,
            ...saved.reflection,
          },
          summarizer: {
            ...defaults.summarizer,
            ...saved.summarizer,
          },
          entityExtraction: {
            ...defaults.entityExtraction,
            ...saved.entityExtraction,
          },
          security: {
            ...defaults.security,
            ...saved.security,
            shell: {
              ...defaults.security.shell,
              ...saved.security?.shell,
            },
          },
          feishu: { ...defaults.feishu, ...saved.feishu },
          wechat: { ...defaults.wechat, ...saved.wechat },
          session: { ...defaults.session, ...saved.session },
          routing: { ...defaults.routing, ...saved.routing },
          intentFeedback: {
            ...defaults.intentFeedback,
            ...saved.intentFeedback,
          },
          agentRuntime: {
            ...defaults.agentRuntime,
            ...saved.agentRuntime,
            autonomousTaskRuntime: {
              ...defaults.agentRuntime.autonomousTaskRuntime,
              ...saved.agentRuntime?.autonomousTaskRuntime,
            },
          },
          ui: {
            ...defaults.ui,
            ...saved.ui,
          },
          llmBackend: {
            ...defaults.llmBackend,
            ...saved.llmBackend,
            openai: {
              ...defaults.llmBackend?.openai,
              ...saved.llmBackend?.openai,
            },
          },
        };
      } catch (e) {
        console.error(
          "[ConfigManager] Error parsing config.json, using defaults.",
        );
        this.config = defaults;
      }
    } else {
      this.config = defaults;
      this.save();
    }
  }

  public save() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error("[ConfigManager] Failed to save config:", e);
    }
  }

  public get(): JarvisConfig {
    return this.config;
  }

  public update(newConfig: Partial<JarvisConfig>) {
    this.config = { ...this.config, ...newConfig };
    this.save();
  }
}
