/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import * as genai from "@google/genai";
import { HttpsProxyAgent } from "https-proxy-agent";
import { debugLogger } from "../../../gemini-cli/packages/core/src/index.js";
import { ConfigManager } from "./configManager.js";
import { EntityExtractor, type EntityLink } from "./entityExtractor.js";

export class MemoryService {
  private db: Database.Database;
  private jarvisConfig = ConfigManager.getInstance().get();
  private client: any = null;
  private queue: {
    sessionId: string;
    userPrompt: string;
    assistantText: string;
  }[] = [];
  private isProcessing = false; // guards processQueue
  private isConsolidating = false; // guards consolidateFacts (separate to avoid竞态)
  private isBackfillingEntities = false; // guards backfillEntityLinks
  private config: any;
  private lastConsolidatedCount = 0;
  private generateTextFn: ((prompt: string) => Promise<string>) | null = null;
  private embedContentFn: ((text: string) => Promise<number[]>) | null = null;
  private memoryDir: string;
  private entityExtractor: EntityExtractor | null = null;

  constructor(sourceRoot: string, dbPath?: string) {
    const memoryDir =
      dbPath ?? path.join(os.homedir(), ".gemini-jarvis", "memory");
    this.memoryDir = memoryDir;
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    this.db = new Database(path.join(memoryDir, "memory.db"));

    // Initialize Schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT,
        text TEXT,
        timestamp INTEGER
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,
        content TEXT,
        importance INTEGER DEFAULT 5,
        timestamp INTEGER,
        embedding BLOB
      );
      CREATE TABLE IF NOT EXISTS processed_files (
        filename TEXT PRIMARY KEY,
        last_mtime INTEGER
      );
    `);

    // Knowledge graph tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        name  TEXT UNIQUE,
        type  TEXT
      );
      CREATE TABLE IF NOT EXISTS entity_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id INTEGER REFERENCES entities(id),
        relation   TEXT,
        object_id  INTEGER REFERENCES entities(id),
        fact_id    INTEGER REFERENCES facts(id) ON DELETE CASCADE,
        timestamp  INTEGER
      );
    `);

    // Migration: rebuild entity_links with ON DELETE CASCADE on fact_id
    // This prevents FOREIGN KEY constraint failures when facts are deleted
    try {
      const tableInfo = this.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='entity_links'`,
        )
        .get() as { sql: string } | undefined;
      if (tableInfo && !tableInfo.sql.includes("ON DELETE CASCADE")) {
        this.db.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE entity_links_new (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id INTEGER REFERENCES entities(id),
            relation   TEXT,
            object_id  INTEGER REFERENCES entities(id),
            fact_id    INTEGER REFERENCES facts(id) ON DELETE CASCADE,
            timestamp  INTEGER
          );
          INSERT INTO entity_links_new SELECT * FROM entity_links;
          DROP TABLE entity_links;
          ALTER TABLE entity_links_new RENAME TO entity_links;
          PRAGMA foreign_keys = ON;
        `);
        debugLogger.debug(
          "[MemoryService] entity_links migrated to ON DELETE CASCADE",
        );
      }
    } catch (e: any) {
      console.error(
        `⚠️ [MemoryService] entity_links migration failed: ${e.message}`,
      );
    }

    // FTS5 virtual table for BM25 keyword search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          content,
          fact_id UNINDEXED,
          tokenize = 'unicode61'
        );
      `);
    } catch (_) {}

    // Migrations
    try {
      this.db.exec("ALTER TABLE facts ADD COLUMN embedding BLOB");
    } catch (_) {}
    try {
      this.db.exec("ALTER TABLE facts ADD COLUMN last_accessed INTEGER");
    } catch (_) {}
    try {
      this.db.exec(
        "ALTER TABLE facts ADD COLUMN access_count INTEGER DEFAULT 0",
      );
    } catch (_) {}

    try {
      sqliteVec.load(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          id INTEGER PRIMARY KEY,
          embedding FLOAT[${this.jarvisConfig.models.embeddingDimension}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
          id INTEGER PRIMARY KEY,
          embedding FLOAT[${this.jarvisConfig.models.embeddingDimension}]
        );
      `);
      debugLogger.debug(`[MemoryService V2] Vector support enabled.`);
    } catch (e: any) {
      console.error(
        "⚠️ [MemoryService] Vector extension failed to load.",
        e.message,
      );
    }
  }

  public setConfig(config: any) {
    this.config = config;
    const apiKey =
      this.jarvisConfig.api.key || config.apiKey || process.env.GOOGLE_API_KEY;
    if (apiKey) this.startWithApiKey(apiKey);
  }

  /** Inject a CLI-auth generateText function to replace the API-key-based client for LLM calls. */
  public setGenerateText(fn: (prompt: string) => Promise<string>) {
    this.generateTextFn = fn;
    this.initEntityExtractor();
  }

  /**
   * Returns a generateText function for reflection (consolidateFacts/reflect).
   * Routes to Ollama if reflection.provider = 'ollama', otherwise uses the injected fn.
   */
  public buildReflectionGenerateText(
    fallbackFn: (prompt: string) => Promise<string>,
  ): (prompt: string) => Promise<string> {
    const cfg = this.jarvisConfig.reflection;
    if (cfg?.provider === "ollama") {
      const baseUrl = cfg.baseUrl ?? "http://localhost:11434";
      const model = cfg.model ?? "";
      const timeoutMs = cfg.timeoutMs ?? 120_000;
      if (!model) {
        console.error(
          "⚠️ [MemoryService] reflection.model not set, falling back to gemini",
        );
        return fallbackFn;
      }
      return async (prompt: string): Promise<string> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${baseUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false }),
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(
              `Ollama reflection failed: ${response.status} ${await response.text()}`,
            );
          }
          const data = (await response.json()) as { response: string };
          return data.response;
        } finally {
          clearTimeout(timeout);
        }
      };
    }
    return fallbackFn;
  }

  private _unused(fn: (prompt: string) => Promise<string>) {}

  private initEntityExtractor(): void {
    const cfg = this.jarvisConfig.entityExtraction;
    if (!cfg?.enabled) return;
    this.entityExtractor = new EntityExtractor(
      cfg.provider ?? "gemini",
      this.generateTextFn,
      cfg.baseUrl ?? "http://localhost:11434",
      cfg.model ?? "",
      cfg.timeoutMs ?? 30_000,
    );
    console.error(
      `🔗 [MemoryService] EntityExtractor initialized (provider=${cfg.provider ?? "gemini"}${cfg.model ? ", model=" + cfg.model : ""}, timeout=${cfg.timeoutMs ?? 30_000}ms)`,
    );
  }

  /** Inject a CLI-auth embedContent function for semantic dedup. */
  public setEmbedContent(fn: (text: string) => Promise<number[]>) {
    this.embedContentFn = fn;
    // Trigger auto-backfill after embedContent is available
    void this.autoBackfill();
  }

  /**
   * Unified embedding entry point — routes to Ollama or Google API
   * based on embeddingService.provider config.
   */
  public async embedWithApiKey(text: string): Promise<number[]> {
    const provider = this.jarvisConfig.embeddingService?.provider ?? "google";
    if (provider === "ollama") {
      return this.embedWithOllama(text);
    }
    return this.embedWithGoogle(text);
  }

  private async embedWithGoogle(text: string): Promise<number[]> {
    if (!this.client)
      throw new Error(
        "[MemoryService] No API key client available for Google embedding",
      );
    const result = await this.client.models.embedContent({
      model: this.jarvisConfig.models.embedding,
      contents: [{ role: "user", parts: [{ text }] }],
    });
    const embeddings = result.embeddings || [result.embedding];
    return embeddings[0].values;
  }

  private async embedWithOllama(text: string): Promise<number[]> {
    const { baseUrl = "http://localhost:11434", model } =
      this.jarvisConfig.embeddingService ?? {};
    if (!model)
      throw new Error(
        "[MemoryService] embeddingService.model is required for Ollama provider",
      );
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });
    if (!response.ok) {
      throw new Error(
        `[MemoryService] Ollama embed failed: ${response.status} ${await response.text()}`,
      );
    }
    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  public startWithApiKey(apiKey: string) {
    if (this.client) return;
    try {
      const proxy = this.jarvisConfig.api.proxy;
      // Use namespace-based access which is most reliable in this environment
      this.client = new (genai as any).GoogleGenAI({
        apiKey,
        httpClient: proxy ? { agent: new HttpsProxyAgent(proxy) } : undefined,
      });
      debugLogger.debug("[MemoryService V2] AI Engine ready.");
      void this.syncHistoricalSessions();
      void this.processQueue();
    } catch (e) {
      debugLogger.error(`[MemoryService] Failed to init SDK: ${e.message}`);
    }
  }

  private static readonly DEDUP_JACCARD_THRESHOLD_LATIN = 0.55;
  private static readonly DEDUP_JACCARD_THRESHOLD_CJK = 0.3;
  private static readonly DEDUP_COSINE_THRESHOLD = 0.9;

  private static readonly STOP_WORDS_LATIN = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "user",
    "david",
    "jarvis",
    "at",
    "least",
    "in",
    "of",
    "to",
    "and",
    "for",
    "this",
    "that",
    "with",
    "has",
    "have",
    "should",
    "be",
    "my",
    "i",
    "me",
    "his",
    "her",
  ]);
  private static readonly STOP_WORDS_CJK = new Set([
    "的",
    "了",
    "在",
    "是",
    "我",
    "有",
    "和",
    "就",
    "不",
    "都",
    "也",
    "很",
    "到",
    "说",
    "要",
    "去",
    "你",
    "会",
    "着",
    "看",
    "好",
    "自己",
    "这",
    "他",
    "她",
  ]);

  private static hasCJK(s: string): boolean {
    return /[\u4e00-\u9fff]/.test(s);
  }

  /**
   * Tokenizes text into a set of tokens for Jaccard comparison.
   * Latin: word tokens (length > 1, stop words removed).
   * CJK: unigrams + bigrams (stop words removed).
   */
  private tokenize(s: string): Set<string> {
    const lower = s.toLowerCase();
    const tokens = new Set<string>();
    // Latin words
    lower
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !MemoryService.STOP_WORDS_LATIN.has(w))
      .forEach((w) => tokens.add(w));
    // CJK: unigrams + bigrams
    const cjkChunks = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
    for (const chunk of cjkChunks) {
      for (let i = 0; i < chunk.length; i++) {
        if (!MemoryService.STOP_WORDS_CJK.has(chunk[i])) tokens.add(chunk[i]);
        if (i < chunk.length - 1) tokens.add(chunk.slice(i, i + 2));
      }
    }
    return tokens;
  }

  /** Jaccard similarity with language-aware threshold selection. */
  private jaccardSimilarity(a: string, b: string): number {
    const setA = this.tokenize(a);
    const setB = this.tokenize(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const w of setA) if (setB.has(w)) intersection++;
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private jaccardThreshold(a: string, b: string): number {
    return MemoryService.hasCJK(a) || MemoryService.hasCJK(b)
      ? MemoryService.DEDUP_JACCARD_THRESHOLD_CJK
      : MemoryService.DEDUP_JACCARD_THRESHOLD_LATIN;
  }

  /** Cosine similarity between two equal-length float arrays. */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Returns true if the content is a duplicate of an existing fact. */
  private isDuplicateByJaccard(content: string): boolean {
    const existing = this.db
      .prepare("SELECT content FROM facts")
      .all() as Array<{ content: string }>;
    for (const row of existing) {
      const sim = this.jaccardSimilarity(content, row.content);
      const threshold = this.jaccardThreshold(content, row.content);
      if (sim >= threshold) {
        console.error(
          `♻️ [MemoryService] Duplicate skipped: "${content}" ≈ "${row.content}" (jaccard=${sim.toFixed(2)}, threshold=${threshold})`,
        );
        return true;
      }
    }
    return false;
  }

  /** Returns true if the content is a duplicate via embedding cosine similarity. Falls back to jaccard on error. */
  private async isDuplicateByEmbedding(content: string): Promise<boolean> {
    try {
      const newVec = await this.embedContentFn!(content);
      const existing = this.db
        .prepare(
          "SELECT content, embedding FROM facts WHERE embedding IS NOT NULL",
        )
        .all() as Array<{ content: string; embedding: Buffer }>;

      for (const row of existing) {
        const existingVec = Array.from(new Float32Array(row.embedding.buffer));
        const sim = this.cosineSimilarity(newVec, existingVec);
        if (sim >= MemoryService.DEDUP_COSINE_THRESHOLD) {
          console.error(
            `♻️ [MemoryService] Duplicate skipped: "${content}" ≈ "${row.content}" (cosine=${sim.toFixed(3)})`,
          );
          return true;
        }
      }
      return false;
    } catch (_e) {
      // Embedding unavailable — fall back to jaccard
      return this.isDuplicateByJaccard(content);
    }
  }

  /**
   * Insert a fact into the facts table and sync its embedding to vec_facts
   * within a single transaction to keep the two tables consistent.
   */
  private insertFactWithVec(
    category: string,
    content: string,
    importance: number,
    embedding: number[] | null,
  ): bigint {
    const insertFact = this.db.transaction(() => {
      let rowid: bigint;
      if (embedding) {
        const info = this.db
          .prepare(
            "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            category,
            content,
            importance,
            Date.now(),
            Buffer.from(new Float32Array(embedding).buffer),
          );
        rowid = info.lastInsertRowid as bigint;
        try {
          this.db
            .prepare("INSERT INTO vec_facts (id, embedding) VALUES (?, ?)")
            .run(BigInt(rowid), new Float32Array(embedding));
        } catch (_vecErr) {
          /* vec extension may be unavailable */
        }
      } else {
        const info = this.db
          .prepare(
            "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
          )
          .run(category, content, importance, Date.now());
        rowid = info.lastInsertRowid as bigint;
      }
      // Sync to FTS5 for BM25 search
      try {
        this.db
          .prepare("INSERT INTO facts_fts (content, fact_id) VALUES (?, ?)")
          .run(content, Number(rowid));
      } catch (_) {}
      return rowid;
    });
    return insertFact();
  }

  public async saveFact(
    category: string,
    content: string,
    importance: number = 5,
  ) {
    try {
      // Exact-string dedup (fast path)
      const exists = this.db
        .prepare("SELECT id FROM facts WHERE content = ?")
        .get(content);
      if (exists) return;

      // Strategy-based semantic dedup
      const strategy = this.jarvisConfig.memory.dedupStrategy ?? "jaccard";
      if (strategy === "embedding" && this.embedContentFn) {
        if (await this.isDuplicateByEmbedding(content)) return;
        const newVec = await this.embedContentFn(content).catch(() => null);
        this.insertFactWithVec(category, content, importance, newVec);
      } else {
        if (this.isDuplicateByJaccard(content)) return;
        this.insertFactWithVec(category, content, importance, null);
      }

      const count = this.db
        .prepare("SELECT count(*) as c FROM facts")
        .get() as any;
      console.error(`🔥 [MemoryService] New fact distilled. Total: ${count.c}`);

      // L1 realtime write
      if ((this.jarvisConfig.memory.l1WriteMode ?? "batch") === "realtime") {
        this.appendToPhysicalLayer(category, content, importance);
      }

      // Async entity extraction for knowledge graph (non-blocking)
      if (this.entityExtractor) {
        const factRow = this.db
          .prepare("SELECT id FROM facts WHERE content = ? LIMIT 1")
          .get(content) as { id: number } | undefined;
        const factId = factRow?.id ?? null;
        setImmediate(() => {
          void this.extractAndSaveEntities([{ category, content }], factId);
        });
      }

      // Trigger consolidation when fact count exceeds threshold
      if (
        count.c >
        this.lastConsolidatedCount +
          this.jarvisConfig.memory.consolidationThreshold
      ) {
        void this.consolidateFacts();
      }
    } catch (e: any) {
      console.error(`❌ [MemoryService] Fact save failed: ${e.message}`);
    }
  }

  public async consolidateFacts() {
    if (!this.generateTextFn && !this.client) return;
    // Use dedicated isConsolidating flag — independent of isProcessing (queue)
    if (this.isConsolidating) return;

    this.isConsolidating = true;
    console.error(
      "\n🧠 [Jarvis Reflection] Memory saturation detected. Initiating internal synthesis...",
    );

    try {
      const allFacts = this.db
        .prepare("SELECT * FROM facts ORDER BY category, importance DESC")
        .all() as any[];
      if (allFacts.length < 5) return;

      const factsText = allFacts
        .map(
          (f) => `[${f.category}] (Importance: ${f.importance}) ${f.content}`,
        )
        .join("\n");

      const reflectionPrompt = `
You are the Cognitive Maintenance Module of JARVIS.
Objective: Merge semantically duplicate facts, fix miscategorized facts, and output a clean consolidated list.

Category definitions (mutually exclusive — each fact belongs to exactly ONE):
- identity: ONLY static facts about who the user IS — name, job title, profession, skills (e.g. "named David", "software engineer", "good at cooking")
- behavior: user's habits, hobbies, interests, lifestyle, routines, recurring patterns (e.g. "likes cycling", "interested in history", "runs 3 times a week")
- preference: ONLY how the user wants Jarvis to FORMAT or STYLE responses — output format, tone, language, length (e.g. "prefers tables", "wants concise answers")
- specification: technical decisions, project constraints, system rules

Rules:
1. Merge facts that express the same information (even if worded differently or in different languages).
2. Fix miscategorized facts: hobbies/interests → behavior (NOT identity); response style → preference (NOT behavior).
3. Each output fact must belong to exactly ONE category.
4. Use English for all output content.
5. Preserve importance score (1-10); use the highest score among merged duplicates.

Respond ONLY with a JSON array: [{"category": "identity|behavior|preference|specification", "content": "...", "importance": 1-10}]

Input Facts:
${factsText}
`;

      let responseText = "";
      // Route to Ollama if reflection.provider = 'ollama', else use generateTextFn or API client
      const consolidateGenerateFn = this.generateTextFn
        ? this.buildReflectionGenerateText(this.generateTextFn)
        : null;
      if (consolidateGenerateFn) {
        responseText = await consolidateGenerateFn(reflectionPrompt);
      } else {
        const result = await this.client.models.generateContent({
          model: this.jarvisConfig.models.distillation,
          contents: [{ role: "user", parts: [{ text: reflectionPrompt }] }],
        });
        if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
          responseText = result.response.candidates[0].content.parts[0].text;
        } else if ((result as any).candidates?.[0]?.content?.parts?.[0]?.text) {
          responseText = (result as any).candidates[0].content.parts[0].text;
        } else if (typeof result.response?.text === "function") {
          responseText = result.response.text();
        }
      }

      if (!responseText) {
        console.error(
          "❌ [Jarvis Reflection] Failed to extract text from consolidation model",
        );
        throw new Error("Empty response from reflection model");
      }

      const match = responseText.match(/\[[\s\S]*\]/);
      if (match) {
        const newFacts = JSON.parse(match[0]) as Array<{
          category: string;
          content: string;
          importance: number;
        }>;

        // Preserve access stats: build content → {last_accessed, access_count} map from old facts
        const accessMap = new Map<
          string,
          { last_accessed: number | null; access_count: number }
        >();
        for (const old of allFacts) {
          accessMap.set(old.content, {
            last_accessed: (old as any).last_accessed ?? null,
            access_count: (old as any).access_count ?? 0,
          });
        }

        // Batch-generate embeddings before entering the transaction (async work outside sync tx)
        const embeddings: Array<number[] | null> = [];
        if (this.embedContentFn) {
          for (const f of newFacts) {
            const vec = await this.embedContentFn(f.content).catch(() => null);
            embeddings.push(vec);
          }
        } else {
          newFacts.forEach(() => embeddings.push(null));
        }

        // Atomically replace facts + vec_facts
        const runUpdate = this.db.transaction(() => {
          // Clear dependent tables first to avoid FK constraint failures
          try {
            this.db.prepare("DELETE FROM entity_links").run();
          } catch (_) {}
          try {
            this.db.prepare("DELETE FROM entities").run();
          } catch (_) {}
          this.db.prepare("DELETE FROM facts").run();
          try {
            this.db.prepare("DELETE FROM vec_facts").run();
          } catch (_) {}
          try {
            this.db.prepare("DELETE FROM facts_fts").run();
          } catch (_) {}

          for (let i = 0; i < newFacts.length; i++) {
            const f = newFacts[i];
            const emb = embeddings[i];
            // Best-effort: restore access stats if content matches an old fact
            const access = accessMap.get(f.content);
            const lastAccessed = access?.last_accessed ?? null;
            const accessCount = access?.access_count ?? 0;
            if (emb) {
              const info = this.db
                .prepare(
                  "INSERT INTO facts (category, content, importance, timestamp, embedding, last_accessed, access_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .run(
                  f.category,
                  f.content,
                  f.importance || 5,
                  Date.now(),
                  Buffer.from(new Float32Array(emb).buffer),
                  lastAccessed,
                  accessCount,
                );
              try {
                this.db
                  .prepare(
                    "INSERT INTO vec_facts (id, embedding) VALUES (?, ?)",
                  )
                  .run(BigInt(info.lastInsertRowid), new Float32Array(emb));
              } catch (_) {}
              try {
                this.db
                  .prepare(
                    "INSERT INTO facts_fts (content, fact_id) VALUES (?, ?)",
                  )
                  .run(f.content, Number(info.lastInsertRowid));
              } catch (_) {}
            } else {
              const info2 = this.db
                .prepare(
                  "INSERT INTO facts (category, content, importance, timestamp, last_accessed, access_count) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .run(
                  f.category,
                  f.content,
                  f.importance || 5,
                  Date.now(),
                  lastAccessed,
                  accessCount,
                );
              try {
                this.db
                  .prepare(
                    "INSERT INTO facts_fts (content, fact_id) VALUES (?, ?)",
                  )
                  .run(f.content, Number(info2.lastInsertRowid));
              } catch (_) {}
            }
          }
        });

        runUpdate();
        this.lastConsolidatedCount = newFacts.length;
        console.error(
          `✨ [Jarvis Reflection] Consolidation complete. Condensed ${allFacts.length} fragments into ${newFacts.length} core insights.`,
        );
        // L1 batch flush after consolidation (always, regardless of l1WriteMode)
        this.flushToPhysicalLayer();
        // Re-extract entity links for consolidated facts: delay 30s to avoid
        // competing with ongoing conversation
        if (this.entityExtractor) {
          setTimeout(() => void this.backfillEntityLinks(), 30_000);
        }
      } else {
        // LLM returned text but no valid JSON array — update baseline to avoid re-triggering immediately
        this.lastConsolidatedCount = allFacts.length;
        console.error(
          `⚠️ [Jarvis Reflection] No valid JSON array in consolidation response. Skipping. Preview: ${responseText.slice(0, 200)}`,
        );
      }
    } catch (e: any) {
      console.error(`⚠️ [Jarvis Reflection] Synthesis failed: ${e.message}`);
    } finally {
      this.isConsolidating = false;
    }
  }

  public enqueue(sessionId: string, userPrompt: string, assistantText: string) {
    this.queue.push({ sessionId, userPrompt, assistantText });
  }

  private async processQueue() {
    // processQueue uses its own isProcessing flag, independent of isConsolidating
    if (this.isProcessing) return;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        this.isProcessing = true;
        await this.ingestMemory(
          item.sessionId,
          item.userPrompt,
          item.assistantText,
        );
        this.isProcessing = false;
      }
      await new Promise((r) =>
        setTimeout(r, this.jarvisConfig.memory.ingestionDelayMs),
      );
    }
    setTimeout(() => void this.processQueue(), 2000);
  }

  private async ingestMemory(
    sessionId: string,
    userPrompt: string,
    assistantText: string,
  ) {
    if (!this.embedContentFn && !this.client) return;
    try {
      const text = `User: ${userPrompt}\nAssistant: ${assistantText}`;
      let vecValues: number[];
      if (this.embedContentFn) {
        vecValues = await this.embedContentFn(text);
      } else {
        const result = await this.client.models.embedContent({
          model: this.jarvisConfig.models.embedding,
          contents: [{ role: "user", parts: [{ text }] }],
        });
        const embeddings = result.embeddings || [result.embedding];
        vecValues = embeddings[0].values;
      }
      const info = this.db
        .prepare(
          "INSERT INTO memories (sessionId, text, timestamp) VALUES (?, ?, ?)",
        )
        .run(sessionId, text, Date.now());
      try {
        this.db
          .prepare("INSERT INTO vec_memories (id, embedding) VALUES (?, ?)")
          .run(BigInt(info.lastInsertRowid), new Float32Array(vecValues));
      } catch (_vecErr) {}
    } catch (e) {}
  }

  public async search(query: string, limit: number = 5): Promise<string[]> {
    if (!this.embedContentFn && !this.client) return [];
    try {
      let queryVec: number[];
      if (this.embedContentFn) {
        queryVec = await this.embedContentFn(query);
      } else {
        const result = await this.client.models.embedContent({
          model: this.jarvisConfig.models.embedding,
          contents: [{ role: "user", parts: [{ text: query }] }],
        });
        const embeddings = result.embeddings || [result.embedding];
        queryVec = embeddings[0].values;
      }
      const results = this.db
        .prepare(
          `
        SELECT m.text FROM memories m JOIN vec_memories v ON m.id = v.id
        WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?
      `,
        )
        .all(
          new Float32Array(queryVec),
          limit || this.jarvisConfig.memory.retrievalLimit,
        ) as any[];
      return results.map((r) => r.text);
    } catch (e) {
      return [];
    }
  }

  public getCoreFacts(): string[] {
    try {
      const results = this.db
        .prepare("SELECT category, content FROM facts ORDER BY importance DESC")
        .all() as any[];
      return results.map((f) => `[${f.category}] ${f.content}`);
    } catch (e) {
      return [];
    }
  }

  public getStructuredFacts(): Array<{ category: string; content: string }> {
    try {
      return this.db
        .prepare("SELECT category, content FROM facts ORDER BY importance DESC")
        .all() as any[];
    } catch (e) {
      return [];
    }
  }

  /**
   * Reflects on accumulated facts to generate/update higher-order insights.
   */
  public async reflect(
    generateText: (prompt: string) => Promise<string>,
  ): Promise<void> {
    try {
      const nonInsightFacts = this.db
        .prepare(
          "SELECT category, content, importance FROM facts WHERE category != 'insight' ORDER BY importance DESC",
        )
        .all() as Array<{
        category: string;
        content: string;
        importance: number;
      }>;

      if (nonInsightFacts.length === 0) {
        console.error(
          `💡 [MemoryService] Reflection skipped: no non-insight facts found.`,
        );
        return;
      }

      console.error(
        `💡 [MemoryService] Reflection started: ${nonInsightFacts.length} facts → generating insights...`,
      );

      const existingInsights = this.db
        .prepare(
          "SELECT content, importance FROM facts WHERE category = 'insight' ORDER BY importance DESC",
        )
        .all() as Array<{ content: string; importance: number }>;

      const factsText = nonInsightFacts
        .map((f) => `[${f.category.toUpperCase()}] ${f.content}`)
        .join("\n");

      const insightsSection =
        existingInsights.length > 0
          ? `\nExisting insights (review, update, merge, or replace as needed):\n${existingInsights.map((i) => `[INSIGHT] ${i.content}`).join("\n")}\n`
          : "";

      const prompt = `
You are Jarvis's Cognitive Reflection Module. Analyze the accumulated knowledge and generate an updated set of high-value insights.

Current knowledge:
${factsText}
${insightsSection}
Task: Generate 2-5 meta-level insights that synthesize patterns across the facts above.
If existing insights are provided, merge/update/replace them — do NOT just copy them unchanged.
Focus on:
- Patterns connecting multiple facts (identity + behavior + decisions)
- Gaps or contradictions worth noting
- Observations that could improve future assistance

Rules:
- Each insight must synthesize MULTIPLE facts, not just restate one
- Be specific and actionable, not generic
- Output replaces ALL existing insights (consolidation, not accumulation)

Respond ONLY with a JSON array:
[{"category": "insight", "content": "...", "importance": 1-10}]
`.trim();

      const raw = await generateText(prompt);
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) {
        console.error(
          `⚠️ [MemoryService] Reflection failed: no JSON array in model response. Response preview: ${raw.slice(0, 200)}`,
        );
        return;
      }

      const newInsights = JSON.parse(match[0]) as Array<{
        category: string;
        content: string;
        importance: number;
      }>;
      // Force category to 'insight' — small models often ignore the category constraint
      const validInsights = newInsights
        .filter((i) => i.content)
        .map((i) => ({ ...i, category: "insight" }));
      if (validInsights.length === 0) {
        console.error(
          `⚠️ [MemoryService] Reflection failed: model returned ${newInsights.length} items but none had valid content.`,
        );
        return;
      }

      // Atomically replace all old insights with new ones
      const replaceInsights = this.db.transaction(() => {
        // Clear dependent tables first to avoid FK constraint failures
        try {
          this.db
            .prepare(
              "DELETE FROM entity_links WHERE fact_id IN (SELECT id FROM facts WHERE category = 'insight')",
            )
            .run();
        } catch (_) {}
        this.db.prepare("DELETE FROM facts WHERE category = 'insight'").run();
        try {
          this.db
            .prepare(
              "DELETE FROM vec_facts WHERE id NOT IN (SELECT id FROM facts)",
            )
            .run();
        } catch (_) {}
        try {
          this.db
            .prepare(
              "DELETE FROM facts_fts WHERE fact_id NOT IN (SELECT id FROM facts)",
            )
            .run();
        } catch (_) {}
        for (const insight of validInsights) {
          const info = this.db
            .prepare(
              "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
            )
            .run(
              "insight",
              insight.content,
              insight.importance ?? 8,
              Date.now(),
            );
          try {
            this.db
              .prepare("INSERT INTO facts_fts (content, fact_id) VALUES (?, ?)")
              .run(insight.content, Number(info.lastInsertRowid));
          } catch (_) {}
        }
      });
      replaceInsights();

      console.error(
        `💡 [MemoryService] Reflection complete: ${validInsights.length} insights (replaced ${existingInsights.length} old).`,
      );
      // L1 batch flush after reflection
      this.flushToPhysicalLayer();
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] Reflection failed: ${e.message}`);
    }
  }

  // preference: response style — always needed every turn
  // insight: high-order meta-knowledge — always valuable regardless of current topic
  private static readonly ALWAYS_INJECT_CATEGORIES = new Set([
    "preference",
    "insight",
  ]);

  /**
   * Returns facts relevant to the given query.
   * preference and insight facts are always included.
   * All other facts are ranked by relevance and capped at factRelevanceLimit.
   */
  public async searchFacts(
    query: string,
    limit?: number,
  ): Promise<Array<{ category: string; content: string }>> {
    try {
      // Single read: load all facts into memory once
      const allFacts = this.db
        .prepare(
          "SELECT id, category, content, importance, embedding, last_accessed, access_count FROM facts ORDER BY importance DESC",
        )
        .all() as Array<{
        id: number;
        category: string;
        content: string;
        importance: number;
        embedding: Buffer | null;
        last_accessed: number | null;
        access_count: number | null;
      }>;

      const alwaysFacts = allFacts.filter((f) =>
        MemoryService.ALWAYS_INJECT_CATEGORIES.has(f.category),
      );
      const candidateFacts = allFacts.filter(
        (f) => !MemoryService.ALWAYS_INJECT_CATEGORIES.has(f.category),
      );

      const cap = limit ?? this.jarvisConfig.memory.factRelevanceLimit ?? 5;
      const strategy =
        this.jarvisConfig.memory.factRelevanceStrategy ?? "jaccard";

      let ranked: Array<{ category: string; content: string }>;
      let rankedIdsForGraph: number[] = [];
      // Build id → fact map from ALL facts so expandViaEntityLinks can resolve
      // any linked fact_id including insight/preference categories
      const factById = new Map(allFacts.map((f) => [f.id, f]));

      if (strategy === "embedding" && this.embedContentFn) {
        try {
          const queryVec = await this.embedContentFn(query);
          const alpha = this.jarvisConfig.memory.vectorSimilarityWeight ?? 0.7;
          const beta = this.jarvisConfig.memory.importanceWeight ?? 0.3;

          // vec_facts: only fetch id + distance (no JOIN needed)
          const fetchLimit = Math.max(cap * 3, 20);
          const vecRows = this.db
            .prepare(
              `SELECT id, distance FROM vec_facts
               WHERE embedding MATCH ?
               ORDER BY distance
               LIMIT ?`,
            )
            .all(new Float32Array(queryVec), fetchLimit) as Array<{
            id: number;
            distance: number;
          }>;

          const gamma = this.jarvisConfig.memory.accessWeight ?? 0.1;
          const lambda = this.jarvisConfig.memory.decayLambda ?? 0.1;
          const hybridSearch = this.jarvisConfig.memory.hybridSearch ?? true;
          const rrfK = this.jarvisConfig.memory.rrfK ?? 60;
          const nowMs = Date.now();

          if (vecRows.length > 0) {
            // BM25 parallel search (best-effort)
            const bm25RankMap = new Map<number, number>(); // fact_id → rank (1-based)
            if (hybridSearch) {
              try {
                const ftsQuery = query
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean)
                  .join(" OR ");
                const bm25Rows = this.db
                  .prepare(
                    `
                  SELECT fact_id, rank FROM facts_fts
                  WHERE facts_fts MATCH ?
                  ORDER BY rank
                  LIMIT ?
                `,
                  )
                  .all(ftsQuery, fetchLimit) as Array<{
                  fact_id: number;
                  rank: number;
                }>;
                bm25Rows.forEach((r, idx) =>
                  bm25RankMap.set(r.fact_id, idx + 1),
                );
              } catch (_) {
                /* FTS not available, skip */
              }
            }

            // RRF fusion: rrfScore = 1/(k+rank_vec) + 1/(k+rank_bm25)
            // Then add importance and decay on top
            const scoredRows = vecRows
              .map((r, vecIdx) => {
                const fact = factById.get(r.id);
                if (!fact) return null;
                const vecRank = vecIdx + 1;
                const bm25Rank = bm25RankMap.get(r.id) ?? fetchLimit + 1;
                const rrfScore = 1 / (rrfK + vecRank) + 1 / (rrfK + bm25Rank);
                const daysSince = fact.last_accessed
                  ? (nowMs - fact.last_accessed) / 86_400_000
                  : 0;
                const decay = Math.exp(-lambda * daysSince);
                const fusedScore =
                  rrfScore + beta * (fact.importance / 10) + gamma * decay;
                return {
                  id: r.id,
                  category: fact.category,
                  content: fact.content,
                  score: fusedScore,
                };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null)
              .sort((a, b) => b.score - a.score)
              .slice(0, cap);

            ranked = scoredRows.map(({ category, content }) => ({
              category,
              content,
            }));

            // Async update access stats for ranked facts (non-blocking)
            const rankedIds = scoredRows.map((r) => r.id);
            rankedIdsForGraph = rankedIds;
            setImmediate(() => this.updateAccessStats(rankedIds, nowMs));
          } else {
            // vec_facts empty — fall back to in-memory cosine using already-loaded embeddings
            const scoredFallback = candidateFacts
              .map((f) => {
                if (!f.embedding) return { ...f, score: 0 };
                const vec = Array.from(new Float32Array(f.embedding.buffer));
                const cosineSim = this.cosineSimilarity(queryVec, vec);
                const daysSince = f.last_accessed
                  ? (nowMs - f.last_accessed) / 86_400_000
                  : 0;
                const decay = Math.exp(-lambda * daysSince);
                const fusedScore =
                  alpha * cosineSim +
                  beta * (f.importance / 10) +
                  gamma * decay;
                return { ...f, score: fusedScore };
              })
              .sort((a, b) => (b as any).score - (a as any).score)
              .slice(0, cap);

            ranked = scoredFallback.map(({ category, content }) => ({
              category,
              content,
            }));
            const fallbackIds = scoredFallback.map((f) => f.id);
            rankedIdsForGraph = fallbackIds;
            setImmediate(() => this.updateAccessStats(fallbackIds, nowMs));
          }
        } catch (_e: any) {
          console.error(
            `⚠️ [searchFacts] embedding strategy failed, falling back to jaccard: ${_e?.message}`,
          );
          ranked = this.rankByJaccard(query, candidateFacts, cap);
        }
      } else {
        ranked = this.rankByJaccard(query, candidateFacts, cap);
      }

      const alwaysOut = alwaysFacts.map(({ category, content }) => ({
        category,
        content,
      }));

      console.error(
        `🧠 [searchFacts] always(${alwaysOut.length}): ${alwaysOut.map((f) => `[${f.category}] ${f.content.slice(0, 50)}`).join(" | ")}`,
      );
      console.error(
        `🧠 [searchFacts] ranked(${ranked.length}): ${ranked.map((f) => `[${f.category}] ${f.content.slice(0, 50)}`).join(" | ")}`,
      );

      // Graph expansion: use ids collected during ranking
      // Filter out facts already in alwaysOut or ranked to avoid duplicates
      const alreadyIncluded = new Set([
        ...alwaysOut.map((f) => f.content),
        ...ranked.map((f) => f.content),
      ]);
      const expanded = this.expandViaEntityLinks(
        rankedIdsForGraph,
        factById,
      ).filter((f) => !alreadyIncluded.has(f.content));
      if (expanded.length > 0) {
        console.error(
          `🔗 [searchFacts] expanded(${expanded.length}): ${expanded.map((f) => `[${f.category}] ${f.content.slice(0, 50)}`).join(" | ")}`,
        );
      }
      return [...alwaysOut, ...ranked, ...expanded];
    } catch (e: any) {
      console.error(`⚠️ [searchFacts] outer catch: ${e?.message}`);
      return this.getStructuredFacts();
    }
  }

  // ---------------------------------------------------------------------------
  // Knowledge Graph — Entity Extraction & Neural Link
  // ---------------------------------------------------------------------------

  /** Get or create an entity by name, return its id. */
  private getOrCreateEntity(name: string, type: string): number {
    const existing = this.db
      .prepare("SELECT id FROM entities WHERE name = ?")
      .get(name) as { id: number } | undefined;
    if (existing) return existing.id;
    const info = this.db
      .prepare("INSERT INTO entities (name, type) VALUES (?, ?)")
      .run(name, type);
    return Number(info.lastInsertRowid);
  }

  /** Extract entities from facts and persist to entity_links. */
  private async extractAndSaveEntities(
    facts: Array<{ category: string; content: string }>,
    factId: number | null = null,
  ): Promise<void> {
    if (!this.entityExtractor) return;
    try {
      const links = await this.entityExtractor.extract(facts);

      // Validate factId still exists (may have been deleted by consolidateFacts)
      if (factId !== null) {
        const stillExists = this.db
          .prepare("SELECT id FROM facts WHERE id = ?")
          .get(factId);
        if (!stillExists) {
          debugLogger.debug(
            `[MemoryService] extractAndSaveEntities: fact ${factId} no longer exists, skipping`,
          );
          return;
        }
      }

      const insert = this.db.transaction(() => {
        for (const link of links) {
          const subjectId = this.getOrCreateEntity(
            link.subject,
            link.subject_type,
          );
          const objectId = this.getOrCreateEntity(
            link.object,
            link.object_type,
          );
          const exists = this.db
            .prepare(
              "SELECT id FROM entity_links WHERE subject_id = ? AND relation = ? AND object_id = ?",
            )
            .get(subjectId, link.relation, objectId);
          if (!exists) {
            this.db
              .prepare(
                "INSERT INTO entity_links (subject_id, relation, object_id, fact_id, timestamp) VALUES (?, ?, ?, ?, ?)",
              )
              .run(subjectId, link.relation, objectId, factId, Date.now());
          }
        }
        // Always mark the fact as processed via sentinel row (prevents backfill re-processing)
        if (factId !== null) {
          const alreadyMarked = this.db
            .prepare("SELECT id FROM entity_links WHERE fact_id = ?")
            .get(factId);
          if (!alreadyMarked) {
            this.db
              .prepare(
                "INSERT INTO entity_links (subject_id, relation, object_id, fact_id, timestamp) VALUES (NULL, 'processed', NULL, ?, ?)",
              )
              .run(factId, Date.now());
          }
        }
      });
      insert();
      if (links.length > 0) {
        console.error(
          `🔗 [MemoryService] EntityLinks saved: ${links.length} relations`,
        );
      }
    } catch (e: any) {
      console.error(
        `⚠️ [MemoryService] extractAndSaveEntities failed: ${e.message}`,
      );
    }
  }

  /**
   * Given a set of ranked fact ids, expand via entity_links to find
   * related facts not already in the result set.
   * Returns additional facts to append (up to maxExpand).
   */
  private expandViaEntityLinks(
    rankedIds: number[],
    factById: Map<
      number,
      { category: string; content: string; importance: number }
    >,
    maxExpand: number = 3,
  ): Array<{ category: string; content: string }> {
    if (rankedIds.length === 0 || !this.jarvisConfig.entityExtraction?.enabled)
      return [];
    try {
      // Use json_each to avoid dynamic placeholder construction
      const idsJson = JSON.stringify(rankedIds);
      const linkedFactIds = this.db
        .prepare(
          `
          SELECT DISTINCT el2.fact_id
          FROM entity_links el1
          JOIN entity_links el2
            ON (el1.subject_id = el2.subject_id OR el1.object_id = el2.subject_id
                OR el1.subject_id = el2.object_id OR el1.object_id = el2.object_id)
          WHERE el1.fact_id IN (SELECT value FROM json_each(?))
            AND el1.relation != 'processed'
            AND el2.fact_id IS NOT NULL
            AND el2.relation != 'processed'
            AND el2.fact_id NOT IN (SELECT value FROM json_each(?))
          LIMIT ?
          `,
        )
        .all(idsJson, idsJson, maxExpand) as Array<{ fact_id: number }>;

      console.error(
        `🔗 [expandViaEntityLinks] rankedIds=${JSON.stringify(rankedIds)}, linkedFactIds=${JSON.stringify(linkedFactIds.map((r) => r.fact_id))}, factByIdSize=${factById.size}`,
      );
      const expanded = linkedFactIds
        .map((r) => {
          const f = factById.get(r.fact_id);
          if (!f)
            console.error(
              `🔗 [expandViaEntityLinks] fact_id=${r.fact_id} not in factById`,
            );
          return f;
        })
        .filter((f): f is NonNullable<typeof f> => f !== undefined)
        .map(({ category, content }) => ({ category, content }));
      return expanded;
    } catch (e: any) {
      console.error(
        `⚠️ [MemoryService] expandViaEntityLinks failed: ${e.message}`,
      );
      return [];
    }
  }

  /** Increment access_count and update last_accessed for the given fact ids. */
  private updateAccessStats(ids: number[], nowMs: number): void {
    if (ids.length === 0) return;
    try {
      const update = this.db.prepare(
        "UPDATE facts SET last_accessed = ?, access_count = COALESCE(access_count, 0) + 1 WHERE id = ?",
      );
      const updateAll = this.db.transaction(() => {
        for (const id of ids) update.run(nowMs, id);
      });
      updateAll();
    } catch (e: any) {
      debugLogger.debug(
        `[MemoryService] updateAccessStats failed: ${e.message}`,
      );
    }
  }

  private rankByJaccard(
    query: string,
    facts: Array<{ category: string; content: string }>,
    limit: number,
  ): Array<{ category: string; content: string }> {
    return facts
      .map((f) => ({ ...f, score: this.jaccardSimilarity(query, f.content) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ category, content }) => ({ category, content }));
  }

  /**
   * Sends a prompt to the distillation model and returns the full text response.
   */
  public async generateText(prompt: string): Promise<string> {
    if (!this.client)
      throw new Error("[MemoryService] AI client not initialized");
    const result = await this.client.models.generateContent({
      model: this.jarvisConfig.models.distillation,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
      return result.response.candidates[0].content.parts[0].text;
    } else if ((result as any).candidates?.[0]?.content?.parts?.[0]?.text) {
      return (result as any).candidates[0].content.parts[0].text;
    } else if (typeof result.response?.text === "function") {
      return result.response.text();
    }
    throw new Error("[MemoryService] Empty response from model");
  }

  // ---------------------------------------------------------------------------
  // L1 Physical Layer — MEMORIES.md
  // ---------------------------------------------------------------------------

  private get memoriesFilePath(): string {
    return path.join(this.memoryDir, "MEMORIES.md");
  }

  private get metaFilePath(): string {
    return path.join(this.memoryDir, "memory_meta.json");
  }

  private readMeta(): { lastFlushMtime?: number } {
    try {
      if (!fs.existsSync(this.metaFilePath)) return {};
      return JSON.parse(fs.readFileSync(this.metaFilePath, "utf8"));
    } catch {
      return {};
    }
  }

  private writeMeta(data: { lastFlushMtime?: number }): void {
    try {
      fs.writeFileSync(this.metaFilePath, JSON.stringify(data, null, 2));
    } catch (e: any) {
      console.error(
        `⚠️ [MemoryService] Failed to write memory_meta.json: ${e.message}`,
      );
    }
  }

  /**
   * Serialize a single fact to a Markdown line.
   * Format: `- [importance] content`
   */
  private factToMarkdownLine(fact: {
    content: string;
    importance: number;
  }): string {
    return `- [${fact.importance}] ${fact.content}`;
  }

  /**
   * Full rewrite of MEMORIES.md from the current facts table.
   * Grouped by category, sorted by importance desc.
   * Used in batch mode (after consolidateFacts / reflect).
   */
  public flushToPhysicalLayer(): void {
    try {
      const allFacts = this.db
        .prepare(
          "SELECT category, content, importance FROM facts ORDER BY category, importance DESC",
        )
        .all() as Array<{
        category: string;
        content: string;
        importance: number;
      }>;

      if (allFacts.length === 0) {
        fs.writeFileSync(
          this.memoriesFilePath,
          "# Jarvis Memory\n\n_(No facts yet)_\n",
        );
        return;
      }

      // Group by category
      const byCategory = new Map<
        string,
        Array<{ content: string; importance: number }>
      >();
      for (const f of allFacts) {
        if (!byCategory.has(f.category)) byCategory.set(f.category, []);
        byCategory
          .get(f.category)!
          .push({ content: f.content, importance: f.importance });
      }

      const lines: string[] = ["# Jarvis Memory\n"];
      for (const [category, facts] of byCategory) {
        lines.push(`## ${category}\n`);
        for (const f of facts) {
          lines.push(this.factToMarkdownLine(f));
        }
        lines.push("");
      }

      // Write atomically via temp file
      const tmpPath = this.memoriesFilePath + ".tmp";
      fs.writeFileSync(tmpPath, lines.join("\n"));
      fs.renameSync(tmpPath, this.memoriesFilePath);
      // Record mtime so we can detect manual edits later
      const mtime = fs.statSync(this.memoriesFilePath).mtimeMs;
      this.writeMeta({ lastFlushMtime: mtime });
      debugLogger.debug(
        `[MemoryService] L1 flushed: ${allFacts.length} facts → MEMORIES.md`,
      );
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] L1 flush failed: ${e.message}`);
    }
  }

  /**
   * Append a single fact line to MEMORIES.md (realtime mode).
   * Creates the file and category heading if needed.
   */
  private appendToPhysicalLayer(
    category: string,
    content: string,
    importance: number,
  ): void {
    try {
      const line = this.factToMarkdownLine({ content, importance });
      const heading = `## ${category}`;

      if (!fs.existsSync(this.memoriesFilePath)) {
        fs.writeFileSync(
          this.memoriesFilePath,
          `# Jarvis Memory\n\n${heading}\n\n${line}\n`,
        );
        return;
      }

      const existing = fs.readFileSync(this.memoriesFilePath, "utf8");
      if (existing.includes(heading)) {
        // Append after the last line of this category section
        const updated = existing.replace(
          new RegExp(`(${heading}[\\s\\S]*?)(\n## |$)`),
          (_, section, next) => `${section}\n${line}${next}`,
        );
        fs.writeFileSync(this.memoriesFilePath, updated);
      } else {
        // Category not present yet — append new section
        fs.appendFileSync(this.memoriesFilePath, `\n${heading}\n\n${line}\n`);
      }
    } catch (e: any) {
      console.error(
        `⚠️ [MemoryService] L1 realtime append failed: ${e.message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-Backfill (L2 + L1 self-healing on startup)
  // ---------------------------------------------------------------------------

  /**
   * Checks for missing embeddings in vec_facts and missing MEMORIES.md,
   * then heals them. Called automatically after embedContentFn is injected.
   */
  public async autoBackfill(): Promise<void> {
    if (!this.embedContentFn) return;
    // Rebuild vec tables if dimension changed (e.g. switching embedding provider)
    this.rebuildVecTablesIfDimensionMismatch();
    // Backfill facts_fts for any facts not yet indexed
    this.backfillFts();
    // L1→L2 sync: if MEMORIES.md was manually edited, rebuild facts from it
    const synced = this.syncFromPhysicalLayerIfModified();
    // Run both steps independently — a vec_facts failure should not block L1 rebuild
    try {
      await this.backfillVecFacts();
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] Auto-backfill failed: ${e.message}`);
    }
    try {
      // Skip backfillPhysicalLayer if we just synced from L1 (avoid immediate overwrite)
      if (!synced) this.backfillPhysicalLayer();
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] Auto-backfill failed: ${e.message}`);
    }
    // Backfill entity links: delay 60s after startup to avoid competing
    // with the first user interaction (Ollama calls are slow)
    setTimeout(() => void this.backfillEntityLinks(), 60_000);
  }

  /**
   * For facts that have no entry in entity_links, run entity extraction in batches.
   * Skips if entityExtractor is not initialized.
   */
  private async backfillEntityLinks(): Promise<void> {
    if (!this.entityExtractor) return;
    if (this.isBackfillingEntities) return;
    this.isBackfillingEntities = true;
    try {
      // Facts with no entity_links at all
      const unprocessed = this.db
        .prepare(
          `
        SELECT id, category, content FROM facts
        WHERE id NOT IN (SELECT DISTINCT fact_id FROM entity_links WHERE fact_id IS NOT NULL)
      `,
        )
        .all() as Array<{ id: number; category: string; content: string }>;

      if (unprocessed.length === 0) return;

      console.error(
        `🔗 [MemoryService] Entity backfill: processing ${unprocessed.length} facts...`,
      );

      // Batch size from config (default 1 for best per-fact accuracy with small models)
      const BATCH = Math.max(
        1,
        this.jarvisConfig.entityExtraction?.batchSize ?? 1,
      );
      let total = 0;
      for (let i = 0; i < unprocessed.length; i += BATCH) {
        // Yield to event loop between batches so main thread stays responsive
        await new Promise((r) => setImmediate(r));
        const batch = unprocessed.slice(i, i + BATCH);
        const links = await this.entityExtractor.extract(
          batch.map((f) => ({ category: f.category, content: f.content })),
        );
        if (links.length > 0) {
          // Associate links with the batch facts
          // Use first fact id in batch as representative source (best-effort)
          const batchFactId = batch[0]?.id ?? null;
          const insert = this.db.transaction(() => {
            for (const link of links) {
              const subjectId = this.getOrCreateEntity(
                link.subject,
                link.subject_type,
              );
              const objectId = this.getOrCreateEntity(
                link.object,
                link.object_type,
              );
              const exists = this.db
                .prepare(
                  "SELECT id FROM entity_links WHERE subject_id = ? AND relation = ? AND object_id = ?",
                )
                .get(subjectId, link.relation, objectId);
              if (!exists) {
                this.db
                  .prepare(
                    "INSERT INTO entity_links (subject_id, relation, object_id, fact_id, timestamp) VALUES (?, ?, ?, ?, ?)",
                  )
                  .run(
                    subjectId,
                    link.relation,
                    objectId,
                    batchFactId,
                    Date.now(),
                  );
              }
            }
            // Mark batch facts as processed by inserting a null-linked placeholder
            for (const f of batch) {
              const alreadyMarked = this.db
                .prepare("SELECT id FROM entity_links WHERE fact_id = ?")
                .get(f.id);
              if (!alreadyMarked) {
                // Insert a sentinel row so this fact is not re-processed
                this.db
                  .prepare(
                    "INSERT INTO entity_links (subject_id, relation, object_id, fact_id, timestamp) VALUES (NULL, 'processed', NULL, ?, ?)",
                  )
                  .run(f.id, Date.now());
              }
            }
          });
          insert();
          total += links.length;
        } else {
          // No links found — still mark as processed
          const markProcessed = this.db.transaction(() => {
            for (const f of batch) {
              const alreadyMarked = this.db
                .prepare("SELECT id FROM entity_links WHERE fact_id = ?")
                .get(f.id);
              if (!alreadyMarked) {
                this.db
                  .prepare(
                    "INSERT INTO entity_links (subject_id, relation, object_id, fact_id, timestamp) VALUES (NULL, 'processed', NULL, ?, ?)",
                  )
                  .run(f.id, Date.now());
              }
            }
          });
          markProcessed();
        }
      }
      console.error(
        `✅ [MemoryService] Entity backfill complete: ${total} relations extracted`,
      );
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] Entity backfill failed: ${e.message}`);
    } finally {
      this.isBackfillingEntities = false;
    }
  }

  /**
   * Parse MEMORIES.md into structured facts.
   * Format per line: `- [importance] content`
   * Sections: `## category`
   */
  private parseMemoriesMd(
    content: string,
  ): Array<{ category: string; content: string; importance: number }> {
    const facts: Array<{
      category: string;
      content: string;
      importance: number;
    }> = [];
    let currentCategory = "";
    for (const line of content.split("\n")) {
      const categoryMatch = line.match(/^##\s+(.+)$/);
      if (categoryMatch) {
        currentCategory = categoryMatch[1].trim().toLowerCase();
        continue;
      }
      const factMatch = line.match(/^-\s+\[(\d+)\]\s+(.+)$/);
      if (factMatch && currentCategory) {
        const importance = parseInt(factMatch[1], 10);
        const factContent = factMatch[2].trim();
        if (factContent) {
          facts.push({
            category: currentCategory,
            content: factContent,
            importance,
          });
        }
      }
    }
    return facts;
  }

  /**
   * If MEMORIES.md has been modified since the last flush,
   * rebuild the facts table from it (L1 → L2 sync).
   * Returns true if sync was performed.
   */
  private syncFromPhysicalLayerIfModified(): boolean {
    try {
      if (!fs.existsSync(this.memoriesFilePath)) return false;

      const currentMtime = fs.statSync(this.memoriesFilePath).mtimeMs;
      const meta = this.readMeta();

      // No recorded flush mtime means we never flushed — don't sync
      if (!meta.lastFlushMtime) return false;

      // If mtime matches last flush, user hasn't edited it
      if (currentMtime <= meta.lastFlushMtime) return false;

      console.error(
        "📖 [MemoryService] MEMORIES.md modified since last flush — syncing L1 → L2...",
      );

      const mdContent = fs.readFileSync(this.memoriesFilePath, "utf8");
      const parsedFacts = this.parseMemoriesMd(mdContent);

      if (parsedFacts.length === 0) {
        console.error(
          "⚠️ [MemoryService] L1→L2 sync: no parseable facts found in MEMORIES.md, skipping.",
        );
        return false;
      }

      // Full replacement: clear facts + vec_facts + facts_fts, reinsert from MEMORIES.md
      const rebuild = this.db.transaction(() => {
        // Clear dependent tables first to avoid FK constraint failures
        try {
          this.db.prepare("DELETE FROM entity_links").run();
        } catch (_) {}
        try {
          this.db.prepare("DELETE FROM entities").run();
        } catch (_) {}
        this.db.prepare("DELETE FROM facts").run();
        try {
          this.db.prepare("DELETE FROM vec_facts").run();
        } catch (_) {}
        try {
          this.db.prepare("DELETE FROM facts_fts").run();
        } catch (_) {}
        for (const f of parsedFacts) {
          const info = this.db
            .prepare(
              "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
            )
            .run(f.category, f.content, f.importance, Date.now());
          try {
            this.db
              .prepare("INSERT INTO facts_fts (content, fact_id) VALUES (?, ?)")
              .run(f.content, Number(info.lastInsertRowid));
          } catch (_) {}
        }
      });
      rebuild();

      // Update meta mtime to reflect the sync (treat current file as "our" version now)
      this.writeMeta({ lastFlushMtime: currentMtime });

      console.error(
        `✅ [MemoryService] L1→L2 sync complete: rebuilt ${parsedFacts.length} facts from MEMORIES.md. Embeddings will be regenerated.`,
      );
      return true;
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] L1→L2 sync failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Detects dimension mismatch between config and existing vec tables.
   * If mismatched, drops and recreates both vec_memories and vec_facts,
   * and clears all embeddings in facts/memories so backfill regenerates them.
   */
  private rebuildVecTablesIfDimensionMismatch(): void {
    const expectedDim = this.jarvisConfig.models.embeddingDimension;
    try {
      // Probe actual dimension by checking vec table schema
      const row = this.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_facts'`,
        )
        .get() as { sql: string } | undefined;

      if (!row) return; // table doesn't exist yet, will be created normally

      const match = row.sql.match(/FLOAT\[(\d+)\]/);
      if (!match) return;
      const actualDim = parseInt(match[1], 10);

      if (actualDim === expectedDim) return;

      console.error(
        `🔄 [MemoryService] Embedding dimension changed (${actualDim} → ${expectedDim}). Rebuilding vec tables...`,
      );

      // Drop and recreate vec tables with new dimension
      try {
        this.db.exec("DROP TABLE IF EXISTS vec_facts");
      } catch (_) {}
      try {
        this.db.exec("DROP TABLE IF EXISTS vec_memories");
      } catch (_) {}
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          id INTEGER PRIMARY KEY,
          embedding FLOAT[${expectedDim}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
          id INTEGER PRIMARY KEY,
          embedding FLOAT[${expectedDim}]
        );
      `);

      // Clear stored embeddings so backfill regenerates them with the new dimension
      this.db.prepare("UPDATE facts SET embedding = NULL").run();
      this.db.prepare("DELETE FROM memories").run();

      console.error(
        `✅ [MemoryService] Vec tables rebuilt at ${expectedDim} dimensions. Embeddings will be regenerated.`,
      );
    } catch (e: any) {
      console.error(
        `⚠️ [MemoryService] rebuildVecTablesIfDimensionMismatch failed: ${e.message}`,
      );
    }
  }

  /**
   * For any fact that has an embedding in facts.embedding but is missing
   * from vec_facts, re-insert it. Also handles facts with no embedding yet
   * by generating one (batched, 20 at a time).
   */
  private async backfillVecFacts(): Promise<void> {
    if (!this.embedContentFn) return;

    // Facts with embedding blob but missing from vec_facts
    console.error(
      `[MemoryService] backfillVecFacts: checking for missing vec_facts entries...`,
    );
    const missingInVec = this.db
      .prepare(
        `
      SELECT f.id, f.content, f.embedding
      FROM facts f
      WHERE f.embedding IS NOT NULL
        AND f.id NOT IN (SELECT id FROM vec_facts)
    `,
      )
      .all() as Array<{ id: number; content: string; embedding: Buffer }>;

    for (const row of missingInVec) {
      try {
        const vec = Array.from(new Float32Array(row.embedding.buffer));
        this.db
          .prepare("INSERT INTO vec_facts (id, embedding) VALUES (?, ?)")
          .run(BigInt(row.id), new Float32Array(vec));
      } catch (e: any) {
        console.error(
          `⚠️ [MemoryService] vec_facts insert (existing embedding) failed for id=${row.id}: ${e.message}`,
        );
      }
    }

    // Facts with no embedding at all — generate in batches of 20
    const noEmbedding = this.db
      .prepare("SELECT id, content FROM facts WHERE embedding IS NULL")
      .all() as Array<{ id: number; content: string }>;

    console.error(
      `[MemoryService] backfillVecFacts: missingInVec=${missingInVec.length}, noEmbedding=${noEmbedding.length}`,
    );
    if (noEmbedding.length === 0) {
      if (missingInVec.length > 0) {
        console.error(
          `✅ [MemoryService] Auto-backfill: synced ${missingInVec.length} facts into vec_facts`,
        );
      }
      return;
    }

    debugLogger.debug(
      `[MemoryService] Auto-backfill: generating embeddings for ${noEmbedding.length} facts`,
    );
    const BATCH = 20;
    for (let i = 0; i < noEmbedding.length; i += BATCH) {
      const batch = noEmbedding.slice(i, i + BATCH);
      for (const row of batch) {
        try {
          const vec = await this.embedContentFn(row.content);
          const buf = Buffer.from(new Float32Array(vec).buffer);
          this.db
            .prepare("UPDATE facts SET embedding = ? WHERE id = ?")
            .run(buf, row.id);
          this.db
            .prepare("INSERT INTO vec_facts (id, embedding) VALUES (?, ?)")
            .run(BigInt(row.id), new Float32Array(vec));
        } catch (e: any) {
          console.error(
            `⚠️ [MemoryService] vec_facts insert (new embedding) failed for id=${row.id}:`,
            e,
          );
        }
      }
    }

    if (missingInVec.length > 0 || noEmbedding.length > 0) {
      console.error(
        `✅ [MemoryService] Auto-backfill: synced ${missingInVec.length + noEmbedding.length} facts into vec_facts`,
      );
    }
  }

  /**
   * If MEMORIES.md is missing or empty, rebuild it from SQLite.
   */
  /** Sync any facts not yet in facts_fts into the FTS index. */
  private backfillFts(): void {
    try {
      const missing = this.db
        .prepare(
          `
        SELECT id, content FROM facts
        WHERE id NOT IN (SELECT fact_id FROM facts_fts)
      `,
        )
        .all() as Array<{ id: number; content: string }>;
      if (missing.length === 0) return;
      const insert = this.db.prepare(
        "INSERT INTO facts_fts (content, fact_id) VALUES (?, ?)",
      );
      const insertAll = this.db.transaction(() => {
        for (const row of missing) insert.run(row.content, row.id);
      });
      insertAll();
      console.error(
        `✅ [MemoryService] FTS backfill: indexed ${missing.length} facts into facts_fts`,
      );
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] FTS backfill failed: ${e.message}`);
    }
  }

  private backfillPhysicalLayer(): void {
    try {
      const missing = !fs.existsSync(this.memoriesFilePath);
      const empty =
        !missing &&
        fs.readFileSync(this.memoriesFilePath, "utf8").trim().length < 20;
      if (missing || empty) {
        this.flushToPhysicalLayer();
        console.error(
          "✅ [MemoryService] Auto-backfill: MEMORIES.md rebuilt from SQLite",
        );
      }
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] L1 backfill failed: ${e.message}`);
    }
  }

  /**
   * Parse messages from a session file (.json or .jsonl).
   * .json: single object with messages array
   * .jsonl: first line = metadata, remaining lines = individual message objects
   */
  private parseSessionMessages(
    filePath: string,
  ): Array<{ type: string; content: string; toolCalls?: unknown[] }> {
    const content = fs.readFileSync(filePath, "utf8");
    if (!filePath.endsWith(".jsonl")) {
      const parsed = JSON.parse(content) as {
        messages?: Array<{ type: string; content: string }>;
      };
      return parsed.messages ?? [];
    }
    // .jsonl: skip first line (metadata), parse remaining lines as messages
    const lines = content.split("\n").filter((l) => l.trim());
    const messages: Array<{
      type: string;
      content: string;
      toolCalls?: unknown[];
    }> = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]) as {
          type?: string;
          content?: string;
          toolCalls?: unknown[];
        };
        if (msg.type && msg.content !== undefined) {
          messages.push(
            msg as { type: string; content: string; toolCalls?: unknown[] },
          );
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return messages;
  }

  private async syncHistoricalSessions() {
    const chatsDir = path.join(
      os.homedir(),
      ".gemini-jarvis",
      "storage",
      "chats",
    );
    if (!fs.existsSync(chatsDir)) return;

    const files = fs
      .readdirSync(chatsDir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(chatsDir, file);
      const stats = fs.statSync(filePath);
      const processed = this.db
        .prepare("SELECT last_mtime FROM processed_files WHERE filename = ?")
        .get(file) as any;

      if (!processed || processed.last_mtime < stats.mtimeMs) {
        debugLogger.debug(
          `[MemoryService] Syncing historical session: ${file}`,
        );
        try {
          const messages = this.parseSessionMessages(filePath);
          for (let i = 0; i < messages.length; i += 2) {
            const userMsg = messages[i];
            const assistantMsg = messages[i + 1];
            if (
              userMsg &&
              assistantMsg &&
              userMsg.type === "user" &&
              assistantMsg.type === "gemini"
            ) {
              this.enqueue(
                file.replace(/\.(json|jsonl)$/, ""),
                userMsg.content,
                assistantMsg.content,
              );
            }
          }
          this.db
            .prepare(
              "INSERT OR REPLACE INTO processed_files (filename, last_mtime) VALUES (?, ?)",
            )
            .run(file, stats.mtimeMs);
        } catch (e) {}
      }
    }
  }
}
