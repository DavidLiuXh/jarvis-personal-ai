/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./ollamaClient.js", () => ({
  ollamaGenerate: vi.fn(),
}));

import { IntentResolver, type ConversationTurn } from "./intentResolver.js";
import { ollamaGenerate } from "./ollamaClient.js";

const mockGenerate = vi.mocked(ollamaGenerate);

const HISTORY_CODING: ConversationTurn[] = [
  { role: "user", content: "Help me implement the reranker timeout." },
  {
    role: "assistant",
    content: "We can add a timeout option around the reranker call.",
  },
];

function makeResolver() {
  return new IntentResolver({
    baseUrl: "http://localhost:11434",
    model: "gemma4:e2b",
    timeoutMs: 5_000,
    historyTurns: 5,
  });
}

function modelResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    knowledge_score: 60,
    operation_score: 40,
    complexity_score: 52,
    complexity_reasoning: "test reason",
    query_subject: "external",
    task_type: "analyze",
    needs_external_knowledge: true,
    needs_tool: false,
    needs_scheduling: false,
    candidate_agents: [],
    confidence: 0.8,
    evidence: ["model_cue"],
    time_window_days: null,
    date_from: null,
    date_to: null,
    history_topic: "coding",
    new_topic: "market analysis",
    references_recent_history: false,
    topic_shifted: true,
    ...overrides,
  });
}

describe("IntentResolver", () => {
  beforeEach(() => vi.clearAllMocks());

  it("produces an IntentFrame from local model output", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "mixed",
        task_type: "analyze",
        candidate_agents: ["investment-analysis"],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "结合我的投资风格分析一下 NVDA",
      history: HISTORY_CODING,
    });

    expect(intent).toMatchObject({
      subject: "mixed",
      taskType: "analyze",
      needsMemory: true,
      needsExternalKnowledge: true,
      needsTool: false,
      candidateAgents: ["investment-analysis"],
      topicShifted: true,
      complexityScore: 52,
      confidence: 0.8,
      source: "local-intent/ollama",
    });
  });

  it("upgrades external to personal for memory recall cues", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "chat",
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "帮我总结一下我们之前讨论的 ONNX 部署方案",
      history: HISTORY_CODING,
    });

    expect(intent.subject).toBe("personal");
    expect(intent.taskType).toBe("recall");
    expect(intent.needsMemory).toBe(true);
    expect(intent.evidence).toContain("memory_recall_cue");
  });

  it("upgrades external to mixed for personal-context cues", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({ query_subject: "external" }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Is this framework a good fit for me based on my context?",
    });

    expect(intent.subject).toBe("mixed");
    expect(intent.needsMemory).toBe(true);
    expect(intent.evidence).toContain("personal_context_cue");
  });

  it("forces topicShifted=false for anaphoric current-history references", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        topic_shifted: true,
        references_recent_history: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "这个超时参数应该设多少？",
      history: HISTORY_CODING,
    });

    expect(intent.referencesRecentHistory).toBe(true);
    expect(intent.topicShifted).toBe(false);
  });

  it("uses deterministic schedule cue to set scheduling intent", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "chat",
        needs_scheduling: false,
        needs_tool: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "明天提醒我看 NVDA 财报",
    });

    expect(intent.taskType).toBe("schedule");
    expect(intent.needsScheduling).toBe(true);
    expect(intent.needsTool).toBe(true);
  });

  it("keeps high-confidence pure external questions external", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "analyze",
        confidence: 0.9,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "英伟达财报怎么样",
    });

    expect(intent.subject).toBe("external");
    expect(intent.needsMemory).toBe(false);
  });

  it("upgrades low-confidence external subject to mixed", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        confidence: 0.42,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "这个框架现在值得接入吗",
    });

    expect(intent.subject).toBe("mixed");
    expect(intent.needsMemory).toBe(true);
    expect(intent.evidence).toContain("low_confidence_external_subject");
  });

  it("uses action cues to promote chat to execute", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "chat",
        needs_tool: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "帮我改一下 localModelRouter 的测试",
    });

    expect(intent.taskType).toBe("execute");
    expect(intent.needsTool).toBe(true);
    expect(intent.evidence).toContain("action_cue");
  });

  it("adds investment-analysis as a candidate without forcing delegation", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "delegate",
        needs_tool: true,
        candidate_agents: [],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "分析 GOOGL 的投资价值",
    });

    expect(intent.taskType).toBe("analyze");
    expect(intent.needsTool).toBe(false);
    expect(intent.candidateAgents).toContain("investment-analysis");
    expect(intent.evidence).toContain("investment_analysis_candidate");
    expect(intent.evidence).toContain("delegate_downgraded_to_candidate");
  });

  it("keeps explicit agent requests as delegation", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "delegate",
        needs_tool: false,
        candidate_agents: ["investment-analysis"],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "agent: 分析 NVDA 的投资价值",
    });

    expect(intent.taskType).toBe("delegate");
    expect(intent.needsTool).toBe(true);
    expect(intent.candidateAgents).toContain("investment-analysis");
  });
});
