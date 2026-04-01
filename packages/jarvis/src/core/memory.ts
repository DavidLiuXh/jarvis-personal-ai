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

  private static readonly DEDUP_SIMILARITY_THRESHOLD = 0.85;

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

  public async saveFact(category: string, content: string, importance: number = 5) {
    try {
      // Exact-string dedup (fast path)
      const exists = this.db.prepare('SELECT id FROM facts WHERE content = ?').get(content);
      if (exists) return;

      // Semantic dedup via embedding + in-memory cosine similarity
      if (this.embedContentFn || this.client) {
        try {
          let newVec: number[];
          if (this.embedContentFn) {
            newVec = await this.embedContentFn(content);
          } else {
            const result = await this.client.models.embedContent({
              model: this.jarvisConfig.models.embedding,
              content: { role: 'user', parts: [{ text: content }] },
            });
            const embeddings = result.embeddings || [result.embedding];
            newVec = embeddings[0].values;
          }

          // Compare against all existing fact embeddings stored in the facts table
          const existingFacts = this.db.prepare(
            'SELECT id, content, embedding FROM facts WHERE embedding IS NOT NULL'
          ).all() as Array<{ id: number; content: string; embedding: Buffer }>;

          for (const row of existingFacts) {
            const existingVec = Array.from(new Float32Array(row.embedding.buffer));
            const sim = this.cosineSimilarity(newVec, existingVec);
            if (sim >= MemoryService.DEDUP_SIMILARITY_THRESHOLD) {
              console.error(`♻️ [MemoryService] Semantic duplicate skipped: "${content}" ≈ "${row.content}" (sim=${sim.toFixed(3)})`);
              return;
            }
          }

          // Insert fact with embedding
          this.db.prepare(
            'INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)'
          ).run(category, content, importance, Date.now(), Buffer.from(new Float32Array(newVec).buffer));
        } catch (_embedErr) {
          // Embedding unavailable — fall back to exact-only dedup
          this.db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
            .run(category, content, importance, Date.now());
        }
      } else {
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
- identity: static facts about who the user IS — name, job title, profession
- behavior: user's habits, lifestyle, routines, recurring patterns in how they live or work
- preference: ONLY how the user wants Jarvis to respond — output format, tone, language, length
- specification: technical decisions, project constraints, system rules

Rules:
1. Merge facts that express the same information (even if worded differently or in different languages).
2. Fix any miscategorized facts using the definitions above.
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
