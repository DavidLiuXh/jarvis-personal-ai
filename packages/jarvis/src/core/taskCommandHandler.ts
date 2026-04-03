/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import type { TaskConfig, TasksConfig, TriggeredTask } from './taskScheduler.js';

const TASKS_FILENAME = 'tasks.json';

const HELP = `
📅 Task commands:
  /task list                              — List all tasks
  /task add "<cron>" "<prompt>"           — Add a new task (enabled by default)
       [--channel feishu|wechat|websocket]
       [--chat <chatId>]
  /task enable <id>                       — Enable a task
  /task disable <id>                      — Disable a task
  /task delete <id>                       — Delete a task
  /task run <id>                          — Trigger a task immediately

Usage example:
  /task add "0 8 * * *" "Generate morning news brief"
  /task add "0 22 * * 1-5" "Analyze US stock market" --channel feishu --chat oc_xxx
`.trim();

function generateId(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) + '-' + Date.now().toString(36).slice(-4);
}

/** Parse quoted tokens and --flag value pairs from a command string. */
function parseArgs(input: string): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const regex = /"([^"]+)"|'([^']+)'|--(\w+)\s+(\S+)|(\S+)/g;
  let match: RegExpExecArray | null;
  let pendingFlag: string | null = null;

  while ((match = regex.exec(input)) !== null) {
    if (match[1] !== undefined) {
      if (pendingFlag) { flags[pendingFlag] = match[1]; pendingFlag = null; }
      else positional.push(match[1]);
    } else if (match[2] !== undefined) {
      if (pendingFlag) { flags[pendingFlag] = match[2]; pendingFlag = null; }
      else positional.push(match[2]);
    } else if (match[3] !== undefined) {
      flags[match[3]] = match[4];
    } else if (match[5] !== undefined) {
      if (match[5].startsWith('--')) {
        pendingFlag = match[5].slice(2);
      } else {
        if (pendingFlag) { flags[pendingFlag] = match[5]; pendingFlag = null; }
        else positional.push(match[5]);
      }
    }
  }
  return { positional, flags };
}

/**
 * Handles /task commands: parses input, mutates tasks.json, calls reload.
 */
export class TaskCommandHandler {
  constructor(
    private jarvisHome: string,
    private reload: () => void,
    private runNow: (task: TriggeredTask) => Promise<void>,
  ) {}

  public async handle(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/task')) return '';

    const body = trimmed.slice('/task'.length).trim();
    const [subcommand, ...rest] = body.split(/\s+/);

    switch (subcommand?.toLowerCase()) {
      case 'list': return this.list();
      case 'add':  return this.add(body.slice('add'.length).trim());
      case 'enable': return this.setEnabled(rest[0], true);
      case 'disable': return this.setEnabled(rest[0], false);
      case 'delete': return this.delete(rest[0]);
      case 'run': return this.run(rest[0]);
      default: return `Unknown subcommand "${subcommand}".\n\n${HELP}`;
    }
  }

  // ---------------------------------------------------------------------------

  private list(): string {
    const config = this.readConfig();
    if (!config || config.tasks.length === 0) {
      return '📋 No tasks configured.\n\n' + HELP;
    }
    const lines = config.tasks.map(t => {
      const status = t.enabled ? '✅' : '⏸';
      const channel = t.channel ?? config.defaultChannel;
      const chat = t.chatId ?? config.defaultChatId;
      return `${status} [${t.id}]\n   cron: ${t.cron}\n   prompt: ${t.prompt}\n   → ${channel}:${chat}`;
    });
    return `📋 Tasks (${config.tasks.length}):\n\n${lines.join('\n\n')}`;
  }

  private add(argsStr: string): string {
    const { positional, flags } = parseArgs(argsStr);
    const [cronExpr, prompt] = positional;

    if (!cronExpr || !prompt) {
      return `Missing arguments.\n\n${HELP}`;
    }
    if (!cron.validate(cronExpr)) {
      return `❌ Invalid cron expression: "${cronExpr}"\nExample: "0 8 * * *" (every day at 8am)`;
    }

    const config = this.readConfig() ?? {
      defaultChannel: 'feishu',
      defaultChatId: '',
      tasks: [],
    };

    const newTask: TaskConfig = {
      id: generateId(prompt),
      cron: cronExpr,
      prompt,
      enabled: true,
      ...(flags.channel ? { channel: flags.channel } : {}),
      ...(flags.chat ? { chatId: flags.chat } : {}),
    };

    config.tasks.push(newTask);
    this.writeConfig(config);
    this.reload();

    return `✅ Task added and scheduled:\n  id: ${newTask.id}\n  cron: ${cronExpr}\n  prompt: ${prompt}`;
  }

  private setEnabled(id: string, enabled: boolean): string {
    if (!id) return `Missing task id.\nUsage: /task ${enabled ? 'enable' : 'disable'} <id>`;

    const config = this.readConfig();
    const task = config?.tasks.find(t => t.id === id);
    if (!task) return `❌ Task "${id}" not found. Use /task list to see available tasks.`;

    task.enabled = enabled;
    this.writeConfig(config!);
    this.reload();

    return `${enabled ? '✅ Task enabled' : '⏸ Task disabled'}: ${id}`;
  }

  private delete(id: string): string {
    if (!id) return `Missing task id.\nUsage: /task delete <id>`;

    const config = this.readConfig();
    const idx = config?.tasks.findIndex(t => t.id === id) ?? -1;
    if (idx === -1) return `❌ Task "${id}" not found. Use /task list to see available tasks.`;

    config!.tasks.splice(idx, 1);
    this.writeConfig(config!);
    this.reload();

    return `🗑️ Task deleted: ${id}`;
  }

  private async run(id: string): Promise<string> {
    if (!id) return `Missing task id.\nUsage: /task run <id>`;

    const config = this.readConfig();
    const task = config?.tasks.find(t => t.id === id);
    if (!task) return `❌ Task "${id}" not found. Use /task list to see available tasks.`;

    const triggered: TriggeredTask = {
      ...task,
      channel: task.channel ?? config!.defaultChannel,
      chatId: task.chatId ?? config!.defaultChatId,
    };

    void this.runNow(triggered);
    return `⚡ Task "${id}" triggered immediately. Result will be pushed to ${triggered.channel}:${triggered.chatId}`;
  }

  // ---------------------------------------------------------------------------

  private readConfig(): TasksConfig | null {
    const filePath = path.join(this.jarvisHome, TASKS_FILENAME);
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TasksConfig;
    } catch (_e) { return null; }
  }

  private writeConfig(config: TasksConfig): void {
    const filePath = path.join(this.jarvisHome, TASKS_FILENAME);
    if (!fs.existsSync(this.jarvisHome)) {
      fs.mkdirSync(this.jarvisHome, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  }
}
