/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DefaultMemoryRetriever,
  type EntryMemorySearchResult,
  type FactMemorySearchResult,
  type MemoryRetrieverStores,
  type SessionMemorySearchResult,
} from "./retrieval.js";
import type { MemoryWriteStore } from "./store.js";
import type {
  EntryMemory,
  FactMemory,
  MemoryContract,
  MemoryItem,
  MemoryRetrievalResult,
  SessionMemory,
} from "./types.js";
import {
  DefaultMemoryWriterRuntime,
  type MemoryWriteRequest,
  type MemoryWriteResult,
} from "./writer.js";

export type LayeredMemoryRuntimeOptions = {
  stores: MemoryRetrieverStores;
  writeStore: MemoryWriteStore;
  sessionId?: string;
  retriever?: DefaultMemoryRetriever;
  writer?: DefaultMemoryWriterRuntime;
};

export type LayeredMemorySearchInput = {
  query: string;
  contract?: MemoryContract;
  limit?: number;
};

/**
 * Unified three-layer memory facade:
 * - session memory: current/long-running transcript state and summaries;
 * - fact memory: durable profile/project facts;
 * - entry memory: episodic conversation/task/event records.
 *
 * Storage remains host-provided through adapters; this class owns the common
 * save/search/recall lifecycle and uses writer governance for all writes.
 */
export class DefaultLayeredMemoryRuntime {
  private readonly retriever: DefaultMemoryRetriever;
  private readonly writer: DefaultMemoryWriterRuntime;

  constructor(private readonly options: LayeredMemoryRuntimeOptions) {
    this.retriever =
      options.retriever ??
      new DefaultMemoryRetriever({
        stores: options.stores,
        sessionId: options.sessionId,
      });
    this.writer =
      options.writer ??
      new DefaultMemoryWriterRuntime({ store: options.writeStore });
  }

  async saveFact(fact: FactMemory): Promise<MemoryWriteResult<FactMemory>> {
    return this.writeOne({ operation: "upsert", item: fact });
  }

  async saveEntry(entry: EntryMemory): Promise<MemoryWriteResult<EntryMemory>> {
    return this.writeOne({ operation: "upsert", item: entry });
  }

  async saveSession(
    session: SessionMemory,
  ): Promise<MemoryWriteResult<SessionMemory>> {
    return this.writeOne({ operation: "upsert", item: session });
  }

  async saveMany(requests: MemoryWriteRequest[]): Promise<MemoryWriteResult[]> {
    return this.writer.write(requests);
  }

  async delete(item: MemoryItem): Promise<MemoryWriteResult> {
    return this.writeOne({ operation: "delete", item });
  }

  async recall(contract: MemoryContract): Promise<MemoryRetrievalResult> {
    return this.retriever.retrieve(contract);
  }

  async searchFacts(
    input: LayeredMemorySearchInput,
  ): Promise<FactMemorySearchResult[]> {
    return (
      this.options.stores.facts?.searchFacts(input.query, {
        limit: input.limit,
        contract: input.contract,
      }) ?? []
    );
  }

  async searchEntries(
    input: LayeredMemorySearchInput,
  ): Promise<EntryMemorySearchResult[]> {
    return (
      this.options.stores.entries?.searchEntries(input.query, {
        limit: input.limit,
        contract: input.contract,
        dateRange: input.contract?.query.timeRange ?? null,
      }) ?? []
    );
  }

  async searchSession(
    input: LayeredMemorySearchInput,
  ): Promise<SessionMemorySearchResult[]> {
    return (
      this.options.stores.session?.searchSession(input.query, {
        sessionId: this.options.sessionId,
        limit: input.limit,
        contract: input.contract,
      }) ?? []
    );
  }

  private async writeOne<T extends MemoryItem>(
    request: MemoryWriteRequest<T>,
  ): Promise<MemoryWriteResult<T>> {
    const [result] = await this.writer.write([request]);
    return result as MemoryWriteResult<T>;
  }
}
