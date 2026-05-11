/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ollamaGenerate so tests don't hit a real Ollama server
vi.mock("./ollamaClient.js", () => ({
  ollamaGenerate: vi.fn(),
}));

// extractDateRange has no external dependencies — use real implementation
import { LocalModelRouter, type ConversationTurn } from "./localModelRouter.js";
import { ollamaGenerate } from "./ollamaClient.js";

const mockGenerate = vi.mocked(ollamaGenerate);

const HISTORY_2_TURNS: ConversationTurn[] = [
  { role: "user", content: "What is the capital of France?" },
  { role: "assistant", content: "The capital of France is Paris." },
];

const HISTORY_CODING: ConversationTurn[] = [
  { role: "user", content: "Help me fix this TypeScript error" },
  {
    role: "assistant",
    content: "The issue is a missing type annotation on line 42.",
  },
  { role: "user", content: "Can you also add unit tests?" },
  { role: "assistant", content: "Sure, here are the tests..." },
];

function makeRouter() {
  return new LocalModelRouter(
    "http://localhost:11434",
    "gemma4:e2b",
    70,
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    5_000,
    5,
  );
}

// Standard classify response
function classifyResponse(
  score: number,
  subject = "external",
  topicShifted = false,
) {
  return JSON.stringify({
    knowledge_score: score,
    operation_score: score,
    complexity_score: score,
    complexity_reasoning: "test",
    query_subject: subject,
    time_window_days: null,
    date_from: null,
    date_to: null,
    topic_shifted: topicShifted,
  });
}

describe("LocalModelRouter — detectTopicShift", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when model says shifted=true", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValue('{"shifted": true}');
    const result = await router.detectTopicShift(
      "Tell me about quantum computing",
      HISTORY_2_TURNS,
    );
    expect(result).toBe(true);
  });

  it("returns false when model says shifted=false", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValue('{"shifted": false}');
    const result = await router.detectTopicShift(
      "What about Berlin?",
      HISTORY_2_TURNS,
    );
    expect(result).toBe(false);
  });

  it("returns false on malformed JSON (conservative default)", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValue("not json at all");
    const result = await router.detectTopicShift("anything", HISTORY_2_TURNS);
    expect(result).toBe(false);
  });

  it("returns false when ollamaGenerate throws (conservative default)", async () => {
    const router = makeRouter();
    mockGenerate.mockRejectedValue(new Error("connection refused"));
    const result = await router.detectTopicShift("anything", HISTORY_2_TURNS);
    expect(result).toBe(false);
  });

  it("handles markdown-fenced JSON response", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValue('```json\n{"shifted": true}\n```');
    const result = await router.detectTopicShift("anything", HISTORY_2_TURNS);
    expect(result).toBe(true);
  });
});

describe("LocalModelRouter — route() topic_shifted via classify", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns topicShifted=true when classifier returns topic_shifted=true", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(40, "external", true));

    const result = await router.route(
      "Tell me about investment strategies",
      HISTORY_CODING,
    );

    expect(mockGenerate).toHaveBeenCalledTimes(1); // single call only
    expect(result.topicShifted).toBe(true);
    expect(result.model).toBe("gemini-2.5-flash");
  });

  it("returns topicShifted=false when classifier returns topic_shifted=false", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(80, "external", false));

    const result = await router.route("follow-up question", HISTORY_CODING);

    expect(result.topicShifted).toBe(false);
  });

  it("topicShifted=false when topic_shifted absent from classifier response", async () => {
    const router = makeRouter();
    // Response without topic_shifted field
    mockGenerate.mockResolvedValueOnce(classifyResponse(50));

    const result = await router.route("hello", HISTORY_CODING);

    expect(result.topicShifted).toBe(false);
  });

  it("topicShifted=false in fallback result when classify throws", async () => {
    const router = makeRouter();
    mockGenerate.mockRejectedValue(new Error("timeout"));

    const result = await router.route("anything", HISTORY_CODING);

    expect(result.source).toBe("local-router/fallback");
    expect(result.topicShifted).toBe(false);
  });
});
