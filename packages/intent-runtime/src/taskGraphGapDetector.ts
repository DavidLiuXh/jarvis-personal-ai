/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentFrame } from "@jarvis/memory-runtime";
import type { TaskGraph, TaskGraphNodeKind } from "./taskGraph.js";

export type TaskGraphGapKind =
  | "local_path_without_read"
  | "save_request_without_write"
  | "source_reference_without_acquisition"
  | "execute_task_with_only_llm_nodes"
  | "required_artifact_without_producer";

export type TaskGraphGapSeverity = "info" | "warning" | "critical";

export type TaskGraphGap = {
  kind: TaskGraphGapKind;
  severity: TaskGraphGapSeverity;
  message: string;
  evidence: string[];
  suggestedNodeKinds: TaskGraphNodeKind[];
};

export type TaskGraphGapDetectorContext = {
  userPrompt?: string;
  currentContent?: string;
  artifacts?: Record<string, string>;
};

const LLM_ONLY_NODE_KINDS = new Set<TaskGraphNodeKind>([
  "analyze",
  "respond",
  "delegate",
]);

const LOCAL_PATH_RE =
  /(?:^|[\s"'“”‘’([{，。；;：:在])((?:~|\/Users|\/Volumes|\/tmp|\/private|\/var|\/opt|\/[A-Za-z0-9._-]+)(?:\/[^\s"'“”‘’()[\]{}，。；;：:!?？]+)+)/i;

const LOCAL_REFERENCE_RE =
  /目录|文件夹|文档|资料|材料|参考|读取|读一下|打开|path|folder|directory|documents?|files?|reference material/i;

const SOURCE_REFERENCE_RE =
  /参考(?:这些|上述|目录|文件|文档|资料|材料|内容)?|基于(?:这些|上述|目录|文件|文档|资料|材料|内容)|结合(?:这些|上述|目录|文件|文档|资料|材料|内容)|根据(?:这些|上述|目录|文件|文档|资料|材料|内容)|source material|reference material|based on/i;

const SAVE_REQUEST_RE =
  /保存|写入|写成|输出为|输出到|导出|落地|本地文档|本地文件|生成.*(?:文档|文件|报告|markdown|md)|save|write|export|persist|local document|local file|\.md\b|\.markdown\b|\.txt\b|\.html\b/i;

function textForDetection(
  intent: IntentFrame,
  context: TaskGraphGapDetectorContext,
): string {
  return [
    context.userPrompt,
    intent.richIntent.userGoal,
    intent.reason,
    ...intent.evidence,
    ...intent.intentSteps.flatMap((step) => [
      step.action,
      step.target,
      step.operation.action,
      step.operation.target,
      step.operation.selector,
      step.operation.scope,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function nodeKinds(graph: TaskGraph): Set<TaskGraphNodeKind> {
  return new Set(graph.nodes.map((node) => node.kind));
}

function hasAnyNode(
  graph: TaskGraph,
  kinds: ReadonlyArray<TaskGraphNodeKind>,
): boolean {
  const kindsInGraph = nodeKinds(graph);
  return kinds.some((kind) => kindsInGraph.has(kind));
}

function hasLocalPathReference(text: string): boolean {
  return LOCAL_PATH_RE.test(text) && LOCAL_REFERENCE_RE.test(text);
}

function hasSourceReference(text: string): boolean {
  return SOURCE_REFERENCE_RE.test(text);
}

function hasSaveRequest(text: string, intent: IntentFrame): boolean {
  return (
    SAVE_REQUEST_RE.test(text) ||
    intent.richIntent.targets.some((target) => target.type === "file") ||
    (intent.richIntent.action === "create" &&
      /文档|文件|报告|markdown|md|document|file|report/i.test(text))
  );
}

function hasOnlyLlmNodes(graph: TaskGraph): boolean {
  return (
    graph.nodes.length > 0 &&
    graph.nodes.every((node) => LLM_ONLY_NODE_KINDS.has(node.kind))
  );
}

function requiredFileArtifactUnproduced(
  intent: IntentFrame,
  graph: TaskGraph,
  text: string,
): boolean {
  const fileAcceptanceRequired = graph.acceptanceCriteria.some(
    (criterion) =>
      criterion.required &&
      (criterion.type === "file_exists" || criterion.type === "file_contains"),
  );
  return (
    (fileAcceptanceRequired || hasSaveRequest(text, intent)) &&
    !hasAnyNode(graph, ["write_file"])
  );
}

function pushGap(gaps: TaskGraphGap[], gap: TaskGraphGap): void {
  if (gaps.some((existing) => existing.kind === gap.kind)) return;
  gaps.push(gap);
}

export function detectTaskGraphGaps(
  intent: IntentFrame,
  graph: TaskGraph,
  context: TaskGraphGapDetectorContext = {},
): TaskGraphGap[] {
  const text = textForDetection(intent, context);
  const gaps: TaskGraphGap[] = [];

  if (
    hasLocalPathReference(text) &&
    !hasAnyNode(graph, ["read_file", "run_shell"])
  ) {
    pushGap(gaps, {
      kind: "local_path_without_read",
      severity: "critical",
      message:
        "User provided a local path or directory as task input, but the graph has no local read node.",
      evidence: [text.match(LOCAL_PATH_RE)?.[1] ?? "local_path_reference"],
      suggestedNodeKinds: ["read_file", "analyze"],
    });
  }

  if (hasSaveRequest(text, intent) && !hasAnyNode(graph, ["write_file"])) {
    pushGap(gaps, {
      kind: "save_request_without_write",
      severity: "critical",
      message:
        "User requested a persisted local artifact, but the graph has no write node.",
      evidence: ["save_or_export_request"],
      suggestedNodeKinds: ["write_file"],
    });
  }

  if (
    hasSourceReference(text) &&
    !hasAnyNode(graph, ["research", "read_file", "recall"])
  ) {
    pushGap(gaps, {
      kind: "source_reference_without_acquisition",
      severity: "warning",
      message:
        "User asked to base the work on source material, but the graph has no acquisition node.",
      evidence: ["source_reference_cue"],
      suggestedNodeKinds: ["read_file", "research"],
    });
  }

  if (
    intent.taskType === "execute" &&
    hasOnlyLlmNodes(graph) &&
    (intent.needsTool ||
      intent.richIntent.contextDependency.localWorkspace ||
      hasSaveRequest(text, intent) ||
      hasLocalPathReference(text))
  ) {
    pushGap(gaps, {
      kind: "execute_task_with_only_llm_nodes",
      severity: "critical",
      message:
        "Executable task compiled to only LLM nodes, so deterministic pre-execution has nothing to run.",
      evidence: graph.nodes.map((node) => `${node.id}:${node.kind}`),
      suggestedNodeKinds: ["read_file", "write_file"],
    });
  }

  if (requiredFileArtifactUnproduced(intent, graph, text)) {
    pushGap(gaps, {
      kind: "required_artifact_without_producer",
      severity: "critical",
      message:
        "The task requires a file artifact, but no graph node can produce it.",
      evidence: ["required_file_artifact_without_write_file"],
      suggestedNodeKinds: ["write_file"],
    });
  }

  return gaps;
}
