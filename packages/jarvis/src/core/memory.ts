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
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { debugLogger, type Config, type ConversationRecord } from '../../../core/src/index.js';

const require = createRequire(import.meta.url);
const { GoogleGenAI } = require('@google/genai');

const INGESTION_DELAY_MS = 800; 
const EMBEDDING_MODEL = 'text-embedding-004';
const JARVIS_ROOT = path.join(os.homedir(), '.gemini-jarvis');

export class MemoryService {
  private db: Database.Database;
  private queue: Array<{ sessionId: string; text: string }> = [];
  private isProcessing = false;
  private client?: any;

  constructor() {
    const memoryDir = path.join(JARVIS_ROOT, 'memory');
    const dbPath = path.join(memoryDir, 'memory.db');

    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT,
        text TEXT,
        timestamp INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        id INTEGER PRIMARY KEY,
        embedding FLOAT[768]
      );
      CREATE TABLE IF NOT EXISTS processed_files (
        filename TEXT PRIMARY KEY,
        last_mtime INTEGER
      );
    `);
    debugLogger.debug('[MemoryService V2] Database ready.');
  }

  /**
   * Legacy compatibility method to set config and start AI client.
   */
  public setConfig(config: Config) {
    const apiKey = (config as any).apiKey || process.env.GOOGLE_API_KEY;
    if (apiKey) {
      this.startWithApiKey(apiKey);
    }
  }

  /**
   * Initializes the AI client with optional proxy support.
   */
  public startWithApiKey(apiKey: string) {
    if (this.client) return;

    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    let fetchOptions = {};
    
    if (proxy) {
      debugLogger.debug(`[MemoryService V2] Using proxy: ${proxy}`);
      const agent = new HttpsProxyAgent(proxy);
      // @ts-ignore - SDK internal support
      fetchOptions = { agent };
    }

    this.client = new GoogleGenAI({ 
      apiKey,
      // @ts-ignore - SDK internal support
      httpClient: fetchOptions 
    });

    debugLogger.debug('[MemoryService V2] AI Engine online.');
    void this.syncHistoricalSessions();
    void this.processQueue();
  }

  private async syncHistoricalSessions() {
    if (!this.client) return;

    try {
      const searchRoot = path.join(JARVIS_ROOT, 'storage', 'chats');
      if (!fs.existsSync(searchRoot)) return;

      const output = execSync(`find "${searchRoot}" -name "session-*.json" 2>/dev/null`).toString();
      const sessionFiles = output.split('\n').filter(f => f.trim().length > 0);

      debugLogger.debug(`[MemoryService V2] Found ${sessionFiles.length} internal sessions.`);

      for (const filePath of sessionFiles) {
        try {
          const stats = fs.statSync(filePath);
          const trackingKey = filePath.replace(os.homedir(), '~');
          
          const row = this.db.prepare('SELECT last_mtime FROM processed_files WHERE filename = ?').get(trackingKey) as any;
          if (row && row.last_mtime >= stats.mtimeMs) continue;

          debugLogger.debug(`[MemoryService V2] Backfilling: ${path.basename(filePath)}`);
          const content = fs.readFileSync(filePath, 'utf8');
          const record = JSON.parse(content) as ConversationRecord;
          
          for (const msg of record.messages) {
            if (msg.type === 'user' || msg.type === 'gemini') {
              const text = Array.isArray(msg.content) ? msg.content.map((p: any) => p.text || '').join('') : String(msg.content);
              if (text.length > 50) {
                await this.saveChunk(record.sessionId || 'legacy', text);
                await new Promise(r => setTimeout(r, INGESTION_DELAY_MS));
              }
            }
          }
          this.db.prepare('INSERT OR REPLACE INTO processed_files (filename, last_mtime) VALUES (?, ?)').run(trackingKey, stats.mtimeMs);
        } catch (e) {}
      }
      const finalCount = this.db.prepare('SELECT count(*) as c FROM memories').get() as any;
      debugLogger.debug(`[MemoryService V2] Sync complete. Records: ${finalCount.c}`);
    } catch (err) {
      debugLogger.error('[MemoryService V2] Global sync failure', err);
    }
  }

  public enqueue(sessionId: string, userText: string, assistantText: string) {
    const combined = userText ? `User: ${userText}\nAssistant: ${assistantText}` : assistantText;
    this.queue.push({ sessionId, text: combined });
    void this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0 || !this.client) return;
    this.isProcessing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (item) {
          await this.saveChunk(item.sessionId, item.text);
          await new Promise(r => setTimeout(r, INGESTION_DELAY_MS));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async saveChunk(sessionId: string, text: string) {
    if (!this.client) return;
    try {
      const result = await this.client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: [{ parts: [{ text }] }]
      });
      const vector = result.embeddings[0].values;

      const info = this.db.prepare('INSERT INTO memories (sessionId, text, timestamp) VALUES (?, ?, ?)').run(sessionId, text, Date.now());
      this.db.prepare('INSERT INTO vec_memories (id, embedding) VALUES (last_insert_rowid(), ?)').run(new Float32Array(vector));
    } catch (err: any) {
      debugLogger.error(`[MemoryService V2] Embedding failed: ${err.message}`);
    }
  }

  public async search(query: string, limit: number = 5): Promise<string[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: [{ parts: [{ text: query }] }]
      });
      const vector = result.embeddings[0].values;

      const results = this.db.prepare(`
        SELECT m.text FROM memories m
        JOIN vec_memories v ON m.id = v.id
        WHERE v.embedding MATCH ?
        ORDER BY v.distance LIMIT ?
      `).all(new Float32Array(vector), limit) as any[];
      return results.map(r => r.text);
    } catch (e) {
      return [];
    }
  }
}
