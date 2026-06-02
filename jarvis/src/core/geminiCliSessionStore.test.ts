import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GeminiCliSessionStore } from "./geminiCliSessionStore.js";

describe("GeminiCliSessionStore", () => {
  it("parses JSONL array content and filters by message timestamp", async () => {
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chats-"));
    fs.writeFileSync(
      path.join(chatsDir, "session-2026-05-19-test.jsonl"),
      [
        JSON.stringify({ sessionId: "test", kind: "main" }),
        JSON.stringify({ $set: { sessionId: "test" } }),
        JSON.stringify({
          id: "u1",
          timestamp: "2026-05-19T10:00:00.000Z",
          type: "user",
          content: [{ text: "构建专用Agent，需要分层考虑哪些因素？" }],
        }),
        JSON.stringify({
          id: "a1",
          timestamp: "2026-05-19T10:01:00.000Z",
          type: "gemini",
          content: "需要从战略定位、知识能力、技术架构和运营安全分层考虑。",
        }),
      ].join("\n") + "\n",
    );

    const store = new GeminiCliSessionStore({ chatsDir });
    const results = await store.searchTurns({
      query: "大前天我们讨论了什么内容？ conversation_history",
      limit: 5,
      dateRange: {
        from: Date.parse("2026-05-19T00:00:00+08:00"),
        to: Date.parse("2026-05-20T00:00:00+08:00"),
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("构建专用Agent");
    expect(results[0].text).toContain("战略定位");
  });

  it("finds assistant replies across tool messages", async () => {
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chats-"));
    fs.writeFileSync(
      path.join(chatsDir, "session-tool-call.jsonl"),
      [
        JSON.stringify({ sessionId: "s2", kind: "main" }),
        JSON.stringify({ $set: { sessionId: "s2" } }),
        JSON.stringify({
          id: "u1",
          timestamp: "2026-05-20T10:00:00.000Z",
          type: "user",
          content: "ONNX模型的配置步骤是什么？",
        }),
        JSON.stringify({
          id: "t1",
          type: "tool_call",
          content: "search(ONNX)",
        }),
        JSON.stringify({ id: "t2", type: "tool_result", content: "result" }),
        JSON.stringify({ id: "t3", type: "tool_result", content: "result2" }),
        JSON.stringify({
          id: "a1",
          timestamp: "2026-05-20T10:02:00.000Z",
          type: "gemini",
          content: "ONNX配置需要先安装onnx-manager，然后执行pull命令。",
        }),
      ].join("\n") + "\n",
    );

    const store = new GeminiCliSessionStore({ chatsDir });
    const results = await store.searchTurns({ query: "ONNX配置" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("ONNX模型");
    expect(results[0].text).toContain("onnx-manager");
  });

  it("uses filename date as timestamp fallback when messages omit timestamps", async () => {
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chats-"));
    fs.writeFileSync(
      path.join(chatsDir, "session-2026-05-01-notimestamp.jsonl"),
      [
        JSON.stringify({ sessionId: "s3", kind: "main" }),
        JSON.stringify({ $set: { sessionId: "s3" } }),
        JSON.stringify({ id: "u1", type: "user", content: "投资风格偏好讨论" }),
        JSON.stringify({
          id: "a1",
          type: "gemini",
          content: "用户偏好稳健型投资风格。",
        }),
      ].join("\n") + "\n",
    );

    const store = new GeminiCliSessionStore({ chatsDir });
    const results = await store.searchTurns({
      query: "投资风格",
      limit: 5,
      dateRange: {
        from: Date.parse("2026-05-01T00:00:00+08:00"),
        to: Date.parse("2026-05-02T00:00:00+08:00"),
      },
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("投资风格");
  });

  it("reads a transcript without exposing Gemini roles to callers", async () => {
    const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chats-"));
    fs.writeFileSync(
      path.join(chatsDir, "session-read.jsonl"),
      [
        JSON.stringify({ sessionId: "read", kind: "main" }),
        JSON.stringify({ $set: { sessionId: "read" } }),
        JSON.stringify({ id: "u1", type: "user", content: "hello" }),
        JSON.stringify({ id: "a1", type: "gemini", content: "hi" }),
      ].join("\n") + "\n",
    );

    const store = new GeminiCliSessionStore({ chatsDir });
    const session = await store.readSession("session-read");

    expect(session?.source).toBe("gemini-cli");
    expect(session?.turns.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
