/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EntryMemoryStore,
  type EntryMemory,
  type FactMemory,
  FactMemorySearchResult,
  FactMemoryStore,
  MemoryContract,
  type MemoryItem,
  MemoryRetrieverStores,
  type MemoryWriteStore,
  type SessionMemory,
  SessionMemoryStore,
} from "../memory-runtime/index.js";

export type JarvisMemoryServiceHandle = {
  getRuntimeSqliteMemoryStore?: () => MemoryWriteStore;
  searchFacts: (
    query: string,
    limit?: number,
  ) => Promise<Array<{ category: string; content: string }>>;
  searchWithScore: (
    query: string,
    limit?: number,
    timeWindowDays?: number | null,
    dateRange?: { from: number; to: number } | null,
    maxDistanceOverride?: number,
  ) => Promise<Array<{ text: string; score: number; timestamp?: number }>>;
  searchConversationHistoryLexical?: (
    query: string,
    options?: {
      limit?: number;
      dateRange?: { from: number; to: number } | null;
    },
  ) => Promise<Array<{ text: string; score: number; timestamp?: number }>>;
  searchSummaryChunks?: (
    sessionId: string,
    query: string,
    topK?: number,
    maxDistance?: number,
  ) => Promise<string[]>;
};

function mapFactSubject(category: string): FactMemorySearchResult["subject"] {
  if (category === "preference" || category === "interaction_style") {
    return "preference";
  }
  if (category === "project" || category === "artifact") return "project";
  if (category === "relationship") return "relationship";
  if (category === "identity") return "user";
  return "profile";
}

export class JarvisFactMemoryStore implements FactMemoryStore {
  constructor(private readonly memoryService: JarvisMemoryServiceHandle) {}

  async searchFacts(
    query: string,
    options?: { limit?: number; contract?: MemoryContract },
  ): Promise<FactMemorySearchResult[]> {
    const limit = options?.limit;
    const preview = query.replace(/\s+/g, " ").trim().slice(0, 120);
    console.error(
      `[MemoryRetrieval] jarvis.facts.adapter started query=${JSON.stringify(preview)} limit=${limit ?? "default"} memoryTarget=${options?.contract?.memoryTarget ?? "unknown"}`,
    );
    const facts = await this.memoryService.searchFacts(query, options?.limit);
    console.error(
      `[MemoryRetrieval] jarvis.facts.adapter finished returned=${facts.length} categories=${JSON.stringify(facts.map((fact) => fact.category).slice(0, 8))} previews=${JSON.stringify(facts.map((fact) => fact.content.replace(/\s+/g, " ").trim().slice(0, 80)).slice(0, 3))}`,
    );
    return facts.map((fact, index) => ({
      id: `jarvis-fact-${index}`,
      subject: mapFactSubject(fact.category),
      content: fact.content,
      confidence: 1,
      score: 1,
      metadata: { category: fact.category },
    }));
  }
}

export class JarvisEntryMemoryStore implements EntryMemoryStore {
  constructor(private readonly memoryService: JarvisMemoryServiceHandle) {}

  async searchEntries(
    query: string,
    options?: {
      limit?: number;
      dateRange?: { from: number; to: number } | null;
      maxDistance?: number;
      contract?: MemoryContract;
    },
  ) {
    const limit = options?.limit ?? 3;
    const hasTimeScopedConversationHistory =
      options?.contract?.memoryTarget === "conversation_history" &&
      Boolean(options?.dateRange);
    const rawEntries = await this.memoryService.searchWithScore(
      query,
      limit,
      null,
      options?.dateRange ?? null,
      options?.maxDistance,
    );
    const entries = hasTimeScopedConversationHistory
      ? rawEntries.filter(
          (entry) =>
            typeof entry.timestamp === "number" &&
            entry.timestamp >= options.dateRange!.from &&
            entry.timestamp < options.dateRange!.to,
        )
      : rawEntries;
    const shouldUseHistoryFallback =
      this.memoryService.searchConversationHistoryLexical &&
      options?.contract?.memoryTarget === "conversation_history" &&
      (hasTimeScopedConversationHistory || entries.length < limit);
    const fallbackLimit =
      options?.dateRange &&
      options?.contract?.memoryTarget === "conversation_history"
        ? Math.max(limit, 8)
        : limit;
    const fallbackEntries = shouldUseHistoryFallback
      ? await this.memoryService.searchConversationHistoryLexical!(query, {
          limit: fallbackLimit,
          dateRange: options?.dateRange ?? null,
        })
      : [];
    if (options?.contract?.memoryTarget === "conversation_history") {
      console.error(
        `🔎 [JarvisEntryMemoryStore] conversation_history fallback=${shouldUseHistoryFallback ? "enabled" : "skipped"} vector=${entries.length}/${limit} lexical=${fallbackEntries.length}`,
      );
    }
    const primaryEntries = hasTimeScopedConversationHistory
      ? fallbackEntries
      : entries;
    const secondaryEntries = hasTimeScopedConversationHistory
      ? entries
      : fallbackEntries;
    const seen = new Set(primaryEntries.map((entry) => entry.text));
    const merged = [
      ...primaryEntries.map((entry) => ({
        ...entry,
        source: hasTimeScopedConversationHistory
          ? "conversation_history_lexical"
          : "memory",
      })),
      ...secondaryEntries
        .filter((entry) => !seen.has(entry.text))
        .slice(0, Math.max(0, fallbackLimit - primaryEntries.length))
        .map((entry) => ({
          ...entry,
          source: hasTimeScopedConversationHistory
            ? "memory"
            : "conversation_history_lexical",
        })),
    ];

    return merged.map((entry, index) => ({
      id: `jarvis-entry-${index}`,
      kind: "conversation" as const,
      content: entry.text,
      score: entry.score,
      entities: options?.contract?.query.entities ?? [],
      timestamp: entry.timestamp
        ? new Date(entry.timestamp).toISOString()
        : undefined,
      metadata: {
        source: entry.source,
      },
    }));
  }
}

export class JarvisSessionMemoryStore implements SessionMemoryStore {
  constructor(
    private readonly memoryService: JarvisMemoryServiceHandle,
    private readonly sessionId: string,
  ) {}

  async searchSession(
    query: string,
    options?: {
      limit?: number;
      maxDistance?: number;
      contract?: MemoryContract;
    },
  ) {
    if (!this.memoryService.searchSummaryChunks) return [];
    const chunks = await this.memoryService.searchSummaryChunks(
      this.sessionId,
      query,
      options?.limit ?? 2,
      options?.maxDistance ?? 0.72,
    );
    return chunks.map((chunk, index) => ({
      sessionId: this.sessionId,
      summary: chunk,
      score: 1,
      reason: `summary_chunk_${index}`,
      metadata: { source: "vector" },
    }));
  }
}

export class JarvisMemoryWriteStore implements MemoryWriteStore {
  constructor(private readonly store: MemoryWriteStore) {}

  async upsertFact(fact: FactMemory): Promise<FactMemory> {
    return this.store.upsertFact(fact);
  }

  async upsertEntry(entry: EntryMemory): Promise<EntryMemory> {
    return this.store.upsertEntry(entry);
  }

  async upsertSession(session: SessionMemory): Promise<SessionMemory> {
    return this.store.upsertSession(session);
  }

  async deleteMemory(input: {
    scope: MemoryItem["scope"];
    id: string;
  }): Promise<boolean> {
    return this.store.deleteMemory(input);
  }

  async listFacts(): Promise<FactMemory[]> {
    return this.store.listFacts();
  }

  async listEntries(): Promise<EntryMemory[]> {
    return this.store.listEntries();
  }

  async listSessions(): Promise<SessionMemory[]> {
    return this.store.listSessions();
  }
}

export function createJarvisMemoryStores(
  memoryService: JarvisMemoryServiceHandle,
  sessionId: string,
): MemoryRetrieverStores {
  return {
    facts: new JarvisFactMemoryStore(memoryService),
    entries: new JarvisEntryMemoryStore(memoryService),
    session: new JarvisSessionMemoryStore(memoryService, sessionId),
  };
}

export function createJarvisMemoryWriteStore(
  memoryService: JarvisMemoryServiceHandle,
): MemoryWriteStore {
  const store = memoryService.getRuntimeSqliteMemoryStore?.();
  if (!store) {
    throw new Error("Runtime SqliteMemoryStore is required for memory writes");
  }
  return new JarvisMemoryWriteStore(store);
}
