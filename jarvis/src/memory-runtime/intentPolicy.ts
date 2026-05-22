/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ActionRequestType,
  ConversationTurn,
  IntentEvidence,
  IntentTaskType,
  QuerySubject,
} from "../core/intentResolver.js";

export type IntentPolicyStage =
  | "normalize"
  | "guardrail"
  | "override"
  | "finalize";

export type IntentPolicyReasonCategory =
  | "semantic_evidence"
  | "subject_boundary"
  | "task_boundary"
  | "topic_boundary"
  | "agent_routing";

export type IntentPolicyReasonSeverity = "info" | "warning" | "critical";

export type IntentPolicyReason = {
  code: string;
  category: IntentPolicyReasonCategory;
  severity: IntentPolicyReasonSeverity;
};

export type IntentPolicyTraceEntry = {
  ruleId: string;
  stage: IntentPolicyStage;
  priority: number;
  reasonCode: string;
  reason: IntentPolicyReason;
  applied: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  skippedReason?: string;
};

export type IntentPolicyRunOptions = {
  recordSkipped?: boolean;
};

export type IntentPolicyRule<TState> = {
  id: string;
  stage: IntentPolicyStage;
  priority: number;
  reasonCode: string;
  applies(state: TState): boolean;
  apply(state: TState): TState;
  snapshot(state: TState): Record<string, unknown>;
};

export type IntentPolicyRuleManifest = {
  id: string;
  stage: IntentPolicyStage;
  priority: number;
  reasonCode: string;
  group: "semantic" | "subject" | "task" | "agent";
  reason: IntentPolicyReason;
};

export type IntentCueState = {
  semanticRecallCue: boolean;
  externalPastEventCue: boolean;
  currentContextReferenceCue: boolean;
  personalFactAssertionCue: boolean;
  personalCue: boolean;
  recallCue: boolean;
  scheduleCue: boolean;
  actionCue: boolean;
  explicitDelegateCue: boolean;
  investmentAnalysisCue: boolean;
  recallWithExternalWork: boolean;
};

export type SemanticPolicyState = {
  prompt: string;
  recentTurns: ConversationTurn[];
  semanticEvidence: IntentEvidence;
};

export type SubjectPolicyState = {
  subject: QuerySubject;
  confidence: number;
  cues: IntentCueState;
  semanticEvidence: IntentEvidence;
  hasModelExternalKnowledge: boolean;
  evidence: string[];
};

export type TaskPolicyState = {
  taskType: IntentTaskType;
  cues: IntentCueState;
  prompt: string;
  evidence: string[];
};

export type AgentPolicyState = {
  taskType: IntentTaskType;
  candidateAgents: string[];
  cues: IntentCueState;
  evidence: string[];
  delegateDowngraded: boolean;
};

export type IntentPolicyRegistry = {
  semantic: IntentPolicyRule<SemanticPolicyState>[];
  subject: IntentPolicyRule<SubjectPolicyState>[];
  task: IntentPolicyRule<TaskPolicyState>[];
  agent: IntentPolicyRule<AgentPolicyState>[];
};

export type IntentPolicyDeps = {
  lowConfidenceThreshold: number;
  hasRememberToActionCue(prompt: string): boolean;
  hasPersonalFactAssertionCue(prompt: string): boolean;
  hasAnaphoricReference(prompt: string, history: ConversationTurn[]): boolean;
  hasMemoryRecallCue(prompt: string): boolean;
  hasConversationHistoryRecallCue(prompt: string): boolean;
  hasCurrentContextReferenceCue(prompt: string): boolean;
  inferActionRequestFromCue(prompt: string): ActionRequestType | null;
  normalizeInvestmentEntityHints(
    prompt: string,
    semanticEvidence: IntentEvidence,
    emitLog?: boolean,
  ): IntentEvidence;
  normalizeTechnicalEntityHints(
    prompt: string,
    semanticEvidence: IntentEvidence,
    emitLog?: boolean,
  ): IntentEvidence;
};

const POLICY_REASON_METADATA: Record<
  string,
  Pick<IntentPolicyReason, "category" | "severity">
> = {
  REMEMBER_TO_ACTION_NOT_MEMORY_RECALL: {
    category: "semantic_evidence",
    severity: "warning",
  },
  ANAPHORA_CURRENT_CONTEXT_REFERENCE: {
    category: "semantic_evidence",
    severity: "info",
  },
  CONVERSATION_HISTORY_CUE_FROM_NONE: {
    category: "semantic_evidence",
    severity: "info",
  },
  CONVERSATION_HISTORY_CUE_TARGET_CORRECTION: {
    category: "semantic_evidence",
    severity: "warning",
  },
  ACTION_CUE_FROM_NONE: {
    category: "semantic_evidence",
    severity: "info",
  },
  INVESTMENT_TICKER_NORMALIZATION: {
    category: "semantic_evidence",
    severity: "info",
  },
  TECHNICAL_TERM_NORMALIZATION: {
    category: "semantic_evidence",
    severity: "info",
  },
  PERSONAL_FACT_ASSERTION_NOT_RECALL: {
    category: "semantic_evidence",
    severity: "warning",
  },
  PERSONAL_FACT_ASSERTION_SUBJECT: {
    category: "subject_boundary",
    severity: "warning",
  },
  RECALL_CUE_SUBJECT_OVERRIDE: {
    category: "subject_boundary",
    severity: "warning",
  },
  RECALL_CUE_KEEP_MIXED_FOR_EXTERNAL_WORK: {
    category: "subject_boundary",
    severity: "info",
  },
  PERSONAL_CONTEXT_WITH_EXTERNAL_ENTITY: {
    category: "subject_boundary",
    severity: "warning",
  },
  EXTERNAL_WITH_PERSONAL_CONTEXT_CUE: {
    category: "subject_boundary",
    severity: "warning",
  },
  LOW_CONFIDENCE_EXTERNAL_TO_MIXED: {
    category: "subject_boundary",
    severity: "warning",
  },
  REMEMBER_TO_ACTION_TASK_NOT_RECALL: {
    category: "task_boundary",
    severity: "warning",
  },
  PERSONAL_FACT_ASSERTION_TASK_NOT_RECALL: {
    category: "task_boundary",
    severity: "warning",
  },
  SCHEDULE_CUE_TASK_OVERRIDE: {
    category: "task_boundary",
    severity: "info",
  },
  EXTERNAL_PAST_EVENT_NOT_RECALL: {
    category: "task_boundary",
    severity: "critical",
  },
  RECALL_CUE_TASK_OVERRIDE: {
    category: "task_boundary",
    severity: "warning",
  },
  DELEGATE_CUE_TASK_OVERRIDE: {
    category: "task_boundary",
    severity: "info",
  },
  ACTION_CUE_EXECUTE: {
    category: "task_boundary",
    severity: "info",
  },
  INVESTMENT_ANALYSIS_CANDIDATE: {
    category: "agent_routing",
    severity: "info",
  },
  IMPLICIT_DELEGATE_DOWNGRADE: {
    category: "agent_routing",
    severity: "warning",
  },
};

export function normalizeIntentPolicyReason(
  reasonCode: string,
): IntentPolicyReason {
  const metadata = POLICY_REASON_METADATA[reasonCode];
  if (!metadata) {
    return {
      code: reasonCode,
      category: "semantic_evidence",
      severity: "warning",
    };
  }
  return {
    code: reasonCode,
    ...metadata,
  };
}

export function runIntentPolicyRules<TState>(
  state: TState,
  rules: IntentPolicyRule<TState>[],
  trace: IntentPolicyTraceEntry[],
  options: IntentPolicyRunOptions = {},
): TState {
  let nextState = state;
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
    const before = rule.snapshot(nextState);
    if (!rule.applies(nextState)) {
      if (options.recordSkipped === true) {
        trace.push({
          ruleId: rule.id,
          stage: rule.stage,
          priority: rule.priority,
          reasonCode: rule.reasonCode,
          reason: normalizeIntentPolicyReason(rule.reasonCode),
          applied: false,
          before,
          skippedReason: "applies_false",
        });
      }
      continue;
    }
    nextState = rule.apply(nextState);
    const after = rule.snapshot(nextState);
    trace.push({
      ruleId: rule.id,
      stage: rule.stage,
      priority: rule.priority,
      reasonCode: rule.reasonCode,
      reason: normalizeIntentPolicyReason(rule.reasonCode),
      applied: true,
      before,
      after,
    });
  }
  return nextState;
}

export function appendPolicyEvidence(
  evidence: string[],
  item: string,
): string[] {
  return evidence.includes(item) ? [...evidence] : [...evidence, item];
}

export function logAppliedPolicyTrace(trace: IntentPolicyTraceEntry[]): void {
  if (trace.length === 0) return;
  const compact = trace.map((entry) => ({
    ruleId: entry.ruleId,
    reasonCode: entry.reasonCode,
    reason: entry.reason,
    stage: entry.stage,
    priority: entry.priority,
    before: entry.before,
    after: entry.after,
  }));
  console.error(`[IntentPolicy] trace ${JSON.stringify(compact)}`);
}

const semanticEvidenceSnapshot = (state: SemanticPolicyState) => ({
  memoryTarget: state.semanticEvidence.memoryRecall.target,
  memoryPresent: state.semanticEvidence.memoryRecall.present,
  action: state.semanticEvidence.actionRequest.action,
  actionPresent: state.semanticEvidence.actionRequest.present,
  tickers: [...state.semanticEvidence.entityHints.tickers],
  technicalTerms: [...state.semanticEvidence.entityHints.technicalTerms],
  peopleOrCompanies: [...state.semanticEvidence.entityHints.peopleOrCompanies],
});

const subjectPolicySnapshot = (state: SubjectPolicyState) => ({
  subject: state.subject,
  evidence: [...state.evidence],
});

const taskPolicySnapshot = (state: TaskPolicyState) => ({
  taskType: state.taskType,
  evidence: [...state.evidence],
});

const agentPolicySnapshot = (state: AgentPolicyState) => ({
  taskType: state.taskType,
  candidateAgents: [...state.candidateAgents],
  delegateDowngraded: state.delegateDowngraded,
  evidence: [...state.evidence],
});

function semanticEvidencePolicyRules(
  deps: IntentPolicyDeps,
): IntentPolicyRule<SemanticPolicyState>[] {
  return [
    {
      id: "semantic.remember_to_action_not_recall",
      stage: "guardrail",
      priority: 500,
      reasonCode: "REMEMBER_TO_ACTION_NOT_MEMORY_RECALL",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) => deps.hasRememberToActionCue(state.prompt),
      apply: (state) => ({
        ...state,
        semanticEvidence: {
          ...state.semanticEvidence,
          memoryRecall: {
            present: false,
            target: "none",
            reason: "remember-to-action phrasing is not memory recall",
            span: state.semanticEvidence.memoryRecall.span,
          },
          actionRequest: {
            present: false,
            action: "none",
            object: state.semanticEvidence.actionRequest.object,
          },
        },
      }),
    },
    {
      id: "semantic.personal_fact_assertion_not_recall",
      stage: "guardrail",
      priority: 480,
      reasonCode: "PERSONAL_FACT_ASSERTION_NOT_RECALL",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) =>
        deps.hasPersonalFactAssertionCue(state.prompt) &&
        state.semanticEvidence.memoryRecall.target !== "external_past_event",
      apply: (state) => ({
        ...state,
        semanticEvidence: {
          ...state.semanticEvidence,
          personalContext: {
            present: true,
            reason: "short personal fact assertion in current request",
            span: state.prompt,
          },
          memoryRecall: {
            present: false,
            target: "none",
            reason:
              "current personal fact assertion is not a memory recall request",
            span: state.prompt,
          },
        },
      }),
    },
    {
      id: "semantic.anaphora_current_context",
      stage: "normalize",
      priority: 420,
      reasonCode: "ANAPHORA_CURRENT_CONTEXT_REFERENCE",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) =>
        deps.hasAnaphoricReference(state.prompt, state.recentTurns) &&
        state.semanticEvidence.memoryRecall.target !== "external_past_event" &&
        !deps.hasMemoryRecallCue(state.prompt),
      apply: (state) => ({
        ...state,
        semanticEvidence: {
          ...state.semanticEvidence,
          memoryRecall: {
            ...state.semanticEvidence.memoryRecall,
            present: true,
            target: "current_context_reference",
            reason:
              state.semanticEvidence.memoryRecall.reason ||
              "anaphoric reference to recent conversation",
          },
        },
      }),
    },
    {
      id: "semantic.conversation_history_from_none",
      stage: "normalize",
      priority: 410,
      reasonCode: "CONVERSATION_HISTORY_CUE_FROM_NONE",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) =>
        state.semanticEvidence.memoryRecall.target === "none" &&
        deps.hasConversationHistoryRecallCue(state.prompt),
      apply: (state) => ({
        ...state,
        semanticEvidence: {
          ...state.semanticEvidence,
          memoryRecall: {
            ...state.semanticEvidence.memoryRecall,
            present: true,
            target: "conversation_history",
            reason:
              state.semanticEvidence.memoryRecall.reason ||
              "explicit prior conversation cue",
            span: state.semanticEvidence.memoryRecall.span || state.prompt,
          },
        },
      }),
    },
    {
      id: "semantic.conversation_history_from_memory_or_stale_context",
      stage: "guardrail",
      priority: 400,
      reasonCode: "CONVERSATION_HISTORY_CUE_TARGET_CORRECTION",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) =>
        (state.semanticEvidence.memoryRecall.target === "user_memory" ||
          (state.semanticEvidence.memoryRecall.target ===
            "current_context_reference" &&
            !deps.hasCurrentContextReferenceCue(state.prompt))) &&
        deps.hasConversationHistoryRecallCue(state.prompt),
      apply: (state) => ({
        ...state,
        semanticEvidence: {
          ...state.semanticEvidence,
          memoryRecall: {
            ...state.semanticEvidence.memoryRecall,
            target: "conversation_history",
            reason:
              state.semanticEvidence.memoryRecall.reason ||
              "explicit prior conversation cue",
          },
        },
      }),
    },
    {
      id: "semantic.action_cue_from_none",
      stage: "normalize",
      priority: 300,
      reasonCode: "ACTION_CUE_FROM_NONE",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) => {
        const deterministicAction = deps.inferActionRequestFromCue(
          state.prompt,
        );
        return (
          deterministicAction !== null &&
          state.semanticEvidence.actionRequest.action === "none" &&
          ((state.semanticEvidence.memoryRecall.target === "none" &&
            !deps.hasMemoryRecallCue(state.prompt)) ||
            deterministicAction === "schedule" ||
            deterministicAction === "delegate")
        );
      },
      apply: (state) => ({
        ...state,
        semanticEvidence: {
          ...state.semanticEvidence,
          actionRequest: {
            ...state.semanticEvidence.actionRequest,
            present: true,
            action: deps.inferActionRequestFromCue(state.prompt) ?? "none",
          },
        },
      }),
    },
    {
      id: "semantic.investment_entity_normalization",
      stage: "normalize",
      priority: 200,
      reasonCode: "INVESTMENT_TICKER_NORMALIZATION",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) =>
        deps.normalizeInvestmentEntityHints(
          state.prompt,
          state.semanticEvidence,
          false,
        ) !== state.semanticEvidence,
      apply: (state) => ({
        ...state,
        semanticEvidence: deps.normalizeInvestmentEntityHints(
          state.prompt,
          state.semanticEvidence,
        ),
      }),
    },
    {
      id: "semantic.technical_entity_normalization",
      stage: "normalize",
      priority: 190,
      reasonCode: "TECHNICAL_TERM_NORMALIZATION",
      snapshot: semanticEvidenceSnapshot,
      applies: (state) =>
        deps.normalizeTechnicalEntityHints(
          state.prompt,
          state.semanticEvidence,
          false,
        ) !== state.semanticEvidence,
      apply: (state) => ({
        ...state,
        semanticEvidence: deps.normalizeTechnicalEntityHints(
          state.prompt,
          state.semanticEvidence,
        ),
      }),
    },
  ];
}

function subjectPolicyRules(
  deps: IntentPolicyDeps,
): IntentPolicyRule<SubjectPolicyState>[] {
  return [
    {
      id: "subject.personal_fact_assertion",
      stage: "guardrail",
      priority: 520,
      reasonCode: "PERSONAL_FACT_ASSERTION_SUBJECT",
      snapshot: subjectPolicySnapshot,
      applies: (state) =>
        state.cues.personalFactAssertionCue && state.subject !== "personal",
      apply: (state) => ({
        ...state,
        subject: "personal",
        evidence: appendPolicyEvidence(
          state.evidence,
          "personal_fact_assertion",
        ),
      }),
    },
    {
      id: "subject.recall_cue_override",
      stage: "override",
      priority: 500,
      reasonCode: "RECALL_CUE_SUBJECT_OVERRIDE",
      snapshot: subjectPolicySnapshot,
      applies: (state) =>
        state.cues.recallCue &&
        state.subject !== "personal" &&
        !(state.subject === "mixed" && state.cues.recallWithExternalWork),
      apply: (state) => {
        const subject = state.cues.recallWithExternalWork
          ? "mixed"
          : "personal";
        return {
          ...state,
          subject,
          evidence: appendPolicyEvidence(state.evidence, "memory_recall_cue"),
        };
      },
    },
    {
      id: "subject.recall_cue_mixed_external_context",
      stage: "guardrail",
      priority: 490,
      reasonCode: "RECALL_CUE_KEEP_MIXED_FOR_EXTERNAL_WORK",
      snapshot: subjectPolicySnapshot,
      applies: (state) =>
        state.cues.recallCue &&
        state.subject === "mixed" &&
        state.cues.recallWithExternalWork,
      apply: (state) => ({
        ...state,
        evidence: appendPolicyEvidence(state.evidence, "memory_recall_cue"),
      }),
    },
    {
      id: "subject.personal_with_external_entity",
      stage: "guardrail",
      priority: 360,
      reasonCode: "PERSONAL_CONTEXT_WITH_EXTERNAL_ENTITY",
      snapshot: subjectPolicySnapshot,
      applies: (state) =>
        state.subject === "personal" &&
        state.cues.personalCue &&
        !state.cues.personalFactAssertionCue &&
        (!state.cues.recallCue || state.cues.recallWithExternalWork) &&
        (state.semanticEvidence.entityHints.tickers.length > 0 ||
          state.semanticEvidence.entityHints.peopleOrCompanies.length > 0 ||
          state.hasModelExternalKnowledge),
      apply: (state) => ({
        ...state,
        subject: "mixed",
        evidence: appendPolicyEvidence(
          state.evidence,
          "personal_context_with_external_entity",
        ),
      }),
    },
    {
      id: "subject.external_personal_cue",
      stage: "guardrail",
      priority: 350,
      reasonCode: "EXTERNAL_WITH_PERSONAL_CONTEXT_CUE",
      snapshot: subjectPolicySnapshot,
      applies: (state) =>
        state.subject === "external" && state.cues.personalCue,
      apply: (state) => ({
        ...state,
        subject: "mixed",
        evidence: appendPolicyEvidence(state.evidence, "personal_context_cue"),
      }),
    },
    {
      id: "subject.low_confidence_external",
      stage: "guardrail",
      priority: 100,
      reasonCode: "LOW_CONFIDENCE_EXTERNAL_TO_MIXED",
      snapshot: subjectPolicySnapshot,
      applies: (state) =>
        state.subject === "external" &&
        state.confidence < deps.lowConfidenceThreshold &&
        !state.cues.externalPastEventCue,
      apply: (state) => ({
        ...state,
        subject: "mixed",
        evidence: appendPolicyEvidence(
          state.evidence,
          "low_confidence_external_subject",
        ),
      }),
    },
  ];
}

function taskPolicyRules(
  deps: IntentPolicyDeps,
): IntentPolicyRule<TaskPolicyState>[] {
  return [
    {
      id: "task.remember_to_action_not_recall",
      stage: "guardrail",
      priority: 600,
      reasonCode: "REMEMBER_TO_ACTION_TASK_NOT_RECALL",
      snapshot: taskPolicySnapshot,
      applies: (state) =>
        deps.hasRememberToActionCue(state.prompt) &&
        (state.taskType === "recall" || state.taskType === "execute"),
      apply: (state) => ({
        ...state,
        taskType: "chat",
        evidence: appendPolicyEvidence(
          state.evidence,
          "remember_to_action_not_recall",
        ),
      }),
    },
    {
      id: "task.personal_fact_assertion_not_recall",
      stage: "guardrail",
      priority: 550,
      reasonCode: "PERSONAL_FACT_ASSERTION_TASK_NOT_RECALL",
      snapshot: taskPolicySnapshot,
      applies: (state) =>
        state.cues.personalFactAssertionCue &&
        (state.taskType === "recall" || state.taskType === "analyze"),
      apply: (state) => ({
        ...state,
        taskType: "chat",
        evidence: appendPolicyEvidence(
          state.evidence,
          "personal_fact_assertion",
        ),
      }),
    },
    {
      id: "task.schedule_cue_override",
      stage: "override",
      priority: 500,
      reasonCode: "SCHEDULE_CUE_TASK_OVERRIDE",
      snapshot: taskPolicySnapshot,
      applies: (state) =>
        state.cues.scheduleCue && state.taskType !== "schedule",
      apply: (state) => ({
        ...state,
        taskType: "schedule",
        evidence: appendPolicyEvidence(state.evidence, "schedule_cue"),
      }),
    },
    {
      id: "task.external_past_event_not_recall",
      stage: "guardrail",
      priority: 450,
      reasonCode: "EXTERNAL_PAST_EVENT_NOT_RECALL",
      snapshot: taskPolicySnapshot,
      applies: (state) =>
        state.cues.externalPastEventCue && state.taskType === "recall",
      apply: (state) => ({
        ...state,
        taskType: "analyze",
        evidence: appendPolicyEvidence(
          state.evidence,
          "external_past_event_not_recall",
        ),
      }),
    },
    {
      id: "task.recall_cue_override",
      stage: "override",
      priority: 400,
      reasonCode: "RECALL_CUE_TASK_OVERRIDE",
      snapshot: taskPolicySnapshot,
      applies: (state) =>
        state.cues.recallCue &&
        state.taskType !== "recall" &&
        state.taskType !== "schedule",
      apply: (state) => ({
        ...state,
        taskType: "recall",
        evidence: appendPolicyEvidence(state.evidence, "memory_recall_cue"),
      }),
    },
    {
      id: "task.delegate_cue_override",
      stage: "override",
      priority: 300,
      reasonCode: "DELEGATE_CUE_TASK_OVERRIDE",
      snapshot: taskPolicySnapshot,
      applies: (state) =>
        state.cues.explicitDelegateCue &&
        state.taskType !== "delegate" &&
        state.taskType !== "schedule",
      apply: (state) => ({
        ...state,
        taskType: "delegate",
        evidence: appendPolicyEvidence(state.evidence, "delegate_action_cue"),
      }),
    },
    {
      id: "task.action_cue_execute",
      stage: "override",
      priority: 200,
      reasonCode: "ACTION_CUE_EXECUTE",
      snapshot: taskPolicySnapshot,
      applies: (state) =>
        state.cues.actionCue &&
        (state.taskType === "chat" || state.taskType === "analyze"),
      apply: (state) => ({
        ...state,
        taskType: "execute",
        evidence: appendPolicyEvidence(state.evidence, "action_cue"),
      }),
    },
  ];
}

function agentPolicyRules(): IntentPolicyRule<AgentPolicyState>[] {
  return [
    {
      id: "agent.investment_analysis_candidate",
      stage: "finalize",
      priority: 300,
      reasonCode: "INVESTMENT_ANALYSIS_CANDIDATE",
      snapshot: agentPolicySnapshot,
      applies: (state) =>
        state.cues.investmentAnalysisCue &&
        !state.candidateAgents.includes("investment-analysis"),
      apply: (state) => ({
        ...state,
        candidateAgents: [...state.candidateAgents, "investment-analysis"],
        evidence: appendPolicyEvidence(
          state.evidence,
          "investment_analysis_candidate",
        ),
      }),
    },
    {
      id: "agent.implicit_delegate_downgrade",
      stage: "guardrail",
      priority: 200,
      reasonCode: "IMPLICIT_DELEGATE_DOWNGRADE",
      snapshot: agentPolicySnapshot,
      applies: (state) =>
        state.taskType === "delegate" && !state.cues.explicitDelegateCue,
      apply: (state) => ({
        ...state,
        taskType: state.cues.investmentAnalysisCue ? "analyze" : "chat",
        delegateDowngraded: true,
        evidence: appendPolicyEvidence(
          state.evidence,
          "delegate_downgraded_to_candidate",
        ),
      }),
    },
  ];
}

export function createIntentPolicyRegistry(
  deps: IntentPolicyDeps,
): IntentPolicyRegistry {
  const registry = {
    semantic: semanticEvidencePolicyRules(deps),
    subject: subjectPolicyRules(deps),
    task: taskPolicyRules(deps),
    agent: agentPolicyRules(),
  };
  assertValidIntentPolicyRegistry(registry);
  return registry;
}

export function listIntentPolicyRules(
  registry: IntentPolicyRegistry,
): IntentPolicyRuleManifest[] {
  return (
    Object.entries(registry) as Array<
      [IntentPolicyRuleManifest["group"], IntentPolicyRule<unknown>[]]
    >
  ).flatMap(([group, rules]) =>
    rules.map((rule) => ({
      group,
      id: rule.id,
      stage: rule.stage,
      priority: rule.priority,
      reasonCode: rule.reasonCode,
      reason: normalizeIntentPolicyReason(rule.reasonCode),
    })),
  );
}

export function validateIntentPolicyRegistry(
  registry: IntentPolicyRegistry,
): string[] {
  const errors: string[] = [];
  const rules = listIntentPolicyRules(registry);
  const idToGroup = new Map<string, string>();
  const reasonCodeToRule = new Map<string, string>();
  const groupPriorityToRule = new Map<string, string>();

  if (rules.length === 0) {
    errors.push("registry has no policy rules");
  }

  for (const rule of rules) {
    if (!rule.id.startsWith(`${rule.group}.`)) {
      errors.push(`${rule.id}: rule id must be prefixed with ${rule.group}.`);
    }
    if (!/^[a-z]+\.[a-z0-9_]+$/.test(rule.id)) {
      errors.push(`${rule.id}: rule id must use lowercase dot notation`);
    }
    if (!/^[A-Z0-9_]+$/.test(rule.reasonCode)) {
      errors.push(
        `${rule.id}: reason code ${rule.reasonCode} must be uppercase snake case`,
      );
    }
    if (!POLICY_REASON_METADATA[rule.reasonCode]) {
      errors.push(`${rule.id}: missing reason metadata for ${rule.reasonCode}`);
    }
    if (!Number.isFinite(rule.priority) || !Number.isInteger(rule.priority)) {
      errors.push(`${rule.id}: priority must be an integer`);
    }

    const existingGroup = idToGroup.get(rule.id);
    if (existingGroup !== undefined) {
      errors.push(
        `${rule.id}: duplicate id in ${existingGroup} and ${rule.group}`,
      );
    } else {
      idToGroup.set(rule.id, rule.group);
    }

    const existingReasonRule = reasonCodeToRule.get(rule.reasonCode);
    if (existingReasonRule !== undefined) {
      errors.push(
        `${rule.id}: duplicate reason code ${rule.reasonCode} also used by ${existingReasonRule}`,
      );
    } else {
      reasonCodeToRule.set(rule.reasonCode, rule.id);
    }

    const groupPriorityKey = `${rule.group}:${rule.priority}`;
    const existingPriorityRule = groupPriorityToRule.get(groupPriorityKey);
    if (existingPriorityRule !== undefined) {
      errors.push(
        `${rule.id}: duplicate priority ${rule.priority} in ${rule.group} also used by ${existingPriorityRule}`,
      );
    } else {
      groupPriorityToRule.set(groupPriorityKey, rule.id);
    }
  }

  return errors;
}

export function assertValidIntentPolicyRegistry(
  registry: IntentPolicyRegistry,
): void {
  const errors = validateIntentPolicyRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Invalid intent policy registry:\n${errors.join("\n")}`);
  }
}
