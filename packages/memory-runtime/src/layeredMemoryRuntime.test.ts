import { describe, expect, it } from "vitest";
import { DefaultLayeredMemoryRuntime } from "./layeredMemoryRuntime.js";
import { DefaultMemoryStore } from "./store.js";
import type {
  EntryMemory,
  FactMemory,
  MemoryContract,
  SessionMemory,
} from "./types.js";

const now = "2026-06-02T00:00:00.000Z";

function contract(query: string): MemoryContract {
  return {
    needMemory: true,
    subjectBoundary: "personal",
    targetScopes: ["session", "fact", "entry"],
    memoryTarget: "conversation_history",
    query: { raw: query, entities: ["memory"] },
    confidence: { subject: 1, target: 1, query: 1 },
    constraints: {
      allowPersonalFacts: true,
      allowSessionHistory: true,
      allowEntries: true,
      maxChars: 1000,
    },
    reasons: ["test"],
    policyTrace: [],
  };
}

describe("DefaultLayeredMemoryRuntime", () => {
  it("saves, searches, and recalls all three memory layers", async () => {
    const store = new DefaultMemoryStore();
    const runtime = new DefaultLayeredMemoryRuntime({
      stores: { facts: store, entries: store, session: store },
      writeStore: store,
      sessionId: "session-1",
    });
    const fact: FactMemory = {
      id: "fact-1",
      scope: "fact",
      subject: "profile",
      content: "The user is designing a Universal Memory Layer.",
      confidence: 0.95,
      sourceRefs: ["test"],
      createdAt: now,
      updatedAt: now,
    };
    const entry: EntryMemory = {
      id: "entry-1",
      scope: "entry",
      kind: "conversation",
      content: "Discussed three-layer memory runtime responsibilities.",
      entities: ["memory"],
      timestamp: now,
      sourceRefs: ["session-1"],
    };
    const session: SessionMemory = {
      scope: "session",
      sessionId: "session-1",
      turns: [{ role: "user", content: "Universal Memory Layer" }],
      summary: "Universal Memory Layer discussion.",
    };

    expect((await runtime.saveFact(fact)).written?.content).toContain(
      "Universal Memory Layer",
    );
    expect((await runtime.saveEntry(entry)).written?.kind).toBe("conversation");
    expect((await runtime.saveSession(session)).written?.sessionId).toBe(
      "session-1",
    );

    expect(
      await runtime.searchFacts({ query: "Universal Memory" }),
    ).toHaveLength(1);
    expect(
      await runtime.searchEntries({ query: "three-layer memory" }),
    ).toHaveLength(1);
    expect(
      await runtime.searchSession({ query: "Universal Memory" }),
    ).toHaveLength(1);

    const recalled = await runtime.recall(contract("Universal Memory"));
    expect(recalled.facts).toHaveLength(1);
    expect(recalled.entries).toHaveLength(1);
    expect(recalled.session).toHaveLength(1);
  });
});
