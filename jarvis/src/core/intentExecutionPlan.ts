/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentFrame, IntentStep } from "./intentResolver.js";
import {
  getCrudPolicyDecision,
  getStepOperation,
} from "../memory-runtime/crudPolicy.js";

export type IntentExecutionMode =
  | "context"
  | "llm"
  | "tool"
  | "agent"
  | "confirm";

export type IntentExecutionStep = {
  step: IntentStep;
  mode: IntentExecutionMode;
  requiredTool: string | null;
  instruction: string;
  completionCriteria: string;
};

export type IntentExecutionPlan = {
  mode: "single_llm" | "orchestrated";
  steps: IntentExecutionStep[];
  requiredTools: string[];
  completionCriteria: string[];
};

function hasConcreteScheduleTime(
  intent: IntentFrame,
  step: IntentStep,
): boolean {
  return (
    intent.resolvedDateRange !== null ||
    intent.timeWindowDays !== null ||
    intent.dateFrom !== null ||
    intent.dateTo !== null ||
    /(\d{1,2}\s*点|\d{1,2}:\d{2}|今天|明天|后天|今晚|早上|上午|中午|下午|晚上|每[天日周月年]|每周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|下周|本周|\d{4}-\d{1,2}-\d{1,2})/i.test(
      `${intent.reason} ${intent.evidence.join(" ")} ${intent.semanticEvidence.actionRequest.object ?? ""} ${step.action} ${step.target}`,
    )
  );
}

function hasConcreteStepTarget(step: IntentStep): boolean {
  const operation = getStepOperation(step);
  const target = (operation.selector || operation.target || step.target)
    .trim()
    .toLowerCase();
  return (
    target.length > 0 &&
    !["reminder", "task", "file", "code", "memory", "agent"].includes(target)
  );
}

function executionForStep(
  intent: IntentFrame,
  step: IntentStep,
): IntentExecutionStep {
  if (step.type === "recall") {
    return {
      step,
      mode: "context",
      requiredTool: null,
      instruction:
        "Use injected memory/current context first; call recall_memory when the injected context is insufficient for the requested recall.",
      completionCriteria:
        "The final answer explicitly uses relevant recalled context or states that no relevant memory was found.",
    };
  }

  if (step.type === "schedule") {
    const operation = getStepOperation(step);
    const policy = getCrudPolicyDecision(operation);
    const hasTime = hasConcreteScheduleTime(intent, step);
    const hasTarget = hasConcreteStepTarget(step);
    const missingRequiredTarget = policy.needsTarget && !hasTarget;
    const missingRequiredTime = policy.needsTime && !hasTime;
    const mode =
      missingRequiredTarget || missingRequiredTime || policy.needsConfirmation
        ? "confirm"
        : "tool";
    return {
      step,
      mode,
      requiredTool: policy.requiredTool,
      instruction:
        mode === "tool"
          ? `Execute the scheduled-task ${operation.action} operation with ${policy.requiredTool}. Do not merely say it has been completed.`
          : "Confirm missing target/time/confirmation details before changing scheduled tasks.",
      completionCriteria:
        "The required task tool result is observed, or the step is blocked because required CRUD details are missing.",
    };
  }

  if (step.type === "delegate") {
    const hasTarget = step.target.trim().length > 0;
    return {
      step,
      mode: hasTarget ? "agent" : "confirm",
      requiredTool: null,
      instruction: hasTarget
        ? "Delegate when an explicit agent path exists; otherwise use the candidate agent as domain guidance and report that no agent task was launched."
        : "Confirm which agent should handle this step before delegating.",
      completionCriteria:
        "Either the specialized agent is launched, or the final answer clearly states that the work was handled by the main model without launching an agent.",
    };
  }

  if (step.type === "execute") {
    const policy = getCrudPolicyDecision(getStepOperation(step));
    const requiresTool =
      policy.requiredTool !== null ||
      intent.richIntent.contextDependency.localWorkspace ||
      intent.semanticEvidence.actionRequest.action === "run" ||
      intent.semanticEvidence.actionRequest.action === "write";
    const shouldConfirm =
      (step.requiresConfirmation || policy.needsConfirmation) &&
      (step.riskLevel === "high" || !hasConcreteStepTarget(step));
    return {
      step,
      mode: shouldConfirm ? "confirm" : requiresTool ? "tool" : "llm",
      requiredTool:
        !shouldConfirm && requiresTool
          ? (policy.requiredTool ?? "appropriate_workspace_or_task_tool")
          : null,
      instruction: shouldConfirm
        ? "Confirm the high-risk operation target before executing it."
        : "Use available tools for file, command, workspace, or scheduled-task changes. If the artifact is meant to be returned inline, produce it directly.",
      completionCriteria:
        "The requested operation or artifact is completed, or the final answer states the concrete blocker.",
    };
  }

  if (step.requiresConfirmation && step.riskLevel === "high") {
    return {
      step,
      mode: "confirm",
      requiredTool: null,
      instruction: "Confirm the risky or ambiguous step before executing it.",
      completionCriteria:
        "The user has confirmed the step, or the response clearly states it was not executed.",
    };
  }

  return {
    step,
    mode: "llm",
    requiredTool: null,
    instruction: "Answer or analyze this step directly in the final response.",
    completionCriteria:
      "The final response contains a clear answer for this step.",
  };
}

export function buildIntentExecutionPlan(
  intent: IntentFrame | null,
): IntentExecutionPlan | null {
  const steps = intent?.intentSteps ?? [];
  if (steps.length <= 1 || !intent) return null;

  const executionSteps = steps.map((step) => executionForStep(intent, step));
  const requiredTools = Array.from(
    new Set(
      executionSteps
        .map((step) => step.requiredTool)
        .filter((tool): tool is string => tool !== null),
    ),
  );
  const mode =
    executionSteps.some(
      (step) =>
        step.mode === "tool" ||
        step.mode === "agent" ||
        step.mode === "confirm",
    ) || requiredTools.length > 0
      ? "orchestrated"
      : "single_llm";

  return {
    mode,
    steps: executionSteps,
    requiredTools,
    completionCriteria: executionSteps.map((step) => step.completionCriteria),
  };
}
