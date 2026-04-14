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
  private config: any;
  private lastConsolidatedCount = 0;
  private generateTextFn: ((prompt: string) => Promise<string>) | null = null;
  private embedContentFn: ((text: string) => Promise<number[]>) | null = null;
  private memoryDir: string;

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

    // Migration: add embedding column to existing facts tables
    try {
      this.db.exec("ALTER TABLE facts ADD COLUMN embedding BLOB");
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
      if (this.generateTextFn) {
        responseText = await this.generateTextFn(reflectionPrompt);
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
          // Clear both tables first to avoid id orphans in vec_facts
          this.db.prepare("DELETE FROM facts").run();
          try {
            this.db.prepare("DELETE FROM vec_facts").run();
          } catch (_) {}

          for (let i = 0; i < newFacts.length; i++) {
            const f = newFacts[i];
            const emb = embeddings[i];
            if (emb) {
              const info = this.db
                .prepare(
                  "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
                )
                .run(
                  f.category,
                  f.content,
                  f.importance || 5,
                  Date.now(),
                  Buffer.from(new Float32Array(emb).buffer),
                );
              try {
                this.db
                  .prepare(
                    "INSERT INTO vec_facts (id, embedding) VALUES (?, ?)",
                  )
                  .run(BigInt(info.lastInsertRowid), new Float32Array(emb));
              } catch (_) {}
            } else {
              this.db
                .prepare(
                  "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
                )
                .run(f.category, f.content, f.importance || 5, Date.now());
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
      } else {
        // LLM returned text but no valid JSON array — update baseline to avoid re-triggering immediately
        this.lastConsolidatedCount = allFacts.length;
        console.error(
          "⚠️ [Jarvis Reflection] No valid JSON array in response. Skipping consolidation.",
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

      if (nonInsightFacts.length === 0) return;

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
      if (!match) return;

      const newInsights = JSON.parse(match[0]) as Array<{
        category: string;
        content: string;
        importance: number;
      }>;
      const validInsights = newInsights.filter(
        (i) => i.category === "insight" && i.content,
      );
      if (validInsights.length === 0) return;

      // Atomically replace all old insights with new ones
      const replaceInsights = this.db.transaction(() => {
        this.db.prepare("DELETE FROM facts WHERE category = 'insight'").run();
        // Also remove insight vectors from vec_facts (best-effort)
        try {
          this.db
            .prepare(
              "DELETE FROM vec_facts WHERE id NOT IN (SELECT id FROM facts)",
            )
            .run();
        } catch (_) {}
        for (const insight of validInsights) {
          this.db
            .prepare(
              "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
            )
            .run(
              "insight",
              insight.content,
              insight.importance ?? 8,
              Date.now(),
            );
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
          "SELECT id, category, content, importance, embedding FROM facts ORDER BY importance DESC",
        )
        .all() as Array<{
        id: number;
        category: string;
        content: string;
        importance: number;
        embedding: Buffer | null;
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

      if (strategy === "embedding" && this.embedContentFn) {
        try {
          const queryVec = await this.embedContentFn(query);
          const alpha = this.jarvisConfig.memory.vectorSimilarityWeight ?? 0.7;
          const beta = this.jarvisConfig.memory.importanceWeight ?? 0.3;

          // Build id → fact map from the already-loaded memory (no second DB read)
          const factById = new Map(candidateFacts.map((f) => [f.id, f]));

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

          if (vecRows.length > 0) {
            ranked = vecRows
              .map((r) => {
                const fact = factById.get(r.id);
                if (!fact) return null; // alwaysFacts excluded from candidateFacts
                const cosineSim = Math.max(
                  0,
                  1 - (r.distance * r.distance) / 2,
                );
                const fusedScore =
                  alpha * cosineSim + beta * (fact.importance / 10);
                return {
                  category: fact.category,
                  content: fact.content,
                  score: fusedScore,
                };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null)
              .sort((a, b) => b.score - a.score)
              .slice(0, cap)
              .map(({ category, content }) => ({ category, content }));
          } else {
            // vec_facts empty — fall back to in-memory cosine using already-loaded embeddings
            ranked = candidateFacts
              .map((f) => {
                if (!f.embedding) return { ...f, score: 0 };
                const vec = Array.from(new Float32Array(f.embedding.buffer));
                const cosineSim = this.cosineSimilarity(queryVec, vec);
                const fusedScore =
                  alpha * cosineSim + beta * (f.importance / 10);
                return { ...f, score: fusedScore };
              })
              .sort((a, b) => (b as any).score - (a as any).score)
              .slice(0, cap)
              .map(({ category, content }) => ({ category, content }));
          }
        } catch (_e) {
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
      return [...alwaysOut, ...ranked];
    } catch (e) {
      return this.getStructuredFacts();
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
    // Run both steps independently — a vec_facts failure should not block L1 rebuild
    try {
      await this.backfillVecFacts();
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] Auto-backfill failed: ${e.message}`);
    }
    try {
      this.backfillPhysicalLayer();
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] Auto-backfill failed: ${e.message}`);
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

  private async syncHistoricalSessions() {
    const chatsDir = path.join(
      os.homedir(),
      ".gemini-jarvis",
      "storage",
      "chats",
    );
    if (!fs.existsSync(chatsDir)) return;

    const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith(".json"));
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
          const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const messages = content.messages || [];
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
                file.replace(".json", ""),
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
