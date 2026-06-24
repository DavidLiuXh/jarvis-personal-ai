/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import { buildTaskGraph } from "./taskGraph.js";
import {
  DefaultTaskGraphCapabilityRegistry,
  TaskGraphExecutor,
  type TaskGraphCapabilityAdapter,
  type TaskNodeExecutionRequest,
  type TaskNodeExecutionResult,
} from "./taskGraphExecutor.js";
import {
  InMemoryTaskGraphExecutionStore,
  JsonFileTaskGraphExecutionStore,
  TaskArtifactRegistry,
  resumeStateFromSnapshot,
  snapshotTaskGraphExecution,
} from "./taskGraphState.js";

function makeStep(overrides: Partial<IntentStep>): IntentStep {
  return {
    id: "step-1",
    type: "chat",
    action: "answer",
    target: "question",
    operation: {
      domain: "general_chat",
      action: "answer",
      targetType: "current_context",
      target: "question",
      riskLevel: "low",
    },
    dependsOn: [],
    requiresConfirmation: false,
    riskLevel: "low",
    ...overrides,
  };
}

function intentWithTwoSteps(): IntentFrame {
  const recall = makeStep({
    id: "step-1",
    type: "recall",
    action: "recall",
    target: "previous discussion",
    operation: {
      domain: "memory_management",
      action: "recall",
      targetType: "memory",
      target: "previous discussion",
      riskLevel: "low",
    },
  });
  const write = makeStep({
    id: "step-2",
    type: "execute",
    action: "write",
    target: "summary.md",
    operation: {
      domain: "code_modification",
      action: "create",
      targetType: "file",
      target: "summary.md",
      riskLevel: "low",
    },
    dependsOn: ["step-1"],
  });
  return {
    subject: "personal",
    taskType: "execute",
    needsMemory: true,
    needsExternalKnowledge: false,
    needsTool: true,
    needsScheduling: false,
    candidateAgents: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    topicShifted: false,
    referencesRecentHistory: false,
    complexityScore: 60,
    knowledgeScore: 40,
    operationScore: 70,
    reason: "Recall previous discussion and write summary.md",
    confidence: 0.95,
    confidenceByDimension: {
      subject: 0.95,
      taskType: 0.95,
      memoryTarget: 0.95,
      action: 0.95,
      entityHints: 0.95,
      topicShift: 0.95,
      richIntent: 0.95,
    },
    evidence: [],
    semanticEvidence: {
      personalContext: { present: true, reason: "personal", span: "" },
      memoryRecall: {
        present: true,
        target: "conversation_history",
        reason: "Needs conversation history.",
        span: "",
      },
      actionRequest: { present: true, action: "write", object: "summary.md" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: "Recall previous discussion and write summary.md",
      domain: "code_modification",
      action: "create",
      primaryAction: "modify",
      targets: [{ type: "file", value: "summary.md" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: true,
        localWorkspace: true,
        externalWorld: false,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intentSteps: [recall, write],
    topicAnalysis: {
      history: {
        label: "",
        evidence: [],
        sourceTurns: [],
        confidence: 0.9,
      },
      current: {
        label: "question",
        evidence: ["question"],
        sourceTurns: [0],
        confidence: 0.9,
      },
      relation: "unknown",
      relationReason: "",
      confidence: 0.9,
      lowGrounding: false,
    },
    policyTrace: [],
    source: "test",
  };
}

function adapter(
  capabilities: string[],
  fn: (request: TaskNodeExecutionRequest) => TaskNodeExecutionResult,
): TaskGraphCapabilityAdapter {
  return {
    id: capabilities.join("+"),
    capabilities,
    execute: vi.fn(async (request) => fn(request)),
  };
}

describe("task graph durable state", () => {
  it("snapshots execution and resumes without re-running succeeded nodes", async () => {
    const graph = buildTaskGraph(intentWithTwoSteps());
    const recallAdapter = adapter(["memory.recall"], (request) => ({
      status: "succeeded",
      output: { items: ["history"] },
      artifacts: [
        {
          id: "memory-1",
          nodeId: request.node.id,
          type: "memory",
          memoryItems: ["history"],
        },
      ],
    }));
    const failingWrite = adapter(["file.write"], () => ({
      status: "succeeded",
      output: { ok: true },
      artifacts: [],
    }));
    const firstExecutor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([recallAdapter, failingWrite]),
    );
    const firstResult = await firstExecutor.execute(graph, {
      userPrompt: "write summary",
    });
    const snapshot = snapshotTaskGraphExecution(firstResult, {
      events: [],
      metadata: { phase: "first" },
    });

    const store = new InMemoryTaskGraphExecutionStore();
    await store.save(snapshot);
    const loaded = await store.load(snapshot.id);

    expect(loaded?.failureRootCause).toContain(
      "no existing file artifact was observed",
    );
    expect(loaded?.nodes.find((node) => node.nodeId === "step-1")?.status).toBe(
      "succeeded",
    );

    const successfulWrite = adapter(["file.write"], (request) => ({
      status: "succeeded",
      output: { path: "summary.md" },
      artifacts: [
        {
          id: "file-1",
          nodeId: request.node.id,
          type: "file",
          path: "summary.md",
          exists: true,
          content: "history",
        },
      ],
    }));
    const resumeExecutor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([recallAdapter, successfulWrite]),
    );
    const resumed = await resumeExecutor.execute(graph, {
      userPrompt: "write summary",
      resumeState: resumeStateFromSnapshot(loaded!),
    });

    expect(resumed.status).toBe("succeeded");
    expect(recallAdapter.execute).toHaveBeenCalledTimes(1);
    expect(successfulWrite.execute).toHaveBeenCalledTimes(1);
  });

  it("persists snapshots to a JSON file store and supports filtered listing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "task-graph-state-"));
    try {
      const graph = buildTaskGraph(intentWithTwoSteps());
      const executor = new TaskGraphExecutor(
        new DefaultTaskGraphCapabilityRegistry([
          adapter(["memory.recall"], (request) => ({
            status: "succeeded",
            output: { empty: true },
            artifacts: [
              {
                id: "memory-empty",
                nodeId: request.node.id,
                type: "memory",
                memoryItems: [],
              },
            ],
          })),
          adapter(["file.write"], (request) => ({
            status: "succeeded",
            output: { path: "summary.md" },
            artifacts: [
              {
                id: "file-1",
                nodeId: request.node.id,
                type: "file",
                path: "summary.md",
                exists: true,
              },
            ],
          })),
        ]),
      );
      const result = await executor.execute(graph, {
        userPrompt: "write summary",
      });
      const snapshot = snapshotTaskGraphExecution(result);
      const store = new JsonFileTaskGraphExecutionStore(dir);

      await store.save(snapshot);
      await store.appendEvent(snapshot.id, {
        type: "task_graph_finished",
        graphId: graph.id,
        status: "succeeded",
        blocked: 0,
        failed: 0,
      });

      const loaded = await store.load(snapshot.id);
      const listed = await store.list({ status: "succeeded" });

      expect(loaded?.events).toHaveLength(1);
      expect(listed.map((item) => item.id)).toEqual([snapshot.id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registers artifacts with source node metadata", () => {
    const registry = new TaskArtifactRegistry();

    const artifact = registry.register({
      id: "file-1",
      nodeId: "step-1",
      type: "file",
      path: "summary.md",
      exists: true,
    });

    expect(artifact.sourceNodeId).toBe("step-1");
    expect(artifact.createdAt).toBeTruthy();
    expect(registry.findByNode("step-1")).toHaveLength(1);
    expect(registry.findByType("file")).toHaveLength(1);
  });
});
