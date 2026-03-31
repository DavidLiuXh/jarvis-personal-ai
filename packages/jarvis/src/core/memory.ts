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

  constructor(sourceRoot: string) {
    const memoryDir = path.join(os.homedir(), '.gemini-jarvis', 'memory');
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
        timestamp INTEGER
      );
      CREATE TABLE IF NOT EXISTS processed_files (
        filename TEXT PRIMARY KEY,
        last_mtime INTEGER
      );
    `);

    try {
      sqliteVec.load(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
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

  public async saveFact(category: string, content: string, importance: number = 5) {
    try {
      const exists = this.db.prepare('SELECT id FROM facts WHERE content = ?').get(content);
      if (exists) return;

      this.db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
        .run(category, content, importance, Date.now());
      
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
    if (!this.client || this.isProcessing) return;
    
    this.isProcessing = true;
    console.error('\n🧠 [Jarvis Reflection] Memory saturation detected. Initiating internal synthesis...');

    try {
      const allFacts = this.db.prepare('SELECT * FROM facts ORDER BY category, importance DESC').all() as any[];
      if (allFacts.length < 5) return;

      const factsText = allFacts.map(f => `[${f.category}] (Importance: ${f.importance}) ${f.content}`).join('\n');
      
      const reflectionPrompt = `
You are the Cognitive Maintenance Module of JARVIS.
Objective: Perform semantic deduplication and hierarchical consolidation.
Respond ONLY with a JSON array: [{"category": "...", "content": "...", "importance": 1-10}]

Input Facts:
${factsText}
`;

      const result = await this.client.models.generateContent({
        model: this.jarvisConfig.models.distillation,
        contents: [{ role: 'user', parts: [{ text: reflectionPrompt }] }]
      });
      
      // DEBUG: Identify the actual response structure
      // console.error('[DEBUG] Reflection Raw Result:', JSON.stringify(result, null, 2));

      let responseText = '';
      if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
        responseText = result.response.candidates[0].content.parts[0].text;
      } else if ((result as any).candidates?.[0]?.content?.parts?.[0]?.text) {
        responseText = (result as any).candidates[0].content.parts[0].text;
      } else if (typeof result.response?.text === 'function') {
        responseText = result.response.text();
      }

      if (!responseText) {
        console.error('❌ [Jarvis Reflection] Failed to extract text. Structure:', Object.keys(result));
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
    if (!this.client) return;
    try {
      const text = `User: ${userPrompt}\nAssistant: ${assistantText}`;
      const result = await this.client.models.embedContent({
        model: this.jarvisConfig.models.embedding,
        content: { role: 'user', parts: [{ text }] }
      });
      
      const info = this.db.prepare('INSERT INTO memories (sessionId, text, timestamp) VALUES (?, ?, ?)').run(sessionId, text, Date.now());
      try {
        const embeddings = result.embeddings || [result.embedding];
        this.db.prepare('INSERT INTO vec_memories (id, embedding) VALUES (?, ?)').run(info.lastInsertRowid, new Float32Array(embeddings[0].values));
      } catch (vecErr) {}
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
