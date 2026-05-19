/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationTurn, IntentFrame } from "./intentResolver.js";

export type ConversationRecallCandidate = {
  text: string;
  matchedTerms: string[];
};

const GENERIC_ZH_TERMS = [
  "帮我",
  "请帮",
  "汇总",
  "总结",
  "整理",
  "之前",
  "以前",
  "上次",
  "相关",
  "探讨",
  "讨论",
  "内容",
  "我们",
  "记得",
  "回顾",
  "一下",
  "这个",
  "那个",
  "这些",
  "那些",
  "的",
  "吗",
];

const GENERIC_EN_TERMS = new Set([
  "previous",
  "prior",
  "discussion",
  "conversation",
  "summary",
  "summarize",
  "recall",
  "content",
  "topic",
  "related",
  "history",
]);

function compactText(text: string, maxChars = 220): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).trimEnd()}...`;
}

function normalizeChineseCandidate(text: string): string {
  let result = text;
  for (const term of GENERIC_ZH_TERMS) {
    result = result.replaceAll(term, " ");
  }
  return result.replace(/\s+/g, " ").trim();
}

export function extractConversationRecallTerms(
  userPrompt: string,
  intent: IntentFrame | null,
): string[] {
  const sources = [
    userPrompt,
    ...(intent?.richIntent.targets.map((target) => target.value) ?? []),
    ...(intent?.semanticEvidence.entityHints.technicalTerms ?? []),
    ...(intent?.semanticEvidence.entityHints.peopleOrCompanies ?? []),
    intent?.topicAnalysis.history.label ?? "",
    intent?.topicAnalysis.current.label ?? "",
    ...(intent?.topicAnalysis.history.evidence ?? []),
    ...(intent?.topicAnalysis.current.evidence ?? []),
  ].filter(Boolean);

  const terms = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/[\p{Script=Han}]{2,}/gu)) {
      const normalized = normalizeChineseCandidate(match[0]);
      for (const part of normalized.split(/\s+/)) {
        if (part.length >= 2 && part.length <= 12) {
          terms.add(part);
        }
      }
    }
    for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
      const term = match[0].toLowerCase();
      if (!GENERIC_EN_TERMS.has(term)) {
        terms.add(match[0]);
      }
    }
  }

  return [...terms].slice(0, 8);
}

export function buildRecentConversationRecallCandidates(args: {
  userPrompt: string;
  intent: IntentFrame | null;
  conversationHistory: ConversationTurn[];
  maxCandidates?: number;
}): ConversationRecallCandidate[] {
  if (
    args.intent?.semanticEvidence.memoryRecall.target !== "conversation_history"
  ) {
    return [];
  }

  const terms = extractConversationRecallTerms(args.userPrompt, args.intent);
  if (terms.length === 0) return [];

  const maxCandidates = args.maxCandidates ?? 2;
  const candidates: ConversationRecallCandidate[] = [];
  const usedIndexes = new Set<number>();

  for (let index = args.conversationHistory.length - 1; index >= 0; index--) {
    const turn = args.conversationHistory[index];
    if (!turn) continue;
    const matchedTerms = terms.filter((term) => turn.content.includes(term));
    if (matchedTerms.length === 0) continue;

    const start = Math.max(0, index - 1);
    const end = Math.min(args.conversationHistory.length - 1, index + 1);
    const windowTurns = [];
    for (let cursor = start; cursor <= end; cursor++) {
      if (usedIndexes.has(cursor)) continue;
      const item = args.conversationHistory[cursor];
      if (!item) continue;
      usedIndexes.add(cursor);
      windowTurns.push(
        `${item.role === "user" ? "User" : "Assistant"}: ${compactText(item.content)}`,
      );
    }
    if (windowTurns.length === 0) continue;

    candidates.push({
      text: `Recent conversation match (${matchedTerms.join(", ")}):\n${windowTurns.join("\n")}`,
      matchedTerms,
    });
    if (candidates.length >= maxCandidates) break;
  }

  return candidates;
}
