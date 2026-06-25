/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskGraph, TaskSpec } from "./taskGraph.js";
import type {
  TaskGraphExecutionResult,
  TaskGraphExecutorEvent,
  TaskRuntimeArtifact,
} from "./taskGraphExecutor.js";
import type { ReplanDecision } from "./taskGraphRecovery.js";
import type { TaskGraphExecutionSnapshot } from "./taskGraphState.js";

export type TaskGraphGoldenTrace = {
  schemaVersion: 1;
  taskSpec: {
    id: string;
    userGoal: string;
    taskKind: TaskSpec["taskKind"];
    acceptanceCriteria: string[];
    expectedArtifacts: string[];
  };
  taskGraph: {
    id: string;
    status: TaskGraph["status"];
    nodes: Array<{
      id: string;
      kind: string;
      requiredCapabilities: string[];
      acceptanceCriteria: string[];
    }>;
    edges: Array<{
      from: string;
      to: string;
      reason: string;
    }>;
  };
  execution: {
    status: TaskGraphExecutionResult["status"];
    nodes: Array<{
      id: string;
      status: string;
      attempts: number;
      validators: Array<{
        id: string;
        ok: boolean;
        reason: string;
      }>;
      artifacts: string[];
      lastError: string | null;
    }>;
    artifacts: Array<{
      id: string;
      nodeId: string;
      sourceNodeId?: string;
      type: TaskRuntimeArtifact["type"];
      path?: string;
      taskId?: string;
      checksum?: string;
    }>;
    finalResponseCanClaimSuccess: boolean;
  };
  events: Array<{
    type: TaskGraphExecutorEvent["type"];
    nodeId?: string;
    status?: string;
  }>;
  replanDecisions: Array<{
    action: ReplanDecision["action"];
    nodeId: string | null;
    reasonCode: string;
  }>;
  snapshot?: {
    id: string;
    status: TaskGraphExecutionSnapshot["status"];
    nodeCount: number;
    artifactCount: number;
    failureRootCause?: string;
  };
};

export type TaskGraphTraceHealth = {
  ok: boolean;
  violations: string[];
};

function eventNodeId(event: TaskGraphExecutorEvent): string | undefined {
  return "nodeId" in event ? event.nodeId : undefined;
}

function eventStatus(event: TaskGraphExecutorEvent): string | undefined {
  return "status" in event ? String(event.status) : undefined;
}

export function buildTaskGraphGoldenTrace(input: {
  taskSpec: TaskSpec;
  taskGraph: TaskGraph;
  execution: TaskGraphExecutionResult;
  events?: TaskGraphExecutorEvent[];
  replanDecisions?: ReplanDecision[];
  snapshot?: TaskGraphExecutionSnapshot;
}): TaskGraphGoldenTrace {
  return {
    schemaVersion: 1,
    taskSpec: {
      id: input.taskSpec.id,
      userGoal: input.taskSpec.userGoal,
      taskKind: input.taskSpec.taskKind,
      acceptanceCriteria: input.taskSpec.acceptanceCriteria.map(
        (criterion) => `${criterion.id}:${criterion.type}`,
      ),
      expectedArtifacts: input.taskSpec.expectedArtifacts.map(
        (artifact) => `${artifact.id}:${artifact.type}`,
      ),
    },
    taskGraph: {
      id: input.taskGraph.id,
      status: input.taskGraph.status,
      nodes: input.taskGraph.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        requiredCapabilities: [...node.requiredCapabilities],
        acceptanceCriteria: node.acceptanceCriteria.map(
          (criterion) => `${criterion.id}:${criterion.type}`,
        ),
      })),
      edges: input.taskGraph.edges.map((edge) => ({ ...edge })),
    },
    execution: {
      status: input.execution.status,
      nodes: input.execution.nodes.map((state) => ({
        id: state.node.id,
        status: state.status,
        attempts: state.attempts,
        validators: state.acceptanceResults.map((result) => ({
          id: result.criterionId,
          ok: result.ok,
          reason: result.reason,
        })),
        artifacts: state.artifacts.map((artifact) => artifact.id),
        lastError: state.lastError,
      })),
      artifacts: input.execution.artifacts.map((artifact) => ({
        id: artifact.id,
        nodeId: artifact.nodeId,
        sourceNodeId: artifact.sourceNodeId,
        type: artifact.type,
        path: artifact.path,
        taskId: artifact.taskId,
        checksum: artifact.checksum,
      })),
      finalResponseCanClaimSuccess:
        input.execution.finalResponseContract.canClaimSuccess,
    },
    events: (input.events ?? []).map((event) => ({
      type: event.type,
      nodeId: eventNodeId(event),
      status: eventStatus(event),
    })),
    replanDecisions: (input.replanDecisions ?? []).map((decision) => ({
      action: decision.action,
      nodeId: decision.nodeId,
      reasonCode: decision.reasonCode,
    })),
    snapshot: input.snapshot
      ? {
          id: input.snapshot.id,
          status: input.snapshot.status,
          nodeCount: input.snapshot.nodes.length,
          artifactCount: input.snapshot.artifacts.length,
          failureRootCause: input.snapshot.failureRootCause,
        }
      : undefined,
  };
}

export function validateTaskGraphGoldenTrace(
  trace: TaskGraphGoldenTrace,
): TaskGraphTraceHealth {
  const violations: string[] = [];
  if (trace.taskSpec.acceptanceCriteria.length === 0) {
    violations.push("trace_missing_task_spec_acceptance");
  }
  if (trace.taskGraph.nodes.length === 0) {
    violations.push("trace_missing_task_graph_nodes");
  }
  for (const node of trace.execution.nodes) {
    if (node.status === "succeeded" && node.validators.length === 0) {
      violations.push(`node_succeeded_without_validators:${node.id}`);
    }
    if (
      node.status === "succeeded" &&
      node.validators.some((validator) => !validator.ok)
    ) {
      violations.push(`node_succeeded_with_failed_validator:${node.id}`);
    }
  }
  if (
    trace.execution.finalResponseCanClaimSuccess &&
    trace.execution.nodes.some(
      (node) => node.status !== "succeeded" && node.status !== "skipped",
    )
  ) {
    violations.push("final_response_can_claim_success_with_incomplete_nodes");
  }
  const executedNodeIds = new Set(
    trace.events
      .filter((event) => event.type === "task_node_started")
      .map((event) => event.nodeId)
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
  );
  for (const node of trace.execution.nodes) {
    if (node.status === "succeeded" && !executedNodeIds.has(node.id)) {
      violations.push(`node_succeeded_without_start_event:${node.id}`);
    }
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function diffTaskGraphGoldenTrace(
  expected: TaskGraphGoldenTrace,
  actual: TaskGraphGoldenTrace,
): string {
  const differences: string[] = [];
  const expectedJson = JSON.stringify(expected, null, 2).split("\n");
  const actualJson = JSON.stringify(actual, null, 2).split("\n");
  const max = Math.max(expectedJson.length, actualJson.length);
  for (let index = 0; index < max; index += 1) {
    if (expectedJson[index] !== actualJson[index]) {
      differences.push(
        `line ${index + 1}\n- ${expectedJson[index] ?? ""}\n+ ${actualJson[index] ?? ""}`,
      );
    }
  }
  return differences.join("\n");
}
