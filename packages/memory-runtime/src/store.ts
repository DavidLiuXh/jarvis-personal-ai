/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EntryMemory,
  FactMemory,
  MemoryContract,
  MemoryItem,
  SessionMemory,
} from "./types.js";
import {
  type EntryMemorySearchResult,
  type EntryMemoryStore,
  type FactMemorySearchResult,
  type FactMemoryStore,
  type SessionMemorySearchResult,
  type SessionMemoryStore,
} from "./retrieval.js";
import { lexicalSimilarity } from "./governance.js";

export type MemoryWriteStore = {
  upsertFact(fact: FactMemory): Promise<FactMemory>;
  upsertEntry(entry: EntryMemory): Promise<EntryMemory>;
  upsertSession(session: SessionMemory): Promise<SessionMemory>;
  deleteMemory(input: {
    scope: MemoryItem["scope"];
    id: string;
  }): Promise<boolean>;
  listFacts(): Promise<FactMemory[]>;
  listEntries(): Promise<EntryMemory[]>;
  listSessions(): Promise<SessionMemory[]>;
};

export type DefaultMemoryStoreOptions = {
  facts?: FactMemory[];
  entries?: EntryMemory[];
  sessions?: SessionMemory[];
};

function compareByScore<T extends { score?: number }>(items: T[]): T[] {
  return [...items].sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0),
  );
}

function limit<T>(items: T[], count: number): T[] {
  return items.slice(0, Math.max(0, count));
}

export class DefaultMemoryStore
  implements
    FactMemoryStore,
    EntryMemoryStore,
    SessionMemoryStore,
    MemoryWriteStore
{
  private readonly facts = new Map<string, FactMemory>();
  private readonly entries = new Map<string, EntryMemory>();
  private readonly sessions = new Map<string, SessionMemory>();

  constructor(options: DefaultMemoryStoreOptions = {}) {
    for (const fact of options.facts ?? []) this.facts.set(fact.id, fact);
    for (const entry of options.entries ?? [])
      this.entries.set(entry.id, entry);
    for (const session of options.sessions ?? []) {
      this.sessions.set(session.sessionId, session);
    }
  }

  async searchFacts(
    query: string,
    options: { limit?: number; contract?: MemoryContract } = {},
  ): Promise<FactMemorySearchResult[]> {
    const results = Array.from(this.facts.values())
      .map((fact) => ({
        ...fact,
        score: lexicalSimilarity(query, fact.content),
      }))
      .filter((fact) => fact.score > 0 || !query.trim());
    return limit(compareByScore(results), options.limit ?? 5);
  }

  async searchEntries(
    query: string,
    options: { limit?: number; contract?: MemoryContract } = {},
  ): Promise<EntryMemorySearchResult[]> {
    const results = Array.from(this.entries.values())
      .map((entry) => ({
        ...entry,
        score: lexicalSimilarity(
          query,
          `${entry.content} ${entry.entities.join(" ")}`,
        ),
      }))
      .filter((entry) => entry.score > 0 || !query.trim());
    return limit(compareByScore(results), options.limit ?? 3);
  }

  async searchSession(
    query: string,
    options: {
      sessionId?: string;
      limit?: number;
      contract?: MemoryContract;
    } = {},
  ): Promise<SessionMemorySearchResult[]> {
    const sessions = options.sessionId
      ? Array.from(this.sessions.values()).filter(
          (session) => session.sessionId === options.sessionId,
        )
      : Array.from(this.sessions.values());
    const results = sessions
      .map((session) => {
        const text = [
          session.summary ?? "",
          ...session.turns.map((turn) => turn.content),
        ].join(" ");
        return {
          ...session,
          score: lexicalSimilarity(query, text),
          reason: "default_memory_store",
        };
      })
      .filter((session) => session.score > 0 || !query.trim());
    return limit(compareByScore(results), options.limit ?? 2);
  }

  async upsertFact(fact: FactMemory): Promise<FactMemory> {
    this.facts.set(fact.id, fact);
    return fact;
  }

  async upsertEntry(entry: EntryMemory): Promise<EntryMemory> {
    this.entries.set(entry.id, entry);
    return entry;
  }

  async upsertSession(session: SessionMemory): Promise<SessionMemory> {
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async deleteMemory(input: {
    scope: MemoryItem["scope"];
    id: string;
  }): Promise<boolean> {
    if (input.scope === "fact") return this.facts.delete(input.id);
    if (input.scope === "entry") return this.entries.delete(input.id);
    return this.sessions.delete(input.id);
  }

  async listFacts(): Promise<FactMemory[]> {
    return Array.from(this.facts.values());
  }

  async listEntries(): Promise<EntryMemory[]> {
    return Array.from(this.entries.values());
  }

  async listSessions(): Promise<SessionMemory[]> {
    return Array.from(this.sessions.values());
  }
}
