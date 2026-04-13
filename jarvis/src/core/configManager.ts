/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    dedupStrategy: 'jaccard' | 'embedding';
    /** Strategy for selecting relevant facts to inject into system prompt. Default: 'jaccard'. */
    factRelevanceStrategy: 'jaccard' | 'embedding';
    /** Max number of identity/specification facts to inject per turn (preference/behavior always injected). Default: 5. */
    factRelevanceLimit: number;
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

const JARVIS_HOME = path.join(os.homedir(), '.gemini-jarvis');
const CONFIG_PATH = path.join(JARVIS_HOME, 'config.json');

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
        key: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',
        proxy: process.env.HTTPS_PROXY || process.env.https_proxy || ''
      },
      models: {
        chat: 'auto',
        embedding: 'models/gemini-embedding-001',
        embeddingDimension: 3072,
        distillation: 'gemini-2.5-flash'
      },
      network: {
        maxRetries: 3,
        cleanOrphanedTurnOnFailure: true,
      },
      server: {
        port: Number(process.env.JARVIS_PORT) || 3000
      },
      memory: {
        ingestionDelayMs: 800,
        retrievalLimit: 5,
        consolidationThreshold: 3,
        dedupStrategy: 'jaccard' as const,
        factRelevanceStrategy: 'jaccard' as const,
        factRelevanceLimit: 5,
      },
      security: {
        jailbreak: false
      },
      feishu: {
        enabled: false,
        appId: '',
        appSecret: '',
        showThoughts: false
      },
      wechat: {
        enabled: false,
        apiBaseUrl: 'https://ilinkai.weixin.qq.com'
      },
      session: {
        useGlobalSession: false,
        globalSessionId: 'jarvis-global-master',
        resumeOnStart: true,
        recentTurnsOnResume: 20,
      }
    };

    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        this.config = {
          ...defaults,
          ...saved,
          api: { ...defaults.api, ...saved.api },
          models: { ...defaults.models, ...saved.models },
          network: { ...defaults.network, ...saved.network },
          server: { ...defaults.server, ...saved.server },
          memory: { ...defaults.memory, ...saved.memory },
          security: { ...defaults.security, ...saved.security },
          feishu: { ...defaults.feishu, ...saved.feishu },
          wechat: { ...defaults.wechat, ...saved.wechat },
          session: { ...defaults.session, ...saved.session }
        };
      } catch (e) {
        console.error('[ConfigManager] Error parsing config.json, using defaults.');
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
      console.error('[ConfigManager] Failed to save config:', e);
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
