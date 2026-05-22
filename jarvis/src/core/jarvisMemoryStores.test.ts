/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import { createJarvisMemoryStores } from "./jarvisMemoryStores.js";

describe("Jarvis memory store adapters", () => {
  it("wraps MemoryService fact, entry, and session retrieval", async () => {
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
});
