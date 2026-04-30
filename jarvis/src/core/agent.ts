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
  ToolConfirmationOutcome,
  type Part,
} from "../../../gemini-cli/packages/core/src/index.js";
import { MessageBusType } from "../../../gemini-cli/packages/core/src/confirmation-bus/types.js";

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
import {
  buildIncrementalSummary,
  buildHistoryWithSummary,
  type SessionMessage,
} from "./sessionSummarizer.js";
import { LocalModelRouter } from "./localModelRouter.js";
import { type AgentManager } from "./agentManager.js";
import { routeToAgent } from "./agentRouter.js";

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
  private agentManager: AgentManager | null = null;
  private conversationTurnCount = 0;
  private summarizerGenerateText: ((prompt: string) => Promise<string>) | null =
    null;

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

    // Route distillation through reflection.provider so local Ollama models
    // can be used for fact extraction. Falls back to Gemini if reflection.model
    // is not set or provider is "gemini".
    const distillGenerateText =
      this.memoryService.buildReflectionGenerateText(generateText);

    this.distiller = new BackgroundDistiller(
      distillGenerateText,
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
        this.jarvisConfig.ollama?.baseUrl ?? "http://localhost:11434",
        routingCfg.model,
        routingCfg.threshold ?? 70,
        routingCfg.proModel ?? "gemini-2.5-pro",
        routingCfg.flashModel ?? "gemini-2.5-flash",
        routingCfg.timeoutMs ??
          this.jarvisConfig.ollama?.defaultTimeoutMs ??
          30_000,
        routingCfg.historyTurns ?? 5,
      );
      console.error(
        `🔀 [Jarvis] Local model router initialized (model=${routingCfg.model}, threshold=${routingCfg.threshold ?? 70})`,
      );
    }

    // Initialize summarizer generateText for history compression
    // Uses summarizer.model (Ollama) if configured, falls back to CLI-auth
    this.summarizerGenerateText =
      this.memoryService.buildReflectionGenerateText(generateText);

    // 🛡️ Register messageBus listener for tool confirmation.
    // The correct confirmation flow in gemini-cli:
    //   1. PolicyEngine → ASK_USER → resolveConfirmation() called
    //   2. resolveConfirmation() calls shouldConfirmExecute() → getMessageBusDecision()
    //      which publishes TOOL_CONFIRMATION_REQUEST; Scheduler auto-responds with
    //      requiresUserConfirmation=true → getMessageBusDecision returns 'ask_user'
    //   3. resolveConfirmation() generates a NEW correlationId, calls
    //      state.updateStatus(AwaitingApproval, { correlationId }) → TOOL_CALLS_UPDATE
    //   4. resolveConfirmation() calls waitForConfirmation(messageBus, correlationId)
    //      which listens for TOOL_CONFIRMATION_RESPONSE with that correlationId
    //
    // We must listen to TOOL_CALLS_UPDATE, detect AwaitingApproval status,
    // extract the correlationId and confirmationDetails, then emit to web UI.
    // provideConfirmationResponse() emits TOOL_CONFIRMATION_RESPONSE with that id.
    const messageBus = this.client.config.getMessageBus();
    const emittedConfirmIds = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageBus.on(MessageBusType.TOOL_CALLS_UPDATE, (msg: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const waitingCall = msg.toolCalls?.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tc: any) => tc.status === "awaiting_approval" && tc.correlationId,
      );
      if (waitingCall) {
        const correlationId = waitingCall.correlationId as string;
        if (emittedConfirmIds.has(correlationId)) return;
        emittedConfirmIds.add(correlationId);
        const details = waitingCall.confirmationDetails;
        const toolName =
          details?.title ?? waitingCall.request?.name ?? "unknown_tool";
        const toolArgs = JSON.stringify(waitingCall.request?.args ?? {});
        const message = details?.command
          ? `Confirm execution of: ${details.command}`
          : `Tool "${toolName}" requires confirmation.\nArgs: ${toolArgs}`;
        this.emit(JarvisEventType.CONTENT, {
          type: "confirmation_request",
          value: { id: correlationId, message },
        });
      }
    });

    this.initialized = true;
    debugLogger.debug(`[JarvisAgent] Lifeform Ready.`);

    // Wait for autoBackfill (including startup events backfill) to complete
    // so Jarvis is fully ready before the HTTP server starts accepting requests
    await this.memoryService.waitForBackfill();
  }

  /**
   * Compress in-memory chat history when it exceeds historyCompressionThreshold turns.
   * Summarizes older turns and keeps only the most recent historyKeepRecentTurns raw.
   * Automatically scales the threshold for code-heavy conversations.
   */
  private async compressHistoryIfNeeded(): Promise<void> {
    if (!this.summarizerGenerateText || !this.client) return;

    let threshold =
      this.jarvisConfig.session?.historyCompressionThreshold ?? 30;
    const keepRecent = this.jarvisConfig.session?.historyKeepRecentTurns ?? 5;
    const multiplier =
      this.jarvisConfig.session?.codeHeavyThresholdMultiplier ?? 2.0;

    if (threshold === 0) return;

    const history = this.client.getChat().getHistory();
    // Each "turn" is a user+model pair = 2 entries
    const totalEntries = history.length;
    const turnCount = Math.floor(totalEntries / 2);

    // 🧠 DYNAMIC THRESHOLD: Detect if history contains significant code
    let codeBlockCount = 0;
    for (const entry of history) {
      const text = entry.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      if (text.includes("```")) {
        codeBlockCount++;
      }
    }
    const codeDensity = codeBlockCount / (totalEntries || 1);
    const isCodeHeavy = codeDensity > 0.15; // > 15% of messages have code

    if (isCodeHeavy) {
      threshold = Math.floor(threshold * multiplier);
      debugLogger.debug(
        `[Jarvis] Code-heavy context detected (density=${codeDensity.toFixed(2)}). Scaling threshold to ${threshold}.`,
      );
    }

    if (turnCount <= threshold) return;

    try {
      // Split: turns to compress vs turns to keep raw
      const keepEntries = keepRecent * 2;
      const toCompress = history.slice(0, history.length - keepEntries);
      const toKeep = history.slice(history.length - keepEntries);

      // Convert to SessionMessage format for buildIncrementalSummary
      const messages: SessionMessage[] = toCompress
        .map((turn) => {
          const text = turn.parts?.map((p: any) => p.text ?? "").join("") ?? "";
          if (!text.trim()) return null;
          return {
            type: turn.role === "user" ? "user" : "gemini",
            content: text,
          } as SessionMessage;
        })
        .filter((m): m is SessionMessage => m !== null);

      if (messages.length === 0) return;

      // Extract existing summary if history starts with one
      let existingSummary: string | null = null;
      const firstUserText =
        toCompress[0]?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      if (firstUserText.startsWith("[CONVERSATION HISTORY SUMMARY]")) {
        existingSummary = firstUserText
          .replace("[CONVERSATION HISTORY SUMMARY]\n", "")
          .trim();
      }

      const newSummary = await buildIncrementalSummary(
        messages,
        existingSummary,
        this.summarizerGenerateText,
        { maxRetries: 2, retryDelayMs: 1000 },
      );

      if (!newSummary.trim()) return;

      // Rebuild history: summary pair + recent raw turns
      const compressedHistory = buildHistoryWithSummary(
        newSummary,
        toKeep
          .map((turn) => ({
            type: turn.role === "user" ? "user" : "gemini",
            content: turn.parts?.map((p: any) => p.text ?? "").join("") ?? "",
          }))
          .filter((m) => m.content.trim()) as SessionMessage[],
      );

      this.client.getChat().setHistory(compressedHistory);
      console.error(
        `🗜️ [Jarvis] History compressed: ${turnCount} turns → summary + ${keepRecent} recent turns.`,
      );
    } catch (e: any) {
      console.error(`⚠️ [Jarvis] History compression failed: ${e.message}`);
    }
  }

  private async refreshContext(
    userPrompt: string,
    querySubject: "personal" | "external" | "mixed" = "mixed",
    timeWindowDays: number | null = null,
    resolvedDateRange: { from: number; to: number } | null = null,
  ) {
    // For external queries (pure world knowledge), skip personal facts entirely —
    // they add noise and no value. For personal/mixed, use symmetric embedding:
    // prepend the same "PRIVATE_USER_DATA: User Query - " prefix to the query
    // so it lands in the same embedding space as the prefixed fact vectors.
    let facts: FactRecord[] = [];
    if (querySubject !== "external") {
      const embeddingQuery =
        querySubject === "personal" || querySubject === "mixed"
          ? "PRIVATE_USER_DATA: User Query - " + userPrompt
          : userPrompt;
      const hasPrefix = embeddingQuery !== userPrompt;
      console.error(
        `🔍 [Jarvis] searchFacts (subject=${querySubject}, prefix=${hasPrefix}): "${embeddingQuery.slice(0, 80)}"`,
      );
      facts = (await this.memoryService.searchFacts(
        embeddingQuery,
      )) as FactRecord[];
    } else {
      console.error(
        `🔍 [Jarvis] External query (subject=external) — skipping facts + prewarm injection.`,
      );
    }

    const protocol = this.promptBuilder.buildFromFacts(
      facts,
      userPrompt,
      this.availableSkills,
    );
    // Use Jarvis slim preamble — GEMINI.md (userMemory) intentionally excluded
    // as it is Gemini CLI global config irrelevant to personal assistant use
    const defaultInstruction = buildJarvisPreamble();

    // vec_memories pre-warm: inject semantically similar past conversations
    // Also skip for external queries to avoid Context Adhesion
    const prewarmLimit = this.jarvisConfig.memory.prewarmLimit ?? 3;
    let prewarmSection = "";
    if (prewarmLimit > 0 && querySubject !== "external") {
      const similarMemories = await this.memoryService.search(
        userPrompt,
        prewarmLimit,
        timeWindowDays,
        resolvedDateRange,
      );
      if (similarMemories.length > 0) {
        prewarmSection =
          "\n<relevant_past_conversations>\n" +
          similarMemories
            .map((m, i) => `[Long-term Memory ${i + 1}]: ${m}`)
            .join("\n") +
          "\n</relevant_past_conversations>";
        console.error(
          `🧠 [prewarm] ${similarMemories.length} memories injected:\n` +
            similarMemories
              .map((m, i) => `  [${i + 1}] ${m.slice(0, 120)}`)
              .join("\n"),
        );
      }
    }

    this.client
      .getChat()
      .setSystemInstruction(
        defaultInstruction + "\n" + protocol + prewarmSection,
      );

    console.error(
      `🔄 [Jarvis] System Prompt Refreshed (subject=${querySubject}). Facts injected: ${facts.length}. Prewarmed memories: ${prewarmLimit > 0 ? (prewarmSection ? prewarmSection.split("[Long-term Memory ").length - 1 : 0) : "disabled"}.`,
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

  public setAgentManager(manager: AgentManager): void {
    this.agentManager = manager;
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
        // Local model routing: classify complexity + query subject, set model
        let querySubject: "personal" | "external" | "mixed" = "mixed";
        let timeWindowDays: number | null = null;
        let resolvedDateRange: { from: number; to: number } | null = null;
        if (this.localModelRouter) {
          const rawHistory = this.client.getChat().getHistory();
          const history = rawHistory.flatMap((turn) => {
            const content =
              turn.parts?.map((p: any) => p.text ?? "").join("") ?? "";
            if (!content.trim()) return [];
            return [
              {
                role: (turn.role === "user" ? "user" : "assistant") as
                  | "user"
                  | "assistant",
                content,
              },
            ];
          });
          const result = await this.localModelRouter.route(userPrompt, history);
          this.client.config.setModel(result.model);
          querySubject = result.querySubject;
          timeWindowDays = result.timeWindowDays;
          resolvedDateRange = result.resolvedDateRange ?? null;
          this.toolRouter.setCurrentTimeWindow(timeWindowDays);
          this.toolRouter.setCurrentDateRange(
            resolvedDateRange,
            result.dateFrom,
            result.dateTo,
          );
          const twLabel = result.dateFrom
            ? `${result.dateFrom}~${result.dateTo}`
            : (result.timeWindowDays ?? "none");
          console.error(
            `🔀 [Jarvis] Local routing: ${result.decision} | subject=${result.querySubject} | time_window=${twLabel} | reason="${result.classifierReason}" (source=${result.source})`,
          );
        }

        // ── External Agent routing ────────────────────────────────────────
        // Check if this request should be dispatched to an ADK agent instead
        // of going through the normal LLM path.
        if (this.agentManager) {
          const route = routeToAgent(
            userPrompt,
            this.agentManager.getRegistry(),
          );
          if (route.matched) {
            console.error(
              `🤖 [AgentRouter] Dispatching to agent=${route.agentId}, input=${JSON.stringify(route.input)}`,
            );
            try {
              // Emit confirmation to user immediately (non-blocking)
              this.emit(JarvisEventType.CONTENT, route.confirmationMessage);
              this.emit(JarvisEventType.DONE, "");
              // Start the agent task in the background
              this.agentManager.createTask(
                route.agentId,
                this.sessionId,
                route.input,
              );
              return; // Skip LLM path entirely
            } catch (agentErr: any) {
              // Validation or registry error — fall through to normal LLM path
              console.error(
                `⚠️ [AgentRouter] createTask failed (${agentErr.message}), falling back to LLM`,
              );
            }
          }
        }
        // ── End external agent routing ────────────────────────────────────

        await this.refreshContext(
          userPrompt,
          querySubject,
          timeWindowDays,
          resolvedDateRange,
        );

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

        // 🛡️ Safety guards: prevent infinite loops and silent failure spirals
        const MAX_TOOL_ITERATIONS = networkConfig?.maxToolIterations ?? 30;
        const MAX_CONSECUTIVE_TOOL_FAILURES =
          networkConfig?.maxConsecutiveToolFailures ?? 3;
        let toolIterations = 0;
        let consecutiveToolFailures = 0;

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
                  // Emit immediately so the web UI can show "Invoking..." before
                  // the tool actually starts executing (which may take a long time).
                  this.emit(JarvisEventType.CONTENT, event);
                } else if (event.type === GeminiEventType.Error) {
                  throw event.value.error;
                } else if (event.type !== GeminiEventType.ModelInfo) {
                  // Filter out ModelInfo events — model name should not appear in chat output
                  this.emit(JarvisEventType.CONTENT, event);
                }
              }

              if (toolCallRequests.length > 0) {
                // Guard: max tool iterations
                toolIterations++;
                if (toolIterations > MAX_TOOL_ITERATIONS) {
                  const msg = `⚠️ [Jarvis] Task aborted: exceeded ${MAX_TOOL_ITERATIONS} tool call iterations. The task may be too complex or stuck in a loop.`;
                  console.error(msg);
                  this.emit(JarvisEventType.CONTENT, {
                    type: GeminiEventType.Content,
                    value: msg,
                  });
                  success = true;
                  break;
                }

                for (const req of toolCallRequests)
                  allToolsCalled.add(req.name);
                const responseParts = await this.toolRouter.route(
                  toolCallRequests,
                  abortController.signal,
                  (resp) => this.emit(JarvisEventType.TOOL_CALL_RESPONSE, resp),
                );

                // Guard: consecutive tool failures
                const failCount = responseParts.filter((p: any) => {
                  const r = p?.functionResponse?.response;
                  return (
                    r &&
                    typeof r === "object" &&
                    ("error" in r || r.status === "error")
                  );
                }).length;

                if (failCount > 0 && failCount === toolCallRequests.length) {
                  consecutiveToolFailures++;
                  if (
                    consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES
                  ) {
                    const msg = `⚠️ [Jarvis] Task aborted: ${MAX_CONSECUTIVE_TOOL_FAILURES} consecutive tool call rounds all failed. Please check tool availability or rephrase the request.`;
                    console.error(msg);
                    this.emit(JarvisEventType.CONTENT, {
                      type: GeminiEventType.Content,
                      value: msg,
                    });
                    success = true;
                    break;
                  }
                } else {
                  consecutiveToolFailures = 0;
                }

                currentQueryParts = responseParts;
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

          // Trigger session events extraction every N turns (async, non-blocking)
          const interval =
            this.jarvisConfig.memory.eventsExtractionInterval ?? 20;
          if (interval > 0 && ++this.conversationTurnCount % interval === 0) {
            setImmediate(() => void this.memoryService.backfillSessionEvents());
          }

          // Trigger skill extraction every 50 turns (async, non-blocking)
          // confucius analyzes new sessions and writes SKILL.md to ~/.gemini/skills/
          const skillInterval = 50;
          if (this.conversationTurnCount % skillInterval === 0) {
            setTimeout(
              () => void this.agentInitializer.triggerSkillExtraction(),
              120_000, // 2 min delay to avoid competing with ongoing conversation
            );
          }

          // Compress in-memory chat history if it exceeds the threshold
          setImmediate(() => void this.compressHistoryIfNeeded());
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

  public triggerSkillExtraction(): Promise<void> {
    return this.agentInitializer.triggerSkillExtraction();
  }

  public provideConfirmationResponse(id: string, decision: "allow" | "deny") {
    if (!this.client) return;
    const messageBus = this.client.config.getMessageBus();
    messageBus.emit(MessageBusType.TOOL_CONFIRMATION_RESPONSE, {
      type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      correlationId: id,
      confirmed: decision === "allow",
      outcome:
        decision === "allow"
          ? ToolConfirmationOutcome.ProceedOnce
          : ToolConfirmationOutcome.Cancel,
    });
  }
}
