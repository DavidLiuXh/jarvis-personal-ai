/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ClarificationQuestion,
  IntentFrame,
  QuerySubject,
} from "./types.js";
import { getCrudPolicyDecision, getStepOperation } from "./crudPolicy.js";

export type { IntentFrame, QuerySubject } from "./types.js";

export type ClarificationPolicyInput = {
  userPrompt: string;
  intent: IntentFrame | null;
  querySubject: QuerySubject;
  candidateAgents: string[];
  recentHistoryLength?: number;
  executionContext?: "interactive" | "proactive_task";
};

export type ClarificationState =
  | "ready"
  | "awaiting_user"
  | "blocked_without_channel";

export type ClarificationScope = "none" | "intent" | "step";

export type ClarificationStepRequirement = {
  stepId: string;
  stepType: IntentFrame["intentSteps"][number]["type"];
  reason: string;
  blocking: boolean;
};

export type ClarificationDecision = {
  state: ClarificationState;
  scope: ClarificationScope;
  shouldAsk: boolean;
  blocking: boolean;
  questions: ClarificationQuestion[];
  reasons: string[];
  stepRequirements: ClarificationStepRequirement[];
};

export type ClarificationRuntimeRequirement = {
  id: string;
  scope: ClarificationScope;
  stepId: string | null;
  reason: string;
  questionHeader: string | null;
  blocking: boolean;
  askedCount: number;
  answered: boolean;
  answer: string | null;
};

export type ClarificationRuntimeState = {
  state: ClarificationState;
  pendingRequirements: ClarificationRuntimeRequirement[];
  answeredRequirements: ClarificationRuntimeRequirement[];
  askedQuestionHeaders: string[];
  answeredQuestionHeaders: string[];
  answers: Record<string, string>;
  turns: number;
};

export type ClarificationTrace = {
  enabled: true;
  state: ClarificationState;
  scope: ClarificationScope;
  shouldAsk: boolean;
  blocking: boolean;
  reasons: string[];
  stepRequirements: ClarificationStepRequirement[];
  questionHeaders: string[];
  intent: null | {
    subject: IntentFrame["subject"];
    taskType: IntentFrame["taskType"];
    needsMemory: boolean;
    referencesRecentHistory: boolean;
    confidence: number;
    confidenceByDimension: IntentFrame["confidenceByDimension"];
    memoryTarget: IntentFrame["semanticEvidence"]["memoryRecall"]["target"];
    riskLevel: IntentFrame["richIntent"]["riskLevel"];
    ambiguity: IntentFrame["richIntent"]["ambiguity"];
  };
  input: {
    querySubject: QuerySubject;
    candidateAgents: string[];
    recentHistoryLength: number;
    executionContext: "interactive" | "proactive_task";
  };
};

const LOW_CONFIDENCE_THRESHOLD = 0.55;

function questionHeader(
  question: ClarificationQuestion,
  index: number,
): string {
  return question.header ?? `Q${index + 1}`;
}

function answerKey(question: ClarificationQuestion, index: number): string {
  return `${index}_${question.header ?? question.question.slice(0, 20)}`;
}

function answerForQuestion(
  answers: Record<string, string>,
  question: ClarificationQuestion,
  index: number,
): string {
  return (
    answers[answerKey(question, index)] ??
    answers[String(index)] ??
    answers[questionHeader(question, index)] ??
    ""
  );
}

function requirementId(requirement: ClarificationStepRequirement): string {
  return `step:${requirement.stepId}:${requirement.reason}`;
}

function intentRequirementId(reason: string): string {
  return `intent:${reason}`;
}

function hasHighSeverityAmbiguity(
  intent: IntentFrame,
  fields: string[],
): boolean {
  return intent.richIntent.ambiguity.some((item) => {
    if (item.severity !== "high") return false;
    const field = item.field.toLowerCase();
    return fields.some((candidate) => field.includes(candidate));
  });
}

function addQuestion(
  questions: ClarificationQuestion[],
  question: ClarificationQuestion,
): void {
  if (questions.some((existing) => existing.header === question.header)) return;
  questions.push(question);
}

function hasScheduleTimeCue(text: string): boolean {
  return /(\d{1,2}\s*点|\d{1,2}:\d{2}|今天|明天|后天|今晚|早上|上午|中午|下午|晚上|每[天日周月年]|每周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|下周|本周|\d{4}-\d{1,2}-\d{1,2})/i.test(
    text,
  );
}

function hasConcreteScheduleTime(
  intent: IntentFrame,
  userPrompt: string,
  stepText = "",
): boolean {
  return (
    intent.resolvedDateRange !== null ||
    intent.timeWindowDays !== null ||
    intent.dateFrom !== null ||
    intent.dateTo !== null ||
    hasScheduleTimeCue(userPrompt) ||
    hasScheduleTimeCue(intent.semanticEvidence.actionRequest.object ?? "") ||
    hasScheduleTimeCue(stepText)
  );
}

function hasConcreteTarget(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !/^(这条|这个|那个|它|this|that)$/i.test(trimmed) &&
    !/^(把)?(这条|这个|那个|它)(记忆|提醒|任务|文件)?(删掉|删除|取消|更新)?$/i.test(
      trimmed,
    ) &&
    !["reminder", "task", "file", "code", "memory", "agent"].includes(
      trimmed.toLowerCase(),
    )
  );
}

function addStepRequirement(
  requirements: ClarificationStepRequirement[],
  requirement: ClarificationStepRequirement,
): void {
  if (
    requirements.some(
      (existing) =>
        existing.stepId === requirement.stepId &&
        existing.reason === requirement.reason,
    )
  ) {
    return;
  }
  requirements.push(requirement);
}

function buildDecision(args: {
  questions: ClarificationQuestion[];
  reasons: string[];
  stepRequirements: ClarificationStepRequirement[];
}): ClarificationDecision {
  const shouldAsk = args.questions.length > 0;
  const blocking =
    args.questions.length > 0 ||
    args.stepRequirements.some((requirement) => requirement.blocking);
  return {
    state: shouldAsk ? "awaiting_user" : "ready",
    scope:
      args.stepRequirements.length > 0
        ? "step"
        : args.reasons.length > 0
          ? "intent"
          : "none",
    shouldAsk,
    blocking,
    questions: args.questions,
    reasons: args.reasons,
    stepRequirements: args.stepRequirements,
  };
}

export function applyClarificationChannelState(
  decision: ClarificationDecision,
  hasInteractiveChannel: boolean,
): ClarificationDecision {
  if (!decision.shouldAsk || hasInteractiveChannel) return decision;
  return {
    ...decision,
    state: "blocked_without_channel",
    blocking: true,
  };
}

export function buildClarificationRuntimeState(
  decision: ClarificationDecision,
  previous?: ClarificationRuntimeState | null,
): ClarificationRuntimeState {
  const previousRequirements = [
    ...(previous?.pendingRequirements ?? []),
    ...(previous?.answeredRequirements ?? []),
  ];
  const byId = new Map(
    previousRequirements.map((requirement) => [requirement.id, requirement]),
  );
  const questionHeaders = decision.questions.map(questionHeader);
  const stepRequirements = decision.stepRequirements.map((requirement) => {
    const id = requirementId(requirement);
    const existing = byId.get(id);
    return {
      id,
      scope: "step" as ClarificationScope,
      stepId: requirement.stepId,
      reason: requirement.reason,
      questionHeader:
        questionHeaders.find((header) => header.includes(requirement.stepId)) ??
        null,
      blocking: requirement.blocking,
      askedCount: (existing?.askedCount ?? 0) + (decision.shouldAsk ? 1 : 0),
      answered: existing?.answered ?? false,
      answer: existing?.answer ?? null,
    };
  });

  const stepRequirementReasons = new Set(
    decision.stepRequirements.map((requirement) => requirement.reason),
  );
  const intentRequirements = decision.reasons
    .filter((reason) => !stepRequirementReasons.has(reason))
    .map((reason) => {
      const id = intentRequirementId(reason);
      const existing = byId.get(id);
      return {
        id,
        scope: "intent" as ClarificationScope,
        stepId: null,
        reason,
        questionHeader: questionHeaders[0] ?? null,
        blocking: decision.blocking,
        askedCount: (existing?.askedCount ?? 0) + (decision.shouldAsk ? 1 : 0),
        answered: existing?.answered ?? false,
        answer: existing?.answer ?? null,
      };
    });

  const requirements = [...stepRequirements, ...intentRequirements];
  const pendingRequirements = requirements.filter(
    (requirement) => !requirement.answered,
  );
  const answeredRequirements = [
    ...(previous?.answeredRequirements ?? []),
    ...requirements.filter((requirement) => requirement.answered),
  ].filter(
    (requirement, index, all) =>
      all.findIndex((candidate) => candidate.id === requirement.id) === index,
  );

  return {
    state: decision.state,
    pendingRequirements,
    answeredRequirements,
    askedQuestionHeaders: Array.from(
      new Set([...(previous?.askedQuestionHeaders ?? []), ...questionHeaders]),
    ),
    answeredQuestionHeaders: previous?.answeredQuestionHeaders ?? [],
    answers: previous?.answers ?? {},
    turns: (previous?.turns ?? 0) + (decision.shouldAsk ? 1 : 0),
  };
}

export function applyClarificationAnswers(
  state: ClarificationRuntimeState,
  decision: ClarificationDecision,
  answers: Record<string, string>,
): ClarificationRuntimeState {
  const answeredHeaders = new Set(state.answeredQuestionHeaders);
  const normalizedAnswers = { ...state.answers };
  for (const [index, question] of decision.questions.entries()) {
    const answer = answerForQuestion(answers, question, index).trim();
    if (!answer) continue;
    const header = questionHeader(question, index);
    answeredHeaders.add(header);
    normalizedAnswers[header] = answer;
  }

  const markRequirement = (
    requirement: ClarificationRuntimeRequirement,
  ): ClarificationRuntimeRequirement => {
    const answer =
      (requirement.questionHeader
        ? normalizedAnswers[requirement.questionHeader]
        : undefined) ??
      (requirement.stepId
        ? Object.entries(normalizedAnswers).find(([header]) =>
            header.includes(requirement.stepId ?? ""),
          )?.[1]
        : undefined) ??
      null;
    return answer ? { ...requirement, answered: true, answer } : requirement;
  };

  const pending = state.pendingRequirements.map(markRequirement);
  return {
    ...state,
    state: pending.some((requirement) => !requirement.answered)
      ? "awaiting_user"
      : "ready",
    pendingRequirements: pending.filter((requirement) => !requirement.answered),
    answeredRequirements: [
      ...state.answeredRequirements,
      ...pending.filter((requirement) => requirement.answered),
    ].filter(
      (requirement, index, all) =>
        all.findIndex((candidate) => candidate.id === requirement.id) === index,
    ),
    answeredQuestionHeaders: Array.from(answeredHeaders),
    answers: normalizedAnswers,
  };
}

export function filterClarificationDecisionByState(
  decision: ClarificationDecision,
  state: ClarificationRuntimeState | null | undefined,
): ClarificationDecision {
  if (!state) return decision;
  const answeredHeaders = new Set(state.answeredQuestionHeaders);
  const answeredRequirements = new Set(
    state.answeredRequirements.map((requirement) => requirement.id),
  );
  const questions = decision.questions.filter(
    (question, index) => !answeredHeaders.has(questionHeader(question, index)),
  );
  const stepRequirements = decision.stepRequirements.filter(
    (requirement) => !answeredRequirements.has(requirementId(requirement)),
  );
  const answeredReasons = new Set(
    state.answeredRequirements.map((requirement) => requirement.reason),
  );
  return buildDecision({
    questions,
    reasons: decision.reasons.filter((reason) => !answeredReasons.has(reason)),
    stepRequirements,
  });
}

export function buildClarificationDecision(
  input: ClarificationPolicyInput,
): ClarificationDecision {
  const questions: ClarificationQuestion[] = [];
  const reasons: string[] = [];
  const stepRequirements: ClarificationStepRequirement[] = [];
  const { intent } = input;
  const isProactiveTask = input.executionContext === "proactive_task";

  if (!intent) {
    return buildDecision({ questions, reasons, stepRequirements });
  }

  const dimension = intent.confidenceByDimension;
  const highRiskExecution =
    intent.taskType === "execute" ||
    intent.taskType === "delegate" ||
    intent.taskType === "schedule" ||
    intent.richIntent.riskLevel === "high";
  const actionAmbiguous =
    dimension.action < LOW_CONFIDENCE_THRESHOLD ||
    hasHighSeverityAmbiguity(intent, ["action", "operation", "tool"]);
  const targetAmbiguous =
    hasHighSeverityAmbiguity(intent, ["target", "file", "agent", "object"]) ||
    intent.richIntent.targets.length === 0;

  for (const step of intent.intentSteps) {
    const operation = getStepOperation(step);
    const policy = getCrudPolicyDecision(operation);
    const operationTarget = operation.selector || operation.target;
    if (
      !isProactiveTask &&
      policy.needsTime &&
      !hasConcreteScheduleTime(
        intent,
        input.userPrompt,
        `${step.action} ${step.target} ${operationTarget}`,
      )
    ) {
      addStepRequirement(stepRequirements, {
        stepId: step.id,
        stepType: step.type,
        reason: "schedule_step_missing_time",
        blocking: true,
      });
      reasons.push("schedule_step_missing_time");
      addQuestion(questions, {
        header: `Schedule ${step.id}`,
        question: "这个提醒或计划步骤需要安排在什么时候？",
        type: "text",
        placeholder: "例如：明天早上 9 点、每周一 8 点",
      });
    }

    if (policy.needsTarget && !hasConcreteTarget(operationTarget)) {
      const reason =
        operation.action === "delete" ||
        operation.action === "forget" ||
        operation.action === "cancel"
          ? "crud_target_required_for_destructive_action"
          : "crud_target_required";
      addStepRequirement(stepRequirements, {
        stepId: step.id,
        stepType: step.type,
        reason,
        blocking: true,
      });
      reasons.push(reason);
      addQuestion(questions, {
        header: `Target ${step.id}`,
        question: "这个步骤要作用在哪个具体对象上？",
        type: "text",
        placeholder: "例如：提醒名称、文件路径、记忆内容、目标 channel",
      });
    }

    if (
      (step.requiresConfirmation || policy.needsConfirmation) &&
      (actionAmbiguous || targetAmbiguous)
    ) {
      const reason =
        step.type === "delegate"
          ? "delegate_step_target_ambiguous"
          : policy.needsConfirmation
            ? "crud_step_confirmation_required"
            : "execute_step_action_ambiguous";
      addStepRequirement(stepRequirements, {
        stepId: step.id,
        stepType: step.type,
        reason,
        blocking: true,
      });
      reasons.push(reason);
    }

    if (
      step.type === "recall" &&
      input.querySubject !== "external" &&
      dimension.memoryTarget < LOW_CONFIDENCE_THRESHOLD
    ) {
      addStepRequirement(stepRequirements, {
        stepId: step.id,
        stepType: step.type,
        reason: "recall_step_memory_target_ambiguous",
        blocking: true,
      });
      reasons.push("recall_step_memory_target_ambiguous");
    }
  }

  if (highRiskExecution && (actionAmbiguous || targetAmbiguous)) {
    reasons.push("high_risk_action_ambiguous");
    addQuestion(questions, {
      header: "Clarify action",
      question: "你希望我具体执行什么动作？",
      type: "text",
      placeholder: "例如：修改哪个文件、运行哪个命令、启动哪个 agent",
    });
  }

  const allCandidateAgents = Array.from(
    new Set([...intent.candidateAgents, ...input.candidateAgents]),
  ).filter(Boolean);
  if (
    intent.taskType === "delegate" &&
    allCandidateAgents.length > 1 &&
    (dimension.action < 0.7 || targetAmbiguous)
  ) {
    reasons.push("delegate_agent_ambiguous");
    addQuestion(questions, {
      header: "Choose agent",
      question: "你希望把这个任务交给哪个 agent？",
      type: "choice",
      options: allCandidateAgents.map((agentId) => ({
        label: agentId,
        description: agentId === allCandidateAgents[0] ? "Recommended" : "",
      })),
    });
  }

  if (
    !isProactiveTask &&
    (intent.intentSteps.some(
      (step) => getCrudPolicyDecision(getStepOperation(step)).needsTime,
    ) ||
      (intent.taskType === "schedule" &&
        !["delete", "read", "list", "cancel"].includes(
          intent.richIntent.action,
        ))) &&
    !hasConcreteScheduleTime(intent, input.userPrompt)
  ) {
    reasons.push("schedule_time_ambiguous");
    addQuestion(questions, {
      header: "Schedule",
      question: "这个任务需要在什么时候提醒或执行？",
      type: "text",
      placeholder: "例如：明天早上 9 点、每周一 8 点",
    });
  }

  const memoryTargetAmbiguous =
    dimension.memoryTarget < LOW_CONFIDENCE_THRESHOLD ||
    hasHighSeverityAmbiguity(intent, ["memory", "context"]);
  const memoryLookupRequested =
    intent.semanticEvidence.memoryRecall.target !== "none" ||
    intent.referencesRecentHistory ||
    (intent.semanticEvidence.personalContext.present &&
      intent.needsExternalKnowledge);
  if (
    input.querySubject !== "external" &&
    intent.needsMemory &&
    memoryLookupRequested &&
    memoryTargetAmbiguous
  ) {
    reasons.push("memory_target_ambiguous");
    addQuestion(questions, {
      header: "Memory",
      question: "这里需要参考你的长期记忆，还是只参考当前对话？",
      type: "choice",
      options: [
        {
          label: "当前对话",
          description: "Recommended when you mean what we are discussing now",
        },
        {
          label: "长期记忆",
          description: "Use saved preferences, facts, or older conversations",
        },
        {
          label: "都不需要",
          description: "Answer without personal memory",
        },
      ],
    });
  }

  if (
    intent.referencesRecentHistory &&
    (input.recentHistoryLength ?? 0) === 0 &&
    intent.semanticEvidence.memoryRecall.target === "current_context_reference"
  ) {
    reasons.push("missing_recent_context");
    addQuestion(questions, {
      header: "Context",
      question: "你提到的“这个/刚才/继续”具体指什么？",
      type: "text",
      placeholder: "请补充要继续处理的对象或上下文",
    });
  }

  return buildDecision({
    questions,
    reasons: Array.from(new Set(reasons)),
    stepRequirements,
  });
}

export function buildClarifiedPrompt(
  originalPrompt: string,
  decision: ClarificationDecision,
  answers: Record<string, string>,
): string {
  const answerLines = decision.questions.map((question, index) => {
    const answer = answerForQuestion(answers, question, index);
    return `- ${questionHeader(question, index)}: ${answer}`;
  });

  return [
    originalPrompt,
    "",
    "User clarification:",
    ...answerLines.filter((line) => !line.endsWith(": ")),
  ].join("\n");
}

export function formatClarificationQuestions(
  decision: ClarificationDecision,
): string {
  const lines = ["我需要先确认一个关键信息："];
  decision.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.question}`);
    question.options?.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex + 1}. ${option.label}`);
    });
  });
  return lines.join("\n");
}

export function buildClarificationTrace(
  input: ClarificationPolicyInput,
  decision: ClarificationDecision,
): ClarificationTrace {
  return {
    enabled: true,
    state: decision.state,
    scope: decision.scope,
    shouldAsk: decision.shouldAsk,
    blocking: decision.blocking,
    reasons: decision.reasons,
    stepRequirements: decision.stepRequirements,
    questionHeaders: decision.questions.map(
      (question) => question.header ?? question.question.slice(0, 40),
    ),
    intent: input.intent
      ? {
          subject: input.intent.subject,
          taskType: input.intent.taskType,
          needsMemory: input.intent.needsMemory,
          referencesRecentHistory: input.intent.referencesRecentHistory,
          confidence: input.intent.confidence,
          confidenceByDimension: input.intent.confidenceByDimension,
          memoryTarget: input.intent.semanticEvidence.memoryRecall.target,
          riskLevel: input.intent.richIntent.riskLevel,
          ambiguity: input.intent.richIntent.ambiguity,
        }
      : null,
    input: {
      querySubject: input.querySubject,
      candidateAgents: input.candidateAgents,
      recentHistoryLength: input.recentHistoryLength ?? 0,
      executionContext: input.executionContext ?? "interactive",
    },
  };
}
