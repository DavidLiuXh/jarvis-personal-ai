/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  GeminiClient,
  debugLogger,
  AuthType,
  Scheduler,
  ROOT_SCHEDULER_ID,
  ApprovalMode,
  LlmRole,
  type ConversationRecord,
} from "../../../gemini-cli/packages/core/src/index.js";

// @ts-expect-error - Relative import
import { loadCliConfig } from "../../../gemini-cli/packages/cli/src/config/config.js";
// @ts-expect-error - Relative import
import { loadSettings } from "../../../gemini-cli/packages/cli/src/config/settings.js";
// @ts-expect-error - Relative import
import { type MemoryService } from "./memory.js";
import { ConfigManager } from "./configManager.js";
import {
  loadSummaryState,
  saveSummaryState,
  buildIncrementalSummary,
  buildHistoryWithSummary,
  getNewOrUpdatedFiles,
  type SessionMessage,
} from "./sessionSummarizer.js";

type DynamicRegistryHandle = {
  getDynamicToolSchemas: () => unknown[];
};

/**
 * Parse a session file that may be either:
 * - .json: single JSON object with a `messages` array
 * - .jsonl: first line is session metadata, subsequent lines are individual messages
 *
 * Returns { messages, record } where record is the ConversationRecord metadata.
 */
function parseSessionFile(filePath: string): {
  messages: SessionMessage[];
  record: ConversationRecord;
} {
  const content = fs.readFileSync(filePath, "utf8");
  const isJsonl = filePath.endsWith(".jsonl");

  if (!isJsonl) {
    // Legacy .json format: single object with messages array
    const parsed = JSON.parse(content) as ConversationRecord & {
      messages?: SessionMessage[];
    };
    return { messages: parsed.messages ?? [], record: parsed };
  }

  // .jsonl format: first line = metadata, rest = individual message objects
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length === 0)
    return { messages: [], record: {} as ConversationRecord };

  const record = JSON.parse(lines[0]) as ConversationRecord;
  const messages: SessionMessage[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]) as SessionMessage;
      if (msg.type && msg.content !== undefined) {
        messages.push(msg);
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return { messages, record };
}

export type InitializeResult = {
  client: GeminiClient;
  scheduler: Scheduler;
};

/**
 * Handles the one-time boot sequence for JarvisAgent:
 * settings → config → auth → client → scheduler → history resume.
 */
export class AgentInitializer {
  private jarvisConfig = ConfigManager.getInstance().get();

  constructor(
    private sessionId: string,
    private sourceRoot: string,
    private memoryService: MemoryService,
    private dynamicRegistry: DynamicRegistryHandle,
  ) {}

  async initialize(
    onSubagentActivity: (message: unknown) => void,
  ): Promise<InitializeResult> {
    debugLogger.debug(`[AgentInitializer] Booting Lifeform: ${this.sessionId}`);
    const settings = loadSettings(this.sourceRoot);

    // I. PERMISSION UNLOCK
    settings.merged.general.approvalMode = ApprovalMode.NEVER;
    if (settings.merged.tools) {
      settings.merged.tools.googleWebSearch = { enabled: true };
      settings.merged.tools.codebaseInvestigator = { enabled: true };
      settings.merged.tools.generalist = { enabled: true };
      settings.merged.tools.saveMemory = { enabled: true };
    }

    if (!settings.merged.context) {
      settings.merged.context = {};
    }
    settings.merged.context.includeDirectoryTree = false;
    if (!settings.merged.context.trustedFolders) {
      settings.merged.context.trustedFolders = [];
    }
    settings.merged.context.trustedFolders.push(os.homedir());

    if (!settings.merged.model) {
      settings.merged.model = {};
    }
    if (this.jarvisConfig.models.chat !== "auto") {
      // settings.model.name is the field that loadCliConfig reads to set config.model
      // (via argv.model || process.env.GEMINI_MODEL || settings.model?.name)
      // primaryModel was incorrect — it is only used for quota tracking, not routing
      settings.merged.model.name = this.jarvisConfig.models.chat;
    }
    settings.merged.model.embeddingModel = this.jarvisConfig.models.embedding;

    // II. CORE INITIALIZATION
    const jarvisStorageRoot = path.join(
      os.homedir(),
      ".gemini-jarvis",
      "storage",
    );
    if (!fs.existsSync(jarvisStorageRoot)) {
      fs.mkdirSync(jarvisStorageRoot, { recursive: true });
    }

    const config = await loadCliConfig(
      settings.merged,
      this.sessionId,
      { _: [], yolo: true, interactive: true },
      {
        cwd: path.join(os.homedir(), ".gemini-jarvis"),
        projectTmpDir: jarvisStorageRoot,
      },
    );

    if (config.storage) {
      // @ts-expect-error - internal storage property
      config.storage.targetDir = path.join(
        os.homedir(),
        ".gemini-jarvis",
        "runtime",
      );
      // @ts-expect-error - internal storage property
      config.storage.getProjectTempDir = () => jarvisStorageRoot;
    }

    const forceApiKey =
      this.jarvisConfig.api.forceApiKey && this.jarvisConfig.api.key;
    if (forceApiKey) {
      process.env.GEMINI_API_KEY = this.jarvisConfig.api.key;
    }
    const authType = forceApiKey
      ? AuthType.USE_GEMINI
      : settings.merged.security.auth.selectedType ||
        AuthType.LOGIN_WITH_GOOGLE;
    await config.refreshAuth(authType);
    await config.initialize();

    // III. TOOL REGISTRATION
    const registry = config.getToolRegistry();

    const recallMemoryTool = {
      name: "recall_memory",
      description:
        "MANDATORY for retrieving any past interaction, technical decision, or user preference not in the current view.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Specific keywords to search in long-term memory.",
          },
          limit: { type: "number", description: "Number of results (1-10)." },
        },
        required: ["query"],
      },
      parallelizable: true,
    };

    const taskTools = [
      {
        name: "task_list",
        description:
          "ALWAYS use this tool when the user asks about scheduled tasks, cron jobs, or automated tasks in Jarvis. This lists Jarvis's own internal task scheduler (NOT system crontab). Do NOT use run_shell_command or crontab -l for this purpose.",
        parameters: { type: "object", properties: {}, required: [] },
        parallelizable: false,
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
                'The instruction Jarvis will execute when the task fires. Jarvis can use google_web_search and other tools at runtime — no code needed. E.g. "使用google_web_search查询GitHub Trending今日热门项目并汇总" or "搜索今日美股行情并分析".',
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
            chat_id: {
              type: "string",
              description: "New target chat/user ID.",
            },
          },
          required: ["id"],
        },
        parallelizable: false,
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
      },
    ];

    const pushToChannelTool = {
      name: "push_to_channel",
      description:
        'Push a message to WeChat or Feishu. Call this when user says "发到微信", "推送到飞书", "send to WeChat", "push to Feishu", or asks to share/send content to a messaging channel.',
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: '"wechat" or "feishu"' },
          content: {
            type: "string",
            description: "The message content to push.",
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
    };

    // @ts-expect-error - addDiscoveredTool is not in public ToolRegistry types
    if (typeof registry.addDiscoveredTool === "function") {
      // @ts-expect-error - addDiscoveredTool is not in public ToolRegistry types
      registry.addDiscoveredTool(recallMemoryTool);
      // @ts-expect-error - addDiscoveredTool is not in public ToolRegistry types
      registry.addDiscoveredTool(pushToChannelTool);
      for (const tool of taskTools) {
        // @ts-expect-error - addDiscoveredTool is not in public ToolRegistry types
        registry.addDiscoveredTool(tool);
      }
    }

    const coreParallelTools = [
      "run_shell_command",
      "write_file",
      "google_web_search",
      "generalist",
      "codebase_investigator",
      "save_memory",
      "recall_memory",
    ];
    for (const toolName of coreParallelTools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = (registry as unknown as Record<string, any>).getTool?.(
        toolName,
      );
      if (tool) {
        tool.parallelizable = true;
      }
    }

    const client = new GeminiClient(config);
    await client.initialize();

    // Inject evolved skills
    const evolvedTools = this.dynamicRegistry.getDynamicToolSchemas();
    if (evolvedTools.length > 0) {
      const reg = config.getToolRegistry();
      for (const toolDef of evolvedTools) {
        // @ts-expect-error - addDiscoveredTool is not in public ToolRegistry types
        if (typeof reg.addDiscoveredTool === "function") {
          // @ts-expect-error - addDiscoveredTool is not in public ToolRegistry types
          reg.addDiscoveredTool(toolDef);
        }
      }
    }

    this.memoryService.setConfig(config);

    // IV. REAL-TIME ACTIVITY FEEDBACK
    const messageBus = config.getMessageBus();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageBus.subscribe("tool-calls-update", (message: any) => {
      if (message.schedulerId !== ROOT_SCHEDULER_ID) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sanitizedToolCalls = message.toolCalls.map((tc: any) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { tool: _tool, invocation: _inv, ...rest } = tc;
          if (rest.response) {
            const { error, ...resRest } = rest.response;
            rest.response = { ...resRest, error: error?.message };
          }
          return rest;
        });
        onSubagentActivity({ ...message, toolCalls: sanitizedToolCalls });
      }
    });

    // Build generateText for session summarizer
    // Routes to Ollama if summarizer.provider = 'ollama', else uses CLI-auth
    const summarizerCfg = this.jarvisConfig.summarizer;
    const cliGenerateText = async (prompt: string): Promise<string> => {
      const generator = client.config.getContentGenerator();
      const response = await generator.generateContent(
        {
          model: this.jarvisConfig.models.distillation,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        },
        `summarize-${Date.now()}`,
        LlmRole.UTILITY_SUMMARIZER,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (response as any).candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    };

    let generateText: (prompt: string) => Promise<string>;
    if (summarizerCfg?.provider === "ollama" && summarizerCfg.model) {
      const baseUrl = summarizerCfg.baseUrl ?? "http://localhost:11434";
      const model = summarizerCfg.model;
      const timeoutMs = summarizerCfg.timeoutMs ?? 120_000;
      generateText = async (prompt: string): Promise<string> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${baseUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false }),
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error(`Ollama summarizer failed: ${response.status}`);
          const data = (await response.json()) as { response: string };
          return data.response;
        } finally {
          clearTimeout(timeout);
        }
      };
      console.error(`📝 [Jarvis] Session summarizer: Ollama (${model})`);
    } else {
      generateText = cliGenerateText;
    }

    await this.resumeFromDisk(client, generateText);

    const scheduler = new Scheduler({
      context: config,
      messageBus: config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    debugLogger.debug(`[AgentInitializer] Lifeform Ready.`);
    return { client, scheduler };
  }

  private async resumeFromDisk(
    client: GeminiClient,
    generateText?: (prompt: string) => Promise<string>,
  ): Promise<void> {
    if (!this.jarvisConfig.session?.resumeOnStart) {
      debugLogger.debug(
        "[AgentInitializer] resumeOnStart=false, skipping history restore.",
      );
      return;
    }

    const chatsDir = path.join(
      client.config.storage.getProjectTempDir(),
      "chats",
    );
    const memoryDir = path.join(os.homedir(), ".gemini-jarvis", "memory");
    const recentTurns = this.jarvisConfig.session?.recentTurnsOnResume ?? 20;

    try {
      if (!fs.existsSync(chatsDir)) return;

      // 1. Collect all session files sorted by mtime (oldest first)
      // Support both .json (legacy) and .jsonl (current gemini-cli format)
      const allFiles = fs
        .readdirSync(chatsDir)
        .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(chatsDir, f)).mtimeMs,
        }))
        .sort((a, b) => a.mtime - b.mtime);

      if (allFiles.length === 0) return;

      // 2. Load existing summary state
      const existingState = loadSummaryState(memoryDir);

      // 3. Find new or updated files using mtime comparison
      const newOrUpdatedFiles = getNewOrUpdatedFiles(allFiles, existingState);

      // 4. Collect messages from new/updated files
      const newMessages: SessionMessage[] = [];
      for (const file of newOrUpdatedFiles) {
        try {
          const { messages } = parseSessionFile(path.join(chatsDir, file.name));
          newMessages.push(...messages);
        } catch {
          /* skip unreadable file */
        }
      }

      // 5. Update structured context + summary incrementally
      let summary = existingState?.summary ?? "";

      if (newMessages.length > 0 && generateText) {
        console.error(
          `🧠 [Jarvis] Compressing session history (${newOrUpdatedFiles.length} new/updated files, ${newMessages.length} messages)...`,
        );
        try {
          // Chunked summarization: process newMessages in batches for small models
          const chunkSize = this.jarvisConfig.summarizer?.chunkSize ?? 100;
          const chunks: SessionMessage[][] =
            chunkSize > 0 && newMessages.length > chunkSize
              ? Array.from(
                  { length: Math.ceil(newMessages.length / chunkSize) },
                  (_, i) =>
                    newMessages.slice(i * chunkSize, (i + 1) * chunkSize),
                )
              : [newMessages];

          if (chunks.length > 1) {
            console.error(
              `🧠 [Jarvis] Chunked summarization: ${newMessages.length} messages → ${chunks.length} chunks of ~${chunkSize}`,
            );
          }

          let rollingSummary = summary || null;
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunks.length > 1) {
              console.error(
                `🧠 [Jarvis] Summarizing chunk ${i + 1}/${chunks.length} (${chunk.length} messages)...`,
              );
            }
            const newSummary = await buildIncrementalSummary(
              chunk,
              rollingSummary,
              generateText,
              { maxRetries: 3, retryDelayMs: 2000 },
            );
            if (newSummary.trim().length > 0) {
              rollingSummary = newSummary;
            }
          }

          if (rollingSummary && rollingSummary !== (summary || null)) {
            summary = rollingSummary;
            const processedFileMtimes: Record<string, number> = {};
            for (const f of allFiles) processedFileMtimes[f.name] = f.mtime;
            saveSummaryState(memoryDir, {
              summary,
              processedFileMtimes,
              updatedAt: Date.now(),
            });
            console.error(
              `✅ [Jarvis] Session history compressed (${summary.length} chars, ${chunks.length} chunk(s)).`,
            );
          } else {
            console.error(
              `⚠️ [Jarvis] Compression returned empty — not persisting. Will retry next startup.`,
            );
          }
        } catch (e) {
          console.error(
            `⚠️ [Jarvis] History compression failed, using existing: ${(e as Error).message}`,
          );
        }
      } else if (newMessages.length > 0 && !generateText) {
        debugLogger.debug(
          "[AgentInitializer] generateText unavailable, skipping history compression.",
        );
      } else {
        debugLogger.debug(
          "[AgentInitializer] No new session content, using existing summary.",
        );
      }

      if (!summary.trim()) {
        console.error(
          `⚠️ [Jarvis] No compressed history available — context limited to recent ${recentTurns} turns.`,
        );
      }

      // 6. Take the most recent N raw messages across ALL files for the recent turns
      const allMessages: SessionMessage[] = [];
      for (const file of allFiles) {
        try {
          const { messages } = parseSessionFile(path.join(chatsDir, file.name));
          allMessages.push(...messages);
        } catch {
          /* skip unreadable file */
        }
      }
      const recentMessages = allMessages.slice(-recentTurns);

      // 7. Build history: compressed history prefix + recent raw turns
      const history = buildHistoryWithSummary(summary, recentMessages);

      // 8. Use the latest session file as the active recording target
      const latestFile = allFiles[allFiles.length - 1];
      const { record: latestRecord } = parseSessionFile(
        path.join(chatsDir, latestFile.name),
      );

      await client.resumeChat(history, {
        conversation: latestRecord,
        filePath: path.join(chatsDir, latestFile.name),
      });

      // 9. Stats log
      const totalMsgs = allMessages.length;
      const userTurns = allMessages.filter((m) => m.type === "user").length;
      const modelTurns = allMessages.filter((m) => m.type === "gemini").length;
      const toolCalls = allMessages.reduce(
        (n, m) => n + (m.toolCalls?.length ?? 0),
        0,
      );
      // timestamp may be ISO string or number — normalise to ms
      const timestamps = allMessages
        .map((m) => m.timestamp)
        .filter(Boolean)
        .map((t) =>
          typeof t === "string" ? new Date(t as string).getTime() : Number(t),
        )
        .filter((t) => !isNaN(t));
      const earliest = timestamps.length
        ? new Date(Math.min(...timestamps)).toLocaleString()
        : "unknown";
      const latest = timestamps.length
        ? new Date(Math.max(...timestamps)).toLocaleString()
        : "unknown";

      console.error(
        `📂 [Jarvis] Session restored: ${allFiles.length} session files, ${totalMsgs} total messages ` +
          `(${userTurns} user / ${modelTurns} model / ${toolCalls} tool calls) | ` +
          `${earliest} → ${latest} | injected: summary + ${recentMessages.length} recent turns`,
      );
    } catch (e) {
      console.error(
        `⚠️ [AgentInitializer] resumeFromDisk failed: ${(e as Error).message}`,
      );
    }
  }
}
