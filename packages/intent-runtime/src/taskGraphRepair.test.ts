/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import { buildTaskGraph, validateTaskGraph } from "./taskGraph.js";
import { detectTaskGraphGaps } from "./taskGraphGapDetector.js";
import { repairTaskGraphGaps } from "./taskGraphRepair.js";

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
    subject: "external",
    taskType: "chat",
    needsMemory: false,
    needsExternalKnowledge: false,
    needsTool: false,
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
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: { present: false, action: "none", object: "" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: "Answer the question",
      domain: "general_chat",
      action: "answer",
      primaryAction: "answer",
      targets: [],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        localWorkspace: false,
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
    ...overrides,
  };
}

function makeLocalDocumentIntent(): {
  intent: IntentFrame;
  userPrompt: string;
} {
  const userPrompt =
    "在/Users/lw/Documents/投资/美国市场预测目录下是最近一段时间对美国市场的预测，分析和复盘。以这些文档作参考，完成一篇有深度的分析，保存在本地文档中。";
  return {
    userPrompt,
    intent: makeIntent({
      taskType: "execute",
      needsTool: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal:
          "perform a deep unique analysis of US market predictions and save final document",
        action: "create",
        primaryAction: "create",
        contextDependency: {
          recentConversation: false,
          longTermMemory: false,
          localWorkspace: true,
          externalWorld: false,
        },
      },
      intentSteps: [
        makeStep({
          id: "step-1",
          type: "analyze",
          action: "execute",
          target: "local_file_analysis",
          operation: {
            domain: "data_analysis",
            action: "analyze",
            targetType: "file",
            target: "local_file_analysis",
            riskLevel: "medium",
          },
          riskLevel: "medium",
        }),
        makeStep({
          id: "step-2",
          type: "analyze",
          action: "analyze",
          target: "analysis_generation",
          operation: {
            domain: "data_analysis",
            action: "analyze",
            targetType: "external_entity",
            target: "analysis_generation",
            riskLevel: "medium",
          },
          dependsOn: ["step-1"],
          riskLevel: "medium",
        }),
        makeStep({
          id: "step-3",
          type: "chat",
          action: "save",
          target: "final_document",
          operation: {
            domain: "document_generation",
            action: "answer",
            targetType: "current_context",
            target: "final_document",
            riskLevel: "low",
          },
          dependsOn: ["step-2"],
        }),
      ],
    }),
  };
}

describe("task graph deterministic repair", () => {
  it("repairs an LLM-only local document workflow with read and write nodes", () => {
    const { intent, userPrompt } = makeLocalDocumentIntent();
    const graph = buildTaskGraph(intent);
    const gaps = detectTaskGraphGaps(intent, graph, { userPrompt });

    const result = repairTaskGraphGaps(intent, graph, gaps, { userPrompt });

    expect(result.rejectedReasons).toEqual([]);
    expect(result.repairs.map((repair) => repair.kind)).toEqual(
      expect.arrayContaining([
        "insert_local_read",
        "wire_read_to_analysis",
        "insert_artifact_write",
        "wire_content_to_write",
      ]),
    );
    expect(result.graph.nodes.map((node) => node.kind)).toEqual([
      "read_many_files",
      "analyze",
      "analyze",
      "respond",
      "write_file",
    ]);
    expect(result.graph.nodes[0].title).toContain(
      "/Users/lw/Documents/投资/美国市场预测",
    );
    expect(result.graph.nodes[0].title).not.toContain("目录下");
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "repair-read-local-input",
          to: "step-1",
        }),
        expect.objectContaining({
          from: "repair-read-local-input",
          to: "step-2",
        }),
        expect.objectContaining({
          from: "step-3",
          to: "repair-write-final-artifact",
        }),
      ]),
    );
    expect(result.graph.nodes.at(-1)?.acceptanceCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file_exists" }),
      ]),
    );
    expect(validateTaskGraph(result.graph).every((gate) => gate.ok)).toBe(true);
  });

  it("does not mutate stable schedule and recall graphs", () => {
    const scheduleIntent = makeIntent({
      taskType: "schedule",
      needsScheduling: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "明天早上8点提醒我复盘市场",
        domain: "task_management",
        action: "schedule",
        primaryAction: "schedule",
      },
      intentSteps: [
        makeStep({
          id: "step-1",
          type: "schedule",
          action: "create",
          target: "明天早上8点提醒我复盘市场",
          operation: {
            domain: "task_management",
            action: "create",
            targetType: "task",
            target: "明天早上8点提醒我复盘市场",
            riskLevel: "medium",
          },
          riskLevel: "medium",
        }),
      ],
    });
    const recallIntent = makeIntent({
      taskType: "recall",
      needsMemory: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "回忆我们上次讨论过什么",
        domain: "memory_management",
        action: "recall",
        primaryAction: "recall",
      },
      intentSteps: [
        makeStep({
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
        }),
      ],
    });

    for (const intent of [scheduleIntent, recallIntent]) {
      const graph = buildTaskGraph(intent);
      const result = repairTaskGraphGaps(
        intent,
        graph,
        detectTaskGraphGaps(intent, graph),
      );
      expect(result.repairs).toEqual([]);
      expect(result.graph).toEqual(graph);
    }
  });

  it("rejects local read repair when a path hint is unavailable", () => {
    const intent = makeIntent({
      taskType: "execute",
      needsTool: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "参考这些文档写一篇分析并保存",
        action: "create",
        primaryAction: "create",
        contextDependency: {
          recentConversation: false,
          longTermMemory: false,
          localWorkspace: true,
          externalWorld: false,
        },
      },
      intentSteps: [
        makeStep({
          id: "step-1",
          type: "analyze",
          action: "analyze",
          target: "documents",
          operation: {
            domain: "data_analysis",
            action: "analyze",
            targetType: "file",
            target: "documents",
            riskLevel: "medium",
          },
          riskLevel: "medium",
        }),
      ],
    });
    const graph = buildTaskGraph(intent);

    const result = repairTaskGraphGaps(
      intent,
      graph,
      [
        {
          kind: "local_path_without_read",
          severity: "critical",
          message: "forced test gap",
          evidence: [],
          suggestedNodeKinds: ["read_file"],
        },
      ],
      { userPrompt: "参考这些文档写一篇分析并保存" },
    );

    expect(result.graph.nodes.map((node) => node.kind)).not.toContain(
      "read_file",
    );
    expect(result.rejectedReasons).toContain(
      "local_path_without_read:missing_path_hint",
    );
  });
});
