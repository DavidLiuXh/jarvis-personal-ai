/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "node:events";
import {
  GeminiClient,
  debugLogger,
  GeminiEventType,
  Scheduler,
  promptIdContext,
  LlmRole,
  type Part,
} from "../../../gemini-cli/packages/core/src/index.js";

import { JarvisEventType, type JarvisAgentOptions } from "./types.js";
import { type MemoryService } from "./memory.js";
import { DynamicToolRegistry } from "./dynamicToolRegistry.js";
import {
  SystemPromptBuilder,
  buildJarvisPreamble,
  type FactRecord,
  type SkillInfo,
} from "./systemPromptBuilder.js";
import { BackgroundDistiller } from "./backgroundDistiller.js";
import { ToolRouter } from "./toolRouter.js";
import { AgentInitializer } from "./agentInitializer.js";
import { type TaskCommandHandler } from "./taskCommandHandler.js";
import { type SkillCommandHandler } from "./skillCommandHandler.js";
import { isFetchError, cleanOrphanedUserTurn } from "./agentNetworkUtils.js";
import { ConfigManager } from "./configManager.js";
import { type ChannelRegistry } from "./channelRegistry.js";
import { LocalModelRouter } from "./localModelRouter.js";

/**
 * JARVIS 3.0: The Digital Lifeform Agent
 *
 * Coordinator: delegates initialization, tool routing, and background
 * distillation to focused collaborators.
 */
export class JarvisAgent extends EventEmitter {
  private client!: GeminiClient;
  private scheduler!: Scheduler;
  private sessionId: string;
  private memoryService: MemoryService;
  private dynamicRegistry: DynamicToolRegistry;
  private initialized = false;
  private isProcessing = false;
  private promptBuilder = new SystemPromptBuilder();
  private jarvisConfig = ConfigManager.getInstance().get();
  private distiller!: BackgroundDistiller;
  private toolRouter!: ToolRouter;
  private agentInitializer: AgentInitializer;
  private taskCommandHandler?: TaskCommandHandler;
  private skillCommandHandler?: SkillCommandHandler;
  private channelRegistry?: ChannelRegistry;
  private availableSkills: SkillInfo[] = [];
  private localModelRouter: LocalModelRouter | null = null;

  constructor(options: JarvisAgentOptions) {
    super();
    this.sessionId = options.sessionId;
    this.memoryService = options.memoryService;
    this.dynamicRegistry = new DynamicToolRegistry(options.cwd);
    this.agentInitializer = new AgentInitializer(
      options.sessionId,
      options.cwd,
      options.memoryService,
      this.dynamicRegistry,
    );
  }

  public async initialize() {
    if (this.initialized) return;

    const { client, scheduler } = await this.agentInitializer.initialize(
      (msg) => this.emit(JarvisEventType.SUBAGENT_ACTIVITY, msg),
    );
    this.client = client;
    this.scheduler = scheduler;

    const generateText = async (prompt: string): Promise<string> => {
      const generator = this.client.config.getContentGenerator();
      const response = await generator.generateContent(
        {
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        },
        `distill-${Date.now()}`,
        LlmRole.UTILITY_TOOL,
      );
      return response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    };

    this.distiller = new BackgroundDistiller(
      generateText,
      (category, content, importance) =>
        this.memoryService.saveFact(category, content, importance),
    );

    this.memoryService.setGenerateText(generateText);

    // Always use the API key path for embedding — Code Assist mode does not
    // support embedContent, and the direct GoogleGenAI client is more reliable.
    const embedContent = (text: string): Promise<number[]> =>
      this.memoryService.embedWithApiKey(text);
    this.memoryService.setEmbedContent(embedContent);

    this.toolRouter = new ToolRouter(
      this.memoryService,
      this.dynamicRegistry,
      this.scheduler,
      this.client,
      this.taskCommandHandler,
      this.channelRegistry,
    );

    // Initialize local model router if configured
    const routingCfg = this.jarvisConfig.routing;
    if (routingCfg?.enabled && routingCfg.model) {
      this.localModelRouter = new LocalModelRouter(
        routingCfg.baseUrl ?? "http://localhost:11434",
        routingCfg.model,
        routingCfg.threshold ?? 70,
        routingCfg.proModel ?? "gemini-2.5-pro",
        routingCfg.flashModel ?? "gemini-2.5-flash",
        routingCfg.timeoutMs ?? 30_000,
      );
      console.error(
        `🔀 [Jarvis] Local model router initialized (model=${routingCfg.model}, threshold=${routingCfg.threshold ?? 70})`,
      );
    }

    this.initialized = true;
    debugLogger.debug(`[JarvisAgent] Lifeform Ready.`);
  }

  private async refreshContext(userPrompt: string) {
    const facts = (await this.memoryService.searchFacts(
      userPrompt,
    )) as FactRecord[];
    const protocol = this.promptBuilder.buildFromFacts(
      facts,
      userPrompt,
      this.availableSkills,
    );
    // Use Jarvis slim preamble — GEMINI.md (userMemory) intentionally excluded
    // as it is Gemini CLI global config irrelevant to personal assistant use
    const defaultInstruction = buildJarvisPreamble();

    // vec_memories pre-warm: inject semantically similar past conversations
    const prewarmLimit = this.jarvisConfig.memory.prewarmLimit ?? 3;
    let prewarmSection = "";
    if (prewarmLimit > 0) {
      const similarMemories = await this.memoryService.search(
        userPrompt,
        prewarmLimit,
      );
      if (similarMemories.length > 0) {
        prewarmSection =
          "\n<relevant_past_conversations>\n" +
          similarMemories
            .map((m, i) => `[Long-term Memory ${i + 1}]: ${m}`)
            .join("\n") +
          "\n</relevant_past_conversations>";
      }
    }

    this.client
      .getChat()
      .setSystemInstruction(
        defaultInstruction + "\n" + protocol + prewarmSection,
      );

    console.error(
      `🔄 [Jarvis] System Prompt Refreshed. Facts injected: ${facts.length}. Prewarmed memories: ${prewarmLimit > 0 ? (prewarmSection ? prewarmSection.split("[Past ").length - 1 : 0) : "disabled"}.`,
    );
  }

  public setChannelRegistry(registry: ChannelRegistry): void {
    this.channelRegistry = registry;
    // Re-create toolRouter with the registry if already initialized
    if (this.toolRouter) {
      this.toolRouter = new ToolRouter(
        this.memoryService,
        this.dynamicRegistry,
        this.scheduler,
        this.client,
        this.taskCommandHandler,
        this.channelRegistry,
      );
    }
  }

  public setTaskCommandHandler(handler: TaskCommandHandler): void {
    this.taskCommandHandler = handler;
  }

  public setAvailableSkills(skills: SkillInfo[]): void {
    this.availableSkills = skills;
    this.skillCommandHandler?.setCurrentSkills(skills);
  }

  public setSkillCommandHandler(handler: SkillCommandHandler): void {
    this.skillCommandHandler = handler;
  }

  public async processMessage(
    userPrompt: string,
    imageAttachment?: { data: Buffer; mimeType: string },
  ) {
    // Intercept !task commands — no LLM, no memory operations needed
    if (userPrompt.trimStart().startsWith("!task") && this.taskCommandHandler) {
      const result = await this.taskCommandHandler.handle(userPrompt);
      this.emit(JarvisEventType.CONTENT, {
        type: JarvisEventType.CONTENT,
        value: result,
      });
      this.emit(JarvisEventType.DONE);
      return;
    }

    // Intercept !skill commands — no LLM, no memory operations needed
    if (
      userPrompt.trimStart().startsWith("!skill") &&
      this.skillCommandHandler
    ) {
      const result = await this.skillCommandHandler.handle(userPrompt);
      this.emit(JarvisEventType.CONTENT, {
        type: JarvisEventType.CONTENT,
        value: result,
      });
      this.emit(JarvisEventType.DONE);
      return;
    }

    if (this.isProcessing) {
      throw new Error("Mission in progress.");
    }

    await this.initialize();
    this.isProcessing = true;

    try {
      const pId = `jarvis-${this.sessionId}-${Date.now()}`;

      await promptIdContext.run(pId, async () => {
        // Local model routing: classify complexity and set model before LLM call
        if (this.localModelRouter) {
          const result = await this.localModelRouter.route(userPrompt);
          this.client.config.setModel(result.model);
          console.error(
            `🔀 [Jarvis] Local routing: ${result.decision} | reason="${result.classifierReason}" (source=${result.source})`,
          );
        }

        await this.refreshContext(userPrompt);

        const abortController = new AbortController();
        let currentQueryParts: Part[] = [{ text: userPrompt }];
        if (imageAttachment) {
          currentQueryParts.push({
            inlineData: {
              mimeType: imageAttachment.mimeType,
              data: imageAttachment.data.toString("base64"),
            },
          });
        }

        let finalAssistantText = "";
        const allToolsCalled = new Set<string>();

        const networkConfig = this.jarvisConfig.network;
        const maxRetries = networkConfig?.maxRetries ?? 3;
        const cleanOnFailure =
          networkConfig?.cleanOrphanedTurnOnFailure ?? true;

        while (true) {
          let retryCount = 0;
          let success = false;

          while (retryCount < maxRetries && !success) {
            try {
              const responseStream = this.client.sendMessageStream(
                currentQueryParts,
                abortController.signal,
                pId,
              );
              const toolCallRequests: any[] = [];
              let turnTextAccumulated = "";

              for await (const event of responseStream) {
                if (event.type === GeminiEventType.Content) {
                  const newText = event.value;
                  if (
                    turnTextAccumulated.includes(newText) &&
                    turnTextAccumulated.length > 0
                  )
                    continue;
                  turnTextAccumulated += newText;
                  finalAssistantText += newText;
                  this.emit(JarvisEventType.CONTENT, event);
                } else if (event.type === GeminiEventType.ToolCallRequest) {
                  toolCallRequests.push(event.value);
                } else if (event.type === GeminiEventType.Error) {
                  throw event.value.error;
                } else if (event.type !== GeminiEventType.ModelInfo) {
                  // Filter out ModelInfo events — model name should not appear in chat output
                  this.emit(JarvisEventType.CONTENT, event);
                }
              }

              if (toolCallRequests.length > 0) {
                for (const req of toolCallRequests)
                  allToolsCalled.add(req.name);
                currentQueryParts = await this.toolRouter.route(
                  toolCallRequests,
                  abortController.signal,
                  (resp) => this.emit(JarvisEventType.TOOL_CALL_RESPONSE, resp),
                );
              } else {
                success = true;
              }

              if (!toolCallRequests.length) {
                success = true;
              }
            } catch (err: any) {
              if (isFetchError(err) && retryCount < maxRetries - 1) {
                retryCount++;
                const delay = Math.pow(2, retryCount) * 1000;
                console.error(
                  `⚠️ [JarvisAgent] Network error (${err.message}). Retrying in ${delay}ms... (attempt ${retryCount}/${maxRetries - 1})`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
              } else {
                // All retries exhausted — clean orphaned user turn if configured
                if (cleanOnFailure) {
                  try {
                    const chat = this.client.getChat();
                    const cleaned = cleanOrphanedUserTurn(chat.getHistory());
                    if (cleaned.length < chat.getHistory().length) {
                      chat.setHistory(cleaned);
                      console.error(
                        `🧹 [JarvisAgent] Cleaned orphaned user turn from history.`,
                      );
                    }
                  } catch (_cleanErr) {}
                }
                throw err;
              }
            }
          }
          if (success) break;
        }

        // Skip memory ops when the turn only involved task management tools —
        // task state is already persisted in tasks.json, no need to distill facts.
        const onlyTaskTools =
          allToolsCalled.size > 0 &&
          [...allToolsCalled].every((name) => name.startsWith("task_"));
        if (!onlyTaskTools) {
          this.memoryService.enqueue(
            this.sessionId,
            userPrompt,
            finalAssistantText,
          );
          void this.distiller.distill(userPrompt, finalAssistantText);
        }
      });
      this.emit(JarvisEventType.DONE);
    } catch (error) {
      debugLogger.error("[JarvisAgent] Operational error:", error);
      this.emit(JarvisEventType.ERROR, error);
    } finally {
      this.isProcessing = false;
    }
  }

  public getHistory() {
    if (!this.client) return [];
    return this.client.getChat().getHistory();
  }
}
