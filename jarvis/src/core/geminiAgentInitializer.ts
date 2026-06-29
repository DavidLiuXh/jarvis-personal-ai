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
} from "../../../gemini-cli/packages/core/src/index.js";

// @ts-expect-error - Relative import
import { loadCliConfig } from "../../../gemini-cli/packages/cli/src/config/config.js";
// @ts-expect-error - Relative import
import { loadSettings } from "../../../gemini-cli/packages/cli/src/config/settings.js";
// @ts-expect-error - Relative import
import { MemoryService } from "./memory.js";
import { ConfigManager } from "./configManager.js";
import { ollamaGenerateWithRetry } from "./ollamaClient.js";
import {
  loadSummaryState,
  saveSummaryState,
  buildChunkedRollingSummary,
  getNewOrUpdatedFiles,
} from "./sessionSummarizer.js";
import { buildHistoryFromMessages } from "./resumeFromDisk.js";
import {
  listSessionTranscriptFiles,
  parseSessionTranscriptFile,
  sessionTranscriptRootsFromProjectTempDir,
} from "./sessionTranscript.js";
import {
  addToolsToGeminiRegistry,
  createDefaultRuntimeToolRegistry,
} from "./jarvisToolRegistry.js";

type DynamicRegistryHandle = {
  getDynamicToolSchemas: () => unknown[];
};

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
  // Stored after initialize() so triggerSkillExtraction() can reuse it
  private config: any = null;
  private isExtractingSkills = false;
  private conversationSummary = "";

  constructor(
    private sessionId: string,
    private sourceRoot: string,
    private memoryService: MemoryService,
    private dynamicRegistry: DynamicRegistryHandle,
    private skipResume: boolean = false,
  ) {}

  getCompatibilityConfig(): unknown {
    return this.config;
  }

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
      const shellSecurity = this.jarvisConfig.security?.shell;
      if (shellSecurity?.allowNetworkFetchCommands) {
        const fetchAllows = (shellSecurity.networkFetchCommands ?? [])
          .map((command) => command.trim())
          .filter(Boolean)
          .map((command) => `run_shell_command(${command})`);
        if (fetchAllows.length > 0) {
          settings.merged.tools.allowed = [
            ...(settings.merged.tools.allowed ?? []),
            ...fetchAllows,
          ];
          console.error(
            `🔓 [Jarvis] Shell network fetch commands allowed: ${fetchAllows.join(", ")}`,
          );
        }
      }
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

    // Ensure api.proxy from Jarvis config is applied as environment variable
    // so loadCliConfig (and subsequently setGlobalProxy) picks it up.
    // This bridges the gap between Jarvis config and gemini-cli's proxy handling.
    const jarvisProxy = this.jarvisConfig.api?.proxy;
    if (jarvisProxy && !process.env.HTTPS_PROXY && !process.env.https_proxy) {
      process.env.HTTPS_PROXY = jarvisProxy;
      console.error(`🌐 [Jarvis] Proxy configured: ${jarvisProxy}`);
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
    this.config = config; // store for triggerSkillExtraction()

    // III. TOOL REGISTRATION
    const registry = config.getToolRegistry();

    addToolsToGeminiRegistry(
      registry,
      createDefaultRuntimeToolRegistry().listTools(),
    );

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
      const model = summarizerCfg.model;
      const baseUrl = this.jarvisConfig.ollama?.baseUrl;
      const timeoutMs =
        summarizerCfg.timeoutMs ??
        this.jarvisConfig.ollama?.defaultTimeoutMs ??
        120_000;
      generateText = (prompt: string) =>
        ollamaGenerateWithRetry(model, prompt, {
          baseUrl,
          timeoutMs,
          maxRetries: this.jarvisConfig.ollama?.maxRetries,
          maxTimeoutMs: timeoutMs * 3,
          purpose: "session-summarizer",
        });
      console.error(`📝 [Jarvis] Session summarizer: Ollama (${model})`);
    } else {
      generateText = cliGenerateText;
    }

    await this.resumeFromDisk(client, generateText);

    // Strip the gemini-cli session_context turn from ALL GeminiClient instances.
    // gemini-cli maintains TWO separate GeminiClient objects:
    //   1. config._geminiClient — used by ContextBuilder/Conseca safety checks
    //   2. Jarvis's own `client` — used for actual LLM requests
    // Both get session_context prepended via getInitialChatHistory().
    // Stripping only one leaves the other stale and Conseca still sees it.
    const stripSessionContext = (c: any): number => {
      if (!c?.getHistory || !c?.setHistory) return 0;
      const h = [...(c.getHistory() as any[])];
      const stripped = h.filter(
        (turn: any) =>
          !(
            turn.role === "user" &&
            turn.parts?.some((p: any) =>
              (p.text ?? "").includes("<session_context>"),
            )
          ),
      );
      if (stripped.length < h.length) {
        c.setHistory(stripped);
        return h.length - stripped.length;
      }
      return 0;
    };

    const n1 = stripSessionContext(client);
    const n2 = stripSessionContext((config as any)._geminiClient);
    if (n1 + n2 > 0) {
      console.error(
        `🧹 [Jarvis] Stripped session_context from ${[n1 && "own", n2 && "config"].filter(Boolean).join(" + ")} client(s).`,
      );
    }

    const scheduler = new Scheduler({
      context: config,
      messageBus: config.getMessageBus(),
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    debugLogger.debug(`[AgentInitializer] Lifeform Ready.`);
    return { client, scheduler };
  }

  public getConversationSummary(): string {
    return this.conversationSummary;
  }

  /**
   * Runs confucius (SkillExtractionAgent) against Jarvis session history.
   * Writes new SKILL.md files to ~/.gemini/skills/ so they are immediately
   * available via activate_skill.
   * Non-blocking: safe to call with setImmediate / setTimeout.
   */
  public async triggerSkillExtraction(): Promise<void> {
    if (!this.config) return;
    if (this.isExtractingSkills) return;
    this.isExtractingSkills = true;

    try {
      // Dynamically import to avoid circular deps and keep startup fast
      const { SkillExtractionAgent } = await import(
        "../../../gemini-cli/packages/core/src/agents/skill-extraction-agent.js"
      );
      const { LocalAgentExecutor } = await import(
        "../../../gemini-cli/packages/core/src/agents/local-executor.js"
      );
      const { buildSessionIndex } = await import(
        "../../../gemini-cli/packages/core/src/services/memoryService.js"
      );
      const { getModelConfigAlias } = await import(
        "../../../gemini-cli/packages/core/src/agents/registry.js"
      );

      const roots = sessionTranscriptRootsFromProjectTempDir(
        this.config.storage.getProjectTempDir(),
      );
      const sessionDirs = [
        roots.jarvisSessionsDir,
        roots.geminiChatsDir,
      ].filter(
        (dir, index, all) => fs.existsSync(dir) && all.indexOf(dir) === index,
      );
      // Write skills to ~/.gemini/skills/ — where Jarvis loads them from
      const skillsDir = path.join(os.homedir(), ".gemini", "skills");
      if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
      }

      // Build session index (only processes new sessions)
      const statePath = path.join(
        os.homedir(),
        ".gemini-jarvis",
        "skill-extraction-state.json",
      );
      const { readExtractionState } = await import(
        "../../../gemini-cli/packages/core/src/services/memoryService.js"
      );
      const state = await readExtractionState(statePath);
      const sessionIndexes: string[] = [];
      const newSessionIds: string[] = [];
      for (const dir of sessionDirs) {
        const indexed = await buildSessionIndex(dir, state);
        sessionIndexes.push(indexed.sessionIndex);
        newSessionIds.push(...indexed.newSessionIds);
      }
      const sessionIndex = sessionIndexes.filter(Boolean).join("\n");
      const uniqueNewSessionIds = Array.from(new Set(newSessionIds));

      if (uniqueNewSessionIds.length === 0) {
        debugLogger.debug(
          "[AgentInitializer] triggerSkillExtraction: no new sessions, skipping.",
        );
        return;
      }

      console.error(
        `🧠 [Jarvis] Skill extraction started: ${uniqueNewSessionIds.length} new session(s) to analyze...`,
      );

      const agentDefinition = SkillExtractionAgent(
        skillsDir,
        sessionIndex,
        "", // no existing skills summary for now
      );

      // Register model config (required before running)
      const modelAlias = getModelConfigAlias(agentDefinition);
      this.config.modelConfigService.registerRuntimeModelConfig(modelAlias, {
        modelConfig: agentDefinition.modelConfig,
      });

      // Build AgentLoopContext from stored config
      const context = {
        config: this.config,
        promptId: `skill-extraction-${Date.now()}`,
        toolRegistry: this.config.getToolRegistry(),
        promptRegistry: this.config.getPromptRegistry?.() ?? ({} as any),
        resourceRegistry: this.config.getResourceRegistry?.() ?? ({} as any),
        messageBus: this.config.getMessageBus(),
        geminiClient: this.config.getGeminiClient?.() ?? ({} as any),
        sandboxManager: this.config.getSandboxManager?.() ?? ({} as any),
      };

      const executor = await LocalAgentExecutor.create(
        agentDefinition,
        context,
      );
      const abortController = new AbortController();
      await executor.run(
        { request: "Extract reusable skills from the provided sessions." },
        abortController.signal,
      );

      // Persist state so processed sessions aren't re-analyzed next time
      const { writeExtractionState } = await import(
        "../../../gemini-cli/packages/core/src/services/memoryService.js"
      );
      await writeExtractionState(statePath, {
        ...state,
        runs: [
          ...state.runs,
          {
            timestamp: Date.now(),
            processedSessionIds: uniqueNewSessionIds,
            skillsCreated: [],
            durationMs: 0,
          },
        ],
      });

      console.error(`✅ [Jarvis] Skill extraction complete.`);
    } catch (e: any) {
      console.error(`⚠️ [Jarvis] Skill extraction failed: ${e.message}`);
    } finally {
      this.isExtractingSkills = false;
    }
  }

  private async resumeFromDisk(
    client: GeminiClient,
    generateText?: (prompt: string) => Promise<string>,
  ): Promise<void> {
    if (this.skipResume || !this.jarvisConfig.session?.resumeOnStart) {
      debugLogger.debug(
        `[AgentInitializer] Skipping history restore (skipResume=${this.skipResume}, resumeOnStart=${this.jarvisConfig.session?.resumeOnStart}).`,
      );
      return;
    }

    const roots = sessionTranscriptRootsFromProjectTempDir(
      client.config.storage.getProjectTempDir(),
    );
    const memoryDir = path.join(os.homedir(), ".gemini-jarvis", "memory");
    const recentTurns = this.jarvisConfig.session?.recentTurnsOnResume ?? 20;

    try {
      // 1. Collect all session files sorted by mtime (oldest first)
      const allFiles = listSessionTranscriptFiles(roots);

      if (allFiles.length === 0) return;

      // 2. Load existing summary state
      let existingState = loadSummaryState(memoryDir);

      // Apply summaryWindowDays: only process files within the window
      const summaryWindowDays =
        this.jarvisConfig.summarizer?.summaryWindowDays ?? 0;
      const cutoffMs =
        summaryWindowDays > 0 ? Date.now() - summaryWindowDays * 86_400_000 : 0;

      // If existing summary is older than the window, reset it
      if (
        summaryWindowDays > 0 &&
        existingState?.updatedAt &&
        existingState.updatedAt < cutoffMs
      ) {
        console.error(
          `🧠 [Jarvis] Summary older than ${summaryWindowDays} days — resetting for fresh window.`,
        );
        existingState = null;
      }

      const windowFiles =
        cutoffMs > 0 ? allFiles.filter((f) => f.mtime >= cutoffMs) : allFiles;

      // 3. Find new or updated files using mtime comparison (within window)
      const newOrUpdatedFiles = getNewOrUpdatedFiles(
        windowFiles,
        existingState,
      );

      // 4. Collect messages from new/updated files
      const newMessages: SessionMessage[] = [];
      for (const file of newOrUpdatedFiles) {
        try {
          const { messages } = parseSessionTranscriptFile(file.filePath);
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
          const rollingSummary = await buildChunkedRollingSummary(
            newMessages,
            summary || null,
            generateText,
            {
              chunkSize: this.jarvisConfig.summarizer?.chunkSize ?? 100,
              maxSummaryLength:
                this.jarvisConfig.summarizer?.maxSummaryLength ?? 1200,
              maxRetries: 3,
              retryDelayMs: 2000,
              onProgress: (message) => console.error(`🧠 [Jarvis] ${message}`),
            },
          );

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
              `✅ [Jarvis] Session history compressed (${summary.length} chars).`,
            );

            // Events extraction is handled by backfillSessionEvents() in autoBackfill()
            // which runs 60s after startup with proper file-level state tracking.
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
          const { messages } = parseSessionTranscriptFile(file.filePath);
          allMessages.push(...messages);
        } catch {
          /* skip unreadable file */
        }
      }
      // slice(-0) === slice(0) returns the full array, so guard explicitly
      const recentMessages =
        recentTurns > 0 ? allMessages.slice(-recentTurns) : [];

      // 7. Build history: compressed history prefix + recent raw turns
      const history = buildHistoryFromMessages(recentMessages);
      this.conversationSummary = summary;

      // 8. Use the latest session file as the active recording target
      const latestFile = allFiles[allFiles.length - 1];
      const { record: latestRecord } = parseSessionTranscriptFile(
        latestFile.filePath,
      );

      await client.resumeChat(history, {
        conversation: latestRecord,
        filePath: latestFile.filePath,
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
          `${earliest} → ${latest} | injected: ${recentMessages.length} recent turns, summary loaded separately`,
      );
    } catch (e) {
      console.error(
        `⚠️ [AgentInitializer] resumeFromDisk failed: ${(e as Error).message}`,
      );
    }
  }
}
