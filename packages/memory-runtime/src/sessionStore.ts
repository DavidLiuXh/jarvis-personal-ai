/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConversationRole, DateRange } from "./types.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

export type JarvisJsonlSessionStoreOptions = {
  dir: string;
  maxScanFiles?: number;
  mtimeBufferMs?: number;
  source?: string;
};

type JarvisJsonlSessionRecord = {
  kind: "session";
  schemaVersion: 1;
  sessionId: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

type JarvisJsonlTurnRecord = {
  kind: "turn";
  id?: string;
  role: ConversationRole;
  content: string;
  timestamp?: string | number;
  backend?: string;
  model?: string;
  metadata?: Record<string, unknown>;
};

function sanitizeSessionId(sessionId: string): string {
  return (
    sessionId
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 160) || "session"
  );
}

function stringifyJsonlRecord(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function parseJsonlFile(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((record): record is unknown => record !== null);
}

function isSessionRecord(value: unknown): value is JarvisJsonlSessionRecord {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "session" &&
    (value as { sessionId?: unknown }).sessionId !== undefined
  );
}

function isTurnRecord(value: unknown): value is JarvisJsonlTurnRecord {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "turn" &&
    typeof (value as { role?: unknown }).role === "string" &&
    typeof (value as { content?: unknown }).content === "string"
  );
}

function fileDateTimestamp(filename: string): number | null {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const value = new Date(
    `${match[1]}-${match[2]}-${match[3]}T12:00:00`,
  ).getTime();
  return Number.isNaN(value) ? null : value;
}

function timestampIso(value: string | number | undefined): string | undefined {
  const ms = normalizeSessionTimestamp(value);
  return ms === null ? undefined : new Date(ms).toISOString();
}

function filenameTimestamp(value: string | number | undefined): string {
  return (timestampIso(value) ?? new Date().toISOString()).replace(
    /[:.]/g,
    "-",
  );
}

export class JarvisJsonlSessionStore implements SessionStore {
  readonly capabilities: SessionStoreCapabilities = {
    read: true,
    write: true,
    search: true,
  };

  private readonly dir: string;
  private readonly maxScanFiles: number;
  private readonly mtimeBufferMs: number;
  private readonly source: string;

  constructor(options: JarvisJsonlSessionStoreOptions) {
    this.dir = options.dir;
    this.maxScanFiles = options.maxScanFiles ?? 50;
    this.mtimeBufferMs = options.mtimeBufferMs ?? 7 * 24 * 60 * 60 * 1000;
    this.source = options.source ?? "jarvis-jsonl-v1";
  }

  async listSessions(query?: SessionListQuery): Promise<SessionSummary[]> {
    return this.listSessionFiles(query?.dateRange ?? null)
      .slice(0, query?.limit ?? this.maxScanFiles)
      .map(({ file, filePath, mtime }) => {
        const transcript = this.readTranscriptFile(filePath, file, mtime);
        return {
          sessionId: transcript.sessionId,
          source: transcript.source,
          turnCount: transcript.turns.length,
          updatedAt: transcript.updatedAt ?? new Date(mtime).toISOString(),
          metadata: transcript.metadata,
        };
      });
  }

  async readSession(sessionId: string): Promise<SessionTranscript | null> {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;
    return this.readTranscriptFile(file.filePath, file.file, file.mtime);
  }

  async searchTurns(query: SessionSearchQuery): Promise<SessionSearchResult[]> {
    const dateRange = query.dateRange ?? null;
    const candidates: Array<{
      sessionId: string;
      text: string;
      timestamp: number;
      turns: SessionTranscriptTurn[];
      metadata: Record<string, unknown>;
    }> = [];
    for (const { file, filePath, mtime } of this.listSessionFiles(dateRange)) {
      const transcript = this.readTranscriptFile(filePath, file, mtime);
      for (let index = 0; index < transcript.turns.length; index++) {
        const userTurn = transcript.turns[index];
        if (userTurn.role !== "user") continue;
        const assistantTurn = transcript.turns
          .slice(index + 1, index + 8)
          .find((turn) => turn.role === "assistant");
        const timestamp =
          normalizeSessionTimestamp(userTurn.timestamp) ??
          normalizeSessionTimestamp(assistantTurn?.timestamp) ??
          fileDateTimestamp(file) ??
          mtime;
        if (
          dateRange &&
          (timestamp < dateRange.from || timestamp >= dateRange.to)
        ) {
          continue;
        }
        const userText = userTurn.content.trim();
        const assistantText = assistantTurn?.content.trim() ?? "";
        if (!userText && !assistantText) continue;
        candidates.push({
          sessionId: transcript.sessionId,
          text: `User: ${userText}\nJarvis: ${assistantText}`.trim(),
          timestamp,
          turns: assistantTurn ? [userTurn, assistantTurn] : [userTurn],
          metadata: {
            source: transcript.source,
            file,
            format: "jarvis-jsonl-v1",
          },
        });
      }
    }
    return scoreSessionSearchCandidates({
      query: query.query,
      candidates,
      limit: query.limit,
    });
  }

  async appendTurn(input: SessionAppendInput): Promise<void> {
    this.ensureDir();
    const filePath =
      this.findSessionFile(input.sessionId)?.filePath ??
      this.filePathForNewSession(input.sessionId, input.turn.timestamp);
    if (!fs.existsSync(filePath)) {
      const now = new Date().toISOString();
      fs.appendFileSync(
        filePath,
        stringifyJsonlRecord({
          kind: "session",
          schemaVersion: 1,
          sessionId: input.sessionId,
          source: this.source,
          createdAt: now,
          updatedAt: now,
        } satisfies JarvisJsonlSessionRecord),
        "utf8",
      );
    }
    const metadata = input.turn.metadata ?? {};
    fs.appendFileSync(
      filePath,
      stringifyJsonlRecord({
        kind: "turn",
        id: input.turn.id ?? crypto.randomUUID(),
        role: input.turn.role,
        content: input.turn.content,
        timestamp: input.turn.timestamp ?? new Date().toISOString(),
        backend:
          typeof metadata.backend === "string" ? metadata.backend : undefined,
        model: typeof metadata.model === "string" ? metadata.model : undefined,
        metadata,
      } satisfies JarvisJsonlTurnRecord),
      "utf8",
    );
  }

  async upsertSession(session: SessionTranscript): Promise<void> {
    this.ensureDir();
    const filePath =
      this.findSessionFile(session.sessionId)?.filePath ??
      this.filePathForNewSession(
        session.sessionId,
        session.createdAt ?? session.turns[0]?.timestamp,
      );
    const now = new Date().toISOString();
    const records: unknown[] = [
      {
        kind: "session",
        schemaVersion: 1,
        sessionId: session.sessionId,
        source: session.source || this.source,
        createdAt: session.createdAt ?? now,
        updatedAt: session.updatedAt ?? now,
        metadata: session.metadata,
      } satisfies JarvisJsonlSessionRecord,
      ...session.turns.map(
        (turn) =>
          ({
            kind: "turn",
            id: turn.id ?? crypto.randomUUID(),
            role: turn.role,
            content: turn.content,
            timestamp: turn.timestamp ?? now,
            backend:
              typeof turn.metadata?.backend === "string"
                ? turn.metadata.backend
                : undefined,
            model:
              typeof turn.metadata?.model === "string"
                ? turn.metadata.model
                : undefined,
            metadata: turn.metadata,
          }) satisfies JarvisJsonlTurnRecord,
      ),
    ];
    fs.writeFileSync(filePath, records.map(stringifyJsonlRecord).join(""), {
      encoding: "utf8",
    });
  }

  private readTranscriptFile(
    filePath: string,
    file: string,
    mtime: number,
  ): SessionTranscript {
    const records = parseJsonlFile(filePath);
    const sessionRecord = records.find(isSessionRecord);
    const turns = records.filter(isTurnRecord).map(
      (record): SessionTranscriptTurn => ({
        id: record.id,
        role: record.role,
        content: record.content,
        timestamp: record.timestamp,
        metadata: {
          ...record.metadata,
          backend: record.backend ?? record.metadata?.backend,
          model: record.model ?? record.metadata?.model,
        },
      }),
    );
    const sessionId =
      sessionRecord?.sessionId ?? file.replace(/\.(json|jsonl)$/, "");
    const updatedAt =
      timestampIso(turns[turns.length - 1]?.timestamp) ??
      sessionRecord?.updatedAt ??
      new Date(mtime).toISOString();
    return {
      sessionId,
      source: sessionRecord?.source ?? this.source,
      createdAt: sessionRecord?.createdAt,
      updatedAt,
      turns,
      metadata: {
        ...sessionRecord?.metadata,
        file,
        path: filePath,
        format: "jarvis-jsonl-v1",
      },
    };
  }

  private listSessionFiles(dateRange: DateRange | null): Array<{
    file: string;
    filePath: string;
    mtime: number;
  }> {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => {
        const filePath = path.join(this.dir, file);
        return { file, filePath, mtime: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .filter(
        ({ mtime }) =>
          !dateRange || mtime >= dateRange.from - this.mtimeBufferMs,
      )
      .slice(0, this.maxScanFiles);
  }

  private findSessionFile(sessionId: string): {
    file: string;
    filePath: string;
    mtime: number;
  } | null {
    const safeSessionId = sanitizeSessionId(sessionId);
    const legacyExpected = `${safeSessionId}.jsonl`;
    const suffixExpected = `_${safeSessionId}.jsonl`;
    return (
      this.listSessionFiles(null).find(
        ({ file }) =>
          file === legacyExpected ||
          file.endsWith(suffixExpected) ||
          file.replace(/\.jsonl$/, "") === sessionId,
      ) ?? null
    );
  }

  private filePathForNewSession(
    sessionId: string,
    timestamp?: string | number,
  ): string {
    return path.join(
      this.dir,
      `${filenameTimestamp(timestamp)}_${sanitizeSessionId(sessionId)}.jsonl`,
    );
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }
}

export class CompositeSessionStore implements SessionStore {
  readonly capabilities: SessionStoreCapabilities;

  constructor(private readonly stores: SessionStore[]) {
    this.capabilities = {
      read: stores.some((store) => store.capabilities.read),
      write: stores.some((store) => store.capabilities.write),
      search: stores.some((store) => store.capabilities.search),
    };
  }

  async listSessions(query?: SessionListQuery): Promise<SessionSummary[]> {
    const seen = new Set<string>();
    const sessions: SessionSummary[] = [];
    for (const store of this.stores) {
      for (const session of await store.listSessions(query)) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        sessions.push(session);
      }
    }
    sessions.sort(
      (left, right) =>
        (normalizeSessionTimestamp(right.updatedAt) ?? 0) -
        (normalizeSessionTimestamp(left.updatedAt) ?? 0),
    );
    return sessions.slice(0, query?.limit ?? sessions.length);
  }

  async readSession(sessionId: string): Promise<SessionTranscript | null> {
    for (const store of this.stores) {
      const session = await store.readSession(sessionId);
      if (session) return session;
    }
    return null;
  }

  async searchTurns(query: SessionSearchQuery): Promise<SessionSearchResult[]> {
    const results: SessionSearchResult[] = [];
    const seen = new Set<string>();
    for (const store of this.stores) {
      for (const result of await store.searchTurns(query)) {
        const key = result.text.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(result);
      }
    }
    results.sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : (b.timestamp ?? 0) - (a.timestamp ?? 0),
    );
    return results.slice(0, query.limit ?? 5);
  }

  async appendTurn(input: SessionAppendInput): Promise<void> {
    const store = this.stores.find(
      (candidate) => candidate.capabilities.write && candidate.appendTurn,
    );
    if (!store?.appendTurn) {
      throw new Error("No writable session store is configured.");
    }
    await store.appendTurn(input);
  }

  async upsertSession(session: SessionTranscript): Promise<void> {
    const store = this.stores.find(
      (candidate) => candidate.capabilities.write && candidate.upsertSession,
    );
    if (!store?.upsertSession) {
      throw new Error("No writable session store is configured.");
    }
    await store.upsertSession(session);
  }
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
