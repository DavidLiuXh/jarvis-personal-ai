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
