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
  saveFact?: (
    category: string,
    content: string,
    importance?: number,
  ) => Promise<void>;
  saveEntryMemory?: (input: {
    id?: string;
    sessionId?: string;
    kind?: EntryMemory["kind"];
    content: string;
    timestamp?: string | number;
    entities?: string[];
    sourceRefs?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<EntryMemory>;
  appendSessionTurn?: (input: {
    sessionId: string;
    role: SessionMemory["turns"][number]["role"];
    content: string;
    timestamp?: string | number;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  listRuntimeFacts?: (limit?: number) => Promise<FactMemory[]>;
  listRuntimeEntries?: (limit?: number) => Promise<EntryMemory[]>;
  listRuntimeSessions?: (limit?: number) => Promise<SessionMemory[]>;
  deleteRuntimeMemory?: (input: {
    scope: MemoryItem["scope"];
    id: string;
  }) => Promise<boolean>;
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
    const facts = await this.memoryService.searchFacts(query, options?.limit);
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

function factSubjectToCategory(fact: FactMemory): string {
  if (typeof fact.metadata?.category === "string") {
    return fact.metadata.category;
  }
  if (fact.subject === "user") return "identity";
  if (fact.subject === "preference") return "interaction_style";
  if (fact.subject === "project") return "specification";
  return "behavior";
}

export class JarvisMemoryWriteStore implements MemoryWriteStore {
  constructor(private readonly memoryService: JarvisMemoryServiceHandle) {}

  async upsertFact(fact: FactMemory): Promise<FactMemory> {
    if (!this.memoryService.saveFact) return fact;
    const importance =
      typeof fact.metadata?.importance === "number"
        ? fact.metadata.importance
        : Math.max(1, Math.min(10, Math.round(fact.confidence * 10)));
    await this.memoryService.saveFact(
      factSubjectToCategory(fact),
      fact.content,
      importance,
    );
    return fact;
  }

  async upsertEntry(entry: EntryMemory): Promise<EntryMemory> {
    return (
      (await this.memoryService.saveEntryMemory?.({
        id: entry.id,
        sessionId:
          typeof entry.metadata?.sessionId === "string"
            ? entry.metadata.sessionId
            : entry.sourceRefs[0],
        kind: entry.kind,
        content: entry.content,
        timestamp: entry.timestamp,
        entities: entry.entities,
        sourceRefs: entry.sourceRefs,
        metadata: entry.metadata,
      })) ?? entry
    );
  }

  async upsertSession(session: SessionMemory): Promise<SessionMemory> {
    if (this.memoryService.appendSessionTurn) {
      for (const turn of session.turns) {
        await this.memoryService.appendSessionTurn({
          sessionId: session.sessionId,
          role: turn.role,
          content: turn.content,
          timestamp: turn.timestamp,
          metadata: turn.metadata,
        });
      }
    }
    return session;
  }

  async deleteMemory(input: {
    scope: MemoryItem["scope"];
    id: string;
  }): Promise<boolean> {
    return (await this.memoryService.deleteRuntimeMemory?.(input)) ?? false;
  }

  async listFacts(): Promise<FactMemory[]> {
    return (await this.memoryService.listRuntimeFacts?.()) ?? [];
  }

  async listEntries(): Promise<EntryMemory[]> {
    return (await this.memoryService.listRuntimeEntries?.()) ?? [];
  }

  async listSessions(): Promise<SessionMemory[]> {
    return (await this.memoryService.listRuntimeSessions?.()) ?? [];
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
  return new JarvisMemoryWriteStore(memoryService);
}
