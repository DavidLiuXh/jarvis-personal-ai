/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DefaultLayeredMemoryRuntime,
  DefaultMemoryWriterRuntime,
  type EntryMemorySearchResult,
  type EntryMemoryStore,
  type MemoryRetrieverStores,
  type MemoryWriteEventItem,
  type MemoryWriteStore,
  type MemoryWriterRuntimeEvent,
  type SessionMemoryStore,
  type SqliteMemoryStore,
} from "../memory-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import type { MemoryService } from "./memory.js";
import type { RuntimeIntentFeedbackCollector } from "./runtimeIntentFeedbackCollector.js";

type ConversationHistoryFallback = Pick<
  MemoryService,
  "searchConversationHistoryLexical"
>;

export type JarvisRuntimeMemoryLayer = {
  sqliteStore: SqliteMemoryStore;
  stores: MemoryRetrieverStores;
  writeStore: MemoryWriteStore;
  layeredRuntime: DefaultLayeredMemoryRuntime;
};

class JarvisConversationHistoryEntryStore implements EntryMemoryStore {
  constructor(
    private readonly base: EntryMemoryStore,
    private readonly fallback: ConversationHistoryFallback,
  ) {}

  async searchEntries(
    query: string,
    options: Parameters<EntryMemoryStore["searchEntries"]>[1] = {},
  ): Promise<EntryMemorySearchResult[]> {
    const limit = options?.limit ?? 3;
    const isConversationHistory =
      options?.contract?.memoryTarget === "conversation_history";
    const hasTimeScope = isConversationHistory && Boolean(options?.dateRange);

    const baseEntries = await this.base.searchEntries(query, options);
    const entries = hasTimeScope
      ? baseEntries.filter(
          (entry) =>
            !entry.timestamp ||
            (Date.parse(entry.timestamp) >= options.dateRange!.from &&
              Date.parse(entry.timestamp) < options.dateRange!.to),
        )
      : baseEntries;

    const shouldUseFallback =
      isConversationHistory && (hasTimeScope || entries.length < limit);
    const fallbackLimit = hasTimeScope ? Math.max(limit, 8) : limit;
    const fallbackEntries = shouldUseFallback
      ? await this.fallback.searchConversationHistoryLexical(query, {
          limit: fallbackLimit,
          dateRange: options?.dateRange ?? null,
        })
      : [];

    if (isConversationHistory) {
      console.error(
        `🔎 [JarvisRuntimeMemoryLayer] conversation_history fallback=${shouldUseFallback ? "enabled" : "skipped"} sqlite=${entries.length}/${limit} lexical=${fallbackEntries.length}`,
      );
    }

    const primaryEntries = hasTimeScope ? fallbackEntries : entries;
    const secondaryEntries = hasTimeScope ? entries : fallbackEntries;
    const seen = new Set(primaryEntries.map((entry) => entry.text));
    return [
      ...primaryEntries.map((entry, index) =>
        this.toEntryResult(entry, {
          index,
          source: hasTimeScope ? "conversation_history_lexical" : "sqlite",
        }),
      ),
      ...secondaryEntries
        .filter((entry) => !seen.has(entry.text))
        .slice(0, Math.max(0, fallbackLimit - primaryEntries.length))
        .map((entry, index) =>
          this.toEntryResult(entry, {
            index,
            source: hasTimeScope ? "sqlite" : "conversation_history_lexical",
          }),
        ),
    ].slice(0, fallbackLimit);
  }

  private toEntryResult(
    entry:
      | EntryMemorySearchResult
      | { text: string; score: number; timestamp?: number },
    options: { index: number; source: string },
  ): EntryMemorySearchResult {
    if ("content" in entry) {
      return {
        ...entry,
        metadata: {
          ...(entry.metadata ?? {}),
          source: entry.metadata?.source ?? options.source,
        },
      };
    }
    return {
      id: `conversation-history-${options.index}`,
      kind: "conversation",
      content: entry.text,
      score: entry.score,
      timestamp:
        typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString()
          : undefined,
      metadata: { source: options.source },
    };
  }
}

export function createJarvisRuntimeMemoryLayer(input: {
  memoryService: MemoryService;
  sessionId: string;
  config?: Pick<JarvisConfig, "memory">;
  runtimeIntentFeedbackCollector?: RuntimeIntentFeedbackCollector;
}): JarvisRuntimeMemoryLayer {
  const sqliteStore = input.memoryService.getRuntimeSqliteMemoryStore();
  const entries = new JarvisConversationHistoryEntryStore(
    sqliteStore,
    input.memoryService,
  );
  const session: SessionMemoryStore = sqliteStore;
  const stores: MemoryRetrieverStores = {
    facts: sqliteStore,
    entries,
    session,
  };
  const writeObservability = input.config?.memory?.writeObservability !== false;
  const writer = new DefaultMemoryWriterRuntime({
    store: sqliteStore,
    observer: async (event) => {
      if (writeObservability) logMemoryWriteEvent(event);
      await input.runtimeIntentFeedbackCollector?.recordMemoryEvent({
        type: "runtime_feedback",
        sessionId: input.sessionId,
        signal: "memory_write_observed",
        observed: event,
      });
    },
  });
  const layeredRuntime = new DefaultLayeredMemoryRuntime({
    stores,
    writeStore: sqliteStore,
    sessionId: input.sessionId,
    writer,
  });
  return {
    sqliteStore,
    stores,
    writeStore: sqliteStore,
    layeredRuntime,
  };
}

function logMemoryWriteEvent(event: MemoryWriterRuntimeEvent): void {
  if (event.type === "memory_write_started") {
    console.error(`[MemoryWrite] started count=${event.count}`);
    return;
  }
  if (event.type === "memory_write_decision") {
    const item = event.item;
    console.error(
      `[MemoryWrite] decision scope=${event.scope} id=${event.id} action=${event.action} reason=${event.reasonCode}${formatMemoryWriteItem(item)}`,
    );
    return;
  }
  console.error(
    `[MemoryWrite] finished written=${event.written} skipped=${event.skipped} deleted=${event.deleted}`,
  );
  for (const result of event.results) {
    if (!result.written && !result.deleted) continue;
    console.error(
      `[MemoryWrite] ${result.written ? "upserted" : "deleted"} scope=${result.scope} id=${result.id} action=${result.action} reason=${result.reasonCode}${formatMemoryWriteItem(result.item)}`,
    );
  }
}

function formatMemoryWriteItem(item: MemoryWriteEventItem): string {
  const parts: string[] = [];
  if (item.subject) parts.push(`subject=${item.subject}`);
  if (item.kind) parts.push(`kind=${item.kind}`);
  if (typeof item.confidence === "number") {
    parts.push(`confidence=${item.confidence.toFixed(2)}`);
  }
  const category =
    typeof item.metadata?.category === "string" ? item.metadata.category : null;
  if (category) parts.push(`category=${category}`);
  const importance =
    typeof item.metadata?.importance === "number"
      ? item.metadata.importance
      : null;
  if (importance !== null) parts.push(`importance=${importance}`);
  if (item.sourceRefs?.length)
    parts.push(`source=${item.sourceRefs.join(",")}`);
  if (item.contentPreview) parts.push(`preview="${item.contentPreview}"`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
