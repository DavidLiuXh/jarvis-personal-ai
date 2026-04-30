/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JarvisAgent } from "./agent.js";
import { JarvisEventType } from "./types.js";
import type { MemoryService } from "./memory.js";
import type { AgentManager } from "./agentManager.js";
import type { ChannelRegistry } from "./channelRegistry.js";
import type { TaskCommandHandler } from "./taskCommandHandler.js";

/** Maximum time a background task may run before being force-failed (ms). */
const BG_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Trigger prefixes that activate background task mode */
const BG_TRIGGERS = [
  /^后台[:：\s]/i,
  /^background[:：\s]/i,
  /^async[:：\s]/i,
  /^bg[:：\s]/i,
];

export type BackgroundTask = {
  taskId: string;
  sessionId: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
};

/** Events emitted by BackgroundTaskRunner */
export type BackgroundTaskEvent =
  | { type: "bg_task_started"; task: BackgroundTask }
  | { type: "bg_task_done"; taskId: string; sessionId: string; result: string }
  | {
      type: "bg_task_failed";
      taskId: string;
      sessionId: string;
      error: string;
    };

/**
 * Detects whether a message is a background task request.
 * Returns the cleaned prompt (without the trigger prefix) or null.
 */
export function extractBackgroundPrompt(userPrompt: string): string | null {
  const trimmed = userPrompt.trim();
  for (const pattern of BG_TRIGGERS) {
    const m = trimmed.match(pattern);
    if (m) {
      return trimmed.slice(m[0].length).trim();
    }
  }
  return null;
}

/**
 * Runs LLM tasks in the background using a dedicated JarvisAgent instance,
 * completely isolated from the main conversation session.
 *
 * Each background task:
 *  - Gets its own agent (own isProcessing lock, own chat history)
 *  - Does not block the main dialog
 *  - Pushes a completion notification via EventEmitter when done
 */
export class BackgroundTaskRunner extends EventEmitter {
  private tasks = new Map<string, BackgroundTask>();

  constructor(
    private readonly sourceRoot: string,
    private readonly memoryService: MemoryService,
    private agentManager: AgentManager | null = null,
    private channelRegistry: ChannelRegistry | null = null,
    private taskCommandHandler: TaskCommandHandler | null = null,
  ) {
    super();
  }

  setAgentManager(mgr: AgentManager): void {
    this.agentManager = mgr;
  }

  setChannelRegistry(reg: ChannelRegistry): void {
    this.channelRegistry = reg;
  }

  setTaskCommandHandler(h: TaskCommandHandler): void {
    this.taskCommandHandler = h;
  }

  /**
   * Starts a background task.
   * Returns the task immediately; caller should emit a confirmation to the user.
   * Result is pushed via 'event' emitter when complete.
   */
  run(prompt: string, originSessionId: string): BackgroundTask {
    const taskId = randomUUID();
    const bgSessionId = `bg-${taskId}`;

    const task: BackgroundTask = {
      taskId,
      sessionId: originSessionId,
      prompt,
      status: "running",
      createdAt: Date.now(),
    };

    this.tasks.set(taskId, task);
    this.emit("event", {
      type: "bg_task_started",
      task,
    } satisfies BackgroundTaskEvent);

    console.error(
      `🔀 [BackgroundTask] Started ${taskId} for session ${originSessionId}: "${prompt.slice(0, 80)}"`,
    );

    // Non-blocking: run in background without awaiting
    setImmediate(() => void this.execute(task, bgSessionId));

    return task;
  }

  listTasks(sessionId?: string): BackgroundTask[] {
    const all = Array.from(this.tasks.values());
    return sessionId ? all.filter((t) => t.sessionId === sessionId) : all;
  }

  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  private async execute(
    task: BackgroundTask,
    bgSessionId: string,
  ): Promise<void> {
    // Create a fully isolated agent instance — never shares isProcessing or
    // chat history with the main session agent.
    const agent = new JarvisAgent({
      sessionId: bgSessionId,
      cwd: this.sourceRoot,
      memoryService: this.memoryService,
      skipResume: true, // no history restore — avoids loading all sessions
      lightweight: true, // skip BackgroundDistiller, EntityExtractor, backfill, summarizer
    });

    if (this.agentManager) agent.setAgentManager(this.agentManager);
    if (this.channelRegistry) agent.setChannelRegistry(this.channelRegistry);
    if (this.taskCommandHandler)
      agent.setTaskCommandHandler(this.taskCommandHandler);

    const resultChunks: string[] = [];

    agent.on(JarvisEventType.CONTENT, (event: any) => {
      const text =
        typeof event === "string" ? event : (event?.value ?? event?.text ?? "");
      if (typeof text === "string" && text) resultChunks.push(text);
    });

    // Debug: log tool call responses to understand tool execution flow
    agent.on(JarvisEventType.TOOL_CALL_RESPONSE, (data: any) => {
      console.error(
        `🔧 [BgTask] tool_response: name=${data?.name} status=${data?.status} output_len=${String(data?.output ?? "").length}`,
      );
    });

    // Timeout guard: if processMessage hangs (e.g. a tool call never returns),
    // reject after BG_TASK_TIMEOUT_MS so the finally block always runs and
    // the agent is properly disposed.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(
              `Background task timed out after ${BG_TASK_TIMEOUT_MS / 60000} minutes`,
            ),
          ),
        BG_TASK_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([agent.processMessage(task.prompt), timeoutPromise]);

      const result = resultChunks.join("").trim() || "(no output)";
      task.status = "completed";
      task.result = result;
      task.completedAt = Date.now();

      console.error(`✅ [BackgroundTask] Completed ${task.taskId}`);
      this.emit("event", {
        type: "bg_task_done",
        taskId: task.taskId,
        sessionId: task.sessionId,
        result,
      } satisfies BackgroundTaskEvent);
    } catch (err: any) {
      const error = err.message ?? String(err);
      task.status = "failed";
      task.error = error;
      task.completedAt = Date.now();

      console.error(`❌ [BackgroundTask] Failed ${task.taskId}: ${error}`);
      this.emit("event", {
        type: "bg_task_failed",
        taskId: task.taskId,
        sessionId: task.sessionId,
        error,
      } satisfies BackgroundTaskEvent);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      // dispose() calls Config.dispose() → coreEvents.off() for model-changed etc.
      // Without this, coreEvents holds a reference chain preventing GC of the
      // agent, its GeminiClient, and Config after the task completes.
      await agent.dispose();
      // Evict completed/failed tasks after 30 minutes to prevent unbounded map growth
      setTimeout(() => this.tasks.delete(task.taskId), 30 * 60 * 1000);
    }
  }
}
