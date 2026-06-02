/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationRole, DateRange } from "./types.js";

export type SessionStoreCapabilities = {
  read: boolean;
  write: boolean;
  search: boolean;
};

export type SessionTranscriptTurn = {
  id?: string;
  role: ConversationRole;
  content: string;
  timestamp?: string | number;
  metadata?: Record<string, unknown>;
};

export type SessionTranscript = {
  sessionId: string;
  source: string;
  createdAt?: string;
  updatedAt?: string;
  turns: SessionTranscriptTurn[];
  metadata?: Record<string, unknown>;
};

export type SessionListQuery = {
  limit?: number;
  dateRange?: DateRange | null;
};

export type SessionSummary = {
  sessionId: string;
  source: string;
  turnCount: number;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type SessionSearchQuery = {
  query: string;
  limit?: number;
  dateRange?: DateRange | null;
};

export type SessionSearchResult = {
  sessionId: string;
  text: string;
  score: number;
  timestamp?: number;
  turns?: SessionTranscriptTurn[];
  metadata?: Record<string, unknown>;
};

export type SessionAppendInput = {
  sessionId: string;
  turn: SessionTranscriptTurn;
};

export interface SessionStore {
  readonly capabilities: SessionStoreCapabilities;
  listSessions(query?: SessionListQuery): Promise<SessionSummary[]>;
  readSession(sessionId: string): Promise<SessionTranscript | null>;
  searchTurns(query: SessionSearchQuery): Promise<SessionSearchResult[]>;
  appendTurn?(input: SessionAppendInput): Promise<void>;
  upsertSession?(session: SessionTranscript): Promise<void>;
}

const HISTORY_RECALL_STOPWORDS = new Set([
  "conversation_history",
  "recall",
  "memory",
  "history",
  "previous",
  "conversation",
  "discussion",
  "discuss",
  "what",
  "which",
  "when",
  "where",
  "about",
  "before",
  "yesterday",
  "today",
  "内容",
  "哪些",
  "什么",
  "之前",
  "以前",
  "上次",
  "昨天",
  "前天",
  "大前天",
  "今天",
  "我们",
  "咱们",
  "相关",
  "汇总",
  "总结",
]);

const HAN_FILLER_CHARS = new Set(
  "的地得了着过在是有都也就与和或把被让使给向对从到上下里外前后中内以于为之而及且但虽因如若所其该此那这您你我他她它们吗呢吧哦啊哎嗯啦嘛呀哟喔嗨哈帮".split(
    "",
  ),
);

function extractHanBigrams(block: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < block.length - 1; i++) {
    const gram = block.slice(i, i + 2);
    if (!HAN_FILLER_CHARS.has(gram[0]) && !HAN_FILLER_CHARS.has(gram[1])) {
      grams.push(gram);
    }
  }
  return grams;
}

export function extractSessionSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  const lower = query.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    const term = match[0];
    if (!HISTORY_RECALL_STOPWORDS.has(term)) terms.add(term);
  }
  for (const match of query.matchAll(/[\p{Script=Han}]+/gu)) {
    const stripped = match[0]
      .replace(
        /之前|以前|上次|昨天|前天|大前天|今天|我们|咱们|聊了|聊过|聊|说了|说过|说|讨论了|讨论过|讨论|探讨了|探讨过|探讨|相关|内容|哪些|什么|汇总|总结|关于|帮我|告诉我|给我|了|大/g,
        " ",
      )
      .trim();
    for (const segment of stripped.split(/\s+/)) {
      if (segment.length < 2) continue;
      for (const gram of extractHanBigrams(segment)) {
        if (!HISTORY_RECALL_STOPWORDS.has(gram)) terms.add(gram);
      }
    }
  }
  return Array.from(terms);
}

export function normalizeSessionTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function scoreSessionSearchCandidates(input: {
  query: string;
  candidates: Array<{
    sessionId: string;
    text: string;
    timestamp: number;
    turns?: SessionTranscriptTurn[];
    metadata?: Record<string, unknown>;
  }>;
  limit?: number;
}): SessionSearchResult[] {
  const terms = extractSessionSearchTerms(input.query);
  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    lower: candidate.text.toLowerCase(),
  }));
  const totalDocs = candidates.length || 1;
  const termWeight = (term: string): number => {
    let documentFrequency = 0;
    const lower = term.toLowerCase();
    for (const candidate of candidates) {
      if (candidate.lower.includes(lower)) documentFrequency++;
    }
    return Math.log(totalDocs / (documentFrequency + 1) + 1);
  };
  const weights = new Map(terms.map((term) => [term, termWeight(term)]));
  const totalWeight =
    terms.reduce((sum, term) => sum + (weights.get(term) ?? 1), 0) || 1;

  const scored: SessionSearchResult[] = [];
  for (const candidate of candidates) {
    const matchedTerms = terms.filter((term) =>
      candidate.lower.includes(term.toLowerCase()),
    );
    if (terms.length > 0 && matchedTerms.length === 0) continue;
    const matchedWeight = matchedTerms.reduce(
      (sum, term) => sum + (weights.get(term) ?? 1),
      0,
    );
    const score =
      terms.length === 0
        ? 0.55
        : Math.min(0.95, 0.55 + 0.4 * (matchedWeight / totalWeight));
    scored.push({
      sessionId: candidate.sessionId,
      text: candidate.text,
      score,
      timestamp: candidate.timestamp,
      turns: candidate.turns,
      metadata: candidate.metadata,
    });
  }
  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : (b.timestamp ?? 0) - (a.timestamp ?? 0),
  );
  return scored.slice(0, input.limit ?? 5);
}
