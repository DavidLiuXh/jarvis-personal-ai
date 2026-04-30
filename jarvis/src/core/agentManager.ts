/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AgentCard,
  AgentTask,
  AgentTaskEvent,
  AgentTaskStatus,
} from "./externalAgent.js";

/**
 * Manages the lifecycle of all running ADK agent tasks.
 *
 * Responsibilities:
 *  - Create / track / cancel tasks
 *  - Emit AgentTaskEvents that index.ts bridges to WebSocket clients
 *  - Provide task listing for the UI panel
 *
 * Actual process spawning and A2A communication is delegated to
 * AgentLauncher (Phase 2). During Phase 1 the launch is a no-op stub.
 */
export class AgentManager extends EventEmitter {
  private tasks = new Map<string, AgentTask>();
  private registry: AgentCard[] = [];

  constructor(registry: AgentCard[] = []) {
    super();
    this.registry = registry;
  }

  // ── Registry ────────────────────────────────────────────────────────────

  getRegistry(): AgentCard[] {
    return this.registry;
  }

  getCard(agentId: string): AgentCard | undefined {
    return this.registry.find((c) => c.agentId === agentId);
  }

  // ── Task creation ────────────────────────────────────────────────────────

  /**
   * Creates a new task and schedules it for execution (non-blocking).
   * Returns the task immediately so the caller can report taskId to the user.
   */
  createTask(
    agentId: string,
    sessionId: string,
    input: Record<string, unknown>,
  ): AgentTask {
    const card = this.getCard(agentId);
    if (!card) throw new Error(`Unknown agent: ${agentId}`);

    const task: AgentTask = {
      taskId: randomUUID(),
      agentId,
      sessionId,
      status: "pending",
      input,
      streamChunks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.tasks.set(task.taskId, task);
    this.emit("event", {
      type: "agent_task_created",
      task,
    } satisfies AgentTaskEvent);

    console.error(
      `🤖 [AgentManager] Task created: ${task.taskId} (agent=${agentId}, session=${sessionId})`,
    );

    // Non-blocking launch — Phase 2 will replace this stub
    setImmediate(() => this.launchTask(task, card));

    return task;
  }

  // ── Task queries ─────────────────────────────────────────────────────────

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(sessionId?: string): AgentTask[] {
    const all = Array.from(this.tasks.values());
    return sessionId ? all.filter((t) => t.sessionId === sessionId) : all;
  }

  // ── User interaction ─────────────────────────────────────────────────────

  /**
   * Provide user input to a task that is in INPUT_REQUIRED state.
   * Phase 2 will forward this to the running A2A session.
   */
  sendInput(taskId: string, value: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.error(`⚠️ [AgentManager] sendInput: unknown taskId ${taskId}`);
      return;
    }
    if (task.status !== "input_required") {
      console.error(
        `⚠️ [AgentManager] sendInput: task ${taskId} is not in input_required state`,
      );
      return;
    }
    console.error(`📥 [AgentManager] User input received for task ${taskId}`);
    // Phase 2: forward to AgentLauncher
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled"
    )
      return;

    this.updateStatus(task, "cancelled");
    this.emit("event", {
      type: "agent_task_cancelled",
      taskId,
    } satisfies AgentTaskEvent);
    console.error(`🛑 [AgentManager] Task cancelled: ${taskId}`);
    // Phase 2: kill the process
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private updateStatus(task: AgentTask, status: AgentTaskStatus): void {
    task.status = status;
    task.updatedAt = Date.now();
  }

  /**
   * Phase 1 stub — just marks the task as failed with a helpful message.
   * Phase 2 will replace this with real AgentLauncher invocation.
   */
  private async launchTask(task: AgentTask, card: AgentCard): Promise<void> {
    this.updateStatus(task, "starting");
    this.emit("event", {
      type: "agent_task_started",
      taskId: task.taskId,
    } satisfies AgentTaskEvent);

    console.error(
      `🚀 [AgentManager] Launching agent ${card.agentId} for task ${task.taskId} [STUB — Phase 2 pending]`,
    );

    // Stub: simulate a short delay then report "not yet implemented"
    await new Promise((r) => setTimeout(r, 500));

    const msg = `Agent launcher not yet implemented (Phase 2). Agent: ${card.name}, Input: ${JSON.stringify(task.input)}`;
    task.error = msg;
    this.updateStatus(task, "failed");
    this.emit("event", {
      type: "agent_task_failed",
      taskId: task.taskId,
      error: msg,
    } satisfies AgentTaskEvent);
  }

  // ── Stream helpers (called by AgentLauncher in Phase 2) ──────────────────

  appendChunk(taskId: string, chunk: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.streamChunks.push(chunk);
    task.updatedAt = Date.now();
    this.emit("event", {
      type: "agent_task_stream",
      taskId,
      chunk,
    } satisfies AgentTaskEvent);
  }

  completeTask(taskId: string, output: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.output = output;
    this.updateStatus(task, "completed");
    this.emit("event", {
      type: "agent_task_done",
      taskId,
      output,
    } satisfies AgentTaskEvent);
    console.error(`✅ [AgentManager] Task completed: ${taskId}`);
  }

  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.error = error;
    this.updateStatus(task, "failed");
    this.emit("event", {
      type: "agent_task_failed",
      taskId,
      error,
    } satisfies AgentTaskEvent);
    console.error(`❌ [AgentManager] Task failed: ${taskId} — ${error}`);
  }

  requireInput(taskId: string, question: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.updateStatus(task, "input_required");
    this.emit("event", {
      type: "agent_input_required",
      taskId,
      question,
    } satisfies AgentTaskEvent);
  }
}
