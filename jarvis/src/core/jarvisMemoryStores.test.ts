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
});
