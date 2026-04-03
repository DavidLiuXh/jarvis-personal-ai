/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskConfig = {
  id: string;
  /** Standard 5-field cron expression, e.g. "0 8 * * *" */
  cron: string;
  /** Prompt sent to the agent when this task fires */
  prompt: string;
  enabled: boolean;
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

type TriggerCallback = (task: TriggeredTask) => void;

const TASKS_FILENAME = 'tasks.json';

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
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TasksConfig;
    } catch (e: any) {
      console.error(`⚠️ [TaskScheduler] Failed to load tasks.json: ${e.message}`);
      return null;
    }
  }

  public getTasks(): TaskConfig[] {
    return this.config?.tasks ?? [];
  }

  public onTrigger(cb: TriggerCallback): void {
    this.triggerCallbacks.push(cb);
  }

  public start(): void {
    if (!this.config) return;

    const { defaultChannel, defaultChatId, tasks } = this.config;
    const enabledTasks = tasks.filter(t => t.enabled);

    for (const task of enabledTasks) {
      if (!cron.validate(task.cron)) {
        console.error(`⚠️ [TaskScheduler] Invalid cron expression for task "${task.id}": ${task.cron}`);
        continue;
      }

      const job = cron.schedule(task.cron, () => {
        console.error(`⏰ [TaskScheduler] Task triggered: ${task.id}`);
        const triggered: TriggeredTask = {
          ...task,
          channel: task.channel ?? defaultChannel,
          chatId: task.chatId ?? defaultChatId,
        };
        for (const cb of this.triggerCallbacks) {
          cb(triggered);
        }
      });

      this.jobs.push(job);
      console.error(`✅ [TaskScheduler] Scheduled task "${task.id}" (${task.cron})`);
    }

    console.error(`📅 [TaskScheduler] ${enabledTasks.length} task(s) scheduled.`);
  }

  public stop(): void {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];
    console.error(`🛑 [TaskScheduler] All tasks stopped.`);
  }

  /** Reload tasks.json and re-register all cron jobs. */
  public reload(): void {
    this.stop();
    this.config = this.loadConfig();
    this.start();
    console.error(`🔄 [TaskScheduler] Reloaded.`);
  }
}
