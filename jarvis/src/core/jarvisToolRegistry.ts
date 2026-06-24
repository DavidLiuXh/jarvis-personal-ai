/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmToolSchema } from "../agent-runtime/index.js";

export type RuntimeToolRiskLevel = "low" | "medium" | "high";

export type JarvisToolSchema = LlmToolSchema & {
  parallelizable?: boolean;
  riskLevel?: RuntimeToolRiskLevel;
  tags?: string[];
};

export type RuntimeToolRegistry = {
  listTools(): JarvisToolSchema[];
  getTool(name: string): JarvisToolSchema | null;
  addTool(tool: JarvisToolSchema): void;
};

export class DefaultRuntimeToolRegistry implements RuntimeToolRegistry {
  private readonly tools = new Map<string, JarvisToolSchema>();

  constructor(initialTools: JarvisToolSchema[] = []) {
    for (const tool of initialTools) {
      this.addTool(tool);
    }
  }

  listTools(): JarvisToolSchema[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): JarvisToolSchema | null {
    return this.tools.get(name) ?? null;
  }

  addTool(tool: JarvisToolSchema): void {
    this.tools.set(tool.name, tool);
  }
}

const WORKSPACE_TOOL_NAMES = new Set([
  "activate_skill",
  "read_file",
  "write_file",
  "read_many_files",
  "glob",
  "grep",
  "run_shell_command",
]);

export function createJarvisNativeToolSchemas(): JarvisToolSchema[] {
  const recallMemoryTool: JarvisToolSchema = {
    name: "recall_memory",
    description:
      "MANDATORY for retrieving any past interaction, technical decision, or user preference not in the current view. " +
      "The 'query' parameter MUST contain specific topic keywords extracted from the user's question — " +
      "e.g. if user asks 'did I ask about Ollama?', set query='Ollama'; " +
      "if user asks 'what was my investment strategy?', set query='investment strategy'; " +
      "if user asks 'did we discuss Anthropic yesterday?', set query='Anthropic' (extract the TOPIC, not the time word); " +
      "if user asks 'what did we talk about last week?', set query='recent discussion'. " +
      "When the question mentions a relative time period, set time_window_days: yesterday=1, today=0, last week=7, last month=30. " +
      "When the user refers to a specific calendar date (e.g. '4月27日', 'January 20', '2026-04-27'), " +
      "set date_from='YYYY-MM-DD' and date_to='YYYY-MM-DD' instead of time_window_days — this gives exact date filtering. " +
      "NEVER call this tool without a non-empty query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Specific keywords extracted from the user's question to search in long-term memory. Must be non-empty.",
        },
        limit: { type: "number", description: "Number of results (1-10)." },
        time_window_days: {
          type: "number",
          description:
            "Optional filter for relative time periods. 0=today, 1=yesterday, 7=last week. Leave null when using date_from/date_to.",
        },
        date_from: {
          type: "string",
          description:
            "Optional absolute start date for memory search as ISO 8601 (e.g. '2026-01-20' or '2026-04-27T00:00:00'). Use for specific calendar dates. When set, overrides time_window_days.",
        },
        date_to: {
          type: "string",
          description:
            "Optional absolute end date for memory search as ISO 8601 (e.g. '2026-01-20' or '2026-04-27T23:59:59'). Must be provided together with date_from.",
        },
      },
      required: ["query"],
    },
    parallelizable: true,
    riskLevel: "low",
    tags: ["memory", "recall"],
  };

  const taskTools: JarvisToolSchema[] = [
    {
      name: "task_list",
      description:
        "ALWAYS use this tool when the user asks about scheduled tasks, cron jobs, or automated tasks in Jarvis. This lists Jarvis's own internal task scheduler (NOT system crontab). Do NOT use run_shell_command or crontab -l for this purpose.",
      parameters: { type: "object", properties: {}, required: [] },
      parallelizable: false,
      riskLevel: "low",
      tags: ["task", "schedule"],
    },
    {
      name: "task_add",
      description:
        'IMMEDIATELY call this when the user says things like "每天X点做Y", "每周X做Y", "定时查询/汇总/分析", "schedule", "remind me", "automatically do X at Y time". Do NOT write code or scripts — just create a scheduled task with task_add. The prompt parameter is what Jarvis will say/do when the task fires.',
      parameters: {
        type: "object",
        properties: {
          cron: {
            type: "string",
            description:
              'Schedule: cron expression OR natural language like "每天晚上8点", "weekdays at 9am", "每周一早上10点".',
          },
          prompt: {
            type: "string",
            description:
              'The instruction Jarvis will execute when the task fires. Jarvis can use Jarvis-native runtime tools when available — no code needed. E.g. "搜索今日美股行情并分析" or "读取本地报告并汇总".',
          },
          channel: {
            type: "string",
            description:
              'Output channel: feishu or wechat. ONLY set when user explicitly mentions pushing/sending/notifying to a channel (e.g. "发到飞书", "推送到微信"). Leave unset if user does not mention push.',
          },
          chat_id: {
            type: "string",
            description:
              "Target chat/user ID. Optional — if omitted, the channel uses its default target (WeChat: logged-in user; Feishu: defaultChatId from config). Only set when user specifies a different target.",
          },
        },
        required: ["cron", "prompt"],
      },
      parallelizable: false,
      riskLevel: "medium",
      tags: ["task", "schedule", "write"],
    },
    {
      name: "task_update",
      description:
        'Update an existing task in Jarvis\'s internal scheduler. Supports natural language for schedule (e.g. "每天早上8点", "weekdays at 9am").',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID from task_list." },
          cron: {
            type: "string",
            description:
              'New schedule: cron expression or natural language like "每天早上8点".',
          },
          prompt: { type: "string", description: "New prompt for the task." },
          channel: { type: "string", description: "New output channel." },
          chat_id: { type: "string", description: "New target chat/user ID." },
        },
        required: ["id"],
      },
      parallelizable: false,
      riskLevel: "medium",
      tags: ["task", "schedule", "write"],
    },
    {
      name: "task_toggle",
      description:
        "Enable or disable a task in Jarvis's internal scheduler by ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID from task_list." },
          enabled: {
            type: "boolean",
            description: "true to enable, false to disable.",
          },
        },
        required: ["id", "enabled"],
      },
      parallelizable: false,
      riskLevel: "medium",
      tags: ["task", "schedule", "write"],
    },
    {
      name: "task_delete",
      description:
        "Permanently delete a task from Jarvis's internal scheduler by ID. Use task_list first to get the task ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID from task_list." },
        },
        required: ["id"],
      },
      parallelizable: false,
      riskLevel: "high",
      tags: ["task", "schedule", "delete"],
    },
    {
      name: "task_run",
      description:
        "Immediately trigger a Jarvis internal scheduled task once, without waiting for its cron schedule.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID from task_list." },
        },
        required: ["id"],
      },
      parallelizable: false,
      riskLevel: "medium",
      tags: ["task", "schedule", "run"],
    },
  ];

  const pushToChannelTool: JarvisToolSchema = {
    name: "push_to_channel",
    description:
      'Push a message to WeChat or Feishu. Call this immediately when the user says "发到微信", "推送到飞书", "send to WeChat", "push to Feishu", or asks to share/send content to a messaging channel. Do not replace this with run_shell_command or manual copy instructions.',
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            'Target channel. Use exact lowercase values: "wechat" or "feishu".',
        },
        content: {
          type: "string",
          description:
            "The final message content to push. Can be multi-line markdown/plain text.",
        },
        chat_id: {
          type: "string",
          description:
            "Optional target chat/user ID. Leave empty to use the default (logged-in user for WeChat, defaultChatId for Feishu).",
        },
      },
      required: ["channel", "content"],
    },
    parallelizable: false,
    riskLevel: "medium",
    tags: ["channel", "write"],
  };

  const activateSkillTool: JarvisToolSchema = {
    name: "activate_skill",
    description:
      "Activate a Jarvis skill by name and return its SKILL.md instructions and available resources. " +
      "Call this before applying a skill listed in the system prompt, such as dmii, docs-writer, or other available skills.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name exactly as listed in the system prompt.",
        },
      },
      required: ["name"],
    },
    parallelizable: false,
    riskLevel: "low",
    tags: ["skill"],
  };

  const workspaceTools: JarvisToolSchema[] = [
    {
      name: "read_file",
      description:
        "Read a text file inside the current workspace. Use start_line and end_line for targeted reads. Paths must stay within the workspace.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Workspace-relative path.",
          },
          start_line: {
            type: "number",
            description: "Optional 1-based start line.",
          },
          end_line: {
            type: "number",
            description: "Optional 1-based inclusive end line.",
          },
        },
        required: ["file_path"],
      },
      parallelizable: true,
      riskLevel: "low",
      tags: ["workspace", "file", "read"],
    },
    {
      name: "read_many_files",
      description:
        "Read multiple text files inside the current workspace. Use this when several specific files are needed.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Workspace-relative file paths.",
          },
          start_line: { type: "number" },
          end_line: { type: "number" },
        },
        required: ["paths"],
      },
      parallelizable: true,
      riskLevel: "low",
      tags: ["workspace", "file", "read"],
    },
    {
      name: "glob",
      description:
        'Find files in the current workspace using a glob pattern such as "src/**/*.ts" or "**/*.md".',
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Workspace-relative glob pattern.",
          },
        },
        required: ["pattern"],
      },
      parallelizable: true,
      riskLevel: "low",
      tags: ["workspace", "search", "read"],
    },
    {
      name: "grep",
      description:
        "Search text in workspace files using a regular expression pattern. Prefer this before broad file reads.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression to search for.",
          },
          path: {
            type: "string",
            description: "Optional workspace-relative file or directory path.",
          },
          include: {
            type: "string",
            description: 'Optional file glob filter, e.g. "**/*.ts".',
          },
          ignore_case: {
            type: "boolean",
            description: "Default true. Set false for case-sensitive search.",
          },
        },
        required: ["pattern"],
      },
      parallelizable: true,
      riskLevel: "low",
      tags: ["workspace", "search", "read"],
    },
    {
      name: "write_file",
      description:
        "Create, overwrite, or append to a file inside the current workspace. Never use this for secrets or files outside the workspace.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Workspace-relative path.",
          },
          content: { type: "string", description: "Full content to write." },
          mode: {
            type: "string",
            enum: ["overwrite", "append", "create"],
            description: 'Default "overwrite".',
          },
        },
        required: ["file_path", "content"],
      },
      parallelizable: false,
      riskLevel: "high",
      tags: ["workspace", "file", "write"],
    },
    {
      name: "run_shell_command",
      description:
        "Run a non-interactive shell command inside the current workspace. Destructive/system commands are blocked by Jarvis workspace policy.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command to run from the workspace.",
          },
          cwd: {
            type: "string",
            description: "Optional workspace-relative working directory.",
          },
          timeout_ms: {
            type: "number",
            description: "Optional timeout, capped by Jarvis policy.",
          },
        },
        required: ["command"],
      },
      parallelizable: false,
      riskLevel: "high",
      tags: ["workspace", "shell", "execute"],
    },
  ];

  return [
    recallMemoryTool,
    activateSkillTool,
    pushToChannelTool,
    ...taskTools,
    ...workspaceTools,
  ];
}

export function createDefaultRuntimeToolRegistry(
  dynamicTools: JarvisToolSchema[] = [],
): RuntimeToolRegistry {
  return new DefaultRuntimeToolRegistry([
    ...createJarvisNativeToolSchemas(),
    ...dynamicTools,
  ]);
}

export function addToolsToGeminiRegistry(
  registry: unknown,
  tools: JarvisToolSchema[],
): void {
  const addDiscoveredTool = (registry as { addDiscoveredTool?: unknown })
    ?.addDiscoveredTool;
  if (typeof addDiscoveredTool !== "function") return;
  for (const tool of tools) {
    if (WORKSPACE_TOOL_NAMES.has(tool.name)) continue;
    addDiscoveredTool.call(registry, tool);
  }
}
