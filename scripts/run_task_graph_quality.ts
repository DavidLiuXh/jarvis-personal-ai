/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import {
  AutonomousTaskRuntime,
  DefaultTaskGraphCapabilityRegistry,
  InMemoryTaskGraphExecutionStore,
  TaskGraphExecutor,
  buildTaskGraph,
  buildTaskSpec,
  type TaskGraphCapabilityAdapter,
  type TaskNodeExecutionRequest,
  type TaskNodeExecutionResult,
} from "@jarvis/intent-runtime";

type TaskGraphQualityCaseResult = {
  id: string;
  dimension:
    | "taskEvaluation"
    | "taskGraphPlanning"
    | "capabilitySelection"
    | "executionOrdering"
    | "acceptanceValidation"
    | "replanning"
    | "durableState";
  passed: boolean;
  details: Record<string, unknown>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const logsDir = path.join(repoRoot, "evals", "logs");

function step(overrides: Partial<IntentStep>): IntentStep {
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
  const write = step({
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
    source: "quality",
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
    execute: async (request) => fn(request),
  };
}

function pass(
  id: TaskGraphQualityCaseResult["id"],
  dimension: TaskGraphQualityCaseResult["dimension"],
  passed: boolean,
  details: Record<string, unknown>,
): TaskGraphQualityCaseResult {
  return { id, dimension, passed, details };
}

async function runTaskEvaluationCase(): Promise<TaskGraphQualityCaseResult> {
  const spec = buildTaskSpec(intent());
  return pass(
    "task_spec_acceptance",
    "taskEvaluation",
    spec.acceptanceCriteria.length > 0,
    {
      taskKind: spec.taskKind,
      criteria: spec.acceptanceCriteria.map((item) => item.type),
    },
  );
}

async function runPlanningCase(): Promise<TaskGraphQualityCaseResult> {
  const recall = step({
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
  const write = step({
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
  const graph = buildTaskGraph(intent({ intentSteps: [recall, write] }));
  return pass(
    "task_graph_dependencies",
    "taskGraphPlanning",
    graph.nodes.length === 2 && graph.edges.length === 1,
    {
      nodes: graph.nodes.map((node) => node.kind),
      edges: graph.edges,
    },
  );
}

async function runCapabilityCase(): Promise<TaskGraphQualityCaseResult> {
  const graph = buildTaskGraph(intent(), undefined, {
    availableCapabilities: ["llm.respond"],
  });
  return pass(
    "capability_missing_blocks",
    "capabilitySelection",
    graph.status === "blocked" &&
      graph.blockedReasons.some((reason) =>
        reason.includes("blocked_missing_capability:file.write"),
      ),
    { status: graph.status, blockedReasons: graph.blockedReasons },
  );
}

async function runOrderingCase(): Promise<TaskGraphQualityCaseResult> {
  const recall = step({
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
  const write = step({
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
  const graph = buildTaskGraph(intent({ intentSteps: [recall, write] }));
  const order: string[] = [];
  const executor = new TaskGraphExecutor(
    new DefaultTaskGraphCapabilityRegistry([
      adapter(["memory.recall"], (request) => {
        order.push(request.node.id);
        return {
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
        };
      }),
      adapter(["file.write"], (request) => {
        order.push(request.node.id);
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
  );
  const result = await executor.execute(graph, { userPrompt: "write summary" });
  return pass(
    "dependency_execution_order",
    "executionOrdering",
    result.status === "succeeded" && order.join(",") === "step-1,step-2",
    { status: result.status, order },
  );
}

async function runAcceptanceCase(): Promise<TaskGraphQualityCaseResult> {
  const result = await new TaskGraphExecutor(
    new DefaultTaskGraphCapabilityRegistry([
      adapter(["file.write"], () => ({
        status: "succeeded",
        output: { ok: true },
        artifacts: [],
      })),
    ]),
  ).execute(buildTaskGraph(intent()), { userPrompt: "write file" });
  return pass(
    "acceptance_blocks_false_success",
    "acceptanceValidation",
    result.status === "failed" &&
      result.finalResponseContract.canClaimSuccess === false,
    {
      status: result.status,
      failedReasons: result.failedReasons,
      canClaimSuccess: result.finalResponseContract.canClaimSuccess,
    },
  );
}

async function runReplanningCase(): Promise<TaskGraphQualityCaseResult> {
  let attempts = 0;
  const graph = buildTaskGraph(intent());
  graph.nodes[0].retryPolicy.maxAttempts = 1;
  const runtime = new AutonomousTaskRuntime(
    new DefaultTaskGraphCapabilityRegistry([
      adapter(["file.write"], (request) => {
        attempts += 1;
        return attempts === 1
          ? { status: "succeeded", output: { ok: true }, artifacts: [] }
          : {
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
  return pass(
    "replanning_retries_validation_failure",
    "replanning",
    result.status === "succeeded" &&
      result.replanDecisions.some(
        (decision) => decision.reasonCode === "file_artifact_missing_retry",
      ),
    {
      status: result.status,
      attempts,
      decisions: result.replanDecisions.map((decision) => decision.reasonCode),
    },
  );
}

async function runDurableStateCase(): Promise<TaskGraphQualityCaseResult> {
  const store = new InMemoryTaskGraphExecutionStore();
  const runtime = new AutonomousTaskRuntime(
    new DefaultTaskGraphCapabilityRegistry([
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
    { store },
  );
  const result = await runtime.run({
    intent: intent(),
    context: { userPrompt: "write file" },
  });
  const loaded = await store.load(result.snapshot.id);
  return pass(
    "durable_snapshot_saved",
    "durableState",
    loaded?.status === "succeeded" && loaded.artifacts.length === 1,
    {
      snapshotId: result.snapshot.id,
      status: loaded?.status,
      artifacts: loaded?.artifacts.length,
    },
  );
}

const results = [
  await runTaskEvaluationCase(),
  await runPlanningCase(),
  await runCapabilityCase(),
  await runOrderingCase(),
  await runAcceptanceCase(),
  await runReplanningCase(),
  await runDurableStateCase(),
];
const passed = results.filter((result) => result.passed).length;
const report = {
  generatedAt: new Date().toISOString(),
  passed,
  total: results.length,
  dimensions: Object.fromEntries(
    [...new Set(results.map((result) => result.dimension))].map((dimension) => {
      const dimensionResults = results.filter(
        (result) => result.dimension === dimension,
      );
      return [
        dimension,
        {
          passed: dimensionResults.filter((result) => result.passed).length,
          total: dimensionResults.length,
        },
      ];
    }),
  ),
  results,
};

await mkdir(logsDir, { recursive: true });
await writeFile(
  path.join(logsDir, "task-graph-quality-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
await writeFile(
  path.join(logsDir, "task-graph-quality-latest.md"),
  [
    "# Task Graph Quality Report",
    "",
    `Result: ${passed}/${results.length} passed`,
    "",
    ...results.map(
      (result) =>
        `- ${result.passed ? "PASS" : "FAIL"} ${result.dimension}/${result.id}: \`${JSON.stringify(
          result.details,
        )}\``,
    ),
    "",
  ].join("\n"),
);

for (const result of results) {
  console.log(
    `${result.passed ? "PASS" : "FAIL"} ${result.dimension}/${result.id}`,
  );
}
console.log(`Result: ${passed}/${results.length} passed`);

if (passed !== results.length) process.exit(1);
