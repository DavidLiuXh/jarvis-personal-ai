/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EntryMemory,
  FactMemory,
  MemoryItem,
  SessionMemory,
} from "./types.js";

export type MemoryGovernanceAction =
  | "insert"
  | "update"
  | "merge"
  | "skip"
  | "delete";

export type MemoryGovernanceReasonCode =
  | "empty_content"
  | "duplicate_content"
  | "same_subject_update"
  | "lower_confidence_conflict"
  | "higher_confidence_replaces"
  | "delete_requested"
  | "new_memory"
  | "session_upsert";

export type MemoryGovernanceDecision<T extends MemoryItem = MemoryItem> = {
  action: MemoryGovernanceAction;
  reasonCode: MemoryGovernanceReasonCode;
  incoming: T;
  existing?: T;
  result?: T;
  confidenceDelta?: number;
};

export type MemoryGovernancePolicyOptions = {
  duplicateSimilarity?: number;
  conflictConfidenceMargin?: number;
  now?: () => Date;
};

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  const terms = new Set(normalizeText(text).split(" ").filter(Boolean));
  for (const sequence of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (const char of sequence) terms.add(char);
    for (let index = 0; index < sequence.length - 1; index++) {
      terms.add(sequence.slice(index, index + 2));
    }
  }
  return terms;
}

export function lexicalSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function contentOf(item: MemoryItem): string {
  if (item.scope === "session") {
    return [item.summary ?? "", ...item.turns.map((turn) => turn.content)]
      .join("\n")
      .trim();
  }
  return item.content.trim();
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function mergeFact(args: {
  incoming: FactMemory;
  existing: FactMemory;
  now: () => Date;
}): FactMemory {
  const sourceRefs = Array.from(
    new Set([...args.existing.sourceRefs, ...args.incoming.sourceRefs]),
  );
  return {
    ...args.existing,
    content:
      args.incoming.confidence >= args.existing.confidence
        ? args.incoming.content
        : args.existing.content,
    confidence: Math.max(args.existing.confidence, args.incoming.confidence),
    sourceRefs,
    updatedAt: timestamp(args.now),
    metadata: {
      ...args.existing.metadata,
      ...args.incoming.metadata,
      governance: "merged_duplicate_fact",
    },
  };
}

function mergeEntry(args: {
  incoming: EntryMemory;
  existing: EntryMemory;
}): EntryMemory {
  return {
    ...args.existing,
    content:
      args.incoming.content.length > args.existing.content.length
        ? args.incoming.content
        : args.existing.content,
    entities: Array.from(
      new Set([...args.existing.entities, ...args.incoming.entities]),
    ),
    sourceRefs: Array.from(
      new Set([...args.existing.sourceRefs, ...args.incoming.sourceRefs]),
    ),
    metadata: {
      ...args.existing.metadata,
      ...args.incoming.metadata,
      governance: "merged_duplicate_entry",
    },
  };
}

function mergeSession(args: {
  incoming: SessionMemory;
  existing: SessionMemory;
}): SessionMemory {
  return {
    ...args.existing,
    turns:
      args.incoming.turns.length > 0
        ? args.incoming.turns
        : args.existing.turns,
    summary: args.incoming.summary ?? args.existing.summary,
    topicState: args.incoming.topicState ?? args.existing.topicState,
  };
}

export class MemoryGovernancePolicy {
  private readonly duplicateSimilarity: number;
  private readonly conflictConfidenceMargin: number;
  private readonly now: () => Date;

  constructor(options: MemoryGovernancePolicyOptions = {}) {
    this.duplicateSimilarity = options.duplicateSimilarity ?? 0.92;
    this.conflictConfidenceMargin = options.conflictConfidenceMargin ?? 0.1;
    this.now = options.now ?? (() => new Date());
  }

  decideUpsert<T extends MemoryItem>(
    incoming: T,
    candidates: T[] = [],
  ): MemoryGovernanceDecision<T> {
    if (!contentOf(incoming)) {
      return { action: "skip", reasonCode: "empty_content", incoming };
    }

    if (incoming.scope === "session") {
      const existing = candidates.find(
        (candidate) =>
          candidate.scope === "session" &&
          candidate.sessionId === incoming.sessionId,
      ) as T | undefined;
      if (!existing) {
        return {
          action: "insert",
          reasonCode: "new_memory",
          incoming,
          result: incoming,
        };
      }
      return {
        action: "update",
        reasonCode: "session_upsert",
        incoming,
        existing,
        result: mergeSession({
          incoming: incoming as SessionMemory,
          existing: existing as SessionMemory,
        }) as T,
      };
    }

    const duplicate = candidates.find(
      (candidate) =>
        candidate.scope === incoming.scope &&
        lexicalSimilarity(contentOf(candidate), contentOf(incoming)) >=
          this.duplicateSimilarity,
    ) as T | undefined;
    if (duplicate) {
      const result =
        incoming.scope === "fact"
          ? (mergeFact({
              incoming: incoming as FactMemory,
              existing: duplicate as FactMemory,
              now: this.now,
            }) as T)
          : (mergeEntry({
              incoming: incoming as EntryMemory,
              existing: duplicate as EntryMemory,
            }) as T);
      return {
        action: "merge",
        reasonCode: "duplicate_content",
        incoming,
        existing: duplicate,
        result,
      };
    }

    if (incoming.scope === "fact" && incoming.subject === "user") {
      const sameSubject = candidates.find(
        (candidate) =>
          candidate.scope === "fact" &&
          candidate.subject === incoming.subject &&
          candidate.id !== incoming.id,
      ) as T | undefined;
      if (sameSubject) {
        const existing = sameSubject as FactMemory;
        const delta = incoming.confidence - existing.confidence;
        if (delta < -this.conflictConfidenceMargin) {
          return {
            action: "skip",
            reasonCode: "lower_confidence_conflict",
            incoming,
            existing: sameSubject,
            confidenceDelta: delta,
          };
        }
        return {
          action: "update",
          reasonCode:
            delta > this.conflictConfidenceMargin
              ? "higher_confidence_replaces"
              : "same_subject_update",
          incoming,
          existing: sameSubject,
          result: mergeFact({
            incoming: incoming as FactMemory,
            existing,
            now: this.now,
          }) as T,
          confidenceDelta: delta,
        };
      }
    }

    return {
      action: "insert",
      reasonCode: "new_memory",
      incoming,
      result: incoming,
    };
  }

  decideDelete<T extends MemoryItem>(item: T): MemoryGovernanceDecision<T> {
    return {
      action: "delete",
      reasonCode: "delete_requested",
      incoming: item,
      existing: item,
    };
  }
}
