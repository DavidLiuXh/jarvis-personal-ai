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
function classifyResponse(score: number, subject = "external") {
  return JSON.stringify({
    knowledge_score: score,
    operation_score: score,
    complexity_score: score,
    complexity_reasoning: "test",
    query_subject: subject,
    time_window_days: null,
    date_from: null,
    date_to: null,
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

describe("LocalModelRouter — route() with detectShift=true", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs classify and detectTopicShift in parallel when detectShift=true and history>=2", async () => {
    const router = makeRouter();
    // First call = classify, second = detectTopicShift
    mockGenerate
      .mockResolvedValueOnce(classifyResponse(40))
      .mockResolvedValueOnce('{"shifted": true}');

    const result = await router.route(
      "Tell me about investment strategies",
      HISTORY_CODING,
      true,
    );

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.topicShifted).toBe(true);
    expect(result.model).toBe("gemini-2.5-flash"); // score=40 < threshold=70
  });

  it("sets topicShifted=false when detectShift=false", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(80));

    const result = await router.route("new topic", HISTORY_CODING, false);

    expect(mockGenerate).toHaveBeenCalledTimes(1); // only classify
    expect(result.topicShifted).toBe(false);
  });

  it("skips shift detection when history has fewer than 2 turns", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(40));

    const shortHistory: ConversationTurn[] = [
      { role: "user", content: "hello" },
    ];
    const result = await router.route("world", shortHistory, true);

    expect(mockGenerate).toHaveBeenCalledTimes(1); // only classify
    expect(result.topicShifted).toBe(false);
  });

  it("topicShifted=false in fallback result when classify throws", async () => {
    const router = makeRouter();
    mockGenerate.mockRejectedValue(new Error("timeout"));

    const result = await router.route("anything", HISTORY_CODING, true);

    expect(result.source).toBe("local-router/fallback");
    expect(result.topicShifted).toBe(false);
  });

  it("topicShifted=false when shift detection throws but classify succeeds", async () => {
    const router = makeRouter();
    mockGenerate
      .mockResolvedValueOnce(classifyResponse(60))
      .mockRejectedValueOnce(new Error("ollama down"));

    const result = await router.route("anything", HISTORY_CODING, true);

    expect(result.topicShifted).toBe(false);
    expect(result.source).toBe("local-router/ollama");
  });
});

describe("LocalModelRouter — route() topicShifted=false by default", () => {
  beforeEach(() => vi.clearAllMocks());

  it("route() without detectShift param always returns topicShifted=false", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(50));

    const result = await router.route("hello", HISTORY_CODING);

    expect(result.topicShifted).toBe(false);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});
