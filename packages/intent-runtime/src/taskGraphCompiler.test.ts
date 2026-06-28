/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { IntentFrame } from "@jarvis/memory-runtime";
import { validateTaskGraph } from "./taskGraph.js";
import { compileTaskGraphDraft } from "./taskGraphCompiler.js";
import type { TaskGraphPlanDraft } from "./taskGraphPlanner.js";

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

describe("task graph compiler", () => {
  it("compiles a local document workflow draft into executable graph nodes", () => {
    const draft: TaskGraphPlanDraft = {
      goal: "Analyze local reports and save markdown",
      confidence: 0.9,
      assumptions: [],
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
          kind: "evidence_extraction",
          purpose: "Extract evidence",
          dependsOn: ["draft-1"],
          required: true,
          riskLevel: "low",
        },
        {
          id: "draft-3",
          kind: "analysis",
          purpose: "Analyze evidence",
          dependsOn: ["draft-2"],
          required: true,
          riskLevel: "medium",
        },
        {
          id: "draft-4",
          kind: "artifact_write",
          purpose: "Save final markdown",
          artifact: {
            type: "file",
            format: "markdown",
            destinationHint: "local_file",
          },
          dependsOn: ["draft-3"],
          required: true,
          riskLevel: "low",
        },
      ],
    };

    const result = compileTaskGraphDraft(makeIntent(), draft);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.rejectedReasons.join(","));
    expect(result.graph.nodes.map((node) => node.kind)).toEqual([
      "read_many_files",
      "extract_evidence",
      "analyze",
      "write_artifact",
    ]);
    expect(result.graph.edges).toEqual([
      { from: "draft-1", to: "draft-2", reason: "planner draft dependency" },
      { from: "draft-2", to: "draft-3", reason: "planner draft dependency" },
      { from: "draft-3", to: "draft-4", reason: "planner draft dependency" },
    ]);
    expect(result.graph.nodes.at(-1)?.acceptanceCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file_exists" }),
      ]),
    );
    expect(validateTaskGraph(result.graph).every((gate) => gate.ok)).toBe(true);
  });

  it("adds a prior content dependency for artifact writes when the draft omits it", () => {
    const draft: TaskGraphPlanDraft = {
      goal: "Analyze and save",
      confidence: 0.8,
      assumptions: [],
      steps: [
        {
          id: "draft-1",
          kind: "analysis",
          purpose: "Analyze",
          dependsOn: [],
          required: true,
          riskLevel: "medium",
        },
        {
          id: "draft-2",
          kind: "artifact_write",
          purpose: "Save",
          dependsOn: [],
          required: true,
          riskLevel: "low",
        },
      ],
    };

    const result = compileTaskGraphDraft(makeIntent(), draft);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.rejectedReasons.join(","));
    expect(result.graph.edges).toEqual([
      { from: "draft-1", to: "draft-2", reason: "planner draft dependency" },
    ]);
  });

  it("rejects artifact writes with no content producer", () => {
    const draft: TaskGraphPlanDraft = {
      goal: "Save only",
      confidence: 0.8,
      assumptions: [],
      steps: [
        {
          id: "draft-1",
          kind: "artifact_write",
          purpose: "Save",
          dependsOn: [],
          required: true,
          riskLevel: "low",
        },
      ],
    };

    const result = compileTaskGraphDraft(makeIntent(), draft);

    expect(result.ok).toBe(false);
    expect(result.rejectedReasons).toEqual([
      "write_without_content_producer:draft-1",
    ]);
  });

  it("compiles recall and schedule drafts with matching capabilities", () => {
    const recall = compileTaskGraphDraft(makeIntent(), {
      goal: "Recall",
      confidence: 0.9,
      assumptions: [],
      steps: [
        {
          id: "draft-1",
          kind: "memory_recall",
          purpose: "Recall memory",
          dependsOn: [],
          required: true,
          riskLevel: "low",
        },
      ],
    });
    const schedule = compileTaskGraphDraft(makeIntent(), {
      goal: "Schedule",
      confidence: 0.9,
      assumptions: [],
      steps: [
        {
          id: "draft-1",
          kind: "schedule",
          purpose: "Create reminder",
          dependsOn: [],
          required: true,
          riskLevel: "medium",
        },
      ],
    });

    expect(recall.ok && recall.graph.nodes[0].requiredCapabilities).toEqual([
      "memory.recall",
    ]);
    expect(schedule.ok && schedule.graph.nodes[0].requiredCapabilities).toEqual(
      ["task.schedule"],
    );
  });

  it("compiles directory discovery and many-file reads as first-class nodes", () => {
    const result = compileTaskGraphDraft(makeIntent(), {
      goal: "Discover and read a local directory",
      confidence: 0.9,
      assumptions: [],
      steps: [
        {
          id: "draft-1",
          kind: "local_workspace_discovery",
          purpose: "List report directory",
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
          kind: "local_file_read",
          purpose: "Read report files",
          source: {
            type: "local_directory",
            pathHint: "/Users/lw/Documents/reports",
          },
          dependsOn: ["draft-1"],
          required: true,
          riskLevel: "low",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.rejectedReasons.join(","));
    expect(result.graph.nodes.map((node) => node.kind)).toEqual([
      "list_directory",
      "read_many_files",
    ]);
    expect(result.graph.nodes.map((node) => node.requiredCapabilities)).toEqual(
      [["file.read"], ["file.read"]],
    );
  });
});
