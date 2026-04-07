/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import type { TaskConfig, TasksConfig, TriggeredTask } from './taskScheduler.js';
import { parseNaturalTimeToCron } from './cronParser.js';

const TASKS_FILENAME = 'tasks.json';

const HELP = `
📅 Task commands:
  !task list                              — List all tasks
  !task add "<cron|natural>" "<prompt>"   — Add a new task (enabled by default)
       [--channel feishu|wechat|websocket]
       [--chat <chatId>]
  !task update <id>                       — Update an existing task
       [--cron "<cron|natural>"]
       [--prompt "<new prompt>"]
       [--channel <channel>]
       [--chat <chatId>]
  !task enable <id>                       — Enable a task
  !task disable <id>                      — Disable a task
  !task delete <id>                       — Delete a task
  !task run <id>                          — Trigger a task immediately

Cron supports natural language: "每天早上8点", "weekdays at 9am", "每隔2小时"

Usage example:
  !task add "每天早上8点" "Generate morning news brief"
  !task add "0 22 * * 1-5" "Analyze US stock market" --channel feishu --chat oc_xxx
  !task update task-id --cron "每天下午3点" --prompt "Updated prompt"
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

  // Tokenise: quoted strings, --flag, bare words
  const tokenRegex = /"([^"]+)"|'([^']+)'|--(\w+)|(\S+)/g;
  const tokens: Array<{ type: 'quoted' | 'flag' | 'bare'; value: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(input)) !== null) {
    if (m[1] !== undefined) tokens.push({ type: 'quoted', value: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'quoted', value: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: 'flag', value: m[3] });
    else if (m[4] !== undefined) tokens.push({ type: 'bare', value: m[4] });
  }

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === 'flag') {
      // Next token (quoted or bare) is the flag value
      const next = tokens[i + 1];
      if (next && next.type !== 'flag') {
        flags[tok.value] = next.value;
        i += 2;
      } else {
        flags[tok.value] = '';
        i++;
      }
    } else {
      positional.push(tok.value);
      i++;
    }
  }
  return { positional, flags };
}

/**
 * Handles !task commands: parses input, mutates tasks.json, calls reload.
 */
export class TaskCommandHandler {
  constructor(
    private jarvisHome: string,
    private reload: () => void,
    private runNow: (task: TriggeredTask) => Promise<void>,
  ) {}

  public async handle(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('!task')) return '';

    const body = trimmed.slice('!task'.length).trim();
    const [subcommand, ...rest] = body.split(/\s+/);

    switch (subcommand?.toLowerCase()) {
      case 'list': return this.list();
      case 'add':  return this.add(body.slice('add'.length).trim());
      case 'update': return this.update(rest[0], body.slice('update'.length).trim().slice(rest[0]?.length ?? 0).trim());
      case 'enable': return this.setEnabled(rest[0], true);
      case 'disable': return this.setEnabled(rest[0], false);
      case 'delete': return this.delete(rest[0]);
      case 'run': return this.run(rest[0]);
      default: return `Unknown subcommand "${subcommand}".\n\n${HELP}`;
    }
  }

  /**
   * Called by ToolRouter when the LLM invokes a task_* tool.
   * action: 'list' | 'add' | 'update' | 'enable' | 'disable' | 'delete' | 'run'
   * args: tool call arguments from the LLM
   */
  public async handleTool(action: string, args: Record<string, unknown>): Promise<string> {
    switch (action) {
      case 'list': return this.list();
      case 'add': {
        const cron = args.cron as string;
        const prompt = args.prompt as string;
        const channel = args.channel as string | undefined;
        const chatId = args.chat_id as string | undefined;
        const flags = [
          channel ? `--channel ${channel}` : '',
          chatId ? `--chat ${chatId}` : '',
        ].filter(Boolean).join(' ');
        return this.add(`"${cron}" "${prompt}" ${flags}`.trim());
      }
      case 'update': {
        const id = args.id as string;
        const flags = [
          args.cron ? `--cron "${args.cron}"` : '',
          args.prompt ? `--prompt "${args.prompt}"` : '',
          args.channel ? `--channel ${args.channel}` : '',
          args.chat_id ? `--chat ${args.chat_id}` : '',
        ].filter(Boolean).join(' ');
        return this.update(id, flags);
      }
      case 'enable': return this.setEnabled(args.id as string, true);
      case 'disable': return this.setEnabled(args.id as string, false);
      case 'toggle': return this.setEnabled(args.id as string, args.enabled as boolean);
      case 'delete': return this.delete(args.id as string);
      case 'run': return this.run(args.id as string);
      default: return `Unknown task action: ${action}`;
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

  private resolveCron(input: string): { cron: string } | { error: string } {
    // Try natural language first, then fall back to direct cron validation
    const parsed = parseNaturalTimeToCron(input);
    if (parsed) return { cron: parsed };
    if (cron.validate(input)) return { cron: input };
    return { error: `❌ Invalid cron expression or unrecognized time expression: "${input}"\nExamples: "0 8 * * *", "每天早上8点", "weekdays at 9am"` };
  }

  private add(argsStr: string): string {
    const { positional, flags } = parseArgs(argsStr);
    const [cronInput, prompt] = positional;

    if (!cronInput || !prompt) {
      return `Missing arguments.\n\n${HELP}`;
    }
    const cronResult = this.resolveCron(cronInput);
    if ('error' in cronResult) return cronResult.error;
    const cronExpr = cronResult.cron;

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

  private update(id: string, argsStr: string): string {
    if (!id) return `Missing task id.\nUsage: !task update <id> [--cron ...] [--prompt ...] [--channel ...] [--chat ...]`;

    const config = this.readConfig();
    const task = config?.tasks.find(t => t.id === id);
    if (!task) return `❌ Task "${id}" not found. Use !task list to see available tasks.`;

    const { flags } = parseArgs(argsStr);
    const changes: string[] = [];

    if (flags.cron) {
      const cronResult = this.resolveCron(flags.cron);
      if ('error' in cronResult) return cronResult.error;
      task.cron = cronResult.cron;
      changes.push(`cron → ${task.cron}`);
    }
    if (flags.prompt) {
      task.prompt = flags.prompt;
      changes.push(`prompt → ${task.prompt}`);
    }
    if (flags.channel) {
      task.channel = flags.channel;
      changes.push(`channel → ${task.channel}`);
    }
    if (flags.chat) {
      task.chatId = flags.chat;
      changes.push(`chatId → ${task.chatId}`);
    }

    if (changes.length === 0) {
      return `No changes specified.\nUsage: !task update <id> [--cron ...] [--prompt ...] [--channel ...] [--chat ...]`;
    }

    this.writeConfig(config!);
    this.reload();
    return `✅ Task updated: ${id}\n  ${changes.join('\n  ')}`;
  }

  private setEnabled(id: string, enabled: boolean): string {
    if (!id) return `Missing task id.\nUsage: !task ${enabled ? 'enable' : 'disable'} <id>`;

    const config = this.readConfig();
    const task = config?.tasks.find(t => t.id === id);
    if (!task) return `❌ Task "${id}" not found. Use !task list to see available tasks.`;

    task.enabled = enabled;
    this.writeConfig(config!);
    this.reload();

    return `${enabled ? '✅ Task enabled' : '⏸ Task disabled'}: ${id}`;
  }

  private delete(id: string): string {
    if (!id) return `Missing task id.\nUsage: !task delete <id>`;

    const config = this.readConfig();
    const idx = config?.tasks.findIndex(t => t.id === id) ?? -1;
    if (idx === -1) return `❌ Task "${id}" not found. Use !task list to see available tasks.`;

    config!.tasks.splice(idx, 1);
    this.writeConfig(config!);
    this.reload();

    return `🗑️ Task deleted: ${id}`;
  }

  private async run(id: string): Promise<string> {
    if (!id) return `Missing task id.\nUsage: !task run <id>`;

    const config = this.readConfig();
    const task = config?.tasks.find(t => t.id === id);
    if (!task) return `❌ Task "${id}" not found. Use !task list to see available tasks.`;

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
