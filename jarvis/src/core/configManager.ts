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
   * All Ollama-based features (embedding, routing, reflection, entity extraction, summarizer)
   * use these as defaults. Individual features can override timeoutMs only.
   */
  ollama: {
    /** Ollama service base URL. Default: "http://localhost:11434". */
    baseUrl: string;
    /** Default request timeout in milliseconds. Default: 30000. */
    defaultTimeoutMs: number;
    /**
     * Max retry attempts on timeout or network errors for reflection/entity
     * extraction calls. Each retry doubles the timeout up to 3x the base.
     * Default: 2 (total 3 attempts).
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
   * then select proModel or flashModel accordingly.
   */
  routing?: {
    /** Enable local routing. Default: false. */
    enabled: boolean;
    /** 'ollama': use local Ollama model (default). */
    provider?: "ollama";
    /** Ollama model for complexity classification, e.g. "gemma4:e2b". */
    model: string;
    /** Complexity score threshold (1-100). Score >= threshold → proModel. Default: 70. */
    threshold?: number;
    /** Model to use for complex requests. Default: "gemini-2.5-pro". */
    proModel?: string;
    /** Model to use for simple requests. Default: "gemini-2.5-flash". */
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
     * Number of facts per batch during backfill entity extraction.
     * Smaller values improve per-fact success rate but increase total calls.
     * Default: 1 (one fact per call for best accuracy).
     */
    batchSize?: number;
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
        recentTurnsOnResume: 3,
        historyCompressionThreshold: 20,
        historyKeepRecentTurns: 3,
        codeHeavyThresholdMultiplier: 1.2,
      },
      routing: {
        enabled: true,
        model: "",
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
          security: { ...defaults.security, ...saved.security },
          feishu: { ...defaults.feishu, ...saved.feishu },
          wechat: { ...defaults.wechat, ...saved.wechat },
          session: { ...defaults.session, ...saved.session },
          routing: { ...defaults.routing, ...saved.routing },
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
