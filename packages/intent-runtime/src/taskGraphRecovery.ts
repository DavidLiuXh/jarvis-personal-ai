/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskGraph, TaskNode } from "./taskGraph.js";
import type {
  TaskGraphExecutionResult,
  TaskGraphResumeState,
  TaskNodeExecutionState,
} from "./taskGraphExecutor.js";

export type ReplanAction =
  | "retry_same"
  | "retry_with_modified_args"
  | "switch_capability"
  | "ask_user"
  | "skip_optional"
  | "abort";

export type ReplanDecision = {
  action: ReplanAction;
  nodeId: string | null;
  reasonCode: string;
  reason: string;
  blocking: boolean;
  addedNode?: TaskNode;
  modifiedNode?: TaskNode;
};

export type ReplanDecisionInput = {
  result: TaskGraphExecutionResult;
  availableCapabilities?: string[];
  recoveryAttempts?: number;
  maxRecoveryAttempts?: number;
};

function reasonText(state: TaskNodeExecutionState): string {
  return [
    state.lastError,
    ...state.acceptanceResults
      .filter((item) => !item.ok && item.blocking)
      .map((item) => item.reason),
  ]
    .filter(Boolean)
    .join(" | ");
}

function canRetry(state: TaskNodeExecutionState): boolean {
  return state.attempts < state.node.retryPolicy.maxAttempts;
}

function hasCapability(
  availableCapabilities: string[] | undefined,
  capability: string,
): boolean {
  return !availableCapabilities || availableCapabilities.includes(capability);
}

function makeResearchRepairNode(sourceNode: TaskNode): TaskNode {
  const nodeId = `${sourceNode.id}-source-repair`;
  return {
    id: nodeId,
    title: `Repair source coverage for ${sourceNode.title}`,
    kind: "research",
    requiredCapabilities: ["web.search"],
    inputs: [],
    outputs: [
      {
        id: `${nodeId}-source`,
        type: "report",
        description: "Additional source evidence for failed coverage.",
        required: true,
      },
    ],
    acceptanceCriteria: [
      {
        id: `${nodeId}-source-count`,
        scope: "step",
        type: "source_count",
        description: "At least one source is available after repair search.",
        required: true,
        validator: "source_count_validator",
        params: { minSources: 1 },
      },
    ],
    retryPolicy: { maxAttempts: 2, strategy: "same" },
    optional: false,
  };
}

export function decideTaskGraphRecovery(
  input: ReplanDecisionInput,
): ReplanDecision {
  const { result } = input;
  const maxRecoveryAttempts = input.maxRecoveryAttempts ?? 2;
  if ((input.recoveryAttempts ?? 0) >= maxRecoveryAttempts) {
    return {
      action: "abort",
      nodeId: null,
      reasonCode: "recovery_attempts_exhausted",
      reason: `Recovery attempts reached limit ${maxRecoveryAttempts}.`,
      blocking: true,
    };
  }
  const failedOrBlocked = result.nodes.find(
    (state) =>
      !state.node.optional &&
      (state.status === "failed" || state.status === "blocked"),
  );
  if (!failedOrBlocked) {
    return {
      action: "abort",
      nodeId: null,
      reasonCode: "no_recoverable_failure",
      reason: "No failed or blocked required node was found.",
      blocking: false,
    };
  }

  const reason = reasonText(failedOrBlocked);
  const node = failedOrBlocked.node;
  if (
    /permission|denied|policy|forbidden|confirm|确认|权限|拒绝|拦截/i.test(
      reason,
    )
  ) {
    return {
      action: "ask_user",
      nodeId: node.id,
      reasonCode: "permission_or_policy_requires_user",
      reason,
      blocking: true,
    };
  }
  if (
    /schedule.*time|missing.*time|channel|缺少.*(?:时间|渠道)|通道/i.test(
      reason,
    )
  ) {
    return {
      action: "ask_user",
      nodeId: node.id,
      reasonCode: "missing_required_user_input",
      reason,
      blocking: true,
    };
  }
  if (
    node.kind === "write_file" &&
    /no existing file artifact|file artifact|file missing|文件/i.test(reason)
  ) {
    return {
      action: "retry_same",
      nodeId: node.id,
      reasonCode: "file_artifact_missing_retry",
      reason,
      blocking: false,
    };
  }
  if (
    /source count .*<|source coverage|source_count|证据|来源/i.test(reason) &&
    hasCapability(input.availableCapabilities, "web.search")
  ) {
    return {
      action: "switch_capability",
      nodeId: node.id,
      reasonCode: "source_coverage_add_search_node",
      reason,
      blocking: false,
      addedNode: makeResearchRepairNode(node),
    };
  }
  if (node.optional) {
    return {
      action: "skip_optional",
      nodeId: node.id,
      reasonCode: "optional_node_failed",
      reason,
      blocking: false,
    };
  }
  if (canRetry(failedOrBlocked)) {
    return {
      action: "retry_same",
      nodeId: node.id,
      reasonCode: "transient_failure_retry",
      reason,
      blocking: false,
    };
  }
  return {
    action: "abort",
    nodeId: node.id,
    reasonCode: "required_node_unrecoverable",
    reason,
    blocking: true,
  };
}

export function applyReplanDecision(
  graph: TaskGraph,
  decision: ReplanDecision,
): TaskGraph {
  if (decision.action !== "switch_capability" || !decision.addedNode) {
    return structuredClone(graph);
  }
  const graphClone = structuredClone(graph);
  if (!graphClone.nodes.some((node) => node.id === decision.addedNode?.id)) {
    graphClone.nodes.push(decision.addedNode);
  }
  if (decision.nodeId) {
    const target = graphClone.nodes.find((node) => node.id === decision.nodeId);
    if (target) {
      target.inputs.push({
        sourceNodeId: decision.addedNode.id,
        name: `${decision.addedNode.id}.output`,
        required: true,
      });
      graphClone.edges.push({
        from: decision.addedNode.id,
        to: target.id,
        reason: decision.reasonCode,
      });
    }
  }
  graphClone.status = "planned";
  return graphClone;
}

export function buildRecoveryResumeState(
  result: TaskGraphExecutionResult,
  decision: ReplanDecision,
): TaskGraphResumeState {
  const retryNodeId = decision.nodeId;
  return {
    nodes: result.nodes
      .filter((state) => state.status === "succeeded")
      .filter((state) => state.node.id !== retryNodeId)
      .map((state) => ({
        nodeId: state.node.id,
        status: state.status,
        attempts: state.attempts,
        output: state.output,
        artifacts: state.artifacts,
        acceptanceResults: state.acceptanceResults,
        lastError: state.lastError,
      })),
    artifacts: result.artifacts.filter(
      (artifact) => artifact.nodeId !== retryNodeId,
    ),
  };
}
