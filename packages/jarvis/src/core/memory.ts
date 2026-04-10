/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as genai from '@google/genai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { debugLogger } from '../../../core/src/index.js';
import { ConfigManager } from './configManager.js';

export class MemoryService {
  private db: Database.Database;
  private jarvisConfig = ConfigManager.getInstance().get();
  private client: any = null;
  private queue: { sessionId: string; userPrompt: string; assistantText: string }[] = [];
  private isProcessing = false;
  private config: any;
  private lastConsolidatedCount = 0;
  private generateTextFn: ((prompt: string) => Promise<string>) | null = null;
  private embedContentFn: ((text: string) => Promise<number[]>) | null = null;

  constructor(sourceRoot: string, dbPath?: string) {
    const memoryDir = dbPath ?? path.join(os.homedir(), '.gemini-jarvis', 'memory');
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    this.db = new Database(path.join(memoryDir, 'memory.db'));
    
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
    try { this.db.exec('ALTER TABLE facts ADD COLUMN embedding BLOB'); } catch (_) {}

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
      console.error('⚠️ [MemoryService] Vector extension failed to load.', e.message);
    }
  }

  public setConfig(config: any) {
    this.config = config;
    const apiKey = this.jarvisConfig.api.key || config.apiKey || process.env.GOOGLE_API_KEY;
    if (apiKey) this.startWithApiKey(apiKey);
  }

  /** Inject a CLI-auth generateText function to replace the API-key-based client for LLM calls. */
  public setGenerateText(fn: (prompt: string) => Promise<string>) {
    this.generateTextFn = fn;
  }

  /** Inject a CLI-auth embedContent function for semantic dedup. */
  public setEmbedContent(fn: (text: string) => Promise<number[]>) {
    this.embedContentFn = fn;
  }

  public startWithApiKey(apiKey: string) {
    if (this.client) return;
    try {
      const proxy = this.jarvisConfig.api.proxy;
      // Use namespace-based access which is most reliable in this environment
      this.client = new (genai as any).GoogleGenAI({ 
        apiKey,
        httpClient: proxy ? { agent: new HttpsProxyAgent(proxy) } : undefined
      });
      debugLogger.debug('[MemoryService V2] AI Engine ready.');
      void this.syncHistoricalSessions();
      void this.processQueue();
    } catch (e) {
      debugLogger.error(`[MemoryService] Failed to init SDK: ${e.message}`);
    }
  }

  private static readonly DEDUP_JACCARD_THRESHOLD_LATIN = 0.55;
  private static readonly DEDUP_JACCARD_THRESHOLD_CJK = 0.30;
  private static readonly DEDUP_COSINE_THRESHOLD = 0.90;

  private static readonly STOP_WORDS_LATIN = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'user', 'david', 'jarvis',
    'at', 'least', 'in', 'of', 'to', 'and', 'for', 'this', 'that',
    'with', 'has', 'have', 'should', 'be', 'my', 'i', 'me', 'his', 'her',
  ]);
  private static readonly STOP_WORDS_CJK = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '都',
    '也', '很', '到', '说', '要', '去', '你', '会', '着', '看',
    '好', '自己', '这', '他', '她',
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
    lower.replace(/[^a-z0-9\u4e00-\u9fff]/g, ' ').split(/\s+/)
      .filter(w => w.length > 1 && !MemoryService.STOP_WORDS_LATIN.has(w))
      .forEach(w => tokens.add(w));
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
    return (MemoryService.hasCJK(a) || MemoryService.hasCJK(b))
      ? MemoryService.DEDUP_JACCARD_THRESHOLD_CJK
      : MemoryService.DEDUP_JACCARD_THRESHOLD_LATIN;
  }

  /** Cosine similarity between two equal-length float arrays. */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
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
    const existing = this.db.prepare('SELECT content FROM facts').all() as Array<{ content: string }>;
    for (const row of existing) {
      const sim = this.jaccardSimilarity(content, row.content);
      const threshold = this.jaccardThreshold(content, row.content);
      if (sim >= threshold) {
        console.error(`♻️ [MemoryService] Duplicate skipped: "${content}" ≈ "${row.content}" (jaccard=${sim.toFixed(2)}, threshold=${threshold})`);
        return true;
      }
    }
    return false;
  }

  /** Returns true if the content is a duplicate via embedding cosine similarity. Falls back to jaccard on error. */
  private async isDuplicateByEmbedding(content: string): Promise<boolean> {
    try {
      const newVec = await this.embedContentFn!(content);
      const existing = this.db.prepare(
        'SELECT content, embedding FROM facts WHERE embedding IS NOT NULL'
      ).all() as Array<{ content: string; embedding: Buffer }>;

      for (const row of existing) {
        const existingVec = Array.from(new Float32Array(row.embedding.buffer));
        const sim = this.cosineSimilarity(newVec, existingVec);
        if (sim >= MemoryService.DEDUP_COSINE_THRESHOLD) {
          console.error(`♻️ [MemoryService] Duplicate skipped: "${content}" ≈ "${row.content}" (cosine=${sim.toFixed(3)})`);
          return true;
        }
      }
      return false;
    } catch (_e) {
      // Embedding unavailable — fall back to jaccard
      return this.isDuplicateByJaccard(content);
    }
  }

  public async saveFact(category: string, content: string, importance: number = 5) {
    try {
      // Exact-string dedup (fast path)
      const exists = this.db.prepare('SELECT id FROM facts WHERE content = ?').get(content);
      if (exists) return;

      // Strategy-based semantic dedup
      const strategy = this.jarvisConfig.memory.dedupStrategy ?? 'jaccard';
      if (strategy === 'embedding' && this.embedContentFn) {
        if (await this.isDuplicateByEmbedding(content)) return;
        // Insert with embedding for future comparisons
        const newVec = await this.embedContentFn(content).catch(() => null);
        if (newVec) {
          this.db.prepare('INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)')
            .run(category, content, importance, Date.now(), Buffer.from(new Float32Array(newVec).buffer));
        } else {
          this.db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
            .run(category, content, importance, Date.now());
        }
      } else {
        if (this.isDuplicateByJaccard(content)) return;
        this.db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
          .run(category, content, importance, Date.now());
      }

      const count = this.db.prepare('SELECT count(*) as c FROM facts').get() as any;
      console.error(`🔥 [MemoryService] New fact distilled. Total: ${count.c}`);

      // 🧠 TRIGGER REFLECTION: Use dynamic threshold from config
      if (count.c > this.lastConsolidatedCount + this.jarvisConfig.memory.consolidationThreshold) {
        void this.consolidateFacts();
      }
    } catch (e: any) {
      console.error(`❌ [MemoryService] Fact save failed: ${e.message}`);
    }
  }

  public async consolidateFacts() {
    if (!this.generateTextFn && !this.client) return;
    if (this.isProcessing) return;
    
    this.isProcessing = true;
    console.error('\n🧠 [Jarvis Reflection] Memory saturation detected. Initiating internal synthesis...');

    try {
      const allFacts = this.db.prepare('SELECT * FROM facts ORDER BY category, importance DESC').all() as any[];
      if (allFacts.length < 5) return;

      const factsText = allFacts.map(f => `[${f.category}] (Importance: ${f.importance}) ${f.content}`).join('\n');
      
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

      let responseText = '';
      if (this.generateTextFn) {
        responseText = await this.generateTextFn(reflectionPrompt);
      } else {
        const result = await this.client.models.generateContent({
          model: this.jarvisConfig.models.distillation,
          contents: [{ role: 'user', parts: [{ text: reflectionPrompt }] }]
        });
        if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
          responseText = result.response.candidates[0].content.parts[0].text;
        } else if ((result as any).candidates?.[0]?.content?.parts?.[0]?.text) {
          responseText = (result as any).candidates[0].content.parts[0].text;
        } else if (typeof result.response?.text === 'function') {
          responseText = result.response.text();
        }
      }

      if (!responseText) {
        console.error('❌ [Jarvis Reflection] Failed to extract text from consolidation model');
        throw new Error('Empty response from reflection model');
      }
      const match = responseText.match(/\[[\s\S]*\]/);
      if (match) {
        const newFacts = JSON.parse(match[0]);
        const runUpdate = this.db.transaction(() => {
          this.db.prepare('DELETE FROM facts').run();
          for (const f of newFacts) {
            this.db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
              .run(f.category, f.content, f.importance || 5, Date.now());
          }
        });

        runUpdate();
        this.lastConsolidatedCount = newFacts.length;
        console.error(`✨ [Jarvis Reflection] Consolidation complete. Condensed ${allFacts.length} fragments into ${newFacts.length} core insights.`);
      } else {
        // LLM returned text but no valid JSON array — update the baseline to
        // prevent immediately re-triggering consolidation on the next saveFact.
        this.lastConsolidatedCount = allFacts.length;
        console.error('⚠️ [Jarvis Reflection] No valid JSON array in response. Skipping consolidation.');
      }
    } catch (e: any) {
      console.error(`⚠️ [Jarvis Reflection] Synthesis failed: ${e.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  public enqueue(sessionId: string, userPrompt: string, assistantText: string) {
    this.queue.push({ sessionId, userPrompt, assistantText });
  }

  private async processQueue() {
    if (this.isProcessing) return;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        this.isProcessing = true;
        await this.ingestMemory(item.sessionId, item.userPrompt, item.assistantText);
        this.isProcessing = false;
      }
      await new Promise(r => setTimeout(r, this.jarvisConfig.memory.ingestionDelayMs));
    }
    setTimeout(() => this.processQueue(), 2000);
  }

  private async ingestMemory(sessionId: string, userPrompt: string, assistantText: string) {
    if (!this.embedContentFn && !this.client) return;
    try {
      const text = `User: ${userPrompt}\nAssistant: ${assistantText}`;
      let vecValues: number[];
      if (this.embedContentFn) {
        vecValues = await this.embedContentFn(text);
      } else {
        const result = await this.client.models.embedContent({
          model: this.jarvisConfig.models.embedding,
          content: { role: 'user', parts: [{ text }] }
        });
        const embeddings = result.embeddings || [result.embedding];
        vecValues = embeddings[0].values;
      }
      const info = this.db.prepare('INSERT INTO memories (sessionId, text, timestamp) VALUES (?, ?, ?)').run(sessionId, text, Date.now());
      try {
        this.db.prepare('INSERT INTO vec_memories (id, embedding) VALUES (?, ?)').run(info.lastInsertRowid, new Float32Array(vecValues));
      } catch (_vecErr) {}
    } catch (e) {}
  }

  public async search(query: string, limit: number = 5): Promise<string[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.models.embedContent({
        model: this.jarvisConfig.models.embedding,
        content: { role: 'user', parts: [{ text: query }] }
      });
      const embeddings = result.embeddings || [result.embedding];
      const results = this.db.prepare(`
        SELECT m.text FROM memories m JOIN vec_memories v ON m.id = v.id
        WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?
      `).all(new Float32Array(embeddings[0].values), limit || this.jarvisConfig.memory.retrievalLimit) as any[];
      return results.map(r => r.text);
    } catch (e) { return []; }
  }

  public getCoreFacts(): string[] {
    try {
      const results = this.db.prepare('SELECT category, content FROM facts ORDER BY importance DESC').all() as any[];
      return results.map(f => `[${f.category}] ${f.content}`);
    } catch (e) { return []; }
  }

  public getStructuredFacts(): Array<{ category: string; content: string }> {
    try {
      return this.db.prepare('SELECT category, content FROM facts ORDER BY importance DESC').all() as any[];
    } catch (e) { return []; }
  }

  /**
   * Reflects on accumulated facts to generate higher-order insights.
   * Insights are saved to the facts table with category='insight' and high importance.
   * Does nothing if there are no facts to reflect on.
   */
  public async reflect(generateText: (prompt: string) => Promise<string>): Promise<void> {
    try {
      const allFacts = this.db.prepare(
        "SELECT category, content, importance FROM facts WHERE category != 'insight' ORDER BY importance DESC"
      ).all() as Array<{ category: string; content: string; importance: number }>;

      if (allFacts.length === 0) return;

      const factsText = allFacts
        .map(f => `[${f.category.toUpperCase()}] ${f.content}`)
        .join('\n');

      const prompt = `
You are Jarvis's Cognitive Reflection Module. Analyze the following accumulated knowledge about the user and generate high-value insights.

Current knowledge:
${factsText}

Task: Generate 2-5 meta-level insights by finding patterns, connections, and implications across these facts.
Focus on:
- Patterns that connect multiple facts (e.g., how identity + behavior + decisions relate)
- Gaps or contradictions worth noting
- High-level observations that could improve future assistance

Rules:
- Each insight must synthesize MULTIPLE facts, not just restate one
- Insights should be actionable or meaningful for future interactions
- Be specific, not generic

Respond ONLY with a JSON array:
[{"category": "insight", "content": "...", "importance": 1-10}]
`.trim();

      const raw = await generateText(prompt);
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return;

      const insights = JSON.parse(match[0]) as Array<{ category: string; content: string; importance: number }>;
      for (const insight of insights) {
        if (insight.category === 'insight' && insight.content) {
          // Check for duplicates before saving
          const exists = this.db.prepare('SELECT id FROM facts WHERE content = ?').get(insight.content);
          if (!exists) {
            this.db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
              .run('insight', insight.content, insight.importance ?? 8, Date.now());
            console.error(`💡 [MemoryService] Insight saved: ${insight.content.slice(0, 60)}...`);
          }
        }
      }
    } catch (e: any) {
      console.error(`⚠️ [MemoryService] Reflection failed: ${e.message}`);
    }
  }

  private static readonly ALWAYS_INJECT_CATEGORIES = new Set(['preference']);

  /**
   * Returns facts relevant to the given query.
   * Only preference facts are always included (response style instructions needed every turn).
   * All other facts (identity, behavior, specification) are ranked by relevance and capped at factRelevanceLimit.
   */
  public async searchFacts(query: string, limit?: number): Promise<Array<{ category: string; content: string }>> {
    try {
      const allFacts = this.db.prepare('SELECT category, content, importance, embedding FROM facts ORDER BY importance DESC').all() as Array<{ category: string; content: string; importance: number; embedding: Buffer | null }>;

      const alwaysFacts = allFacts.filter(f => MemoryService.ALWAYS_INJECT_CATEGORIES.has(f.category));
      const candidateFacts = allFacts.filter(f => !MemoryService.ALWAYS_INJECT_CATEGORIES.has(f.category));

      const cap = limit ?? this.jarvisConfig.memory.factRelevanceLimit ?? 5;
      const strategy = this.jarvisConfig.memory.factRelevanceStrategy ?? 'jaccard';

      let ranked: Array<{ category: string; content: string }>;

      if (strategy === 'embedding' && this.embedContentFn) {
        try {
          const queryVec = await this.embedContentFn(query);
          ranked = candidateFacts
            .map(f => {
              if (!f.embedding) return { ...f, score: 0 };
              const vec = Array.from(new Float32Array(f.embedding.buffer));
              return { ...f, score: this.cosineSimilarity(queryVec, vec) };
            })
            .sort((a, b) => (b as any).score - (a as any).score)
            .slice(0, cap)
            .map(({ category, content }) => ({ category, content }));
        } catch (_e) {
          // fallback to jaccard
          ranked = this.rankByJaccard(query, candidateFacts, cap);
        }
      } else {
        ranked = this.rankByJaccard(query, candidateFacts, cap);
      }

      return [...alwaysFacts.map(({ category, content }) => ({ category, content })), ...ranked];
    } catch (e) {
      return this.getStructuredFacts();
    }
  }

  private rankByJaccard(query: string, facts: Array<{ category: string; content: string }>, limit: number): Array<{ category: string; content: string }> {
    return facts
      .map(f => ({ ...f, score: this.jaccardSimilarity(query, f.content) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ category, content }) => ({ category, content }));
  }

  /**
   * Sends a prompt to the distillation model and returns the full text response.
   * Used by BackgroundDistiller to avoid coupling it to GeminiClient.
   */
  public async generateText(prompt: string): Promise<string> {
    if (!this.client) throw new Error('[MemoryService] AI client not initialized');
    const result = await this.client.models.generateContent({
      model: this.jarvisConfig.models.distillation,
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
      return result.response.candidates[0].content.parts[0].text;
    } else if ((result as any).candidates?.[0]?.content?.parts?.[0]?.text) {
      return (result as any).candidates[0].content.parts[0].text;
    } else if (typeof result.response?.text === 'function') {
      return result.response.text();
    }
    throw new Error('[MemoryService] Empty response from model');
  }

  private async syncHistoricalSessions() {
    const chatsDir = path.join(os.homedir(), '.gemini-jarvis', 'storage', 'chats');
    if (!fs.existsSync(chatsDir)) return;

    const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(chatsDir, file);
      const stats = fs.statSync(filePath);
      const processed = this.db.prepare('SELECT last_mtime FROM processed_files WHERE filename = ?').get(file) as any;

      if (!processed || processed.last_mtime < stats.mtimeMs) {
        debugLogger.debug(`[MemoryService] Syncing historical session: ${file}`);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const messages = content.messages || [];
          for (let i = 0; i < messages.length; i += 2) {
            const userMsg = messages[i];
            const assistantMsg = messages[i+1];
            if (userMsg && assistantMsg && userMsg.type === 'user' && assistantMsg.type === 'gemini') {
              this.enqueue(file.replace('.json', ''), userMsg.content, assistantMsg.content);
            }
          }
          this.db.prepare('INSERT OR REPLACE INTO processed_files (filename, last_mtime) VALUES (?, ?)').run(file, stats.mtimeMs);
        } catch (e) {}
      }
    }
  }
}
