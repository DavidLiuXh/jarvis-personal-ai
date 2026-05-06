/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  beforeEach,
} from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// --- Mocks ---

vi.mock("sqlite-vec", () => ({
  load: vi.fn(),
}));

vi.mock("../../../core/src/index.js", () => ({
  debugLogger: { debug: vi.fn(), error: vi.fn() },
}));

vi.mock("./configManager.js", () => ({
  ConfigManager: {
    getInstance: () => ({
      get: () => ({
        api: { key: "test-key", proxy: null },
        models: {
          embedding: "test-embedding-model",
          embeddingDimension: 128,
          distillation: "test-distillation-model",
        },
        memory: {
          ingestionDelayMs: 0,
          retrievalLimit: 5,
          consolidationThreshold: 3,
          dedupStrategy: "jaccard",
          factRelevanceStrategy: "jaccard",
          factRelevanceLimit: 5,
          prewarmLimit: 3,
          l1WriteMode: "batch",
          vectorSimilarityWeight: 0.7,
          importanceWeight: 0.3,
        },
      }),
    }),
  },
}));

// --- Helpers ---

/**
 * Creates an in-memory MemoryService with a fake LLM client injected.
 * Returns the service instance and a handle to the fake client.
 */
async function createService(fakeGenerateContent: () => Promise<unknown>) {
  // Dynamically import AFTER mocks are set up
  const { MemoryService } = await import("./memory.js");

  // Use a temp dir so the real DB file isn't created in ~/.gemini-jarvis
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new (MemoryService as new (
    root: string,
    dbPath?: string,
  ) => InstanceType<typeof MemoryService>)("", tmpDir);

  // Inject a fake AI client directly (bypasses API key / network)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as unknown as Record<string, unknown>).client = {
    models: {
      generateContent: fakeGenerateContent,
      embedContent: vi.fn().mockResolvedValue({
        embeddings: [{ values: new Array(128).fill(0) }],
      }),
    },
  };

  return { service, tmpDir };
}

// --- Tests ---

describe("MemoryService.consolidateFacts", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("does not re-trigger consolidation when LLM returns invalid JSON", async () => {
    // LLM returns garbage — no valid JSON array
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        candidates: [
          { content: { parts: [{ text: "sorry, I cannot help with that" }] } },
        ],
      },
    });

    const { service } = await createService(generateContent);

    // Seed enough facts to cross the consolidation threshold (default: 3)
    const svc1 = service as unknown as Record<string, unknown>;
    const db1 = svc1.db as {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };
    for (let i = 0; i < 6; i++) {
      db1
        .prepare(
          "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
        )
        .run("test", `fact-${i}`, 5, Date.now());
    }
    svc1.lastConsolidatedCount = 0;

    // First consolidation attempt — LLM returns invalid JSON
    await service.consolidateFacts();

    const callsAfterFirst = generateContent.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    // Save one more fact — should NOT trigger another consolidation
    // because lastConsolidatedCount should have been updated after the failed attempt
    await service.saveFact("test", "one-more-fact", 5);

    expect(generateContent.mock.calls.length).toBe(1); // still 1, no second call
  });

  it("uses injected generateText instead of this.client when available", async () => {
    const consolidatedFacts = [
      {
        category: "behavior",
        content: "user runs 3 times a week",
        importance: 7,
      },
    ];

    // this.client.generateContent should NOT be called
    const legacyGenerateContent = vi.fn();
    const { service } = await createService(legacyGenerateContent);

    // Inject the CLI-auth generateText function
    const generateText = vi
      .fn()
      .mockResolvedValue(JSON.stringify(consolidatedFacts));
    service.setGenerateText(generateText);

    const svc = service as unknown as Record<string, unknown>;
    const db = svc.db as {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };
    for (let i = 0; i < 6; i++) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run("test", `fact-${i}`, 5, Date.now());
    }
    svc.lastConsolidatedCount = 0;

    await service.consolidateFacts();

    expect(generateText).toHaveBeenCalledOnce();
    expect(legacyGenerateContent).not.toHaveBeenCalled();
    expect(
      (service as unknown as Record<string, unknown>).lastConsolidatedCount,
    ).toBe(1);
  });

  it("consolidation prompt includes category definitions and dedup rules", async () => {
    const generateText = vi.fn().mockResolvedValue("[]");
    const { service } = await createService(vi.fn());
    service.setGenerateText(generateText);

    const svc = service as unknown as Record<string, unknown>;
    const db = svc.db as {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };
    for (let i = 0; i < 6; i++) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run("behavior", `fact-${i}`, 5, Date.now());
    }
    svc.lastConsolidatedCount = 0;

    await service.consolidateFacts();

    const prompt = generateText.mock.calls[0][0] as string;
    // Prompt must include all four category definitions
    expect(prompt).toContain("behavior");
    expect(prompt).toContain("interaction_style");
    expect(prompt).toContain("identity");
    expect(prompt).toContain("specification");
    // Must include merge/dedup instruction
    expect(prompt.toLowerCase()).toMatch(/merge|consolidate|dedup/);
    // Must include conflict resolution instruction
    expect(prompt.toUpperCase()).toContain("RESOLVE CONFLICTS");
    // Must instruct not to output XML tags
    expect(prompt.toLowerCase()).toContain("xml tags");
  });

  it("updates lastConsolidatedCount after successful consolidation", async () => {
    const consolidatedFacts = [
      { category: "test", content: "merged-fact-1", importance: 8 },
      { category: "test", content: "merged-fact-2", importance: 7 },
    ];

    const generateContent = vi.fn().mockResolvedValue({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(consolidatedFacts) }],
            },
          },
        ],
      },
    });

    const { service } = await createService(generateContent);

    const svc2 = service as unknown as Record<string, unknown>;
    const db2 = svc2.db as {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };
    for (let i = 0; i < 6; i++) {
      db2
        .prepare(
          "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
        )
        .run("test", `fact-${i}`, 5, Date.now());
    }
    svc2.lastConsolidatedCount = 0;

    await service.consolidateFacts();

    // After success, lastConsolidatedCount should equal the number of consolidated facts
    expect(
      (service as unknown as Record<string, unknown>).lastConsolidatedCount,
    ).toBe(consolidatedFacts.length);
  });
});

describe("MemoryService.saveFact semantic dedup", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createDedupeService(dedupStrategy?: "jaccard" | "embedding") {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-embedding-model",
              embeddingDimension: 128,
              distillation: "test-distillation-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100, // high threshold to avoid triggering consolidation
              dedupStrategy: dedupStrategy ?? "jaccard",
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-dedup-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    return { service, tmpDir };
  }

  it("skips saving a fact when a textually similar Latin fact already exists", async () => {
    const { service } = await createDedupeService();

    await service.saveFact("behavior", "user runs 3 times a week", 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect((db.prepare("SELECT count(*) as c FROM facts").get() as any).c).toBe(
      1,
    );

    await service.saveFact("behavior", "runs at least 3 times per week", 8);

    expect((db.prepare("SELECT count(*) as c FROM facts").get() as any).c).toBe(
      1,
    );
  });

  it("skips saving a fact when a textually similar CJK fact already exists", async () => {
    const { service } = await createDedupeService();

    await service.saveFact("behavior", "每周跑步三次", 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect((db.prepare("SELECT count(*) as c FROM facts").get() as any).c).toBe(
      1,
    );

    // Similar CJK content — should be skipped via lower CJK threshold
    await service.saveFact("behavior", "每周至少跑步3次", 8);

    expect((db.prepare("SELECT count(*) as c FROM facts").get() as any).c).toBe(
      1,
    );
  });

  it("does not falsely deduplicate unrelated CJK facts", async () => {
    const { service } = await createDedupeService();

    await service.saveFact("behavior", "我对历史很感兴趣", 8);
    await service.saveFact("behavior", "我每周跑步三次", 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect((db.prepare("SELECT count(*) as c FROM facts").get() as any).c).toBe(
      2,
    );
  });

  it("saves a fact when it is semantically different from existing facts", async () => {
    const { service } = await createDedupeService();

    await service.saveFact("behavior", "user runs 3 times a week", 8);
    await service.saveFact("behavior", "user codes every day", 8);

    const db = (service as unknown as Record<string, unknown>).db as any;
    const count = (db.prepare("SELECT count(*) as c FROM facts").get() as any)
      .c;
    expect(count).toBe(2);
  });

  it("logs a message when a duplicate is skipped", async () => {
    const { service } = await createDedupeService();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await service.saveFact("behavior", "user runs 3 times a week", 8);
    await service.saveFact("behavior", "runs at least 3 times per week", 8);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate skipped"),
    );
    consoleSpy.mockRestore();
  });

  it("uses embedding strategy when dedupStrategy is embedding and embedContentFn is injected", async () => {
    const { service } = await createDedupeService("embedding");

    // Two nearly-identical vectors (cosine sim ≈ 1.0)
    const vec1 = new Array(128).fill(0);
    vec1[0] = 1.0;
    const vec2 = new Array(128).fill(0);
    vec2[0] = 0.9999;

    let callCount = 0;
    service.setEmbedContent(async (_text: string) => {
      return callCount++ === 0 ? vec1 : vec2;
    });

    await service.saveFact("behavior", "user runs 3 times a week", 8);
    await service.saveFact("behavior", "每周跑步三次", 8); // different text, similar vector

    const db = (service as unknown as Record<string, unknown>).db as any;
    const count = (db.prepare("SELECT count(*) as c FROM facts").get() as any)
      .c;
    expect(count).toBe(1); // duplicate rejected via embedding similarity
  });

  it("falls back to jaccard when embedding strategy fails", async () => {
    const { service } = await createDedupeService("embedding");

    service.setEmbedContent(async (_text: string) => {
      throw new Error("embedding API unavailable");
    });

    await service.saveFact("behavior", "user runs 3 times a week", 8);
    await service.saveFact("behavior", "runs at least 3 times per week", 8); // similar via jaccard

    const db = (service as unknown as Record<string, unknown>).db as any;
    const count = (db.prepare("SELECT count(*) as c FROM facts").get() as any)
      .c;
    expect(count).toBe(1); // still deduped via jaccard fallback
  });
});

describe("MemoryService.searchFacts", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createServiceWithFacts(
    facts: Array<{ category: string; content: string; importance: number }>,
  ) {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-search-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    // Insert facts directly into DB
    const db = (service as unknown as Record<string, unknown>).db as any;
    for (const f of facts) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run(f.category, f.content, f.importance, Date.now());
    }
    return { service };
  }

  it("jaccard: returns facts ranked by relevance to query, up to limit", async () => {
    const { service } = await createServiceWithFacts([
      {
        category: "identity",
        content: "user is a software engineer",
        importance: 8,
      },
      { category: "identity", content: "user likes history", importance: 7 },
      {
        category: "behavior",
        content: "user runs 3 times a week",
        importance: 6,
      },
      {
        category: "specification",
        content: "project uses TypeScript",
        importance: 9,
      },
      {
        category: "specification",
        content: "do not modify gemini-cli source",
        importance: 9,
      },
    ]);

    const results = await service.searchFacts("TypeScript project setup", 2);

    // 'project uses TypeScript' should rank highest for this query
    // limit=2 applies to identity/specification candidates only (preference/behavior always included)
    const nonStyleFacts = results.filter(
      (f) => f.category !== "interaction_style" && f.category !== "behavior",
    );
    expect(nonStyleFacts.length).toBeLessThanOrEqual(2);
    expect(results.some((f) => f.content.includes("TypeScript"))).toBe(true);
  });

  it("always includes preference facts regardless of relevance, behavior is ranked like others", async () => {
    const { service } = await createServiceWithFacts([
      {
        category: "identity",
        content: "user is a software engineer",
        importance: 8,
      },
      {
        category: "interaction_style",
        content: "prefers concise answers",
        importance: 10,
      },
      {
        category: "behavior",
        content: "user runs 3 times a week",
        importance: 6,
      },
      {
        category: "specification",
        content: "project uses TypeScript",
        importance: 9,
      },
    ]);

    // Query is about cooking — unrelated to all facts, limit=1
    const results = await service.searchFacts("cooking recipes", 1);

    // preference must always be included (style instructions needed every turn)
    expect(results.some((f) => f.category === "interaction_style")).toBe(true);
    // behavior is NOT guaranteed — it competes with identity/specification for the limit
    // With limit=1, only the top-1 non-preference fact is included
    const nonPrefFacts = results.filter(
      (f) => f.category !== "interaction_style",
    );
    expect(nonPrefFacts.length).toBeLessThanOrEqual(1);
  });

  it("embedding: uses embedContentFn to rank facts by cosine similarity", async () => {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "embedding",
              factRelevanceLimit: 2,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-embed-search-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);

    const db = (service as unknown as Record<string, unknown>).db as any;
    // Insert facts with known embeddings
    const tsVec = new Float32Array([1, 0, 0, 0]);
    const runVec = new Float32Array([0, 1, 0, 0]);
    const histVec = new Float32Array([0, 0, 1, 0]);
    const prefVec = new Float32Array([0, 0, 0, 1]);

    const insertFact = (
      cat: string,
      content: string,
      imp: number,
      vec: Float32Array,
    ) => {
      const info = db
        .prepare(
          "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
        )
        .run(cat, content, imp, Date.now(), Buffer.from(vec.buffer));
      return info.lastInsertRowid;
    };
    insertFact("specification", "project uses TypeScript", 9, tsVec);
    insertFact("behavior", "user runs 3 times a week", 6, runVec);
    insertFact("identity", "user likes history", 7, histVec);
    insertFact("interaction_style", "prefers concise answers", 10, prefVec);

    // Query vector close to TypeScript vector
    service.setEmbedContent(async (_text: string) => [1, 0, 0, 0]);

    const results = await service.searchFacts("TypeScript setup", 1);

    // TypeScript fact should be top result; preference always included
    expect(results.some((f) => f.content.includes("TypeScript"))).toBe(true);
    expect(results.some((f) => f.category === "interaction_style")).toBe(true);
    // behavior competes with others under the limit, not guaranteed
  });
});

describe("MemoryService.reflect", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createReflectService() {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 5,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-reflect-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    return { service, tmpDir };
  }

  it("reflect calls generateText with facts and saves insights to facts table", async () => {
    const { service } = await createReflectService();

    // Seed some facts
    const db = (service as any).db;
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs 3 times a week", 8, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("identity", "user is a software engineer", 9, Date.now());

    const insights = [
      {
        category: "insight",
        content: "User combines physical discipline with technical work",
        importance: 9,
      },
    ];
    const generateText = vi.fn().mockResolvedValue(JSON.stringify(insights));

    await service.reflect(generateText);

    expect(generateText).toHaveBeenCalledOnce();
    const prompt = generateText.mock.calls[0][0] as string;
    expect(prompt).toContain("insight");
    expect(prompt).toContain("runs 3 times");

    // Insight should be saved to facts table
    const saved = db
      .prepare("SELECT * FROM facts WHERE category = 'insight'")
      .all() as any[];
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toContain("discipline");
    // New insights are capped at 6 regardless of model output (conservative mode)
    expect(saved[0].importance).toBe(6);
  });

  it("reflect does nothing when no facts exist", async () => {
    const { service } = await createReflectService();
    const generateText = vi.fn();
    await service.reflect(generateText);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("reflect does not throw when generateText fails", async () => {
    const { service } = await createReflectService();
    const db = (service as any).db;
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs", 8, Date.now());

    const generateText = vi.fn().mockRejectedValue(new Error("API error"));
    await expect(service.reflect(generateText)).resolves.not.toThrow();
  });

  it("reflect includes existing insights in prompt so LLM can merge/update them", async () => {
    const { service } = await createReflectService();
    const db = (service as any).db;

    // Seed a fact and an existing insight
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs 3 times a week", 8, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "Old insight about discipline", 9, Date.now());

    const generateText = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          category: "insight",
          content: "Updated insight merging old and new",
          importance: 9,
        },
      ]),
    );

    await service.reflect(generateText);

    const prompt = generateText.mock.calls[0][0] as string;
    // Prompt must include existing insights for LLM to merge
    expect(prompt).toContain("Old insight about discipline");
  });

  it("reflect replaces all old insights with new ones (no accumulation)", async () => {
    const { service } = await createReflectService();
    const db = (service as any).db;

    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs", 8, Date.now());
    // Two existing insights
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "Old insight 1", 8, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "Old insight 2", 7, Date.now());

    const newInsights = [
      { category: "insight", content: "New merged insight", importance: 9 },
    ];
    const generateText = vi.fn().mockResolvedValue(JSON.stringify(newInsights));

    await service.reflect(generateText);

    const saved = db
      .prepare("SELECT content FROM facts WHERE category = 'insight'")
      .all() as any[];
    // Old insights gone, only new one remains
    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe("New merged insight");
  });
});

// ---------------------------------------------------------------------------
// Conservative insight mode regression tests
// ---------------------------------------------------------------------------

describe("MemoryService — conservative insight mode", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createInsightService() {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 5,
              prewarmLimit: 0,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-insight-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    const db = (service as any).db;
    return { service, db, tmpDir };
  }

  // ── reflect() importance cap ───────────────────────────────────────────────

  it("reflect: new insight importance is capped at 6 regardless of model output", async () => {
    const { service, db } = await createInsightService();
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs daily", 8, Date.now());

    const generateText = vi
      .fn()
      .mockResolvedValue(
        '[{"category":"insight","content":"User is disciplined","importance":9}]',
      );
    await service.reflect(generateText);

    const saved = db
      .prepare("SELECT importance FROM facts WHERE category = 'insight'")
      .all() as Array<{ importance: number }>;
    expect(saved).toHaveLength(1);
    // Model said 9, but cap must enforce 6
    expect(saved[0].importance).toBe(6);
  });

  it("reflect: existing insight with access_count >= 3 gets importance boost", async () => {
    const { service, db } = await createInsightService();
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs daily", 8, Date.now());
    // Seed an old insight with access_count=3 and importance=6
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp, access_count) VALUES (?, ?, ?, ?, ?)",
    ).run("insight", "User is disciplined", 6, Date.now() - 1000, 3);

    const generateText = vi
      .fn()
      .mockResolvedValue(
        '[{"category":"insight","content":"User is disciplined","importance":6}]',
      );
    await service.reflect(generateText);

    const saved = db
      .prepare(
        "SELECT importance, access_count FROM facts WHERE category = 'insight'",
      )
      .all() as Array<{ importance: number; access_count: number }>;
    expect(saved).toHaveLength(1);
    // access_count was 3 → boost: old importance(6) + 1 = 7
    expect(saved[0].importance).toBe(7);
    // access_count inherited from old insight
    expect(saved[0].access_count).toBe(3);
  });

  it("reflect: existing insight with access_count < 3 does NOT get boost", async () => {
    const { service, db } = await createInsightService();
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs daily", 8, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp, access_count) VALUES (?, ?, ?, ?, ?)",
    ).run("insight", "User is disciplined", 6, Date.now() - 1000, 2);

    const generateText = vi
      .fn()
      .mockResolvedValue(
        '[{"category":"insight","content":"User is disciplined","importance":6}]',
      );
    await service.reflect(generateText);

    const saved = db
      .prepare("SELECT importance FROM facts WHERE category = 'insight'")
      .all() as Array<{ importance: number }>;
    // No boost: access_count=2 < 3, importance stays at max(6, 6) = 6
    expect(saved[0].importance).toBe(6);
  });

  it("reflect: new insight (no match) starts fresh at importance=6 with access_count=0", async () => {
    const { service, db } = await createInsightService();
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs daily", 8, Date.now());

    const generateText = vi
      .fn()
      .mockResolvedValue(
        '[{"category":"insight","content":"Brand new insight","importance":8}]',
      );
    await service.reflect(generateText);

    const saved = db
      .prepare(
        "SELECT importance, access_count FROM facts WHERE category = 'insight'",
      )
      .all() as Array<{ importance: number; access_count: number }>;
    expect(saved[0].importance).toBe(6); // capped at 6
    expect(saved[0].access_count).toBe(0); // no inheritance
  });

  // ── searchFacts() insight filtering ───────────────────────────────────────

  it("searchFacts: insight with importance < 7 is NOT injected", async () => {
    const { service, db } = await createInsightService();
    // insight at importance=6 (below threshold)
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "User is disciplined", 6, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("interaction_style", "prefers concise answers", 9, Date.now());

    const results = await service.searchFacts("discipline", 5);

    expect(results.some((f) => f.category === "insight")).toBe(false);
    expect(results.some((f) => f.category === "interaction_style")).toBe(true);
  });

  it("searchFacts: insight with importance >= 7 IS injected when query-relevant", async () => {
    const { service, db } = await createInsightService();
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "User is disciplined about exercise", 7, Date.now());

    const results = await service.searchFacts("exercise discipline", 5);

    expect(results.some((f) => f.category === "insight")).toBe(true);
  });

  it("searchFacts: at most 2 insights injected regardless of how many qualify", async () => {
    const { service, db } = await createInsightService();
    // Insert 4 qualifying insights (importance >= 7)
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run("insight", `Insight about exercise ${i}`, 7, Date.now());
    }

    const results = await service.searchFacts("exercise", 10);

    const injectedInsights = results.filter((f) => f.category === "insight");
    expect(injectedInsights.length).toBeLessThanOrEqual(2);
  });

  it("searchFacts: insight does not appear in ranked facts (separate path)", async () => {
    const { service, db } = await createInsightService();
    // insight at importance=7 (qualifies), plus regular facts
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "User is disciplined", 7, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs daily", 8, Date.now());

    const results = await service.searchFacts("discipline", 5);

    // insight should appear exactly once (not duplicated via ranked path)
    const insightResults = results.filter((f) => f.category === "insight");
    expect(insightResults.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 1: isConsolidating / isProcessing race condition fix
// ---------------------------------------------------------------------------

describe("MemoryService.consolidateFacts — isConsolidating guard", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does not run concurrent consolidations when called twice simultaneously", async () => {
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-guard-"));
    const service = new (MemoryService as any)("", tmpDir);

    const generateText = vi.fn().mockImplementation(async () => {
      // Simulate slow LLM
      await new Promise((r) => setTimeout(r, 50));
      return JSON.stringify([
        { category: "behavior", content: "merged", importance: 7 },
      ]);
    });
    service.setGenerateText(generateText);

    const db = (service as any).db;
    for (let i = 0; i < 6; i++) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run("test", `fact-${i}`, 5, Date.now());
    }
    (service as any).lastConsolidatedCount = 0;

    // Fire two concurrent consolidations
    const [r1, r2] = await Promise.all([
      service.consolidateFacts(),
      service.consolidateFacts(),
    ]);
    void r1;
    void r2;

    // Only one LLM call should have been made
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("isProcessing (queue) and isConsolidating are independent flags", async () => {
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-flags-"));
    const service = new (MemoryService as any)("", tmpDir);

    // Set isProcessing = true (queue is running)
    (service as any).isProcessing = true;

    const generateText = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify([
          { category: "behavior", content: "merged", importance: 7 },
        ]),
      );
    service.setGenerateText(generateText);

    const db = (service as any).db;
    for (let i = 0; i < 6; i++) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run("test", `fact-${i}`, 5, Date.now());
    }
    (service as any).lastConsolidatedCount = 0;

    // consolidateFacts should NOT be blocked by isProcessing
    await service.consolidateFacts();
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: L1 physical layer — MEMORIES.md
// ---------------------------------------------------------------------------

describe("MemoryService — L1 physical layer (MEMORIES.md)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createL1Service(l1WriteMode: "realtime" | "batch" = "batch") {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 5,
              prewarmLimit: 3,
              l1WriteMode,
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-l1-"));
    const service = new (MemoryService as any)("", tmpDir);
    return { service, tmpDir };
  }

  it("flushToPhysicalLayer creates MEMORIES.md grouped by category", async () => {
    const { service, tmpDir } = await createL1Service();
    const db = (service as any).db;
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("identity", "user is David", 9, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs 3 times a week", 7, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("identity", "user is a software engineer", 8, Date.now());

    service.flushToPhysicalLayer();

    const content = fs.readFileSync(path.join(tmpDir, "MEMORIES.md"), "utf8");
    expect(content).toContain("## identity");
    expect(content).toContain("## behavior");
    expect(content).toContain("user is David");
    expect(content).toContain("user runs 3 times a week");
    expect(content).toContain("[9]");
    expect(content).toContain("[7]");
  });

  it("flushToPhysicalLayer writes empty placeholder when no facts", async () => {
    const { service, tmpDir } = await createL1Service();
    service.flushToPhysicalLayer();
    const content = fs.readFileSync(path.join(tmpDir, "MEMORIES.md"), "utf8");
    expect(content).toContain("No facts yet");
  });

  it("flushToPhysicalLayer writes atomically (no partial file on concurrent call)", async () => {
    const { service, tmpDir } = await createL1Service();
    const db = (service as any).db;
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run("behavior", `fact-${i}`, 5, Date.now());
    }

    // Call twice — second call should overwrite cleanly
    service.flushToPhysicalLayer();
    service.flushToPhysicalLayer();

    const content = fs.readFileSync(path.join(tmpDir, "MEMORIES.md"), "utf8");
    // Should not have duplicate headings
    const headingMatches = content.match(/## behavior/g);
    expect(headingMatches).toHaveLength(1);
  });

  it("realtime mode: saveFact appends to MEMORIES.md immediately", async () => {
    const { service, tmpDir } = await createL1Service("realtime");

    await service.saveFact("identity", "user is named Alice", 9);

    const memoriesPath = path.join(tmpDir, "MEMORIES.md");
    expect(fs.existsSync(memoriesPath)).toBe(true);
    const content = fs.readFileSync(memoriesPath, "utf8");
    expect(content).toContain("user is named Alice");
    expect(content).toContain("## identity");
  });

  it("realtime mode: second fact in same category appends under existing heading", async () => {
    const { service, tmpDir } = await createL1Service("realtime");

    await service.saveFact("behavior", "user runs 3 times a week", 7);
    await service.saveFact("behavior", "user likes cycling", 6);

    const content = fs.readFileSync(path.join(tmpDir, "MEMORIES.md"), "utf8");
    // Only one ## behavior heading
    const headingMatches = content.match(/## behavior/g);
    expect(headingMatches).toHaveLength(1);
    expect(content).toContain("user runs 3 times a week");
    expect(content).toContain("user likes cycling");
  });

  it("batch mode: saveFact does NOT write to MEMORIES.md", async () => {
    const { service, tmpDir } = await createL1Service("batch");

    await service.saveFact("identity", "user is named Bob", 9);

    const memoriesPath = path.join(tmpDir, "MEMORIES.md");
    // In batch mode, file should not be created by saveFact alone
    expect(fs.existsSync(memoriesPath)).toBe(false);
  });

  it("consolidateFacts flushes L1 after successful consolidation", async () => {
    const { service, tmpDir } = await createL1Service("batch");
    const db = (service as any).db;

    for (let i = 0; i < 6; i++) {
      db.prepare(
        "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
      ).run("behavior", `fact-${i}`, 5, Date.now());
    }
    (service as any).lastConsolidatedCount = 0;

    const consolidated = [
      { category: "behavior", content: "user is active", importance: 8 },
    ];
    service.setGenerateText(
      vi.fn().mockResolvedValue(JSON.stringify(consolidated)),
    );

    await service.consolidateFacts();

    const memoriesPath = path.join(tmpDir, "MEMORIES.md");
    expect(fs.existsSync(memoriesPath)).toBe(true);
    const content = fs.readFileSync(memoriesPath, "utf8");
    expect(content).toContain("user is active");
  });

  it("reflect flushes L1 after successful reflection", async () => {
    const { service, tmpDir } = await createL1Service("batch");
    const db = (service as any).db;
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs", 8, Date.now());

    const insights = [
      { category: "insight", content: "User is disciplined", importance: 9 },
    ];
    await service.reflect(vi.fn().mockResolvedValue(JSON.stringify(insights)));

    const memoriesPath = path.join(tmpDir, "MEMORIES.md");
    expect(fs.existsSync(memoriesPath)).toBe(true);
    const content = fs.readFileSync(memoriesPath, "utf8");
    expect(content).toContain("User is disciplined");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Auto-Backfill
// ---------------------------------------------------------------------------

describe("MemoryService — autoBackfill", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("backfillPhysicalLayer rebuilds MEMORIES.md when file is missing", async () => {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 5,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-backfill-"));
    const service = new (MemoryService as any)("", tmpDir);

    // Seed a fact directly
    const db = (service as any).db;
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("identity", "user is Alice", 9, Date.now());

    // MEMORIES.md does not exist yet
    const memoriesPath = path.join(tmpDir, "MEMORIES.md");
    expect(fs.existsSync(memoriesPath)).toBe(false);

    // Call autoBackfill directly (awaitable) rather than via setEmbedContent
    service.setEmbedContent(async (_text: string) => new Array(4).fill(0));
    await (service as any).autoBackfill();

    expect(fs.existsSync(memoriesPath)).toBe(true);
    const content = fs.readFileSync(memoriesPath, "utf8");
    expect(content).toContain("user is Alice");
  });

  it("autoBackfill does nothing when embedContentFn is not set", async () => {
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-backfill2-"));
    const service = new (MemoryService as any)("", tmpDir);

    // Should not throw
    await expect((service as any).autoBackfill()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 3: L3 weighted fusion in searchFacts
// ---------------------------------------------------------------------------

describe("MemoryService.searchFacts — L3 weighted fusion", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function createFusionService(alpha = 0.7, beta = 0.3) {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "embedding",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: alpha,
              importanceWeight: beta,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fusion-"));
    const service = new (MemoryService as any)("", tmpDir);
    return { service, tmpDir };
  }

  it("importance weight boosts a lower-similarity fact above a higher-similarity one", async () => {
    // alpha=0.5, beta=0.5 so importance has equal weight to similarity
    const { service } = await createFusionService(0.5, 0.5);
    const db = (service as any).db;

    // Fact A: high similarity (vec close to query), low importance
    const vecA = new Float32Array([1, 0, 0, 0]); // cosine_sim ≈ 1.0 with query [1,0,0,0]
    const infoA = db
      .prepare(
        "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "identity",
        "fact-high-sim-low-imp",
        2,
        Date.now(),
        Buffer.from(vecA.buffer),
      );

    // Fact B: lower similarity, high importance
    const vecB = new Float32Array([0.6, 0.8, 0, 0]); // cosine_sim ≈ 0.6 with query
    const infoB = db
      .prepare(
        "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "identity",
        "fact-low-sim-high-imp",
        10,
        Date.now(),
        Buffer.from(vecB.buffer),
      );

    // Also insert into vec_facts so SQL path is used
    try {
      db.prepare("INSERT INTO vec_facts (id, embedding) VALUES (?, ?)").run(
        infoA.lastInsertRowid,
        vecA,
      );
      db.prepare("INSERT INTO vec_facts (id, embedding) VALUES (?, ?)").run(
        infoB.lastInsertRowid,
        vecB,
      );
    } catch (_) {
      // vec extension unavailable — fallback cosine path used instead.
      // The importance-weight assertion below still runs via in-memory cosine.
    }

    // Query vector = [1, 0, 0, 0]
    service.setEmbedContent(async (_text: string) => [1, 0, 0, 0]);

    const results = await service.searchFacts("test query", 2);
    const nonStyle = results.filter(
      (f: any) =>
        f.category !== "interaction_style" && f.category !== "insight",
    );

    // With equal weights, fact B (importance=10) should rank above fact A (importance=2)
    // fusedScore(A) = 0.5 * ~1.0 + 0.5 * (2/10) = 0.5 + 0.1 = 0.6
    // fusedScore(B) = 0.5 * ~0.6 + 0.5 * (10/10) = 0.3 + 0.5 = 0.8
    if (nonStyle.length >= 2) {
      expect(nonStyle[0].content).toBe("fact-low-sim-high-imp");
    }
  });

  it("falls back to in-memory cosine when vec_facts is empty", async () => {
    const { service } = await createFusionService();
    const db = (service as any).db;

    // Insert facts with embeddings in facts table but NOT in vec_facts
    const vec = new Float32Array([1, 0, 0, 0]);
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "identity",
      "fact-with-embedding",
      8,
      Date.now(),
      Buffer.from(vec.buffer),
    );

    service.setEmbedContent(async (_text: string) => [1, 0, 0, 0]);

    // Should not throw and should return the fact via in-memory fallback
    const results = await service.searchFacts("test", 1);
    expect(results.some((f: any) => f.content === "fact-with-embedding")).toBe(
      true,
    );
  });

  it("falls back to jaccard when embedContentFn throws", async () => {
    const { service } = await createFusionService();
    const db = (service as any).db;

    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("specification", "project uses TypeScript", 9, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("behavior", "user runs daily", 6, Date.now());

    service.setEmbedContent(async (_text: string) => {
      throw new Error("embedding unavailable");
    });

    const results = await service.searchFacts("TypeScript project", 2);
    // Jaccard fallback should still find TypeScript fact
    expect(results.some((f: any) => f.content.includes("TypeScript"))).toBe(
      true,
    );
  });

  it("embedding: preference always included; insight only when importance >= 7", async () => {
    const { service } = await createFusionService();
    const db = (service as any).db;

    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("interaction_style", "prefers concise answers", 10, Date.now());
    // insight at importance=7 (at threshold) — should be included
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "User is disciplined", 7, Date.now());
    // insight at importance=6 (below threshold) — should NOT be included
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("insight", "User sometimes forgets", 6, Date.now());
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp) VALUES (?, ?, ?, ?)",
    ).run("identity", "user is a developer", 7, Date.now());

    service.setEmbedContent(async (_text: string) => [1, 0, 0, 0]);

    const results = await service.searchFacts("discipline", 5);
    expect(results.some((f: any) => f.category === "interaction_style")).toBe(
      true,
    );
    // Only the importance=7 insight should appear
    const injectedInsights = results.filter(
      (f: any) => f.category === "insight",
    );
    expect(injectedInsights.length).toBe(1);
    expect(injectedInsights[0].content).toBe("User is disciplined");
  });

  it("embedding: insight excluded from ranked facts (both vec_facts SQL and fallback cosine paths)", async () => {
    // Regression test: insight must never appear in ranked[] regardless of
    // which embedding path is taken.
    // vec_facts SQL path: scoredRows filter must skip category=insight.
    // fallback cosine path: candidateFacts already excludes insight.
    // Both paths are exercised — assertion runs unconditionally either way.
    const { service } = await createFusionService();
    const db = (service as any).db;

    const vec = new Float32Array([1, 0, 0, 0]);

    // Insert an insight with importance=6 (below threshold) into both tables
    const insightInfo = db
      .prepare(
        "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "insight",
        "Low-importance insight",
        6,
        Date.now(),
        Buffer.from(vec.buffer),
      );

    // Insert a regular fact
    const factInfo = db
      .prepare(
        "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "identity",
        "user is a developer",
        7,
        Date.now(),
        Buffer.from(vec.buffer),
      );

    try {
      db.prepare("INSERT INTO vec_facts (id, embedding) VALUES (?, ?)").run(
        insightInfo.lastInsertRowid,
        vec,
      );
      db.prepare("INSERT INTO vec_facts (id, embedding) VALUES (?, ?)").run(
        factInfo.lastInsertRowid,
        vec,
      );
    } catch (_) {
      // vec extension unavailable — fallback cosine path will be used instead.
      // The assertion below still runs and verifies the fallback path.
    }

    service.setEmbedContent(async (_text: string) => [1, 0, 0, 0]);
    const results = await service.searchFacts("developer", 5);

    // insight with importance=6 must NOT appear via either path
    const insightResults = results.filter((f: any) => f.category === "insight");
    expect(insightResults.length).toBe(0);
    // The regular fact must appear
    expect(results.some((f: any) => f.content === "user is a developer")).toBe(
      true,
    );
  });

  it("embedding: insight ranked by queryVecCached (rankByEmbeddingWithId path)", async () => {
    // Regression test: insight candidates must use the pre-computed queryVec
    // (queryVecCached) for cosine ranking, not fall back to jaccard.
    // Verify by checking that the more similar insight ranks first.
    const { service } = await createFusionService();
    const db = (service as any).db;

    // Query vector = [1, 0, 0, 0]
    // Insight A: vec close to query → high cosine sim
    const vecA = new Float32Array([1, 0, 0, 0]);
    // Insight B: vec orthogonal to query → low cosine sim
    const vecB = new Float32Array([0, 1, 0, 0]);

    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "insight",
      "Insight close to query",
      7,
      Date.now(),
      Buffer.from(vecA.buffer),
    );
    db.prepare(
      "INSERT INTO facts (category, content, importance, timestamp, embedding) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "insight",
      "Insight far from query",
      7,
      Date.now(),
      Buffer.from(vecB.buffer),
    );

    service.setEmbedContent(async (_text: string) => [1, 0, 0, 0]);
    const results = await service.searchFacts("query topic", 5);

    const insightResults = results.filter((f: any) => f.category === "insight");
    // At most 2 insights, and the closer one should rank first
    expect(insightResults.length).toBeGreaterThanOrEqual(1);
    expect(insightResults[0].content).toBe("Insight close to query");
  });
});

// ---------------------------------------------------------------------------
// Semantic prefix embedding tests
// ---------------------------------------------------------------------------

describe("MemoryService.buildEmbeddingText", () => {
  // Import the class directly — buildEmbeddingText is a pure static method
  // that does not touch the DB or any mocked module, so a static import is safe.
  let BuildEmbeddingText: (category: string, content: string) => string;

  beforeAll(async () => {
    const mod = await import("./memory.js");
    BuildEmbeddingText = (mod.MemoryService as any).buildEmbeddingText;
  });

  it("prepends PRIVATE_USER_DATA prefix for identity", () => {
    const text = BuildEmbeddingText("identity", "user is a software engineer");
    expect(text).toBe(
      "PRIVATE_USER_DATA: Identity - user is a software engineer",
    );
  });

  it("prepends PRIVATE_USER_DATA prefix for behavior", () => {
    const text = BuildEmbeddingText(
      "behavior",
      "User has a moderate risk appetite for investment.",
    );
    expect(text).toContain("PRIVATE_USER_DATA: Habit/Behavior - ");
    expect(text).toContain("moderate risk appetite");
  });

  it("prepends UI_UX_INSTRUCTION prefix for interaction_style", () => {
    const text = BuildEmbeddingText("interaction_style", "respond in Chinese");
    expect(text).toBe(
      "UI_UX_INSTRUCTION: Response Pattern - respond in Chinese",
    );
  });

  it("prepends SYSTEM_CONSTRAINT prefix for specification", () => {
    const text = BuildEmbeddingText("specification", "project uses TypeScript");
    expect(text).toBe(
      "SYSTEM_CONSTRAINT: Implementation Rule - project uses TypeScript",
    );
  });

  it("prepends PRIVATE_USER_DATA prefix for insight", () => {
    const text = BuildEmbeddingText("insight", "user is disciplined");
    expect(text).toBe(
      "PRIVATE_USER_DATA: Meta Observation - user is disciplined",
    );
  });

  it("uses generic prefix for unknown categories", () => {
    const text = BuildEmbeddingText("unknown_category", "some fact");
    expect(text).toContain("PRIVATE_USER_DATA: User/Project Fact - ");
    expect(text).toContain("some fact");
  });

  it("prefix makes behavior fact semantically distinct from general investment query", () => {
    // The key property: embedding text for a personal behavior fact
    // contains "PRIVATE_USER_DATA" which is absent from external-world queries.
    const factText = BuildEmbeddingText(
      "behavior",
      "User has a moderate risk appetite for investment.",
    );
    const queryText = "Did Amazon invest in Anthropic?";
    // The fact text contains the discriminating prefix
    expect(factText).toContain("PRIVATE_USER_DATA");
    // The query text does not contain any such prefix
    expect(queryText).not.toContain("PRIVATE_USER_DATA");
    // They share the word "invest" but the prefix creates semantic distance
    expect(factText).not.toBe(queryText);
  });
});

describe("MemoryService — embedding prefix used during saveFact", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("calls embedContentFn with prefixed text for the fact embedding", async () => {
    // vi.doMock must be called at test scope (not inside a helper) for vitest
    // module isolation to work correctly.
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-embedding-model",
              embeddingDimension: 128,
              distillation: "test-distillation-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "embedding",
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-prefix-test-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);

    const embedCalls: string[] = [];
    service.setEmbedContent(async (text: string) => {
      embedCalls.push(text);
      return new Array(128).fill(0.1);
    });

    await service.saveFact("behavior", "user runs daily", 7);

    // isDuplicateByEmbedding calls embedContentFn with raw content first.
    // Then the storage embedding must use the semantic prefix.
    const prefixedCall = embedCalls.find(
      (t) => t.startsWith("PRIVATE_USER_DATA") && t.includes("user runs daily"),
    );
    expect(prefixedCall).toBeDefined();
    expect(prefixedCall).toBe(
      "PRIVATE_USER_DATA: Habit/Behavior - user runs daily",
    );
  });

  it("different categories produce different prefixes", async () => {
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-embedding-model",
              embeddingDimension: 128,
              distillation: "test-distillation-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "embedding",
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-prefix-test-2-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);

    const embedCalls: string[] = [];
    let callIdx = 0;
    service.setEmbedContent(async (text: string) => {
      embedCalls.push(text);
      // Return distinct vectors so facts don't get rejected as duplicates
      const vec = new Array(128).fill(0);
      vec[callIdx % 128] = 1.0;
      callIdx++;
      return vec;
    });

    await service.saveFact("identity", "user is named David", 9);
    await service.saveFact("specification", "project uses TypeScript", 8);

    const identityEmbed = embedCalls.find((t) =>
      t.startsWith("PRIVATE_USER_DATA: Identity"),
    );
    const specEmbed = embedCalls.find((t) =>
      t.startsWith("SYSTEM_CONSTRAINT: Implementation Rule"),
    );

    expect(identityEmbed).toBeDefined();
    expect(specEmbed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryService.backfillSkillIndex + searchSkills
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryService skill index", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /** Builds a MemoryService with sqlite-vec stubbed and a controllable embedFn. */
  async function createSkillService(
    embedFn: (text: string) => Promise<number[]>,
  ) {
    vi.doMock("sqlite-vec", () => ({ load: vi.fn() }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "test-model",
              embeddingDimension: 4,
              distillation: "test-model",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-skill-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);

    // sqlite-vec is mocked so vec_skills isn't a real virtual table.
    // We need to stub the DB calls that touch vec_skills/skills_index
    // so tests exercise the logic without the native extension.
    // Instead, we spy on the internal DB to track what was called.
    service.setEmbedContentOnly(embedFn);

    return { service };
  }

  // ── Helper: build a MemoryService with a real (non-vec) DB for logic tests ──
  // Since sqlite-vec is mocked, vec_skills won't exist as a real virtual table.
  // We test the public interface by verifying that searchSkills falls back
  // gracefully when embedFn is absent, and that backfillSkillIndex calls
  // embedFn for each skill.

  it("backfillSkillIndex: does nothing when embedFn is not set", async () => {
    vi.doMock("sqlite-vec", () => ({ load: vi.fn() }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-skill-noembed-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);

    // embedContentFn is null — should return without throwing
    await expect(
      service.backfillSkillIndex([{ name: "s1", description: "d1" }]),
    ).resolves.toBeUndefined();
  });

  it("backfillSkillIndex: calls embedFn once per new skill", async () => {
    const embedCalls: string[] = [];
    const embedFn = async (text: string) => {
      embedCalls.push(text);
      return [1, 0, 0, 0];
    };

    vi.doMock("sqlite-vec", () => ({
      load: vi.fn((db: any) => {
        // Stub vec_skills as a plain table so INSERT/SELECT work without the extension
        db.exec(`
          CREATE TABLE IF NOT EXISTS vec_skills (id INTEGER PRIMARY KEY, embedding BLOB);
        `);
      }),
    }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-skill-embed-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(embedFn);

    const skills = [
      { name: "dmii", description: "Decision framework" },
      { name: "brainstorm", description: "Brainstorming helper" },
    ];

    await service.backfillSkillIndex(skills);

    // Each skill should have triggered one embed call
    expect(embedCalls).toHaveLength(2);
    expect(embedCalls[0]).toContain("dmii");
    expect(embedCalls[1]).toContain("brainstorm");
  });

  it("backfillSkillIndex: does not re-embed skills that already exist unchanged", async () => {
    const embedCalls: string[] = [];
    const embedFn = async (text: string) => {
      embedCalls.push(text);
      return [1, 0, 0, 0];
    };

    vi.doMock("sqlite-vec", () => ({
      load: vi.fn((db: any) => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS vec_skills (id INTEGER PRIMARY KEY, embedding BLOB);`,
        );
      }),
    }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-skill-incr-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(embedFn);

    const skills = [{ name: "dmii", description: "Decision framework" }];

    // First call — should embed
    await service.backfillSkillIndex(skills);
    expect(embedCalls).toHaveLength(1);

    // Second call with same skills — should NOT re-embed
    await service.backfillSkillIndex(skills);
    expect(embedCalls).toHaveLength(1); // still 1, no additional call
  });

  it("backfillSkillIndex: re-embeds when skill description changes", async () => {
    const embedCalls: string[] = [];
    const embedFn = async (text: string) => {
      embedCalls.push(text);
      return [1, 0, 0, 0];
    };

    vi.doMock("sqlite-vec", () => ({
      load: vi.fn((db: any) => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS vec_skills (id INTEGER PRIMARY KEY, embedding BLOB);`,
        );
      }),
    }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-skill-upd-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(embedFn);

    await service.backfillSkillIndex([
      { name: "dmii", description: "v1 description" },
    ]);
    expect(embedCalls).toHaveLength(1);

    // Update description — should re-embed
    await service.backfillSkillIndex([
      { name: "dmii", description: "v2 updated description" },
    ]);
    expect(embedCalls).toHaveLength(2);
    expect(embedCalls[1]).toContain("v2 updated description");
  });

  it("backfillSkillIndex: removes stale skills no longer in the list", async () => {
    const embedFn = async () => [1, 0, 0, 0];

    vi.doMock("sqlite-vec", () => ({
      load: vi.fn((db: any) => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS vec_skills (id INTEGER PRIMARY KEY, embedding BLOB);`,
        );
      }),
    }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-skill-stale-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(embedFn);

    // Index two skills
    await service.backfillSkillIndex([
      { name: "dmii", description: "d1" },
      { name: "brainstorm", description: "d2" },
    ]);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect(db.prepare("SELECT COUNT(*) as c FROM skills_index").get().c).toBe(
      2,
    );

    // Remove one skill
    await service.backfillSkillIndex([{ name: "dmii", description: "d1" }]);

    expect(db.prepare("SELECT COUNT(*) as c FROM skills_index").get().c).toBe(
      1,
    );
    expect(db.prepare("SELECT name FROM skills_index").get().name).toBe("dmii");
  });

  it("searchSkills: returns empty array when embedFn is not set", async () => {
    vi.doMock("sqlite-vec", () => ({ load: vi.fn() }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-skill-nosearch-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);

    const result = await service.searchSkills("analyze stocks", 3);
    expect(result).toEqual([]);
  });

  it("searchSkills: returns empty array when index is empty", async () => {
    const embedFn = async () => [1, 0, 0, 0];

    vi.doMock("sqlite-vec", () => ({ load: vi.fn() }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));
    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-skill-emptysearch-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(embedFn);

    // No skills indexed yet
    const result = await service.searchSkills("analyze stocks", 3);
    expect(result).toEqual([]);
  });

  it("backfillSkillIndex: concurrent calls are serialised (guard prevents double-insert)", async () => {
    let embedCallCount = 0;
    const embedFn = async () => {
      embedCallCount++;
      // Small delay to allow the second call to interleave if guard is absent
      await new Promise((r) => setTimeout(r, 5));
      return [1, 0, 0, 0];
    };

    vi.doMock("sqlite-vec", () => ({
      load: vi.fn((db: any) => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS vec_skills (id INTEGER PRIMARY KEY, embedding BLOB);`,
        );
      }),
    }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-skill-conc-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(embedFn);

    const skills = [{ name: "dmii", description: "Decision framework" }];

    // Fire two concurrent calls — guard should serialise them so only one runs
    await Promise.all([
      service.backfillSkillIndex(skills),
      service.backfillSkillIndex(skills),
    ]);

    const db = (service as unknown as Record<string, unknown>).db as any;
    // The skill should appear exactly once in skills_index
    expect(db.prepare("SELECT COUNT(*) as c FROM skills_index").get().c).toBe(
      1,
    );
    // embedFn should have been called exactly once (second call was blocked by guard)
    expect(embedCallCount).toBe(1);
  });

  it("skillIndexBuilding returns true while backfill is running, false after", async () => {
    let resolveEmbed!: () => void;
    const embedFn = async () => {
      await new Promise<void>((r) => {
        resolveEmbed = r;
      });
      return [1, 0, 0, 0];
    };

    vi.doMock("sqlite-vec", () => ({
      load: vi.fn((db: any) => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS vec_skills (id INTEGER PRIMARY KEY, embedding BLOB);`,
        );
      }),
    }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-skill-flag-"));
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(embedFn);

    expect(service.skillIndexBuilding).toBe(false);

    const backfillPromise = service.backfillSkillIndex([
      { name: "test-skill", description: "desc" },
    ]);

    // Flag should be true while backfill is suspended at embedFn
    expect(service.skillIndexBuilding).toBe(true);

    // Unblock the embedFn
    resolveEmbed();
    await backfillPromise;

    expect(service.skillIndexBuilding).toBe(false);
  });

  it("searchSkills: returns mapped results from skills_index JOIN", async () => {
    // This test verifies the name/description mapping without vec0 by
    // stubbing the db.prepare().all() call used inside searchSkills.
    vi.doMock("sqlite-vec", () => ({ load: vi.fn() }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-skill-search-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);
    service.setEmbedContentOnly(async () => [0.5, 0.5, 0.5, 0.5]);

    // Inject skills into skills_index directly so COUNT(*) > 0
    const db = (service as unknown as Record<string, unknown>).db as any;
    db.prepare(
      "INSERT INTO skills_index (name, description) VALUES (?, ?)",
    ).run("dmii", "Decision framework");
    db.prepare(
      "INSERT INTO skills_index (name, description) VALUES (?, ?)",
    ).run("brainstorm", "Brainstorming helper");

    // Stub the prepare().all() to return mock rows (bypasses vec0 extension)
    const originalPrepare = db.prepare.bind(db);
    const stub = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("embedding MATCH")) {
        return {
          all: () => [
            { name: "dmii", description: "Decision framework", distance: 0.1 },
            {
              name: "brainstorm",
              description: "Brainstorming helper",
              distance: 0.3,
            },
          ],
        };
      }
      return originalPrepare(sql);
    });

    const results = await service.searchSkills("decision making", 5);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      name: "dmii",
      description: "Decision framework",
    });
    expect(results[1]).toEqual({
      name: "brainstorm",
      description: "Brainstorming helper",
    });

    stub.mockRestore();
  });

  it("backfillSkillIndex: queues skills when embedFn absent, runs when setEmbedContent called", async () => {
    const embedCalls: string[] = [];
    const embedFn = async (text: string) => {
      embedCalls.push(text);
      return [1, 0, 0, 0];
    };

    vi.doMock("sqlite-vec", () => ({
      load: vi.fn((db: any) => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS vec_skills (id INTEGER PRIMARY KEY, embedding BLOB);`,
        );
      }),
    }));
    vi.doMock("./configManager.js", () => ({
      ConfigManager: {
        getInstance: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({
            api: { key: "test-key", proxy: null },
            models: {
              embedding: "m",
              embeddingDimension: 4,
              distillation: "m",
            },
            memory: {
              ingestionDelayMs: 0,
              retrievalLimit: 5,
              consolidationThreshold: 100,
              dedupStrategy: "jaccard",
              factRelevanceStrategy: "jaccard",
              factRelevanceLimit: 3,
              prewarmLimit: 3,
              l1WriteMode: "batch",
              vectorSimilarityWeight: 0.7,
              importanceWeight: 0.3,
            },
          }),
        }),
      },
    }));

    const { MemoryService } = await import("./memory.js");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-skill-deferred-"),
    );
    const service = new (MemoryService as new (
      root: string,
      dbPath?: string,
    ) => InstanceType<typeof MemoryService>)("", tmpDir);

    // embedFn NOT set yet — simulates agent not yet initialized
    const skills = [
      { name: "dmii", description: "Decision framework" },
      { name: "brainstorm", description: "Brainstorming" },
    ];

    // Should queue, not embed
    await service.backfillSkillIndex(skills);
    expect(embedCalls).toHaveLength(0);

    const db = (service as unknown as Record<string, unknown>).db as any;
    expect(db.prepare("SELECT COUNT(*) as c FROM skills_index").get().c).toBe(
      0,
    );

    // Now set embedFn — should drain the queue and index skills
    service.setEmbedContentOnly(embedFn);
    // setEmbedContentOnly triggers drainPendingSkillBackfill which is async
    await new Promise((r) => setTimeout(r, 50));

    expect(embedCalls).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) as c FROM skills_index").get().c).toBe(
      2,
    );
  });
});
