/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { DefaultMemoryRetriever } from "./retrieval.js";
import type { MemoryContract } from "./types.js";

function contract(overrides: Partial<MemoryContract> = {}): MemoryContract {
  return {
    needMemory: true,
    subjectBoundary: "personal",
    targetScopes: ["session", "fact", "entry"],
    memoryTarget: "conversation_history",
    query: {
      raw: "summarize previous TypeScript discussion",
      rewritten: "TypeScript discussion",
      entities: ["TypeScript"],
      timeRange: { from: 1, to: 2 },
    },
    confidence: { subject: 0.9, target: 0.9, query: 0.9 },
    constraints: {
      allowPersonalFacts: true,
      allowSessionHistory: true,
      allowEntries: true,
      maxChars: 1800,
    },
    reasons: ["test"],
    policyTrace: [],
    ...overrides,
  };
}

describe("DefaultMemoryRetriever", () => {
  it("retrieves only scopes allowed by the MemoryContract", async () => {
    const searchFacts = vi
      .fn()
      .mockResolvedValue([
        { id: "f1", subject: "preference", content: "prefers TypeScript" },
      ]);
    const searchEntries = vi
      .fn()
      .mockResolvedValue([
        { id: "e1", content: "previous discussion", score: 0.8 },
      ]);
    const searchSession = vi
      .fn()
      .mockResolvedValue([{ sessionId: "s1", summary: "session summary" }]);
    const retriever = new DefaultMemoryRetriever({
      sessionId: "s1",
      stores: {
        facts: { searchFacts },
        entries: { searchEntries },
        session: { searchSession },
      },
    });

    const result = await retriever.retrieve(contract());

    expect(searchFacts).toHaveBeenCalledWith(
      "TypeScript discussion",
      expect.objectContaining({ limit: 5 }),
    );
    expect(searchEntries).toHaveBeenCalledWith(
      "TypeScript discussion",
      expect.objectContaining({ dateRange: { from: 1, to: 2 }, limit: 3 }),
    );
    expect(searchSession).toHaveBeenCalledWith(
      "TypeScript discussion",
      expect.objectContaining({ sessionId: "s1", limit: 2 }),
    );
    expect(result.facts[0].item.content).toBe("prefers TypeScript");
    expect(result.entries[0].item.content).toBe("previous discussion");
    expect(result.session[0].item.summary).toBe("session summary");
  });

  it("does not call stores for external or no-memory contracts", async () => {
    const stores = {
      facts: { searchFacts: vi.fn() },
      entries: { searchEntries: vi.fn() },
      session: { searchSession: vi.fn() },
    };
    const retriever = new DefaultMemoryRetriever({ stores });

    const result = await retriever.retrieve(
      contract({
        needMemory: false,
        subjectBoundary: "external",
        targetScopes: [],
        constraints: {
          allowPersonalFacts: false,
          allowSessionHistory: false,
          allowEntries: false,
          maxChars: 1800,
        },
      }),
    );

    expect(stores.facts.searchFacts).not.toHaveBeenCalled();
    expect(stores.entries.searchEntries).not.toHaveBeenCalled();
    expect(stores.session.searchSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ session: [], facts: [], entries: [] });
  });
});
