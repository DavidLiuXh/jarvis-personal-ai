/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import {
  buildTaskGraph,
  buildTaskSpec,
  validateTaskGraph,
  validateTaskSpec,
} from "./taskGraph.js";

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

describe("task graph runtime planning", () => {
  it("builds a TaskSpec with acceptance criteria for a single answer task", () => {
    const spec = buildTaskSpec(makeIntent());

    expect(spec.taskKind).toBe("answer");
    expect(spec.acceptanceCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "response_contains" }),
      ]),
    );
    expect(validateTaskSpec(spec).every((gate) => gate.ok)).toBe(true);
  });

  it("builds a multi-node TaskGraph with explicit dependencies", () => {
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
    const intent = makeIntent({
      taskType: "execute",
      needsMemory: true,
      needsTool: true,
      semanticEvidence: {
        ...makeIntent().semanticEvidence,
        memoryRecall: {
          present: true,
          target: "conversation_history",
          reason: "Needs previous discussion.",
          span: "previous discussion",
        },
      },
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "Recall previous discussion and save it to summary.md",
        contextDependency: {
          recentConversation: false,
          longTermMemory: true,
          localWorkspace: true,
          externalWorld: false,
        },
      },
      intentSteps: [recall, write],
    });

    const graph = buildTaskGraph(intent);

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "recall",
      "write_file",
    ]);
    expect(graph.edges).toEqual([
      { from: "step-1", to: "step-2", reason: "intent step dependency" },
    ]);
    expect(graph.nodes[1].acceptanceCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file_exists" }),
      ]),
    );
    expect(validateTaskGraph(graph).every((gate) => gate.ok)).toBe(true);
  });

  it("blocks executable nodes when a required capability is unavailable", () => {
    const intent = makeIntent({
      taskType: "schedule",
      needsScheduling: true,
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "每天早上8点生成新闻摘要",
        domain: "task_management",
        action: "schedule",
        primaryAction: "schedule",
      },
      intentSteps: [
        makeStep({
          id: "step-1",
          type: "schedule",
          action: "create",
          target: "每天早上8点生成新闻摘要",
          operation: {
            domain: "task_management",
            action: "create",
            targetType: "task",
            target: "每天早上8点生成新闻摘要",
            riskLevel: "medium",
          },
          riskLevel: "medium",
        }),
      ],
    });

    const graph = buildTaskGraph(intent, undefined, {
      availableCapabilities: ["llm.respond"],
    });

    expect(graph.status).toBe("blocked");
    expect(graph.blockedReasons.join("\n")).toContain(
      "blocked_missing_capability:task.schedule",
    );
    expect(validateTaskGraph(graph)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          code: "task_graph_capabilities_available",
        }),
      ]),
    );
  });

  it("blocks personal recall planning under an external memory boundary", () => {
    const intent = makeIntent({
      subject: "personal",
      taskType: "recall",
      needsMemory: true,
      semanticEvidence: {
        ...makeIntent().semanticEvidence,
        memoryRecall: {
          present: true,
          target: "user_memory",
          reason: "User asks for saved personal memory.",
          span: "hobbies",
        },
      },
      richIntent: {
        ...makeIntent().richIntent,
        userGoal: "我有哪些爱好？",
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
          target: "user hobbies",
          operation: {
            domain: "memory_management",
            action: "recall",
            targetType: "memory",
            target: "user hobbies",
            riskLevel: "low",
          },
        }),
      ],
    });

    const graph = buildTaskGraph(intent, undefined, {
      memoryBoundary: "external",
    });

    expect(graph.status).toBe("blocked");
    expect(graph.blockedReasons.join("\n")).toContain(
      "external memory boundary forbids personal recall",
    );
  });
});
