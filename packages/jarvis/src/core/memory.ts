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
import { debugLogger, type Config, type ConversationRecord } from '../../../core/src/index.js';

const require = createRequire(import.meta.url);
const { GoogleGenAI } = require('@google/genai');

const INGESTION_DELAY_MS = 500;
const EMBEDDING_MODEL = 'text-embedding-004';

export class MemoryService {
  private db: Database.Database;
  private queue: Array<{ sessionId: string; text: string }> = [];
  private isProcessing = false;
  private config?: Config;
  private client?: any;

  constructor() {
    const memoryDir = path.join(os.homedir(), '.gemini', 'jarvis');
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
  }

  public startWithApiKey(apiKey: string) {
    if (apiKey && !this.client) {
      this.client = new GoogleGenAI({ apiKey });
      debugLogger.debug('[MemoryService] AI client ready (New SDK).');
      void this.syncHistoricalSessions();
      void this.processQueue();
    }
  }

  public setConfig(config: Config) {
    this.config = config;
    const apiKey = (config as any).apiKey || process.env.GOOGLE_API_KEY;
    if (apiKey && !this.client) {
      this.startWithApiKey(apiKey);
    }
  }

  /**
   * SYSTEM-POWERED SYNC: Uses native 'find' command for bulletproof session discovery.
   */
  private async syncHistoricalSessions() {
    if (!this.client) return;

    try {
      const home = os.homedir();
      const cmd = `find "${home}/.gemini" -name "session-*.json" 2>/dev/null`;
      const output = execSync(cmd).toString();
      const allSessionFiles = output.split('\n').filter(f => f.trim().length > 0);

      console.log(`[MemoryService] DISCOVERED ${allSessionFiles.length} HISTORICAL SESSIONS.`);

      for (const filePath of allSessionFiles) {
        try {
          const stats = fs.statSync(filePath);
          const trackingKey = filePath.replace(home, '~');
          
          const row = this.db.prepare('SELECT last_mtime FROM processed_files WHERE filename = ?').get(trackingKey) as any;
          if (row && row.last_mtime >= stats.mtimeMs) continue;

          console.log(`[MemoryService] Indexing: ${path.basename(filePath)}`);
          const content = fs.readFileSync(filePath, 'utf8');
          const record = JSON.parse(content) as ConversationRecord;
          
          for (const msg of record.messages) {
            if (msg.type === 'user' || msg.type === 'gemini') {
              const text = Array.isArray(msg.content) ? msg.content.map((p: any) => p.text || '').join('') : String(msg.content);
              if (text.length > 50) {
                await this.saveChunk(record.sessionId || 'imported', text);
                await new Promise(r => setTimeout(r, INGESTION_DELAY_MS));
              }
            }
          }
          this.db.prepare('INSERT OR REPLACE INTO processed_files (filename, last_mtime) VALUES (?, ?)').run(trackingKey, stats.mtimeMs);
        } catch (e) {
          console.error(`[MemoryService] Skipped ${filePath} due to error.`);
        }
      }
      const finalCount = this.db.prepare('SELECT count(*) as c FROM memories').get() as any;
      console.log(`[MemoryService] SYNC COMPLETE. Records in DB: ${finalCount.c}`);
    } catch (err) {
      console.error('[MemoryService] Sync failed:', err);
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
      // NEW SDK SYNTAX
      const result = await this.client.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: [{ parts: [{ text }] }]
      });
      
      const vector = result.embeddings[0].values;

      const info = this.db.prepare('INSERT INTO memories (sessionId, text, timestamp) VALUES (?, ?, ?)').run(sessionId, text, Date.now());
      this.db.prepare('INSERT INTO vec_memories (id, embedding) VALUES (last_insert_rowid(), ?)').run(new Float32Array(vector));
      debugLogger.debug(`[MemoryService] Indexed ${vector.length}d chunk.`);
    } catch (err: any) {
      const cause = err.cause ? ` | Cause: ${err.cause.message || err.cause}` : '';
      const status = err.status || (err.response ? err.response.status : '');
      console.error(`[MemoryService] API Save Error: ${err.message}${status ? ' (Status: ' + status + ')' : ''}${cause}`);
    }
  }

  public async search(query: string, limit: number = 5): Promise<string[]> {
    if (!this.client) return [];
    try {
      // NEW SDK SYNTAX
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
