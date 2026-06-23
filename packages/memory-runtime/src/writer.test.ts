import { describe, expect, it } from "vitest";
import { DefaultMemoryStore } from "./store.js";
import { DefaultMemoryWriterRuntime } from "./writer.js";
import { DefaultMemoryRetriever } from "./retrieval.js";
import type {
  EntryMemory,
  FactMemory,
  MemoryContract,
  SessionMemory,
} from "./types.js";

const now = "2026-06-02T00:00:00.000Z";

function fact(overrides: Partial<FactMemory> = {}): FactMemory {
  return {
    id: overrides.id ?? "fact-1",
    scope: "fact",
    subject: overrides.subject ?? "profile",
    content: overrides.content ?? "The user prefers concise Chinese replies.",
    confidence: overrides.confidence ?? 0.8,
    sourceRefs: overrides.sourceRefs ?? ["test"],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    metadata: overrides.metadata,
  };
}

function entry(overrides: Partial<EntryMemory> = {}): EntryMemory {
  return {
    id: overrides.id ?? "entry-1",
    scope: "entry",
    kind: overrides.kind ?? "conversation",
    content: overrides.content ?? "Discussed Universal Memory Layer design.",
    entities: overrides.entities ?? ["memory"],
    timestamp: overrides.timestamp ?? now,
    sourceRefs: overrides.sourceRefs ?? ["session"],
    metadata: overrides.metadata,
  };
}

function session(overrides: Partial<SessionMemory> = {}): SessionMemory {
  return {
    scope: "session",
    sessionId: overrides.sessionId ?? "session-1",
    turns: overrides.turns ?? [{ role: "user", content: "hello" }],
    summary: overrides.summary,
    topicState: overrides.topicState,
    metadata: overrides.metadata,
  };
}

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

describe("DefaultMemoryWriterRuntime", () => {
  it("merges duplicate facts and keeps the stronger source metadata", async () => {
    const store = new DefaultMemoryStore({
      facts: [fact({ id: "existing", confidence: 0.7, sourceRefs: ["old"] })],
    });
    const writer = new DefaultMemoryWriterRuntime({ store });

    const [result] = await writer.write([
      {
        operation: "upsert",
        item: fact({
          id: "incoming",
          confidence: 0.95,
          sourceRefs: ["new"],
        }),
      },
    ]);

    expect(result.decision.action).toBe("merge");
    expect(result.decision.reasonCode).toBe("duplicate_content");
    expect(await store.listFacts()).toHaveLength(1);
    expect((await store.listFacts())[0].confidence).toBe(0.95);
    expect((await store.listFacts())[0].sourceRefs).toEqual(["old", "new"]);
  });

  it("skips lower-confidence identity facts for the same user subject", async () => {
    const store = new DefaultMemoryStore({
      facts: [
        fact({
          id: "profile",
          subject: "user",
          content: "The user is named David Liu.",
          confidence: 0.95,
        }),
      ],
    });
    const writer = new DefaultMemoryWriterRuntime({ store });

    const [result] = await writer.write([
      {
        operation: "upsert",
        item: fact({
          id: "conflict",
          subject: "user",
          content: "The user is named Alice.",
          confidence: 0.5,
        }),
      },
    ]);

    expect(result.decision.action).toBe("skip");
    expect(result.decision.reasonCode).toBe("lower_confidence_conflict");
    expect(await store.listFacts()).toHaveLength(1);
  });

  it("keeps distinct profile facts even when they share the profile subject", async () => {
    const store = new DefaultMemoryStore({
      facts: [
        fact({
          id: "cycling",
          subject: "profile",
          content: "The user enjoys cycling.",
          confidence: 0.7,
        }),
      ],
    });
    const writer = new DefaultMemoryWriterRuntime({ store });

    const [result] = await writer.write([
      {
        operation: "upsert",
        item: fact({
          id: "hiking",
          subject: "profile",
          content: "The user enjoys hiking.",
          confidence: 0.8,
        }),
      },
    ]);

    expect(result.decision.action).toBe("insert");
    expect(result.decision.reasonCode).toBe("new_memory");
    expect(await store.listFacts()).toHaveLength(2);
  });

  it("upserts sessions and exposes the same store through retrieval adapters", async () => {
    const store = new DefaultMemoryStore({
      entries: [entry()],
    });
    const events: string[] = [];
    const writer = new DefaultMemoryWriterRuntime({
      store,
      observer(event) {
        events.push(event.type);
      },
    });

    await writer.write([
      {
        operation: "upsert",
        item: session({
          summary: "Discussed Universal Memory Layer write runtime.",
        }),
      },
    ]);

    const retriever = new DefaultMemoryRetriever({
      stores: { facts: store, entries: store, session: store },
      sessionId: "session-1",
    });
    const result = await retriever.retrieve(contract("Universal Memory Layer"));

    expect(events).toContain("memory_write_started");
    expect(events).toContain("memory_write_finished");
    expect(result.session).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
  });

  it("emits item summaries for write observability", async () => {
    const store = new DefaultMemoryStore();
    const events: unknown[] = [];
    const writer = new DefaultMemoryWriterRuntime({
      store,
      observer(event) {
        events.push(event);
      },
    });

    await writer.write([
      {
        operation: "upsert",
        item: fact({
          id: "fact-observed",
          subject: "preference",
          content: "The user prefers runtime memory write logs.",
          confidence: 0.92,
          metadata: { category: "interaction_style", importance: 9 },
        }),
      },
    ]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "memory_write_decision",
        scope: "fact",
        id: "fact-observed",
        item: expect.objectContaining({
          scope: "fact",
          subject: "preference",
          contentPreview: "The user prefers runtime memory write logs.",
          confidence: 0.92,
          metadata: { category: "interaction_style", importance: 9 },
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "memory_write_finished",
        written: 1,
        results: [
          expect.objectContaining({
            scope: "fact",
            written: true,
            item: expect.objectContaining({
              contentPreview: "The user prefers runtime memory write logs.",
            }),
          }),
        ],
      }),
    );
  });
});
