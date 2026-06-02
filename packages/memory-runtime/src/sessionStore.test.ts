import { describe, expect, it } from "vitest";
import {
  CompositeSessionStore,
  extractSessionSearchTerms,
  JarvisJsonlSessionStore,
  scoreSessionSearchCandidates,
  type SessionStore,
} from "./sessionStore.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("sessionStore helpers", () => {
  it("extracts discriminative Chinese terms for conversation recall", () => {
    expect(
      extractSessionSearchTerms("帮我汇总之前梓潼相关的探讨内容"),
    ).toContain("梓潼");
  });

  it("scores matching transcript candidates with recency tiebreak", () => {
    const results = scoreSessionSearchCandidates({
      query: "ONNX配置",
      candidates: [
        {
          sessionId: "old",
          text: "User: ONNX模型的配置步骤是什么？\nJarvis: 安装 onnx-manager。",
          timestamp: 1,
        },
        {
          sessionId: "new",
          text: "User: ONNX模型的配置步骤是什么？\nJarvis: 执行 pull 命令。",
          timestamp: 2,
        },
        {
          sessionId: "other",
          text: "User: 梓潼的文化意义是什么？",
          timestamp: 3,
        },
      ],
    });

    expect(results.map((result) => result.sessionId)).toEqual(["new", "old"]);
  });

  it("writes, reads, and searches Jarvis JSONL transcript v1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-session-store-"));
    const store = new JarvisJsonlSessionStore({ dir });

    await store.appendTurn({
      sessionId: "session-openai",
      turn: {
        role: "user",
        content: "ONNX模型的配置步骤是什么？",
        timestamp: "2026-06-02T10:00:00.000Z",
        metadata: { backend: "openai", model: "gpt-4.1" },
      },
    });
    await store.appendTurn({
      sessionId: "session-openai",
      turn: {
        role: "assistant",
        content: "ONNX配置需要先安装onnx-manager，然后执行pull命令。",
        timestamp: "2026-06-02T10:01:00.000Z",
        metadata: { backend: "openai", model: "gpt-4.1" },
      },
    });

    const session = await store.readSession("session-openai");
    const results = await store.searchTurns({ query: "ONNX配置" });
    const writtenFiles = fs.readdirSync(dir);
    const transcriptFile = writtenFiles.find((file) =>
      file.endsWith("_session-openai.jsonl"),
    );
    const fileContent = fs.readFileSync(
      path.join(dir, transcriptFile ?? ""),
      "utf8",
    );

    expect(transcriptFile).toBe(
      "2026-06-02T10-00-00-000Z_session-openai.jsonl",
    );
    expect(session?.source).toBe("jarvis-jsonl-v1");
    expect(session?.turns.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(results[0].text).toContain("onnx-manager");
    expect(fileContent).toContain('"kind":"session"');
    expect(fileContent).toContain('"schemaVersion":1');
    expect(fileContent).toContain('"backend":"openai"');
  });

  it("composes writable primary store with legacy search fallback", async () => {
    const primaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "jarvis-primary-session-store-"),
    );
    const primary = new JarvisJsonlSessionStore({ dir: primaryDir });
    const legacy: SessionStore = {
      capabilities: { read: true, write: false, search: true },
      async listSessions() {
        return [];
      },
      async readSession() {
        return null;
      },
      async searchTurns() {
        return [
          {
            sessionId: "legacy",
            text: "User: 梓潼的文化意义是什么？\nJarvis: 梓潼是文昌帝君的发源地。",
            score: 0.9,
            timestamp: 1,
          },
        ];
      },
    };
    const composite = new CompositeSessionStore([primary, legacy]);

    await composite.appendTurn({
      sessionId: "new-session",
      turn: { role: "user", content: "hello" },
    });
    const fallbackResults = await composite.searchTurns({ query: "梓潼" });

    expect(
      fs
        .readdirSync(primaryDir)
        .some((file) => file.endsWith("_new-session.jsonl")),
    ).toBe(true);
    expect(fallbackResults[0].sessionId).toBe("legacy");
  });
});
