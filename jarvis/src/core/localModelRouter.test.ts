/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Ollama retry wrapper so tests don't hit a real Ollama server
vi.mock("./ollamaClient.js", () => ({
  ollamaGenerateWithRetry: vi.fn(),
}));

// extractDateRange has no external dependencies — use real implementation
import { LocalModelRouter, type ConversationTurn } from "./localModelRouter.js";
import { ollamaGenerateWithRetry } from "./ollamaClient.js";

const mockGenerate = vi.mocked(ollamaGenerateWithRetry);

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
    task_type: "analyze",
    needs_external_knowledge: true,
    needs_tool: false,
    needs_scheduling: false,
    candidate_agents: [],
    time_window_days: null,
    date_from: null,
    date_to: null,
    confidence: 0.8,
    evidence: ["test"],
    semantic_evidence: {
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: { present: false, action: "none", object: "" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    history_topic: "coding",
    new_topic: "market analysis",
    references_recent_history: false,
    topic_shifted: topicShifted,
  });
}

function conversationRecallResponse(score: number) {
  return JSON.stringify({
    knowledge_score: 95,
    operation_score: 95,
    complexity_score: score,
    complexity_reasoning:
      "The request requires recalling specific past conversation content.",
    query_subject: "personal",
    task_type: "recall",
    needs_external_knowledge: false,
    needs_tool: false,
    needs_scheduling: false,
    candidate_agents: [],
    time_window_days: null,
    date_from: null,
    date_to: null,
    confidence: 1,
    evidence: ["recall", "昨天", "讨论"],
    semantic_evidence: {
      personalContext: { present: true, reason: "past conversation", span: "" },
      memoryRecall: {
        present: true,
        target: "conversation_history",
        reason: "asks what was discussed before",
        span: "昨天我们都讨论了哪些内容",
      },
      actionRequest: { present: false, action: "read", object: "" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    rich_intent: {
      userGoal: "summarize yesterday's discussion",
      domain: "memory_management",
      action: "recall",
      primaryAction: "recall",
      targets: [{ type: "memory", value: "conversation_history" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: true,
        localWorkspace: false,
        externalWorld: false,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intent_steps: [
      {
        id: "step-1",
        type: "recall",
        action: "summarize past conversation",
        target: "conversation_history",
        depends_on: [],
        requires_confirmation: false,
        risk_level: "low",
        operation: {
          domain: "memory_management",
          action: "recall",
          target_type: "memory",
          target: "conversation_history",
          target_id: "",
          selector: "yesterday",
          scope: "long_term",
          risk_level: "low",
        },
      },
    ],
    history_topic: "",
    new_topic: "Recall Past Conversation",
    references_recent_history: false,
    topic_shifted: false,
    topic_analysis: {
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0 },
      current: {
        label: "Recall Past Conversation",
        evidence: ["汇总下昨天我们都讨论了哪些内容"],
        sourceTurns: [0],
        confidence: 1,
      },
      relation: "unknown",
      relationReason: "no history",
      confidence: 1,
      lowGrounding: false,
    },
  });
}

function productRecommendationResponse() {
  return JSON.stringify({
    knowledge_score: 75,
    operation_score: 50,
    complexity_score: 62.5,
    complexity_reasoning:
      "The user is initiating a conversation, requiring basic knowledge retrieval and operational execution.",
    query_subject: "external",
    task_type: "chat",
    needs_external_knowledge: true,
    needs_tool: false,
    needs_scheduling: false,
    candidate_agents: [],
    time_window_days: null,
    date_from: null,
    date_to: null,
    confidence: 1,
    confidence_by_dimension: {
      subject: 1,
      taskType: 1,
      memoryTarget: 1,
      action: 1,
      entityHints: 1,
      topicShift: 1,
      richIntent: 0.85,
    },
    evidence: ["tesla model Y", "用户评价好的行李固定装置"],
    semantic_evidence: {
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: {
        present: true,
        action: "read",
        object: "tesla model Y后背箱用户评价好的行李固定装置",
      },
      entityHints: {
        tickers: [],
        technicalTerms: ["Tesla Model Y", "后背箱", "行李固定装置"],
        peopleOrCompanies: ["Tesla"],
      },
    },
    rich_intent: {
      userGoal: "找到 Tesla Model Y 后备箱用户评价好的行李固定装置",
      domain: "external_knowledge",
      action: "answer",
      primaryAction: "answer",
      targets: [
        { type: "external_entity", value: "Tesla Model Y" },
        { type: "external_entity", value: "行李固定装置" },
      ],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        localWorkspace: false,
        externalWorld: true,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intent_steps: [],
    topic_analysis: {
      relation: "unknown",
      history: {
        label: "Greeting",
        evidence: ["Hi Jarvis"],
        sourceTurns: [-1],
        confidence: 0.4,
      },
      current: {
        label: "Tesla Model Y trunk accessory recommendation",
        evidence: ["tesla model Y后背箱有哪些用户评价好的行李固定装置"],
        sourceTurns: [0],
        confidence: 0.95,
      },
      relationReason: "standalone product recommendation",
      confidence: 0.9,
      lowGrounding: false,
    },
    references_recent_history: false,
    topic_shifted: false,
  });
}

describe("LocalModelRouter — detectTopicShift", () => {
  beforeEach(() => mockGenerate.mockReset());

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

  it("returns false when ollamaGenerateWithRetry throws (conservative default)", async () => {
    const router = makeRouter();
    mockGenerate.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });
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
  beforeEach(() => mockGenerate.mockReset());

  it("returns topicShifted=true when classifier returns topic_shifted=true", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(40, "external", true));

    const result = await router.route(
      "Tell me about quantum computing",
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

  it("topicShifted=false when topic_shifted field is missing from JSON", async () => {
    const router = makeRouter();
    // Explicitly omit topic_shifted from the response JSON
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({
        knowledge_score: 50,
        operation_score: 50,
        complexity_score: 50,
        complexity_reasoning: "test",
        query_subject: "external",
        task_type: "chat",
        needs_external_knowledge: true,
        needs_tool: false,
        needs_scheduling: false,
        candidate_agents: [],
        confidence: 0.8,
        evidence: ["test"],
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        time_window_days: null,
        date_from: null,
        date_to: null,
        // topic_shifted intentionally omitted — parsed.topic_shifted === undefined
      }),
    );

    const result = await router.route("hello", []);

    expect(result.topicShifted).toBe(false);
  });

  it("topicShifted=false in fallback result when classify throws", async () => {
    const router = makeRouter();
    mockGenerate.mockImplementationOnce(async () => {
      throw new Error("timeout");
    });

    const result = await router.route("anything", HISTORY_CODING);

    expect(result.source).toBe("local-router/fallback");
    expect(result.topicShifted).toBe(false);
  });

  it("topicShifted=false forced by anaphoric pre-filter (Chinese pronoun)", async () => {
    const router = makeRouter();
    // LLM says topic_shifted=true, but prompt has anaphoric reference → must be false
    mockGenerate.mockResolvedValueOnce(classifyResponse(50, "external", true));

    const result = await router.route("它的性能怎么样", HISTORY_CODING);

    expect(result.topicShifted).toBe(false);
  });

  it("topicShifted=false when LLM references_recent_history=true even if topic_shifted=true", async () => {
    const router = makeRouter();
    // LLM reports references_recent_history=true but also topic_shifted=true (contradictory) → references_recent_history wins
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({
        knowledge_score: 50,
        operation_score: 50,
        complexity_score: 50,
        complexity_reasoning: "test",
        query_subject: "external",
        task_type: "chat",
        needs_external_knowledge: true,
        needs_tool: false,
        needs_scheduling: false,
        candidate_agents: [],
        confidence: 0.8,
        evidence: ["test"],
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        time_window_days: null,
        date_from: null,
        date_to: null,
        history_topic: "TypeScript development",
        new_topic: "follow-up on tests",
        references_recent_history: true,
        topic_shifted: true,
      }),
    );

    const result = await router.route(
      "What about those tests?",
      HISTORY_CODING,
    );

    expect(result.topicShifted).toBe(false);
  });
});

describe("LocalModelRouter — query subject personal-context guard", () => {
  beforeEach(() => mockGenerate.mockReset());

  it("upgrades classifier external to mixed for Chinese personal-context cues", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(60, "external", false));

    const result = await router.route("按我的投资风格分析一下英伟达");

    expect(result.querySubject).toBe("mixed");
  });

  it("upgrades classifier external to mixed for English personal-context cues", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(60, "external", false));

    const result = await router.route(
      "Is this framework a good fit for me based on my context?",
    );

    expect(result.querySubject).toBe("mixed");
  });

  it("keeps pure external questions external", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(classifyResponse(60, "external", false));

    const result = await router.route("英伟达最新财报怎么样");

    expect(result.querySubject).toBe("external");
  });
});

describe("LocalModelRouter — routing score calibration", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T04:00:00+08:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes simple time-scoped conversation recall to flash even when raw complexity is high", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(conversationRecallResponse(97));

    const result = await router.route("汇总下昨天我们都讨论了哪些内容");

    expect(result.querySubject).toBe("personal");
    expect(result.intent?.complexityScore).toBe(97);
    expect(result.dateFrom).toBe("2026-06-01");
    expect(result.dateTo).toBe("2026-06-01");
    expect(result.score).toBeLessThan(70);
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.classifierReason).toContain(
      "calibration=time_scoped_conversation_recall",
    );
  });

  it("still down-scores time-scoped conversation recall when the model overstates tool need", async () => {
    const router = makeRouter();
    const parsed = JSON.parse(conversationRecallResponse(80));
    parsed.needs_tool = true;
    mockGenerate.mockResolvedValueOnce(JSON.stringify(parsed));

    const result = await router.route("汇总下昨天我们讨论了什么内容");

    expect(result.score).toBe(58);
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.classifierReason).toContain(
      "calibration=time_scoped_conversation_recall",
    );
  });

  it("does not downscore recall requests that also require external analysis", async () => {
    const router = makeRouter();
    const parsed = JSON.parse(conversationRecallResponse(88));
    parsed.needs_external_knowledge = true;
    parsed.task_type = "analyze";
    parsed.intent_steps.push({
      id: "step-2",
      type: "analyze",
      action: "analyze implications",
      target: "external context",
      depends_on: ["step-1"],
      requires_confirmation: false,
      risk_level: "low",
      operation: {
        domain: "external_knowledge",
        action: "analyze",
        target_type: "external_entity",
        target: "external context",
        target_id: "",
        selector: "",
        scope: "external",
        risk_level: "low",
      },
    });
    mockGenerate.mockResolvedValueOnce(JSON.stringify(parsed));

    const result = await router.route(
      "汇总昨天讨论的内容，并结合最新行业动态分析一下",
    );

    expect(result.score).toBe(88);
    expect(result.model).toBe("gemini-2.5-pro");
    expect(result.classifierReason).not.toContain(
      "calibration=time_scoped_conversation_recall",
    );
  });

  it("calibrates external product recommendation after greeting history as low-operation analyze", async () => {
    const router = makeRouter();
    mockGenerate.mockResolvedValueOnce(productRecommendationResponse());

    const result = await router.route(
      "tesla model Y后背箱有哪些用户评价好的行李固定装置",
      [{ role: "user", content: "Hi Jarvis" }],
    );

    expect(result.querySubject).toBe("external");
    expect(result.intent?.taskType).toBe("analyze");
    expect(result.intent?.needsMemory).toBe(false);
    expect(result.intent?.operationScore).toBeLessThanOrEqual(35);
    expect(result.score).toBeLessThan(70);
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.classifierReason).toContain(
      "calibration=external_product_recommendation",
    );
    expect(result.classifierReason).not.toMatch(/initiating.*conversation/i);
  });
});
