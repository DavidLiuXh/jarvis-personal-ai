/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  SessionListQuery,
  SessionSearchQuery,
  SessionSearchResult,
  SessionStore,
  SessionStoreCapabilities,
  SessionSummary,
  SessionTranscript,
  SessionTranscriptTurn,
} from "./sessionStore.js";
import type { DateRange } from "./types.js";
import {
  normalizeSessionTimestamp,
  scoreSessionSearchCandidates,
  shouldIncludeSessionSearchPair,
} from "./sessionStore.js";

type RawGeminiSessionMessage = {
  id?: string;
  type: string;
  content: string;
  timestamp?: string | number;
  toolCalls?: unknown[];
};

export type GeminiCliSessionStoreOptions = {
  chatsDir?: string;
  maxScanFiles?: number;
  mtimeBufferMs?: number;
};

function defaultChatsDir(): string {
  return path.join(os.homedir(), ".gemini-jarvis", "storage", "chats");
}

function toLocalDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function extractFilenameDate(filename: string): number | null {
  const m = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function extractSessionMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function mapGeminiRole(type: string): SessionTranscriptTurn["role"] | null {
  if (type === "user") return "user";
  if (type === "gemini" || type === "model" || type === "assistant") {
    return "assistant";
  }
  if (type === "system") return "system";
  if (type === "tool" || type === "tool_call" || type === "tool_result") {
    return "tool";
  }
  return null;
}

export class GeminiCliSessionStore implements SessionStore {
  readonly capabilities: SessionStoreCapabilities = {
    read: true,
    write: false,
    search: true,
  };

  private readonly chatsDir: string;
  private readonly maxScanFiles: number;
  private readonly mtimeBufferMs: number;

  constructor(options: GeminiCliSessionStoreOptions = {}) {
    this.chatsDir = options.chatsDir ?? defaultChatsDir();
    this.maxScanFiles = options.maxScanFiles ?? 50;
    this.mtimeBufferMs = options.mtimeBufferMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  async listSessions(query?: SessionListQuery): Promise<SessionSummary[]> {
    return this.listSessionFiles(query?.dateRange ?? null)
      .slice(0, query?.limit ?? this.maxScanFiles)
      .map(({ file, mtime }) => ({
        sessionId: this.sessionIdFromFilename(file),
        source: "gemini-cli",
        turnCount: 0,
        updatedAt: new Date(mtime).toISOString(),
        metadata: { file },
      }));
  }

  async readSession(sessionId: string): Promise<SessionTranscript | null> {
    const file = this.findSessionFile(sessionId);
    if (!file) return null;
    const messages = this.parseSessionMessages(file.filePath);
    return {
      sessionId: this.sessionIdFromFilename(file.file),
      source: "gemini-cli",
      updatedAt: new Date(file.mtime).toISOString(),
      turns: messages
        .map((message): SessionTranscriptTurn | null => {
          const role = mapGeminiRole(message.type);
          if (!role) return null;
          return {
            id: message.id,
            role,
            content: message.content,
            timestamp: message.timestamp,
            metadata: { type: message.type, toolCalls: message.toolCalls },
          } satisfies SessionTranscriptTurn;
        })
        .filter((turn): turn is SessionTranscriptTurn => turn !== null),
      metadata: { file: file.file, path: file.filePath },
    };
  }

  async searchTurns(query: SessionSearchQuery): Promise<SessionSearchResult[]> {
    const limit = query.limit ?? 5;
    const dateRange = query.dateRange ?? null;
    const pairs: Array<{
      sessionId: string;
      text: string;
      timestamp: number;
      turns: SessionTranscriptTurn[];
      metadata: Record<string, unknown>;
    }> = [];

    for (const { file, filePath, mtime } of this.listSessionFiles(dateRange)) {
      try {
        const sessionId = this.sessionIdFromFilename(file);
        const filenameDate = extractFilenameDate(file);
        const messages = this.parseSessionMessages(filePath);
        for (let index = 0; index < messages.length; index++) {
          const userMsg = messages[index];
          if (userMsg?.type !== "user") continue;
          const followingMessages = messages.slice(index + 1, index + 8);
          const nextUserIndex = followingMessages.findIndex(
            (msg) => msg.type === "user",
          );
          const assistantSearchWindow =
            nextUserIndex === -1
              ? followingMessages
              : followingMessages.slice(0, nextUserIndex);
          const assistantMsg = assistantSearchWindow.find(
            (msg) =>
              msg.type === "gemini" ||
              msg.type === "model" ||
              msg.type === "assistant",
          );
          const timestamp =
            normalizeSessionTimestamp(userMsg.timestamp) ??
            normalizeSessionTimestamp(assistantMsg?.timestamp) ??
            filenameDate ??
            mtime;
          if (
            dateRange &&
            (timestamp < dateRange.from || timestamp >= dateRange.to)
          ) {
            continue;
          }
          const userText = userMsg.content.trim();
          const assistantText = assistantMsg?.content.trim() ?? "";
          if (!shouldIncludeSessionSearchPair({ userText, assistantText })) {
            continue;
          }
          const turns: SessionTranscriptTurn[] = [
            {
              id: userMsg.id,
              role: "user",
              content: userText,
              timestamp: userMsg.timestamp,
              metadata: { type: userMsg.type },
            },
          ];
          if (assistantMsg) {
            turns.push({
              id: assistantMsg.id,
              role: "assistant",
              content: assistantText,
              timestamp: assistantMsg.timestamp,
              metadata: { type: assistantMsg.type },
            });
          }
          pairs.push({
            sessionId,
            text: `User: ${userText}\nJarvis: ${assistantText}`.trim(),
            timestamp,
            turns,
            metadata: { source: "gemini-cli", file },
          });
        }
      } catch {
        /* skip unreadable files */
      }
    }

    const results = scoreSessionSearchCandidates({
      query: query.query,
      candidates: pairs,
      limit,
    });
    const rangeLabel = dateRange
      ? `${toLocalDateString(dateRange.from)}~${toLocalDateString(dateRange.to)}`
      : "all-time";
    console.error(
      `🔎 [conversation-history] lexical fallback query="${query.query.slice(0, 80)}" range=${rangeLabel} pairs=${pairs.length} candidates=${results.length} returned=${results.length}`,
    );
    return results;
  }

  private listSessionFiles(dateRange: DateRange | null): Array<{
    file: string;
    filePath: string;
    mtime: number;
  }> {
    if (!fs.existsSync(this.chatsDir)) return [];
    return fs
      .readdirSync(this.chatsDir)
      .filter((file) => file.endsWith(".json") || file.endsWith(".jsonl"))
      .map((file) => {
        const filePath = path.join(this.chatsDir, file);
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
    return (
      this.listSessionFiles(null).find(
        ({ file }) =>
          file === sessionId ||
          file.replace(/\.(json|jsonl)$/, "") === sessionId,
      ) ?? null
    );
  }

  private parseSessionMessages(filePath: string): RawGeminiSessionMessage[] {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    const records = raw
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return records
      .map((record: any): RawGeminiSessionMessage | null => {
        if (record?.type && record?.content !== undefined) {
          return {
            id: record.id,
            type: record.type,
            content: extractSessionMessageText(record.content),
            timestamp: record.timestamp,
            toolCalls: record.toolCalls,
          } satisfies RawGeminiSessionMessage;
        }
        return null;
      })
      .filter((message): message is RawGeminiSessionMessage => !!message);
  }

  private sessionIdFromFilename(file: string): string {
    return file.replace(/\.(json|jsonl)$/, "");
  }
}
