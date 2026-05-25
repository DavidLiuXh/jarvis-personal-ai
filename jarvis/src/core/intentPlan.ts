/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildIntentExecutionPlan,
  type IntentExecutionStep,
} from "./intentExecutionPlan.js";
import type { IntentFrame, IntentStep } from "./intentResolver.js";
import { getStepOperation } from "../memory-runtime/crudPolicy.js";

function formatIntentStep(step: IntentStep): string {
  const dependsOn =
    step.dependsOn.length > 0 ? ` depends_on=${step.dependsOn.join(",")}` : "";
  const confirmation = step.requiresConfirmation
    ? " requires_confirmation=true"
    : "";
  const stepOperation = getStepOperation(step);
  const operation = ` op=${stepOperation.domain}.${stepOperation.action}.${stepOperation.targetType}`;
  return `- [${step.id}] ${step.type}: ${step.action} -> ${step.target || "unspecified"}${operation} risk=${step.riskLevel}${dependsOn}${confirmation}`;
}

function formatExecutionStep(step: IntentExecutionStep): string {
  const requiredTool = step.requiredTool
    ? ` required_tool=${step.requiredTool}`
    : "";
  return `- [${step.step.id}] mode=${step.mode}${requiredTool} instruction="${step.instruction}" done_when="${step.completionCriteria}"`;
}

export function buildIntentPlanSection(intent: IntentFrame | null): string {
  const steps = intent?.intentSteps ?? [];
  if (steps.length <= 1) return "";
  const executionPlan = buildIntentExecutionPlan(intent);
  const executionLines = executionPlan
    ? [
        "",
        "<intent_execution_contract>",
        `mode=${executionPlan.mode}`,
        executionPlan.requiredTools.length > 0
          ? `required_tools=${executionPlan.requiredTools.join(",")}`
          : "required_tools=none",
        "Rules:",
        "- Complete every step in dependency order.",
        "- Do not claim a tool-backed step is complete unless the corresponding tool call succeeded.",
        "- If a step is blocked by missing information, state the blocker and do not silently skip later dependent steps.",
        "- In the final response, summarize which steps were completed and which, if any, were blocked.",
        ...executionPlan.steps.map(formatExecutionStep),
        "</intent_execution_contract>",
      ]
    : [];

  return [
    "",
    "<intent_plan>",
    "The user request contains multiple intent steps. Treat this as an execution plan, not a suggestion.",
    ...steps.map(formatIntentStep),
    "</intent_plan>",
    ...executionLines,
    "",
  ].join("\n");
}
