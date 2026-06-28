import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultLayeredMemoryRuntime } from "./layeredMemoryRuntime.js";
import { SqliteMemoryStore } from "./sqliteMemoryStore.js";
import type { EntryMemory, FactMemory, SessionMemory } from "./types.js";

const now = "2026-06-02T00:00:00.000Z";

function dbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-runtime-sqlite-"));
  return path.join(dir, "memory.db");
}

describe("SqliteMemoryStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("owns the facts, memories, and summary chunk schema", async () => {
    const store = new SqliteMemoryStore({ dbPath: dbPath() });
    const fact: FactMemory = {
      id: "fact-1",
      scope: "fact",
      subject: "profile",
      content: "The user is building a universal memory runtime.",
      confidence: 0.9,
      sourceRefs: ["test"],
      createdAt: now,
      updatedAt: now,
    };
    const entry: EntryMemory = {
      id: "entry-1",
      scope: "entry",
      kind: "conversation",
      content: "Discussed facts, memories, and summary chunks.",
      entities: ["memory"],
      timestamp: now,
      sourceRefs: ["session-1"],
    };
    const session: SessionMemory = {
      scope: "session",
      sessionId: "session-1",
      turns: [{ role: "user", content: "memory runtime", timestamp: now }],
      summary: "Universal memory runtime stores facts and session summaries.",
    };

    const savedFact = await store.upsertFact(fact);
    const savedEntry = await store.upsertEntry(entry);
    await store.upsertSession(session);

    expect(Number(savedFact.id)).toBeGreaterThan(0);
    expect(Number(savedEntry.id)).toBeGreaterThan(0);
    expect(await store.searchFacts("universal memory")).toHaveLength(1);
    expect(await store.searchEntries("summary chunks")).toHaveLength(1);
    expect(await store.searchSession("session summaries")).toHaveLength(1);

    const tables = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')",
      )
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((table) => table.name));
    expect(tableNames.has("facts")).toBe(true);
    expect(tableNames.has("memories")).toBe(true);
    expect(tableNames.has("summary_chunks_index")).toBe(true);
    expect(tableNames.has("facts_fts")).toBe(true);
    store.close();
  });

  it("filters session summary search by date range through session entries", async () => {
    const store = new SqliteMemoryStore({ dbPath: dbPath() });
    await store.upsertEntry({
      id: "entry-yesterday",
      scope: "entry",
      kind: "conversation",
      content: "Discussed Universal Memory yesterday.",
      entities: ["memory"],
      timestamp: "2026-06-01T10:00:00+08:00",
      sourceRefs: ["session-yesterday"],
    });
    await store.upsertSession({
      scope: "session",
      sessionId: "session-yesterday",
      turns: [
        {
          role: "user",
          content: "Universal Memory yesterday",
          timestamp: "2026-06-01T10:00:00+08:00",
        },
      ],
      summary: "Universal Memory discussion from yesterday.",
    });
    await store.upsertEntry({
      id: "entry-today",
      scope: "entry",
      kind: "conversation",
      content: "Discussed Universal Memory today.",
      entities: ["memory"],
      timestamp: "2026-06-02T10:00:00+08:00",
      sourceRefs: ["session-today"],
    });
    await store.upsertSession({
      scope: "session",
      sessionId: "session-today",
      turns: [
        {
          role: "user",
          content: "Universal Memory today",
          timestamp: "2026-06-02T10:00:00+08:00",
        },
      ],
      summary: "Universal Memory discussion from today.",
    });

    const results = await store.searchSession("Universal Memory discussion", {
      limit: 5,
      dateRange: {
        from: Date.parse("2026-06-01T00:00:00+08:00"),
        to: Date.parse("2026-06-02T00:00:00+08:00"),
      },
    });

    expect(results.map((result) => result.sessionId)).toEqual([
      "session-yesterday",
    ]);
    store.close();
  });

  it("logs retrieved fact item previews for diagnostics", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new SqliteMemoryStore({ dbPath: dbPath() });
    await store.upsertFact({
      id: "fact-1",
      scope: "fact",
      subject: "profile",
      content: "The user enjoys hiking as a personal hobby.",
      confidence: 0.8,
      sourceRefs: ["test"],
      createdAt: now,
      updatedAt: now,
      metadata: { category: "behavior", importance: 8 },
    });

    const results = await store.searchFacts("hiking hobby", { limit: 1 });

    expect(results).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[MemoryRetrieval] facts.search item"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("category=behavior"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'preview="The user enjoys hiking as a personal hobby."',
      ),
    );
    store.close();
  });

  it("recalls short Chinese hobby facts for user-memory queries", async () => {
    const store = new SqliteMemoryStore({ dbPath: dbPath() });
    const facts: Array<Pick<FactMemory, "content" | "confidence">> = [
      {
        content:
          "USER is interested in Chrome extension development and commercialisation.",
        confidence: 0.7,
      },
      {
        content:
          "The user wants to know about successful cases of monetising a free tool into paid tools.",
        confidence: 0.7,
      },
      { content: "爱好骑自行车", confidence: 0.6 },
      { content: "爱好逛胡同", confidence: 0.6 },
    ];

    for (const fact of facts) {
      await store.upsertFact({
        id: "",
        scope: "fact",
        subject: "profile",
        content: fact.content,
        confidence: fact.confidence,
        sourceRefs: ["test"],
        createdAt: now,
        updatedAt: now,
        metadata: {
          category: "behavior",
          importance: Math.round(fact.confidence * 10),
        },
      });
    }

    const results = await store.searchFacts(
      "你记录了我有哪些爱好？ user_memory",
      {
        limit: 5,
        contract: {
          needMemory: true,
          subjectBoundary: "personal",
          targetScopes: ["fact"],
          memoryTarget: "user_memory",
          query: {
            raw: "你记录了我有哪些爱好？",
            entities: ["爱好"],
          },
          confidence: {
            subject: 1,
            target: 1,
            query: 1,
          },
          constraints: {
            allowPersonalFacts: true,
            allowSessionHistory: false,
            allowEntries: false,
            maxChars: 1000,
          },
          reasons: [],
          policyTrace: [],
        },
      },
    );

    expect(results.map((result) => result.content)).toEqual(
      expect.arrayContaining(["爱好骑自行车", "爱好逛胡同"]),
    );
    store.close();
  });

  it("works through DefaultLayeredMemoryRuntime", async () => {
    const store = new SqliteMemoryStore({ dbPath: dbPath() });
    const runtime = new DefaultLayeredMemoryRuntime({
      stores: { facts: store, entries: store, session: store },
      writeStore: store,
      sessionId: "runtime-session",
    });

    await runtime.saveEntry({
      id: "entry-runtime",
      scope: "entry",
      kind: "event",
      content: "Runtime event about SQLite-backed memory.",
      entities: ["sqlite"],
      timestamp: now,
      sourceRefs: ["runtime-session"],
    });

    expect(
      await runtime.searchEntries({ query: "SQLite-backed" }),
    ).toHaveLength(1);
    store.close();
  });
});
