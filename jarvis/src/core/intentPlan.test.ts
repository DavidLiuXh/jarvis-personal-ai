/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame } from "./intentResolver.js";
import { buildIntentPlanSection } from "./intentPlan.js";

function intent(steps: IntentFrame["intentSteps"]): IntentFrame {
  return {
    subject: "mixed",
    taskType: "schedule",
    needsMemory: true,
    needsExternalKnowledge: true,
    needsTool: true,
    needsScheduling: true,
    candidateAgents: ["investment-analysis"],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 60,
    knowledgeScore: 60,
    operationScore: 60,
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
      personalContext: { present: true, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: { present: true, action: "schedule", object: "" },
      entityHints: {
        tickers: ["NVDA"],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: "analyze NVDA and schedule review",
      primaryAction: "schedule",
      targets: [{ type: "external_entity", value: "NVDA" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: true,
        localWorkspace: false,
        externalWorld: true,
      },
      ambiguity: [],
      riskLevel: "medium",
    },
    intentSteps: steps,
    topicAnalysis: {
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0.8 },
      current: {
        label: "test",
        evidence: ["test"],
        sourceTurns: [0],
        confidence: 0.8,
      },
      relation: "unknown",
      relationReason: "",
      confidence: 0.8,
      lowGrounding: false,
    },
    source: "local-intent/ollama",
  };
}

describe("buildIntentPlanSection", () => {
  it("does not inject an intent plan for single-step requests", () => {
    const section = buildIntentPlanSection(
      intent([
        {
          id: "step-1",
          type: "analyze",
          action: "analyze external/domain context",
          target: "NVDA",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
      ]),
    );

    expect(section).toBe("");
  });

  it("formats multi-intent steps for the system prompt", () => {
    const section = buildIntentPlanSection(
      intent([
        {
          id: "step-1",
          type: "recall",
          action: "retrieve relevant user context",
          target: "risk preference",
          dependsOn: [],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-2",
          type: "analyze",
          action: "analyze external/domain context",
          target: "NVDA",
          dependsOn: ["step-1"],
          requiresConfirmation: false,
          riskLevel: "low",
        },
        {
          id: "step-3",
          type: "schedule",
          action: "schedule future follow-up",
          target: "reminder",
          dependsOn: ["step-2"],
          requiresConfirmation: true,
          riskLevel: "medium",
        },
      ]),
    );

    expect(section).toContain("<intent_plan>");
    expect(section).toContain("[step-1] recall");
    expect(section).toContain("[step-2] analyze");
    expect(section).toContain("depends_on=step-1");
    expect(section).toContain("requires_confirmation=true");
  });
});
