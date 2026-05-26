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

export type IntentStepRuntimeStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped";

export type ToolCallLike = {
  name: string;
  callId?: string;
  args?: Record<string, unknown>;
};

export type FunctionResponseLike = {
  functionResponse?: {
    name?: string;
    response?: unknown;
  };
};

export type IntentStepRuntimeEntry = IntentExecutionStep & {
  status: IntentStepRuntimeStatus;
  attempts: number;
  lastToolName: string | null;
  lastError: string | null;
  seenSignatures: Set<string>;
};

export type DuplicateToolDecision = {
  executableRequests: ToolCallLike[];
  duplicateResponses: FunctionResponseLike[];
  suppressed: Array<{ request: ToolCallLike; stepId: string | null }>;
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

const ENFORCEABLE_STEP_TOOLS = new Set(["recall_memory", "task_add"]);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function toolSignature(request: ToolCallLike): string {
  return `${request.name}:${stableJson(request.args ?? {})}`;
}

function responseHasError(response: unknown): boolean {
  if (typeof response === "string") {
    return /(^|[^\w])(error|failed|denied|not available|requires|❌)([^\w]|$)/i.test(
      response,
    );
  }
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if ("error" in record || record.status === "error") return true;
    if (typeof record.result === "string")
      return responseHasError(record.result);
  }
  return false;
}

function responseErrorText(response: unknown): string | null {
  if (!responseHasError(response)) return null;
  if (typeof response === "string") return response.slice(0, 240);
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    if (typeof record.error === "string") return record.error.slice(0, 240);
    if (typeof record.result === "string") return record.result.slice(0, 240);
  }
  return "tool response reported an error";
}

export class IntentStepRuntime {
  readonly plan: IntentExecutionPlan | null;
  private entries: IntentStepRuntimeEntry[];
  private signatureToStepId = new Map<string, string>();
  private maxAttemptsPerStep: number;

  constructor(
    intent: IntentFrame | null,
    options?: { maxAttemptsPerStep?: number },
  ) {
    this.plan = buildIntentExecutionPlan(intent);
    this.entries =
      this.plan?.steps.map((step) => ({
        ...step,
        status:
          step.mode === "context" || step.mode === "llm"
            ? "succeeded"
            : step.mode === "confirm"
              ? "blocked"
              : "pending",
        attempts: 0,
        lastToolName: null,
        lastError: step.mode === "confirm" ? "confirmation required" : null,
        seenSignatures: new Set<string>(),
      })) ?? [];
    this.maxAttemptsPerStep = options?.maxAttemptsPerStep ?? 2;
  }

  get active(): boolean {
    return this.entries.length > 1;
  }

  snapshot(): Array<
    Pick<
      IntentStepRuntimeEntry,
      "step" | "mode" | "requiredTool" | "status" | "attempts" | "lastError"
    >
  > {
    return this.entries.map((entry) => ({
      step: entry.step,
      mode: entry.mode,
      requiredTool: entry.requiredTool,
      status: entry.status,
      attempts: entry.attempts,
      lastError: entry.lastError,
    }));
  }

  actionableEnforceableSteps(): IntentStepRuntimeEntry[] {
    return this.entries.filter(
      (entry) =>
        (entry.status === "pending" || entry.status === "failed") &&
        entry.requiredTool !== null &&
        ENFORCEABLE_STEP_TOOLS.has(entry.requiredTool),
    );
  }

  private matchRequestToStep(
    request: ToolCallLike,
  ): IntentStepRuntimeEntry | null {
    const exact = this.entries.find(
      (entry) =>
        entry.status === "pending" && entry.requiredTool === request.name,
    );
    if (exact) return exact;
    return (
      this.entries.find(
        (entry) =>
          entry.requiredTool === request.name &&
          entry.status !== "blocked" &&
          entry.status !== "skipped",
      ) ?? null
    );
  }

  filterDuplicateToolCalls(requests: ToolCallLike[]): DuplicateToolDecision {
    const executableRequests: ToolCallLike[] = [];
    const duplicateResponses: FunctionResponseLike[] = [];
    const suppressed: Array<{ request: ToolCallLike; stepId: string | null }> =
      [];

    for (const request of requests) {
      const signature = toolSignature(request);
      const step = this.matchRequestToStep(request);
      const stepAlreadySucceeded =
        step !== null &&
        step.status === "succeeded" &&
        step.seenSignatures.has(signature);
      const globallySucceededStepId = this.signatureToStepId.get(signature);
      if (stepAlreadySucceeded || globallySucceededStepId) {
        const stepId = step?.step.id ?? globallySucceededStepId ?? null;
        duplicateResponses.push({
          functionResponse: {
            name: request.name,
            response: {
              result:
                `Duplicate tool call suppressed for ${stepId ?? "completed step"}. ` +
                `The matching step already has a successful result; continue with the next incomplete step or final answer.`,
            },
          },
        });
        suppressed.push({ request, stepId });
        continue;
      }
      executableRequests.push(request);
    }

    return { executableRequests, duplicateResponses, suppressed };
  }

  observeToolResults(
    requests: ToolCallLike[],
    responseParts: FunctionResponseLike[],
  ): void {
    for (const request of requests) {
      const step = this.matchRequestToStep(request);
      if (!step) continue;
      const signature = toolSignature(request);
      const responsePart = responseParts.find(
        (part) => part.functionResponse?.name === request.name,
      );
      const response = responsePart?.functionResponse?.response;
      const errorText = responseErrorText(response);
      step.attempts += 1;
      step.lastToolName = request.name;
      step.seenSignatures.add(signature);

      if (errorText) {
        step.lastError = errorText;
        step.status =
          step.attempts >= this.maxAttemptsPerStep ? "blocked" : "failed";
      } else {
        step.status = "succeeded";
        step.lastError = null;
        this.signatureToStepId.set(signature, step.step.id);
      }
    }
  }

  buildMissingStepPrompt(): string | null {
    const missingSteps = this.actionableEnforceableSteps();
    if (missingSteps.length === 0) return null;
    return [
      "SYSTEM: The multi-intent execution contract is not complete.",
      "Continue the same user request, but execute only the incomplete tool-backed step(s) below.",
      "Do not repeat steps marked succeeded or blocked. Do not call the same tool with the same arguments again.",
      "Incomplete steps:",
      ...missingSteps.map(
        (entry) =>
          `- ${entry.step.id} ${entry.step.type}: ${entry.step.action} -> ${entry.step.target}; required_tool=${entry.requiredTool}; attempts=${entry.attempts}; done_when=${entry.completionCriteria}`,
      ),
    ].join("\n");
  }

  buildDeterministicToolRequests(): ToolCallLike[] {
    const requests: ToolCallLike[] = [];
    for (const entry of this.actionableEnforceableSteps()) {
      if (entry.requiredTool !== "task_add") continue;
      const operation = getStepOperation(entry.step);
      const target = (operation.target || entry.step.target).trim();
      if (
        !target ||
        ["reminder", "task", "schedule", "follow-up"].includes(
          target.toLowerCase(),
        )
      ) {
        continue;
      }
      requests.push({
        name: "task_add",
        callId: `intent-${entry.step.id}-task_add`,
        args: {
          cron: target,
          prompt: target,
        },
      });
    }
    return requests;
  }

  buildStatePrompt(): string {
    return [
      "SYSTEM: Multi-intent step runtime state.",
      ...this.entries.map((entry) => {
        const error = entry.lastError ? ` last_error="${entry.lastError}"` : "";
        return `- ${entry.step.id}: status=${entry.status} mode=${entry.mode} required_tool=${entry.requiredTool ?? "none"} attempts=${entry.attempts}${error}`;
      }),
      "Use this state to avoid repeating completed steps.",
    ].join("\n");
  }
}
