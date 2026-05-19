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

export type ClarificationDecision = {
  shouldAsk: boolean;
  blocking: boolean;
  questions: AskUserQuestion[];
  reasons: string[];
};

export type ClarificationTrace = {
  enabled: true;
  shouldAsk: boolean;
  blocking: boolean;
  reasons: string[];
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

export function buildClarificationDecision(
  input: ClarificationPolicyInput,
): ClarificationDecision {
  const questions: AskUserQuestion[] = [];
  const reasons: string[] = [];
  const { intent } = input;

  if (!intent) {
    return { shouldAsk: false, blocking: false, questions, reasons };
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
    intent.resolvedDateRange === null &&
    intent.timeWindowDays === null
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
  if (
    input.querySubject !== "external" &&
    intent.needsMemory &&
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

  return {
    shouldAsk: questions.length > 0,
    blocking: questions.length > 0,
    questions,
    reasons,
  };
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
    shouldAsk: decision.shouldAsk,
    blocking: decision.blocking,
    reasons: decision.reasons,
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
