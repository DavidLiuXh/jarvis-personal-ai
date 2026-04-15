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
   * Embedding service configuration.
   * provider 'google': use Gemini API key (requires api.key).
   * provider 'ollama': use local Ollama service (requires baseUrl and model).
   */
  embeddingService: {
    provider: "google" | "ollama";
    /** Ollama base URL, e.g. "http://localhost:11434". Only used when provider='ollama'. */
    baseUrl?: string;
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
    /** Ollama base URL. Default: "http://localhost:11434". */
    baseUrl?: string;
    /** Ollama model for complexity classification, e.g. "gemma4:e2b". */
    model: string;
    /** Complexity score threshold (1-100). Score >= threshold → proModel. Default: 70. */
    threshold?: number;
    /** Model to use for complex requests. Default: "gemini-2.5-pro". */
    proModel?: string;
    /** Model to use for simple requests. Default: "gemini-2.5-flash". */
    flashModel?: string;
    /** Timeout in milliseconds for the classification call. Default: 10000. */
    timeoutMs?: number;
  };
  /**
   * Reflection (consolidateFacts + reflect) model configuration.
   * provider 'gemini': use existing generateTextFn (default, requires CLI auth or api.key).
   * provider 'ollama': use local Ollama model (works offline, no API key needed).
   */
  reflection: {
    provider: "gemini" | "ollama";
    /** Ollama base URL. Only used when provider='ollama'. Default: "http://localhost:11434". */
    baseUrl?: string;
    /** Ollama model name, e.g. "gemma4:e2b". Only used when provider='ollama'. */
    model?: string;
    /** Request timeout in milliseconds. Default: 120000 (2 min, reflection prompts are long). */
    timeoutMs?: number;
  };
  /**
   * Entity extraction configuration for knowledge graph (Neural Link).
   * Extracts entities and relations from facts to build entity_links.
   */
  entityExtraction: {
    /** Enable entity extraction. Default: false. */
    enabled: boolean;
    /** 'ollama': use local Ollama model. 'gemini': reuse existing generateTextFn. */
    provider: "ollama" | "gemini";
    /** Ollama base URL. Only used when provider='ollama'. Default: "http://localhost:11434". */
    baseUrl?: string;
    /** Ollama model name, e.g. "gemma4:e4b". Only used when provider='ollama'. */
    model?: string;
    /** Request timeout in milliseconds for Ollama calls. Default: 30000 (30s). */
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
      embeddingService: {
        provider: "google" as const,
      },
      reflection: {
        provider: "gemini" as const,
      },
      entityExtraction: {
        enabled: true,
        provider: "gemini" as const,
      },
      network: {
        maxRetries: 3,
        cleanOrphanedTurnOnFailure: true,
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
        l1WriteMode: "batch" as const,
        vectorSimilarityWeight: 0.7,
        importanceWeight: 0.2,
        accessWeight: 0.1,
        decayLambda: 0.1,
        hybridSearch: true,
        rrfK: 60,
      },
      security: {
        jailbreak: false,
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
          embeddingService: {
            ...defaults.embeddingService,
            ...saved.embeddingService,
          },
          reflection: {
            ...defaults.reflection,
            ...saved.reflection,
          },
          entityExtraction: {
            ...defaults.entityExtraction,
            ...saved.entityExtraction,
          },
          security: { ...defaults.security, ...saved.security },
          feishu: { ...defaults.feishu, ...saved.feishu },
          wechat: { ...defaults.wechat, ...saved.wechat },
          session: { ...defaults.session, ...saved.session },
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
