import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listSessionTranscriptFiles,
  parseSessionTranscriptFile,
} from "./sessionTranscript.js";

describe("sessionTranscript", () => {
  it("normalizes new Jarvis session JSONL turns and legacy Gemini chat messages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-transcripts-"));
    const sessionsDir = path.join(root, "sessions");
    const chatsDir = path.join(root, "chats");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    const jarvisPath = path.join(sessionsDir, "session-jarvis.jsonl");
    const legacyPath = path.join(chatsDir, "session-legacy.jsonl");
    fs.writeFileSync(
      jarvisPath,
      [
        JSON.stringify({ kind: "session", sessionId: "jarvis" }),
        JSON.stringify({
          kind: "turn",
          role: "user",
          content: "昨天讨论了什么？",
          timestamp: "2026-06-28T10:00:00.000Z",
        }),
        JSON.stringify({
          kind: "turn",
          role: "assistant",
          content: "讨论了 TaskGraph session recall。",
          timestamp: "2026-06-28T10:01:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      legacyPath,
      [
        JSON.stringify({ sessionId: "legacy" }),
        JSON.stringify({
          type: "user",
          content: [{ text: "旧格式问题" }],
        }),
        JSON.stringify({
          type: "gemini",
          content: "旧格式回答",
        }),
      ].join("\n") + "\n",
    );

    const files = listSessionTranscriptFiles({
      jarvisSessionsDir: sessionsDir,
      geminiChatsDir: chatsDir,
    });
    expect(files.map((file) => file.source).sort()).toEqual([
      "gemini-cli",
      "jarvis-jsonl",
    ]);

    expect(parseSessionTranscriptFile(jarvisPath).messages).toMatchObject([
      { type: "user", content: "昨天讨论了什么？" },
      { type: "gemini", content: "讨论了 TaskGraph session recall。" },
    ]);
    expect(parseSessionTranscriptFile(legacyPath).messages).toMatchObject([
      { type: "user", content: [{ text: "旧格式问题" }] },
      { type: "gemini", content: "旧格式回答" },
    ]);
  });
});
