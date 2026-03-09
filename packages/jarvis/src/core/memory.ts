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
import { GoogleGenerativeAI } from '@google/generative-ai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { debugLogger, type Config, type ConversationRecord } from '../../../core/src/index.js';

const INGESTION_DELAY_MS = 800; 
const JARVIS_ROOT = path.join(os.homedir(), '.gemini-jarvis');
const FIXED_EMBEDDING_MODEL = 'models/gemini-embedding-001';
const EMBEDDING_DIMENSION = 3072; // Matched to gemini-embedding-001 output

export class MemoryService {
  private db: Database.Database;
  private queue: Array<{ sessionId: string; text: string }> = [];
  private isProcessing = false;
  private genAI?: GoogleGenerativeAI;
  private config?: Config;

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
        embedding FLOAT[${EMBEDDING_DIMENSION}]
      );
      CREATE TABLE IF NOT EXISTS processed_files (
        filename TEXT PRIMARY KEY,
        last_mtime INTEGER
      );
    `);
    debugLogger.debug(`[MemoryService V2] Database initialized with ${EMBEDDING_DIMENSION} dims.`);
  }

  public setConfig(config: Config) {
    this.config = config;
    const apiKey = (config as any).apiKey || process.env.GOOGLE_API_KEY;
    if (apiKey) {
      this.startWithApiKey(apiKey);
    }
  }

  public startWithApiKey(apiKey: string) {
    if (this.genAI) return;
    try {
      this.genAI = new GoogleGenerativeAI(apiKey);
      debugLogger.debug('[MemoryService V2] AI Engine online (Stable SDK).');
      void this.syncHistoricalSessions();
      void this.processQueue();
    } catch (e) {
      debugLogger.error('[MemoryService V2] Failed to init Stable SDK', e);
    }
  }

  private async syncHistoricalSessions() {
    if (!this.genAI) return;
    try {
      const searchRoots: string[] = [];
      if (this.config?.storage) {
        searchRoots.push(path.join(this.config.storage.getProjectTempDir(), 'chats'));
      }
      searchRoots.push(path.join(JARVIS_ROOT, 'storage', 'chats'));
      
      const sessionFiles: string[] = [];
      for (const root of searchRoots) {
        if (fs.existsSync(root)) {
          const output = execSync(`find "${root}" -name "session-*.json" 2>/dev/null`).toString();
          sessionFiles.push(...output.split('\n').filter(f => f.trim().length > 0));
        }
      }

      console.log(`[MemoryService V2] SCANNING ${sessionFiles.length} SESSIONS...`);

      for (const filePath of sessionFiles) {
        try {
          const stats = fs.statSync(filePath);
          const trackingKey = filePath.replace(os.homedir(), '~');
          const row = this.db.prepare('SELECT last_mtime FROM processed_files WHERE filename = ?').get(trackingKey) as any;
          if (row && row.last_mtime >= stats.mtimeMs) continue;

          console.log(`[MemoryService V2] Indexing: ${path.basename(filePath)}`);
          const content = fs.readFileSync(filePath, 'utf8');
          const record = JSON.parse(content) as ConversationRecord;
          
          let chunksIndexed = 0;
          for (const msg of record.messages) {
            if (msg.type === 'user' || msg.type === 'gemini') {
              const text = Array.isArray(msg.content) ? msg.content.map((p: any) => p.text || '').join('') : String(msg.content);
              if (text.length > 50) {
                const success = await this.saveChunk(record.sessionId || 'legacy', text);
                if (success) chunksIndexed++;
                await new Promise(r => setTimeout(r, INGESTION_DELAY_MS));
              }
            }
          }
          this.db.prepare('INSERT OR REPLACE INTO processed_files (filename, last_mtime) VALUES (?, ?)').run(trackingKey, stats.mtimeMs);
        } catch (e) {}
      }
      const finalCount = this.db.prepare('SELECT count(*) as c FROM memories').get() as any;
      console.log(`[MemoryService V2] FINAL TOTAL: ${finalCount.c} records.`);
    } catch (err) {
      console.error('[MemoryService V2] Sync failed', err);
    }
  }

  public enqueue(sessionId: string, userText: string, assistantText: string) {
    const combined = userText ? `User: ${userText}\nAssistant: ${assistantText}` : assistantText;
    this.queue.push({ sessionId, text: combined });
    void this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0 || !this.genAI) return;
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

  private async saveChunk(sessionId: string, text: string): Promise<boolean> {
    if (!this.genAI) return false;
    
    try {
      console.log(`[MemoryService V2] Embedding via ${FIXED_EMBEDDING_MODEL}...`);
      
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      let requestOptions = {};
      if (proxy) {
        // @ts-ignore
        requestOptions = { agent: new HttpsProxyAgent(proxy) };
      }

      const model = this.genAI.getGenerativeModel({ model: FIXED_EMBEDDING_MODEL }, requestOptions);
      const result = await model.embedContent(text);
      const vector = result.embedding.values;

      const info = this.db.prepare('INSERT INTO memories (sessionId, text, timestamp) VALUES (?, ?, ?)').run(sessionId, text, Date.now());
      this.db.prepare('INSERT INTO vec_memories (id, embedding) VALUES (last_insert_rowid(), ?)').run(new Float32Array(vector));
      
      console.log(`[MemoryService V2] SUCCESS! ID: ${info.lastInsertRowid}`);
      return true;
    } catch (err: any) {
      console.error(`[MemoryService V2] EMBEDDING FAILED: ${err.message}`);
      return false;
    }
  }

  public async search(query: string, limit: number = 5): Promise<string[]> {
    if (!this.genAI) return [];
    try {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      let requestOptions = {};
      if (proxy) {
        // @ts-ignore
        requestOptions = { agent: new HttpsProxyAgent(proxy) };
      }

      const model = this.genAI.getGenerativeModel({ model: FIXED_EMBEDDING_MODEL }, requestOptions);
      const result = await model.embedContent(query);
      const vector = result.embedding.values;

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
