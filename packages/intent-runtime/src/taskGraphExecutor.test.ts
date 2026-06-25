/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import { buildTaskGraph } from "./taskGraph.js";
import {
  DefaultTaskGraphCapabilityRegistry,
  TaskGraphExecutor,
  validateAcceptanceCriterion,
  type TaskGraphCapabilityAdapter,
  type TaskGraphExecutorEvent,
  type TaskNodeExecutionRequest,
  type TaskNodeExecutionResult,
} from "./taskGraphExecutor.js";

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

function makeIntent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  return {
    subject: "personal",
    taskType: "execute",
    needsMemory: true,
    needsExternalKnowledge: false,
    needsTool: true,
    needsScheduling: false,
    candidateAgents: [],
    confidence: 0.9,
    confidenceByDimension: {
      subject: 0.9,
      taskType: 0.9,
      memoryTarget: 0.9,
      action: 0.9,
      entityHints: 0.9,
      topicShift: 0.9,
      richIntent: 0.9,
    },
    reason: "test intent",
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
    intentSteps: [],
    timeWindowDays: null,
    dateFrom: null,
    dateTo: null,
    resolvedDateRange: null,
    referencesRecentHistory: false,
    topicShifted: false,
    policyTrace: [],
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
    source: "test",
    complexityScore: 60,
    knowledgeScore: 40,
    operationScore: 70,
    ...overrides,
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

function recallAndWriteIntent(): IntentFrame {
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
  return makeIntent({ intentSteps: [recall, write] });
}

describe("TaskGraphExecutor", () => {
  it("does not pass source_count for empty source artifacts", () => {
    const result = validateAcceptanceCriterion(
      {
        id: "source-count",
        scope: "step",
        type: "source_count",
        description: "requires real source evidence",
        required: true,
        params: { minSources: 1 },
      },
      {
        result: { status: "succeeded", output: {}, artifacts: [] },
        artifacts: [{ id: "empty", nodeId: "n", type: "source" }],
        context: { userPrompt: "research" },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("source count 0 < 1");
  });

  it("executes a dependency-ordered graph and validates node acceptance", async () => {
    const executionOrder: string[] = [];
    const graph = buildTaskGraph(recallAndWriteIntent());
    const executor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter(["memory.recall"], (request) => {
          executionOrder.push(request.node.id);
          return {
            status: "succeeded",
            output: { items: ["previous discussion"] },
            artifacts: [
              {
                id: "memory-1",
                nodeId: request.node.id,
                type: "memory",
                memoryItems: ["previous discussion"],
              },
            ],
          };
        }),
        adapter(["file.write"], (request) => {
          executionOrder.push(request.node.id);
          return {
            status: "succeeded",
            output: { path: "summary.md" },
            artifacts: [
              {
                id: "file-1",
                nodeId: request.node.id,
                type: "file",
                path: "summary.md",
                content: "previous discussion",
                exists: true,
              },
            ],
          };
        }),
      ]),
    );

    const result = await executor.execute(graph, {
      userPrompt: "Recall previous discussion and write summary.md",
    });

    expect(result.status).toBe("succeeded");
    expect(executionOrder).toEqual(["step-1", "step-2"]);
    expect(result.finalResponseContract.canClaimSuccess).toBe(true);
    expect(
      result.nodes.flatMap((state) =>
        state.acceptanceResults.map((item) => item.ok),
      ),
    ).toEqual([true, true]);
  });

  it("fails a node when execution succeeds but required acceptance fails", async () => {
    const graph = buildTaskGraph(recallAndWriteIntent());
    const executor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter(["memory.recall"], (request) => ({
          status: "succeeded",
          output: { items: ["previous discussion"] },
          artifacts: [
            {
              id: "memory-1",
              nodeId: request.node.id,
              type: "memory",
              memoryItems: ["previous discussion"],
            },
          ],
        })),
        adapter(["file.write"], () => ({
          status: "succeeded",
          output: { ok: true },
          artifacts: [],
        })),
      ]),
    );

    const result = await executor.execute(graph, {
      userPrompt: "Recall previous discussion and write summary.md",
    });

    expect(result.status).toBe("failed");
    expect(result.failedReasons.join("\n")).toContain(
      "no existing file artifact was observed",
    );
    expect(result.finalResponseContract.canClaimSuccess).toBe(false);
    expect(
      executor.validateFinalResponse(result, "已经成功写入 summary.md。").ok,
    ).toBe(false);
    expect(
      executor.validateFinalResponse(
        result,
        "未能写入 summary.md，因为没有文件产物。",
      ).ok,
    ).toBe(true);
  });

  it("fails the graph and blocks dependent nodes when an upstream required node fails", async () => {
    const graph = buildTaskGraph(recallAndWriteIntent());
    const executor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter(["memory.recall"], () => ({
          status: "failed",
          error: "memory backend unavailable",
          output: { error: "memory backend unavailable" },
        })),
        adapter(["file.write"], () => ({
          status: "succeeded",
          output: { path: "summary.md" },
          artifacts: [
            {
              id: "file-1",
              nodeId: "step-2",
              type: "file",
              path: "summary.md",
              exists: true,
            },
          ],
        })),
      ]),
    );

    const result = await executor.execute(graph, {
      userPrompt: "Recall previous discussion and write summary.md",
    });

    expect(result.status).toBe("failed");
    expect(
      result.nodes.find((state) => state.node.id === "step-1")?.status,
    ).toBe("failed");
    expect(
      result.nodes.find((state) => state.node.id === "step-2")?.status,
    ).toBe("blocked");
    expect(result.blockedReasons.join("\n")).toContain(
      "waiting for dependent node(s): step-1",
    );
  });

  it("emits observable execution and acceptance events", async () => {
    const graph = buildTaskGraph(recallAndWriteIntent());
    const events: TaskGraphExecutorEvent[] = [];
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
      {
        observer: (event) => {
          events.push(event);
        },
      },
    );

    const result = await executor.execute(graph, {
      userPrompt: "Recall previous discussion and write summary.md",
    });

    expect(result.status).toBe("succeeded");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task_graph_started",
        "task_node_started",
        "task_node_result",
        "task_node_acceptance",
        "task_node_finished",
        "task_graph_finished",
      ]),
    );
    expect(
      events.find((event) => event.type === "task_node_started"),
    ).toMatchObject({
      type: "task_node_started",
      nodeId: "step-1",
      adapterId: "memory.recall",
      requiredCapabilities: ["memory.recall"],
    });
    expect(
      events.find((event) => event.type === "task_node_result"),
    ).toMatchObject({
      type: "task_node_result",
      nodeId: "step-1",
      artifactCount: 1,
      artifactTypes: ["memory"],
    });
    expect(
      events.find((event) => event.type === "task_graph_finished"),
    ).toMatchObject({
      type: "task_graph_finished",
      status: "succeeded",
      blockedReasons: [],
      failedReasons: [],
      finalResponseCanClaimSuccess: true,
    });
  });
});
