/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame } from "./intentResolver.js";
import {
  applyClarificationChannelState,
  buildClarificationDecision,
  buildClarificationTrace,
  buildClarifiedPrompt,
} from "./clarificationPolicy.js";

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  return {
    subject: "external",
    taskType: "analyze",
    needsMemory: false,
    needsExternalKnowledge: true,
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
    richIntent: {
      userGoal: "test goal",
      primaryAction: "analyze",
      targets: [{ type: "external_entity", value: "NVDA" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        localWorkspace: false,
        externalWorld: true,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intentSteps: [
      {
        id: "step-1",
        type: "analyze",
        action: "analyze external/domain context",
        target: "NVDA",
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

describe("buildClarificationDecision", () => {
  it("does not ask for ordinary external analysis", () => {
    const decision = buildClarificationDecision({
      userPrompt: "分析一下 NVDA 的财报",
      querySubject: "external",
      candidateAgents: [],
      intent: intent(),
    });

    expect(decision.shouldAsk).toBe(false);
    expect(decision.questions).toHaveLength(0);
    expect(decision.state).toBe("ready");
    expect(decision.scope).toBe("none");
  });

  it("does not ask for low-risk analysis with low subject confidence", () => {
    const decision = buildClarificationDecision({
      userPrompt: "这个架构怎么看",
      querySubject: "mixed",
      candidateAgents: [],
      intent: intent({
        subject: "mixed",
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          subject: 0.4,
        },
      }),
    });

    expect(decision.shouldAsk).toBe(false);
  });

  it("asks when an execute request has ambiguous action", () => {
    const decision = buildClarificationDecision({
      userPrompt: "帮我处理一下这个文件",
      querySubject: "external",
      candidateAgents: [],
      intent: intent({
        taskType: "execute",
        needsTool: true,
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          action: 0.4,
        },
        richIntent: {
          ...intent().richIntent,
          primaryAction: "modify",
          targets: [],
          riskLevel: "high",
        },
      }),
    });

    expect(decision.shouldAsk).toBe(true);
    expect(decision.reasons).toContain("high_risk_action_ambiguous");
  });

  it("asks when schedule intent lacks concrete time", () => {
    const decision = buildClarificationDecision({
      userPrompt: "提醒我复盘投资组合",
      querySubject: "external",
      candidateAgents: [],
      intent: intent({
        taskType: "schedule",
        needsTool: true,
        needsScheduling: true,
        resolvedDateRange: null,
        timeWindowDays: null,
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          action: 0.6,
        },
        richIntent: {
          ...intent().richIntent,
          primaryAction: "schedule",
          targets: [{ type: "calendar", value: "portfolio review" }],
          riskLevel: "medium",
        },
      }),
    });

    expect(decision.shouldAsk).toBe(true);
    expect(decision.reasons).toContain("schedule_time_ambiguous");
    expect(decision.state).toBe("awaiting_user");
    expect(decision.scope).toBe("intent");
  });

  it("asks from a schedule step even when schedule is not the primary task type", () => {
    const decision = buildClarificationDecision({
      userPrompt: "分析 NVDA，然后提醒我复盘",
      querySubject: "external",
      candidateAgents: [],
      intent: intent({
        taskType: "analyze",
        needsScheduling: true,
        intentSteps: [
          {
            id: "step-1",
            type: "analyze",
            action: "analyze external/domain context",
            target: "NVDA",
            dependsOn: [],
            requiresConfirmation: false,
            riskLevel: "low",
          },
          {
            id: "step-2",
            type: "schedule",
            action: "schedule future follow-up",
            target: "reminder",
            dependsOn: ["step-1"],
            requiresConfirmation: true,
            riskLevel: "medium",
          },
        ],
      }),
    });

    expect(decision.shouldAsk).toBe(true);
    expect(decision.scope).toBe("step");
    expect(decision.reasons).toContain("schedule_step_missing_time");
    expect(decision.stepRequirements).toContainEqual({
      stepId: "step-2",
      stepType: "schedule",
      reason: "schedule_step_missing_time",
      blocking: true,
    });
  });

  it("asks when delegate has multiple plausible agents", () => {
    const decision = buildClarificationDecision({
      userPrompt: "帮我分析一下 NVDA",
      querySubject: "external",
      candidateAgents: ["investment-analysis", "generalist"],
      intent: intent({
        taskType: "delegate",
        candidateAgents: ["investment-analysis", "generalist"],
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          action: 0.6,
        },
        richIntent: {
          ...intent().richIntent,
          primaryAction: "delegate",
          targets: [],
          riskLevel: "medium",
        },
      }),
    });

    expect(decision.shouldAsk).toBe(true);
    expect(decision.reasons).toContain("delegate_agent_ambiguous");
  });

  it("asks when current-context reference has no recent history", () => {
    const decision = buildClarificationDecision({
      userPrompt: "继续这个",
      querySubject: "personal",
      candidateAgents: [],
      recentHistoryLength: 0,
      intent: intent({
        subject: "personal",
        referencesRecentHistory: true,
        semanticEvidence: {
          ...intent().semanticEvidence,
          memoryRecall: {
            present: true,
            target: "current_context_reference",
            reason: "",
            span: "这个",
          },
        },
        richIntent: {
          ...intent().richIntent,
          targets: [{ type: "current_context", value: "这个" }],
          contextDependency: {
            recentConversation: true,
            longTermMemory: false,
            localWorkspace: false,
            externalWorld: false,
          },
        },
      }),
    });

    expect(decision.shouldAsk).toBe(true);
    expect(decision.reasons).toContain("missing_recent_context");
  });

  it("asks when memory target is ambiguous and memory would be used", () => {
    const decision = buildClarificationDecision({
      userPrompt: "你觉得这个适合我吗",
      querySubject: "mixed",
      candidateAgents: [],
      intent: intent({
        subject: "mixed",
        needsMemory: true,
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          memoryTarget: 0.4,
        },
        semanticEvidence: {
          ...intent().semanticEvidence,
          personalContext: { present: true, reason: "", span: "适合我" },
        },
        intentSteps: [
          {
            id: "step-1",
            type: "recall",
            action: "retrieve relevant user context",
            target: "user_context",
            dependsOn: [],
            requiresConfirmation: false,
            riskLevel: "low",
          },
          {
            id: "step-2",
            type: "analyze",
            action: "analyze external/domain context",
            target: "framework",
            dependsOn: ["step-1"],
            requiresConfirmation: false,
            riskLevel: "low",
          },
        ],
        richIntent: {
          ...intent().richIntent,
          contextDependency: {
            recentConversation: true,
            longTermMemory: true,
            localWorkspace: false,
            externalWorld: true,
          },
        },
      }),
    });

    expect(decision.shouldAsk).toBe(true);
    expect(decision.reasons).toContain("memory_target_ambiguous");
    expect(decision.stepRequirements).toContainEqual({
      stepId: "step-1",
      stepType: "recall",
      reason: "recall_step_memory_target_ambiguous",
      blocking: true,
    });
  });

  it("does not ask for external past events", () => {
    const decision = buildClarificationDecision({
      userPrompt: "上次苹果发布会发布了什么",
      querySubject: "external",
      candidateAgents: [],
      intent: intent({
        taskType: "analyze",
        semanticEvidence: {
          ...intent().semanticEvidence,
          memoryRecall: {
            present: true,
            target: "external_past_event",
            reason: "",
            span: "上次苹果发布会",
          },
        },
      }),
    });

    expect(decision.shouldAsk).toBe(false);
  });
});

describe("applyClarificationChannelState", () => {
  it("marks blocking clarification as blocked when no interactive channel is available", () => {
    const decision = buildClarificationDecision({
      userPrompt: "提醒我复盘投资组合",
      querySubject: "external",
      candidateAgents: [],
      intent: intent({
        taskType: "schedule",
        needsScheduling: true,
        needsTool: true,
        richIntent: {
          ...intent().richIntent,
          primaryAction: "schedule",
          targets: [{ type: "calendar", value: "portfolio review" }],
          riskLevel: "medium",
        },
      }),
    });

    const withoutChannel = applyClarificationChannelState(decision, false);
    const withChannel = applyClarificationChannelState(decision, true);

    expect(withoutChannel.state).toBe("blocked_without_channel");
    expect(withoutChannel.blocking).toBe(true);
    expect(withChannel.state).toBe("awaiting_user");
  });
});

describe("buildClarifiedPrompt", () => {
  it("appends answered clarifications to the original prompt", () => {
    const decision = buildClarificationDecision({
      userPrompt: "帮我处理一下这个文件",
      querySubject: "external",
      candidateAgents: [],
      intent: intent({
        taskType: "execute",
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          action: 0.4,
        },
        richIntent: {
          ...intent().richIntent,
          targets: [],
          riskLevel: "high",
        },
      }),
    });

    const prompt = buildClarifiedPrompt("帮我处理一下这个文件", decision, {
      "0_Clarify action": "格式化并运行测试",
    });

    expect(prompt).toContain("帮我处理一下这个文件");
    expect(prompt).toContain("Clarify action: 格式化并运行测试");
  });
});

describe("buildClarificationTrace", () => {
  it("returns a compact structured trace for enabled observability", () => {
    const input = {
      userPrompt: "帮我处理一下这个文件",
      querySubject: "external" as const,
      candidateAgents: [],
      intent: intent({
        taskType: "execute",
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          action: 0.4,
        },
        richIntent: {
          ...intent().richIntent,
          targets: [],
          riskLevel: "high",
          ambiguity: [
            {
              field: "action",
              reason: "operation is not specified",
              severity: "high",
            },
          ],
        },
      }),
      recentHistoryLength: 2,
    };
    const decision = buildClarificationDecision(input);

    const trace = buildClarificationTrace(input, decision);

    expect(trace.enabled).toBe(true);
    expect(trace.state).toBe("awaiting_user");
    expect(trace.scope).toBe("intent");
    expect(trace.shouldAsk).toBe(true);
    expect(trace.questionHeaders).toEqual(["Clarify action"]);
    expect(trace.intent?.taskType).toBe("execute");
    expect(trace.intent?.confidenceByDimension.action).toBe(0.4);
    expect(trace.input.recentHistoryLength).toBe(2);
  });
});
