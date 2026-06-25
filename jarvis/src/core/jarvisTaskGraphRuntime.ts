/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from "node:os";
import path from "node:path";
import type {
  TaskRuntime,
  TaskRuntimeExecuteInput,
  TaskRuntimePlanInput,
} from "../agent-runtime/index.js";
import {
  AutonomousTaskRuntime,
  buildTaskGraph,
  buildTaskSpec,
  DefaultTaskGraphCapabilityRegistry,
  IntentStepRuntime,
  JsonFileTaskGraphExecutionStore,
  type RuntimeToolRequest,
  type RuntimeToolResult,
  type TaskGraph,
  type TaskGraphCapabilityAdapter,
  type TaskGraphExecutionObserver,
  type TaskNodeExecutionRequest,
  type TaskNodeExecutionResult,
  type TaskRuntimeArtifact,
} from "../intent-runtime/index.js";
import type { JarvisConfig } from "./configManager.js";
import type { IntentFrame } from "./intentResolver.js";
import type { ToolRouter } from "./toolRouter.js";

const IMPLEMENTED_CAPABILITIES = [
  "llm.respond",
  "llm.analyze",
  "memory.recall",
  "file.read",
  "file.write",
  "shell.run",
  "task.schedule",
  "channel.push",
  "skill.activate",
] as const;

const DETERMINISTIC_NODE_KINDS = new Set([
  "recall",
  "write_file",
  "read_file",
  "run_shell",
  "schedule",
  "push",
  "delegate",
]);

type JarvisTaskGraphRuntimeOptions = {
  config: JarvisConfig;
  toolRouter: ToolRouter;
  sessionId: string;
};

function enabledConfig(config: JarvisConfig) {
  return config.agentRuntime?.autonomousTaskRuntime;
}

function taskGraphStateDir(config: JarvisConfig): string {
  return (
    enabledConfig(config)?.stateDir ??
    path.join(os.homedir(), ".gemini-jarvis", "task-graph-state")
  );
}

function formatNode(node: TaskGraph["nodes"][number]): string {
  const caps = node.requiredCapabilities.join(",") || "none";
  const deps =
    node.inputs
      .map((input) => input.sourceNodeId)
      .filter(Boolean)
      .join(",") || "-";
  const blocked = node.blockedReason ? ` blocked="${node.blockedReason}"` : "";
  return `${node.id}: kind=${node.kind} caps=${caps} deps=${deps} title="${node.title}"${blocked}`;
}

function logTaskGraphPlan(graph: TaskGraph): void {
  console.error(
    `🧭 [TaskGraph] planned id=${graph.id} status=${graph.status} nodes=${graph.nodes.length}`,
  );
  console.error(
    `🧭 [TaskGraph] execution plan:\n${graph.nodes
      .map((node) => `  ${formatNode(node)}`)
      .join("\n")}`,
  );
  if (graph.blockedReasons.length > 0) {
    console.error(
      `🧭 [TaskGraph] planning blockers: ${graph.blockedReasons.join("; ")}`,
    );
  }
}

function observer(enabled: boolean): TaskGraphExecutionObserver {
  return (event) => {
    if (!enabled) return;
    if (event.type === "task_graph_started") {
      console.error(
        `🧭 [TaskGraph] started id=${event.graphId} nodes=${event.nodes}`,
      );
    } else if (event.type === "task_node_started") {
      console.error(
        `🧭 [TaskGraph] node started id=${event.nodeId} kind=${event.kind} attempt=${event.attempt}`,
      );
    } else if (event.type === "task_node_result") {
      console.error(
        `🧭 [TaskGraph] node result id=${event.nodeId} status=${event.status} artifacts=${event.artifactCount}`,
      );
    } else if (event.type === "task_node_acceptance") {
      console.error(
        `🧭 [TaskGraph] node acceptance id=${event.nodeId} ` +
          event.results
            .map(
              (result) =>
                `${result.criterionId}:${result.ok ? "pass" : "fail"}${result.blocking ? ":blocking" : ""}`,
            )
            .join(","),
      );
    } else if (event.type === "task_node_finished") {
      console.error(
        `🧭 [TaskGraph] node finished id=${event.nodeId} status=${event.status}` +
          (event.reason ? ` reason="${event.reason}"` : ""),
      );
    } else if (event.type === "task_graph_finished") {
      console.error(
        `🧭 [TaskGraph] finished id=${event.graphId} status=${event.status} blocked=${event.blocked} failed=${event.failed}`,
      );
    }
  };
}

function getIntent(request: TaskNodeExecutionRequest): IntentFrame | null {
  const value = request.context.metadata?.intent;
  return value && typeof value === "object" ? (value as IntentFrame) : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function outputIndicatesFailure(output: unknown): boolean {
  return /(^|[^\w])(error|failed|denied|blocked|not available|requires|❌|失败|不可用|被拒绝)([^\w]|$)/i.test(
    stringifyOutput(output),
  );
}

function toolStatus(
  result: RuntimeToolResult,
): TaskNodeExecutionResult["status"] {
  if (result.status === "blocked") return "blocked";
  if (result.status !== "success" || outputIndicatesFailure(result.output)) {
    return "failed";
  }
  return "succeeded";
}

function makeCallId(nodeId: string, toolName: string): string {
  return `taskgraph-${nodeId}-${toolName}`;
}

function textFromArtifacts(request: TaskNodeExecutionRequest): string {
  const artifactText = request.artifacts
    .map((artifact) => artifact.content)
    .filter((content): content is string => Boolean(content?.trim()))
    .join("\n\n");
  const dependencyText = Object.values(request.dependencyOutputs)
    .map(stringifyOutput)
    .filter(Boolean)
    .join("\n\n");
  return [artifactText, dependencyText].filter(Boolean).join("\n\n");
}

function extractPath(text: string): string | null {
  const match = text.match(
    /([A-Za-z0-9_\-./\u4e00-\u9fff]+?\.(?:md|markdown|txt|json|html|csv|ts|tsx|js|py|yaml|yml))/i,
  );
  return match?.[1]?.replace(/\.markdown$/i, ".md") ?? null;
}

function safeFileName(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${normalized || "jarvis-task"}.md`;
}

function deriveFilePath(request: TaskNodeExecutionRequest): string {
  return (
    extractPath(`${request.node.title} ${request.context.userPrompt}`) ??
    path.join("jarvis_outputs", safeFileName(request.node.title))
  );
}

function deriveCommand(request: TaskNodeExecutionRequest): string {
  const source = `${request.node.title}\n${request.context.userPrompt}`;
  const explicit = source.match(/(?:运行|执行|run)\s*[:：]?\s*([^\n]+)/i)?.[1];
  if (explicit?.trim()) return explicit.trim();
  const line = source
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) =>
      /\b(?:curl|wget|node|npm|npx|python|python3|bash)\b/.test(item),
    );
  return line ?? "";
}

function deriveChannel(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes("wechat") ||
    lower.includes("weixin") ||
    text.includes("微信")
  ) {
    return "wechat";
  }
  if (
    lower.includes("feishu") ||
    lower.includes("lark") ||
    text.includes("飞书")
  ) {
    return "feishu";
  }
  return "";
}

function deriveSkillName(text: string): string {
  const explicit = text.match(
    /(?:activate_skill|skill|技能|使用)\s*[:：]?\s*([A-Za-z0-9_.-]+)/i,
  )?.[1];
  return explicit?.trim() ?? text.trim().split(/\s+/)[0] ?? "";
}

function workspaceArtifact(
  request: TaskNodeExecutionRequest,
  result: RuntimeToolResult,
): TaskRuntimeArtifact[] {
  const parsed = parseJsonObject(result.output);
  const ok = parsed?.ok !== false;
  const payload =
    parsed?.result && typeof parsed.result === "object"
      ? (parsed.result as Record<string, unknown>)
      : parsed;
  const pathValue =
    typeof payload?.path === "string" ? payload.path : deriveFilePath(request);
  if (request.node.kind === "write_file") {
    return [
      {
        id: `${request.node.id}-file`,
        nodeId: request.node.id,
        type: "file",
        path: pathValue,
        exists: ok,
        content: textFromArtifacts(request) || request.context.currentContent,
        metadata: { tool: result.name, output: result.output },
      },
    ];
  }
  if (request.node.kind === "read_file") {
    return [
      {
        id: `${request.node.id}-file`,
        nodeId: request.node.id,
        type: "file",
        path: pathValue,
        exists: ok,
        content:
          typeof payload?.content === "string" ? payload.content : undefined,
        metadata: { tool: result.name, output: result.output },
      },
    ];
  }
  return [];
}

function recallArtifacts(
  request: TaskNodeExecutionRequest,
  result: RuntimeToolResult,
): TaskRuntimeArtifact[] {
  const text = stringifyOutput(result.output);
  const noMemory = /NO SPECIFIC MEMORIES FOUND/i.test(text);
  const items = noMemory
    ? []
    : text
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith("- "))
        .map((line) => line.replace(/^-\s*/, "").trim());
  return [
    {
      id: `${request.node.id}-memory`,
      nodeId: request.node.id,
      type: "memory",
      memoryItems: items,
      content: text,
      metadata: { noMemory, tool: result.name },
    },
  ];
}

function taskArtifacts(
  request: TaskNodeExecutionRequest,
  result: RuntimeToolResult,
): TaskRuntimeArtifact[] {
  const text = stringifyOutput(result.output);
  const idMatch = text.match(/\bid:\s*([^\s]+)/i);
  return [
    {
      id: `${request.node.id}-scheduled-task`,
      nodeId: request.node.id,
      type: "scheduled_task",
      taskId: idMatch?.[1] ?? `${request.node.id}-scheduled`,
      content: text,
      metadata: { tool: result.name },
    },
  ];
}

async function executeOneTool(
  toolRouter: ToolRouter,
  request: TaskNodeExecutionRequest,
  signal: AbortSignal,
  toolRequest: RuntimeToolRequest | null,
  artifacts: (result: RuntimeToolResult) => TaskRuntimeArtifact[] = () => [],
): Promise<TaskNodeExecutionResult> {
  if (!toolRequest) {
    return {
      status: "blocked",
      error: `No deterministic tool request could be built for ${request.node.id}.`,
    };
  }
  const [result] = await toolRouter.executeTools([toolRequest], signal);
  if (!result) {
    return {
      status: "failed",
      error: `${toolRequest.name} returned no result.`,
    };
  }
  return {
    status: toolStatus(result),
    output: result.output,
    artifacts: artifacts(result),
    error:
      toolStatus(result) === "succeeded"
        ? undefined
        : stringifyOutput(result.output),
    metadata: { tool: toolRequest.name, callId: toolRequest.callId },
  };
}

function deterministicTaskRequest(
  request: TaskNodeExecutionRequest,
): RuntimeToolRequest | null {
  const intent = getIntent(request);
  if (!intent) return null;
  const runtime = new IntentStepRuntime(intent);
  const deterministic = runtime
    .buildDeterministicToolRequests()
    .find((item) => item.callId?.includes(request.node.id));
  if (!deterministic) return null;
  return {
    name: deterministic.name,
    callId: makeCallId(request.node.id, deterministic.name),
    args: deterministic.args ?? {},
    metadata: deterministic.metadata,
  };
}

function recallRequest(request: TaskNodeExecutionRequest): RuntimeToolRequest {
  const intent = getIntent(request);
  return {
    name: "recall_memory",
    callId: makeCallId(request.node.id, "recall_memory"),
    args: {
      query: request.node.title || request.context.userPrompt,
      limit: 5,
      time_window_days: intent?.timeWindowDays,
      date_from: intent?.dateFrom,
      date_to: intent?.dateTo,
    },
  };
}

function fileWriteRequest(
  request: TaskNodeExecutionRequest,
): RuntimeToolRequest | null {
  const content =
    textFromArtifacts(request) ||
    request.context.currentContent ||
    Object.values(request.context.artifacts ?? {})[0] ||
    "";
  if (!content.trim()) return null;
  return {
    name: "write_file",
    callId: makeCallId(request.node.id, "write_file"),
    args: {
      file_path: deriveFilePath(request),
      content,
      mode: "overwrite",
    },
  };
}

function fileReadRequest(
  request: TaskNodeExecutionRequest,
): RuntimeToolRequest | null {
  const filePath = extractPath(
    `${request.node.title} ${request.context.userPrompt}`,
  );
  if (!filePath) return null;
  return {
    name: "read_file",
    callId: makeCallId(request.node.id, "read_file"),
    args: { file_path: filePath },
  };
}

function shellRequest(
  request: TaskNodeExecutionRequest,
): RuntimeToolRequest | null {
  const command = deriveCommand(request);
  if (!command) return null;
  return {
    name: "run_shell_command",
    callId: makeCallId(request.node.id, "run_shell_command"),
    args: { command },
  };
}

function pushRequest(
  request: TaskNodeExecutionRequest,
): RuntimeToolRequest | null {
  const content =
    textFromArtifacts(request) ||
    request.context.currentContent ||
    Object.values(request.context.artifacts ?? {})[0] ||
    "";
  const channel = deriveChannel(
    `${request.node.title} ${request.context.userPrompt}`,
  );
  if (!channel || !content.trim()) return null;
  return {
    name: "push_to_channel",
    callId: makeCallId(request.node.id, "push_to_channel"),
    args: { channel, content, chat_id: "" },
  };
}

function skillRequest(
  request: TaskNodeExecutionRequest,
): RuntimeToolRequest | null {
  const name = deriveSkillName(request.node.title);
  if (!name) return null;
  return {
    name: "activate_skill",
    callId: makeCallId(request.node.id, "activate_skill"),
    args: { name },
  };
}

function llmAdapter(
  capability: "llm.respond" | "llm.analyze",
): TaskGraphCapabilityAdapter {
  return {
    id: capability,
    capabilities: [capability],
    async execute(request) {
      const content =
        capability === "llm.analyze"
          ? `Analysis node delegated to final LLM response: ${request.node.title}`
          : `Response node delegated to final LLM response: ${request.node.title}`;
      return {
        status: "succeeded",
        output: content,
        artifacts: [
          {
            id: `${request.node.id}-message`,
            nodeId: request.node.id,
            type: capability === "llm.analyze" ? "report" : "message",
            content,
          },
        ],
      };
    },
  };
}

function createAdapters(toolRouter: ToolRouter): TaskGraphCapabilityAdapter[] {
  return [
    llmAdapter("llm.respond"),
    llmAdapter("llm.analyze"),
    {
      id: "jarvis-memory-recall",
      capabilities: ["memory.recall"],
      execute: (request, signal) =>
        executeOneTool(
          toolRouter,
          request,
          signal,
          recallRequest(request),
          (result) => recallArtifacts(request, result),
        ),
    },
    {
      id: "jarvis-file-read",
      capabilities: ["file.read"],
      execute: (request, signal) =>
        executeOneTool(
          toolRouter,
          request,
          signal,
          fileReadRequest(request),
          (result) => workspaceArtifact(request, result),
        ),
    },
    {
      id: "jarvis-file-write",
      capabilities: ["file.write"],
      execute: (request, signal) =>
        executeOneTool(
          toolRouter,
          request,
          signal,
          fileWriteRequest(request),
          (result) => workspaceArtifact(request, result),
        ),
    },
    {
      id: "jarvis-shell-run",
      capabilities: ["shell.run"],
      execute: (request, signal) =>
        executeOneTool(toolRouter, request, signal, shellRequest(request)),
    },
    {
      id: "jarvis-task-schedule",
      capabilities: ["task.schedule"],
      execute: (request, signal) =>
        executeOneTool(
          toolRouter,
          request,
          signal,
          deterministicTaskRequest(request),
          (result) => taskArtifacts(request, result),
        ),
    },
    {
      id: "jarvis-channel-push",
      capabilities: ["channel.push"],
      execute: (request, signal) =>
        executeOneTool(toolRouter, request, signal, pushRequest(request)),
    },
    {
      id: "jarvis-skill-activate",
      capabilities: ["skill.activate"],
      execute: (request, signal) =>
        executeOneTool(toolRouter, request, signal, skillRequest(request)),
    },
  ];
}

function shouldExecuteGraph(input: TaskRuntimeExecuteInput): boolean {
  const graph = input.graph;
  if (graph.nodes.length === 0) return false;
  return graph.nodes.some((node) => {
    if (!DETERMINISTIC_NODE_KINDS.has(node.kind)) return false;
    if (node.kind === "recall" && graph.nodes.length === 1) return false;
    return true;
  });
}

export function createJarvisTaskRuntime(
  options: JarvisTaskGraphRuntimeOptions,
): TaskRuntime | undefined {
  const cfg = enabledConfig(options.config);
  if (cfg?.enabled !== true) return undefined;
  const adapters = createAdapters(options.toolRouter);
  const mode = cfg.mode ?? "plan_only";
  const observability =
    cfg.observability ?? options.config.agentRuntime?.observability === true;
  const store = new JsonFileTaskGraphExecutionStore(
    taskGraphStateDir(options.config),
  );
  const runtime = new AutonomousTaskRuntime(
    new DefaultTaskGraphCapabilityRegistry(adapters),
    {
      store,
      observer: observer(observability),
      maxRecoveryAttempts: cfg.maxRecoveryAttempts ?? 2,
      availableCapabilities: IMPLEMENTED_CAPABILITIES as unknown as string[],
    },
  );

  return {
    mode,
    async plan(input: TaskRuntimePlanInput) {
      const graph = buildTaskGraph(input.intent, buildTaskSpec(input.intent), {
        availableCapabilities: IMPLEMENTED_CAPABILITIES as unknown as string[],
        channelAvailable: input.context.interactiveChannel,
        memoryBoundary: input.memoryContract.subjectBoundary,
      });
      logTaskGraphPlan(graph);
      return graph;
    },
    shouldExecute(input) {
      return shouldExecuteGraph(input);
    },
    async execute(input) {
      if (!shouldExecuteGraph(input)) return null;
      console.error(
        `🧭 [TaskGraph] executing deterministic nodes for graph=${input.graph.id}`,
      );
      const result = await runtime.run({
        intent: input.intent,
        graph: input.graph,
        context: {
          userPrompt: input.context.userPrompt,
          finalResponse: input.context.response?.text,
          currentContent: input.context.currentContent,
          artifacts: input.context.artifacts,
          metadata: {
            ...input.context.metadata,
            intent: input.intent,
            memoryContract: input.memoryContract,
            stepMemoryDecisions: input.stepMemoryDecisions,
            sessionId: options.sessionId,
          },
        },
        signal: input.signal,
      });
      console.error(
        `🧭 [TaskGraph] execution result status=${result.status} snapshot=${result.snapshot.id} replan=${
          result.replanDecisions.map((decision) => decision.action).join(",") ||
          "none"
        }`,
      );
      return result;
    },
  };
}
