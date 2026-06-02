/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MemoryGovernancePolicy,
  type MemoryGovernanceDecision,
} from "./governance.js";
import type { MemoryWriteStore } from "./store.js";
import type {
  EntryMemory,
  FactMemory,
  MemoryItem,
  SessionMemory,
} from "./types.js";

export type MemoryWriteOperation = "upsert" | "delete";

export type MemoryWriteRequest<T extends MemoryItem = MemoryItem> = {
  operation: MemoryWriteOperation;
  item: T;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryWriteResult<T extends MemoryItem = MemoryItem> = {
  request: MemoryWriteRequest<T>;
  decision: MemoryGovernanceDecision<T>;
  written: T | null;
  deleted: boolean;
};

export type MemoryWriterRuntimeObserver = (
  event: MemoryWriterRuntimeEvent,
) => void | Promise<void>;

export type MemoryWriterRuntimeEvent =
  | {
      type: "memory_write_started";
      count: number;
    }
  | {
      type: "memory_write_decision";
      reasonCode: string;
      action: string;
      scope: MemoryItem["scope"];
      id: string;
    }
  | {
      type: "memory_write_finished";
      written: number;
      skipped: number;
      deleted: number;
    };

export type MemoryWriterRuntimeOptions = {
  store: MemoryWriteStore;
  governance?: MemoryGovernancePolicy;
  observer?: MemoryWriterRuntimeObserver;
};

async function candidatesForItem<T extends MemoryItem>(
  store: MemoryWriteStore,
  item: T,
): Promise<T[]> {
  if (item.scope === "fact") return (await store.listFacts()) as T[];
  if (item.scope === "entry") return (await store.listEntries()) as T[];
  return (await store.listSessions()) as T[];
}

async function writeItem<T extends MemoryItem>(
  store: MemoryWriteStore,
  item: T,
): Promise<T> {
  if (item.scope === "fact")
    return (await store.upsertFact(item as FactMemory)) as T;
  if (item.scope === "entry") {
    return (await store.upsertEntry(item as EntryMemory)) as T;
  }
  return (await store.upsertSession(item as SessionMemory)) as T;
}

export class DefaultMemoryWriterRuntime {
  private readonly governance: MemoryGovernancePolicy;

  constructor(private readonly options: MemoryWriterRuntimeOptions) {
    this.governance = options.governance ?? new MemoryGovernancePolicy();
  }

  async write(requests: MemoryWriteRequest[]): Promise<MemoryWriteResult[]> {
    await this.emit({ type: "memory_write_started", count: requests.length });
    const results: MemoryWriteResult[] = [];

    for (const request of requests) {
      const decision =
        request.operation === "delete"
          ? this.governance.decideDelete(request.item)
          : this.governance.decideUpsert(
              request.item,
              await candidatesForItem(this.options.store, request.item),
            );
      await this.emit({
        type: "memory_write_decision",
        reasonCode: decision.reasonCode,
        action: decision.action,
        scope: request.item.scope,
        id:
          request.item.scope === "session"
            ? request.item.sessionId
            : request.item.id,
      });

      if (decision.action === "delete") {
        const id =
          request.item.scope === "session"
            ? request.item.sessionId
            : request.item.id;
        const deleted = await this.options.store.deleteMemory({
          scope: request.item.scope,
          id,
        });
        results.push({ request, decision, written: null, deleted });
        continue;
      }

      if (
        decision.action === "insert" ||
        decision.action === "update" ||
        decision.action === "merge"
      ) {
        const written = await writeItem(
          this.options.store,
          decision.result ?? request.item,
        );
        results.push({ request, decision, written, deleted: false });
        continue;
      }

      results.push({ request, decision, written: null, deleted: false });
    }

    await this.emit({
      type: "memory_write_finished",
      written: results.filter((result) => result.written).length,
      skipped: results.filter((result) => result.decision.action === "skip")
        .length,
      deleted: results.filter((result) => result.deleted).length,
    });
    return results;
  }

  private async emit(event: MemoryWriterRuntimeEvent): Promise<void> {
    await this.options.observer?.(event);
  }
}
