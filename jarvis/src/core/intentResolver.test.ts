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
    });
    expect(intent.intentSteps.at(-1)).toMatchObject({
      type: "schedule",
      requiresConfirmation: true,
      riskLevel: "medium",
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
});
