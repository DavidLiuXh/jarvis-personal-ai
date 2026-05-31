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
  buildIntentExecutionPlan,
  type IntentExecutionPlan,
  type IntentExecutionStep,
  type IntentStepRuntimeStatus,
} from "./executionPlan.js";

export type RuntimeToolRequest = {
  name: string;
  callId: string;
  args: Record<string, unknown>;
};

export type RuntimeToolResult = {
  name: string;
  callId: string;
  status: "success" | "failed" | "blocked";
  output: unknown;
};

export type ToolExecutorAdapter = {
  executeTools(
    requests: RuntimeToolRequest[],
    signal: AbortSignal,
  ): Promise<RuntimeToolResult[]>;
};

export type AgentExecutionRequest = {
  agent: string;
  prompt: string;
  step: IntentStep;
  metadata?: Record<string, unknown>;
};

export type AgentExecutionResult = {
  agent: string;
  status: "success" | "failed" | "blocked";
  output: unknown;
};

export type AgentExecutorAdapter = {
  executeAgent(
    request: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult>;
};

export type RuntimeCapabilityKind =
  | "scheduled_task"
  | "channel_push"
  | "memory_recall"
  | "workspace_file"
  | "shell_command"
  | "subagent"
  | "generic_tool";

export type RuntimeCapability = {
  id: string;
  kind: RuntimeCapabilityKind;
  tools: string[];
  canHandle(step: IntentExecutionStep, intent: IntentFrame): boolean;
  buildRequest?: (input: {
    intent: IntentFrame;
    step: IntentExecutionStep;
    context: IntentExecutorContext;
  }) => RuntimeToolRequest | null;
  validateResult?: (result: RuntimeToolResult) => RuntimeResultValidation;
};

export type RuntimeCapabilityRegistry = {
  list(): RuntimeCapability[];
  findForStep(
    step: IntentExecutionStep,
    intent: IntentFrame,
  ): RuntimeCapability | null;
  findByTool(toolName: string): RuntimeCapability | null;
};

export type RuntimeResultValidation = {
  ok: boolean;
  reason?: string;
};

export type ExecutionObserver = (
  event: IntentExecutorEvent,
) => void | Promise<void>;

export type IntentExecutorEvent =
  | {
      type: "execution_started";
      planMode: IntentExecutionPlan["mode"];
      steps: number;
    }
  | {
      type: "step_started";
      stepId: string;
      mode: IntentExecutionStep["mode"];
      requiredTool: string | null;
    }
  | {
      type: "tool_requested";
      stepId: string;
      request: RuntimeToolRequest;
    }
  | {
      type: "tool_result";
      stepId: string;
      result: RuntimeToolResult;
    }
  | {
      type: "agent_requested";
      stepId: string;
      request: AgentExecutionRequest;
    }
  | {
      type: "agent_result";
      stepId: string;
      result: AgentExecutionResult;
    }
  | {
      type: "step_finished";
      stepId: string;
      status: IntentStepRuntimeStatus;
      reason?: string;
    }
  | {
      type: "execution_finished";
      status: IntentExecutionStatus;
      blockedSteps: number;
      failedSteps: number;
    };

export type IntentExecutionStatus =
  | "not_required"
  | "succeeded"
  | "blocked"
  | "failed";

export type IntentExecutorContext = {
  userPrompt: string;
  currentContent?: string;
  artifacts?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type IntentExecutorOptions = {
  registry?: RuntimeCapabilityRegistry;
  observer?: ExecutionObserver;
  maxAttemptsPerStep?: number;
};

export type IntentExecutorInput = {
  intent: IntentFrame;
  plan?: IntentExecutionPlan | null;
  context: IntentExecutorContext;
  signal?: AbortSignal;
};

export type IntentExecutionStepState = {
  executionStep: IntentExecutionStep;
  status: IntentStepRuntimeStatus;
  attempts: number;
  lastError: string | null;
  toolRequests: RuntimeToolRequest[];
  toolResults: RuntimeToolResult[];
  agentResult: AgentExecutionResult | null;
};

export type IntentExecutionResult = {
  status: IntentExecutionStatus;
  plan: IntentExecutionPlan | null;
  steps: IntentExecutionStepState[];
  requiredTools: string[];
  completedTools: string[];
  blockedReasons: string[];
  finalResponseContract: FinalResponseContract;
};

export type FinalResponseContract = {
  canClaimSuccess: boolean;
  incompleteSteps: Array<{
    stepId: string;
    status: IntentStepRuntimeStatus;
    reason: string;
  }>;
  instruction: string;
};

class DefaultRuntimeCapabilityRegistry implements RuntimeCapabilityRegistry {
  constructor(private readonly capabilities: RuntimeCapability[]) {}

  list(): RuntimeCapability[] {
    return [...this.capabilities];
  }

  findForStep(
    step: IntentExecutionStep,
    intent: IntentFrame,
  ): RuntimeCapability | null {
    return (
      this.capabilities.find((capability) =>
        capability.canHandle(step, intent),
      ) ?? null
    );
  }

  findByTool(toolName: string): RuntimeCapability | null {
    return (
      this.capabilities.find((capability) =>
        capability.tools.includes(toolName),
      ) ?? null
    );
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function makeCallId(step: IntentExecutionStep, toolName: string): string {
  return `intent-${step.step.id}-${toolName}`;
}

function resultHasError(output: unknown): boolean {
  if (typeof output === "string") {
    return /(^|[^\w])(error|failed|denied|not available|requires|❌|失败|不可用)([^\w]|$)/i.test(
      output,
    );
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if ("error" in record || record.status === "error") return true;
    if (typeof record.result === "string") return resultHasError(record.result);
  }
  return false;
}

function defaultValidateResult(
  result: RuntimeToolResult,
): RuntimeResultValidation {
  if (result.status !== "success") {
    return { ok: false, reason: `${result.name} returned ${result.status}` };
  }
  if (resultHasError(result.output)) {
    return {
      ok: false,
      reason: `${result.name} output indicates failure`,
    };
  }
  return { ok: true };
}

const SCHEDULE_TIME_PATTERNS = [
  /(?:北京时间\s*)?(?:每\s*)?(?:周|星期)[一二三四五六日天](?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /(?:北京时间\s*)?(?:每天|每日|每\s*天|每\s*日)(?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /(?:今天|明天|后天|今晚|下周[一二三四五六日天]?|本周[一二三四五六日天]?)(?:\s*(?:早上|上午|中午|下午|晚上|傍晚|夜间|凌晨))?\s*\d{1,2}(?::\d{2})?\s*[点时]?/i,
  /\b(?:every\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b(?:daily|every day|weekdays)\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b\d{1,2}:\d{2}\b/,
];

function extractScheduleTime(text: string): string {
  for (const pattern of SCHEDULE_TIME_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) return normalizeText(match[0]);
  }
  return "";
}

function stripSchedulePrompt(text: string, cron: string): string {
  return normalizeText(
    text
      .replace(cron, " ")
      .replace(
        /^(?:请|帮我|麻烦)?(?:添加|创建|新增|设置|建立)?(?:一个|一条)?(?:定时任务|定时|任务|提醒|schedule|scheduled task)\s*[:：,，-]*/i,
        "",
      ),
  );
}

function buildTaskRequest(input: {
  intent: IntentFrame;
  step: IntentExecutionStep;
}): RuntimeToolRequest | null {
  const tool = input.step.requiredTool;
  if (!tool?.startsWith("task_")) return null;
  if (tool !== "task_add") {
    return {
      name: tool,
      callId: makeCallId(input.step, tool),
      args: {
        target:
          input.step.step.operation.selector ||
          input.step.step.operation.target ||
          input.step.step.target,
      },
    };
  }

  const source = normalizeText(
    [
      input.step.step.operation.selector,
      input.step.step.operation.target,
      input.step.step.target,
      input.step.step.action,
      input.intent.semanticEvidence.actionRequest.object,
      input.intent.richIntent.userGoal,
      ...input.intent.evidence,
    ].join(" "),
  );
  const cron = extractScheduleTime(source);
  const prompt = stripSchedulePrompt(source, cron);
  if (!cron || !prompt) return null;
  return {
    name: "task_add",
    callId: makeCallId(input.step, "task_add"),
    args: { cron, prompt },
  };
}

function deriveChannel(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes("wechat") ||
    lower.includes("weixin") ||
    text.includes("微信")
  ) {
    return "wechat";
  }
  if (
    lower.includes("feishu") ||
    lower.includes("lark") ||
    text.includes("飞书")
  ) {
    return "feishu";
  }
  return "";
}

function buildPushRequest(input: {
  step: IntentExecutionStep;
  context: IntentExecutorContext;
}): RuntimeToolRequest | null {
  const channel =
    deriveChannel(input.step.step.operation.target) ||
    deriveChannel(input.step.step.target) ||
    deriveChannel(input.context.userPrompt);
  const content =
    input.context.currentContent ??
    input.context.artifacts?.[input.step.step.id] ??
    "";
  if (!channel || !content.trim()) return null;
  return {
    name: "push_to_channel",
    callId: makeCallId(input.step, "push_to_channel"),
    args: { channel, content: content.trim(), chat_id: "" },
  };
}

function buildRecallRequest(input: {
  intent: IntentFrame;
  step: IntentExecutionStep;
  context: IntentExecutorContext;
}): RuntimeToolRequest {
  const query =
    normalizeText(input.step.step.operation.target) ||
    normalizeText(input.step.step.target) ||
    normalizeText(input.intent.richIntent.userGoal) ||
    input.context.userPrompt;
  return {
    name: "recall_memory",
    callId: makeCallId(input.step, "recall_memory"),
    args: {
      query,
      limit: 5,
      time_window_days: input.intent.timeWindowDays,
      date_from: input.intent.dateFrom,
      date_to: input.intent.dateTo,
    },
  };
}

export function createDefaultRuntimeCapabilityRegistry(): RuntimeCapabilityRegistry {
  return new DefaultRuntimeCapabilityRegistry([
    {
      id: "scheduled-task-tools",
      kind: "scheduled_task",
      tools: ["task_add", "task_update", "task_delete", "task_list"],
      canHandle: (step) =>
        step.requiredTool !== null && step.requiredTool.startsWith("task_"),
      buildRequest: ({ intent, step }) => buildTaskRequest({ intent, step }),
      validateResult: defaultValidateResult,
    },
    {
      id: "channel-push",
      kind: "channel_push",
      tools: ["push_to_channel"],
      canHandle: (step, intent) =>
        step.requiredTool === "push_to_channel" ||
        /push|send|wechat|feishu|微信|飞书/i.test(
          `${step.step.action} ${step.step.target} ${intent.richIntent.userGoal}`,
        ),
      buildRequest: ({ step, context }) => buildPushRequest({ step, context }),
      validateResult: defaultValidateResult,
    },
    {
      id: "memory-recall",
      kind: "memory_recall",
      tools: ["recall_memory"],
      canHandle: (step) =>
        step.requiredTool === "recall_memory" || step.step.type === "recall",
      buildRequest: ({ intent, step, context }) =>
        buildRecallRequest({ intent, step, context }),
      validateResult: defaultValidateResult,
    },
    {
      id: "workspace-file-tools",
      kind: "workspace_file",
      tools: [
        "read_file",
        "write_file",
        "replace",
        "grep_search",
        "list_directory",
      ],
      canHandle: (step, intent) =>
        step.requiredTool === "appropriate_workspace_or_task_tool" &&
        intent.richIntent.contextDependency.localWorkspace,
      validateResult: defaultValidateResult,
    },
    {
      id: "shell-command-tools",
      kind: "shell_command",
      tools: ["run_shell_command"],
      canHandle: (step) =>
        step.requiredTool === "run_shell_command" ||
        /shell|command|terminal|命令|终端/.test(
          `${step.step.action} ${step.step.target}`,
        ),
      validateResult: defaultValidateResult,
    },
    {
      id: "subagent-delegation",
      kind: "subagent",
      tools: ["generalist", "codebase_investigator"],
      canHandle: (step) =>
        step.mode === "agent" || step.step.type === "delegate",
      validateResult: defaultValidateResult,
    },
  ]);
}

function makeStepState(step: IntentExecutionStep): IntentExecutionStepState {
  return {
    executionStep: step,
    status: step.mode === "confirm" ? "blocked" : "pending",
    attempts: 0,
    lastError: step.mode === "confirm" ? "confirmation required" : null,
    toolRequests: [],
    toolResults: [],
    agentResult: null,
  };
}

function requestSignature(request: RuntimeToolRequest): string {
  return `${request.name}:${stableJson(request.args)}`;
}

export class IntentExecutor {
  private readonly registry: RuntimeCapabilityRegistry;
  private readonly observer?: ExecutionObserver;
  private readonly maxAttemptsPerStep: number;

  constructor(
    private readonly toolExecutor: ToolExecutorAdapter,
    private readonly agentExecutor?: AgentExecutorAdapter,
    options: IntentExecutorOptions = {},
  ) {
    this.registry =
      options.registry ?? createDefaultRuntimeCapabilityRegistry();
    this.observer = options.observer;
    this.maxAttemptsPerStep = options.maxAttemptsPerStep ?? 2;
  }

  async execute(input: IntentExecutorInput): Promise<IntentExecutionResult> {
    const plan = input.plan ?? buildIntentExecutionPlan(input.intent);
    if (!plan) {
      return {
        status: "not_required",
        plan: null,
        steps: [],
        requiredTools: [],
        completedTools: [],
        blockedReasons: [],
        finalResponseContract: {
          canClaimSuccess: true,
          incompleteSteps: [],
          instruction:
            "No runtime-enforced execution was required; final response may answer directly.",
        },
      };
    }

    const signal = input.signal ?? new AbortController().signal;
    const states = plan.steps.map(makeStepState);
    const seenSuccessfulRequests = new Set<string>();
    await this.emit({
      type: "execution_started",
      planMode: plan.mode,
      steps: states.length,
    });

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const state of states) {
        if (state.status !== "pending" && state.status !== "failed") continue;
        if (!this.dependenciesSatisfied(state, states)) continue;
        progressed = true;
        await this.executeStep(
          input.intent,
          state,
          states,
          input.context,
          signal,
          seenSuccessfulRequests,
        );
      }
    }

    for (const state of states) {
      if (
        (state.status === "pending" || state.status === "failed") &&
        !this.dependenciesSatisfied(state, states)
      ) {
        state.status = "blocked";
        state.lastError = this.dependencyBlockReason(state, states);
        await this.emitStepFinished(state);
      }
    }

    const result = this.buildResult(plan, states);
    await this.emit({
      type: "execution_finished",
      status: result.status,
      blockedSteps: states.filter((step) => step.status === "blocked").length,
      failedSteps: states.filter((step) => step.status === "failed").length,
    });
    return result;
  }

  validateFinalResponse(
    execution: IntentExecutionResult,
    finalResponse: string,
  ): RuntimeResultValidation {
    if (execution.finalResponseContract.canClaimSuccess) return { ok: true };
    const claimsSuccess =
      /(?:已|已经|成功|完成|done|completed|successfully)/i.test(
        finalResponse,
      ) &&
      !/(?:无法|未能|失败|blocked|failed|not completed|could not)/i.test(
        finalResponse,
      );
    if (!claimsSuccess) return { ok: true };
    return {
      ok: false,
      reason:
        "Final response claims success while runtime execution has incomplete tool-backed steps.",
    };
  }

  private async executeStep(
    intent: IntentFrame,
    state: IntentExecutionStepState,
    allStates: IntentExecutionStepState[],
    context: IntentExecutorContext,
    signal: AbortSignal,
    seenSuccessfulRequests: Set<string>,
  ): Promise<void> {
    const step = state.executionStep;
    await this.emit({
      type: "step_started",
      stepId: step.step.id,
      mode: step.mode,
      requiredTool: step.requiredTool,
    });

    if (step.mode === "context" || step.mode === "llm") {
      state.status = "succeeded";
      await this.emitStepFinished(state);
      return;
    }

    if (step.mode === "confirm") {
      state.status = "blocked";
      state.lastError = "confirmation required";
      await this.emitStepFinished(state);
      return;
    }

    if (step.mode === "agent") {
      await this.executeAgentStep(state, context, signal);
      return;
    }

    const capability = this.registry.findForStep(step, intent);
    if (!capability) {
      state.status = "blocked";
      state.lastError = `No runtime capability registered for step ${step.step.id}`;
      await this.emitStepFinished(state);
      return;
    }

    const request =
      capability.buildRequest?.({ intent, step, context }) ?? null;
    if (!request) {
      state.status = "blocked";
      state.lastError = `Capability ${capability.id} cannot build a deterministic request for ${step.step.id}`;
      await this.emitStepFinished(state);
      return;
    }

    const signature = requestSignature(request);
    if (seenSuccessfulRequests.has(signature)) {
      state.status = "succeeded";
      state.lastError = null;
      await this.emitStepFinished(state);
      return;
    }

    state.attempts += 1;
    state.toolRequests.push(request);
    await this.emit({ type: "tool_requested", stepId: step.step.id, request });
    const [result] = await this.toolExecutor.executeTools([request], signal);
    const effectiveResult =
      result ??
      ({
        name: request.name,
        callId: request.callId,
        status: "failed",
        output: "Tool executor returned no result.",
      } satisfies RuntimeToolResult);
    state.toolResults.push(effectiveResult);
    await this.emit({
      type: "tool_result",
      stepId: step.step.id,
      result: effectiveResult,
    });

    const validation =
      capability.validateResult?.(effectiveResult) ??
      defaultValidateResult(effectiveResult);
    if (validation.ok) {
      state.status = "succeeded";
      state.lastError = null;
      seenSuccessfulRequests.add(signature);
    } else {
      state.lastError = validation.reason ?? "tool result failed validation";
      state.status =
        state.attempts >= this.maxAttemptsPerStep ? "blocked" : "failed";
    }
    await this.emitStepFinished(state);

    if (
      state.status === "failed" &&
      this.dependenciesSatisfied(state, allStates)
    ) {
      // A retry-capable failed step remains in the queue for the next loop.
      return;
    }
  }

  private async executeAgentStep(
    state: IntentExecutionStepState,
    context: IntentExecutorContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.agentExecutor) {
      state.status = "blocked";
      state.lastError = "No AgentExecutorAdapter registered";
      await this.emitStepFinished(state);
      return;
    }
    const agent =
      state.executionStep.step.operation.target ||
      state.executionStep.step.target ||
      "generalist";
    const request: AgentExecutionRequest = {
      agent,
      prompt:
        `${context.userPrompt}\n\nStep: ${state.executionStep.step.action} ${state.executionStep.step.target}`.trim(),
      step: state.executionStep.step,
      metadata: context.metadata,
    };
    await this.emit({
      type: "agent_requested",
      stepId: state.executionStep.step.id,
      request,
    });
    const result = await this.agentExecutor.executeAgent(request, signal);
    state.agentResult = result;
    await this.emit({
      type: "agent_result",
      stepId: state.executionStep.step.id,
      result,
    });
    const validation = defaultValidateResult({
      name: result.agent,
      callId: `agent-${state.executionStep.step.id}`,
      status: result.status,
      output: result.output,
    });
    state.status = validation.ok ? "succeeded" : "blocked";
    state.lastError = validation.ok
      ? null
      : (validation.reason ?? "agent result failed validation");
    await this.emitStepFinished(state);
  }

  private dependenciesSatisfied(
    state: IntentExecutionStepState,
    allStates: IntentExecutionStepState[],
  ): boolean {
    return state.executionStep.step.dependsOn.every(
      (stepId) =>
        allStates.find(
          (candidate) => candidate.executionStep.step.id === stepId,
        )?.status === "succeeded",
    );
  }

  private dependencyBlockReason(
    state: IntentExecutionStepState,
    allStates: IntentExecutionStepState[],
  ): string {
    const waitingOn = state.executionStep.step.dependsOn.filter(
      (stepId) =>
        allStates.find(
          (candidate) => candidate.executionStep.step.id === stepId,
        )?.status !== "succeeded",
    );
    return `waiting for dependent step(s): ${waitingOn.join(", ")}`;
  }

  private buildResult(
    plan: IntentExecutionPlan,
    steps: IntentExecutionStepState[],
  ): IntentExecutionResult {
    const blockedReasons = steps
      .filter((step) => step.status === "blocked" || step.status === "failed")
      .map(
        (step) =>
          `${step.executionStep.step.id}: ${step.lastError ?? step.status}`,
      );
    const completedTools = Array.from(
      new Set(
        steps.flatMap((step) =>
          step.toolResults
            .filter((result) => result.status === "success")
            .map((result) => result.name),
        ),
      ),
    );
    const status: IntentExecutionStatus = steps.some(
      (step) => step.status === "failed",
    )
      ? "failed"
      : steps.some((step) => step.status === "blocked")
        ? "blocked"
        : "succeeded";

    return {
      status,
      plan,
      steps,
      requiredTools: plan.requiredTools,
      completedTools,
      blockedReasons,
      finalResponseContract: buildFinalResponseContract(steps),
    };
  }

  private async emit(event: IntentExecutorEvent): Promise<void> {
    await this.observer?.(event);
  }

  private async emitStepFinished(
    state: IntentExecutionStepState,
  ): Promise<void> {
    await this.emit({
      type: "step_finished",
      stepId: state.executionStep.step.id,
      status: state.status,
      reason: state.lastError ?? undefined,
    });
  }
}

export function buildFinalResponseContract(
  steps: IntentExecutionStepState[],
): FinalResponseContract {
  const incompleteSteps = steps
    .filter(
      (step) =>
        step.status === "pending" ||
        step.status === "running" ||
        step.status === "failed" ||
        step.status === "blocked",
    )
    .map((step) => ({
      stepId: step.executionStep.step.id,
      status: step.status,
      reason: step.lastError ?? step.executionStep.completionCriteria,
    }));

  return {
    canClaimSuccess: incompleteSteps.length === 0,
    incompleteSteps,
    instruction:
      incompleteSteps.length === 0
        ? "All runtime-enforced steps succeeded. The final response may claim completion."
        : "Do not claim completion. Explain the concrete blocker or failed step, and ask for only the missing information/action needed to continue.",
  };
}
