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
import { launchAgent, sendAgentInput } from "./agentLauncher.js";

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
/** How long to wait for user input before auto-failing the task (ms) */
const INPUT_REQUIRED_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class AgentManager extends EventEmitter {
  private tasks = new Map<string, AgentTask>();
  private registry: AgentCard[] = [];
  private inputTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(registry: AgentCard[] = []) {
    super();
    this.registry = registry;

    // Kill all running agent processes when Jarvis exits (including crashes).
    // This prevents orphaned agent processes occupying ports after restart.
    const cleanup = () => this.killAllRunningAgents();
    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    process.once("uncaughtException", (err) => {
      console.error("[AgentManager] Uncaught exception, killing agents:", err);
      cleanup();
    });
  }

  private killAllRunningAgents(): void {
    for (const task of this.tasks.values()) {
      if (
        task.pid &&
        !["completed", "failed", "cancelled"].includes(task.status)
      ) {
        try {
          process.kill(task.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
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
      logs: [],
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

    // Clear the INPUT_REQUIRED timeout since user has responded
    const timer = this.inputTimeouts.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.inputTimeouts.delete(taskId);
    }

    if (!task.port) {
      this.failTask(taskId, "Cannot resume: agent port unknown");
      return;
    }

    this.updateStatus(task, "running");

    // Resume the A2A session — non-blocking
    setImmediate(() =>
      sendAgentInput(
        task.port!,
        task.taskId,
        task.a2aContextId ?? task.taskId,
        value,
        {
          onChunk: (chunk) => this.appendChunk(taskId, chunk),
          onComplete: (output) => this.completeTask(taskId, output),
          onFailed: (error) => this.failTask(taskId, error),
          onInputRequired: (question, contextId) => {
            task.a2aContextId = contextId;
            this.requireInput(taskId, question);
          },
        },
      ),
    );
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
    if (task.pid) {
      try {
        process.kill(task.pid, "SIGTERM");
      } catch {
        // process may have already exited
      }
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private updateStatus(task: AgentTask, status: AgentTaskStatus): void {
    task.status = status;
    task.updatedAt = Date.now();
  }

  private async launchTask(task: AgentTask, card: AgentCard): Promise<void> {
    this.updateStatus(task, "starting");
    this.emit("event", {
      type: "agent_task_started",
      taskId: task.taskId,
    } satisfies AgentTaskEvent);

    const result = await launchAgent(card, task, {
      onChunk: (chunk) => this.appendChunk(task.taskId, chunk),
      onComplete: (output) => this.completeTask(task.taskId, output),
      onFailed: (error) => this.failTask(task.taskId, error),
      onInputRequired: (question, contextId) => {
        task.a2aContextId = contextId;
        this.requireInput(task.taskId, question);
      },
      onLog: (line) => {
        task.logs.push(line);
        if (task.logs.length > 200) task.logs.shift(); // cap at 200 lines
      },
    });

    if (result) {
      task.pid = result.pid;
      task.port = result.port;
      task.updatedAt = Date.now();
    }
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

    // Auto-fail after timeout — prevents tasks from hanging indefinitely
    const timer = setTimeout(() => {
      if (this.tasks.get(taskId)?.status === "input_required") {
        this.failTask(
          taskId,
          `Timed out waiting for user input after ${INPUT_REQUIRED_TIMEOUT_MS / 60000} minutes`,
        );
        if (task.pid) {
          try {
            process.kill(task.pid, "SIGTERM");
          } catch {
            /* gone */
          }
        }
      }
    }, INPUT_REQUIRED_TIMEOUT_MS);
    this.inputTimeouts.set(taskId, timer);
  }
}
