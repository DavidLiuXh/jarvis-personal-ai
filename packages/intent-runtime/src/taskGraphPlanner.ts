/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentFrame } from "@jarvis/memory-runtime";
import type { IntentModelClient } from "./modelClient.js";
import type { TaskGraph } from "./taskGraph.js";
import type {
  TaskGraphGap,
  TaskGraphGapDetectorContext,
} from "./taskGraphGapDetector.js";

export type TaskGraphPlanDraftStepKind =
  | "source_acquisition"
  | "local_workspace_discovery"
  | "local_file_read"
  | "evidence_extraction"
  | "analysis"
  | "artifact_write"
  | "memory_recall"
  | "schedule"
  | "channel_push"
  | "delegate"
  | "final_response";

export type TaskGraphPlanDraftSourceType =
  | "user_prompt"
  | "local_file"
  | "local_directory"
  | "current_context"
  | "memory"
  | "web"
  | "tool_result";

export type TaskGraphPlanDraftArtifactType =
  | "message"
  | "report"
  | "file"
  | "source"
  | "memory"
  | "scheduled_task";

export type TaskGraphPlanDraft = {
  goal: string;
  confidence: number;
  assumptions: string[];
  steps: TaskGraphPlanDraftStep[];
};

export type TaskGraphPlanDraftStep = {
  id: string;
  kind: TaskGraphPlanDraftStepKind;
  purpose: string;
  source?: {
    type: TaskGraphPlanDraftSourceType;
    pathHint?: string;
    queryHint?: string;
  };
  artifact?: {
    type: TaskGraphPlanDraftArtifactType;
    format?: "markdown" | "json" | "text" | "html";
    destinationHint?: string;
  };
  dependsOn: string[];
  required: boolean;
  riskLevel: "low" | "medium" | "high";
};

export type TaskGraphPlanDraftValidationResult =
  | { ok: true; draft: TaskGraphPlanDraft; rejectedReasons: [] }
  | { ok: false; draft: null; rejectedReasons: string[] };

export type TaskGraphPlannerInput = {
  intent: IntentFrame;
  graph: TaskGraph;
  gaps: TaskGraphGap[];
  context?: TaskGraphGapDetectorContext;
  modelClient: IntentModelClient;
  timeoutMs?: number;
};

export type TaskGraphPlannerResult = {
  draft: TaskGraphPlanDraft | null;
  rejectedReasons: string[];
  prompt: string;
  rawResponse: string | null;
};

const STEP_KINDS = new Set<TaskGraphPlanDraftStepKind>([
  "source_acquisition",
  "local_workspace_discovery",
  "local_file_read",
  "evidence_extraction",
  "analysis",
  "artifact_write",
  "memory_recall",
  "schedule",
  "channel_push",
  "delegate",
  "final_response",
]);

const SOURCE_TYPES = new Set<TaskGraphPlanDraftSourceType>([
  "user_prompt",
  "local_file",
  "local_directory",
  "current_context",
  "memory",
  "web",
  "tool_result",
]);

const ARTIFACT_TYPES = new Set<TaskGraphPlanDraftArtifactType>([
  "message",
  "report",
  "file",
  "source",
  "memory",
  "scheduled_task",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function parsePlannerJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("planner_response_not_json");
    return JSON.parse(match[0]);
  }
}

function sourceText(
  intent: IntentFrame,
  context: TaskGraphGapDetectorContext,
): string {
  return [
    context.userPrompt,
    context.currentContent,
    ...Object.values(context.artifacts ?? {}),
    intent.richIntent.userGoal,
    intent.reason,
    ...intent.evidence,
  ]
    .filter(Boolean)
    .join("\n");
}

function pathIsGrounded(pathHint: string, source: string): boolean {
  return source.includes(pathHint);
}

function hasCycle(steps: TaskGraphPlanDraftStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    const step = byId.get(id);
    if (!step) return false;
    visiting.add(id);
    for (const dep of step.dependsOn) {
      if (visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

function hasForbiddenExecutionFields(step: Record<string, unknown>): boolean {
  return (
    "toolArgs" in step ||
    "tool_call" in step ||
    "toolCall" in step ||
    "command" in step ||
    "shellCommand" in step
  );
}

function validateStep(
  value: unknown,
  ids: Set<string>,
  groundedText: string,
): TaskGraphPlanDraftStep | string[] {
  const record = asRecord(value);
  const rejected: string[] = [];
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const kind = record.kind;
  const purpose =
    typeof record.purpose === "string" ? record.purpose.trim() : "";
  const dependsOn = Array.isArray(record.dependsOn)
    ? record.dependsOn.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const required = record.required;
  const riskLevel = record.riskLevel;

  if (!id) rejected.push("step_missing_id");
  if (id && ids.has(id)) rejected.push(`duplicate_step_id:${id}`);
  if (!STEP_KINDS.has(kind as TaskGraphPlanDraftStepKind)) {
    rejected.push(`unknown_step_kind:${String(kind)}`);
  }
  if (!purpose) rejected.push(`step_missing_purpose:${id || "unknown"}`);
  if (typeof required !== "boolean") {
    rejected.push(`step_required_not_boolean:${id || "unknown"}`);
  }
  if (!["low", "medium", "high"].includes(String(riskLevel))) {
    rejected.push(`invalid_risk_level:${id || "unknown"}`);
  }
  if (hasForbiddenExecutionFields(record)) {
    rejected.push(`forbidden_execution_field:${id || "unknown"}`);
  }

  const sourceRecord = record.source ? asRecord(record.source) : undefined;
  const artifactRecord = record.artifact
    ? asRecord(record.artifact)
    : undefined;

  const step: TaskGraphPlanDraftStep = {
    id,
    kind: kind as TaskGraphPlanDraftStepKind,
    purpose,
    dependsOn,
    required: Boolean(required),
    riskLevel: riskLevel as "low" | "medium" | "high",
  };

  if (sourceRecord) {
    const sourceType = sourceRecord.type;
    if (!SOURCE_TYPES.has(sourceType as TaskGraphPlanDraftSourceType)) {
      rejected.push(`unknown_source_type:${id || "unknown"}`);
    }
    const pathHint =
      typeof sourceRecord.pathHint === "string"
        ? sourceRecord.pathHint.trim()
        : undefined;
    if (pathHint && !pathIsGrounded(pathHint, groundedText)) {
      rejected.push(`ungrounded_path_hint:${pathHint}`);
    }
    step.source = {
      type: sourceType as TaskGraphPlanDraftSourceType,
      ...(pathHint ? { pathHint } : {}),
      ...(typeof sourceRecord.queryHint === "string"
        ? { queryHint: sourceRecord.queryHint }
        : {}),
    };
  }

  if (artifactRecord) {
    const artifactType = artifactRecord.type;
    if (!ARTIFACT_TYPES.has(artifactType as TaskGraphPlanDraftArtifactType)) {
      rejected.push(`unknown_artifact_type:${id || "unknown"}`);
    }
    step.artifact = {
      type: artifactType as TaskGraphPlanDraftArtifactType,
      ...(typeof artifactRecord.format === "string"
        ? {
            format: artifactRecord.format as
              | "markdown"
              | "json"
              | "text"
              | "html",
          }
        : {}),
      ...(typeof artifactRecord.destinationHint === "string"
        ? { destinationHint: artifactRecord.destinationHint }
        : {}),
    };
  }

  if (rejected.length > 0) return rejected;
  ids.add(id);
  return step;
}

export function validateTaskGraphPlanDraft(
  value: unknown,
  input: { intent: IntentFrame; context?: TaskGraphGapDetectorContext },
): TaskGraphPlanDraftValidationResult {
  let parsed: unknown;
  try {
    parsed = parsePlannerJson(value);
  } catch (error) {
    return {
      ok: false,
      draft: null,
      rejectedReasons: [
        error instanceof Error ? error.message : "planner_response_not_json",
      ],
    };
  }

  const record = asRecord(parsed);
  const rejected: string[] = [];
  const goal = typeof record.goal === "string" ? record.goal.trim() : "";
  const confidence =
    typeof record.confidence === "number" ? record.confidence : Number.NaN;
  const assumptions = Array.isArray(record.assumptions)
    ? record.assumptions.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];

  if (!goal) rejected.push("draft_missing_goal");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    rejected.push("draft_invalid_confidence");
  }
  if (rawSteps.length === 0) rejected.push("draft_missing_steps");

  const ids = new Set<string>();
  const steps: TaskGraphPlanDraftStep[] = [];
  const groundedText = sourceText(input.intent, input.context ?? {});
  for (const rawStep of rawSteps) {
    const step = validateStep(rawStep, ids, groundedText);
    if (Array.isArray(step)) {
      rejected.push(...step);
    } else {
      steps.push(step);
    }
  }

  const knownIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!knownIds.has(dep)) {
        rejected.push(`unknown_dependency:${step.id}:${dep}`);
      }
    }
  }
  if (hasCycle(steps)) rejected.push("draft_dependency_cycle");

  if (rejected.length > 0) {
    return { ok: false, draft: null, rejectedReasons: rejected };
  }
  return {
    ok: true,
    rejectedReasons: [],
    draft: { goal, confidence, assumptions, steps },
  };
}

export function buildTaskGraphPlannerPrompt(input: {
  intent: IntentFrame;
  graph: TaskGraph;
  gaps: TaskGraphGap[];
  context?: TaskGraphGapDetectorContext;
}): string {
  return [
    "You are compiling a user request into a high-level workflow draft.",
    "Return strict JSON only. Do not produce tool calls. Do not generate shell commands.",
    "Do not invent paths. pathHint values must come from the user prompt or provided context.",
    "Allowed step kinds: source_acquisition, local_workspace_discovery, local_file_read, evidence_extraction, analysis, artifact_write, memory_recall, schedule, channel_push, delegate, final_response.",
    "",
    `<user_prompt>${input.context?.userPrompt ?? ""}</user_prompt>`,
    `<intent_goal>${input.intent.richIntent.userGoal}</intent_goal>`,
    `<intent_task_type>${input.intent.taskType}</intent_task_type>`,
    `<graph_nodes>${input.graph.nodes.map((node) => `${node.id}:${node.kind}`).join(",")}</graph_nodes>`,
    `<gaps>${input.gaps.map((gap) => gap.kind).join(",")}</gaps>`,
    "",
    "JSON shape:",
    '{"goal":"","confidence":0.0,"assumptions":[],"steps":[{"id":"draft-1","kind":"analysis","purpose":"","dependsOn":[],"required":true,"riskLevel":"low"}]}',
  ].join("\n");
}

export async function planTaskGraphDraft(
  input: TaskGraphPlannerInput,
): Promise<TaskGraphPlannerResult> {
  const prompt = buildTaskGraphPlannerPrompt(input);
  let rawResponse: string | null = null;
  try {
    rawResponse = await input.modelClient.generateJson({
      prompt,
      responseFormat: "json",
      temperature: 0,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    return {
      draft: null,
      prompt,
      rawResponse,
      rejectedReasons: [
        error instanceof Error ? error.message : "planner_model_failed",
      ],
    };
  }

  const validation = validateTaskGraphPlanDraft(rawResponse, {
    intent: input.intent,
    context: input.context,
  });
  if (!validation.ok) {
    return {
      draft: null,
      prompt,
      rawResponse,
      rejectedReasons: validation.rejectedReasons,
    };
  }
  return {
    draft: validation.draft,
    prompt,
    rawResponse,
    rejectedReasons: [],
  };
}
