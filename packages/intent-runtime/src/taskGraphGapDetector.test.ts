/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import { buildTaskGraph } from "./taskGraph.js";
import { detectTaskGraphGaps } from "./taskGraphGapDetector.js";

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

describe("task graph gap detector", () => {
  it("detects local directory read and write gaps in an LLM-only execute graph", () => {
    const userPrompt =
      "请求：在/Users/lw/Documents/投资/美国市场预测目录下是最近一段时间对美国市场的预测，分析和复盘。你以这些文档作参考，完成一篇分析，保存在本地文档中。";
    const intent = makeIntent({
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
    });
    const graph = buildTaskGraph(intent);

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "analyze",
      "analyze",
      "respond",
    ]);

    const gaps = detectTaskGraphGaps(intent, graph, { userPrompt });

    expect(gaps.map((gap) => gap.kind)).toEqual(
      expect.arrayContaining([
        "local_path_without_read",
        "save_request_without_write",
        "source_reference_without_acquisition",
        "execute_task_with_only_llm_nodes",
        "required_artifact_without_producer",
      ]),
    );
  });

  it("does not report gaps for stable recall, schedule, answer, and explicit write graphs", () => {
    const recallIntent = makeIntent({
      taskType: "recall",
      needsMemory: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "回忆我们上次讨论过什么",
        domain: "memory_management",
        action: "recall",
        primaryAction: "recall",
        contextDependency: {
          recentConversation: false,
          longTermMemory: true,
          localWorkspace: false,
          externalWorld: false,
        },
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
    const answerIntent = makeIntent();
    const writeIntent = makeIntent({
      taskType: "execute",
      needsTool: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "write summary.md",
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
          type: "execute",
          action: "write",
          target: "summary.md",
          operation: {
            domain: "document_generation",
            action: "create",
            targetType: "file",
            target: "summary.md",
            riskLevel: "low",
          },
        }),
      ],
    });

    for (const intent of [
      recallIntent,
      scheduleIntent,
      answerIntent,
      writeIntent,
    ]) {
      expect(detectTaskGraphGaps(intent, buildTaskGraph(intent))).toEqual([]);
    }
  });

  it("detects required file artifacts without a producer", () => {
    const intent = makeIntent({
      taskType: "execute",
      needsTool: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "save a final report locally",
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
          target: "report",
          operation: {
            domain: "data_analysis",
            action: "analyze",
            targetType: "external_entity",
            target: "report",
            riskLevel: "medium",
          },
          riskLevel: "medium",
        }),
      ],
    });

    const gaps = detectTaskGraphGaps(intent, buildTaskGraph(intent));

    expect(gaps.map((gap) => gap.kind)).toEqual(
      expect.arrayContaining([
        "save_request_without_write",
        "required_artifact_without_producer",
      ]),
    );
  });
});
