/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EntryMemoryStore,
  FactMemorySearchResult,
  FactMemoryStore,
  MemoryContract,
  MemoryRetrieverStores,
  SessionMemoryStore,
} from "../memory-runtime/index.js";

export type JarvisMemoryServiceHandle = {
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
  ) => Promise<Array<{ text: string; score: number }>>;
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
    const entries = await this.memoryService.searchWithScore(
      query,
      options?.limit ?? 3,
      null,
      options?.dateRange ?? null,
      options?.maxDistance,
    );
    return entries.map((entry, index) => ({
      id: `jarvis-entry-${index}`,
      kind: "conversation" as const,
      content: entry.text,
      score: entry.score,
      entities: options?.contract?.query.entities ?? [],
      metadata: { source: "memory" },
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
