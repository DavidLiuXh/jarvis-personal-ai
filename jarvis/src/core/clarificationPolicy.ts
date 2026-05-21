/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AskUserQuestion } from "./toolRouter.js";
import type { IntentFrame, QuerySubject } from "./intentResolver.js";

export type ClarificationPolicyInput = {
  userPrompt: string;
  intent: IntentFrame | null;
  querySubject: QuerySubject;
  candidateAgents: string[];
  recentHistoryLength?: number;
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
  questions: AskUserQuestion[];
  reasons: string[];
  stepRequirements: ClarificationStepRequirement[];
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
  };
};

const LOW_CONFIDENCE_THRESHOLD = 0.55;

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
  questions: AskUserQuestion[],
  question: AskUserQuestion,
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
): boolean {
  return (
    intent.resolvedDateRange !== null ||
    intent.timeWindowDays !== null ||
    intent.dateFrom !== null ||
    intent.dateTo !== null ||
    hasScheduleTimeCue(userPrompt) ||
    hasScheduleTimeCue(intent.semanticEvidence.actionRequest.object ?? "")
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
  questions: AskUserQuestion[];
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

export function buildClarificationDecision(
  input: ClarificationPolicyInput,
): ClarificationDecision {
  const questions: AskUserQuestion[] = [];
  const reasons: string[] = [];
  const stepRequirements: ClarificationStepRequirement[] = [];
  const { intent } = input;

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
    if (
      step.type === "schedule" &&
      !hasConcreteScheduleTime(intent, input.userPrompt)
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

    if (
      (step.type === "execute" || step.type === "delegate") &&
      step.requiresConfirmation &&
      (actionAmbiguous || targetAmbiguous)
    ) {
      const reason =
        step.type === "delegate"
          ? "delegate_step_target_ambiguous"
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
    intent.taskType === "schedule" &&
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
    const key = `${index}_${question.header ?? question.question.slice(0, 20)}`;
    const answer = answers[key] ?? answers[String(index)] ?? "";
    return `- ${question.header ?? `Q${index + 1}`}: ${answer}`;
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
    },
  };
}
