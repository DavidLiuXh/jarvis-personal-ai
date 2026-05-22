/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import {
  createIntentPolicyRegistry,
  listIntentPolicyRules,
  normalizeIntentPolicyReason,
  runIntentPolicyRules,
  validateIntentPolicyRegistry,
  type AgentPolicyState,
  type IntentCueState,
  type IntentPolicyDeps,
  type IntentPolicyRule,
  type IntentPolicyTraceEntry,
  type SemanticPolicyState,
  type SubjectPolicyState,
  type TaskPolicyState,
} from "./intentPolicy.js";
import type {
  ActionRequestType,
  IntentEvidence,
  IntentTaskType,
  QuerySubject,
} from "./intentResolver.js";

const baseEvidence = (): IntentEvidence => ({
  personalContext: { present: false, reason: "", span: "" },
  memoryRecall: { present: false, target: "none", reason: "", span: "" },
  actionRequest: { present: false, action: "none", object: "" },
  entityHints: {
    tickers: [],
    technicalTerms: [],
    peopleOrCompanies: [],
  },
});

const baseCues = (): IntentCueState => ({
  semanticRecallCue: false,
  externalPastEventCue: false,
  currentContextReferenceCue: false,
  personalFactAssertionCue: false,
  personalCue: false,
  recallCue: false,
  scheduleCue: false,
  actionCue: false,
  explicitDelegateCue: false,
  investmentAnalysisCue: false,
  recallWithExternalWork: false,
});

const deps: IntentPolicyDeps = {
  lowConfidenceThreshold: 0.55,
  hasRememberToActionCue: (prompt) => prompt.includes("remember-action"),
  hasPersonalFactAssertionCue: (prompt) => prompt.includes("personal-fact"),
  hasAnaphoricReference: (prompt, history) =>
    prompt.includes("anaphora") && history.length > 0,
  hasMemoryRecallCue: (prompt) => prompt.includes("memory-recall"),
  hasConversationHistoryRecallCue: (prompt) =>
    prompt.includes("conversation-history"),
  hasCurrentContextReferenceCue: (prompt) => prompt.includes("current-context"),
  inferActionRequestFromCue: (prompt): ActionRequestType | null => {
    if (prompt.includes("schedule-action")) return "schedule";
    if (prompt.includes("delegate-action")) return "delegate";
    if (prompt.includes("write-action")) return "write";
    return null;
  },
  normalizeInvestmentEntityHints: (prompt, semanticEvidence) => {
    if (!prompt.includes("normalize-investment")) return semanticEvidence;
    return {
      ...semanticEvidence,
      entityHints: {
        ...semanticEvidence.entityHints,
        tickers: ["NVDA"],
      },
    };
  },
  normalizeTechnicalEntityHints: (prompt, semanticEvidence) => {
    if (!prompt.includes("normalize-technical")) return semanticEvidence;
    return {
      ...semanticEvidence,
      entityHints: {
        ...semanticEvidence.entityHints,
        technicalTerms: ["React"],
      },
    };
  },
};

const registry = createIntentPolicyRegistry(deps);

function traceReasonCodes(trace: IntentPolicyTraceEntry[]) {
  return trace.map((entry) => entry.reasonCode);
}

function runSemantic(state: Partial<SemanticPolicyState>) {
  const trace: IntentPolicyTraceEntry[] = [];
  runIntentPolicyRules(
    {
      prompt: "",
      recentTurns: [],
      semanticEvidence: baseEvidence(),
      ...state,
    },
    registry.semantic,
    trace,
  );
  return trace;
}

function runSubject(state: Partial<SubjectPolicyState>) {
  const trace: IntentPolicyTraceEntry[] = [];
  runIntentPolicyRules(
    {
      subject: "external" as QuerySubject,
      confidence: 0.9,
      cues: baseCues(),
      semanticEvidence: baseEvidence(),
      hasModelExternalKnowledge: false,
      evidence: [],
      ...state,
    },
    registry.subject,
    trace,
  );
  return trace;
}

function runTask(state: Partial<TaskPolicyState>) {
  const trace: IntentPolicyTraceEntry[] = [];
  runIntentPolicyRules(
    {
      taskType: "chat" as IntentTaskType,
      cues: baseCues(),
      prompt: "",
      evidence: [],
      ...state,
    },
    registry.task,
    trace,
  );
  return trace;
}

function runAgent(state: Partial<AgentPolicyState>) {
  const trace: IntentPolicyTraceEntry[] = [];
  runIntentPolicyRules(
    {
      taskType: "analyze" as IntentTaskType,
      candidateAgents: [],
      cues: baseCues(),
      evidence: [],
      delegateDowngraded: false,
      ...state,
    },
    registry.agent,
    trace,
  );
  return trace;
}

describe("intent policy registry", () => {
  it("has stable, unique rule ids and reason codes", () => {
    const rules = listIntentPolicyRules(registry);
    expect(rules.length).toBeGreaterThan(0);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    expect(new Set(rules.map((rule) => rule.reasonCode)).size).toBe(
      rules.length,
    );
  });

  it("passes registry validation", () => {
    expect(validateIntentPolicyRegistry(registry)).toEqual([]);
  });

  it("attaches standardized reason metadata to every policy manifest", () => {
    const rules = listIntentPolicyRules(registry);

    for (const rule of rules) {
      expect(rule.reason).toEqual(
        expect.objectContaining({
          code: rule.reasonCode,
          category: expect.any(String),
          severity: expect.any(String),
        }),
      );
    }
  });

  it("normalizes policy reason code metadata", () => {
    expect(
      normalizeIntentPolicyReason("EXTERNAL_PAST_EVENT_NOT_RECALL"),
    ).toEqual({
      code: "EXTERNAL_PAST_EVENT_NOT_RECALL",
      category: "task_boundary",
      severity: "critical",
    });
  });

  it("reports registry contract violations", () => {
    const duplicateRule: IntentPolicyRule<SemanticPolicyState> = {
      ...registry.semantic[0],
      priority: registry.semantic[1].priority,
      reasonCode: registry.semantic[1].reasonCode,
    };
    const invalidRegistry = {
      ...registry,
      semantic: [registry.semantic[0], registry.semantic[1], duplicateRule],
    };

    expect(validateIntentPolicyRegistry(invalidRegistry)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duplicate reason code"),
        expect.stringContaining("duplicate priority"),
      ]),
    );
  });

  it("can record skipped decisions for policy debugging", () => {
    const trace: IntentPolicyTraceEntry[] = [];
    runIntentPolicyRules(
      { prompt: "", recentTurns: [], semanticEvidence: baseEvidence() },
      registry.semantic.slice(0, 1),
      trace,
      { recordSkipped: true },
    );

    expect(trace).toEqual([
      expect.objectContaining({
        ruleId: "semantic.remember_to_action_not_recall",
        applied: false,
        reason: {
          code: "REMEMBER_TO_ACTION_NOT_MEMORY_RECALL",
          category: "semantic_evidence",
          severity: "warning",
        },
        skippedReason: "applies_false",
      }),
    ]);
  });

  it.each([
    [
      "REMEMBER_TO_ACTION_NOT_MEMORY_RECALL",
      () => runSemantic({ prompt: "remember-action" }),
    ],
    [
      "ANAPHORA_CURRENT_CONTEXT_REFERENCE",
      () =>
        runSemantic({
          prompt: "anaphora",
          recentTurns: [{ role: "user", content: "prior" }],
        }),
    ],
    [
      "CONVERSATION_HISTORY_CUE_FROM_NONE",
      () => runSemantic({ prompt: "conversation-history" }),
    ],
    [
      "CONVERSATION_HISTORY_CUE_TARGET_CORRECTION",
      () =>
        runSemantic({
          prompt: "conversation-history",
          semanticEvidence: {
            ...baseEvidence(),
            memoryRecall: {
              present: true,
              target: "user_memory",
              reason: "",
            },
          },
        }),
    ],
    ["ACTION_CUE_FROM_NONE", () => runSemantic({ prompt: "write-action" })],
    [
      "INVESTMENT_TICKER_NORMALIZATION",
      () => runSemantic({ prompt: "normalize-investment" }),
    ],
    [
      "TECHNICAL_TERM_NORMALIZATION",
      () => runSemantic({ prompt: "normalize-technical" }),
    ],
    [
      "RECALL_CUE_SUBJECT_OVERRIDE",
      () =>
        runSubject({
          cues: { ...baseCues(), recallCue: true },
        }),
    ],
    [
      "RECALL_CUE_KEEP_MIXED_FOR_EXTERNAL_WORK",
      () =>
        runSubject({
          subject: "mixed",
          cues: {
            ...baseCues(),
            recallCue: true,
            recallWithExternalWork: true,
          },
        }),
    ],
    [
      "PERSONAL_CONTEXT_WITH_EXTERNAL_ENTITY",
      () =>
        runSubject({
          subject: "personal",
          cues: { ...baseCues(), personalCue: true },
          semanticEvidence: {
            ...baseEvidence(),
            entityHints: {
              tickers: ["NVDA"],
              technicalTerms: [],
              peopleOrCompanies: [],
            },
          },
        }),
    ],
    [
      "EXTERNAL_WITH_PERSONAL_CONTEXT_CUE",
      () =>
        runSubject({
          cues: { ...baseCues(), personalCue: true },
        }),
    ],
    [
      "LOW_CONFIDENCE_EXTERNAL_TO_MIXED",
      () =>
        runSubject({
          confidence: 0.4,
        }),
    ],
    [
      "REMEMBER_TO_ACTION_TASK_NOT_RECALL",
      () =>
        runTask({
          prompt: "remember-action",
          taskType: "recall",
        }),
    ],
    [
      "SCHEDULE_CUE_TASK_OVERRIDE",
      () =>
        runTask({
          cues: { ...baseCues(), scheduleCue: true },
        }),
    ],
    [
      "EXTERNAL_PAST_EVENT_NOT_RECALL",
      () =>
        runTask({
          taskType: "recall",
          cues: { ...baseCues(), externalPastEventCue: true },
        }),
    ],
    [
      "RECALL_CUE_TASK_OVERRIDE",
      () =>
        runTask({
          cues: { ...baseCues(), recallCue: true },
        }),
    ],
    [
      "DELEGATE_CUE_TASK_OVERRIDE",
      () =>
        runTask({
          cues: { ...baseCues(), explicitDelegateCue: true },
        }),
    ],
    [
      "ACTION_CUE_EXECUTE",
      () =>
        runTask({
          taskType: "analyze",
          cues: { ...baseCues(), actionCue: true },
        }),
    ],
    [
      "INVESTMENT_ANALYSIS_CANDIDATE",
      () =>
        runAgent({
          cues: { ...baseCues(), investmentAnalysisCue: true },
        }),
    ],
    [
      "IMPLICIT_DELEGATE_DOWNGRADE",
      () =>
        runAgent({
          taskType: "delegate",
          cues: { ...baseCues(), investmentAnalysisCue: true },
        }),
    ],
  ])("has a deterministic case for %s", (reasonCode, run) => {
    expect(traceReasonCodes(run())).toContain(reasonCode);
  });
});
