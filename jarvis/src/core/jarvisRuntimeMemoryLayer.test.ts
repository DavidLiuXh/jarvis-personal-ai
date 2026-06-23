/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteMemoryStore } from "../memory-runtime/index.js";
import { createJarvisRuntimeMemoryLayer } from "./jarvisRuntimeMemoryLayer.js";
import type { MemoryService } from "./memory.js";

const tempDirs: string[] = [];

function tempDbPath() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-runtime-memory-"));
  tempDirs.push(dir);
  return path.join(dir, "memory.db");
}

function memoryServiceFor(store: SqliteMemoryStore) {
  return {
    getRuntimeSqliteMemoryStore: () => store,
    searchConversationHistoryLexical: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryService;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Jarvis runtime memory layer", () => {
  it("wires DefaultLayeredMemoryRuntime directly to SqliteMemoryStore", async () => {
    const sqliteStore = new SqliteMemoryStore({
      dbPath: tempDbPath(),
      enableVectors: false,
    });
    const layer = createJarvisRuntimeMemoryLayer({
      memoryService: memoryServiceFor(sqliteStore),
      sessionId: "session-1",
    });

    await layer.layeredRuntime.saveFact({
      id: "fact-1",
      scope: "fact",
      subject: "preference",
      content: "The user prefers Chinese technical explanations.",
      confidence: 0.9,
      sourceRefs: ["test"],
      metadata: { category: "interaction_style", importance: 9 },
    });
    await layer.layeredRuntime.saveEntry({
      id: "entry-1",
      scope: "entry",
      kind: "conversation",
      content: "Discussed the universal memory runtime migration.",
      entities: ["memory-runtime"],
      timestamp: "2026-06-23T00:00:00.000Z",
      sourceRefs: ["session-1"],
    });
    await layer.layeredRuntime.saveSession({
      scope: "session",
      sessionId: "session-1",
      summary: "Universal memory runtime migration summary.",
      turns: [],
    });

    expect(
      await layer.layeredRuntime.searchFacts({
        query: "Chinese technical explanations",
      }),
    ).toEqual([
      expect.objectContaining({
        content: "The user prefers Chinese technical explanations.",
        metadata: expect.objectContaining({ category: "interaction_style" }),
      }),
    ]);
    expect(
      await layer.layeredRuntime.searchEntries({
        query: "memory runtime migration",
      }),
    ).toEqual([
      expect.objectContaining({
        content: "Discussed the universal memory runtime migration.",
      }),
    ]);
    expect(
      await layer.layeredRuntime.searchSession({ query: "migration summary" }),
    ).toEqual([
      expect.objectContaining({
        summary: "Universal memory runtime migration summary.",
      }),
    ]);

    sqliteStore.close();
  });

  it("keeps Jarvis lexical conversation-history fallback as an entry-store decorator", async () => {
    const sqliteStore = new SqliteMemoryStore({
      dbPath: tempDbPath(),
      enableVectors: false,
    });
    await sqliteStore.upsertEntry({
      id: "entry-today",
      scope: "entry",
      kind: "conversation",
      content: "User: 今天讨论了不相关的话题。",
      entities: [],
      timestamp: "2026-06-02T10:00:00+08:00",
      sourceRefs: ["session-1"],
    });
    const fallback = vi.fn().mockResolvedValue([
      {
        text: "User: 昨天讨论了 Universal Memory Layer\nJarvis: 重点是 runtime 直连 SQLite。",
        score: 0.55,
        timestamp: Date.parse("2026-06-01T10:00:00+08:00"),
      },
    ]);
    const layer = createJarvisRuntimeMemoryLayer({
      memoryService: {
        getRuntimeSqliteMemoryStore: () => sqliteStore,
        searchConversationHistoryLexical: fallback,
      } as unknown as MemoryService,
      sessionId: "session-1",
    });
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

    const entries = await layer.stores.entries!.searchEntries(
      contract.query.raw,
      {
        limit: 1,
        dateRange: contract.query.timeRange,
        contract,
      },
    );

    expect(fallback).toHaveBeenCalledWith(contract.query.raw, {
      limit: 8,
      dateRange: contract.query.timeRange,
    });
    expect(entries[0]).toMatchObject({
      content: expect.stringContaining("runtime 直连 SQLite"),
      metadata: { source: "conversation_history_lexical" },
    });
    expect(entries.map((entry) => entry.content).join("\n")).not.toContain(
      "不相关",
    );

    sqliteStore.close();
  });
});
