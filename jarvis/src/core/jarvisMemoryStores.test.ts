/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JarvisMemoryWriteStore,
  createJarvisMemoryStores,
  createJarvisMemoryWriteStore,
} from "./jarvisMemoryStores.js";

describe("Jarvis memory store adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps MemoryService fact, entry, and session retrieval", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const memoryService = {
      searchFacts: vi
        .fn()
        .mockResolvedValue([{ category: "preference", content: "likes TS" }]),
      searchWithScore: vi
        .fn()
        .mockResolvedValue([{ text: "old discussion", score: 0.77 }]),
      searchSummaryChunks: vi.fn().mockResolvedValue(["summary chunk"]),
    };
    const stores = createJarvisMemoryStores(memoryService, "session-1");

    const facts = await stores.facts!.searchFacts("TypeScript", { limit: 2 });
    const entries = await stores.entries!.searchEntries("TypeScript", {
      limit: 3,
      dateRange: { from: 1, to: 2 },
      maxDistance: 0.6,
    });
    const session = await stores.session!.searchSession("TypeScript", {
      limit: 1,
      maxDistance: 0.7,
    });

    expect(memoryService.searchFacts).toHaveBeenCalledWith("TypeScript", 2);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[MemoryRetrieval] jarvis.facts.adapter started"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[MemoryRetrieval] jarvis.facts.adapter finished",
      ),
    );
    expect(memoryService.searchWithScore).toHaveBeenCalledWith(
      "TypeScript",
      3,
      null,
      { from: 1, to: 2 },
      0.6,
    );
    expect(memoryService.searchSummaryChunks).toHaveBeenCalledWith(
      "session-1",
      "TypeScript",
      1,
      0.7,
    );
    expect(facts[0]).toMatchObject({
      subject: "preference",
      content: "likes TS",
    });
    expect(entries[0]).toMatchObject({
      content: "old discussion",
      score: 0.77,
    });
    expect(session[0]).toMatchObject({
      sessionId: "session-1",
      summary: "summary chunk",
    });
    consoleSpy.mockRestore();
  });

  it("falls back to lexical conversation history when vector entries are empty", async () => {
    const memoryService = {
      searchFacts: vi.fn().mockResolvedValue([]),
      searchWithScore: vi.fn().mockResolvedValue([]),
      searchConversationHistoryLexical: vi.fn().mockResolvedValue([
        {
          text: "User: 前天我们讨论了 Universal Memory Layer\nJarvis: 主要聊了 runtime 接入。",
          score: 0.55,
          timestamp: Date.parse("2026-05-20T10:00:00+08:00"),
        },
      ]),
    };
    const stores = createJarvisMemoryStores(memoryService, "session-1");
    const contract = {
      needMemory: true,
      subjectBoundary: "personal" as const,
      targetScopes: ["entry" as const],
      memoryTarget: "conversation_history" as const,
      query: {
        raw: "前天我们聊了哪些内容？ conversation_history",
        entities: [],
        timeRange: {
          from: Date.parse("2026-05-20T00:00:00+08:00"),
          to: Date.parse("2026-05-21T00:00:00+08:00"),
        },
      },
      confidence: { subject: 1, target: 1, query: 1 },
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: false,
        allowEntries: true,
        maxChars: 1800,
      },
      reasons: ["conversation_history"],
      policyTrace: [],
    };

    const entries = await stores.entries!.searchEntries(contract.query.raw, {
      limit: 3,
      dateRange: contract.query.timeRange,
      contract,
    });

    expect(memoryService.searchConversationHistoryLexical).toHaveBeenCalledWith(
      contract.query.raw,
      { limit: 8, dateRange: contract.query.timeRange },
    );
    expect(entries[0]).toMatchObject({
      content: expect.stringContaining("Universal Memory Layer"),
      metadata: { source: "conversation_history_lexical" },
    });
  });

  it("prefers lexical conversation history for time-scoped recall even when vector entries exist", async () => {
    const memoryService = {
      searchFacts: vi.fn().mockResolvedValue([]),
      searchWithScore: vi.fn().mockResolvedValue([
        {
          text: "User: 今天讨论了小红书内容策略\nJarvis: 重点是选题转化。",
          score: 0.9,
          timestamp: Date.parse("2026-06-02T10:00:00+08:00"),
        },
      ]),
      searchConversationHistoryLexical: vi.fn().mockResolvedValue([
        {
          text: "User: 昨天讨论了 Universal Memory Layer\nJarvis: 重点是 session recall。",
          score: 0.55,
          timestamp: Date.parse("2026-06-01T10:00:00+08:00"),
        },
      ]),
    };
    const stores = createJarvisMemoryStores(memoryService, "session-1");
    const contract = {
      needMemory: true,
      subjectBoundary: "personal" as const,
      targetScopes: ["entry" as const],
      memoryTarget: "conversation_history" as const,
      query: {
        raw: "汇总下昨天我们讨论了什么内容 conversation_history",
        entities: [],
        timeRange: {
          from: Date.parse("2026-06-01T00:00:00+08:00"),
          to: Date.parse("2026-06-02T00:00:00+08:00"),
        },
      },
      confidence: { subject: 1, target: 1, query: 1 },
      constraints: {
        allowPersonalFacts: false,
        allowSessionHistory: false,
        allowEntries: true,
        maxChars: 1800,
      },
      reasons: ["time_scoped_conversation_history"],
      policyTrace: [],
    };

    const entries = await stores.entries!.searchEntries(contract.query.raw, {
      limit: 1,
      dateRange: contract.query.timeRange,
      contract,
    });

    expect(memoryService.searchConversationHistoryLexical).toHaveBeenCalled();
    expect(entries[0]).toMatchObject({
      content: expect.stringContaining("session recall"),
      metadata: { source: "conversation_history_lexical" },
    });
    expect(entries.map((entry) => entry.content).join("\n")).not.toContain(
      "小红书",
    );
  });

  it("adapts runtime write operations directly to the runtime write store", async () => {
    const runtimeStore = {
      upsertFact: vi.fn().mockImplementation(async (fact) => fact),
      upsertEntry: vi.fn().mockImplementation(async (entry) => ({
        ...entry,
        id: "entry-db-1",
      })),
      upsertSession: vi.fn().mockImplementation(async (session) => session),
      deleteMemory: vi.fn().mockResolvedValue(true),
      listFacts: vi.fn().mockResolvedValue([]),
      listEntries: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
    };
    const memoryService = {
      getRuntimeSqliteMemoryStore: () => runtimeStore,
      searchFacts: vi.fn(),
      searchWithScore: vi.fn(),
    };
    const store = new JarvisMemoryWriteStore(runtimeStore);

    const fact = {
      id: "fact-1",
      scope: "fact",
      subject: "preference",
      content: "The user prefers concise Chinese replies.",
      confidence: 0.9,
      sourceRefs: ["test"],
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    } as const;
    const entry = {
      id: "entry-1",
      scope: "entry",
      kind: "conversation",
      content: "Discussed memory runtime.",
      entities: ["memory"],
      timestamp: "2026-06-02T00:00:00.000Z",
      sourceRefs: ["session-1"],
    } as const;
    const session = {
      scope: "session",
      sessionId: "session-1",
      turns: [{ role: "user", content: "hello" }],
    } as const;

    await store.upsertFact(fact);
    await store.upsertEntry(entry);
    await store.upsertSession(session);
    await store.deleteMemory({ scope: "entry", id: "entry-db-1" });

    expect(runtimeStore.upsertFact).toHaveBeenCalledWith(fact);
    expect(runtimeStore.upsertEntry).toHaveBeenCalledWith(entry);
    expect(runtimeStore.upsertSession).toHaveBeenCalledWith(session);
    expect(runtimeStore.deleteMemory).toHaveBeenCalledWith({
      scope: "entry",
      id: "entry-db-1",
    });
    expect(createJarvisMemoryWriteStore(memoryService)).toBeInstanceOf(
      JarvisMemoryWriteStore,
    );
  });
});
