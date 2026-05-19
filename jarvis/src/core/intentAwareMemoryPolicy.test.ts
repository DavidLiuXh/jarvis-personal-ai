/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame } from "./intentResolver.js";
import { buildIntentAwareMemoryPolicy } from "./intentAwareMemoryPolicy.js";

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
});
