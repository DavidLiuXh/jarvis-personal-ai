/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskConfig = {
  id: string;
  /** Standard 5-field cron expression, e.g. "0 8 * * *" */
  cron: string;
  /** Prompt sent to the agent when this task fires (not used for 'reflect' type) */
  prompt: string;
  enabled: boolean;
  /** Task type: 'agent' (default) runs prompt via LLM; 'reflect' triggers memory reflection */
  type?: "agent" | "reflect";
  /** Override default channel for this task */
  channel?: string;
  /** Override default chatId for this task */
  chatId?: string;
};

export type TasksConfig = {
  /** Default channel to push results to: 'feishu' | 'wechat' | 'websocket' */
  defaultChannel: string;
  /** Default chat/user ID for the default channel */
  defaultChatId: string;
  tasks: TaskConfig[];
};

export type TriggeredTask = TaskConfig & {
  /** Resolved chatId (task-level or default) */
  chatId: string;
  /** Resolved channel (task-level or default) */
  channel: string;
};

type TriggerCallback = (task: TriggeredTask) => void | Promise<void>;

const TASKS_FILENAME = "tasks.json";

// ---------------------------------------------------------------------------
// TaskScheduler
// ---------------------------------------------------------------------------

/**
 * Reads ~/.gemini-jarvis/tasks.json, registers cron jobs for enabled tasks,
 * and fires a callback when a task is triggered.
 */
export class TaskScheduler {
  private config: TasksConfig | null = null;
  private jobs: cron.ScheduledTask[] = [];
  private triggerCallbacks: TriggerCallback[] = [];

  constructor(private jarvisHome: string) {
    this.config = this.loadConfig();
  }

  private loadConfig(): TasksConfig | null {
    const filePath = path.join(this.jarvisHome, TASKS_FILENAME);
    try {
      let config: TasksConfig;
      if (!fs.existsSync(filePath)) {
        // Initialize with default reflection task if no config exists
        config = {
          defaultChannel: "wechat",
          defaultChatId: "",
          tasks: [this.getDefaultReflectionTask()],
        };
        this.saveConfig(config);
      } else {
        config = JSON.parse(fs.readFileSync(filePath, "utf8")) as TasksConfig;
        if (!config.tasks) config.tasks = [];
        // Ensure nightly reflection task always exists (migration-safe)
        const hasReflection = config.tasks.some(
          (t) => t.id === "nightly-reflection",
        );
        if (!hasReflection) {
          config.tasks.push(this.getDefaultReflectionTask());
          this.saveConfig(config);
        }
      }
      return config;
    } catch (e: any) {
      console.error(
        `⚠️ [TaskScheduler] Failed to load tasks.json: ${e.message}`,
      );
      return null;
    }
  }

  private getDefaultReflectionTask(): TaskConfig {
    return {
      id: "nightly-reflection",
      cron: "0 22 * * *",
      prompt:
        "Analyze today's conversation and generate higher-order insights.",
      enabled: true,
      type: "reflect",
    };
  }

  private saveConfig(config: TasksConfig): void {
    const filePath = path.join(this.jarvisHome, TASKS_FILENAME);
    try {
      if (!fs.existsSync(this.jarvisHome)) {
        fs.mkdirSync(this.jarvisHome, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
      console.error(
        "✅ [TaskScheduler] Default reflection task initialized and saved.",
      );
    } catch (e: any) {
      console.error(
        `⚠️ [TaskScheduler] Failed to save tasks.json: ${e.message}`,
      );
    }
  }

  public getTasks(): TaskConfig[] {
    return this.config?.tasks ?? [];
  }

  public getDefaultChannel(): string | undefined {
    return this.config?.defaultChannel;
  }

  public getDefaultChatId(): string | undefined {
    return this.config?.defaultChatId;
  }

  public onTrigger(cb: TriggerCallback): void {
    this.triggerCallbacks.push(cb);
  }

  public addTask(task: TaskConfig): void {
    if (!this.config) {
      this.config = { defaultChannel: "feishu", defaultChatId: "", tasks: [] };
    }
    this.config.tasks.push(task);
    this.saveConfig(this.config);
    this.reload();
  }

  public updateTask(id: string, updates: Partial<TaskConfig>): void {
    if (!this.config) return;
    const task = this.config.tasks.find((t) => t.id === id);
    if (task) {
      Object.assign(task, updates);
      this.saveConfig(this.config);
      this.reload();
    }
  }

  public deleteTask(id: string): void {
    if (!this.config) return;
    const initialLength = this.config.tasks.length;
    this.config.tasks = this.config.tasks.filter((t) => t.id !== id);
    if (this.config.tasks.length !== initialLength) {
      this.saveConfig(this.config);
      this.reload();
    }
  }

  public start(): void {
    if (!this.config) return;

    const { defaultChannel, defaultChatId, tasks } = this.config;
    const enabledTasks = tasks.filter((t) => t.enabled);

    for (const task of enabledTasks) {
      if (!cron.validate(task.cron)) {
        console.error(
          `⚠️ [TaskScheduler] Invalid cron expression for task "${task.id}": ${task.cron}`,
        );
        continue;
      }

      const job = cron.schedule(task.cron, async () => {
        const now = new Date();
        console.error(
          `⏰ [TaskScheduler] Task triggered: ${task.id} at ${now.toLocaleString()} (${now.toISOString()})`,
        );
        const triggered: TriggeredTask = {
          ...task,
          channel: task.channel ?? defaultChannel,
          chatId: task.chatId ?? defaultChatId,
        };
        for (const cb of this.triggerCallbacks) {
          await Promise.resolve(cb(triggered)).catch((e: any) => {
            console.error(
              `⚠️ [TaskScheduler] Task "${task.id}" callback failed: ${e?.message ?? e}`,
            );
          });
        }
      });

      // Log next scheduled execution time for diagnostics
      const nextDate =
        (job as any).nextDate?.() ?? (job as any).getNextDate?.();
      const nextStr = nextDate
        ? `next: ${new Date(nextDate).toLocaleString()}`
        : "next: unknown";
      this.jobs.push(job);
      console.error(
        `✅ [TaskScheduler] Scheduled task "${task.id}" (${task.cron}) — ${nextStr}`,
      );
    }

    console.error(
      `📅 [TaskScheduler] ${enabledTasks.length} task(s) scheduled.`,
    );
  }

  public stop(): void {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];
    console.error(`🛑 [TaskScheduler] All tasks stopped.`);
  }

  /** Reload tasks.json and re-register all cron jobs.
   * If the new config fails to load, keeps the existing jobs running and
   * returns false so the caller knows the reload did not take effect.
   */
  public reload(): boolean {
    const newConfig = this.loadConfig();
    if (!newConfig) {
      console.error(
        `⚠️ [TaskScheduler] Reload aborted — failed to load tasks.json. Existing jobs unchanged.`,
      );
      return false;
    }
    this.stop();
    this.config = newConfig;
    this.start();
    console.error(`🔄 [TaskScheduler] Reloaded.`);
    return true;
  }
}
