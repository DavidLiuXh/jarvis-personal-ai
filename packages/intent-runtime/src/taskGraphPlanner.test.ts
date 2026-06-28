/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type { IntentFrame } from "@jarvis/memory-runtime";
import type { IntentModelClient } from "./modelClient.js";
import { buildTaskGraph } from "./taskGraph.js";
import {
  planTaskGraphDraft,
  validateTaskGraphPlanDraft,
} from "./taskGraphPlanner.js";

function makeIntent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  return {
    subject: "external",
    taskType: "execute",
    needsMemory: false,
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
      personalContext: { present: false, reason: "", span: "" },
      memoryRecall: { present: false, target: "none", reason: "", span: "" },
      actionRequest: { present: true, action: "write", object: "report" },
      entityHints: {
        tickers: [],
        technicalTerms: [],
        peopleOrCompanies: [],
      },
    },
    richIntent: {
      userGoal: "Analyze local documents and save a report",
      domain: "document_generation",
      action: "create",
      primaryAction: "create",
      targets: [],
      contextDependency: {
        recentConversation: false,
        longTermMemory: false,
        localWorkspace: true,
        externalWorld: false,
      },
      ambiguity: [],
      riskLevel: "medium",
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
        label: "local documents",
        evidence: ["local documents"],
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

function plannerClient(response: string | Error): IntentModelClient {
  return {
    generateJson: vi.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

describe("task graph planner draft", () => {
  it("accepts a grounded workflow draft", async () => {
    const intent = makeIntent();
    const userPrompt =
      "读取 /Users/lw/Documents/reports 下的文档，生成分析并保存成 markdown";
    const raw = JSON.stringify({
      goal: "Analyze local reports and save markdown",
      confidence: 0.88,
      assumptions: ["The provided directory is the source material."],
      steps: [
        {
          id: "draft-1",
          kind: "local_file_read",
          purpose: "Read local reports",
          source: {
            type: "local_directory",
            pathHint: "/Users/lw/Documents/reports",
          },
          dependsOn: [],
          required: true,
          riskLevel: "low",
        },
        {
          id: "draft-2",
          kind: "analysis",
          purpose: "Analyze report evidence",
          dependsOn: ["draft-1"],
          required: true,
          riskLevel: "medium",
        },
        {
          id: "draft-3",
          kind: "artifact_write",
          purpose: "Save final markdown",
          artifact: {
            type: "file",
            format: "markdown",
            destinationHint: "local_file",
          },
          dependsOn: ["draft-2"],
          required: true,
          riskLevel: "low",
        },
      ],
    });

    const result = await planTaskGraphDraft({
      intent,
      graph: buildTaskGraph(intent),
      gaps: [],
      context: { userPrompt },
      modelClient: plannerClient(raw),
    });

    expect(result.rejectedReasons).toEqual([]);
    expect(result.draft?.steps.map((step) => step.kind)).toEqual([
      "local_file_read",
      "analysis",
      "artifact_write",
    ]);
  });

  it("rejects unknown kinds, execution fields, and ungrounded path hints", () => {
    const intent = makeIntent();
    const validation = validateTaskGraphPlanDraft(
      {
        goal: "Bad plan",
        confidence: 0.9,
        assumptions: [],
        steps: [
          {
            id: "draft-1",
            kind: "run_shell",
            purpose: "Run a command",
            command: "rm -rf /tmp/example",
            source: {
              type: "local_directory",
              pathHint: "/Users/lw/Invented/Path",
            },
            dependsOn: [],
            required: true,
            riskLevel: "low",
          },
        ],
      },
      {
        intent,
        context: { userPrompt: "请分析 /Users/lw/Documents/reports" },
      },
    );

    expect(validation.ok).toBe(false);
    expect(validation.rejectedReasons).toEqual(
      expect.arrayContaining([
        "unknown_step_kind:run_shell",
        "forbidden_execution_field:draft-1",
        "ungrounded_path_hint:/Users/lw/Invented/Path",
      ]),
    );
  });

  it("rejects dependency cycles and unknown dependencies", () => {
    const intent = makeIntent();
    const validation = validateTaskGraphPlanDraft(
      {
        goal: "Cyclic plan",
        confidence: 0.9,
        assumptions: [],
        steps: [
          {
            id: "draft-1",
            kind: "analysis",
            purpose: "A",
            dependsOn: ["draft-2"],
            required: true,
            riskLevel: "low",
          },
          {
            id: "draft-2",
            kind: "artifact_write",
            purpose: "B",
            dependsOn: ["draft-1", "missing"],
            required: true,
            riskLevel: "low",
          },
        ],
      },
      { intent },
    );

    expect(validation.ok).toBe(false);
    expect(validation.rejectedReasons).toEqual(
      expect.arrayContaining([
        "unknown_dependency:draft-2:missing",
        "draft_dependency_cycle",
      ]),
    );
  });

  it("falls back with rejection reasons when the planner model fails", async () => {
    const intent = makeIntent();
    const result = await planTaskGraphDraft({
      intent,
      graph: buildTaskGraph(intent),
      gaps: [],
      context: { userPrompt: "读取 /Users/lw/Documents/reports" },
      modelClient: plannerClient(new Error("planner unavailable")),
    });

    expect(result.draft).toBeNull();
    expect(result.rejectedReasons).toEqual(["planner unavailable"]);
    expect(result.rawResponse).toBeNull();
  });
});
