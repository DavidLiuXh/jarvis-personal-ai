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
const EMBEDDING_DIMENSION = 3072;

export class MemoryService {
  private db: Database.Database;
  private queue: Array<{ sessionId: string; text: string }> = [];
  private isProcessing = false;
  private genAI?: GoogleGenerativeAI;
  private config?: Config;

  constructor() {
    const memoryDir = path.join(JARVIS_ROOT, 'memory');
    const dbPath = path.join(memoryDir, 'memory.db');

    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

    this.db = new Database(dbPath);
    
    // 1. First, init normal tables
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

    // 2. Then, attempt to load vector extension and virtual table
    try {
      sqliteVec.load(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          id INTEGER PRIMARY KEY,
          embedding FLOAT[${EMBEDDING_DIMENSION}]
        );
      `);
      debugLogger.debug('[MemoryService V2] Vector support enabled.');
    } catch (e: any) {
      console.error('⚠️ [MemoryService] Vector extension failed to load. Running in text-only mode.', e.message);
    }
  }

  public setConfig(config: Config) {
    this.config = config;
    const apiKey = (config as any).apiKey || process.env.GOOGLE_API_KEY;
    if (apiKey) this.startWithApiKey(apiKey);
  }

  public startWithApiKey(apiKey: string) {
    if (this.genAI) return;
    try {
      this.genAI = new GoogleGenerativeAI(apiKey);
      debugLogger.debug('[MemoryService V2] AI Engine ready.');
      void this.syncHistoricalSessions();
      void this.processQueue();
    } catch (e) {}
  }

  public saveFact(category: string, content: string, importance: number = 5) {
    try {
      const exists = this.db.prepare('SELECT id FROM facts WHERE content = ?').get(content);
      if (exists) return;

      this.db.prepare('INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)')
        .run(category, content, importance, Date.now());
      
      const check = this.db.prepare('SELECT count(*) as c FROM facts').get() as any;
      console.log(`🔥 [MemoryService] FACT PHYSICALLY STORED. CURRENT COUNT: ${check.c}`);
    } catch (e: any) {
      console.error(`❌ [MemoryService] Fact save failed: ${e.message}`);
    }
  }

  public runRegexFallback(userText: string) {
    const identityRegex = /(?:I am|my name is|call me|我是|我叫|称呼我为)\s*([^.!?\n,，。]+)/i;
    const prefRegex = /(?:I love|I hate|I prefer|remember that|my favorite|我喜欢|我讨厌|我更倾向于|记得)\s*([^.!?\n,，。]+)/i;

    const idMatch = userText.match(identityRegex);
    if (idMatch) this.saveFact('identity', idMatch[1].trim(), 10);

    const prefMatch = userText.match(prefRegex);
    if (prefMatch) this.saveFact('preference', prefMatch[1].trim(), 8);
  }

  public getCoreFacts(): string[] {
    try {
      const rows = this.db.prepare('SELECT category, content FROM facts ORDER BY importance DESC').all() as any[];
      return rows.map(r => `[${r.category}] ${r.content}`);
    } catch (e) { return []; }
  }

  private async syncHistoricalSessions() {
    if (!this.genAI) return;
    try {
      const roots = [];
      if (this.config?.storage) roots.push(path.join(this.config.storage.getProjectTempDir(), 'chats'));
      roots.push(path.join(JARVIS_ROOT, 'storage', 'chats'));
      
      for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        const output = execSync(`find "${root}" -name "session-*.json" 2>/dev/null`).toString();
        const files = output.split('\n').filter(f => f.trim());
        for (const filePath of files) {
          try {
            const stats = fs.statSync(filePath);
            const row = this.db.prepare('SELECT last_mtime FROM processed_files WHERE filename = ?').get(filePath) as any;
            if (row && row.last_mtime >= stats.mtimeMs) continue;

            const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ConversationRecord;
            for (const msg of record.messages) {
              const text = Array.isArray(msg.content) ? msg.content.map((p: any) => p.text || '').join('') : String(msg.content);
              if (text.length > 50) {
                await this.saveChunk(record.sessionId || 'legacy', text);
                await new Promise(r => setTimeout(r, INGESTION_DELAY_MS));
              }
            }
            this.db.prepare('INSERT OR REPLACE INTO processed_files (filename, last_mtime) VALUES (?, ?)').run(filePath, stats.mtimeMs);
          } catch (e) {}
        }
      }
    } catch (err) {}
  }

  public enqueue(sessionId: string, userText: string, assistantText: string) {
    const cleanText = userText.replace(/<session_context>[\s\S]*?<\/session_context>/g, '').trim();
    this.runRegexFallback(cleanText);

    this.queue.push({ sessionId, text: `User: ${userText}\nAssistant: ${assistantText}` });
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
    } finally { this.isProcessing = false; }
  }

  private async saveChunk(sessionId: string, text: string): Promise<boolean> {
    if (!this.genAI) return false;
    try {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      const model = this.genAI.getGenerativeModel({ model: FIXED_EMBEDDING_MODEL }, proxy ? { agent: new HttpsProxyAgent(proxy) } : {});
      const result = await model.embedContent(text);
      
      const info = this.db.prepare('INSERT INTO memories (sessionId, text, timestamp) VALUES (?, ?, ?)').run(sessionId, text, Date.now());
      
      // Separate vector write to prevent total failure
      try {
        this.db.prepare('INSERT INTO vec_memories (id, embedding) VALUES (?, ?)').run(info.lastInsertRowid, new Float32Array(result.embedding.values));
      } catch (vecErr) {}
      
      return true;
    } catch (e) { return false; }
  }

  public async search(query: string, limit: number = 5): Promise<string[]> {
    if (!this.genAI) return [];
    try {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      const model = this.genAI.getGenerativeModel({ model: FIXED_EMBEDDING_MODEL }, proxy ? { agent: new HttpsProxyAgent(proxy) } : {});
      const result = await model.embedContent(query);
      const results = this.db.prepare(`
        SELECT m.text FROM memories m JOIN vec_memories v ON m.id = v.id
        WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?
      `).all(new Float32Array(result.embedding.values), limit) as any[];
      return results.map(r => r.text);
    } catch (e) { return []; }
  }
}
