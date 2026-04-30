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
import type { MemoryService } from "./memory.js";

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
  private memoryService: MemoryService | null = null;

  constructor(registry: AgentCard[] = []) {
    super();
    this.registry = registry;

    // Register only on 'exit' (fires regardless of how the process terminates).
    // SIGINT/SIGTERM/uncaughtException handlers are owned by index.ts which calls
    // killAllRunningAgents() as part of its own graceful shutdown — registering
    // them here too would conflict (process.once fires only one handler).
    process.once("exit", () => this.killAllRunningAgents());
  }

  /**
   * Inject the MemoryService for task persistence.
   * Must be called before the first createTask() to ensure tasks are persisted.
   * Also restores previously persisted tasks from DB.
   */
  public setMemoryService(svc: MemoryService): void {
    this.memoryService = svc;
    this.restoreFromDb();
  }

  /**
   * Loads persisted tasks from DB on startup.
   * Running/starting tasks are marked failed (process is gone).
   * Completed/failed/cancelled tasks are restored as-is for history.
   * input_required tasks are marked failed (agent process is gone).
   */
  private restoreFromDb(): void {
    if (!this.memoryService) return;
    const VALID_STATUSES = new Set<string>([
      "pending",
      "starting",
      "running",
      "input_required",
      "completed",
      "failed",
      "cancelled",
    ]);
    try {
      const rows = this.memoryService.loadAgentTasks();
      let restored = 0;
      let markedFailed = 0;
      for (const row of rows) {
        // Validate status at runtime — TypeScript cast won't catch stale DB values
        let status = row.status as AgentTaskStatus;
        if (!VALID_STATUSES.has(row.status)) {
          console.error(
            `⚠️ [AgentManager] Unknown status "${row.status}" for task ${row.taskId}, marking failed`,
          );
          status = "failed";
        }
        const task: AgentTask = {
          taskId: row.taskId,
          agentId: row.agentId,
          sessionId: row.sessionId,
          status,
          input: row.input,
          streamChunks: row.streamChunks,
          output: row.output,
          error: row.error,
          pid: row.pid,
          port: row.port,
          a2aContextId: row.a2aContextId,
          logs: row.logs,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
        // Tasks that were in-flight when Jarvis stopped cannot be resumed
        if (
          task.status === "pending" ||
          task.status === "starting" ||
          task.status === "running" ||
          task.status === "input_required"
        ) {
          task.status = "failed";
          task.error = "Jarvis restarted while this task was in progress.";
          task.updatedAt = Date.now();
          this.memoryService.upsertAgentTask(task);
          markedFailed++;
        }
        this.tasks.set(task.taskId, task);
        restored++;
      }
      if (restored > 0) {
        console.error(
          `🗄️ [AgentManager] Restored ${restored} task(s) from DB` +
            (markedFailed > 0
              ? `, ${markedFailed} marked failed (process gone)`
              : ""),
        );
      }
    } catch (e: any) {
      console.error(`⚠️ [AgentManager] restoreFromDb failed: ${e.message}`);
    }
  }

  private persist(task: AgentTask): void {
    try {
      this.memoryService?.upsertAgentTask(task);
    } catch (e: any) {
      console.error(
        `⚠️ [AgentManager] persist failed for ${task.taskId}: ${e.message}`,
      );
    }
  }

  public killAllRunningAgents(): void {
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

    // Validate required fields from inputSchema
    const required: string[] = (card.inputSchema as any)?.required ?? [];
    const missing = required.filter((f) => input[f] == null);
    if (missing.length > 0) {
      throw new Error(
        `Agent ${agentId}: missing required input field(s): ${missing.join(", ")}`,
      );
    }

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
    this.persist(task);
    this.emit("event", {
      type: "agent_task_created",
      task,
    } satisfies AgentTaskEvent);

    console.error(
      `🤖 [AgentManager] Task created: ${task.taskId} (agent=${agentId}, session=${sessionId})`,
    );

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

    this.clearInputTimeout(taskId);
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
    this.persist(task);
  }

  private async launchTask(task: AgentTask, card: AgentCard): Promise<void> {
    this.updateStatus(task, "starting");
    this.emit("event", {
      type: "agent_task_started",
      taskId: task.taskId,
    } satisfies AgentTaskEvent);

    try {
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
          if (task.logs.length > 200) task.logs.shift();
        },
      });

      if (result) {
        task.pid = result.pid;
        task.port = result.port;
        task.updatedAt = Date.now();
        this.persist(task);
      }
    } catch (err: any) {
      // Unexpected launcher error (e.g., port exhaustion, spawn failure not
      // caught internally). Fail the task so the UI reflects the error.
      this.failTask(task.taskId, `Internal launcher error: ${err.message}`);
    }
  }

  // ── Stream helpers (called by AgentLauncher in Phase 2) ──────────────────

  appendChunk(taskId: string, chunk: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.streamChunks.push(chunk);
    task.updatedAt = Date.now();
    // Persist on first chunk (proves task started) then every 10 thereafter.
    // completeTask() always persists the final state regardless.
    const n = task.streamChunks.length;
    if (n === 1 || n % 10 === 0) {
      this.persist(task);
    }
    this.emit("event", {
      type: "agent_task_stream",
      taskId,
      chunk,
    } satisfies AgentTaskEvent);
  }

  private clearInputTimeout(taskId: string): void {
    const t = this.inputTimeouts.get(taskId);
    if (t) {
      clearTimeout(t);
      this.inputTimeouts.delete(taskId);
    }
  }

  completeTask(taskId: string, output: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.clearInputTimeout(taskId);
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
    this.clearInputTimeout(taskId);
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
    // Clear any existing timer before setting a new one (prevents leaked timer
    // if agent sends two consecutive input-required events).
    this.clearInputTimeout(taskId);
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
