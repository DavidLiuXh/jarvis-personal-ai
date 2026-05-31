/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IntentFrame,
  IntentStep,
} from "../../memory-runtime/src/types.js";
import {
  getCrudPolicyDecision,
  getStepOperation,
} from "../../memory-runtime/src/crudPolicy.js";

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
  | "running"
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
  toolCalls: ToolCallLike[];
  agentCalls: string[];
  observedResults: string[];
  seenSignatures: Set<string>;
};

export type DuplicateToolDecision = {
  executableRequests: ToolCallLike[];
  duplicateResponses: FunctionResponseLike[];
  suppressed: Array<{
    request: ToolCallLike;
    stepId: string | null;
    reason?: string;
  }>;
};

const GENERIC_TASK_TARGETS = new Set([
  "reminder",
  "task",
  "schedule",
  "follow-up",
  "定时任务",
  "任务",
  "提醒",
]);

const SCHEDULE_TIME_PATTERNS = [
  /(?:北京时间\s*)?(?:每\s*)?(?:周|星期)[一二三四五六日天](?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /(?:北京时间\s*)?(?:每天|每日|每\s*天|每\s*日)(?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /(?:今天|明天|后天|今晚|下周[一二三四五六日天]?|本周[一二三四五六日天]?)(?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /\b(?:every\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b(?:daily|every day|weekdays)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b(?:\d+|\*)\s+(?:\d+|\*)\s+(?:\d+|\*)\s+(?:\d+|\*)\s+(?:[\d*,-]+)\b/,
];

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

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s,，:：;；。]+|[\s,，:：;；。]+$/g, "")
    .trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(normalizeText)) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function collectScheduleTextSources(
  intent: IntentFrame | null,
  step: IntentStep,
): string[] {
  const operation = getStepOperation(step);
  return uniqueNonEmpty([
    operation.selector,
    operation.target,
    step.target,
    step.action,
    intent?.semanticEvidence.actionRequest.object ?? "",
    intent?.richIntent.userGoal ?? "",
    intent?.richIntent.action ?? "",
    intent?.richIntent.primaryAction ?? "",
    intent?.reason ?? "",
    ...(intent?.evidence ?? []),
  ]);
}

function extractScheduleTimeText(sources: string[]): string | null {
  for (const source of sources) {
    for (const pattern of SCHEDULE_TIME_PATTERNS) {
      const match = source.match(pattern);
      const text = normalizeText(match?.[0] ?? "");
      if (text) return text;
    }
  }
  return null;
}

function stripScheduleWrapper(text: string, cronText: string): string {
  let result = normalizeText(text);
  result = result
    .replace(
      /^(?:请|帮我|麻烦)?(?:添加|创建|新增|设置|建立)?(?:一个|一条)?(?:定时任务|定时|任务|提醒|schedule|scheduled task)\s*[:：,，-]*/i,
      "",
    )
    .replace(/^(?:北京时间|当地时间)\s*[:：,，-]*/i, "")
    .replace(/^(?:并且|然后|再|同时)\s*/i, "");
  if (cronText) {
    for (const variant of uniqueNonEmpty([
      cronText,
      cronText.replace(/^(?:北京时间|当地时间)\s*/i, ""),
    ])) {
      result = normalizeText(result.replace(variant, " "));
    }
  }
  result = result.replace(/^(?:并且|然后|再|同时)\s*/i, "");
  return normalizeText(result);
}

function isGenericTaskPrompt(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  return (
    normalized.length === 0 ||
    GENERIC_TASK_TARGETS.has(normalized) ||
    /^(?:添加|创建|新增|设置)?(?:定时任务|任务|提醒)$/.test(normalized)
  );
}

function buildPromptFromNonScheduleSteps(
  intent: IntentFrame | null,
): string | null {
  const prompt = uniqueNonEmpty(
    (intent?.intentSteps ?? [])
      .filter((step) => step.type !== "schedule")
      .map((step) => normalizeText(`${step.action} ${step.target}`)),
  ).join("；");
  return prompt && !isGenericTaskPrompt(prompt) ? prompt : null;
}

function buildTaskAddArgs(
  intent: IntentFrame | null,
  step: IntentStep,
): Record<string, string> | null {
  const sources = collectScheduleTextSources(intent, step);
  const cronText = extractScheduleTimeText(sources);
  if (!cronText) return null;

  const directPromptCandidates = sources
    .filter((source) => source.includes(cronText))
    .map((source) => stripScheduleWrapper(source, cronText))
    .filter((source) => !isGenericTaskPrompt(source))
    .sort((a, b) => b.length - a.length);
  const fallbackPromptCandidates = sources
    .filter((source) => !source.includes(cronText))
    .map((source) => stripScheduleWrapper(source, cronText))
    .filter((source) => !isGenericTaskPrompt(source))
    .sort((a, b) => b.length - a.length);
  const prompt =
    directPromptCandidates[0] ??
    fallbackPromptCandidates[0] ??
    buildPromptFromNonScheduleSteps(intent) ??
    null;
  if (!prompt) return null;

  return {
    cron: cronText,
    prompt,
  };
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
  if (steps.length === 0 || !intent) return null;

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
  if (steps.length === 1 && mode === "single_llm") return null;

  return {
    mode,
    steps: executionSteps,
    requiredTools,
    completionCriteria: executionSteps.map((step) => step.completionCriteria),
  };
}

const ENFORCEABLE_STEP_TOOLS = new Set([
  "recall_memory",
  "task_add",
  "push_to_channel",
]);

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

function formatObservedResult(response: unknown): string {
  if (typeof response === "string") return response.slice(0, 240);
  try {
    return JSON.stringify(response).slice(0, 240);
  } catch {
    return String(response).slice(0, 240);
  }
}

export class IntentStepRuntime {
  readonly plan: IntentExecutionPlan | null;
  private entries: IntentStepRuntimeEntry[];
  private signatureToStepId = new Map<string, string>();
  private maxAttemptsPerStep: number;
  private readonly intent: IntentFrame | null;

  constructor(
    intent: IntentFrame | null,
    options?: { maxAttemptsPerStep?: number },
  ) {
    this.intent = intent;
    this.plan = buildIntentExecutionPlan(intent);
    this.entries =
      this.plan?.steps.map((step) => ({
        ...step,
        status:
          step.mode === "context" ||
          step.mode === "llm" ||
          step.mode === "agent" ||
          (step.requiredTool !== null &&
            !ENFORCEABLE_STEP_TOOLS.has(step.requiredTool))
            ? "succeeded"
            : step.mode === "confirm"
              ? "blocked"
              : "pending",
        attempts: 0,
        lastToolName: null,
        lastError: step.mode === "confirm" ? "confirmation required" : null,
        toolCalls: [],
        agentCalls: [],
        observedResults: [],
        seenSignatures: new Set<string>(),
      })) ?? [];
    this.maxAttemptsPerStep = options?.maxAttemptsPerStep ?? 2;
  }

  get active(): boolean {
    return this.entries.length > 0;
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

  private entryById(stepId: string): IntentStepRuntimeEntry | null {
    return this.entries.find((entry) => entry.step.id === stepId) ?? null;
  }

  private dependenciesSatisfied(entry: IntentStepRuntimeEntry): boolean {
    return entry.step.dependsOn.every(
      (stepId) => this.entryById(stepId)?.status === "succeeded",
    );
  }

  private dependencyBlockReason(entry: IntentStepRuntimeEntry): string | null {
    const waitingOn = entry.step.dependsOn.filter(
      (stepId) => this.entryById(stepId)?.status !== "succeeded",
    );
    return waitingOn.length > 0
      ? `waiting for dependent step(s): ${waitingOn.join(", ")}`
      : null;
  }

  actionableEnforceableSteps(): IntentStepRuntimeEntry[] {
    return this.entries.filter(
      (entry) =>
        (entry.status === "pending" || entry.status === "failed") &&
        entry.requiredTool !== null &&
        ENFORCEABLE_STEP_TOOLS.has(entry.requiredTool) &&
        this.dependenciesSatisfied(entry),
    );
  }

  private matchRequestToStep(
    request: ToolCallLike,
  ): IntentStepRuntimeEntry | null {
    const candidates = this.entries.filter(
      (entry) =>
        entry.requiredTool === request.name &&
        entry.status !== "blocked" &&
        entry.status !== "skipped",
    );
    if (candidates.length === 0) return null;

    return (
      candidates
        .map((entry) => ({
          entry,
          score: this.requestStepMatchScore(request, entry),
        }))
        .sort((a, b) => b.score - a.score)[0]?.entry ?? null
    );
  }

  private requestStepMatchScore(
    request: ToolCallLike,
    entry: IntentStepRuntimeEntry,
  ): number {
    if (request.name === "task_add") {
      const expected = buildTaskAddArgs(this.intent, entry.step);
      if (expected && stableJson(request.args ?? {}) === stableJson(expected)) {
        return 100;
      }
      const requestCron = normalizeText(String(request.args?.cron ?? ""));
      const requestPrompt = normalizeText(String(request.args?.prompt ?? ""));
      const stepSources = collectScheduleTextSources(null, entry.step);
      const stepCron = extractScheduleTimeText(stepSources);
      if (requestCron && stepCron && requestCron === stepCron) {
        const stepPromptMatched = stepSources
          .map((source) => stripScheduleWrapper(source, stepCron))
          .some(
            (source) =>
              source &&
              (source === requestPrompt ||
                source.includes(requestPrompt) ||
                requestPrompt.includes(source)),
          );
        return stepPromptMatched ? 95 : 80;
      }
    }
    if (request.name === "push_to_channel") {
      const channel = normalizeText(String(request.args?.channel ?? ""));
      const target = normalizeText(
        entry.step.operation.selector ||
          entry.step.operation.target ||
          entry.step.target,
      ).toLowerCase();
      if (channel && target && channel.toLowerCase() === target) return 100;
    }
    const argsText = JSON.stringify(request.args ?? {}).toLowerCase();
    const stepText = normalizeText(
      `${entry.step.action} ${entry.step.target} ${entry.step.operation.target}`,
    ).toLowerCase();
    if (stepText && argsText.includes(stepText)) return 50;
    return entry.status === "running" ? 10 : 0;
  }

  filterDuplicateToolCalls(requests: ToolCallLike[]): DuplicateToolDecision {
    const executableRequests: ToolCallLike[] = [];
    const duplicateResponses: FunctionResponseLike[] = [];
    const suppressed: Array<{
      request: ToolCallLike;
      stepId: string | null;
      reason?: string;
    }> = [];

    for (const request of requests) {
      const signature = toolSignature(request);
      const step = this.matchRequestToStep(request);
      if (step) {
        const dependencyReason = this.dependencyBlockReason(step);
        if (dependencyReason) {
          duplicateResponses.push({
            functionResponse: {
              name: request.name,
              response: {
                result:
                  `Tool call suppressed for ${step.step.id}: ${dependencyReason}. ` +
                  "Complete the dependency first, then retry this step.",
              },
            },
          });
          suppressed.push({
            request,
            stepId: step.step.id,
            reason: dependencyReason,
          });
          continue;
        }
      }
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
        suppressed.push({ request, stepId, reason: "duplicate" });
        continue;
      }
      if (step) {
        step.status = "running";
        step.lastToolName = request.name;
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
      step.toolCalls.push(request);
      step.seenSignatures.add(signature);
      if (response !== undefined) {
        step.observedResults.push(formatObservedResult(response));
      }

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
      const args = buildTaskAddArgs(this.intent, entry.step);
      if (!args) continue;
      requests.push({
        name: "task_add",
        callId: `intent-${entry.step.id}-task_add`,
        args,
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
