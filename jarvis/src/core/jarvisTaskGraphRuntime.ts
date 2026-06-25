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
  type TaskFinalResponseContract,
  type TaskGraph,
  type TaskGraphCapabilityAdapter,
  type TaskGraphExecutionObserver,
  type TaskNodeExecutionRequest,
  type TaskNodeExecutionResult,
  type TaskNodeExecutionStatus,
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
  "web.search",
  "task.schedule",
  "channel.push",
  "skill.activate",
] as const;

const DETERMINISTIC_NODE_KINDS = new Set([
  "recall",
  "research",
  "write_file",
  "read_file",
  "run_shell",
  "schedule",
  "push",
]);

const PRE_LLM_BLOCKING_NODE_KINDS = new Set(["analyze", "respond", "delegate"]);

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

function compactLogText(value: unknown, max = 180): string {
  const text = stringifyOutput(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function formatCriteria(node: TaskGraph["nodes"][number]): string {
  return (
    node.acceptanceCriteria
      .map(
        (criterion) =>
          `${criterion.id}:${criterion.type}${criterion.required ? ":required" : ""}`,
      )
      .join(",") || "none"
  );
}

function formatArtifact(artifact: TaskRuntimeArtifact): string {
  const parts = [`${artifact.id}:${artifact.type}`];
  if (artifact.path) parts.push(`path=${artifact.path}`);
  if (artifact.taskId) parts.push(`taskId=${artifact.taskId}`);
  if (artifact.exists !== undefined) parts.push(`exists=${artifact.exists}`);
  if (artifact.memoryItems) parts.push(`items=${artifact.memoryItems.length}`);
  if (artifact.checksum) parts.push(`checksum=${artifact.checksum}`);
  return parts.join(" ");
}

function logTaskGraphPlan(
  graph: TaskGraph,
  input: TaskRuntimePlanInput,
  options: {
    mode: string;
    observability: boolean;
    stateDir: string;
    maxRecoveryAttempts: number;
  },
): void {
  console.error(
    `🧭 [TaskGraph] runtime config mode=${options.mode} observability=${options.observability} ` +
      `stateDir=${options.stateDir} maxRecoveryAttempts=${options.maxRecoveryAttempts}`,
  );
  console.error(
    `🧭 [TaskGraph] context subject=${input.intent.subject} taskType=${input.intent.taskType} ` +
      `memoryBoundary=${input.memoryContract.subjectBoundary} memoryTarget=${input.memoryContract.memoryTarget} ` +
      `interactiveChannel=${input.context.interactiveChannel} currentContent=${
        input.context.currentContent?.trim() ? "yes" : "no"
      } artifacts=${Object.keys(input.context.artifacts ?? {}).length} skills=${input.skills.length}`,
  );
  console.error(
    `🧭 [TaskGraph] planned id=${graph.id} status=${graph.status} nodes=${graph.nodes.length} edges=${graph.edges.length}`,
  );
  console.error(
    `🧭 [TaskGraph] execution plan:\n${graph.nodes
      .map((node) => `  ${formatNode(node)}`)
      .join("\n")}`,
  );
  if (options.observability) {
    console.error(
      `🧭 [TaskGraph] acceptance plan:\n${graph.nodes
        .map((node) => `  ${node.id}: ${formatCriteria(node)}`)
        .join("\n")}`,
    );
  }
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
        `🧭 [TaskGraph] node started id=${event.nodeId} kind=${event.kind} attempt=${event.attempt} ` +
          `adapter=${event.adapterId} caps=${event.requiredCapabilities.join(",") || "none"}`,
      );
    } else if (event.type === "task_node_result") {
      console.error(
        `🧭 [TaskGraph] node result id=${event.nodeId} status=${event.status} ` +
          `artifacts=${event.artifactCount} artifactTypes=${event.artifactTypes.join(",") || "none"}` +
          (event.error ? ` error="${compactLogText(event.error)}"` : ""),
      );
    } else if (event.type === "task_node_acceptance") {
      console.error(
        `🧭 [TaskGraph] node acceptance id=${event.nodeId} ` +
          event.results
            .map(
              (result) =>
                `${result.criterionId}:${result.ok ? "pass" : "fail"}${result.blocking ? ":blocking" : ""}` +
                (result.ok ? "" : ` reason="${compactLogText(result.reason)}"`),
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
        `🧭 [TaskGraph] finished id=${event.graphId} status=${event.status} blocked=${event.blocked} failed=${event.failed} ` +
          `canClaimSuccess=${event.finalResponseCanClaimSuccess ?? false}`,
      );
      const blockedReasons = event.blockedReasons ?? [];
      const failedReasons = event.failedReasons ?? [];
      if (blockedReasons.length > 0) {
        console.error(
          `🧭 [TaskGraph] blocked reasons:\n${blockedReasons
            .map((reason) => `  - ${reason}`)
            .join("\n")}`,
        );
      }
      if (failedReasons.length > 0) {
        console.error(
          `🧭 [TaskGraph] failed reasons:\n${failedReasons
            .map((reason) => `  - ${reason}`)
            .join("\n")}`,
        );
      }
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
  const parsed = parseJsonObject(result.output);
  const payload =
    parsed?.result && typeof parsed.result === "object"
      ? (parsed.result as Record<string, unknown>)
      : parsed;
  const taskId =
    (typeof payload?.taskId === "string" ? payload.taskId : undefined) ??
    (typeof payload?.id === "string" ? payload.id : undefined) ??
    text.match(/\bid:\s*([^\s]+)/i)?.[1];
  return [
    {
      id: `${request.node.id}-scheduled-task`,
      nodeId: request.node.id,
      type: "scheduled_task",
      taskId,
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

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const RESEARCH_QUERY_FILLER_RE =
  /\b(?:execute|collect|search|fetch|crawl|scrape|gather|find|source|sources|sites|authoritative|websites?|references?)\b|资料|素材|来源|信源|网站|网页|权威|收集|检索|搜索|抓取|爬取|查找|整理/gim;

function deriveResearchQueryText(
  node: TaskGraph["nodes"][number],
  userPrompt: string,
): string {
  const title = node.title.trim();
  const strippedTitle = title
    .replace(RESEARCH_QUERY_FILLER_RE, " ")
    .replace(/^\s*(?:on|about|for|regarding|around|关于|有关|围绕)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (strippedTitle.length >= 3) return strippedTitle;
  return [title, userPrompt]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function webSearchRequest(
  request: TaskNodeExecutionRequest,
): RuntimeToolRequest | null {
  const query = deriveResearchQueryText(
    request.node,
    request.context.userPrompt,
  );
  if (!query) return null;
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
  return {
    name: "run_shell_command",
    callId: makeCallId(request.node.id, "web_search"),
    args: {
      command: `curl -L --silent --show-error --max-time 20 ${shellSingleQuote(url)}`,
      timeout_ms: 25_000,
    },
    metadata: {
      capability: "web.search",
      query,
      provider: "jina-search",
      url,
    },
  };
}

function shellOutputPayload(output: unknown): Record<string, unknown> | null {
  const parsed = parseJsonObject(output);
  const result = parsed?.result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : parsed;
}

function extractSourceUrls(content: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of content.matchAll(/https?:\/\/[^\s)\]}>"']+/g)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= 20) break;
  }
  return urls;
}

function sourceArtifacts(
  request: TaskNodeExecutionRequest,
  result: RuntimeToolResult,
): TaskRuntimeArtifact[] {
  const payload = shellOutputPayload(result.output);
  const stdout = typeof payload?.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload?.stderr === "string" ? payload.stderr : "";
  const content = stdout.trim() || stringifyOutput(result.output);
  const query =
    (result as RuntimeToolResult & { metadata?: Record<string, unknown> })
      .metadata?.query ??
    deriveResearchQueryText(request.node, request.context.userPrompt);
  const sources = extractSourceUrls(content);
  return [
    {
      id: `${request.node.id}-sources`,
      nodeId: request.node.id,
      type: "source",
      content,
      metadata: {
        tool: result.name,
        query,
        sources,
        stderr: stderr || undefined,
      },
    },
  ];
}

async function executeWebSearch(
  toolRouter: ToolRouter,
  request: TaskNodeExecutionRequest,
  signal: AbortSignal,
): Promise<TaskNodeExecutionResult> {
  const toolRequest = webSearchRequest(request);
  if (!toolRequest) {
    return {
      status: "blocked",
      error: `No deterministic web search query could be built for ${request.node.id}.`,
    };
  }
  const [result] = await toolRouter.executeTools([toolRequest], signal);
  if (!result) {
    return {
      status: "failed",
      error: `${toolRequest.name} returned no result.`,
    };
  }
  const parsed = parseJsonObject(result.output);
  const payload = shellOutputPayload(result.output);
  const exitCode =
    typeof payload?.exit_code === "number" ? payload.exit_code : undefined;
  const timedOut = payload?.timed_out === true;
  const ok =
    result.status === "success" &&
    parsed?.ok !== false &&
    exitCode !== null &&
    exitCode !== undefined &&
    exitCode === 0 &&
    !timedOut;
  const stdout = typeof payload?.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload?.stderr === "string" ? payload.stderr : "";
  const artifacts = ok ? sourceArtifacts(request, result) : [];
  const query = String(toolRequest.metadata?.query ?? "");
  return {
    status: ok ? "succeeded" : "failed",
    output: {
      query,
      sources: artifacts[0]?.metadata?.sources ?? [],
      content: stdout.trim(),
      stderr: stderr || undefined,
    },
    artifacts,
    error: ok ? undefined : stderr || stringifyOutput(result.output),
    metadata: {
      tool: toolRequest.name,
      callId: toolRequest.callId,
      capability: "web.search",
      provider: toolRequest.metadata?.provider,
    },
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
      id: "jarvis-web-search",
      capabilities: ["web.search"],
      execute: (request, signal) =>
        executeWebSearch(toolRouter, request, signal),
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

function hasCurrentContextWriteSource(input: TaskRuntimeExecuteInput): boolean {
  return (
    input.intent.referencesRecentHistory === true ||
    input.intent.memoryTarget === "current_context_reference" ||
    input.intent.richIntent.contextDependency.recentConversation === true
  );
}

function hasConcreteContextContent(input: TaskRuntimeExecuteInput): boolean {
  return Boolean(
    input.context.currentContent?.trim() ||
      Object.values(input.context.artifacts ?? {}).some((value) =>
        value.trim(),
      ),
  );
}

function hasSafeDependency(
  node: TaskGraph["nodes"][number],
  safeNodeIds: Set<string>,
): boolean {
  return node.inputs.some(
    (item) => item.sourceNodeId && safeNodeIds.has(item.sourceNodeId),
  );
}

function deterministicNodeInputReady(
  input: TaskRuntimeExecuteInput,
  node: TaskGraph["nodes"][number],
  safeNodeIds: Set<string>,
): { ok: boolean; reason: string } {
  if (node.blockedReason) {
    return { ok: false, reason: `blocked:${node.blockedReason}` };
  }
  if (node.kind === "recall" && input.graph.nodes.length === 1) {
    return {
      ok: false,
      reason: "recall_only_delegated_to_llm_active_recall",
    };
  }
  if (node.kind === "write_file") {
    if (hasSafeDependency(node, safeNodeIds)) {
      return { ok: true, reason: "dependency_artifact_available" };
    }
    if (
      hasConcreteContextContent(input) &&
      hasCurrentContextWriteSource(input)
    ) {
      return { ok: true, reason: "current_context_content_available" };
    }
    return {
      ok: false,
      reason: "no_concrete_write_content",
    };
  }
  if (node.kind === "research") {
    return deriveResearchQueryText(node, input.context.userPrompt)
      ? { ok: true, reason: "research_query_available" }
      : { ok: false, reason: "missing_research_query" };
  }
  if (node.kind === "read_file") {
    return extractPath(`${node.title} ${input.context.userPrompt}`)
      ? { ok: true, reason: "file_path_available" }
      : { ok: false, reason: "missing_file_path" };
  }
  if (node.kind === "run_shell") {
    return deriveCommand({
      graph: input.graph,
      node,
      attempt: 1,
      dependencyOutputs: {},
      artifacts: [],
      context: {
        userPrompt: input.context.userPrompt,
        currentContent: input.context.currentContent,
        artifacts: input.context.artifacts,
      },
    })
      ? { ok: true, reason: "command_available" }
      : { ok: false, reason: "missing_command" };
  }
  if (node.kind === "push") {
    const channel = deriveChannel(`${node.title} ${input.context.userPrompt}`);
    const hasContent =
      hasSafeDependency(node, safeNodeIds) || hasConcreteContextContent(input);
    if (!channel) return { ok: false, reason: "missing_channel" };
    if (!hasContent) return { ok: false, reason: "missing_push_content" };
    return { ok: true, reason: "channel_and_content_available" };
  }
  return { ok: true, reason: "deterministic_input_available" };
}

type TaskGraphExecutionDecision = {
  execute: boolean;
  reasons: string[];
  executableNodeIds: string[];
  deterministicNodeIds: string[];
  llmBlockingNodeIds: string[];
  deferredNodeIds: string[];
  skippedNodeReasons: string[];
};

function evaluateExecutionDecision(
  input: TaskRuntimeExecuteInput,
): TaskGraphExecutionDecision {
  const graph = input.graph;
  const reasons: string[] = [];
  if (graph.nodes.length === 0) {
    return {
      execute: false,
      reasons: ["no_nodes"],
      executableNodeIds: [],
      deterministicNodeIds: [],
      llmBlockingNodeIds: [],
      deferredNodeIds: [],
      skippedNodeReasons: [],
    };
  }
  if (graph.blockedReasons.length > 0) {
    reasons.push(`planning_blockers=${graph.blockedReasons.length}`);
  }
  const llmBlockingNodeIds = graph.nodes
    .filter((node) => PRE_LLM_BLOCKING_NODE_KINDS.has(node.kind))
    .map((node) => node.id);
  if (llmBlockingNodeIds.length > 0) {
    reasons.push(`llm_nodes_deferred=${llmBlockingNodeIds.join(",")}`);
  }
  const deterministicNodeIds = graph.nodes
    .filter((node) => DETERMINISTIC_NODE_KINDS.has(node.kind))
    .map((node) => node.id);
  const safeNodeIds = new Set<string>();
  const skippedNodeReasons = new Map<string, string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of graph.nodes) {
      if (safeNodeIds.has(node.id)) continue;
      if (!DETERMINISTIC_NODE_KINDS.has(node.kind)) {
        skippedNodeReasons.set(node.id, `non_deterministic:${node.kind}`);
        continue;
      }
      const dependencyIds = node.inputs
        .filter((item) => item.required && item.sourceNodeId)
        .map((item) => item.sourceNodeId!);
      const unmetDependency = dependencyIds.find(
        (dependencyId) => !safeNodeIds.has(dependencyId),
      );
      if (unmetDependency) {
        skippedNodeReasons.set(
          node.id,
          `waiting_for_unexecuted_dependency:${unmetDependency}`,
        );
        continue;
      }
      const readiness = deterministicNodeInputReady(input, node, safeNodeIds);
      if (!readiness.ok) {
        skippedNodeReasons.set(node.id, readiness.reason);
        continue;
      }
      safeNodeIds.add(node.id);
      skippedNodeReasons.delete(node.id);
      progressed = true;
    }
  }
  const executableNodeIds = graph.nodes
    .filter((node) => safeNodeIds.has(node.id))
    .map((node) => node.id);
  const deferredNodeIds = graph.nodes
    .filter((node) => !safeNodeIds.has(node.id))
    .map((node) => node.id);
  if (deterministicNodeIds.length === 0) {
    reasons.push("no_deterministic_nodes");
  }
  if (
    deterministicNodeIds.length > 0 &&
    executableNodeIds.length === 0 &&
    graph.nodes.every((node) => node.kind === "recall")
  ) {
    reasons.push("recall_only_delegated_to_llm_active_recall");
  }
  if (executableNodeIds.length > 0) {
    reasons.push("deterministic_nodes_available");
  }
  return {
    execute: executableNodeIds.length > 0,
    reasons,
    executableNodeIds,
    deterministicNodeIds,
    llmBlockingNodeIds,
    deferredNodeIds,
    skippedNodeReasons: [...skippedNodeReasons.entries()].map(
      ([nodeId, reason]) => `${nodeId}:${reason}`,
    ),
  };
}

function logExecutionDecision(
  input: TaskRuntimeExecuteInput,
  decision: TaskGraphExecutionDecision,
): void {
  console.error(
    `🧭 [TaskGraph] execution decision graph=${input.graph.id} execute=${decision.execute} ` +
      `reasons=${decision.reasons.join(",") || "none"} executable=${decision.executableNodeIds.join(",") || "-"} ` +
      `deterministic=${decision.deterministicNodeIds.join(",") || "-"} llmBlocking=${decision.llmBlockingNodeIds.join(",") || "-"} ` +
      `deferred=${decision.deferredNodeIds.join(",") || "-"}`,
  );
  if (decision.skippedNodeReasons.length > 0) {
    console.error(
      `🧭 [TaskGraph] execution skip reasons:\n${decision.skippedNodeReasons
        .map((reason) => `  - ${reason}`)
        .join("\n")}`,
    );
  }
}

function logExecutionSummary(
  result: Awaited<ReturnType<AutonomousTaskRuntime["run"]>>,
  observability: boolean,
): void {
  console.error(
    `🧭 [TaskGraph] execution result status=${result.status} snapshot=${result.snapshot.id} ` +
      `snapshotStatus=${result.snapshot.status} nodes=${result.execution.nodes.length} artifacts=${result.execution.artifacts.length} ` +
      `replan=${result.replanDecisions.map((decision) => `${decision.action}:${decision.reasonCode}`).join(",") || "none"} ` +
      `canClaimSuccess=${result.execution.finalResponseContract.canClaimSuccess}`,
  );
  if (!observability) return;
  if (result.execution.artifacts.length > 0) {
    console.error(
      `🧭 [TaskGraph] artifacts:\n${result.execution.artifacts
        .map((artifact) => `  - ${formatArtifact(artifact)}`)
        .join("\n")}`,
    );
  }
  if (result.replanDecisions.length > 0) {
    console.error(
      `🧭 [TaskGraph] replan decisions:\n${result.replanDecisions
        .map(
          (decision) =>
            `  - action=${decision.action} node=${decision.nodeId ?? "-"} reason=${decision.reasonCode}`,
        )
        .join("\n")}`,
    );
  }
  if (result.execution.blockedReasons.length > 0) {
    console.error(
      `🧭 [TaskGraph] execution blocked reasons:\n${result.execution.blockedReasons
        .map((reason) => `  - ${reason}`)
        .join("\n")}`,
    );
  }
  if (result.execution.failedReasons.length > 0) {
    console.error(
      `🧭 [TaskGraph] execution failed reasons:\n${result.execution.failedReasons
        .map((reason) => `  - ${reason}`)
        .join("\n")}`,
    );
  }
}

function buildExecutableSubgraph(
  graph: TaskGraph,
  decision: TaskGraphExecutionDecision,
): TaskGraph {
  const executableNodeIds = new Set(decision.executableNodeIds);
  if (executableNodeIds.size === graph.nodes.length) return graph;
  const partial = executableNodeIds.size < graph.nodes.length;
  return {
    ...graph,
    id: `${graph.id}-preexec-${decision.executableNodeIds.join("-")}`,
    nodes: graph.nodes
      .filter((node) => executableNodeIds.has(node.id))
      .map((node) =>
        partial && node.kind === "research"
          ? {
              ...node,
              // Research pre-execution is an optimization. If source fetch
              // times out, the main LLM/tool loop can still complete the step.
              optional: true,
              retryPolicy: { ...node.retryPolicy, maxAttempts: 1 },
            }
          : node,
      ),
    edges: graph.edges.filter(
      (edge) =>
        executableNodeIds.has(edge.from) && executableNodeIds.has(edge.to),
    ),
    status: "planned",
    blockedReasons: [],
  };
}

function partialExecutionContract(
  fullGraph: TaskGraph,
  completedNodeIds: Set<string>,
  attemptedStates: Array<{
    node: TaskGraph["nodes"][number];
    status: TaskNodeExecutionStatus;
    lastError: string | null;
  }>,
): TaskFinalResponseContract {
  const remainingNodes = fullGraph.nodes.filter(
    (node) => !completedNodeIds.has(node.id),
  );
  const attemptedById = new Map(
    attemptedStates.map((state) => [state.node.id, state]),
  );
  const completedLabel = [...completedNodeIds].join(",") || "none";
  return {
    canClaimSuccess: false,
    incompleteNodes: remainingNodes.map((node) => ({
      nodeId: node.id,
      status: attemptedById.get(node.id)?.status ?? "pending",
      reason:
        attemptedById.get(node.id)?.lastError ??
        (PRE_LLM_BLOCKING_NODE_KINDS.has(node.kind)
          ? "requires LLM generation or reasoning after pre-executed artifacts are available"
          : "depends on a node that was deferred to the LLM/tool loop"),
    })),
    instruction:
      `Only the deterministic pre-LLM TaskGraph nodes were executed: ${
        completedLabel
      }. ` +
      `Remaining nodes still need completion in the LLM/tool loop or final response: ${
        remainingNodes.map((node) => `${node.id}:${node.kind}`).join(",") ||
        "none"
      }. Use pre-executed artifacts as inputs. Do not claim that deferred file, schedule, push, analysis, or delegate nodes completed unless they are actually completed later in this turn.`,
  };
}

function applyPartialExecutionContract(
  fullGraph: TaskGraph,
  result: Awaited<ReturnType<AutonomousTaskRuntime["run"]>>,
): Awaited<ReturnType<AutonomousTaskRuntime["run"]>> {
  const completedNodeIds = new Set(
    result.execution.nodes
      .filter((state) => state.status === "succeeded")
      .map((state) => state.node.id),
  );
  if (completedNodeIds.size === fullGraph.nodes.length) return result;
  const contract = partialExecutionContract(
    fullGraph,
    completedNodeIds,
    result.execution.nodes,
  );
  return {
    ...result,
    execution: {
      ...result.execution,
      finalResponseContract: contract,
    },
  };
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
  const stateDir = taskGraphStateDir(options.config);
  const maxRecoveryAttempts = cfg.maxRecoveryAttempts ?? 2;
  if (mode === "skip") {
    console.error(
      `🧭 [TaskGraph] runtime config mode=skip observability=${observability} stateDir=${stateDir}; planning disabled`,
    );
  }
  const store = new JsonFileTaskGraphExecutionStore(stateDir);
  const runtime = new AutonomousTaskRuntime(
    new DefaultTaskGraphCapabilityRegistry(adapters),
    {
      store,
      observer: observer(observability),
      maxRecoveryAttempts,
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
      logTaskGraphPlan(graph, input, {
        mode,
        observability,
        stateDir,
        maxRecoveryAttempts,
      });
      return graph;
    },
    shouldExecute(input) {
      const decision = evaluateExecutionDecision(input);
      logExecutionDecision(input, decision);
      return decision.execute;
    },
    async execute(input) {
      const decision = evaluateExecutionDecision(input);
      if (!decision.execute) {
        logExecutionDecision(input, decision);
        return null;
      }
      const executableGraph = buildExecutableSubgraph(input.graph, decision);
      console.error(
        `🧭 [TaskGraph] executing deterministic nodes for graph=${input.graph.id} executedGraph=${executableGraph.id} nodes=${decision.executableNodeIds.join(",")}`,
      );
      const result = await runtime.run({
        intent: input.intent,
        graph: executableGraph,
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
      const normalizedResult = applyPartialExecutionContract(
        input.graph,
        result,
      );
      logExecutionSummary(normalizedResult, observability);
      return normalizedResult;
    },
  };
}
