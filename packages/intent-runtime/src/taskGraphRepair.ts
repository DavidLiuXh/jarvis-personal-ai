/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentFrame } from "@jarvis/memory-runtime";
import type {
  AcceptanceCriteria,
  TaskEdge,
  TaskGraph,
  TaskGraphNodeKind,
  TaskInputRef,
  TaskNode,
  TaskOutputSpec,
} from "./taskGraph.js";
import { validateTaskGraph } from "./taskGraph.js";
import type {
  TaskGraphGap,
  TaskGraphGapDetectorContext,
} from "./taskGraphGapDetector.js";

export type TaskGraphRepairKind =
  | "insert_local_read"
  | "insert_artifact_write"
  | "wire_read_to_analysis"
  | "wire_content_to_write";

export type TaskGraphRepair = {
  kind: TaskGraphRepairKind;
  reason: string;
  nodeId?: string;
  edge?: TaskEdge;
};

export type TaskGraphRepairResult = {
  graph: TaskGraph;
  repairs: TaskGraphRepair[];
  rejectedReasons: string[];
};

const LOCAL_PATH_RE =
  /(?:^|[\s"'“”‘’([{，。；;：:在])((?:~|\/Users|\/Volumes|\/tmp|\/private|\/var|\/opt|\/[A-Za-z0-9._-]+)(?:\/[^\s"'“”‘’()[\]{}，。；;：:!?？]+)+)/i;
const LOCAL_PATH_BOUNDARY_RE =
  /(目录下|文件夹下|路径下|下是|里面|中是|[，。；;：:!?？\s])/;

function textForRepair(
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

function extractLocalPath(text: string): string | null {
  const raw = text.match(LOCAL_PATH_RE)?.[1];
  if (!raw) return null;
  const boundary = raw.search(LOCAL_PATH_BOUNDARY_RE);
  const trimmed = (boundary >= 0 ? raw.slice(0, boundary) : raw)
    .replace(/(?:目录|文件夹|路径)$/u, "")
    .trim();
  return trimmed || null;
}

function hasNodeKind(graph: TaskGraph, kind: TaskGraphNodeKind): boolean {
  return graph.nodes.some((node) => node.kind === kind);
}

function acceptance(
  id: string,
  type: AcceptanceCriteria["type"],
  description: string,
  params: Record<string, unknown> = {},
): AcceptanceCriteria {
  return {
    id,
    scope: "step",
    type,
    description,
    required: true,
    validator: `${type}_validator`,
    params,
  };
}

function inputFrom(nodeId: string): TaskInputRef {
  return {
    sourceNodeId: nodeId,
    name: `${nodeId}.output`,
    required: true,
  };
}

function output(
  nodeId: string,
  type: TaskOutputSpec["type"],
  description: string,
): TaskOutputSpec[] {
  return [
    {
      id: `${nodeId}-${type}`,
      type,
      description,
      required: true,
    },
  ];
}

function localReadNode(pathHint: string): TaskNode {
  const nodeId = "repair-read-local-input";
  return {
    id: nodeId,
    title: `read local reference material ${pathHint}`,
    kind: "read_many_files",
    requiredCapabilities: ["file.read"],
    inputs: [],
    outputs: output(
      nodeId,
      "source",
      "Local reference material read by repair.",
    ),
    acceptanceCriteria: [
      acceptance(
        `${nodeId}-tool-result`,
        "tool_result",
        "The local reference material read tool reports success.",
        { nodeId, tool: "read_many_files" },
      ),
    ],
    retryPolicy: { maxAttempts: 2, strategy: "same" },
    optional: false,
  };
}

function artifactWriteNode(inputNodeId: string): TaskNode {
  const nodeId = "repair-write-final-artifact";
  return {
    id: nodeId,
    title: "write final local document",
    kind: "write_file",
    requiredCapabilities: ["file.write"],
    inputs: [inputFrom(inputNodeId)],
    outputs: output(nodeId, "file", "Final local document created by repair."),
    acceptanceCriteria: [
      acceptance(
        `${nodeId}-file-exists`,
        "file_exists",
        "The repaired graph creates the requested local file artifact.",
        { nodeId },
      ),
    ],
    retryPolicy: { maxAttempts: 2, strategy: "same" },
    optional: false,
  };
}

function addInputIfMissing(node: TaskNode, sourceNodeId: string): TaskNode {
  if (node.inputs.some((input) => input.sourceNodeId === sourceNodeId)) {
    return node;
  }
  return { ...node, inputs: [...node.inputs, inputFrom(sourceNodeId)] };
}

function edgeExists(edges: TaskEdge[], from: string, to: string): boolean {
  return edges.some((edge) => edge.from === from && edge.to === to);
}

function addEdge(edges: TaskEdge[], from: string, to: string): TaskEdge[] {
  if (edgeExists(edges, from, to)) return edges;
  return [
    ...edges,
    { from, to, reason: "deterministic graph repair dependency" },
  ];
}

function findLastContentProducer(graph: TaskGraph): TaskNode | null {
  const preferred = [...graph.nodes]
    .reverse()
    .find((node) => node.kind === "analyze" || node.kind === "respond");
  if (preferred) return preferred;
  return (
    [...graph.nodes]
      .reverse()
      .find((node) =>
        [
          "read_file",
          "read_many_files",
          "list_directory",
          "research",
          "recall",
        ].includes(node.kind),
      ) ?? null
  );
}

function hasGap(gaps: TaskGraphGap[], kind: TaskGraphGap["kind"]): boolean {
  return gaps.some((gap) => gap.kind === kind);
}

function sortNodesForRepair(nodes: TaskNode[]): TaskNode[] {
  const rank = (node: TaskNode): number => {
    if (
      (node.kind === "read_file" || node.kind === "read_many_files") &&
      node.id.startsWith("repair-")
    ) {
      return 0;
    }
    if (node.kind === "recall" || node.kind === "research") return 1;
    if (node.kind === "analyze") return 2;
    if (node.kind === "respond") return 3;
    if (node.kind === "write_file" && node.id.startsWith("repair-")) return 4;
    return 2;
  };
  return [...nodes].sort((a, b) => rank(a) - rank(b));
}

export function repairTaskGraphGaps(
  intent: IntentFrame,
  graph: TaskGraph,
  gaps: TaskGraphGap[],
  context: TaskGraphGapDetectorContext = {},
): TaskGraphRepairResult {
  const repairs: TaskGraphRepair[] = [];
  const rejectedReasons: string[] = [];
  let nodes = [...graph.nodes];
  let edges = [...graph.edges];
  const text = textForRepair(intent, context);

  if (
    hasGap(gaps, "local_path_without_read") &&
    !hasNodeKind(graph, "read_file") &&
    !hasNodeKind(graph, "read_many_files") &&
    !hasNodeKind(graph, "list_directory")
  ) {
    const pathHint = extractLocalPath(text);
    if (!pathHint) {
      rejectedReasons.push("local_path_without_read:missing_path_hint");
    } else {
      const read = localReadNode(pathHint);
      nodes = [read, ...nodes];
      repairs.push({
        kind: "insert_local_read",
        reason: "Local path was present but no read node existed.",
        nodeId: read.id,
      });
      nodes = nodes.map((node) => {
        if (node.kind !== "analyze") return node;
        repairs.push({
          kind: "wire_read_to_analysis",
          reason: "Analysis should consume local reference material.",
          edge: {
            from: read.id,
            to: node.id,
            reason: "deterministic graph repair dependency",
          },
        });
        edges = addEdge(edges, read.id, node.id);
        return addInputIfMissing(node, read.id);
      });
    }
  }

  if (
    (hasGap(gaps, "save_request_without_write") ||
      hasGap(gaps, "required_artifact_without_producer")) &&
    !nodes.some((node) => node.kind === "write_file")
  ) {
    const producer = findLastContentProducer({ ...graph, nodes });
    if (!producer) {
      rejectedReasons.push(
        "save_request_without_write:missing_content_producer",
      );
    } else {
      const write = artifactWriteNode(producer.id);
      nodes = [...nodes, write];
      edges = addEdge(edges, producer.id, write.id);
      repairs.push({
        kind: "insert_artifact_write",
        reason: "Persisted artifact requested but no write node existed.",
        nodeId: write.id,
      });
      repairs.push({
        kind: "wire_content_to_write",
        reason: "Write node must consume generated content.",
        edge: {
          from: producer.id,
          to: write.id,
          reason: "deterministic graph repair dependency",
        },
      });
    }
  }

  const repairedGraph: TaskGraph = {
    ...graph,
    id: repairs.length > 0 ? `${graph.id}-repaired` : graph.id,
    nodes: sortNodesForRepair(nodes),
    edges,
    status: graph.status,
    blockedReasons: [...graph.blockedReasons],
  };
  const validationFailures = validateTaskGraph(repairedGraph).filter(
    (gate) => !gate.ok && gate.blocking,
  );
  if (validationFailures.length > 0) {
    return {
      graph,
      repairs: [],
      rejectedReasons: [
        ...rejectedReasons,
        ...validationFailures.map((gate) => `${gate.code}:${gate.message}`),
      ],
    };
  }
  return { graph: repairedGraph, repairs, rejectedReasons };
}
