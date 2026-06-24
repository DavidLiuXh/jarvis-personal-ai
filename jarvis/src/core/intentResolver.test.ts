/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./ollamaClient.js", () => ({
  ollamaGenerateWithRetry: vi.fn(),
}));

import { IntentResolver, type ConversationTurn } from "./intentResolver.js";
import { ollamaGenerateWithRetry } from "./ollamaClient.js";

const mockGenerate = vi.mocked(ollamaGenerateWithRetry);

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
    confidence_by_dimension: {
      subject: 0.8,
      taskType: 0.8,
      memoryTarget: 0.8,
      action: 0.8,
      entityHints: 0.8,
      topicShift: 0.8,
      richIntent: 0.8,
    },
    evidence: ["model_cue"],
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
    intent_steps: [
      {
        id: "step-1",
        type: "analyze",
        action: "analyze external/domain context",
        target: "market analysis",
        depends_on: [],
        requires_confirmation: false,
        risk_level: "low",
      },
    ],
    time_window_days: null,
    date_from: null,
    date_to: null,
    history_topic: "coding",
    new_topic: "market analysis",
    topic_analysis: {
      history: {
        label: "coding",
        evidence: ["reranker timeout"],
        source_turns: [-2, -1],
        confidence: 0.8,
      },
      current: {
        label: "market analysis",
        evidence: ["market"],
        source_turns: [0],
        confidence: 0.8,
      },
      relation: "new_topic",
      relation_reason: "different domain",
      confidence: 0.8,
    },
    references_recent_history: false,
    topic_shifted: true,
    ...overrides,
  });
}

function policyReasonCodes(
  intent: Awaited<ReturnType<IntentResolver["resolve"]>>,
) {
  return intent.policyTrace.map((entry) => entry.reasonCode);
}

describe("IntentResolver", () => {
  beforeEach(() => mockGenerate.mockReset());

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
    expect(intent.confidenceByDimension).toMatchObject({
      subject: 0.8,
      taskType: 0.8,
      richIntent: 0.8,
    });
    expect(intent.richIntent).toMatchObject({
      primaryAction: "analyze",
      contextDependency: {
        longTermMemory: true,
        externalWorld: true,
      },
      riskLevel: "low",
    });
    expect(mockGenerate.mock.calls[0]?.[2]).toMatchObject({
      format: "json",
      numCtx: 8192,
      temperature: 0,
    });
  });

  it("can resolve intent through an injected model client", async () => {
    const modelClient = {
      generateJson: vi.fn().mockResolvedValue(modelResponse()),
    };
    const resolver = new IntentResolver({
      modelClient,
      timeoutMs: 5_000,
      historyTurns: 5,
    });

    const intent = await resolver.resolve({
      userPrompt: "天气怎么样",
      history: [],
    });

    expect(intent.subject).toBe("external");
    expect(modelClient.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: "json",
        contextWindow: 8192,
      }),
    );
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("parses JSON-mode responses that wrap the intent object as a string", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(JSON.stringify(modelResponse()));

    const intent = await resolver.resolve({
      userPrompt: "天气怎么样",
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("analyze");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("normalizes general_chat query_subject to external for greetings", async () => {
    const resolver = makeResolver();
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "general_chat",
        task_type: "chat",
        needs_external_knowledge: false,
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
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Hi Jarvis",
      history: [],
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("chat");
    expect(intent.evidence).toContain(
      "normalized_subject:general_chat->external",
    );
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("Invalid query_subject"),
      ),
    ).toBe(false);
    warnSpy.mockRestore();
  });

  it("repairs malformed intent JSON once before parsing", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce(
        '{"query_subject":"external","task_type":"analyze"',
      )
      .mockResolvedValueOnce(
        `Nested fragment: {"present":false}
Original invalid fragment: {"query_subject":"external"
${modelResponse({
  query_subject: "external",
  task_type: "analyze",
})}`,
      );

    const intent = await resolver.resolve({
      userPrompt: "天气怎么样",
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("analyze");
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[1]?.[2]).toMatchObject({
      format: "json",
      numCtx: 8192,
      temperature: 0,
    });
    expect(mockGenerate.mock.calls[1]?.[1]).toContain(
      "Repair it into one valid raw JSON object",
    );
  });

  it("falls back deterministically when intent JSON repair also fails", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce('{"query_subject":"external"')
      .mockResolvedValueOnce('{"still_invalid":');

    const intent = await resolver.resolve({
      userPrompt: "还记得我偏好的代码风格吗？",
    });

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(intent.subject).toBe("personal");
    expect(intent.taskType).toBe("recall");
    expect(intent.needsMemory).toBe(true);
    expect(intent.evidence).toContain("deterministic_parse_fallback");
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
    expect(intent.evidence).not.toContain("personal_context_cue");
    expect(intent.evidence).not.toContain("low_confidence_external_subject");
  });

  it("uses semantic memory recall target without keyword matching", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "chat",
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "asks for prior conversation",
            span: "那次方案",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: ["ONNX"],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "能把那次方案整理一下吗",
    });

    expect(intent.subject).toBe("personal");
    expect(intent.taskType).toBe("recall");
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "conversation_history",
    );
    expect(intent.evidence).toContain("memory_recall_cue");
  });

  it("corrects prior conversation recall from user memory to conversation history", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "personal recall",
            span: "",
          },
          memoryRecall: {
            present: true,
            target: "user_memory",
            reason: "asks about a personal AI preference",
            span: "我之前说过",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "我之前说过想做一个什么样的个人AI？",
    });

    expect(intent.subject).toBe("personal");
    expect(intent.taskType).toBe("recall");
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "conversation_history",
    );
  });

  it("corrects prior conversation recall from missing memory target", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "chat",
        semantic_evidence: {
          personalContext: {
            present: false,
            reason: "",
            span: "",
          },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: ["梓潼"],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "帮我汇总之前梓潼相关的探讨内容",
    });

    expect(intent.subject).toBe("personal");
    expect(intent.taskType).toBe("recall");
    expect(intent.needsMemory).toBe(true);
    expect(intent.semanticEvidence.memoryRecall.present).toBe(true);
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "conversation_history",
    );
    expect(intent.evidence).toContain("memory_recall_cue");
  });

  it("corrects explicit prior conversation cues away from current context", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        references_recent_history: true,
        topic_analysis: {
          relation: "current_context_reference",
          history: {
            label: "梓潼相关讨论",
            evidence: ["之前讨论过梓潼文化"],
            source_turns: [-1],
          },
          current: {
            label: "梓潼相关汇总",
            evidence: ["帮我汇总之前梓潼相关的探讨内容"],
            source_turns: [0],
          },
          confidence: 0.6,
        },
        semantic_evidence: {
          personalContext: {
            present: false,
            reason: "",
            span: "",
          },
          memoryRecall: {
            present: true,
            target: "current_context_reference",
            reason: "references recent discussion",
            span: "之前梓潼相关的探讨内容",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: ["梓潼"],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "帮我汇总之前梓潼相关的探讨内容",
      history: [
        {
          role: "user",
          content: "还记得之前我们讨论的梓潼相关的内容吗？",
        },
        {
          role: "assistant",
          content:
            "记得。我们之前聊过，您对梓潼、文昌帝君以及古蜀道等相关的文化和符号象征很感兴趣。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicAnalysis.relation).toBe("adjacent_topic");
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "conversation_history",
    );
  });

  it("downgrades self-contained entity questions from current-context references", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "analyze",
        references_recent_history: true,
        topic_shifted: false,
        topic_analysis: {
          relation: "current_context_reference",
          history: {
            label: "AI前沿信息汇总",
            evidence: ["过去一周的 AI 前沿信息", "Google I/O 2026 大会"],
            source_turns: [-1],
            confidence: 0.9,
          },
          current: {
            label: "Gemini Spark发布状态",
            evidence: ["Gemini Spark当前已经发布了？是否已经可用了？"],
            source_turns: [0],
            confidence: 0.9,
          },
          confidence: 0.9,
        },
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "current_context_reference",
            reason: "same AI frontier topic",
            span: "Gemini Spark",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: ["Gemini Spark"],
            peopleOrCompanies: ["Gemini Spark"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Gemini Spark当前已经发布了？是否已经可用了？",
      history: [
        {
          role: "user",
          content: "汇总一周内的ai前沿信息",
        },
        {
          role: "assistant",
          content:
            "本周焦点包括 Google I/O 2026、代理化转型和 AI 安全伦理讨论。",
        },
      ],
    });

    expect(intent.topicShifted).toBe(false);
    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.semanticEvidence.memoryRecall.target).toBe("none");
    expect(intent.topicAnalysis.relation).toBe("subtopic");
    expect(policyReasonCodes(intent)).toContain(
      "SELF_CONTAINED_ENTITY_NOT_CURRENT_CONTEXT",
    );
  });

  it("keeps entity questions as current context when the entity appears in recent history", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "analyze",
        references_recent_history: true,
        topic_analysis: {
          relation: "current_context_reference",
          history: {
            label: "Gemini Spark发布状态",
            evidence: ["Gemini Spark 尚未确认开放时间"],
            source_turns: [-1],
            confidence: 0.9,
          },
          current: {
            label: "Gemini Spark可用性",
            evidence: ["Gemini Spark当前已经可用了？"],
            source_turns: [0],
            confidence: 0.9,
          },
          confidence: 0.9,
        },
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "current_context_reference",
            reason: "asks about recently discussed entity",
            span: "Gemini Spark",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: ["Gemini Spark"],
            peopleOrCompanies: ["Gemini Spark"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Gemini Spark当前已经可用了？",
      history: [
        {
          role: "user",
          content: "Gemini Spark 的发布状态是什么？",
        },
        {
          role: "assistant",
          content: "Gemini Spark 尚未确认全面可用时间。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(true);
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "current_context_reference",
    );
    expect(intent.topicAnalysis.relation).toBe("current_context_reference");
  });

  it("keeps entity status drilldowns adjacent after a broad topical roundup", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "analyze",
        references_recent_history: false,
        topic_shifted: true,
        topic_analysis: {
          relation: "new_topic",
          history: {
            label: "AI前沿信息汇总",
            evidence: ["过去一周 AI 前沿动态"],
            source_turns: [-1],
            confidence: 0.9,
          },
          current: {
            label: "Gemini Spark发布状态",
            evidence: ["Gemini Spark当前已经发布了？是否已经可用了？"],
            source_turns: [0],
            confidence: 0.9,
          },
          confidence: 0.9,
        },
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
            technicalTerms: ["Gemini Spark"],
            peopleOrCompanies: ["Gemini Spark"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Gemini Spark当前已经发布了？是否已经可用了？",
      history: [
        { role: "user", content: "汇总一周内的ai前沿信息" },
        {
          role: "assistant",
          content: "本周 AI 前沿动态包括 Google I/O 和代理化转型。",
        },
      ],
    });

    expect(intent.topicShifted).toBe(false);
    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicAnalysis.relation).toBe("adjacent_topic");
    expect(policyReasonCodes(intent)).toContain("BROAD_TOPIC_ENTITY_DRILLDOWN");
  });

  it("keeps a Gemini product query as a new topic after a stock sentiment report", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "analyze",
        references_recent_history: false,
        topic_shifted: true,
        topic_analysis: {
          relation: "new_topic",
          history: {
            label: "美国股市情绪监测报告",
            evidence: ["NAAIM 风险敞口指数", "机构股票配置"],
            source_turns: [-1],
            confidence: 1,
          },
          current: {
            label: "Gemini Spark产品发布时间",
            evidence: ["Gemini Spark何时才能对普通用户开放可用？"],
            source_turns: [0],
            confidence: 1,
          },
          confidence: 1,
        },
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: { present: false, action: "read", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: ["Gemini Spark"],
            peopleOrCompanies: ["Gemini"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Gemini Spark何时才能对普通用户开放可用？",
      history: [
        { role: "user", content: "生成一份美国股市情绪监测报告" },
        {
          role: "assistant",
          content:
            "美国股市情绪报告：NAAIM 风险敞口指数为 79.27，机构股票配置仍然偏高。",
        },
      ],
    });

    expect(intent.topicShifted).toBe(true);
    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicAnalysis.relation).toBe("new_topic");
    expect(policyReasonCodes(intent)).not.toContain(
      "BROAD_TOPIC_ENTITY_DRILLDOWN",
    );
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

  it("upgrades personal to mixed when personal context includes an external entity", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        needs_external_knowledge: true,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "based on user risk preference",
            span: "我的风险偏好",
          },
          memoryRecall: {
            present: true,
            target: "user_memory",
            reason: "uses stored risk preference",
            span: "我的风险偏好",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: ["NVDA"],
            technicalTerms: [],
            peopleOrCompanies: ["Nvidia"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "结合我的风险偏好分析一下 NVDA 是否适合我",
      history: HISTORY_CODING,
    });

    expect(intent.subject).toBe("mixed");
    expect(intent.evidence).toContain("personal_context_with_external_entity");
  });

  it("forces topicShifted=false for anaphoric current-history references", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        topic_shifted: true,
        references_recent_history: false,
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "model confused current context with old conversation",
            span: "这个方案",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "继续把这个方案拆成任务",
      history: HISTORY_CODING,
    });

    expect(intent.referencesRecentHistory).toBe(true);
    expect(intent.topicShifted).toBe(false);
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "current_context_reference",
    );
    expect(intent.confidenceByDimension.memoryTarget).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(intent.confidenceByDimension.topicShift).toBeGreaterThanOrEqual(0.9);
    expect(intent.richIntent.targets).toContainEqual({
      type: "current_context",
      value: "recent_conversation",
    });
    expect(intent.richIntent.contextDependency.recentConversation).toBe(true);
  });

  it("keeps explicit current-context wording as current context even with prior wording", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "recall",
        references_recent_history: true,
        topic_analysis: {
          relation: "current_context_reference",
          history: {
            label: "reranker timeout",
            evidence: ["timeoutMs option"],
            source_turns: [-1],
            confidence: 0.8,
          },
          current: {
            label: "timeout parameter",
            evidence: ["你之前说的那个超时参数怎么设"],
            source_turns: [0],
            confidence: 0.8,
          },
          confidence: 0.8,
        },
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "current_context_reference",
            reason: "那个 refers to recent context",
            span: "那个超时参数",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "你之前说的那个超时参数怎么设",
      history: HISTORY_CODING,
    });

    expect(intent.referencesRecentHistory).toBe(true);
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "current_context_reference",
    );
    expect(intent.topicAnalysis.relation).toBe("current_context_reference");
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
    expect(intent.confidenceByDimension.taskType).toBeGreaterThanOrEqual(0.9);
    expect(intent.confidenceByDimension.action).toBeGreaterThanOrEqual(0.85);
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

  it("does not treat external previous events as personal recall", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce(
        modelResponse({
          query_subject: "external",
          task_type: "analyze",
          confidence: 0.9,
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          present: true,
          target: "external_past_event",
          reason: "public product launch",
          span: "上次苹果发布会",
        }),
      );

    const intent = await resolver.resolve({
      userPrompt: "上次苹果发布会发布了什么",
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("analyze");
    expect(intent.needsMemory).toBe(false);
    expect(intent.evidence).not.toContain("memory_recall_cue");
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "external_past_event",
    );
  });

  it("uses semantic external past event evidence to forbid recall", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "recall",
        confidence: 0.9,
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "external_past_event",
            reason: "asks about Apple launch event",
            span: "上次苹果发布会",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: ["Apple"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "上次苹果发布会发布了什么",
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("analyze");
    expect(intent.needsMemory).toBe(false);
    expect(intent.evidence).toContain("external_past_event_not_recall");
    expect(intent.evidence).not.toContain("memory_recall_cue");
    expect(policyReasonCodes(intent)).toContain(
      "EXTERNAL_PAST_EVENT_NOT_RECALL",
    );
  });

  it("keeps low-confidence external past events external", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "recall",
        confidence: 0.4,
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "external_past_event",
            reason: "asks about a public past event",
            span: "上次苹果发布会",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: ["Apple"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "上次苹果发布会发布了什么",
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("analyze");
    expect(intent.evidence).not.toContain("low_confidence_external_subject");
  });

  it("does not treat standalone remember phrasing as personal recall", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "recall",
        confidence: 0.9,
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "model confused remember-to-action phrasing",
            span: "记得保存",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "你记得保存这个文件吗",
    });

    expect(intent.subject).toBe("external");
    expect(intent.taskType).toBe("chat");
    expect(intent.needsMemory).toBe(false);
    expect(intent.semanticEvidence.memoryRecall.target).toBe("none");
    expect(intent.semanticEvidence.actionRequest.action).toBe("none");
    expect(intent.evidence).not.toContain("memory_recall_cue");
    expect(policyReasonCodes(intent)).toEqual(
      expect.arrayContaining([
        "REMEMBER_TO_ACTION_NOT_MEMORY_RECALL",
        "REMEMBER_TO_ACTION_TASK_NOT_RECALL",
      ]),
    );
  });

  it("treats personal content-performance questions as analysis, not conversation recall", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_external_knowledge: true,
        candidate_agents: ["content_strategy_analyzer"],
        confidence: 0.95,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "asks about the user's published content performance",
            span: "我在小红书上发布",
          },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "model confused referenced content object with recall",
            span: "一元二次方程",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: ["小红书"],
          },
        },
        topic_analysis: {
          history: {
            label: "初中数学重难点梳理",
            evidence: ["昨天我们讨论了哪些内容"],
            source_turns: [-2, -1],
            confidence: 0.9,
          },
          current: {
            label: "小红书内容推广分析",
            evidence: ["系统分析是材料问题还是其他问题"],
            source_turns: [0],
            confidence: 0.95,
          },
          relation: "new_topic",
          relation_reason: "content strategy analysis differs from recall",
          confidence: 0.95,
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt:
        "我在小红书上发布类似”一元二次方程“这种初中重难点讲解的浏览和点赞数量远不如我发布”中等生如何提升“这种题材，帮我系统分析是我的重难点讲解材料本身问题还是其他问题？",
      history: [
        {
          role: "user",
          content: "昨天我们讨论了哪些内容",
        },
        {
          role: "assistant",
          content:
            "昨天我们主要讨论了初中数学重难点梳理和一元二次方程判别式详解。",
        },
      ],
    });

    expect(intent.subject).toBe("mixed");
    expect(intent.taskType).toBe("analyze");
    expect(intent.needsMemory).toBe(true);
    expect(intent.needsExternalKnowledge).toBe(true);
    expect(intent.semanticEvidence.memoryRecall.target).toBe("none");
    expect(intent.topicShifted).toBe(true);
    expect(intent.candidateAgents).toContain("content_strategy_analyzer");
    expect(intent.evidence).toContain("analysis_cue");
    expect(policyReasonCodes(intent)).toEqual(
      expect.arrayContaining([
        "ANALYSIS_REQUEST_NOT_IMPLICIT_CONVERSATION_RECALL",
        "ANALYSIS_CUE_TASK_OVERRIDE",
        "PERSONAL_CONTEXT_WITH_EXTERNAL_ENTITY",
      ]),
    );
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
    expect(intent.confidenceByDimension.subject).toBeLessThanOrEqual(0.6);
    expect(policyReasonCodes(intent)).toContain(
      "LOW_CONFIDENCE_EXTERNAL_TO_MIXED",
    );
  });

  it("uses action cues to promote chat to execute", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "analyze",
        needs_tool: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "帮我给 intentResolver 增加单元测试",
    });

    expect(intent.taskType).toBe("execute");
    expect(intent.needsTool).toBe(true);
    expect(intent.semanticEvidence.actionRequest.action).toBe("write");
    expect(intent.confidenceByDimension.taskType).toBeGreaterThanOrEqual(0.9);
    expect(intent.confidenceByDimension.action).toBeGreaterThanOrEqual(0.85);
    expect(intent.richIntent.primaryAction).toBe("modify");
    expect(intent.richIntent.contextDependency.localWorkspace).toBe(true);
    expect(intent.evidence).toContain("action_cue");
  });

  it("uses semantic action evidence to promote chat to execute", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "chat",
        needs_tool: false,
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: {
            present: true,
            action: "write",
            object: "localModelRouter test",
          },
          entityHints: {
            tickers: [],
            technicalTerms: ["TypeScript"],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "处理一下 localModelRouter 的测试",
    });

    expect(intent.taskType).toBe("execute");
    expect(intent.needsTool).toBe(true);
    expect(intent.evidence).toContain("action_cue");
  });

  it("adds investment-analysis as a candidate without forcing delegation", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce(
        modelResponse({
          task_type: "delegate",
          needs_tool: true,
          candidate_agents: [],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          tickers: ["GOOGL"],
          technicalTerms: [],
          peopleOrCompanies: ["Google"],
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

  it("does not treat technical acronyms as investment ticker candidates", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce(
        modelResponse({
          task_type: "chat",
          needs_tool: false,
          candidate_agents: [],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          tickers: [],
          technicalTerms: ["ONNX"],
          peopleOrCompanies: [],
        }),
      );

    const intent = await resolver.resolve({
      userPrompt: "分析 ONNX 的基本面",
    });

    expect(intent.candidateAgents).not.toContain("investment-analysis");
    expect(intent.evidence).not.toContain("investment_analysis_candidate");
    expect(intent.semanticEvidence.entityHints.technicalTerms).toContain(
      "ONNX",
    );
  });

  it("uses focused entity hints to add investment candidate", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce(
        modelResponse({
          task_type: "analyze",
          candidate_agents: [],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          tickers: ["NVDA"],
          technicalTerms: [],
          peopleOrCompanies: ["Nvidia"],
        }),
      );

    const intent = await resolver.resolve({
      userPrompt: "分析 NVDA 的基本面",
    });

    expect(intent.candidateAgents).toContain("investment-analysis");
    expect(intent.semanticEvidence.entityHints.tickers).toContain("NVDA");
    expect(intent.confidenceByDimension.entityHints).toBeGreaterThanOrEqual(
      0.85,
    );
    expect(intent.richIntent.targets).toContainEqual({
      type: "external_entity",
      value: "NVDA",
    });
  });

  it("promotes ticker-like company hints to tickers in investment context", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "mixed",
        task_type: "schedule",
        needs_external_knowledge: true,
        needs_tool: true,
        needs_scheduling: true,
        candidate_agents: [],
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "uses user's risk preference",
            span: "我的风险偏好",
          },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: {
            present: true,
            action: "schedule",
            object: "NVDA财报分析",
          },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: ["NVDA"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt:
        "结合我的风险偏好分析 NVDA 最新财报，整理成 markdown，明天早上9点提醒我复盘",
    });

    expect(intent.semanticEvidence.entityHints.tickers).toContain("NVDA");
    expect(intent.semanticEvidence.entityHints.peopleOrCompanies).not.toContain(
      "NVDA",
    );
    expect(intent.candidateAgents).toContain("investment-analysis");
    expect(intent.evidence).toContain("investment_analysis_candidate");
    expect(policyReasonCodes(intent)).toEqual(
      expect.arrayContaining([
        "INVESTMENT_TICKER_NORMALIZATION",
        "INVESTMENT_ANALYSIS_CANDIDATE",
      ]),
    );
  });

  it("adds known technical terms deterministically when entity hints are sparse", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "mixed",
        task_type: "analyze",
        needs_external_knowledge: true,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "uses user's technical preference",
            span: "我的技术偏好",
          },
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
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "结合我的技术偏好，比较一下 React 和 Vue 哪个更适合我",
    });

    expect(intent.semanticEvidence.entityHints.technicalTerms).toEqual(
      expect.arrayContaining(["React", "Vue"]),
    );
    expect(intent.subject).toBe("mixed");
    expect(intent.needsMemory).toBe(true);
  });

  it("keeps mixed personal technical analysis as analysis, not recall", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "mixed",
        task_type: "analyze",
        needs_external_knowledge: true,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "uses user's technical preference",
            span: "我的技术偏好",
          },
          memoryRecall: {
            present: true,
            target: "user_memory",
            reason: "technical preferences are relevant context",
            span: "我的技术偏好",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: ["React", "Vue"],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "结合我的技术偏好，比较一下 React 和 Vue 哪个更适合我",
    });

    expect(intent.subject).toBe("mixed");
    expect(intent.taskType).toBe("analyze");
    expect(intent.semanticEvidence.memoryRecall.target).toBe("user_memory");
    expect(policyReasonCodes(intent)).not.toContain("RECALL_CUE_TASK_OVERRIDE");
  });

  it("trusts semantic technical terms over ticker fallback", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "chat",
        needs_tool: false,
        candidate_agents: [],
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
            technicalTerms: ["RAG"],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "分析 RAG 的基本面",
    });

    expect(intent.candidateAgents).not.toContain("investment-analysis");
    expect(intent.evidence).not.toContain("investment_analysis_candidate");
  });

  it("does not add investment candidate for non-ticker acronyms when hints are empty", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce(
        modelResponse({
          task_type: "chat",
          needs_tool: false,
          candidate_agents: [],
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
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          tickers: [],
          technicalTerms: [],
          peopleOrCompanies: [],
        }),
      );

    const intent = await resolver.resolve({
      userPrompt: "分析 RAG 的基本面",
    });

    expect(intent.semanticEvidence.entityHints.tickers).toHaveLength(0);
    expect(intent.candidateAgents).not.toContain("investment-analysis");
    expect(intent.evidence).not.toContain("investment_analysis_candidate");
  });

  it("keeps explicit agent requests as delegation", async () => {
    const resolver = makeResolver();
    mockGenerate
      .mockResolvedValueOnce(
        modelResponse({
          task_type: "delegate",
          needs_tool: false,
          candidate_agents: ["investment-analysis"],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          tickers: ["NVDA"],
          technicalTerms: [],
          peopleOrCompanies: ["Nvidia"],
        }),
      );

    const intent = await resolver.resolve({
      userPrompt: "agent: investment-analysis 分析 NVDA 的投资价值",
    });

    expect(intent.taskType).toBe("delegate");
    expect(intent.needsTool).toBe(true);
    expect(intent.candidateAgents).toContain("investment-analysis");
    expect(intent.semanticEvidence.actionRequest.action).toBe("delegate");
    expect(intent.confidenceByDimension.action).toBeGreaterThanOrEqual(0.9);
    expect(intent.richIntent).toMatchObject({
      primaryAction: "delegate",
      riskLevel: "medium",
    });
    expect(intent.richIntent.targets).toContainEqual({
      type: "agent",
      value: "investment-analysis",
    });
    expect(intent.intentSteps.map((step) => step.type)).toEqual(["delegate"]);
  });

  it("uses semantic delegate action evidence to preserve delegation", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        task_type: "chat",
        needs_tool: false,
        candidate_agents: ["investment-analysis"],
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: {
            present: true,
            action: "delegate",
            object: "investment-analysis",
          },
          entityHints: {
            tickers: ["NVDA"],
            technicalTerms: [],
            peopleOrCompanies: ["Nvidia"],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "请交给投资分析 agent 看一下 NVDA",
    });

    expect(intent.taskType).toBe("delegate");
    expect(intent.needsTool).toBe(true);
    expect(intent.evidence).toContain("delegate_action_cue");
  });

  it("treats non-none action as present when the model omits actionRequest.present", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "analyze",
        needs_tool: false,
        candidate_agents: ["investment-analysis"],
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: {
            present: false,
            action: "delegate",
            object: "investment-analysis",
          },
          entityHints: {
            tickers: ["GOOGL"],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "请交给投资分析 agent 看一下 GOOGL",
    });

    expect(intent.semanticEvidence.actionRequest.present).toBe(true);
    expect(intent.taskType).toBe("delegate");
    expect(intent.needsTool).toBe(true);
  });

  it("topicShifted=false when there is no conversation history", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        topic_shifted: true,
        references_recent_history: false,
        history_topic: "?",
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Specialized Agent Design",
      // no history passed
    });

    expect(intent.topicShifted).toBe(false);
  });

  it("derives ordered multi-intent steps from semantic evidence and cues", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "analyze",
        needs_external_knowledge: true,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "uses user's risk preference",
            span: "我的风险偏好",
          },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: {
            present: true,
            action: "schedule",
            object: "明天早上9点提醒我复盘",
          },
          entityHints: {
            tickers: ["NVDA"],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        intent_steps: [],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt:
        "结合我的风险偏好分析 NVDA 最新财报，整理成 markdown，明天早上9点提醒我复盘",
    });

    expect(intent.subject).toBe("mixed");
    expect(intent.taskType).toBe("schedule");
    expect(intent.needsMemory).toBe(true);
    expect(intent.needsScheduling).toBe(true);
    expect(intent.intentSteps.map((step) => step.type)).toEqual([
      "recall",
      "analyze",
      "execute",
      "schedule",
    ]);
    expect(intent.intentSteps[1]).toMatchObject({
      type: "analyze",
      target: "NVDA",
      dependsOn: ["step-1"],
    });
    expect(intent.intentSteps[2]).toMatchObject({
      type: "execute",
      dependsOn: ["step-2"],
    });
    expect(intent.intentSteps.at(-1)).toMatchObject({
      type: "schedule",
      dependsOn: ["step-3"],
      requiresConfirmation: true,
      riskLevel: "medium",
    });
  });

  it("canonicalizes parsed multi-intent steps and preserves repeated step types for different targets", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "execute",
        needs_external_knowledge: false,
        needs_tool: true,
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: {
            present: true,
            action: "write",
            object: "docs and tests",
          },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        intent_steps: [
          {
            id: "b",
            type: "execute",
            action: "update docs",
            target: "docs",
            depends_on: ["a"],
            requires_confirmation: false,
            risk_level: "medium",
          },
          {
            id: "a",
            type: "analyze",
            action: "inspect current implementation",
            target: "intent layer",
            depends_on: [],
            requires_confirmation: false,
            risk_level: "low",
          },
          {
            id: "c",
            type: "execute",
            action: "add tests",
            target: "tests",
            depends_on: ["b"],
            requires_confirmation: false,
            risk_level: "medium",
          },
        ],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "先检查 intent layer，再更新文档并补测试",
    });

    expect(intent.intentSteps.map((step) => step.type)).toEqual([
      "analyze",
      "execute",
      "execute",
    ]);
    expect(intent.intentSteps.map((step) => step.target)).toEqual([
      "intent layer",
      "docs",
      "tests",
    ]);
    expect(intent.intentSteps[1].dependsOn).toEqual(["step-1"]);
    expect(intent.intentSteps[2].dependsOn).toEqual(["step-2"]);
  });

  it("preserves parsed multi-intent order when dependencies do not require reordering", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "execute",
        needs_tool: true,
        semantic_evidence: {
          personalContext: { present: false, reason: "", span: "" },
          memoryRecall: {
            present: false,
            target: "none",
            reason: "",
            span: "",
          },
          actionRequest: {
            present: true,
            action: "write",
            object: "reminder then analysis note",
          },
          entityHints: {
            tickers: ["NVDA"],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        intent_steps: [
          {
            id: "a",
            type: "schedule",
            action: "create reminder",
            target: "tomorrow review",
          },
          {
            id: "b",
            type: "analyze",
            action: "analyze company",
            target: "NVDA",
          },
          {
            id: "c",
            type: "execute",
            action: "write note",
            target: "markdown",
          },
        ],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "先设一个明天复盘提醒，再分析 NVDA 并整理成 markdown",
    });

    expect(intent.intentSteps.map((step) => step.type)).toEqual([
      "schedule",
      "analyze",
      "execute",
    ]);
    expect(intent.intentSteps[1].dependsOn).toEqual(["step-1"]);
    expect(intent.intentSteps[2].dependsOn).toEqual(["step-2"]);
  });

  it("keeps schedule as the primary task when delegate and schedule cues both appear", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "external",
        task_type: "execute",
        candidate_agents: [],
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
            tickers: ["TSLA"],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "用 investment-analysis agent 分析 TSLA，明天提醒我复盘",
    });

    expect(intent.taskType).toBe("schedule");
    expect(intent.needsScheduling).toBe(true);
    expect(policyReasonCodes(intent)).toContain("SCHEDULE_CUE_TASK_OVERRIDE");
    expect(policyReasonCodes(intent)).not.toContain(
      "DELEGATE_CUE_TASK_OVERRIDE",
    );
    expect(intent.intentSteps.map((step) => step.type)).not.toContain(
      "analyze",
    );
  });

  it("marks recall plus write artifact requests as needing tools", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_tool: false,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "prior discussion",
            span: "我们之前",
          },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "asks for previous discussion",
            span: "之前关于 intent understanding 的讨论",
          },
          actionRequest: {
            present: true,
            action: "write",
            object: "markdown 文档",
          },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        intent_steps: [],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt:
        "先总结我们之前关于 intent understanding 的讨论，再整理成 markdown 文档",
      history: HISTORY_CODING,
    });

    expect(intent.needsTool).toBe(true);
    expect(intent.intentSteps.map((step) => step.type)).toEqual(
      expect.arrayContaining(["recall", "execute"]),
    );
  });

  it("does not expand current-context save requests into multi-intent recall plans", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "mixed",
        task_type: "execute",
        needs_external_knowledge: false,
        needs_tool: true,
        references_recent_history: true,
        topic_shifted: false,
        topic_analysis: {
          relation: "current_context_reference",
          history: {
            label: "初中二年级下学期数学重难点提要",
            evidence: ["初中二年级下学期数学重难点提要"],
            source_turns: [-1],
            confidence: 1,
          },
          current: {
            label: "Save context to file",
            evidence: ["保存到本地markdown文件"],
            source_turns: [0],
            confidence: 1,
          },
          relation_reason: "save previous answer",
          confidence: 1,
        },
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "uses previous assistant answer",
            span: "保存到本地markdown文件",
          },
          memoryRecall: {
            present: true,
            target: "current_context_reference",
            reason: "refers to the immediately preceding answer",
            span: "保存",
          },
          actionRequest: {
            present: true,
            action: "write",
            object: "本地markdown文件",
          },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        intent_steps: [
          {
            id: "a",
            type: "recall",
            action: "retrieve current context",
            target: "current_context_reference",
          },
          {
            id: "b",
            type: "analyze",
            action: "format current context as markdown",
            target: "初中二年级下学期数学重难点提要",
          },
          {
            id: "c",
            type: "execute",
            action: "save markdown file",
            target: "本地markdown文件",
          },
        ],
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "保存到本地markdown文件",
      history: [
        {
          role: "user",
          content: "初中二年级下学期数学重，难点提要",
        },
        {
          role: "assistant",
          content: "初二下学期数学重难点提要包括方程、几何、函数和统计。",
        },
      ],
    });

    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "current_context_reference",
    );
    expect(intent.intentSteps).toHaveLength(1);
    expect(intent.intentSteps[0]).toMatchObject({
      type: "execute",
      dependsOn: [],
    });
  });

  it("normalizes grounded topic analysis and uses relation for topic shift", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        topic_shifted: false,
        references_recent_history: false,
        history_topic: "Procurement Agent architecture",
        new_topic: "LLM reliability and Agent decision-making",
        topic_analysis: {
          history: {
            label: "AI Agent value in enterprise procurement",
            evidence: ["企业采购流程", "优势与必要性"],
            source_turns: [-2],
            confidence: 0.86,
          },
          current: {
            label: "LLM reliability and Agent decision-making",
            evidence: ["LLM可靠性", "Agent决策"],
            source_turns: [0],
            confidence: 0.84,
          },
          relation: "adjacent_topic",
          relation_reason:
            "Both are about agents, but the focus changes from procurement value to reliability of decisions.",
          confidence: 0.82,
        },
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "LLM可靠性对Agent决策有什么影响？",
      history: [
        {
          role: "user",
          content: "AI Agent在企业采购流程中的优势与必要性？",
        },
        {
          role: "assistant",
          content: "可以从效率、合规、成本控制和供应商协同几个方面分析。",
        },
      ],
    });

    expect(intent.topicShifted).toBe(false);
    expect(intent.topicAnalysis).toMatchObject({
      relation: "adjacent_topic",
      confidence: 0.82,
      history: {
        label: "AI Agent value in enterprise procurement",
        evidence: expect.arrayContaining(["企业采购流程", "优势与必要性"]),
        sourceTurns: [-2],
      },
      current: {
        label: "LLM reliability and Agent decision-making",
        evidence: expect.arrayContaining(["LLM可靠性", "Agent决策"]),
        sourceTurns: [0],
      },
    });
  });

  it("forces topic shift when recall memory target changes from conversation history to user memory", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_external_knowledge: false,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "asks about user's personal profile",
            span: "你还记得我有哪些爱好吗？",
          },
          memoryRecall: {
            present: true,
            target: "user_memory",
            reason: "asks for remembered user hobbies",
            span: "你还记得我有哪些爱好吗？",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        topic_analysis: {
          history: {
            label: "History Retrieval",
            evidence: ["前天我们聊了哪些内容？"],
            source_turns: [-2],
            confidence: 1,
          },
          current: {
            label: "Personal Recall",
            evidence: ["你还记得我有哪些爱好吗？"],
            source_turns: [0],
            confidence: 1,
          },
          relation: "subtopic",
          relation_reason: "both are recall requests",
          confidence: 1,
        },
        references_recent_history: false,
        topic_shifted: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "你还记得我有哪些爱好吗？",
      history: [
        { role: "user", content: "前天我们聊了哪些内容？" },
        {
          role: "assistant",
          content:
            "今天是2026年5月22日，星期五。两天前的对话历史我无法直接取回。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicShifted).toBe(true);
    expect(intent.topicAnalysis).toMatchObject({
      relation: "new_topic",
      relationReason:
        "memory recall target changed from conversation_history to user_memory",
    });
    expect(policyReasonCodes(intent)).toContain("MEMORY_TARGET_TOPIC_SHIFT");
  });

  it("forces topic shift for user-memory recall after unrelated external execution history", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_external_knowledge: false,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "asks about user's stored hobbies",
            span: "我有哪些爱好？",
          },
          memoryRecall: {
            present: true,
            target: "user_memory",
            reason: "asks for remembered user hobbies",
            span: "我有哪些爱好？",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        topic_analysis: {
          history: {
            label: "AI news website crawling",
            evidence: ["curl抓取AI相关新闻", "格式化处理"],
            source_turns: [-2],
            confidence: 1,
          },
          current: {
            label: "Personal hobbies recall",
            evidence: ["我有哪些爱好？"],
            source_turns: [0],
            confidence: 1,
          },
          relation: "adjacent_topic",
          relation_reason: "model incorrectly treats both as assistant tasks",
          confidence: 0.9,
        },
        references_recent_history: false,
        topic_shifted: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "我有哪些爱好？",
      history: [
        {
          role: "user",
          content:
            "你可以锁定几个你知道的AI相关新闻比较权威的网站，然后运行curl命令来抓取信息，对抓取到的内容作格式化处理，最后将结果展现给我",
        },
        {
          role: "assistant",
          content: "我会通过 curl 抓取权威 AI 新闻来源，并整理成结构化摘要。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.semanticEvidence.memoryRecall.target).toBe("user_memory");
    expect(intent.topicShifted).toBe(true);
    expect(intent.topicAnalysis).toMatchObject({
      relation: "new_topic",
    });
    expect(policyReasonCodes(intent)).toContain(
      "USER_MEMORY_RECALL_UNRELATED_RECENT_HISTORY",
    );
  });

  it("forces topic shift for standalone personal requests after unrelated fund analysis history", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_external_knowledge: false,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "asks Jarvis to describe the user profile",
            span: "请描述下我",
          },
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
        topic_analysis: {
          history: {
            label: "Fund outlook and investment advice",
            evidence: ["富国沪深300指数增强", "国联安科技动力"],
            source_turns: [-2],
            confidence: 1,
          },
          current: {
            label: "Personal profile description",
            evidence: ["请描述下我"],
            source_turns: [0],
            confidence: 1,
          },
          relation: "subtopic",
          relation_reason:
            "model incorrectly keeps continuity because both are advice requests",
          confidence: 0.9,
        },
        references_recent_history: false,
        topic_shifted: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "请描述下我",
      history: [
        {
          role: "user",
          content:
            "对于“富国沪深300指数增强”和“国联安科技动力”这两支基金，分析下它们的前景走势，以及投资建议。",
        },
        {
          role: "assistant",
          content:
            "我会从指数增强策略、科技主题波动、基金经理风格和风险收益比几个方面分析。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicShifted).toBe(true);
    expect(intent.topicAnalysis).toMatchObject({
      relation: "new_topic",
      relationReason:
        "standalone personal request is unrelated to recent non-profile history",
    });
    expect(policyReasonCodes(intent)).toContain(
      "PERSONAL_STANDALONE_UNRELATED_RECENT_HISTORY",
    );
  });

  it("uses semantic personal context, not only lexical profile phrases, for standalone personal topic boundaries", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "chat",
        needs_external_knowledge: false,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "asks for guidance about the user's own work style",
            span: "我适合什么样的工作方式？",
          },
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
        topic_analysis: {
          history: {
            label: "Fund outlook and investment advice",
            evidence: ["富国沪深300指数增强", "国联安科技动力"],
            source_turns: [-2],
            confidence: 1,
          },
          current: {
            label: "Personal work style guidance",
            evidence: ["我适合什么样的工作方式？"],
            source_turns: [0],
            confidence: 1,
          },
          relation: "adjacent_topic",
          relation_reason: "model incorrectly treats both as advice requests",
          confidence: 0.9,
        },
        references_recent_history: false,
        topic_shifted: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "我适合什么样的工作方式？",
      history: [
        {
          role: "user",
          content:
            "对于“富国沪深300指数增强”和“国联安科技动力”这两支基金，分析下它们的前景走势，以及投资建议。",
        },
        {
          role: "assistant",
          content:
            "我会从指数增强策略、科技主题波动、基金经理风格和风险收益比几个方面分析。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicShifted).toBe(true);
    expect(policyReasonCodes(intent)).toContain(
      "PERSONAL_STANDALONE_UNRELATED_RECENT_HISTORY",
    );
  });

  it("forces topic shift when recall memory target changes from user memory to conversation history", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_external_knowledge: false,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "asks about prior conversation",
            span: "前天我们聊了哪些内容？",
          },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "asks for conversation history",
            span: "前天我们聊了哪些内容？",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        topic_analysis: {
          history: {
            label: "Personal Recall",
            evidence: ["你还记得我有哪些爱好吗？"],
            source_turns: [-2],
            confidence: 1,
          },
          current: {
            label: "History Retrieval",
            evidence: ["前天我们聊了哪些内容？"],
            source_turns: [0],
            confidence: 1,
          },
          relation: "subtopic",
          relation_reason: "both are recall requests",
          confidence: 1,
        },
        references_recent_history: false,
        topic_shifted: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "前天我们聊了哪些内容？",
      history: [
        { role: "user", content: "你还记得我有哪些爱好吗？" },
        {
          role: "assistant",
          content: "我可以从长期记忆里帮你回顾你的兴趣爱好。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicShifted).toBe(true);
    expect(intent.topicAnalysis).toMatchObject({
      relation: "new_topic",
      relationReason:
        "memory recall target changed from user_memory to conversation_history",
    });
    expect(policyReasonCodes(intent)).toContain("MEMORY_TARGET_TOPIC_SHIFT");
  });

  it("forces topic shift for explicit conversation-history artifact recall", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_external_knowledge: false,
        needs_tool: true,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "asks for a prior artifact",
            span: "之前梳理的中二年级下学期数学重难点提要",
          },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "asks to reopen prior conversation artifact",
            span: "之前梳理的中二年级下学期数学重难点提要",
          },
          actionRequest: {
            present: true,
            action: "read",
            object: "数学重难点提要",
          },
          entityHints: {
            tickers: [],
            technicalTerms: ["数学重难点提要"],
            peopleOrCompanies: [],
          },
        },
        topic_analysis: {
          history: {
            label: "File opening",
            evidence: ["打开 physics_summary.md"],
            source_turns: [-2],
            confidence: 0.8,
          },
          current: {
            label: "Open prior math outline",
            evidence: ["帮我再打开之前梳理的中二年级下学期数学重难点提要"],
            source_turns: [0],
            confidence: 0.9,
          },
          relation: "subtopic",
          relation_reason: "both are file recall/open requests",
          confidence: 0.8,
        },
        references_recent_history: false,
        topic_shifted: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "帮我再打开之前梳理的中二年级下学期数学重难点提要",
      history: [
        {
          role: "user",
          content: "帮我打开之前保存的 physics_summary.md",
        },
        {
          role: "assistant",
          content: "已打开 physics_summary.md。",
        },
      ],
    });

    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.semanticEvidence.memoryRecall.target).toBe(
      "conversation_history",
    );
    expect(intent.topicShifted).toBe(true);
    expect(intent.topicAnalysis).toMatchObject({
      relation: "new_topic",
      relationReason:
        "conversation-history recall targets an explicit prior artifact or topic rather than the current recent context",
    });
    expect(policyReasonCodes(intent)).toContain(
      "CONVERSATION_HISTORY_ARTIFACT_TOPIC_SHIFT",
    );
  });

  it("treats short personal identity assertions as standalone facts, not history recall", async () => {
    const resolver = makeResolver();
    mockGenerate.mockResolvedValueOnce(
      modelResponse({
        query_subject: "personal",
        task_type: "recall",
        needs_external_knowledge: true,
        semantic_evidence: {
          personalContext: {
            present: true,
            reason: "identity statement",
            span: "Javis，我是David Liu",
          },
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "model incorrectly treated it as prior-context recall",
            span: "Javis，我是David Liu",
          },
          actionRequest: { present: false, action: "none", object: "" },
          entityHints: {
            tickers: [],
            technicalTerms: [],
            peopleOrCompanies: ["David Liu"],
          },
        },
        topic_analysis: {
          history: {
            label: "AI monetization in ecommerce",
            evidence: ["电商领域找到一个电商人的小痛点"],
            source_turns: [-2],
            confidence: 0.9,
          },
          current: {
            label: "电商领域AI工具构思",
            evidence: ["Javis，我是David Liu"],
            source_turns: [0],
            confidence: 0.9,
          },
          relation: "subtopic",
          relation_reason: "incorrectly carried over the previous topic",
          confidence: 0.9,
        },
        references_recent_history: false,
        topic_shifted: false,
      }),
    );

    const intent = await resolver.resolve({
      userPrompt: "Javis，我是David Liu",
      history: [
        {
          role: "user",
          content:
            "我是希望在电商领域找到一个电商人的小痛点，据此我有针对性的作一个AI工具来帮它们解决痛点。",
        },
        {
          role: "assistant",
          content: "可以从小商家高频工作流里寻找 AI 工具切入点。",
        },
      ],
    });

    expect(intent.subject).toBe("personal");
    expect(intent.taskType).toBe("chat");
    expect(intent.needsMemory).toBe(false);
    expect(intent.referencesRecentHistory).toBe(false);
    expect(intent.topicShifted).toBe(true);
    expect(intent.semanticEvidence.memoryRecall).toMatchObject({
      present: false,
      target: "none",
    });
    expect(intent.topicAnalysis).toMatchObject({
      relation: "new_topic",
      current: {
        label: "Personal identity assertion",
        evidence: ["Javis，我是David Liu"],
      },
    });
    expect(intent.topicAnalysis.current.label).not.toContain("电商");
    expect(policyReasonCodes(intent)).toEqual(
      expect.arrayContaining([
        "PERSONAL_FACT_ASSERTION_NOT_RECALL",
        "PERSONAL_FACT_ASSERTION_TASK_NOT_RECALL",
      ]),
    );
  });
});
