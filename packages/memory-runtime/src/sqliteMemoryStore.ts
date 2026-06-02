/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { EmbeddingClient } from "./adapters.js";
import { lexicalSimilarity } from "./governance.js";
import type {
  EntryMemorySearchResult,
  EntryMemoryStore,
  FactMemorySearchResult,
  FactMemoryStore,
  SessionMemorySearchResult,
  SessionMemoryStore,
} from "./retrieval.js";
import type { MemoryWriteStore } from "./store.js";
import type {
  ConversationTurn,
  EntryMemory,
  FactMemory,
  MemoryContract,
  MemoryItem,
  SessionMemory,
  TopicState,
} from "./types.js";

export type SqliteMemoryStoreOptions = {
  dbPath: string;
  embedding?: EmbeddingClient;
  vectorDimension?: number;
  enableVectors?: boolean;
  now?: () => Date;
};

type FactRow = {
  id: number;
  category: string;
  content: string;
  importance: number;
  timestamp: number | null;
  embedding: Buffer | null;
  last_accessed: number | null;
  access_count: number | null;
};

type EntryRow = {
  id: number;
  sessionId: string | null;
  text: string;
  timestamp: number | null;
  source: string | null;
};

type SummaryChunkRow = {
  id: number;
  session_id: string;
  chunk_text: string;
  distance?: number;
};

function factSubjectToCategory(subject: FactMemory["subject"]): string {
  if (subject === "user") return "identity";
  if (subject === "preference") return "interaction_style";
  if (subject === "project") return "specification";
  if (subject === "relationship") return "relationship";
  return "behavior";
}

function factCategoryToSubject(category: string): FactMemory["subject"] {
  if (category === "identity") return "user";
  if (category === "interaction_style" || category === "preference") {
    return "preference";
  }
  if (category === "specification" || category === "artifact") {
    return "project";
  }
  if (category === "relationship") return "relationship";
  return "profile";
}

function entryKindToSource(kind: EntryMemory["kind"]): string {
  return kind;
}

function sourceToEntryKind(source: string | null): EntryMemory["kind"] {
  if (source === "task") return "task";
  if (source === "decision") return "decision";
  if (source === "event") return "event";
  if (source === "reflection") return "reflection";
  return "conversation";
}

function timestampMs(value?: string | number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function iso(value: number | null | undefined): string {
  return new Date(value ?? Date.now()).toISOString();
}

function memoryTextOfSession(session: SessionMemory): string {
  return [session.summary ?? "", ...session.turns.map((turn) => turn.content)]
    .join("\n")
    .trim();
}

function embeddingTextForFact(fact: FactMemory): string {
  const category =
    typeof fact.metadata?.category === "string"
      ? fact.metadata.category
      : factSubjectToCategory(fact.subject);
  const prefixes: Record<string, string> = {
    identity: "PRIVATE_USER_DATA: Identity - ",
    behavior: "PRIVATE_USER_DATA: Habit/Behavior - ",
    artifact: "PRIVATE_USER_DATA: Artifact Reference - ",
    interaction_style: "UI_UX_INSTRUCTION: Response Pattern - ",
    specification: "SYSTEM_CONSTRAINT: Implementation Rule - ",
    insight: "PRIVATE_USER_DATA: Meta Observation - ",
  };
  return `${prefixes[category] ?? "PRIVATE_USER_DATA: User/Project Fact - "}${fact.content}`;
}

function splitSummary(summary: string): string[] {
  return summary
    .split(/\n{2,}|(?<=。)|(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 64);
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function compareScore<T extends { score?: number; timestamp?: string }>(
  left: T,
  right: T,
) {
  if ((right.score ?? 0) !== (left.score ?? 0)) {
    return (right.score ?? 0) - (left.score ?? 0);
  }
  return Date.parse(right.timestamp ?? "0") - Date.parse(left.timestamp ?? "0");
}

export class SqliteMemoryStore
  implements
    FactMemoryStore,
    EntryMemoryStore,
    SessionMemoryStore,
    MemoryWriteStore
{
  readonly db: Database.Database;
  private readonly embedding?: EmbeddingClient;
  private readonly vectorEnabled: boolean;
  private readonly now: () => Date;

  constructor(options: SqliteMemoryStoreOptions) {
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.embedding = options.embedding;
    this.now = options.now ?? (() => new Date());
    this.vectorEnabled =
      options.enableVectors !== false &&
      !!options.embedding &&
      !!options.vectorDimension;
    this.initSchema(options.vectorDimension);
  }

  close(): void {
    this.db.close();
  }

  async searchFacts(
    query: string,
    options: { limit?: number; contract?: MemoryContract } = {},
  ): Promise<FactMemorySearchResult[]> {
    const limit = options.limit ?? 5;
    const vectorRows =
      this.vectorEnabled && this.embedding && query.trim()
        ? await this.searchFactVectors(query, Math.max(limit * 4, 20))
        : [];
    const vectorScores = new Map(vectorRows.map((row) => [row.id, row.score]));
    const rows = this.db
      .prepare(
        "SELECT id, category, content, importance, timestamp, embedding, last_accessed, access_count FROM facts ORDER BY importance DESC LIMIT ?",
      )
      .all(Math.max(limit * 8, 50)) as FactRow[];
    const results = rows
      .map((row) => {
        const vectorScore = vectorScores.get(row.id);
        const lexicalScore = lexicalSimilarity(query, row.content);
        return {
          id: String(row.id),
          subject: factCategoryToSubject(row.category),
          content: row.content,
          confidence: Math.max(0.1, Math.min(1, row.importance / 10)),
          score:
            vectorScore !== undefined
              ? Math.max(vectorScore, lexicalScore)
              : lexicalScore,
          createdAt: iso(row.timestamp),
          updatedAt: iso(row.timestamp),
          metadata: { category: row.category, importance: row.importance },
        } satisfies FactMemorySearchResult;
      })
      .filter((result) => (result.score ?? 0) > 0 || !query.trim())
      .sort(compareScore)
      .slice(0, limit);
    this.touchFacts(results.map((result) => Number(result.id)));
    return results;
  }

  async searchEntries(
    query: string,
    options: {
      limit?: number;
      dateRange?: { from: number; to: number } | null;
      maxDistance?: number;
      contract?: MemoryContract;
    } = {},
  ): Promise<EntryMemorySearchResult[]> {
    const limit = options.limit ?? 3;
    const vectorRows =
      this.vectorEnabled && this.embedding && query.trim()
        ? await this.searchEntryVectors(
            query,
            Math.max(limit * 4, 20),
            options.maxDistance,
          )
        : [];
    const vectorScores = new Map(vectorRows.map((row) => [row.id, row.score]));
    const where = options.dateRange
      ? "WHERE timestamp >= ? AND timestamp < ?"
      : "";
    const args = options.dateRange
      ? [options.dateRange.from, options.dateRange.to, Math.max(limit * 8, 50)]
      : [Math.max(limit * 8, 50)];
    const rows = this.db
      .prepare(
        `SELECT id, sessionId, text, timestamp, source FROM memories ${where} ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...args) as EntryRow[];
    return rows
      .map((row) => {
        const vectorScore = vectorScores.get(row.id);
        const lexicalScore = lexicalSimilarity(query, row.text);
        return {
          id: String(row.id),
          kind: sourceToEntryKind(row.source),
          content: row.text,
          score:
            vectorScore !== undefined
              ? Math.max(vectorScore, lexicalScore)
              : lexicalScore,
          timestamp: iso(row.timestamp),
          sourceRefs: row.sessionId ? [row.sessionId] : [],
          entities: [],
          metadata: { sessionId: row.sessionId, source: row.source },
        } satisfies EntryMemorySearchResult;
      })
      .filter((result) => (result.score ?? 0) > 0 || !query.trim())
      .sort(compareScore)
      .slice(0, limit);
  }

  async searchSession(
    query: string,
    options: {
      sessionId?: string;
      limit?: number;
      maxDistance?: number;
      contract?: MemoryContract;
    } = {},
  ): Promise<SessionMemorySearchResult[]> {
    const limit = options.limit ?? 2;
    const vectorRows =
      this.vectorEnabled && this.embedding && query.trim()
        ? await this.searchSummaryVectors(
            query,
            Math.max(limit * 4, 20),
            options.maxDistance,
          )
        : [];
    const vectorScores = new Map(vectorRows.map((row) => [row.id, row.score]));
    const where = options.sessionId ? "WHERE session_id = ?" : "";
    const args = options.sessionId
      ? [options.sessionId, Math.max(limit * 8, 50)]
      : [Math.max(limit * 8, 50)];
    const rows = this.db
      .prepare(
        `SELECT id, session_id, chunk_text FROM summary_chunks_index ${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args) as SummaryChunkRow[];
    return rows
      .map((row) => {
        const vectorScore = vectorScores.get(row.id);
        const lexicalScore = lexicalSimilarity(query, row.chunk_text);
        return {
          sessionId: row.session_id,
          summary: row.chunk_text,
          score:
            vectorScore !== undefined
              ? Math.max(vectorScore, lexicalScore)
              : lexicalScore,
          reason:
            vectorScore !== undefined ? "sqlite_vec_summary" : "sqlite_summary",
          metadata: { source: "summary_chunks_index", chunkId: row.id },
        } satisfies SessionMemorySearchResult;
      })
      .filter((result) => (result.score ?? 0) > 0 || !query.trim())
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, limit);
  }

  async upsertFact(fact: FactMemory): Promise<FactMemory> {
    const category =
      typeof fact.metadata?.category === "string"
        ? fact.metadata.category
        : factSubjectToCategory(fact.subject);
    const importance =
      typeof fact.metadata?.importance === "number"
        ? fact.metadata.importance
        : Math.max(1, Math.min(10, Math.round(fact.confidence * 10)));
    const existing = this.rowIdFromMemoryId(fact.id);
    const timestamp = timestampMs(fact.updatedAt ?? fact.createdAt);
    const vector = await this.embedOptional(embeddingTextForFact(fact));
    const buffer = vector ? Buffer.from(new Float32Array(vector).buffer) : null;
    let rowId: number;
    if (existing) {
      this.db
        .prepare(
          "UPDATE facts SET category = ?, content = ?, importance = ?, timestamp = ?, embedding = ? WHERE id = ?",
        )
        .run(category, fact.content, importance, timestamp, buffer, existing);
      rowId = existing;
    } else {
      const info = this.db
        .prepare(
          "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .run(category, fact.content, importance, timestamp, buffer);
      rowId = Number(info.lastInsertRowid);
    }
    this.syncFactIndexes(rowId, fact.content, vector);
    return { ...fact, id: String(rowId) };
  }

  async upsertEntry(entry: EntryMemory): Promise<EntryMemory> {
    const rowId = this.rowIdFromMemoryId(entry.id);
    const timestamp = timestampMs(entry.timestamp);
    const sessionId =
      entry.sourceRefs[0] ?? entry.metadata?.sessionId ?? "runtime";
    const source =
      typeof entry.metadata?.source === "string"
        ? entry.metadata.source
        : entryKindToSource(entry.kind);
    const vector = await this.embedOptional(entry.content);
    let id: number;
    if (rowId) {
      this.db
        .prepare(
          "UPDATE memories SET sessionId = ?, text = ?, timestamp = ?, source = ? WHERE id = ?",
        )
        .run(String(sessionId), entry.content, timestamp, source, rowId);
      id = rowId;
    } else {
      const info = this.db
        .prepare(
          "INSERT INTO memories (sessionId, text, timestamp, source) VALUES (?, ?, ?, ?)",
        )
        .run(String(sessionId), entry.content, timestamp, source);
      id = Number(info.lastInsertRowid);
    }
    this.syncVector("vec_memories", id, vector);
    return { ...entry, id: String(id) };
  }

  async upsertSession(session: SessionMemory): Promise<SessionMemory> {
    for (const turn of session.turns) {
      await this.upsertEntry({
        id: "",
        scope: "entry",
        kind: "conversation",
        content: `${turn.role}: ${turn.content}`,
        entities: session.topicState?.entities ?? [],
        timestamp: turn.timestamp ?? this.now().toISOString(),
        sourceRefs: [session.sessionId],
        metadata: { sessionId: session.sessionId, role: turn.role },
      });
    }
    if (session.summary) {
      await this.upsertSummaryChunks(session.sessionId, session.summary);
    }
    return session;
  }

  async deleteMemory(input: {
    scope: MemoryItem["scope"];
    id: string;
  }): Promise<boolean> {
    const id = this.rowIdFromMemoryId(input.id);
    if (!id) return false;
    if (input.scope === "fact") {
      const info = this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
      this.deleteVector("vec_facts", id);
      this.db.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(id);
      return info.changes > 0;
    }
    if (input.scope === "entry") {
      const info = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.deleteVector("vec_memories", id);
      return info.changes > 0;
    }
    const info = this.db
      .prepare("DELETE FROM summary_chunks_index WHERE id = ?")
      .run(id);
    this.deleteVector("vec_summary_chunks", id);
    return info.changes > 0;
  }

  async listFacts(): Promise<FactMemory[]> {
    const rows = this.db
      .prepare(
        "SELECT id, category, content, importance, timestamp, embedding, last_accessed, access_count FROM facts ORDER BY timestamp DESC",
      )
      .all() as FactRow[];
    return rows.map((row) => ({
      id: String(row.id),
      scope: "fact",
      subject: factCategoryToSubject(row.category),
      content: row.content,
      confidence: Math.max(0.1, Math.min(1, row.importance / 10)),
      sourceRefs: ["sqlite:facts"],
      createdAt: iso(row.timestamp),
      updatedAt: iso(row.timestamp),
      metadata: { category: row.category, importance: row.importance },
    }));
  }

  async listEntries(): Promise<EntryMemory[]> {
    const rows = this.db
      .prepare(
        "SELECT id, sessionId, text, timestamp, source FROM memories ORDER BY timestamp DESC",
      )
      .all() as EntryRow[];
    return rows.map((row) => ({
      id: String(row.id),
      scope: "entry",
      kind: sourceToEntryKind(row.source),
      content: row.text,
      entities: [],
      timestamp: iso(row.timestamp),
      sourceRefs: row.sessionId ? [row.sessionId] : [],
      metadata: { sessionId: row.sessionId, source: row.source },
    }));
  }

  async listSessions(): Promise<SessionMemory[]> {
    const rows = this.db
      .prepare(
        "SELECT session_id, group_concat(chunk_text, '\n') AS summary FROM summary_chunks_index GROUP BY session_id ORDER BY max(id) DESC",
      )
      .all() as Array<{ session_id: string; summary: string | null }>;
    return rows.map((row) => ({
      scope: "session",
      sessionId: row.session_id,
      turns: [],
      summary: row.summary ?? undefined,
      topicState: { label: "summary_chunks_index" } satisfies TopicState,
    }));
  }

  async upsertSummaryChunks(sessionId: string, summary: string): Promise<void> {
    const chunks = splitSummary(summary);
    const desired = new Set(chunks.map(hashText));
    const existing = this.db
      .prepare(
        "SELECT id, chunk_hash FROM summary_chunks_index WHERE session_id = ?",
      )
      .all(sessionId) as Array<{ id: number; chunk_hash: string }>;
    for (const row of existing) {
      if (!desired.has(row.chunk_hash)) {
        this.db
          .prepare("DELETE FROM summary_chunks_index WHERE id = ?")
          .run(row.id);
        this.deleteVector("vec_summary_chunks", row.id);
      }
    }
    const existingHashes = new Set(existing.map((row) => row.chunk_hash));
    for (const chunk of chunks) {
      const chunkHash = hashText(chunk);
      if (existingHashes.has(chunkHash)) continue;
      const info = this.db
        .prepare(
          "INSERT INTO summary_chunks_index (session_id, chunk_hash, chunk_text) VALUES (?, ?, ?)",
        )
        .run(sessionId, chunkHash, chunk);
      this.syncVector(
        "vec_summary_chunks",
        Number(info.lastInsertRowid),
        await this.embedOptional(chunk),
      );
    }
  }

  private initSchema(vectorDimension?: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT,
        text TEXT,
        timestamp INTEGER,
        source TEXT DEFAULT 'conversation'
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,
        content TEXT,
        importance INTEGER DEFAULT 5,
        timestamp INTEGER,
        embedding BLOB,
        last_accessed INTEGER,
        access_count INTEGER DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        content,
        fact_id UNINDEXED,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS summary_chunks_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        chunk_hash TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        UNIQUE(session_id, chunk_hash)
      );
    `);
    try {
      this.db.exec(
        "ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'conversation'",
      );
    } catch {}
    if (this.vectorEnabled && vectorDimension) {
      try {
        sqliteVec.load(this.db);
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
            id INTEGER PRIMARY KEY,
            embedding FLOAT[${vectorDimension}]
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
            id INTEGER PRIMARY KEY,
            embedding FLOAT[${vectorDimension}]
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_summary_chunks USING vec0(
            id INTEGER PRIMARY KEY,
            embedding FLOAT[${vectorDimension}]
          );
        `);
      } catch {
        // Keep lexical/FTS mode when sqlite-vec is unavailable.
      }
    }
  }

  private async embedOptional(text: string): Promise<number[] | null> {
    if (!this.vectorEnabled || !this.embedding) return null;
    return this.embedding.embed(text).catch(() => null);
  }

  private rowIdFromMemoryId(id: string): number | null {
    if (!id) return null;
    const parsed = Number(id);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private syncFactIndexes(
    id: number,
    content: string,
    vector: number[] | null,
  ): void {
    this.db.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(id);
    this.db
      .prepare("INSERT INTO facts_fts (content, fact_id) VALUES (?, ?)")
      .run(content, id);
    this.syncVector("vec_facts", id, vector);
  }

  private syncVector(table: string, id: number, vector: number[] | null): void {
    if (!vector) return;
    try {
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(BigInt(id));
      this.db
        .prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ?)`)
        .run(BigInt(id), new Float32Array(vector));
    } catch {
      // sqlite-vec may be unavailable in tests or host deployments.
    }
  }

  private deleteVector(table: string, id: number): void {
    try {
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(BigInt(id));
    } catch {}
  }

  private async searchFactVectors(query: string, limit: number) {
    return this.searchVectorTable("vec_facts", query, limit);
  }

  private async searchEntryVectors(
    query: string,
    limit: number,
    maxDistance = 1.0,
  ) {
    return this.searchVectorTable("vec_memories", query, limit, maxDistance);
  }

  private async searchSummaryVectors(
    query: string,
    limit: number,
    maxDistance = 1.0,
  ) {
    return this.searchVectorTable(
      "vec_summary_chunks",
      query,
      limit,
      maxDistance,
    );
  }

  private async searchVectorTable(
    table: string,
    query: string,
    limit: number,
    maxDistance = 1.0,
  ): Promise<Array<{ id: number; score: number }>> {
    const vector = await this.embedOptional(query);
    if (!vector) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, distance FROM ${table}
           WHERE embedding MATCH ?
             AND k = ?
             AND distance < ?
           ORDER BY distance`,
        )
        .all(new Float32Array(vector), limit, maxDistance) as Array<{
        id: number | bigint;
        distance: number;
      }>;
      return rows.map((row) => ({
        id: Number(row.id),
        score: Math.max(0, 1 - row.distance),
      }));
    } catch {
      return [];
    }
  }

  private touchFacts(ids: number[]): void {
    if (ids.length === 0) return;
    const now = this.now().getTime();
    for (const id of ids) {
      if (!Number.isFinite(id)) continue;
      this.db
        .prepare(
          "UPDATE facts SET last_accessed = ?, access_count = COALESCE(access_count, 0) + 1 WHERE id = ?",
        )
        .run(now, id);
    }
  }
}
