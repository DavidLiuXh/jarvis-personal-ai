/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionMessage } from "./sessionSummarizer.js";

export type SessionConversationRecord = Record<string, unknown>;

export type SessionTranscriptFile = {
  name: string;
  filePath: string;
  mtime: number;
  source: "jarvis-jsonl" | "gemini-cli";
};

export type SessionTranscriptRoots = {
  jarvisSessionsDir: string;
  geminiChatsDir: string;
};

export function defaultSessionTranscriptRoots(): SessionTranscriptRoots {
  return {
    jarvisSessionsDir: path.join(
      os.homedir(),
      ".gemini-jarvis",
      "storage",
      "sessions",
    ),
    geminiChatsDir: path.join(
      os.homedir(),
      ".gemini-jarvis",
      "storage",
      "chats",
    ),
  };
}

export function sessionTranscriptRootsFromProjectTempDir(
  projectTempDir: string,
): SessionTranscriptRoots {
  return {
    jarvisSessionsDir: path.join(
      os.homedir(),
      ".gemini-jarvis",
      "storage",
      "sessions",
    ),
    geminiChatsDir: path.join(projectTempDir, "chats"),
  };
}

export function listSessionTranscriptFiles(
  roots: SessionTranscriptRoots = defaultSessionTranscriptRoots(),
): SessionTranscriptFile[] {
  const files: SessionTranscriptFile[] = [];
  const seen = new Set<string>();
  for (const [dir, source] of [
    [roots.jarvisSessionsDir, "jarvis-jsonl"],
    [roots.geminiChatsDir, "gemini-cli"],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      const key = path.resolve(filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        files.push({ name, filePath, mtime: stat.mtimeMs, source });
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return files.sort((a, b) => a.mtime - b.mtime);
}

export function parseSessionTranscriptFile(filePath: string): {
  messages: SessionMessage[];
  record: SessionConversationRecord;
} {
  const content = fs.readFileSync(filePath, "utf8");
  const isJsonl = filePath.endsWith(".jsonl");
  if (!isJsonl) {
    const parsed = JSON.parse(content) as SessionConversationRecord & {
      messages?: SessionMessage[];
    };
    return {
      messages: (parsed.messages ?? [])
        .map(normalizeSessionMessage)
        .filter((message): message is SessionMessage => Boolean(message)),
      record: parsed,
    };
  }

  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    return { messages: [], record: {} };
  }

  let record: SessionConversationRecord = {};
  try {
    record = JSON.parse(lines[0]) as SessionConversationRecord;
  } catch {
    record = {};
  }
  const messages: SessionMessage[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const message = normalizeSessionMessage(JSON.parse(lines[i]));
      if (message) messages.push(message);
    } catch {
      /* skip malformed line */
    }
  }
  return { messages, record };
}

export function extractSessionMessageText(content: unknown): string {
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

function normalizeSessionMessage(value: unknown): SessionMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";
  const role = typeof record.role === "string" ? record.role : "";
  const oldType = typeof record.type === "string" ? record.type : "";
  let type = oldType;
  if (!type && kind === "turn") {
    if (role === "assistant") type = "gemini";
    else if (role === "user" || role === "system" || role === "tool")
      type = role;
  }
  if (!type || record.content === undefined) return null;
  return {
    type,
    content: record.content,
    timestamp:
      typeof record.timestamp === "string" ||
      typeof record.timestamp === "number"
        ? record.timestamp
        : undefined,
    toolCalls: Array.isArray(record.toolCalls)
      ? (record.toolCalls as Array<{ name: string; result: unknown }>)
      : undefined,
  };
}
