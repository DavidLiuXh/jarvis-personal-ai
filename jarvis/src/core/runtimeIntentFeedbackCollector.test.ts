/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClarificationDecision } from "./clarificationPolicy.js";
import type { IntentFrame } from "./intentResolver.js";
import {
  collectSignals,
  RuntimeIntentFeedbackCollector,
} from "./runtimeIntentFeedbackCollector.js";

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
    intentSteps: [],
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
    policyTrace: [],
    source: "local-intent/ollama",
    ...overrides,
  };
}

function clarification(
  overrides: Partial<ClarificationDecision> = {},
): ClarificationDecision {
  return {
    state: "ready",
    scope: "none",
    shouldAsk: false,
    blocking: false,
    questions: [],
    reasons: [],
    stepRequirements: [],
    ...overrides,
  };
}

function baseInput() {
  return {
    sessionId: "test-session",
    userPrompt: "Analyze NVDA",
    history: [],
    intent: intent(),
    clarification: clarification(),
    routing: {
      source: "local-router/ollama" as const,
      model: "gemini-2.5-flash",
      score: 40,
      decision: "test",
      classifierReason: "test",
    },
    executionContext: "interactive" as const,
  };
}

describe("RuntimeIntentFeedbackCollector", () => {
  it("does not write when disabled", () => {
    const outputPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "intent-feedback-")),
      "candidates.jsonl",
    );
    const collector = new RuntimeIntentFeedbackCollector({
      enabled: false,
      outputPath,
    });

    expect(collector.record(baseInput())).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("collects high-signal clarification cases and redacts sensitive text", () => {
    const outputPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "intent-feedback-")),
      "candidates.jsonl",
    );
    const collector = new RuntimeIntentFeedbackCollector({
      enabled: true,
      outputPath,
      maxPromptChars: 120,
      maxHistoryChars: 80,
    });

    const wrote = collector.record({
      ...baseInput(),
      userPrompt:
        "提醒我复盘投资组合，email me@example.com token=secret-token-value",
      history: [
        {
          role: "user",
          content: "previous phone +86 138 0013 8000 and password=abc123",
        },
      ],
      clarification: clarification({
        state: "awaiting_user",
        scope: "step",
        shouldAsk: true,
        blocking: true,
        reasons: ["schedule_step_missing_time"],
      }),
    });

    expect(wrote).toBe(true);
    const [line] = fs.readFileSync(outputPath, "utf8").trim().split("\n");
    const candidate = JSON.parse(line);
    expect(candidate.signals).toEqual(
      expect.arrayContaining([
        "clarification_requested",
        "clarification_blocking",
      ]),
    );
    expect(candidate.prompt).toContain("[redacted_email]");
    expect(candidate.prompt).toContain("[redacted_secret]");
    expect(candidate.history[0].content).toContain("[redacted_phone]");
    expect(candidate.history[0].content).toContain("[redacted_secret]");
    expect(candidate.candidateCase.expect).toEqual({});
  });

  it("detects fallback, low confidence, and warning policy signals", () => {
    const signals = collectSignals({
      ...baseInput(),
      routing: {
        ...baseInput().routing,
        source: "local-router/fallback",
      },
      intent: intent({
        confidenceByDimension: {
          ...intent().confidenceByDimension,
          memoryTarget: 0.2,
        },
        policyTrace: [
          {
            ruleId: "subject.low_confidence_external",
            stage: "guardrail",
            priority: 100,
            reasonCode: "LOW_CONFIDENCE_EXTERNAL_TO_MIXED",
            reason: {
              code: "LOW_CONFIDENCE_EXTERNAL_TO_MIXED",
              category: "subject_boundary",
              severity: "warning",
            },
            applied: true,
          },
        ],
      }),
    });

    expect(signals).toEqual(
      expect.arrayContaining([
        "router_fallback",
        "low_confidence_dimension",
        "warning_policy_correction",
      ]),
    );
  });
});
