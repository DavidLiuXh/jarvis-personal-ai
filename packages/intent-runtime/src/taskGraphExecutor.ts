/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AcceptanceCriteria,
  TaskArtifactSpec,
  TaskGraph,
  TaskGraphStatus,
  TaskNode,
} from "./taskGraph.js";
import { validateTaskGraph } from "./taskGraph.js";

export type TaskGraphExecutionStatus = "succeeded" | "failed" | "blocked";

export type TaskNodeExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped";

export type TaskRuntimeArtifact = {
  id: string;
  nodeId: string;
  sourceNodeId?: string;
  type: TaskArtifactSpec["type"] | "source";
  description?: string;
  path?: string;
  content?: string;
  taskId?: string;
  memoryItems?: unknown[];
  exists?: boolean;
  createdAt?: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
};

export type TaskNodeExecutionRequest = {
  graph: TaskGraph;
  node: TaskNode;
  attempt: number;
  dependencyOutputs: Record<string, unknown>;
  artifacts: TaskRuntimeArtifact[];
  context: TaskGraphExecutorContext;
};

export type TaskNodeExecutionResult = {
  status: Exclude<TaskNodeExecutionStatus, "pending" | "running" | "skipped">;
  output?: unknown;
  artifacts?: TaskRuntimeArtifact[];
  error?: string;
  metadata?: Record<string, unknown>;
};

export type TaskGraphCapabilityAdapter = {
  id: string;
  capabilities: string[];
  execute(
    request: TaskNodeExecutionRequest,
    signal: AbortSignal,
  ): Promise<TaskNodeExecutionResult>;
};

export type TaskGraphCapabilityRegistry = {
  list(): TaskGraphCapabilityAdapter[];
  findForNode(node: TaskNode): TaskGraphCapabilityAdapter | null;
};

export type TaskGraphExecutorContext = {
  userPrompt: string;
  finalResponse?: string;
  currentContent?: string;
  artifacts?: Record<string, string>;
  userConfirmed?: boolean;
  confirmations?: string[];
  resumeState?: TaskGraphResumeState;
  metadata?: Record<string, unknown>;
};

export type TaskGraphResumeState = {
  nodes: Array<
    Pick<
      TaskNodeExecutionState,
      | "status"
      | "attempts"
      | "output"
      | "artifacts"
      | "acceptanceResults"
      | "lastError"
    > & {
      nodeId: string;
    }
  >;
  artifacts: TaskRuntimeArtifact[];
};

export type AcceptanceValidationResult = {
  criterionId: string;
  ok: boolean;
  blocking: boolean;
  reason: string;
};

export type TaskNodeExecutionState = {
  node: TaskNode;
  status: TaskNodeExecutionStatus;
  attempts: number;
  output: unknown;
  artifacts: TaskRuntimeArtifact[];
  acceptanceResults: AcceptanceValidationResult[];
  lastError: string | null;
};

export type TaskFinalResponseContract = {
  canClaimSuccess: boolean;
  incompleteNodes: Array<{
    nodeId: string;
    status: TaskNodeExecutionStatus;
    reason: string;
  }>;
  instruction: string;
};

export type TaskGraphExecutionResult = {
  status: TaskGraphExecutionStatus;
  graph: TaskGraph;
  nodes: TaskNodeExecutionState[];
  artifacts: TaskRuntimeArtifact[];
  blockedReasons: string[];
  failedReasons: string[];
  finalResponseContract: TaskFinalResponseContract;
};

export type TaskGraphExecutorEvent =
  | {
      type: "task_graph_started";
      graphId: string;
      nodes: number;
    }
  | {
      type: "task_node_started";
      graphId: string;
      nodeId: string;
      kind: TaskNode["kind"];
      attempt: number;
    }
  | {
      type: "task_node_result";
      graphId: string;
      nodeId: string;
      status: TaskNodeExecutionResult["status"];
      artifactCount: number;
    }
  | {
      type: "task_node_acceptance";
      graphId: string;
      nodeId: string;
      results: AcceptanceValidationResult[];
    }
  | {
      type: "task_node_finished";
      graphId: string;
      nodeId: string;
      status: TaskNodeExecutionStatus;
      reason?: string;
    }
  | {
      type: "task_graph_finished";
      graphId: string;
      status: TaskGraphExecutionStatus;
      blocked: number;
      failed: number;
    };

export type TaskGraphExecutionObserver = (
  event: TaskGraphExecutorEvent,
) => void | Promise<void>;

export type TaskGraphExecutorOptions = {
  observer?: TaskGraphExecutionObserver;
};

export class DefaultTaskGraphCapabilityRegistry
  implements TaskGraphCapabilityRegistry
{
  constructor(private readonly adapters: TaskGraphCapabilityAdapter[]) {}

  list(): TaskGraphCapabilityAdapter[] {
    return [...this.adapters];
  }

  findForNode(node: TaskNode): TaskGraphCapabilityAdapter | null {
    return (
      this.adapters.find((adapter) =>
        node.requiredCapabilities.every((capability) =>
          adapter.capabilities.includes(capability),
        ),
      ) ?? null
    );
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function outputIndicatesFailure(output: unknown): boolean {
  const text = stringifyOutput(output);
  if (!text) return false;
  return /(^|[^\w])(error|failed|denied|blocked|not available|requires|❌|失败|不可用|被拒绝)([^\w]|$)/i.test(
    text,
  );
}

function checksumText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeArtifact(
  artifact: TaskRuntimeArtifact,
  nodeId: string,
): TaskRuntimeArtifact {
  const sourceNodeId = artifact.sourceNodeId ?? artifact.nodeId ?? nodeId;
  return {
    ...artifact,
    nodeId: artifact.nodeId || nodeId,
    sourceNodeId,
    createdAt: artifact.createdAt ?? new Date().toISOString(),
    checksum:
      artifact.checksum ??
      (artifact.content !== undefined
        ? checksumText(artifact.content)
        : undefined),
  };
}

function getOutputRecord(output: unknown): Record<string, unknown> | null {
  return output && typeof output === "object" && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : null;
}

function getNumberParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

function getStringListParam(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" && value.trim() ? [value] : [];
}

function countSources(
  artifacts: TaskRuntimeArtifact[],
  output: unknown,
): number {
  const artifactSources = artifacts.reduce((count, artifact) => {
    if (artifact.type === "source") return count + 1;
    const metadataSources = artifact.metadata?.sources;
    return (
      count + (Array.isArray(metadataSources) ? metadataSources.length : 0)
    );
  }, 0);
  const record = getOutputRecord(output);
  const outputSources = Array.isArray(record?.sources)
    ? record.sources.length
    : 0;
  return artifactSources + outputSources;
}

export function validateAcceptanceCriterion(
  criterion: AcceptanceCriteria,
  input: {
    node?: TaskNode;
    result?: TaskNodeExecutionResult;
    artifacts: TaskRuntimeArtifact[];
    allArtifacts?: TaskRuntimeArtifact[];
    context: TaskGraphExecutorContext;
  },
): AcceptanceValidationResult {
  const artifacts = input.allArtifacts ?? input.artifacts;
  const output = input.result?.output;
  const outputRecord = getOutputRecord(output);
  let ok = false;
  let reason = "criterion did not pass";

  switch (criterion.type) {
    case "tool_result": {
      ok =
        input.result?.status === "succeeded" && !outputIndicatesFailure(output);
      reason = ok
        ? "tool result succeeded"
        : "tool result failed or indicated failure";
      break;
    }
    case "file_exists": {
      const fileArtifacts = artifacts.filter(
        (artifact) => artifact.type === "file",
      );
      ok = fileArtifacts.some(
        (artifact) => Boolean(artifact.path) && artifact.exists !== false,
      );
      reason = ok
        ? "file artifact exists"
        : "no existing file artifact was observed";
      break;
    }
    case "file_contains": {
      const expected = getStringListParam(criterion.params, "contains");
      const fileContents = artifacts
        .filter((artifact) => artifact.type === "file")
        .map((artifact) => artifact.content ?? "")
        .join("\n");
      ok =
        fileContents.length > 0 &&
        (expected.length === 0 ||
          expected.every((item) => fileContents.includes(item)));
      reason = ok
        ? "file artifact contains expected content"
        : "file artifact does not contain expected content";
      break;
    }
    case "response_contains": {
      const expected = [
        ...getStringListParam(criterion.params, "contains"),
        getStringParam(criterion.params, "goal"),
      ].filter(Boolean);
      const response = input.context.finalResponse ?? stringifyOutput(output);
      ok =
        response.trim().length > 0 &&
        (expected.length === 0 ||
          expected.some((item) => response.includes(item)));
      reason = ok
        ? "response contains required content"
        : "response content is missing or insufficient";
      break;
    }
    case "source_count": {
      const minSources = getNumberParam(criterion.params, "minSources", 1);
      const sourceCount = countSources(artifacts, output);
      ok = sourceCount >= minSources;
      reason = ok
        ? `source count ${sourceCount} >= ${minSources}`
        : `source count ${sourceCount} < ${minSources}`;
      break;
    }
    case "memory_retrieved": {
      const memoryArtifacts = artifacts.filter(
        (artifact) => artifact.type === "memory",
      );
      ok =
        memoryArtifacts.some((artifact) =>
          Array.isArray(artifact.memoryItems)
            ? artifact.memoryItems.length > 0
            : Boolean(artifact.content),
        ) ||
        outputRecord?.empty === true ||
        outputRecord?.noMemory === true;
      reason = ok
        ? "memory evidence or explicit empty-memory result observed"
        : "no memory retrieval evidence observed";
      break;
    }
    case "task_scheduled": {
      const scheduledArtifacts = artifacts.filter(
        (artifact) => artifact.type === "scheduled_task",
      );
      ok =
        scheduledArtifacts.some((artifact) => Boolean(artifact.taskId)) ||
        typeof outputRecord?.taskId === "string" ||
        typeof outputRecord?.id === "string";
      reason = ok
        ? "scheduled task id observed"
        : "no scheduled task id observed";
      break;
    }
    case "user_confirmed": {
      ok =
        input.context.userConfirmed === true ||
        (input.context.confirmations ?? []).includes(criterion.id);
      reason = ok ? "user confirmation observed" : "user confirmation missing";
      break;
    }
    case "custom": {
      ok = criterion.params.ok === true;
      reason = ok
        ? "custom criterion explicitly passed"
        : "custom criterion has no registered validator";
      break;
    }
  }

  return {
    criterionId: criterion.id,
    ok,
    blocking: criterion.required,
    reason,
  };
}

function makeInitialState(
  node: TaskNode,
  resumeState?: TaskGraphResumeState,
): TaskNodeExecutionState {
  const persisted = resumeState?.nodes.find((item) => item.nodeId === node.id);
  if (persisted?.status === "succeeded") {
    return {
      node,
      status: "succeeded",
      attempts: persisted.attempts,
      output: persisted.output,
      artifacts: persisted.artifacts,
      acceptanceResults: persisted.acceptanceResults,
      lastError: null,
    };
  }
  return {
    node,
    status: "pending",
    attempts: persisted?.attempts ?? 0,
    output: null,
    artifacts: [],
    acceptanceResults: [],
    lastError: node.blockedReason ?? null,
  };
}

function dependenciesFor(node: TaskNode): string[] {
  return node.inputs
    .filter((input) => input.required && input.sourceNodeId)
    .map((input) => input.sourceNodeId as string);
}

function dependenciesSucceeded(
  state: TaskNodeExecutionState,
  allStates: TaskNodeExecutionState[],
): boolean {
  const dependencies = dependenciesFor(state.node);
  return dependencies.every(
    (nodeId) =>
      allStates.find((candidate) => candidate.node.id === nodeId)?.status ===
      "succeeded",
  );
}

function dependencyBlockReason(
  state: TaskNodeExecutionState,
  allStates: TaskNodeExecutionState[],
): string {
  const waiting = dependenciesFor(state.node).filter(
    (nodeId) =>
      allStates.find((candidate) => candidate.node.id === nodeId)?.status !==
      "succeeded",
  );
  return `waiting for dependent node(s): ${waiting.join(", ")}`;
}

function collectDependencyOutputs(
  state: TaskNodeExecutionState,
  allStates: TaskNodeExecutionState[],
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const nodeId of dependenciesFor(state.node)) {
    const dependency = allStates.find(
      (candidate) => candidate.node.id === nodeId,
    );
    if (dependency) outputs[nodeId] = dependency.output;
  }
  return outputs;
}

function buildFinalResponseContract(
  states: TaskNodeExecutionState[],
): TaskFinalResponseContract {
  const incompleteNodes = states
    .filter(
      (state) =>
        !state.node.optional &&
        (state.status === "pending" ||
          state.status === "running" ||
          state.status === "failed" ||
          state.status === "blocked"),
    )
    .map((state) => ({
      nodeId: state.node.id,
      status: state.status,
      reason: state.lastError ?? "node incomplete",
    }));
  return {
    canClaimSuccess: incompleteNodes.length === 0,
    incompleteNodes,
    instruction:
      incompleteNodes.length === 0
        ? "All required task graph nodes passed acceptance. The final response may claim completion."
        : "Do not claim completion. Report the incomplete node, concrete blocker, and the smallest next action needed.",
  };
}

function graphStatusFromStates(
  states: TaskNodeExecutionState[],
): TaskGraphExecutionStatus {
  const required = states.filter((state) => !state.node.optional);
  if (required.some((state) => state.status === "failed")) return "failed";
  if (
    required.some(
      (state) => state.status === "blocked" || state.status === "pending",
    )
  ) {
    return "blocked";
  }
  return "succeeded";
}

function runtimeGraphStatus(status: TaskGraphExecutionStatus): TaskGraphStatus {
  return status;
}

export class TaskGraphExecutor {
  private readonly observer?: TaskGraphExecutionObserver;

  constructor(
    private readonly registry: TaskGraphCapabilityRegistry,
    options: TaskGraphExecutorOptions = {},
  ) {
    this.observer = options.observer;
  }

  async execute(
    graph: TaskGraph,
    context: TaskGraphExecutorContext,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TaskGraphExecutionResult> {
    const states = graph.nodes.map((node) =>
      makeInitialState(node, context.resumeState),
    );
    const artifacts: TaskRuntimeArtifact[] = [
      ...(context.resumeState?.artifacts ?? []),
    ];
    await this.emit({
      type: "task_graph_started",
      graphId: graph.id,
      nodes: graph.nodes.length,
    });

    const graphGateFailures = validateTaskGraph(graph).filter(
      (gate) =>
        !gate.ok &&
        gate.blocking &&
        gate.code !== "task_graph_capabilities_available",
    );
    if (graphGateFailures.length > 0) {
      for (const state of states) {
        state.status = "blocked";
        state.lastError = graphGateFailures
          .map((gate) => `${gate.code}: ${gate.message}`)
          .join("; ");
      }
      return this.finish(graph, states, artifacts);
    }

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const state of states) {
        if (state.status !== "pending") continue;
        if (state.node.blockedReason) {
          progressed = true;
          state.status = "blocked";
          state.lastError = state.node.blockedReason;
          await this.emitNodeFinished(graph.id, state);
          continue;
        }
        if (!dependenciesSucceeded(state, states)) continue;
        progressed = true;
        await this.executeNode(
          graph,
          state,
          states,
          artifacts,
          context,
          signal,
        );
      }
    }

    for (const state of states) {
      if (state.status === "pending" && !dependenciesSucceeded(state, states)) {
        state.status = "blocked";
        state.lastError = dependencyBlockReason(state, states);
        await this.emitNodeFinished(graph.id, state);
      }
    }

    return this.finish(graph, states, artifacts);
  }

  validateFinalResponse(
    execution: TaskGraphExecutionResult,
    finalResponse: string,
  ): AcceptanceValidationResult {
    if (execution.finalResponseContract.canClaimSuccess) {
      return {
        criterionId: "final_response_contract",
        ok: true,
        blocking: true,
        reason: "all required nodes completed",
      };
    }
    const claimsSuccess =
      /(?:已|已经|成功|完成|done|completed|successfully)/i.test(
        finalResponse,
      ) &&
      !/(?:无法|未能|失败|blocked|failed|not completed|could not)/i.test(
        finalResponse,
      );
    return {
      criterionId: "final_response_contract",
      ok: !claimsSuccess,
      blocking: true,
      reason: claimsSuccess
        ? "final response claims success while task graph has incomplete required nodes"
        : "final response does not overclaim completion",
    };
  }

  private async executeNode(
    graph: TaskGraph,
    state: TaskNodeExecutionState,
    allStates: TaskNodeExecutionState[],
    artifacts: TaskRuntimeArtifact[],
    context: TaskGraphExecutorContext,
    signal: AbortSignal,
  ): Promise<void> {
    const adapter = this.registry.findForNode(state.node);
    if (!adapter) {
      state.status = "blocked";
      state.lastError = `No capability adapter registered for ${state.node.requiredCapabilities.join(",")}`;
      await this.emitNodeFinished(graph.id, state);
      return;
    }

    state.status = "running";
    state.attempts += 1;
    await this.emit({
      type: "task_node_started",
      graphId: graph.id,
      nodeId: state.node.id,
      kind: state.node.kind,
      attempt: state.attempts,
    });

    const result = await adapter.execute(
      {
        graph,
        node: state.node,
        attempt: state.attempts,
        dependencyOutputs: collectDependencyOutputs(state, allStates),
        artifacts,
        context,
      },
      signal,
    );
    state.output = result.output ?? null;
    const nodeArtifacts = (result.artifacts ?? []).map((artifact) =>
      normalizeArtifact(artifact, state.node.id),
    );
    state.artifacts.push(...nodeArtifacts);
    artifacts.push(...nodeArtifacts);
    await this.emit({
      type: "task_node_result",
      graphId: graph.id,
      nodeId: state.node.id,
      status: result.status,
      artifactCount: nodeArtifacts.length,
    });

    const acceptanceResults = state.node.acceptanceCriteria.map((criterion) =>
      validateAcceptanceCriterion(criterion, {
        node: state.node,
        result,
        artifacts: nodeArtifacts,
        allArtifacts: artifacts,
        context,
      }),
    );
    state.acceptanceResults = acceptanceResults;
    await this.emit({
      type: "task_node_acceptance",
      graphId: graph.id,
      nodeId: state.node.id,
      results: acceptanceResults,
    });

    const failedAcceptance = acceptanceResults.find(
      (item) => !item.ok && item.blocking,
    );
    if (result.status === "succeeded" && !failedAcceptance) {
      state.status = "succeeded";
      state.lastError = null;
    } else if (result.status === "blocked") {
      state.status = "blocked";
      state.lastError = result.error ?? "node execution blocked";
    } else {
      const reason =
        result.error ?? failedAcceptance?.reason ?? "node execution failed";
      if (state.attempts < state.node.retryPolicy.maxAttempts) {
        state.status = "pending";
        state.lastError = reason;
      } else {
        state.status = "failed";
        state.lastError = reason;
      }
    }
    await this.emitNodeFinished(graph.id, state);
  }

  private async finish(
    graph: TaskGraph,
    states: TaskNodeExecutionState[],
    artifacts: TaskRuntimeArtifact[],
  ): Promise<TaskGraphExecutionResult> {
    const status = graphStatusFromStates(states);
    graph.status = runtimeGraphStatus(status);
    const blockedReasons = states
      .filter((state) => state.status === "blocked")
      .map((state) => `${state.node.id}: ${state.lastError ?? "blocked"}`);
    const failedReasons = states
      .filter((state) => state.status === "failed")
      .map((state) => `${state.node.id}: ${state.lastError ?? "failed"}`);
    const result = {
      status,
      graph,
      nodes: states,
      artifacts,
      blockedReasons,
      failedReasons,
      finalResponseContract: buildFinalResponseContract(states),
    } satisfies TaskGraphExecutionResult;
    await this.emit({
      type: "task_graph_finished",
      graphId: graph.id,
      status,
      blocked: blockedReasons.length,
      failed: failedReasons.length,
    });
    return result;
  }

  private async emitNodeFinished(
    graphId: string,
    state: TaskNodeExecutionState,
  ): Promise<void> {
    await this.emit({
      type: "task_node_finished",
      graphId,
      nodeId: state.node.id,
      status: state.status,
      reason: state.lastError ?? undefined,
    });
  }

  private async emit(event: TaskGraphExecutorEvent): Promise<void> {
    await this.observer?.(event);
  }
}
