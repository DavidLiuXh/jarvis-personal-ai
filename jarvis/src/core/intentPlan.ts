/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentFrame, IntentStep } from "./intentResolver.js";

function formatIntentStep(step: IntentStep): string {
  const dependsOn =
    step.dependsOn.length > 0 ? ` depends_on=${step.dependsOn.join(",")}` : "";
  const confirmation = step.requiresConfirmation
    ? " requires_confirmation=true"
    : "";
  return `- [${step.id}] ${step.type}: ${step.action} -> ${step.target || "unspecified"} risk=${step.riskLevel}${dependsOn}${confirmation}`;
}

export function buildIntentPlanSection(intent: IntentFrame | null): string {
  const steps = intent?.intentSteps ?? [];
  if (steps.length <= 1) return "";

  return [
    "",
    "<intent_plan>",
    "The user request contains multiple intent steps. Complete all applicable steps in order unless safety, missing permissions, or clarification policy prevents execution.",
    ...steps.map(formatIntentStep),
    "</intent_plan>",
    "",
  ].join("\n");
}
