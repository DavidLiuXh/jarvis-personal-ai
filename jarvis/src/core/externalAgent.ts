/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Describes an externally-deployed ADK agent.
 * Loaded from ~/.gemini-jarvis/agents/<id>/agent.json at startup.
 */
export type AgentCard = {
  /** Unique identifier, e.g. "investment-analysis" */
  agentId: string;
  /** Human-readable name shown in UI */
  name: string;
  /** One-line description of what the agent does */
  description: string;
  /** Absolute path to the Python entry point (main.py) */
  entrypoint: string;
  /** JSON Schema for the task input object */
  inputSchema: Record<string, unknown>;
  /** Rough duration hint shown to the user, e.g. "2-4 minutes" */
  estimatedDuration: string;
  /** Keywords / phrases that trigger automatic routing to this agent */
  triggers: string[];
};

export type AgentTaskStatus =
  | "pending"
  | "starting"
  | "running"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTask = {
  taskId: string;
  agentId: string;
  /** Jarvis session that spawned this task */
  sessionId: string;
  status: AgentTaskStatus;
  /** Input sent to the agent */
  input: Record<string, unknown>;
  /** Accumulated streaming chunks */
  streamChunks: string[];
  /** Final output (set on completion) */
  output?: string;
  /** Error message (set on failure) */
  error?: string;
  /** OS process id of the spawned agent */
  pid?: number;
  /** Local port the agent is listening on */
  port?: number;
  /** A2A context id for session resumption (INPUT_REQUIRED flow) */
  a2aContextId?: string;
  /** Agent process stdout/stderr lines (last 200), for debugging */
  logs: string[];
  createdAt: number;
  updatedAt: number;
};

/** Events emitted by AgentManager */
export type AgentTaskEvent =
  | { type: "agent_task_created"; task: AgentTask }
  | { type: "agent_task_started"; taskId: string }
  | { type: "agent_task_stream"; taskId: string; chunk: string }
  | { type: "agent_task_done"; taskId: string; output: string }
  | { type: "agent_task_failed"; taskId: string; error: string }
  | { type: "agent_task_cancelled"; taskId: string }
  | {
      type: "agent_input_required";
      taskId: string;
      question: string;
    };
