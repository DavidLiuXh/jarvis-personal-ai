import { describe, expect, it } from "vitest";
import {
  transcriptToLlmMessages,
  transcriptToRuntimeConversation,
} from "./transcriptCompiler.js";

describe("transcriptCompiler", () => {
  const transcript = {
    sessionId: "s1",
    source: "jarvis-jsonl-v1",
    turns: [
      { role: "user" as const, content: "hello", timestamp: "t1" },
      { role: "assistant" as const, content: "hi", timestamp: "t2" },
    ],
  };

  it("compiles standard transcripts into backend-neutral LLM messages", () => {
    const messages = transcriptToLlmMessages(transcript);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[0].metadata).toMatchObject({
      source: "jarvis-jsonl-v1",
      sessionId: "s1",
    });
  });

  it("compiles standard transcripts into runtime conversation content", () => {
    const content = transcriptToRuntimeConversation(transcript);

    expect(content).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi" }] },
    ]);
  });
});
