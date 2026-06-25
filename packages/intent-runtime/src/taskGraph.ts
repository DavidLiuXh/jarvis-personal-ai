/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IntentFrame,
  IntentStep,
  IntentTaskType,
  MemoryRecallTarget,
  QuerySubject,
  RichIntentRiskLevel,
} from "@jarvis/memory-runtime";

export type TaskKind =
  | "answer"
  | "research"
  | "write_artifact"
  | "modify_workspace"
  | "schedule"
  | "memory_recall"
  | "delegate"
  | "mixed";

export type TaskConstraint = {
  id: string;
  description: string;
  source: "intent" | "memory_contract" | "workspace_policy" | "user";
};

export type TaskRequirement = {
  id: string;
  field: string;
  reason: string;
  blocking: boolean;
};

export type TaskArtifactSpec = {
  id: string;
  type: "file" | "message" | "report" | "memory" | "scheduled_task" | "source";
  description: string;
  required: boolean;
};

export type AcceptanceCriteriaType =
  | "tool_result"
  | "file_exists"
  | "file_contains"
  | "response_contains"
  | "source_count"
  | "memory_retrieved"
  | "task_scheduled"
  | "user_confirmed"
  | "custom";

export type AcceptanceCriteria = {
  id: string;
  scope: "task" | "step" | "artifact" | "final_response";
  type: AcceptanceCriteriaType;
  description: string;
  required: boolean;
  validator: string;
  params: Record<string, unknown>;
};

export type TaskSpec = {
  id: string;
  userGoal: string;
  taskKind: TaskKind;
  constraints: TaskConstraint[];
  requiredInputs: TaskRequirement[];
  expectedArtifacts: TaskArtifactSpec[];
  acceptanceCriteria: AcceptanceCriteria[];
  riskLevel: RichIntentRiskLevel;
  requiresClarification: boolean;
  sourceIntentId: string;
  childSpecs: TaskSpec[];
};

export type TaskGraphNodeKind =
  | "recall"
  | "research"
  | "analyze"
  | "write_file"
  | "read_file"
  | "run_shell"
  | "schedule"
  | "push"
  | "delegate"
  | "respond";

export type TaskInputRef = {
  sourceNodeId?: string;
  name: string;
  required: boolean;
};

export type TaskOutputSpec = {
  id: string;
  type: TaskArtifactSpec["type"];
  description: string;
  required: boolean;
};

export type RetryPolicy = {
  maxAttempts: number;
  strategy: "none" | "same" | "repair";
};

export type TaskNode = {
  id: string;
  title: string;
  kind: TaskGraphNodeKind;
  requiredCapabilities: string[];
  inputs: TaskInputRef[];
  outputs: TaskOutputSpec[];
  acceptanceCriteria: AcceptanceCriteria[];
  retryPolicy: RetryPolicy;
  timeoutMs?: number;
  optional: boolean;
  blockedReason?: string;
};

export type TaskEdge = {
  from: string;
  to: string;
  reason: string;
};

export type TaskGraphStatus =
  | "planned"
  | "running"
  | "blocked"
  | "failed"
  | "succeeded";

export type TaskGraph = {
  id: string;
  rootTaskId: string;
  nodes: TaskNode[];
  edges: TaskEdge[];
  globalConstraints: TaskConstraint[];
  acceptanceCriteria: AcceptanceCriteria[];
  status: TaskGraphStatus;
  blockedReasons: string[];
};

export type TaskRuntimeContext = {
  availableCapabilities?: string[];
  channelAvailable?: boolean;
  allowShellNetworkFetch?: boolean;
  memoryBoundary?: QuerySubject;
};

export type TaskGateResult = {
  ok: boolean;
  code: string;
  message: string;
  blocking: boolean;
};

const DEFAULT_CAPABILITIES = new Set([
  "llm.respond",
  "llm.analyze",
  "memory.recall",
  "file.read",
  "file.write",
  "shell.run",
  "web.fetch",
  "web.search",
  "task.schedule",
  "channel.push",
  "skill.activate",
  "subagent.delegate",
]);

function stableId(prefix: string, text: string, index = 0): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${prefix}-${normalized || "task"}-${index + 1}`;
}

function hasAny(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

const SOURCE_ACQUISITION_RE =
  /\b(?:collect|search|fetch|crawl|scrape|source|sources|sites|news|authoritative|websites?|articles?|references?)\b|资料|素材|来源|信源|网站|网页|新闻|权威|收集|检索|搜索|抓取|爬取|查找|整理来源/i;

const EXPLICIT_FILE_WRITE_RE =
  /\b(?:write|save|export|persist|create|update)\b.*\b(?:file|document|report|markdown|md|html|txt|json|csv)\b|保存|写入|写成|保存成|导出|输出到|落地|本地(?:文件|文档)|(?:markdown|md|html|txt|json|csv)\s*(?:文件|文档|报告)|\.(?:md|markdown|txt|json|html|csv|ts|tsx|js|py|yaml|yml)\b/i;

function isSourceAcquisitionText(text: string): boolean {
  return hasAny(text, SOURCE_ACQUISITION_RE);
}

function isExplicitFileWriteText(text: string): boolean {
  return hasAny(text, EXPLICIT_FILE_WRITE_RE);
}

function taskKindFromIntent(intent: IntentFrame): TaskKind {
  if (intent.intentSteps.length > 1) return "mixed";
  if (intent.taskType === "schedule") return "schedule";
  if (intent.taskType === "recall") return "memory_recall";
  if (intent.taskType === "delegate") return "delegate";
  const goal = `${intent.richIntent.userGoal} ${intent.reason} ${intent.evidence.join(" ")}`;
  if (
    hasAny(
      goal,
      /保存|写入|写成|生成.*(?:markdown|md|文件|文档|报告)|\.md\b|file|document|report/i,
    )
  ) {
    return "write_artifact";
  }
  if (
    intent.taskType === "execute" ||
    intent.richIntent.contextDependency.localWorkspace
  ) {
    return "modify_workspace";
  }
  if (
    intent.taskType === "analyze" ||
    intent.richIntent.contextDependency.externalWorld
  ) {
    return "research";
  }
  return "answer";
}

function artifactSpecsForKind(
  kind: TaskKind,
  intent: IntentFrame,
): TaskArtifactSpec[] {
  if (kind === "write_artifact") {
    return [
      {
        id: "artifact-file-1",
        type: "file",
        description: `File artifact for: ${intent.richIntent.userGoal}`,
        required: true,
      },
    ];
  }
  if (kind === "schedule") {
    return [
      {
        id: "artifact-scheduled-task-1",
        type: "scheduled_task",
        description: "Scheduled task registered in Jarvis TaskScheduler.",
        required: true,
      },
    ];
  }
  if (kind === "research") {
    return [
      {
        id: "artifact-source-collection-1",
        type: "source",
        description:
          "Source collection or evidence gathered for downstream analysis.",
        required: true,
      },
    ];
  }
  if (kind === "memory_recall") {
    return [
      {
        id: "artifact-memory-1",
        type: "memory",
        description: "Relevant recalled memory evidence.",
        required: true,
      },
    ];
  }
  return [
    {
      id: "artifact-message-1",
      type: "message",
      description: "Final response answers the user goal.",
      required: true,
    },
  ];
}

function criteria(
  id: string,
  type: AcceptanceCriteriaType,
  description: string,
  params: Record<string, unknown> = {},
  scope: AcceptanceCriteria["scope"] = "task",
): AcceptanceCriteria {
  return {
    id,
    scope,
    type,
    description,
    required: true,
    validator: `${type}_validator`,
    params,
  };
}

function acceptanceCriteriaForKind(
  kind: TaskKind,
  intent: IntentFrame,
): AcceptanceCriteria[] {
  const result: AcceptanceCriteria[] = [];
  if (kind === "schedule") {
    result.push(
      criteria(
        "task-scheduled",
        "task_scheduled",
        "The scheduled task tool reports a created or updated task.",
      ),
      criteria(
        "tool-result",
        "tool_result",
        "The required scheduling tool result is successful.",
      ),
    );
  } else if (kind === "write_artifact" || kind === "modify_workspace") {
    result.push(
      criteria(
        "file-exists",
        "file_exists",
        "The requested file artifact exists at the runtime-observed path.",
      ),
      criteria(
        "tool-result",
        "tool_result",
        "The workspace tool reports success.",
      ),
    );
  } else if (kind === "memory_recall") {
    result.push(
      criteria(
        "memory-retrieved",
        "memory_retrieved",
        "Relevant memory or an explicit no-memory result is observed.",
        { target: intent.semanticEvidence.memoryRecall.target },
      ),
    );
  } else if (kind === "research") {
    result.push(
      criteria(
        "source-or-coverage",
        intent.needsExternalKnowledge ? "source_count" : "response_contains",
        "The answer includes enough evidence or structured coverage for the requested analysis.",
        { minSources: intent.needsExternalKnowledge ? 1 : 0 },
      ),
    );
  } else {
    result.push(
      criteria(
        "response-contains-answer",
        "response_contains",
        "The final response directly addresses the user goal.",
        { goal: intent.richIntent.userGoal },
        "final_response",
      ),
    );
  }
  if (intent.richIntent.riskLevel === "high") {
    result.push(
      criteria(
        "user-confirmed",
        "user_confirmed",
        "The user confirmed this high-risk task before execution.",
      ),
    );
  }
  return result;
}

function requiredInputsForIntent(intent: IntentFrame): TaskRequirement[] {
  const requirements: TaskRequirement[] = [];
  if (
    intent.taskType === "schedule" &&
    intent.dateFrom === null &&
    intent.dateTo === null &&
    intent.timeWindowDays === null &&
    !/(\d{1,2}\s*点|\d{1,2}:\d{2}|每天|每日|每周|周[一二三四五六日天]|星期[一二三四五六日天]|tomorrow|daily|weekly|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(
      intent.richIntent.userGoal,
    )
  ) {
    requirements.push({
      id: "schedule-time",
      field: "schedule.time",
      reason: "Schedule tasks require a concrete time or recurrence.",
      blocking: true,
    });
  }
  if (
    intent.richIntent.action === "send" &&
    !intent.richIntent.targets.some((target) => target.type === "channel")
  ) {
    requirements.push({
      id: "channel-target",
      field: "channel",
      reason: "Push/send tasks require a target channel.",
      blocking: true,
    });
  }
  return requirements;
}

export function buildTaskSpec(intent: IntentFrame): TaskSpec {
  const kind = taskKindFromIntent(intent);
  const childSpecs = intent.intentSteps.map((step, index) =>
    buildTaskSpecForStep(intent, step, index),
  );
  const acceptanceCriteria = acceptanceCriteriaForKind(kind, intent);
  const requiredInputs = requiredInputsForIntent(intent);
  return {
    id: stableId("task", intent.richIntent.userGoal || intent.reason),
    userGoal: intent.richIntent.userGoal || intent.reason,
    taskKind: kind,
    constraints: [
      {
        id: "memory-boundary",
        description: `Respect query subject boundary: ${intent.subject}.`,
        source: "memory_contract",
      },
    ],
    requiredInputs,
    expectedArtifacts: artifactSpecsForKind(kind, intent),
    acceptanceCriteria,
    riskLevel: intent.richIntent.riskLevel,
    requiresClarification: requiredInputs.some((input) => input.blocking),
    sourceIntentId: "intent",
    childSpecs,
  };
}

function buildTaskSpecForStep(
  intent: IntentFrame,
  step: IntentStep,
  index: number,
): TaskSpec {
  const stepIntent = {
    ...intent,
    taskType: step.type,
    intentSteps: [],
    richIntent: {
      ...intent.richIntent,
      userGoal: `${step.action} ${step.target}`.trim(),
      riskLevel: step.riskLevel,
    },
  } satisfies IntentFrame;
  const kind = taskKindFromIntent(stepIntent);
  return {
    id: stableId("task", `${step.id}-${step.action}-${step.target}`, index),
    userGoal: stepIntent.richIntent.userGoal,
    taskKind: kind,
    constraints: [],
    requiredInputs: requiredInputsForIntent(stepIntent),
    expectedArtifacts: artifactSpecsForKind(kind, stepIntent),
    acceptanceCriteria: acceptanceCriteriaForKind(kind, stepIntent),
    riskLevel: step.riskLevel,
    requiresClarification: false,
    sourceIntentId: step.id,
    childSpecs: [],
  };
}

function nodeKindForStep(
  step: IntentStep,
  intent: IntentFrame,
): TaskGraphNodeKind {
  if (step.type === "recall") return "recall";
  if (step.type === "schedule") return "schedule";
  if (step.type === "delegate") return "delegate";
  const surfaceText =
    `${step.action} ${step.target} ${step.operation.target} ${step.operation.selector}`.trim();
  const semanticText =
    `${surfaceText} ${step.operation.action} ${step.operation.targetType}`.trim();
  if (/push|send|发送|推送|微信|飞书|wechat|feishu/i.test(semanticText)) {
    return "push";
  }
  if (
    /read|读取|打开/i.test(semanticText) ||
    step.operation.action === "read"
  ) {
    return "read_file";
  }
  if (
    /shell|command|terminal|curl|wget|命令|终端/i.test(semanticText) ||
    intent.semanticEvidence.actionRequest.action === "run"
  ) {
    return "run_shell";
  }
  if (
    step.type !== "analyze" &&
    isSourceAcquisitionText(semanticText) &&
    !isExplicitFileWriteText(surfaceText)
  ) {
    return "research";
  }
  if (isExplicitFileWriteText(surfaceText)) {
    return "write_file";
  }
  if (step.type === "analyze") return "analyze";
  return "respond";
}

function capabilitiesForNodeKind(kind: TaskGraphNodeKind): string[] {
  switch (kind) {
    case "recall":
      return ["memory.recall"];
    case "research":
      return ["web.search"];
    case "analyze":
      return ["llm.analyze"];
    case "write_file":
      return ["file.write"];
    case "read_file":
      return ["file.read"];
    case "run_shell":
      return ["shell.run"];
    case "schedule":
      return ["task.schedule"];
    case "push":
      return ["channel.push"];
    case "delegate":
      return ["subagent.delegate"];
    case "respond":
      return ["llm.respond"];
  }
}

function outputForNode(
  kind: TaskGraphNodeKind,
  nodeId: string,
): TaskOutputSpec[] {
  if (kind === "write_file") {
    return [
      {
        id: `${nodeId}-file`,
        type: "file",
        description: "Workspace file created or updated by this node.",
        required: true,
      },
    ];
  }
  if (kind === "schedule") {
    return [
      {
        id: `${nodeId}-scheduled-task`,
        type: "scheduled_task",
        description: "Scheduled task registration.",
        required: true,
      },
    ];
  }
  if (kind === "recall") {
    return [
      {
        id: `${nodeId}-memory`,
        type: "memory",
        description: "Memory recall evidence.",
        required: true,
      },
    ];
  }
  if (kind === "research") {
    return [
      {
        id: `${nodeId}-sources`,
        type: "source",
        description:
          "Source collection gathered for downstream analysis or response.",
        required: true,
      },
    ];
  }
  return [
    {
      id: `${nodeId}-message`,
      type: "message",
      description: "Node response or observation.",
      required: true,
    },
  ];
}

function acceptanceForNode(
  kind: TaskGraphNodeKind,
  nodeId: string,
): AcceptanceCriteria[] {
  if (kind === "write_file") {
    return [
      criteria(
        `${nodeId}-file-exists`,
        "file_exists",
        "The node-created file exists.",
        { nodeId },
        "step",
      ),
    ];
  }
  if (kind === "schedule") {
    return [
      criteria(
        `${nodeId}-task-scheduled`,
        "task_scheduled",
        "The scheduler returned a task id.",
        { nodeId },
        "step",
      ),
    ];
  }
  if (kind === "recall") {
    return [
      criteria(
        `${nodeId}-memory-retrieved`,
        "memory_retrieved",
        "The node retrieved relevant memory or recorded an explicit empty result.",
        { nodeId },
        "step",
      ),
    ];
  }
  if (kind === "push") {
    return [
      criteria(
        `${nodeId}-push-tool-result`,
        "tool_result",
        "The push tool returned success.",
        { nodeId, tool: "push_to_channel" },
        "step",
      ),
    ];
  }
  if (kind === "research") {
    return [
      criteria(
        `${nodeId}-source-count`,
        "source_count",
        "The node gathered source evidence for downstream analysis.",
        { nodeId, minSources: 1 },
        "step",
      ),
    ];
  }
  return [
    criteria(
      `${nodeId}-response-contains`,
      "response_contains",
      "The node output addresses its local goal.",
      { nodeId },
      "step",
    ),
  ];
}

function fallbackNodeKindForSpec(spec: TaskSpec): TaskGraphNodeKind {
  switch (spec.taskKind) {
    case "memory_recall":
      return "recall";
    case "research":
      return "research";
    case "write_artifact":
    case "modify_workspace":
      return "write_file";
    case "schedule":
      return "schedule";
    case "delegate":
      return "delegate";
    case "answer":
    case "mixed":
      return "respond";
  }
}

export function buildTaskGraph(
  intent: IntentFrame,
  spec = buildTaskSpec(intent),
  context: TaskRuntimeContext = {},
): TaskGraph {
  const capabilities = new Set(
    context.availableCapabilities ?? [...DEFAULT_CAPABILITIES],
  );
  const steps = intent.intentSteps;
  const nodes: TaskNode[] =
    steps.length > 0
      ? steps.map((step, index) => {
          const kind = nodeKindForStep(step, intent);
          return buildNodeFromStep(step, kind, index, capabilities, context);
        })
      : [
          buildNodeFromSpec(
            spec,
            fallbackNodeKindForSpec(spec),
            0,
            capabilities,
            context,
          ),
        ];
  const edges = buildEdges(steps, nodes);
  const blockedReasons = nodes
    .map((node) => node.blockedReason)
    .filter((reason): reason is string => Boolean(reason));
  const graph: TaskGraph = {
    id: stableId("graph", spec.userGoal),
    rootTaskId: spec.id,
    nodes,
    edges,
    globalConstraints: spec.constraints,
    acceptanceCriteria: spec.acceptanceCriteria,
    status: blockedReasons.length > 0 ? "blocked" : "planned",
    blockedReasons,
  };
  const gates = validateTaskGraph(graph);
  const blockingGateFailures = gates.filter(
    (gate) => !gate.ok && gate.blocking,
  );
  if (blockingGateFailures.length > 0) {
    graph.status = "blocked";
    graph.blockedReasons.push(
      ...blockingGateFailures.map((gate) => `${gate.code}: ${gate.message}`),
    );
  }
  return graph;
}

function buildNodeFromSpec(
  spec: TaskSpec,
  kind: TaskGraphNodeKind,
  index: number,
  capabilities: Set<string>,
  context: TaskRuntimeContext,
): TaskNode {
  const nodeId = stableId("node", `${kind}-${spec.userGoal}`, index);
  return finalizeNode(
    {
      id: nodeId,
      title: spec.userGoal,
      kind,
      requiredCapabilities: capabilitiesForNodeKind(kind),
      inputs: [],
      outputs: outputForNode(kind, nodeId),
      acceptanceCriteria: acceptanceForNode(kind, nodeId),
      retryPolicy: {
        maxAttempts: kind === "respond" ? 1 : 2,
        strategy: "same",
      },
      optional: false,
    },
    capabilities,
    context,
  );
}

function buildNodeFromStep(
  step: IntentStep,
  kind: TaskGraphNodeKind,
  index: number,
  capabilities: Set<string>,
  context: TaskRuntimeContext,
): TaskNode {
  const nodeId =
    step.id || stableId("node", `${step.action}-${step.target}`, index);
  return finalizeNode(
    {
      id: nodeId,
      title: `${step.action} ${step.target}`.trim() || step.type,
      kind,
      requiredCapabilities: capabilitiesForNodeKind(kind),
      inputs: step.dependsOn.map((stepId) => ({
        sourceNodeId: stepId,
        name: `${stepId}.output`,
        required: true,
      })),
      outputs: outputForNode(kind, nodeId),
      acceptanceCriteria: acceptanceForNode(kind, nodeId),
      retryPolicy: {
        maxAttempts: kind === "respond" ? 1 : 2,
        strategy: "same",
      },
      optional: false,
    },
    capabilities,
    context,
  );
}

function finalizeNode(
  node: TaskNode,
  capabilities: Set<string>,
  context: TaskRuntimeContext,
): TaskNode {
  const missingCapabilities = node.requiredCapabilities.filter(
    (capability) => !capabilities.has(capability),
  );
  const policyBlocks: string[] = [];
  if (
    context.memoryBoundary === "external" &&
    node.requiredCapabilities.includes("memory.recall")
  ) {
    policyBlocks.push("external memory boundary forbids personal recall");
  }
  if (
    context.channelAvailable === false &&
    node.requiredCapabilities.includes("channel.push")
  ) {
    policyBlocks.push("channel capability unavailable in current context");
  }
  if (
    context.allowShellNetworkFetch === false &&
    node.requiredCapabilities.includes("shell.run") &&
    /curl|wget|http|fetch|抓取|网页/.test(node.title)
  ) {
    policyBlocks.push("shell network fetch disabled by workspace policy");
  }
  const blockedReason =
    missingCapabilities.length > 0
      ? `blocked_missing_capability:${missingCapabilities.join(",")}`
      : policyBlocks.length > 0
        ? policyBlocks.join("; ")
        : undefined;
  return {
    ...node,
    blockedReason,
  };
}

function buildEdges(steps: IntentStep[], nodes: TaskNode[]): TaskEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return steps.flatMap((step) =>
    step.dependsOn
      .filter((dependency) => nodeIds.has(dependency) && nodeIds.has(step.id))
      .map((dependency) => ({
        from: dependency,
        to: step.id,
        reason: "intent step dependency",
      })),
  );
}

export function validateTaskSpec(spec: TaskSpec): TaskGateResult[] {
  const gates: TaskGateResult[] = [];
  gates.push({
    ok: spec.userGoal.trim().length > 0,
    code: "task_spec_goal_present",
    message: "TaskSpec must include a non-empty userGoal.",
    blocking: true,
  });
  gates.push({
    ok: spec.acceptanceCriteria.length > 0,
    code: "task_spec_acceptance_present",
    message: "TaskSpec must include at least one acceptance criterion.",
    blocking: true,
  });
  if (
    spec.taskKind === "write_artifact" ||
    spec.taskKind === "modify_workspace"
  ) {
    gates.push({
      ok: spec.acceptanceCriteria.some((item) => item.type === "file_exists"),
      code: "task_spec_file_acceptance",
      message:
        "File/artifact tasks require a file_exists acceptance criterion.",
      blocking: true,
    });
  }
  if (spec.taskKind === "schedule") {
    gates.push({
      ok: spec.acceptanceCriteria.some(
        (item) => item.type === "task_scheduled",
      ),
      code: "task_spec_schedule_acceptance",
      message: "Schedule tasks require a task_scheduled acceptance criterion.",
      blocking: true,
    });
  }
  if (spec.riskLevel === "high") {
    gates.push({
      ok: spec.acceptanceCriteria.some(
        (item) => item.type === "user_confirmed",
      ),
      code: "task_spec_high_risk_confirmation",
      message: "High-risk tasks require user_confirmed acceptance.",
      blocking: true,
    });
  }
  return gates;
}

export function validateTaskGraph(graph: TaskGraph): TaskGateResult[] {
  const gates: TaskGateResult[] = [];
  gates.push({
    ok: graph.nodes.length > 0,
    code: "task_graph_nodes_present",
    message: "TaskGraph must include at least one node.",
    blocking: true,
  });
  gates.push({
    ok: graph.acceptanceCriteria.length > 0,
    code: "task_graph_acceptance_present",
    message: "TaskGraph must include root acceptance criteria.",
    blocking: true,
  });
  gates.push({
    ok: graph.nodes.every((node) => node.acceptanceCriteria.length > 0),
    code: "task_graph_node_acceptance_present",
    message: "Every TaskGraph node must include acceptance criteria.",
    blocking: true,
  });
  gates.push({
    ok: isAcyclic(graph),
    code: "task_graph_acyclic",
    message: "TaskGraph dependencies must be acyclic.",
    blocking: true,
  });
  gates.push({
    ok: graph.nodes.every((node) => !node.blockedReason),
    code: "task_graph_capabilities_available",
    message: "Every executable node must have available capabilities.",
    blocking: true,
  });
  return gates;
}

function isAcyclic(graph: TaskGraph): boolean {
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of graph.edges) {
    outgoing.get(edge.from)?.push(edge.to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return false;
    if (visited.has(nodeId)) return true;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      if (!visit(next)) return false;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return true;
  };
  return graph.nodes.every((node) => visit(node.id));
}
