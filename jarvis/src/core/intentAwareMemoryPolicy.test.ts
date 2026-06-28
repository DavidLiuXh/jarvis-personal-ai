/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame } from "./intentResolver.js";
import {
  buildIntentAwareMemoryPolicy,
  buildStepMemoryDecisions,
} from "./intentAwareMemoryPolicy.js";

const CONFIG = {
  prewarmLimit: 3,
  prewarmLimitMixed: 1,
  memoryMaxDistance: 1.0,
  prewarmMaxDistanceMixed: 0.6,
};

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  return {
    subject: "personal",
    taskType: "recall",
    needsMemory: true,
    needsExternalKnowledge: false,
    needsTool: false,
    needsScheduling: false,
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 40,
    knowledgeScore: 40,
    operationScore: 40,
    reason: "test",
    confidence: 0.8,
    confidenceByDimension: {
      subject: 0.8,
      taskType: 0.8,
      memoryTarget: 0.8,
      action: 0.8,
      entityHints: 0.8,
      topicShift: 0.8,
      richIntent: 0.8,
    },
    evidence: [],
    semanticEvidence: {
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: {
        present: true,
        target: "conversation_history",
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
    richIntent: {
      userGoal: "test goal",
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
    intentSteps: [
      {
        id: "step-1",
        type: "recall",
        action: "retrieve relevant user context",
        target: "conversation_history",
        dependsOn: [],
        requiresConfirmation: false,
        riskLevel: "low",
      },
    ],
    topicAnalysis: {
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0.8 },
      current: {
        label: "test goal",
        evidence: ["test goal"],
        sourceTurns: [0],
        confidence: 0.8,
      },
      relation: "unknown",
      relationReason: "",
      confidence: 0.8,
      lowGrounding: false,
    },
    source: "local-intent/ollama",
    ...overrides,
  };
}

describe("buildIntentAwareMemoryPolicy", () => {
  it("skips all memory injection for external past events", () => {
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "去年英伟达财报表现怎么样",
      querySubject: "external",
      config: CONFIG,
      intent: intent({
        subject: "external",
        needsMemory: false,
        semanticEvidence: {
          ...intent().semanticEvidence,
          memoryRecall: {
            present: true,
            target: "external_past_event",
            reason: "",
            span: "",
          },
        },
        richIntent: {
          ...intent().richIntent,
          contextDependency: {
            recentConversation: false,
            longTermMemory: false,
            localWorkspace: false,
            externalWorld: true,
          },
        },
      }),
    });

    expect(policy.allowFacts).toBe(false);
    expect(policy.allowSummary).toBe(false);
    expect(policy.allowPrewarm).toBe(false);
    expect(policy.reasons).toContain("external_past_event");
    expect(policy.contract).toMatchObject({
      needMemory: false,
      subjectBoundary: "external",
      targetScopes: [],
      memoryTarget: "external_past_event",
    });
    expect(policy.contract.constraints.allowPersonalFacts).toBe(false);
  });

  it("skips long-term memory for current-context references", () => {
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "继续把这个方案拆成任务",
      querySubject: "personal",
      config: CONFIG,
      intent: intent({
        semanticEvidence: {
          ...intent().semanticEvidence,
          memoryRecall: {
            present: true,
            target: "current_context_reference",
            reason: "",
            span: "",
          },
        },
        richIntent: {
          ...intent().richIntent,
          targets: [{ type: "current_context", value: "recent_conversation" }],
          contextDependency: {
            recentConversation: true,
            longTermMemory: false,
            localWorkspace: false,
            externalWorld: false,
          },
        },
      }),
    });

    expect(policy.allowFacts).toBe(false);
    expect(policy.allowSummary).toBe(false);
    expect(policy.allowPrewarm).toBe(false);
    expect(policy.reasons).toContain("current_context_reference");
  });

  it("uses conservative prewarm policy for mixed memory-dependent intents", () => {
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "结合我的风险偏好分析 NVDA",
      querySubject: "mixed",
      config: CONFIG,
      intent: intent({
        subject: "mixed",
        taskType: "analyze",
        needsExternalKnowledge: true,
        semanticEvidence: {
          ...intent().semanticEvidence,
          personalContext: { present: true, reason: "", span: "" },
          entityHints: {
            tickers: ["NVDA"],
            technicalTerms: [],
            peopleOrCompanies: [],
          },
        },
        richIntent: {
          ...intent().richIntent,
          primaryAction: "analyze",
          targets: [{ type: "external_entity", value: "NVDA" }],
          contextDependency: {
            recentConversation: false,
            longTermMemory: true,
            localWorkspace: false,
            externalWorld: true,
          },
        },
      }),
    });

    expect(policy.allowFacts).toBe(true);
    expect(policy.allowPrewarm).toBe(true);
    expect(policy.prewarmLimit).toBe(1);
    expect(policy.prewarmMaxDistance).toBe(0.6);
    expect(policy.factQuery).toContain("PRIVATE_USER_DATA");
    expect(policy.prewarmQuery).toContain("NVDA");
    expect(policy.contract).toMatchObject({
      needMemory: true,
      subjectBoundary: "mixed",
      targetScopes: ["session", "fact", "entry"],
    });
    expect(policy.contract.query.entities).toContain("NVDA");
  });

  it("does not carry previous-topic memory target or entities into fact query after topic shift", () => {
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "介绍下文昌帝君",
      querySubject: "personal",
      config: CONFIG,
      intent: intent({
        taskType: "analyze",
        topicShifted: true,
        referencesRecentHistory: false,
        semanticEvidence: {
          ...intent().semanticEvidence,
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "stale previous-topic signal",
            span: "",
          },
          entityHints: {
            tickers: [],
            technicalTerms: ["DMII framework"],
            peopleOrCompanies: [],
          },
        },
        richIntent: {
          ...intent().richIntent,
          primaryAction: "analyze",
          targets: [{ type: "memory", value: "conversation_history" }],
        },
      }),
    });

    expect(policy.factQuery).toBe(
      "PRIVATE_USER_DATA: User Query - 介绍下文昌帝君",
    );
    expect(policy.factQuery).not.toContain("conversation_history");
    expect(policy.factQuery).not.toContain("DMII");
    expect(policy.prewarmQuery).toBe("介绍下文昌帝君");
    expect(policy.contract.query.rewritten).toBeUndefined();
    expect(policy.contract.query.entities).toEqual([]);
  });

  it("disables prewarm when subject or memory confidence is low", () => {
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "我之前说过什么",
      querySubject: "personal",
      config: CONFIG,
      intent: intent({
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          memoryTarget: 0.4,
        },
      }),
    });

    expect(policy.allowFacts).toBe(true);
    expect(policy.allowSummary).toBe(false);
    expect(policy.allowPrewarm).toBe(false);
    expect(policy.reasons).toContain("low_intent_confidence");
  });

  it("allows memory for multi-intent tool tasks when a recall step requires it", () => {
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "先总结我们之前关于 Jarvis 的讨论，再整理成 markdown",
      querySubject: "personal",
      config: CONFIG,
      intent: intent({
        taskType: "execute",
        needsMemory: false,
        needsTool: true,
        semanticEvidence: {
          ...intent().semanticEvidence,
          memoryRecall: {
            present: true,
            target: "conversation_history",
            reason: "asks for prior discussion",
            span: "之前关于 Jarvis 的讨论",
          },
          actionRequest: {
            present: true,
            action: "write",
            object: "markdown",
          },
        },
        richIntent: {
          ...intent().richIntent,
          primaryAction: "modify",
          contextDependency: {
            recentConversation: false,
            longTermMemory: false,
            localWorkspace: true,
            externalWorld: false,
          },
        },
        intentSteps: [
          {
            id: "step-1",
            type: "recall",
            action: "retrieve relevant user context",
            target: "conversation_history",
            dependsOn: [],
            requiresConfirmation: false,
            riskLevel: "low",
          },
          {
            id: "step-2",
            type: "execute",
            action: "produce markdown",
            target: "markdown",
            dependsOn: ["step-1"],
            requiresConfirmation: false,
            riskLevel: "medium",
          },
        ],
      }),
    });

    expect(policy.allowFacts).toBe(true);
    expect(policy.allowSummary).toBe(true);
    expect(policy.allowPrewarm).toBe(true);
    expect(policy.reasons).not.toContain("tool_task_without_memory_dependency");
  });

  it("uses session and entry history for time-scoped conversation-history recall", () => {
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "汇总下昨天我们都讨论了哪些内容",
      querySubject: "personal",
      config: CONFIG,
      intent: intent({
        resolvedDateRange: {
          from: Date.parse("2026-05-25T00:00:00+08:00"),
          to: Date.parse("2026-05-26T00:00:00+08:00"),
        },
        dateFrom: "2026-05-25",
        dateTo: "2026-05-26",
      }),
    });

    expect(policy.allowFacts).toBe(false);
    expect(policy.allowSummary).toBe(true);
    expect(policy.allowPrewarm).toBe(true);
    expect(policy.contract.query.rewritten).toBeUndefined();
    expect(policy.contract.query.raw).toBe("汇总下昨天我们都讨论了哪些内容");
    expect(policy.contract.targetScopes).toEqual(["session", "entry"]);
    expect(policy.contract.constraints).toMatchObject({
      allowPersonalFacts: false,
      allowSessionHistory: true,
      allowEntries: true,
    });
    expect(policy.reasons).toContain("time_scoped_conversation_history");
  });

  it("derives per-step memory decisions from the shared contract", () => {
    const frame = intent({
      taskType: "execute",
      needsTool: true,
      semanticEvidence: {
        ...intent().semanticEvidence,
        memoryRecall: {
          present: true,
          target: "conversation_history",
          reason: "asks for previous discussion",
          span: "之前讨论",
        },
      },
      richIntent: {
        ...intent().richIntent,
        primaryAction: "modify",
        contextDependency: {
          recentConversation: false,
          longTermMemory: true,
          localWorkspace: true,
          externalWorld: false,
        },
      },
      intentSteps: [
        {
          id: "step-1",
          type: "recall",
          action: "recall previous discussion",
          target: "Jarvis runtime",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-2",
          type: "execute",
          action: "save markdown",
          target: "runtime notes",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
        {
          id: "step-3",
          type: "schedule",
          action: "create reminder",
          target: "tomorrow review",
          dependsOn: ["step-2"],
          requiresConfirmation: false,
          riskLevel: "medium",
        },
      ],
    });
    const policy = buildIntentAwareMemoryPolicy({
      userPrompt: "总结之前讨论并保存，明天提醒我复盘",
      querySubject: "personal",
      config: CONFIG,
      intent: frame,
    });

    const decisions = buildStepMemoryDecisions({
      intent: frame,
      contract: policy.contract,
    });

    expect(decisions).toHaveLength(3);
    expect(decisions[0]).toMatchObject({
      stepId: "step-1",
      needMemory: true,
      targetScopes: expect.arrayContaining(["entry"]),
    });
    expect(decisions[2]).toMatchObject({
      stepId: "step-3",
      needMemory: false,
      targetScopes: [],
    });
  });
});
