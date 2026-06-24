/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from "vitest";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import { AutonomousTaskRuntime } from "./autonomousTaskRuntime.js";
import { buildTaskGraph } from "./taskGraph.js";
import {
  applyReplanDecision,
  decideTaskGraphRecovery,
} from "./taskGraphRecovery.js";
import {
  DefaultTaskGraphCapabilityRegistry,
  TaskGraphExecutor,
  type TaskGraphCapabilityAdapter,
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

function intent(overrides: Partial<IntentFrame> = {}): IntentFrame {
  const write = makeStep({
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
  });
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
    intentSteps: [write],
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

describe("task graph recovery", () => {
  it("decides retry for missing file artifacts and aborts after max recovery", async () => {
    const graph = buildTaskGraph(intent());
    const executor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter(["file.write"], () => ({
          status: "succeeded",
          output: { ok: true },
          artifacts: [],
        })),
      ]),
    );

    const result = await executor.execute(graph, { userPrompt: "write file" });
    const decision = decideTaskGraphRecovery({
      result,
      recoveryAttempts: 0,
      maxRecoveryAttempts: 2,
    });
    const exhausted = decideTaskGraphRecovery({
      result,
      recoveryAttempts: 2,
      maxRecoveryAttempts: 2,
    });

    expect(decision).toMatchObject({
      action: "retry_same",
      reasonCode: "file_artifact_missing_retry",
      nodeId: "step-1",
    });
    expect(exhausted).toMatchObject({
      action: "abort",
      reasonCode: "recovery_attempts_exhausted",
    });
  });

  it("adds a source repair node when source coverage fails and web search is available", async () => {
    const frame = intent({
      needsExternalKnowledge: true,
      richIntent: {
        ...intent().richIntent,
        userGoal: "research market trend",
        domain: "external_knowledge",
        action: "analyze",
        primaryAction: "analyze",
        contextDependency: {
          recentConversation: false,
          longTermMemory: false,
          localWorkspace: false,
          externalWorld: true,
        },
      },
      intentSteps: [
        makeStep({
          id: "step-1",
          type: "analyze",
          action: "analyze",
          target: "market trend",
          operation: {
            domain: "external_knowledge",
            action: "analyze",
            targetType: "external_entity",
            target: "market trend",
            riskLevel: "low",
          },
        }),
      ],
    });
    const graph = buildTaskGraph(frame);
    graph.nodes[0].acceptanceCriteria = [
      {
        id: "source-count",
        scope: "step",
        type: "source_count",
        description: "Research answer must include source coverage.",
        required: true,
        validator: "source_count_validator",
        params: { minSources: 1 },
      },
    ];
    const executor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([
        adapter(["llm.analyze"], () => ({
          status: "succeeded",
          output: { summary: "market trend" },
          artifacts: [],
        })),
      ]),
    );

    const result = await executor.execute(graph, { userPrompt: "research" });
    const decision = decideTaskGraphRecovery({
      result,
      availableCapabilities: ["web.search"],
    });
    const patched = applyReplanDecision(graph, decision);

    expect(decision.action).toBe("switch_capability");
    expect(decision.addedNode?.requiredCapabilities).toEqual(["web.search"]);
    expect(patched.nodes.map((node) => node.id)).toContain(
      "step-1-source-repair",
    );
    expect(patched.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "step-1-source-repair",
          to: "step-1",
        }),
      ]),
    );
  });

  it("asks the user for permission or policy blockers", async () => {
    const graph = buildTaskGraph(intent(), undefined, {
      allowShellNetworkFetch: false,
    });
    graph.nodes[0] = {
      ...graph.nodes[0],
      kind: "run_shell",
      title: "curl https://example.com",
      requiredCapabilities: ["shell.run"],
      blockedReason: "shell network fetch disabled by workspace policy",
    };
    const executor = new TaskGraphExecutor(
      new DefaultTaskGraphCapabilityRegistry([]),
    );

    const result = await executor.execute(graph, { userPrompt: "curl site" });
    const decision = decideTaskGraphRecovery({ result });

    expect(decision).toMatchObject({
      action: "ask_user",
      reasonCode: "permission_or_policy_requires_user",
      blocking: true,
    });
  });

  it("autonomous runtime retries recoverable validation failure and persists final snapshot", async () => {
    let attempts = 0;
    const graph = buildTaskGraph(intent());
    graph.nodes[0].retryPolicy.maxAttempts = 1;
    const runtime = new AutonomousTaskRuntime(
      new DefaultTaskGraphCapabilityRegistry([
        adapter(["file.write"], (request) => {
          attempts += 1;
          if (attempts === 1) {
            return {
              status: "succeeded",
              output: { ok: true },
              artifacts: [],
            };
          }
          return {
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
          };
        }),
      ]),
      { maxRecoveryAttempts: 2 },
    );

    const result = await runtime.run({
      intent: intent(),
      graph,
      context: { userPrompt: "write file" },
    });

    expect(result.status).toBe("succeeded");
    expect(attempts).toBe(2);
    expect(result.replanDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "retry_same",
          reasonCode: "file_artifact_missing_retry",
        }),
      ]),
    );
    expect(result.snapshot.status).toBe("succeeded");
  });
});
