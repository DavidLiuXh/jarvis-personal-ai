/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import { buildTaskGraph, buildTaskSpec } from "./taskGraph.js";
import {
  DefaultTaskGraphCapabilityRegistry,
  TaskGraphExecutor,
  type TaskGraphCapabilityAdapter,
  type TaskGraphExecutorEvent,
  type TaskNodeExecutionRequest,
  type TaskNodeExecutionResult,
} from "./taskGraphExecutor.js";
import {
  buildTaskGraphGoldenTrace,
  diffTaskGraphGoldenTrace,
  validateTaskGraphGoldenTrace,
} from "./taskGraphTrace.js";

function step(overrides: Partial<IntentStep>): IntentStep {
  return {
    id: "step-1",
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
    dependsOn: [],
    requiresConfirmation: false,
    riskLevel: "low",
    ...overrides,
  };
}

function intent(): IntentFrame {
  return {
    subject: "personal",
    taskType: "execute",
    needsMemory: false,
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
    reason: "write summary.md",
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
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: { present: true, action: "write", object: "summary.md" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: "write summary.md",
      domain: "code_modification",
      action: "create",
      primaryAction: "modify",
      targets: [{ type: "file", value: "summary.md" }],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        localWorkspace: true,
        externalWorld: false,
      },
      ambiguity: [],
      riskLevel: "low",
    },
    intentSteps: [step({})],
    topicAnalysis: {
      history: { label: "", evidence: [], sourceTurns: [], confidence: 0.9 },
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
  fn: (request: TaskNodeExecutionRequest) => TaskNodeExecutionResult,
): TaskGraphCapabilityAdapter {
  return {
    id: "file.write",
    capabilities: ["file.write"],
    execute: async (request) => fn(request),
  };
}

describe("TaskGraph golden trace", () => {
  it("contains TaskSpec, TaskGraph, transitions, validators and artifacts", async () => {
    const frame = intent();
    const spec = buildTaskSpec(frame);
    const graph = buildTaskGraph(frame, spec);
    const events: TaskGraphExecutorEvent[] = [];
    const executor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter((request) => ({
          status: "succeeded",
          output: { path: "summary.md" },
          artifacts: [
            {
              id: "file-1",
              nodeId: request.node.id,
              type: "file",
              path: "summary.md",
              exists: true,
              content: "summary",
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

    const execution = await executor.execute(graph, {
      userPrompt: "write summary.md",
    });
    const trace = buildTaskGraphGoldenTrace({
      taskSpec: spec,
      taskGraph: graph,
      execution,
      events,
    });

    expect(trace.taskSpec.acceptanceCriteria).toEqual(
      expect.arrayContaining(["file-exists:file_exists"]),
    );
    expect(trace.taskGraph.nodes[0]).toMatchObject({
      id: "step-1",
      kind: "write_file",
      requiredCapabilities: ["file.write"],
    });
    expect(trace.execution.nodes[0].validators[0]).toMatchObject({
      id: "step-1-file-exists",
      ok: true,
    });
    expect(trace.execution.artifacts[0]).toMatchObject({
      id: "file-1",
      path: "summary.md",
      type: "file",
    });
    expect(validateTaskGraphGoldenTrace(trace)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("flags traces that claim success without executed nodes", async () => {
    const frame = intent();
    const spec = buildTaskSpec(frame);
    const graph = buildTaskGraph(frame, spec);
    const execution = await new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter((request) => ({
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
    ).execute(graph, { userPrompt: "write summary.md" });
    const trace = buildTaskGraphGoldenTrace({
      taskSpec: spec,
      taskGraph: graph,
      execution,
      events: [],
    });

    expect(validateTaskGraphGoldenTrace(trace)).toMatchObject({
      ok: false,
      violations: ["node_succeeded_without_start_event:step-1"],
    });
  });

  it("produces readable golden trace diffs", async () => {
    const frame = intent();
    const spec = buildTaskSpec(frame);
    const graph = buildTaskGraph(frame, spec);
    const execution = await new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter((request) => ({
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
      { observer: () => undefined },
    ).execute(graph, { userPrompt: "write summary.md" });
    const actual = buildTaskGraphGoldenTrace({
      taskSpec: spec,
      taskGraph: graph,
      execution,
      events: [
        {
          type: "task_graph_started",
          graphId: graph.id,
          nodes: graph.nodes.length,
        },
      ],
    });
    const expected = {
      ...actual,
      execution: { ...actual.execution, status: "blocked" as const },
    };

    expect(diffTaskGraphGoldenTrace(expected, actual)).toContain("line");
    expect(diffTaskGraphGoldenTrace(expected, actual)).toContain("blocked");
  });
});
