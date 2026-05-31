/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DateRange,
  EntryMemory,
  FactMemory,
  MemoryContract,
  MemoryRetrievalResult,
  SessionMemory,
} from "./types.js";

export type FactMemorySearchResult = {
  id?: string;
  subject?: FactMemory["subject"];
  content: string;
  confidence?: number;
  score?: number;
  sourceRefs?: string[];
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type EntryMemorySearchResult = {
  id?: string;
  kind?: EntryMemory["kind"];
  content: string;
  score?: number;
  entities?: string[];
  timestamp?: string;
  sourceRefs?: string[];
  metadata?: Record<string, unknown>;
};

export type SessionMemorySearchResult = {
  sessionId: string;
  turns?: SessionMemory["turns"];
  summary?: string;
  topicState?: SessionMemory["topicState"];
  score?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export interface FactMemoryStore {
  searchFacts(
    query: string,
    options?: { limit?: number; contract?: MemoryContract },
  ): Promise<FactMemorySearchResult[]>;
}

export interface EntryMemoryStore {
  searchEntries(
    query: string,
    options?: {
      limit?: number;
      dateRange?: DateRange | null;
      maxDistance?: number;
      contract?: MemoryContract;
    },
  ): Promise<EntryMemorySearchResult[]>;
}

export interface SessionMemoryStore {
  searchSession(
    query: string,
    options?: {
      sessionId?: string;
      limit?: number;
      maxDistance?: number;
      contract?: MemoryContract;
    },
  ): Promise<SessionMemorySearchResult[]>;
}

export type MemoryRetrieverStores = {
  facts?: FactMemoryStore;
  entries?: EntryMemoryStore;
  session?: SessionMemoryStore;
};

export type MemoryRetrievalScope = "session" | "fact" | "entry";

export type MemoryRetrievalExtensionContext = {
  prompt?: string;
  history?: unknown[];
  intent?: unknown;
  metadata?: Record<string, unknown>;
};

export type MemoryRetrievalExtensionInput = {
  contract: MemoryContract;
  query: string;
  context?: MemoryRetrievalExtensionContext;
};

export type MemoryQueryPlannerInput = MemoryRetrievalExtensionInput & {
  scope: MemoryRetrievalScope;
  defaultQuery: string;
};

export type MemoryRuntimeRetrievalExtensions = {
  planQuery?: (input: MemoryQueryPlannerInput) => Promise<string> | string;
  augmentEntries?: (
    input: MemoryRetrievalExtensionInput,
  ) => Promise<EntryMemorySearchResult[]> | EntryMemorySearchResult[];
  fallbackSession?: (
    input: MemoryRetrievalExtensionInput & {
      results: SessionMemorySearchResult[];
    },
  ) => Promise<SessionMemorySearchResult[]> | SessionMemorySearchResult[];
};

export type SkillRetrievalExtension<TSkill = unknown> = {
  retrieveSkills(input: {
    prompt: string;
    limit: number;
    maxDistance?: number;
    context?: MemoryRetrievalExtensionContext;
  }): Promise<TSkill[]>;
};

export type DefaultMemoryRetrieverOptions = {
  stores: MemoryRetrieverStores;
  extensions?: MemoryRuntimeRetrievalExtensions;
  context?: MemoryRetrievalExtensionContext;
  sessionId?: string;
  factLimit?: number;
  entryLimit?: number;
  sessionLimit?: number;
  entryMaxDistance?: number;
  sessionMaxDistance?: number;
  now?: () => Date;
};

export class DefaultMemoryRetriever {
  private readonly now: () => Date;

  constructor(private readonly options: DefaultMemoryRetrieverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async retrieve(contract: MemoryContract): Promise<MemoryRetrievalResult> {
    if (!contract.needMemory || contract.subjectBoundary === "external") {
      return { contract, session: [], facts: [], entries: [] };
    }

    const defaultQuery = contract.query.rewritten || contract.query.raw;
    const [session, facts, entries] = await Promise.all([
      this.retrieveSession(
        contract,
        await this.planQuery(contract, "session", defaultQuery),
      ),
      this.retrieveFacts(
        contract,
        await this.planQuery(contract, "fact", defaultQuery),
      ),
      this.retrieveEntries(
        contract,
        await this.planQuery(contract, "entry", defaultQuery),
      ),
    ]);

    return { contract, session, facts, entries };
  }

  private async planQuery(
    contract: MemoryContract,
    scope: MemoryRetrievalScope,
    defaultQuery: string,
  ): Promise<string> {
    const query = await this.options.extensions?.planQuery?.({
      contract,
      scope,
      defaultQuery,
      query: defaultQuery,
      context: this.options.context,
    });
    return query?.trim() || defaultQuery;
  }

  private async retrieveSession(contract: MemoryContract, query: string) {
    if (
      !contract.targetScopes.includes("session") ||
      !contract.constraints.allowSessionHistory ||
      !this.options.stores.session
    ) {
      return [];
    }

    let results = await this.options.stores.session.searchSession(query, {
      sessionId: this.options.sessionId,
      limit: this.options.sessionLimit ?? 2,
      maxDistance: this.options.sessionMaxDistance,
      contract,
    });
    if (results.length === 0 && this.options.extensions?.fallbackSession) {
      results = await this.options.extensions.fallbackSession({
        contract,
        query,
        context: this.options.context,
        results,
      });
    }

    return results.map((result, index) => ({
      item: {
        scope: "session" as const,
        sessionId: result.sessionId,
        turns: result.turns ?? [],
        summary: result.summary,
        topicState: result.topicState,
        metadata: result.metadata,
      },
      score: result.score ?? 1,
      reason: result.reason ?? `session_search_${index}`,
    }));
  }

  private async retrieveFacts(contract: MemoryContract, query: string) {
    if (
      !contract.targetScopes.includes("fact") ||
      !contract.constraints.allowPersonalFacts ||
      !this.options.stores.facts
    ) {
      return [];
    }

    const results = await this.options.stores.facts.searchFacts(query, {
      limit: this.options.factLimit ?? 5,
      contract,
    });
    const timestamp = this.now().toISOString();

    return results.map((result, index) => ({
      item: {
        id: result.id ?? `fact-${index}`,
        scope: "fact" as const,
        subject: result.subject ?? "profile",
        content: result.content,
        confidence: result.confidence ?? 1,
        sourceRefs: result.sourceRefs ?? [],
        createdAt: result.createdAt ?? timestamp,
        updatedAt: result.updatedAt ?? timestamp,
        metadata: result.metadata,
      },
      score: result.score ?? result.confidence ?? 1,
      reason: "fact_search",
    }));
  }

  private async retrieveEntries(contract: MemoryContract, query: string) {
    if (
      !contract.targetScopes.includes("entry") ||
      !contract.constraints.allowEntries ||
      !this.options.stores.entries
    ) {
      return [];
    }

    const augmented =
      (await this.options.extensions?.augmentEntries?.({
        contract,
        query,
        context: this.options.context,
      })) ?? [];
    const results = [
      ...augmented,
      ...(await this.options.stores.entries.searchEntries(query, {
        limit: this.options.entryLimit ?? 3,
        dateRange: contract.query.timeRange ?? null,
        maxDistance: this.options.entryMaxDistance,
        contract,
      })),
    ];
    const timestamp = this.now().toISOString();

    return results.map((result, index) => ({
      item: {
        id: result.id ?? `entry-${index}`,
        scope: "entry" as const,
        kind: result.kind ?? "conversation",
        content: result.content,
        entities: result.entities ?? contract.query.entities,
        timestamp: result.timestamp ?? timestamp,
        sourceRefs: result.sourceRefs ?? [],
        metadata: result.metadata,
      },
      score: result.score ?? 1,
      reason: "entry_search",
    }));
  }
}
