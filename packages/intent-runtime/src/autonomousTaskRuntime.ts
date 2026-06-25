/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentFrame } from "@jarvis/memory-runtime";
import { buildTaskGraph, buildTaskSpec, type TaskGraph } from "./taskGraph.js";
import {
  buildRecoveryResumeState,
  applyReplanDecision,
  decideTaskGraphRecovery,
  type ReplanDecision,
} from "./taskGraphRecovery.js";
import {
  TaskGraphExecutor,
  type TaskGraphCapabilityRegistry,
  type TaskGraphExecutionObserver,
  type TaskGraphExecutionResult,
  type TaskGraphExecutorContext,
  type TaskGraphExecutorEvent,
} from "./taskGraphExecutor.js";
import {
  InMemoryTaskGraphExecutionStore,
  resumeStateFromSnapshot,
  snapshotTaskGraphExecution,
  type TaskGraphExecutionSnapshot,
  type TaskGraphExecutionStore,
} from "./taskGraphState.js";

export type AutonomousTaskRuntimeInput = {
  intent: IntentFrame;
  graph?: TaskGraph;
  context: Omit<TaskGraphExecutorContext, "resumeState">;
  snapshotId?: string;
  /** Execute from a clean state even when a durable snapshot already exists. */
  disableResume?: boolean;
  signal?: AbortSignal;
};

export type AutonomousTaskRuntimeResult = {
  status: TaskGraphExecutionResult["status"];
  graph: TaskGraph;
  execution: TaskGraphExecutionResult;
  snapshot: TaskGraphExecutionSnapshot;
  replanDecisions: ReplanDecision[];
};

export type AutonomousTaskRuntimeOptions = {
  store?: TaskGraphExecutionStore;
  observer?: TaskGraphExecutionObserver;
  maxRecoveryAttempts?: number;
  availableCapabilities?: string[];
};

export class AutonomousTaskRuntime {
  private readonly store: TaskGraphExecutionStore;
  private readonly observer?: TaskGraphExecutionObserver;
  private readonly maxRecoveryAttempts: number;
  private readonly availableCapabilities?: string[];

  constructor(
    private readonly registry: TaskGraphCapabilityRegistry,
    options: AutonomousTaskRuntimeOptions = {},
  ) {
    this.store = options.store ?? new InMemoryTaskGraphExecutionStore();
    this.observer = options.observer;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 2;
    this.availableCapabilities = options.availableCapabilities;
  }

  async run(
    input: AutonomousTaskRuntimeInput,
  ): Promise<AutonomousTaskRuntimeResult> {
    let graph =
      input.graph ??
      buildTaskGraph(input.intent, buildTaskSpec(input.intent), {
        availableCapabilities: this.availableCapabilities,
      });
    let previousSnapshot = input.disableResume
      ? null
      : input.snapshotId
        ? await this.store.load(input.snapshotId)
        : await this.store.load(graph.id);
    const replanDecisions: ReplanDecision[] = [];
    let lastExecution: TaskGraphExecutionResult | null = null;
    let lastSnapshot: TaskGraphExecutionSnapshot | null = null;

    for (let recoveryAttempt = 0; ; recoveryAttempt += 1) {
      const events: TaskGraphExecutorEvent[] = [];
      const executor = new TaskGraphExecutor(this.registry, {
        observer: async (event) => {
          events.push(event);
          await this.observer?.(event);
        },
      });
      const execution = await executor.execute(
        graph,
        {
          ...input.context,
          resumeState: previousSnapshot
            ? resumeStateFromSnapshot(previousSnapshot)
            : undefined,
        },
        input.signal,
      );
      const snapshot = snapshotTaskGraphExecution(execution, {
        id: previousSnapshot?.id ?? graph.id,
        previous: previousSnapshot,
        events,
        metadata: { recoveryAttempt },
      });
      await this.store.save(snapshot);
      lastExecution = execution;
      lastSnapshot = snapshot;
      if (execution.status === "succeeded") {
        return {
          status: execution.status,
          graph,
          execution,
          snapshot,
          replanDecisions,
        };
      }

      const decision = decideTaskGraphRecovery({
        result: execution,
        availableCapabilities: this.availableCapabilities,
        recoveryAttempts: recoveryAttempt,
        maxRecoveryAttempts: this.maxRecoveryAttempts,
      });
      replanDecisions.push(decision);
      if (
        decision.action === "abort" ||
        decision.action === "ask_user" ||
        decision.action === "skip_optional"
      ) {
        return {
          status: execution.status,
          graph,
          execution,
          snapshot,
          replanDecisions,
        };
      }
      graph = applyReplanDecision(graph, decision);
      previousSnapshot = {
        ...snapshot,
        graph,
        nodes: buildRecoveryResumeState(execution, decision).nodes,
        artifacts: buildRecoveryResumeState(execution, decision).artifacts,
      };
    }

    return {
      status: lastExecution?.status ?? "blocked",
      graph,
      execution: lastExecution!,
      snapshot: lastSnapshot!,
      replanDecisions,
    };
  }
}
