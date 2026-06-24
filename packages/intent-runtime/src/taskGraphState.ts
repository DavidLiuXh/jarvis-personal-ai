/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskGraph } from "./taskGraph.js";
import type {
  AcceptanceValidationResult,
  TaskFinalResponseContract,
  TaskGraphExecutionResult,
  TaskGraphExecutionStatus,
  TaskGraphExecutorEvent,
  TaskGraphResumeState,
  TaskNodeExecutionState,
  TaskRuntimeArtifact,
} from "./taskGraphExecutor.js";

export type TaskGraphExecutionSnapshot = {
  id: string;
  graphId: string;
  graph: TaskGraph;
  status: TaskGraphExecutionStatus;
  nodes: Array<{
    nodeId: string;
    status: TaskNodeExecutionState["status"];
    attempts: number;
    output: unknown;
    artifacts: TaskRuntimeArtifact[];
    acceptanceResults: AcceptanceValidationResult[];
    lastError: string | null;
  }>;
  artifacts: TaskRuntimeArtifact[];
  blockedReasons: string[];
  failedReasons: string[];
  finalResponseContract: TaskFinalResponseContract;
  events: TaskGraphExecutorEvent[];
  clarificationAnswers: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  failureRootCause?: string;
  metadata?: Record<string, unknown>;
};

export type TaskGraphExecutionListFilter = {
  status?: TaskGraphExecutionStatus;
  graphId?: string;
  limit?: number;
};

export type TaskGraphExecutionStore = {
  save(snapshot: TaskGraphExecutionSnapshot): Promise<void>;
  load(id: string): Promise<TaskGraphExecutionSnapshot | null>;
  list(
    filter?: TaskGraphExecutionListFilter,
  ): Promise<TaskGraphExecutionSnapshot[]>;
  appendEvent(id: string, event: TaskGraphExecutorEvent): Promise<void>;
};

export class TaskArtifactRegistry {
  private readonly artifacts = new Map<string, TaskRuntimeArtifact>();

  constructor(initialArtifacts: TaskRuntimeArtifact[] = []) {
    this.registerMany(initialArtifacts);
  }

  register(artifact: TaskRuntimeArtifact): TaskRuntimeArtifact {
    const normalized = {
      ...artifact,
      sourceNodeId: artifact.sourceNodeId ?? artifact.nodeId,
      createdAt: artifact.createdAt ?? new Date().toISOString(),
    };
    this.artifacts.set(normalized.id, normalized);
    return normalized;
  }

  registerMany(artifacts: TaskRuntimeArtifact[]): TaskRuntimeArtifact[] {
    return artifacts.map((artifact) => this.register(artifact));
  }

  list(): TaskRuntimeArtifact[] {
    return [...this.artifacts.values()];
  }

  findByNode(nodeId: string): TaskRuntimeArtifact[] {
    return this.list().filter(
      (artifact) =>
        artifact.nodeId === nodeId || artifact.sourceNodeId === nodeId,
    );
  }

  findByType(type: TaskRuntimeArtifact["type"]): TaskRuntimeArtifact[] {
    return this.list().filter((artifact) => artifact.type === type);
  }
}

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 160);
}

function firstRootCause(result: TaskGraphExecutionResult): string | undefined {
  return (
    result.failedReasons[0] ??
    result.blockedReasons[0] ??
    result.nodes.find((node) => node.lastError)?.lastError ??
    undefined
  );
}

export function snapshotTaskGraphExecution(
  result: TaskGraphExecutionResult,
  options: {
    id?: string;
    events?: TaskGraphExecutorEvent[];
    clarificationAnswers?: Record<string, unknown>;
    createdAt?: string;
    metadata?: Record<string, unknown>;
    previous?: TaskGraphExecutionSnapshot | null;
  } = {},
): TaskGraphExecutionSnapshot {
  const now = new Date().toISOString();
  const createdAt = options.createdAt ?? options.previous?.createdAt ?? now;
  return {
    id: options.id ?? options.previous?.id ?? result.graph.id,
    graphId: result.graph.id,
    graph: result.graph,
    status: result.status,
    nodes: result.nodes.map((state) => ({
      nodeId: state.node.id,
      status: state.status,
      attempts: state.attempts,
      output: state.output,
      artifacts: state.artifacts,
      acceptanceResults: state.acceptanceResults,
      lastError: state.lastError,
    })),
    artifacts: result.artifacts,
    blockedReasons: result.blockedReasons,
    failedReasons: result.failedReasons,
    finalResponseContract: result.finalResponseContract,
    events: [...(options.previous?.events ?? []), ...(options.events ?? [])],
    clarificationAnswers: {
      ...(options.previous?.clarificationAnswers ?? {}),
      ...(options.clarificationAnswers ?? {}),
    },
    createdAt,
    updatedAt: now,
    failureRootCause: firstRootCause(result),
    metadata: {
      ...(options.previous?.metadata ?? {}),
      ...(options.metadata ?? {}),
    },
  };
}

export function resumeStateFromSnapshot(
  snapshot: TaskGraphExecutionSnapshot,
): TaskGraphResumeState {
  return {
    nodes: snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      attempts: node.attempts,
      output: node.output,
      artifacts: node.artifacts,
      acceptanceResults: node.acceptanceResults,
      lastError: node.lastError,
    })),
    artifacts: snapshot.artifacts,
  };
}

export class InMemoryTaskGraphExecutionStore
  implements TaskGraphExecutionStore
{
  private readonly snapshots = new Map<string, TaskGraphExecutionSnapshot>();

  async save(snapshot: TaskGraphExecutionSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }

  async load(id: string): Promise<TaskGraphExecutionSnapshot | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async list(
    filter: TaskGraphExecutionListFilter = {},
  ): Promise<TaskGraphExecutionSnapshot[]> {
    const snapshots = [...this.snapshots.values()]
      .filter((snapshot) =>
        filter.status ? snapshot.status === filter.status : true,
      )
      .filter((snapshot) =>
        filter.graphId ? snapshot.graphId === filter.graphId : true,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return structuredClone(
      typeof filter.limit === "number"
        ? snapshots.slice(0, filter.limit)
        : snapshots,
    );
  }

  async appendEvent(id: string, event: TaskGraphExecutorEvent): Promise<void> {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) return;
    snapshot.events.push(event);
    snapshot.updatedAt = new Date().toISOString();
  }
}

export class JsonFileTaskGraphExecutionStore
  implements TaskGraphExecutionStore
{
  constructor(private readonly directory: string) {}

  async save(snapshot: TaskGraphExecutionSnapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      this.filePath(snapshot.id),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
  }

  async load(id: string): Promise<TaskGraphExecutionSnapshot | null> {
    try {
      const content = await readFile(this.filePath(id), "utf8");
      return JSON.parse(content) as TaskGraphExecutionSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(
    filter: TaskGraphExecutionListFilter = {},
  ): Promise<TaskGraphExecutionSnapshot[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) =>
      file.endsWith(".json"),
    );
    const snapshots = (
      await Promise.all(
        files.map(async (file) => {
          const content = await readFile(
            path.join(this.directory, file),
            "utf8",
          );
          return JSON.parse(content) as TaskGraphExecutionSnapshot;
        }),
      )
    )
      .filter((snapshot) =>
        filter.status ? snapshot.status === filter.status : true,
      )
      .filter((snapshot) =>
        filter.graphId ? snapshot.graphId === filter.graphId : true,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return typeof filter.limit === "number"
      ? snapshots.slice(0, filter.limit)
      : snapshots;
  }

  async appendEvent(id: string, event: TaskGraphExecutorEvent): Promise<void> {
    const snapshot = await this.load(id);
    if (!snapshot) return;
    snapshot.events.push(event);
    snapshot.updatedAt = new Date().toISOString();
    await this.save(snapshot);
  }

  private filePath(id: string): string {
    return path.join(this.directory, `${safeFileName(id)}.json`);
  }
}
