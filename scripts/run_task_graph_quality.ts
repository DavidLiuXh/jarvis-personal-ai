/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IntentFrame, IntentStep } from "@jarvis/memory-runtime";
import {
  AutonomousTaskRuntime,
  DefaultTaskGraphCapabilityRegistry,
  InMemoryTaskGraphExecutionStore,
  JsonFileTaskGraphExecutionStore,
  TaskArtifactRegistry,
  TaskGraphExecutor,
  applyReplanDecision,
  buildRecoveryResumeState,
  buildTaskGraph,
  buildTaskGraphGoldenTrace,
  buildTaskSpec,
  decideTaskGraphRecovery,
  resumeStateFromSnapshot,
  snapshotTaskGraphExecution,
  validateAcceptanceCriterion,
  validateTaskGraph,
  validateTaskGraphGoldenTrace,
  validateTaskSpec,
  type AcceptanceCriteria,
  type ReplanDecision,
  type TaskGraph,
  type TaskGraphCapabilityAdapter,
  type TaskGraphExecutorEvent,
  type TaskNode,
  type TaskNodeExecutionRequest,
  type TaskNodeExecutionResult,
} from "@jarvis/intent-runtime";

type Dimension =
  | "taskEvaluation"
  | "taskGraphPlanning"
  | "capabilitySelection"
  | "executionOrdering"
  | "acceptanceValidation"
  | "replanning"
  | "durableState";

type CaseKind = "positive" | "negative" | "boundary";
type Phase = "P0" | "P1" | "P2" | "P3" | "P4" | "P5";

type TaskGraphQualityCaseResult = {
  id: string;
  dimension: Dimension;
  phase: Phase;
  kind: CaseKind;
  reviewed: true;
  passed: boolean;
  details: Record<string, unknown>;
};

type GoldenTraceCaseResult = {
  id: string;
  reviewed: true;
  passed: boolean;
  details: Record<string, unknown>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const logsDir = path.join(repoRoot, "evals", "logs");
const reviewedCasesPath = path.join(
  repoRoot,
  "evals",
  "task_graph",
  "reviewed-task-graph-cases.jsonl",
);
const dimensions: Dimension[] = [
  "taskEvaluation",
  "taskGraphPlanning",
  "capabilitySelection",
  "executionOrdering",
  "acceptanceValidation",
  "replanning",
  "durableState",
];

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
    intentSteps: [
      step({
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
      }),
    ],
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

function criterion(
  type: AcceptanceCriteria["type"],
  params: Record<string, unknown> = {},
): AcceptanceCriteria {
  return {
    id: `criterion-${type}`,
    scope: "step",
    type,
    description: `Validate ${type}`,
    required: true,
    validator: `${type}_validator`,
    params,
  };
}

function qualityCase(
  id: string,
  dimension: Dimension,
  phase: Phase,
  kind: CaseKind,
  passed: boolean,
  details: Record<string, unknown>,
): TaskGraphQualityCaseResult {
  return { id, dimension, phase, kind, reviewed: true, passed, details };
}

async function loadReviewedTaskGraphCases(): Promise<
  TaskGraphQualityCaseResult[]
> {
  let content = "";
  try {
    content = await readFile(reviewedCasesPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as Partial<TaskGraphQualityCaseResult>)
    .map((item, index) =>
      qualityCase(
        item.id ?? `reviewed-task-graph-case-${index + 1}`,
        item.dimension ?? "taskGraphPlanning",
        item.phase ?? "P1",
        item.kind ?? "boundary",
        item.passed === true,
        {
          ...(item.details ?? {}),
          source: "reviewed-task-graph-cases.jsonl",
        },
      ),
    );
}

function singleNodeGraph(node: Partial<TaskNode>): TaskGraph {
  return {
    id: "graph-quality",
    rootTaskId: "task-quality",
    nodes: [
      {
        id: "node-1",
        title: "quality node",
        kind: "respond",
        requiredCapabilities: ["llm.respond"],
        inputs: [],
        outputs: [
          {
            id: "node-1-message",
            type: "message",
            description: "message",
            required: true,
          },
        ],
        acceptanceCriteria: [criterion("response_contains")],
        retryPolicy: { maxAttempts: 1, strategy: "same" },
        optional: false,
        ...node,
      },
    ],
    edges: [],
    globalConstraints: [],
    acceptanceCriteria: [criterion("response_contains")],
    status: "planned",
    blockedReasons: [],
  };
}

async function executeGraph(
  graph: TaskGraph,
  adapters: TaskGraphCapabilityAdapter[],
  events: TaskGraphExecutorEvent[] = [],
) {
  return new TaskGraphExecutor(
    new DefaultTaskGraphCapabilityRegistry(adapters),
    {
      observer: (event) => {
        events.push(event);
      },
    },
  ).execute(graph, { userPrompt: "quality" });
}

function buildRecallWriteGraph() {
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
  return buildTaskGraph(intent({ intentSteps: [recall, write] }));
}

async function taskEvaluationCases(): Promise<TaskGraphQualityCaseResult[]> {
  const cases: TaskGraphQualityCaseResult[] = [];
  const add = (
    id: string,
    kind: CaseKind,
    frame: IntentFrame,
    check: (spec: ReturnType<typeof buildTaskSpec>) => boolean,
  ) => {
    const spec = buildTaskSpec(frame);
    cases.push(
      qualityCase(id, "taskEvaluation", "P0", kind, check(spec), {
        taskKind: spec.taskKind,
        criteria: spec.acceptanceCriteria.map((item) => item.type),
        requiredInputs: spec.requiredInputs.map((item) => item.id),
        childSpecs: spec.childSpecs.length,
        gates: validateTaskSpec(spec).filter((gate) => !gate.ok),
      }),
    );
  };

  add(
    "answer_has_response_criteria",
    "positive",
    intent({
      taskType: "chat",
      needsTool: false,
      reason: "answer question",
      evidence: ["answer question"],
      intentSteps: [],
      richIntent: {
        ...intent().richIntent,
        userGoal: "answer question",
        action: "answer",
        primaryAction: "answer",
        domain: "general_chat",
        contextDependency: {
          recentConversation: false,
          longTermMemory: false,
          localWorkspace: false,
          externalWorld: false,
        },
      },
    }),
    (spec) =>
      spec.taskKind === "answer" &&
      spec.acceptanceCriteria.some((item) => item.type === "response_contains"),
  );
  add(
    "recall_has_memory_criteria",
    "positive",
    intent({
      taskType: "recall",
      needsMemory: true,
      intentSteps: [],
      semanticEvidence: {
        ...intent().semanticEvidence,
        memoryRecall: {
          present: true,
          target: "conversation_history",
          reason: "recall",
          span: "",
        },
      },
      richIntent: {
        ...intent().richIntent,
        userGoal: "recall history",
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
    }),
    (spec) =>
      spec.taskKind === "memory_recall" &&
      spec.acceptanceCriteria.some((item) => item.type === "memory_retrieved"),
  );
  add(
    "schedule_has_task_scheduled",
    "positive",
    intent({
      taskType: "schedule",
      needsScheduling: true,
      intentSteps: [],
      richIntent: {
        ...intent().richIntent,
        userGoal: "每天8点提醒我复盘",
        domain: "task_management",
        action: "create",
        primaryAction: "schedule",
      },
    }),
    (spec) =>
      spec.taskKind === "schedule" &&
      spec.acceptanceCriteria.some((item) => item.type === "task_scheduled"),
  );
  add(
    "write_artifact_has_file_acceptance",
    "positive",
    intent(),
    (spec) =>
      spec.taskKind === "write_artifact" &&
      spec.acceptanceCriteria.some((item) => item.type === "file_exists"),
  );
  add(
    "research_has_source_criteria",
    "positive",
    intent({
      taskType: "analyze",
      needsExternalKnowledge: true,
      reason: "analyze market",
      evidence: ["analyze market"],
      intentSteps: [],
      richIntent: {
        ...intent().richIntent,
        userGoal: "analyze market",
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
    }),
    (spec) =>
      spec.taskKind === "research" &&
      spec.acceptanceCriteria.some((item) => item.type === "source_count"),
  );
  add(
    "multi_intent_generates_child_specs",
    "positive",
    intent({
      intentSteps: [
        step({
          id: "step-1",
          type: "recall",
          action: "recall",
          target: "history",
          operation: {
            domain: "memory_management",
            action: "recall",
            targetType: "memory",
            target: "history",
            riskLevel: "low",
          },
        }),
        step({
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
        }),
      ],
    }),
    (spec) => spec.taskKind === "mixed" && spec.childSpecs.length === 2,
  );
  add(
    "high_risk_requires_confirmation",
    "boundary",
    intent({
      richIntent: { ...intent().richIntent, riskLevel: "high" },
    }),
    (spec) =>
      spec.acceptanceCriteria.some((item) => item.type === "user_confirmed"),
  );
  add(
    "schedule_missing_time_requires_input",
    "negative",
    intent({
      taskType: "schedule",
      needsScheduling: true,
      intentSteps: [],
      richIntent: {
        ...intent().richIntent,
        userGoal: "提醒我复盘",
        domain: "task_management",
        action: "create",
        primaryAction: "schedule",
      },
    }),
    (spec) =>
      spec.requiresClarification &&
      spec.requiredInputs.some((item) => item.id === "schedule-time"),
  );
  add(
    "send_missing_channel_requires_input",
    "negative",
    intent({
      richIntent: {
        ...intent().richIntent,
        userGoal: "发送这份报告",
        action: "send",
        targets: [],
      },
    }),
    (spec) => spec.requiredInputs.some((item) => item.id === "channel-target"),
  );
  add(
    "spec_goal_is_structured_non_empty",
    "boundary",
    intent({
      richIntent: { ...intent().richIntent, userGoal: "  " },
      reason: "fallback goal",
    }),
    (spec) =>
      validateTaskSpec(spec).some(
        (gate) => gate.code === "task_spec_goal_present" && !gate.ok,
      ),
  );
  return cases;
}

async function planningCases(): Promise<TaskGraphQualityCaseResult[]> {
  const cases: TaskGraphQualityCaseResult[] = [];
  const add = (
    id: string,
    kind: CaseKind,
    graph: TaskGraph,
    check: (graph: TaskGraph) => boolean,
  ) =>
    cases.push(
      qualityCase(id, "taskGraphPlanning", "P1", kind, check(graph), {
        status: graph.status,
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          caps: node.requiredCapabilities,
          blocked: node.blockedReason,
        })),
        edges: graph.edges,
        blockedReasons: graph.blockedReasons,
        gates: validateTaskGraph(graph).filter((gate) => !gate.ok),
      }),
    );

  add(
    "multi_step_dependencies_explicit",
    "positive",
    buildRecallWriteGraph(),
    (graph) =>
      graph.nodes.length === 2 &&
      graph.edges.some(
        (edge) => edge.from === "step-1" && edge.to === "step-2",
      ),
  );
  add(
    "write_node_has_file_output",
    "positive",
    buildTaskGraph(intent()),
    (graph) =>
      graph.nodes[0].kind === "write_file" &&
      graph.nodes[0].outputs.some((item) => item.type === "file"),
  );
  add(
    "schedule_node_has_task_output",
    "positive",
    buildTaskGraph(
      intent({
        taskType: "schedule",
        needsScheduling: true,
        richIntent: {
          ...intent().richIntent,
          userGoal: "每天8点提醒我",
          domain: "task_management",
          action: "create",
          primaryAction: "schedule",
        },
        intentSteps: [
          step({
            id: "step-1",
            type: "schedule",
            action: "create",
            target: "每天8点提醒我",
            operation: {
              domain: "task_management",
              action: "create",
              targetType: "task",
              target: "每天8点提醒我",
              riskLevel: "medium",
            },
          }),
        ],
      }),
    ),
    (graph) =>
      graph.nodes[0].kind === "schedule" &&
      graph.nodes[0].acceptanceCriteria.some(
        (item) => item.type === "task_scheduled",
      ),
  );
  add(
    "recall_node_has_memory_output",
    "positive",
    buildTaskGraph(
      intent({
        taskType: "recall",
        needsMemory: true,
        intentSteps: [
          step({
            id: "step-1",
            type: "recall",
            action: "recall",
            target: "history",
            operation: {
              domain: "memory_management",
              action: "recall",
              targetType: "memory",
              target: "history",
              riskLevel: "low",
            },
          }),
        ],
      }),
    ),
    (graph) =>
      graph.nodes[0].kind === "recall" &&
      graph.nodes[0].requiredCapabilities.includes("memory.recall"),
  );
  add(
    "push_node_detected",
    "positive",
    buildTaskGraph(
      intent({
        intentSteps: [
          step({
            id: "step-1",
            type: "execute",
            action: "push",
            target: "wechat",
            operation: {
              domain: "external_knowledge",
              action: "send",
              targetType: "channel",
              target: "wechat",
              riskLevel: "medium",
            },
          }),
        ],
      }),
    ),
    (graph) =>
      graph.nodes[0].kind === "push" &&
      graph.nodes[0].requiredCapabilities.includes("channel.push"),
  );
  add(
    "run_shell_node_detected",
    "positive",
    buildTaskGraph(
      intent({
        intentSteps: [
          step({
            id: "step-1",
            type: "execute",
            action: "run curl",
            target: "curl https://example.com",
            operation: {
              domain: "system_control",
              action: "execute",
              targetType: "external_entity",
              target: "curl https://example.com",
              riskLevel: "medium",
            },
          }),
        ],
      }),
    ),
    (graph) =>
      graph.nodes[0].kind === "run_shell" &&
      graph.nodes[0].requiredCapabilities.includes("shell.run"),
  );
  add(
    "missing_capability_blocks",
    "negative",
    buildTaskGraph(intent(), undefined, {
      availableCapabilities: ["llm.respond"],
    }),
    (graph) =>
      graph.status === "blocked" &&
      graph.blockedReasons.some((reason) =>
        reason.includes("blocked_missing_capability:file.write"),
      ),
  );
  add(
    "external_memory_boundary_blocks_recall",
    "negative",
    buildTaskGraph(
      intent({
        taskType: "recall",
        needsMemory: true,
        intentSteps: [
          step({
            id: "step-1",
            type: "recall",
            action: "recall",
            target: "user memory",
            operation: {
              domain: "memory_management",
              action: "recall",
              targetType: "memory",
              target: "user memory",
              riskLevel: "low",
            },
          }),
        ],
      }),
      undefined,
      { memoryBoundary: "external" },
    ),
    (graph) =>
      graph.status === "blocked" &&
      graph.blockedReasons.join("\n").includes("external memory boundary"),
  );
  add(
    "channel_unavailable_blocks_push",
    "negative",
    buildTaskGraph(
      intent({
        intentSteps: [
          step({
            id: "step-1",
            type: "execute",
            action: "push",
            target: "wechat",
            operation: {
              domain: "external_knowledge",
              action: "send",
              targetType: "channel",
              target: "wechat",
              riskLevel: "medium",
            },
          }),
        ],
      }),
      undefined,
      { channelAvailable: false },
    ),
    (graph) =>
      graph.status === "blocked" &&
      graph.blockedReasons
        .join("\n")
        .includes("channel capability unavailable"),
  );
  add(
    "shell_network_disabled_blocks_curl",
    "boundary",
    buildTaskGraph(
      intent({
        intentSteps: [
          step({
            id: "step-1",
            type: "execute",
            action: "run curl",
            target: "curl https://example.com",
            operation: {
              domain: "system_control",
              action: "execute",
              targetType: "external_entity",
              target: "curl https://example.com",
              riskLevel: "medium",
            },
          }),
        ],
      }),
      undefined,
      { allowShellNetworkFetch: false },
    ),
    (graph) =>
      graph.status === "blocked" &&
      graph.blockedReasons.join("\n").includes("shell network fetch disabled"),
  );
  return cases;
}

async function capabilityCases(): Promise<TaskGraphQualityCaseResult[]> {
  const nodeCases: Array<[string, CaseKind, TaskGraph, string]> = [
    [
      "recall_capability",
      "positive",
      buildTaskGraph(
        intent({
          intentSteps: [
            step({
              id: "step-1",
              type: "recall",
              action: "recall",
              target: "history",
              operation: {
                domain: "memory_management",
                action: "recall",
                targetType: "memory",
                target: "history",
                riskLevel: "low",
              },
            }),
          ],
        }),
      ),
      "memory.recall",
    ],
    ["write_capability", "positive", buildTaskGraph(intent()), "file.write"],
    [
      "schedule_capability",
      "positive",
      buildTaskGraph(
        intent({
          taskType: "schedule",
          needsScheduling: true,
          intentSteps: [
            step({
              id: "step-1",
              type: "schedule",
              action: "create",
              target: "每天8点",
              operation: {
                domain: "task_management",
                action: "create",
                targetType: "task",
                target: "每天8点",
                riskLevel: "medium",
              },
            }),
          ],
        }),
      ),
      "task.schedule",
    ],
    [
      "push_capability",
      "positive",
      buildTaskGraph(
        intent({
          intentSteps: [
            step({
              id: "step-1",
              type: "execute",
              action: "push",
              target: "wechat",
              operation: {
                domain: "external_knowledge",
                action: "send",
                targetType: "channel",
                target: "wechat",
                riskLevel: "medium",
              },
            }),
          ],
        }),
      ),
      "channel.push",
    ],
    [
      "shell_capability",
      "positive",
      buildTaskGraph(
        intent({
          intentSteps: [
            step({
              id: "step-1",
              type: "execute",
              action: "run curl",
              target: "curl https://example.com",
              operation: {
                domain: "system_control",
                action: "execute",
                targetType: "external_entity",
                target: "curl https://example.com",
                riskLevel: "medium",
              },
            }),
          ],
        }),
      ),
      "shell.run",
    ],
    [
      "research_capability",
      "positive",
      buildTaskGraph(
        intent({
          taskType: "analyze",
          needsExternalKnowledge: true,
          reason: "research market",
          evidence: ["research market"],
          intentSteps: [],
          richIntent: {
            ...intent().richIntent,
            userGoal: "research market",
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
        }),
      ),
      "web.search",
    ],
    [
      "analyze_capability",
      "positive",
      buildTaskGraph(
        intent({
          intentSteps: [
            step({
              id: "step-1",
              type: "analyze",
              action: "analyze",
              target: "data",
              operation: {
                domain: "external_knowledge",
                action: "analyze",
                targetType: "external_entity",
                target: "data",
                riskLevel: "low",
              },
            }),
          ],
        }),
      ),
      "llm.analyze",
    ],
    [
      "delegate_capability",
      "positive",
      buildTaskGraph(
        intent({
          taskType: "delegate",
          intentSteps: [
            step({
              id: "step-1",
              type: "delegate",
              action: "delegate",
              target: "researcher",
              operation: {
                domain: "external_knowledge",
                action: "delegate",
                targetType: "agent",
                target: "researcher",
                riskLevel: "medium",
              },
            }),
          ],
        }),
      ),
      "subagent.delegate",
    ],
    [
      "respond_capability",
      "boundary",
      buildTaskGraph(
        intent({
          taskType: "chat",
          needsTool: false,
          reason: "answer question",
          evidence: ["answer question"],
          intentSteps: [],
          richIntent: {
            ...intent().richIntent,
            userGoal: "answer question",
            domain: "general_chat",
            action: "answer",
            primaryAction: "answer",
            contextDependency: {
              recentConversation: false,
              longTermMemory: false,
              localWorkspace: false,
              externalWorld: false,
            },
          },
        }),
      ),
      "llm.respond",
    ],
  ];
  const cases = nodeCases.map(([id, kind, graph, capability]) =>
    qualityCase(
      id,
      "capabilitySelection",
      "P2",
      kind,
      graph.nodes[0].requiredCapabilities.includes(capability),
      { capability, node: graph.nodes[0] },
    ),
  );
  const missing = buildTaskGraph(intent(), undefined, {
    availableCapabilities: ["llm.respond"],
  });
  cases.push(
    qualityCase(
      "missing_capability_blocks_not_fallback",
      "capabilitySelection",
      "P2",
      "negative",
      missing.status === "blocked",
      { status: missing.status, blockedReasons: missing.blockedReasons },
    ),
  );
  return cases;
}

async function orderingCases(): Promise<TaskGraphQualityCaseResult[]> {
  const cases: TaskGraphQualityCaseResult[] = [];
  const add = (
    id: string,
    kind: CaseKind,
    passed: boolean,
    details: Record<string, unknown>,
  ) =>
    cases.push(
      qualityCase(id, "executionOrdering", "P2", kind, passed, details),
    );

  const graph = buildRecallWriteGraph();
  const order: string[] = [];
  const result = await executeGraph(graph, [
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
  ]);
  add(
    "two_step_dependency_order",
    "positive",
    result.status === "succeeded" && order.join(",") === "step-1,step-2",
    { status: result.status, order },
  );

  const chain = buildTaskGraph(
    intent({
      intentSteps: [
        step({
          id: "a",
          type: "recall",
          action: "recall",
          target: "history",
          operation: {
            domain: "memory_management",
            action: "recall",
            targetType: "memory",
            target: "history",
            riskLevel: "low",
          },
        }),
        step({
          id: "b",
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
          dependsOn: ["a"],
        }),
        step({
          id: "c",
          type: "execute",
          action: "push",
          target: "wechat",
          operation: {
            domain: "external_knowledge",
            action: "send",
            targetType: "channel",
            target: "wechat",
            riskLevel: "medium",
          },
          dependsOn: ["b"],
        }),
      ],
    }),
  );
  const chainOrder: string[] = [];
  const chainResult = await executeGraph(chain, [
    adapter(["memory.recall"], (request) => {
      chainOrder.push(request.node.id);
      return {
        status: "succeeded",
        output: { empty: true },
        artifacts: [
          { id: "m", nodeId: request.node.id, type: "memory", memoryItems: [] },
        ],
      };
    }),
    adapter(["file.write"], (request) => {
      chainOrder.push(request.node.id);
      return {
        status: "succeeded",
        output: { path: "summary.md" },
        artifacts: [
          {
            id: "f",
            nodeId: request.node.id,
            type: "file",
            path: "summary.md",
            exists: true,
          },
        ],
      };
    }),
    adapter(["channel.push"], (request) => {
      chainOrder.push(request.node.id);
      return {
        status: "succeeded",
        output: { ok: true },
        artifacts: [
          {
            id: "p",
            nodeId: request.node.id,
            type: "message",
            content: "pushed",
          },
        ],
      };
    }),
  ]);
  add(
    "three_step_chain_order",
    "positive",
    chainResult.status === "succeeded" && chainOrder.join(",") === "a,b,c",
    { status: chainResult.status, order: chainOrder },
  );

  const failedUpstream = await executeGraph(buildRecallWriteGraph(), [
    adapter(["memory.recall"], () => ({
      status: "failed",
      error: "memory unavailable",
      output: { error: "memory unavailable" },
    })),
    adapter(["file.write"], () => ({
      status: "succeeded",
      output: { path: "summary.md" },
      artifacts: [
        {
          id: "file",
          nodeId: "step-2",
          type: "file",
          path: "summary.md",
          exists: true,
        },
      ],
    })),
  ]);
  add(
    "failed_required_blocks_downstream",
    "negative",
    failedUpstream.nodes.find((node) => node.node.id === "step-2")?.status ===
      "blocked",
    {
      statuses: failedUpstream.nodes.map((node) => [node.node.id, node.status]),
    },
  );

  const independent = singleNodeGraph({
    requiredCapabilities: ["llm.respond"],
    acceptanceCriteria: [criterion("response_contains")],
  });
  independent.nodes.push({
    ...independent.nodes[0],
    id: "node-2",
    title: "second",
    inputs: [],
  });
  const independentOrder: string[] = [];
  const independentResult = await executeGraph(independent, [
    adapter(["llm.respond"], (request) => {
      independentOrder.push(request.node.id);
      return { status: "succeeded", output: "quality node", artifacts: [] };
    }),
  ]);
  add(
    "independent_nodes_execute_without_dependencies",
    "boundary",
    independentResult.status === "succeeded" && independentOrder.length === 2,
    { order: independentOrder },
  );

  const blockedGraph = buildTaskGraph(intent(), undefined, {
    availableCapabilities: ["llm.respond"],
  });
  const blockedResult = await executeGraph(blockedGraph, []);
  add(
    "blocked_node_not_executed",
    "negative",
    blockedResult.nodes[0].attempts === 0 &&
      blockedResult.nodes[0].status === "blocked",
    {
      attempts: blockedResult.nodes[0].attempts,
      status: blockedResult.nodes[0].status,
    },
  );

  const retryGraph = buildTaskGraph(intent());
  let retryAttempts = 0;
  const retryResult = await executeGraph(retryGraph, [
    adapter(["file.write"], (request) => {
      retryAttempts += 1;
      return retryAttempts === 1
        ? { status: "failed", error: "transient", output: "failed" }
        : {
            status: "succeeded",
            output: { path: "summary.md" },
            artifacts: [
              {
                id: "file",
                nodeId: request.node.id,
                type: "file",
                path: "summary.md",
                exists: true,
              },
            ],
          };
    }),
  ]);
  add(
    "retry_stays_on_same_node_before_success",
    "boundary",
    retryResult.status === "succeeded" && retryAttempts === 2,
    { retryAttempts },
  );

  const resumeGraph = buildRecallWriteGraph();
  const firstResult = await executeGraph(resumeGraph, [
    adapter(["memory.recall"], (request) => ({
      status: "succeeded",
      output: { items: ["history"] },
      artifacts: [
        {
          id: "memory",
          nodeId: request.node.id,
          type: "memory",
          memoryItems: ["history"],
        },
      ],
    })),
    adapter(["file.write"], () => ({
      status: "succeeded",
      output: { ok: true },
      artifacts: [],
    })),
  ]);
  const snapshot = snapshotTaskGraphExecution(firstResult);
  const resumeOrder: string[] = [];
  const resumed = await new TaskGraphExecutor(
    new DefaultTaskGraphCapabilityRegistry([
      adapter(["memory.recall"], (request) => {
        resumeOrder.push(request.node.id);
        return { status: "succeeded", output: {}, artifacts: [] };
      }),
      adapter(["file.write"], (request) => {
        resumeOrder.push(request.node.id);
        return {
          status: "succeeded",
          output: { path: "summary.md" },
          artifacts: [
            {
              id: "file",
              nodeId: request.node.id,
              type: "file",
              path: "summary.md",
              exists: true,
            },
          ],
        };
      }),
    ]),
  ).execute(resumeGraph, {
    userPrompt: "resume",
    resumeState: resumeStateFromSnapshot(snapshot),
  });
  add(
    "resume_skips_succeeded_upstream",
    "boundary",
    resumed.status === "succeeded" && resumeOrder.join(",") === "step-2",
    { order: resumeOrder },
  );

  const cycleGraph = buildRecallWriteGraph();
  cycleGraph.edges.push({ from: "step-2", to: "step-1", reason: "cycle" });
  add(
    "acyclic_gate_detects_cycle",
    "negative",
    validateTaskGraph(cycleGraph).some(
      (gate) => gate.code === "task_graph_acyclic" && !gate.ok,
    ),
    { gates: validateTaskGraph(cycleGraph) },
  );

  const dependencyOutputsGraph = buildRecallWriteGraph();
  let sawDependencyOutput = false;
  const dependencyResult = await executeGraph(dependencyOutputsGraph, [
    adapter(["memory.recall"], (request) => ({
      status: "succeeded",
      output: { text: "history" },
      artifacts: [
        {
          id: "memory",
          nodeId: request.node.id,
          type: "memory",
          memoryItems: ["history"],
        },
      ],
    })),
    adapter(["file.write"], (request) => {
      sawDependencyOutput =
        (request.dependencyOutputs["step-1"] as any)?.text === "history";
      return {
        status: "succeeded",
        output: { path: "summary.md" },
        artifacts: [
          {
            id: "file",
            nodeId: request.node.id,
            type: "file",
            path: "summary.md",
            exists: true,
          },
        ],
      };
    }),
  ]);
  add(
    "dependency_outputs_available_to_downstream",
    "positive",
    dependencyResult.status === "succeeded" && sawDependencyOutput,
    { sawDependencyOutput },
  );

  const noProgress = singleNodeGraph({
    inputs: [
      { sourceNodeId: "missing", name: "missing.output", required: true },
    ],
  });
  const noProgressResult = await executeGraph(noProgress, [
    adapter(["llm.respond"], () => ({
      status: "succeeded",
      output: "ok",
      artifacts: [],
    })),
  ]);
  add(
    "unresolved_dependency_blocks_node",
    "negative",
    noProgressResult.nodes[0].status === "blocked",
    {
      status: noProgressResult.nodes[0].status,
      reason: noProgressResult.nodes[0].lastError,
    },
  );
  return cases;
}

async function acceptanceCases(): Promise<TaskGraphQualityCaseResult[]> {
  const cases: TaskGraphQualityCaseResult[] = [];
  const check = (
    id: string,
    kind: CaseKind,
    criterionToCheck: AcceptanceCriteria,
    passed: boolean,
    details: Record<string, unknown>,
  ) =>
    cases.push(
      qualityCase(id, "acceptanceValidation", "P3", kind, passed, {
        criterion: criterionToCheck.type,
        ...details,
      }),
    );
  const baseResult = {
    status: "succeeded" as const,
    output: { id: "task-1", taskId: "task-1", sources: ["s1"] },
    artifacts: [],
  };
  const ctx = {
    userPrompt: "quality",
    finalResponse: "answer contains goal",
    userConfirmed: true,
  };
  const validators: Array<
    [
      string,
      CaseKind,
      AcceptanceCriteria,
      Parameters<typeof validateAcceptanceCriterion>[1],
      boolean,
    ]
  > = [
    [
      "tool_result_success",
      "positive",
      criterion("tool_result"),
      { result: baseResult, artifacts: [], context: ctx },
      true,
    ],
    [
      "file_exists_success",
      "positive",
      criterion("file_exists"),
      {
        result: baseResult,
        artifacts: [
          { id: "f", nodeId: "n", type: "file", path: "a.md", exists: true },
        ],
        context: ctx,
      },
      true,
    ],
    [
      "file_contains_success",
      "positive",
      criterion("file_contains", { contains: ["hello"] }),
      {
        result: baseResult,
        artifacts: [
          {
            id: "f",
            nodeId: "n",
            type: "file",
            path: "a.md",
            content: "hello",
            exists: true,
          },
        ],
        context: ctx,
      },
      true,
    ],
    [
      "response_contains_success",
      "positive",
      criterion("response_contains", { contains: ["answer"] }),
      { result: baseResult, artifacts: [], context: ctx },
      true,
    ],
    [
      "source_count_success",
      "positive",
      criterion("source_count", { minSources: 1 }),
      { result: baseResult, artifacts: [], context: ctx },
      true,
    ],
    [
      "memory_retrieved_success",
      "positive",
      criterion("memory_retrieved"),
      {
        result: baseResult,
        artifacts: [
          { id: "m", nodeId: "n", type: "memory", memoryItems: ["memory"] },
        ],
        context: ctx,
      },
      true,
    ],
    [
      "task_scheduled_success",
      "positive",
      criterion("task_scheduled"),
      {
        result: baseResult,
        artifacts: [
          { id: "t", nodeId: "n", type: "scheduled_task", taskId: "task-1" },
        ],
        context: ctx,
      },
      true,
    ],
    [
      "user_confirmed_success",
      "boundary",
      criterion("user_confirmed"),
      { result: baseResult, artifacts: [], context: ctx },
      true,
    ],
    [
      "file_exists_failure_blocks",
      "negative",
      criterion("file_exists"),
      { result: baseResult, artifacts: [], context: ctx },
      false,
    ],
    [
      "final_response_overclaim_blocked",
      "negative",
      criterion("response_contains", { contains: ["done"] }),
      {
        result: {
          status: "failed" as const,
          output: "failed",
          error: "no file",
        },
        artifacts: [],
        context: { userPrompt: "quality", finalResponse: "" },
      },
      false,
    ],
  ];
  for (const [id, kind, item, input, expected] of validators) {
    const result = validateAcceptanceCriterion(item, input);
    check(id, kind, item, result.ok === expected, result);
  }
  return cases;
}

async function replanningCases(): Promise<TaskGraphQualityCaseResult[]> {
  const cases: TaskGraphQualityCaseResult[] = [];
  const add = (
    id: string,
    kind: CaseKind,
    decision: ReplanDecision,
    expected: ReplanDecision["action"],
  ) =>
    cases.push(
      qualityCase(id, "replanning", "P5", kind, decision.action === expected, {
        decision,
      }),
    );

  const failedFile = await executeGraph(buildTaskGraph(intent()), [
    adapter(["file.write"], () => ({
      status: "succeeded",
      output: { ok: true },
      artifacts: [],
    })),
  ]);
  add(
    "file_artifact_missing_retries",
    "positive",
    decideTaskGraphRecovery({ result: failedFile }),
    "retry_same",
  );
  add(
    "recovery_attempt_limit_aborts",
    "negative",
    decideTaskGraphRecovery({
      result: failedFile,
      recoveryAttempts: 2,
      maxRecoveryAttempts: 2,
    }),
    "abort",
  );

  const sourceGraph = singleNodeGraph({
    kind: "analyze",
    requiredCapabilities: ["llm.analyze"],
    acceptanceCriteria: [criterion("source_count", { minSources: 1 })],
  });
  const sourceResult = await executeGraph(sourceGraph, [
    adapter(["llm.analyze"], () => ({
      status: "succeeded",
      output: { summary: "x" },
      artifacts: [],
    })),
  ]);
  const sourceDecision = decideTaskGraphRecovery({
    result: sourceResult,
    availableCapabilities: ["web.search"],
  });
  add(
    "source_coverage_switches_capability",
    "positive",
    sourceDecision,
    "switch_capability",
  );
  const patched = applyReplanDecision(sourceGraph, sourceDecision);
  cases.push(
    qualityCase(
      "repair_node_added_to_graph",
      "replanning",
      "P5",
      "boundary",
      patched.nodes.length === 2 && patched.edges.length === 1,
      { nodes: patched.nodes.map((node) => node.id), edges: patched.edges },
    ),
  );

  const policyGraph = singleNodeGraph({
    kind: "run_shell",
    requiredCapabilities: ["shell.run"],
    blockedReason: "shell network fetch disabled by workspace policy",
  });
  const policyResult = await executeGraph(policyGraph, []);
  add(
    "policy_blocker_asks_user",
    "negative",
    decideTaskGraphRecovery({ result: policyResult }),
    "ask_user",
  );

  const missingInputGraph = singleNodeGraph({
    blockedReason: "schedule_step_missing_time",
  });
  const missingInputResult = await executeGraph(missingInputGraph, []);
  add(
    "missing_input_asks_user",
    "negative",
    decideTaskGraphRecovery({ result: missingInputResult }),
    "ask_user",
  );

  const transientGraph = singleNodeGraph({
    retryPolicy: { maxAttempts: 2, strategy: "same" },
  });
  const transientResult = await executeGraph(transientGraph, [
    adapter(["llm.respond"], () => ({
      status: "failed",
      error: "temporary outage",
      output: "failed",
    })),
  ]);
  transientResult.nodes[0].attempts = 0;
  add(
    "transient_failure_retries",
    "positive",
    decideTaskGraphRecovery({ result: transientResult }),
    "retry_same",
  );

  const optionalGraph = singleNodeGraph({ optional: true });
  const optionalResult = await executeGraph(optionalGraph, [
    adapter(["llm.respond"], () => ({
      status: "failed",
      error: "optional failed",
      output: "failed",
    })),
  ]);
  add(
    "optional_failure_skips",
    "boundary",
    decideTaskGraphRecovery({ result: optionalResult }),
    "skip_optional",
  );

  const noFailureGraph = singleNodeGraph({});
  const noFailureResult = await executeGraph(noFailureGraph, [
    adapter(["llm.respond"], () => ({
      status: "succeeded",
      output: "quality node",
      artifacts: [],
    })),
  ]);
  add(
    "no_failure_not_recoverable",
    "boundary",
    decideTaskGraphRecovery({ result: noFailureResult }),
    "abort",
  );

  const resume = buildRecoveryResumeState(
    failedFile,
    decideTaskGraphRecovery({ result: failedFile }),
  );
  cases.push(
    qualityCase(
      "recovery_resume_drops_failed_node_artifacts",
      "replanning",
      "P5",
      "boundary",
      resume.nodes.every((node) => node.nodeId !== "step-1"),
      { resume },
    ),
  );
  return cases;
}

async function durableCases(): Promise<TaskGraphQualityCaseResult[]> {
  const cases: TaskGraphQualityCaseResult[] = [];
  const store = new InMemoryTaskGraphExecutionStore();
  const success = await executeGraph(buildTaskGraph(intent()), [
    adapter(["file.write"], (request) => ({
      status: "succeeded",
      output: { path: "summary.md" },
      artifacts: [
        {
          id: "file",
          nodeId: request.node.id,
          type: "file",
          path: "summary.md",
          exists: true,
          content: "hello",
        },
      ],
    })),
  ]);
  const snapshot = snapshotTaskGraphExecution(success);
  await store.save(snapshot);
  const loaded = await store.load(snapshot.id);
  cases.push(
    qualityCase(
      "in_memory_store_save_load",
      "durableState",
      "P4",
      "positive",
      loaded?.id === snapshot.id,
      { loaded: loaded?.id },
    ),
  );
  cases.push(
    qualityCase(
      "snapshot_records_artifacts",
      "durableState",
      "P4",
      "positive",
      loaded?.artifacts.length === 1,
      { artifacts: loaded?.artifacts.length },
    ),
  );
  cases.push(
    qualityCase(
      "snapshot_records_validation_results",
      "durableState",
      "P4",
      "positive",
      (loaded?.nodes[0].acceptanceResults.length ?? 0) > 0,
      { validators: loaded?.nodes[0].acceptanceResults },
    ),
  );
  await store.appendEvent(snapshot.id, {
    type: "task_graph_finished",
    graphId: success.graph.id,
    status: "succeeded",
    blocked: 0,
    failed: 0,
  });
  cases.push(
    qualityCase(
      "store_appends_events",
      "durableState",
      "P4",
      "positive",
      (await store.load(snapshot.id))?.events.length === 1,
      { events: (await store.load(snapshot.id))?.events.length },
    ),
  );
  cases.push(
    qualityCase(
      "store_lists_by_status",
      "durableState",
      "P4",
      "positive",
      (await store.list({ status: "succeeded" })).length === 1,
      { listed: (await store.list({ status: "succeeded" })).length },
    ),
  );
  cases.push(
    qualityCase(
      "resume_state_preserves_succeeded_nodes",
      "durableState",
      "P4",
      "boundary",
      resumeStateFromSnapshot(snapshot).nodes[0].status === "succeeded",
      { resume: resumeStateFromSnapshot(snapshot).nodes[0] },
    ),
  );

  const failed = await executeGraph(buildTaskGraph(intent()), [
    adapter(["file.write"], () => ({
      status: "succeeded",
      output: { ok: true },
      artifacts: [],
    })),
  ]);
  const failedSnapshot = snapshotTaskGraphExecution(failed);
  cases.push(
    qualityCase(
      "failure_root_cause_recorded",
      "durableState",
      "P4",
      "negative",
      Boolean(failedSnapshot.failureRootCause),
      { failureRootCause: failedSnapshot.failureRootCause },
    ),
  );

  const registry = new TaskArtifactRegistry();
  const registered = registry.register({
    id: "artifact-1",
    nodeId: "step-1",
    type: "file",
    path: "a.md",
    content: "hello",
    exists: true,
  });
  cases.push(
    qualityCase(
      "artifact_registry_adds_metadata",
      "durableState",
      "P4",
      "positive",
      Boolean(registered.sourceNodeId && registered.createdAt),
      { artifact: registered },
    ),
  );
  cases.push(
    qualityCase(
      "artifact_registry_find_by_type",
      "durableState",
      "P4",
      "positive",
      registry.findByType("file").length === 1,
      { files: registry.findByType("file").length },
    ),
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "task-graph-quality-"));
  try {
    const fileStore = new JsonFileTaskGraphExecutionStore(dir);
    await fileStore.save(snapshot);
    cases.push(
      qualityCase(
        "json_file_store_roundtrip",
        "durableState",
        "P4",
        "boundary",
        (await fileStore.load(snapshot.id))?.id === snapshot.id,
        { dir },
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return cases;
}

async function goldenTraceCases(): Promise<GoldenTraceCaseResult[]> {
  const frame = intent();
  const spec = buildTaskSpec(frame);
  const graph = buildTaskGraph(frame, spec);
  const events: TaskGraphExecutorEvent[] = [];
  const execution = await executeGraph(
    graph,
    [
      adapter(["file.write"], (request) => ({
        status: "succeeded",
        output: { path: "summary.md" },
        artifacts: [
          {
            id: "file",
            nodeId: request.node.id,
            type: "file",
            path: "summary.md",
            exists: true,
            content: "hello",
          },
        ],
      })),
    ],
    events,
  );
  const trace = buildTaskGraphGoldenTrace({
    taskSpec: spec,
    taskGraph: graph,
    execution,
    events,
  });
  const health = validateTaskGraphGoldenTrace(trace);
  const badTrace = buildTaskGraphGoldenTrace({
    taskSpec: spec,
    taskGraph: graph,
    execution,
    events: [],
  });
  const badHealth = validateTaskGraphGoldenTrace(badTrace);
  return [
    {
      id: "golden_trace_contains_spec_graph_execution",
      reviewed: true,
      passed:
        trace.taskSpec.acceptanceCriteria.length > 0 &&
        trace.taskGraph.nodes.length > 0 &&
        trace.execution.nodes.length > 0,
      details: { trace },
    },
    {
      id: "golden_trace_health_passes_for_valid_execution",
      reviewed: true,
      passed: health.ok,
      details: health,
    },
    {
      id: "golden_trace_detects_unexecuted_success",
      reviewed: true,
      passed:
        !badHealth.ok &&
        badHealth.violations.some((item) =>
          item.includes("node_succeeded_without_start_event"),
        ),
      details: badHealth,
    },
  ];
}

function coverageSummary(results: TaskGraphQualityCaseResult[]) {
  return Object.fromEntries(
    dimensions.map((dimension) => {
      const dimensionResults = results.filter(
        (result) => result.dimension === dimension,
      );
      return [
        dimension,
        {
          reviewed: dimensionResults.filter((result) => result.reviewed).length,
          passed: dimensionResults.filter((result) => result.passed).length,
          total: dimensionResults.length,
          kinds: Object.fromEntries(
            ["positive", "negative", "boundary"].map((kind) => [
              kind,
              dimensionResults.filter((result) => result.kind === kind).length,
            ]),
          ),
        },
      ];
    }),
  );
}

function gateResults(
  results: TaskGraphQualityCaseResult[],
  goldenTrace: GoldenTraceCaseResult[],
) {
  const coverage = coverageSummary(results);
  const gates = [
    {
      id: "all_task_graph_cases_pass",
      passed: results.every((result) => result.passed),
      actual: `${results.filter((result) => result.passed).length}/${results.length}`,
      expected: "passed=total",
    },
    {
      id: "ten_reviewed_cases_per_dimension",
      passed: dimensions.every(
        (dimension) => coverage[dimension].reviewed >= 10,
      ),
      actual: Object.fromEntries(
        dimensions.map((dimension) => [
          dimension,
          coverage[dimension].reviewed,
        ]),
      ),
      expected: ">=10 each",
    },
    {
      id: "positive_negative_boundary_coverage",
      passed: dimensions.every(
        (dimension) =>
          coverage[dimension].kinds.positive > 0 &&
          coverage[dimension].kinds.negative > 0 &&
          coverage[dimension].kinds.boundary > 0,
      ),
      actual: Object.fromEntries(
        dimensions.map((dimension) => [dimension, coverage[dimension].kinds]),
      ),
      expected: "each dimension has positive, negative, boundary",
    },
    {
      id: "p0_to_p5_phase_coverage",
      passed: ["P0", "P1", "P2", "P3", "P4", "P5"].every((phase) =>
        results.some((result) => result.phase === phase),
      ),
      actual: [...new Set(results.map((result) => result.phase))].sort(),
      expected: ["P0", "P1", "P2", "P3", "P4", "P5"],
    },
    {
      id: "golden_trace_health",
      passed: goldenTrace.every((result) => result.passed),
      actual: `${goldenTrace.filter((result) => result.passed).length}/${goldenTrace.length}`,
      expected: "passed=total",
    },
  ];
  return gates;
}

const results = [
  ...(await taskEvaluationCases()),
  ...(await planningCases()),
  ...(await capabilityCases()),
  ...(await orderingCases()),
  ...(await acceptanceCases()),
  ...(await replanningCases()),
  ...(await durableCases()),
  ...(await loadReviewedTaskGraphCases()),
];
const goldenTrace = await goldenTraceCases();
const gates = gateResults(results, goldenTrace);
const passed = results.filter((result) => result.passed).length;
const report = {
  generatedAt: new Date().toISOString(),
  passed,
  total: results.length,
  reviewed: results.filter((result) => result.reviewed).length,
  dimensions: coverageSummary(results),
  goldenTrace,
  gates,
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
    `Reviewed cases: ${report.reviewed}`,
    "",
    "## Gates",
    "",
    ...gates.map(
      (gate) =>
        `- ${gate.passed ? "PASS" : "FAIL"} ${gate.id}: actual=\`${JSON.stringify(gate.actual)}\`, expected=\`${JSON.stringify(gate.expected)}\``,
    ),
    "",
    "## Dimensions",
    "",
    ...dimensions.map(
      (dimension) =>
        `- ${dimension}: ${report.dimensions[dimension].passed}/${report.dimensions[dimension].total}, reviewed=${report.dimensions[dimension].reviewed}, kinds=\`${JSON.stringify(report.dimensions[dimension].kinds)}\``,
    ),
    "",
    "## Cases",
    "",
    ...results.map(
      (result) =>
        `- ${result.passed ? "PASS" : "FAIL"} ${result.dimension}/${result.id}: \`${JSON.stringify(result.details)}\``,
    ),
    "",
  ].join("\n"),
);

for (const result of results) {
  console.log(
    `${result.passed ? "PASS" : "FAIL"} ${result.dimension}/${result.id}`,
  );
}
for (const gate of gates) {
  console.log(`${gate.passed ? "PASS" : "FAIL"} gate/${gate.id}`);
}
console.log(`Result: ${passed}/${results.length} passed`);

if (passed !== results.length || gates.some((gate) => !gate.passed)) {
  process.exit(1);
}
