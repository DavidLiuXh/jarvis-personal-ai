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
import {
  extractBackgroundPrompt,
  type BackgroundTaskRunner,
} from "./backgroundTaskRunner.js";

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
  private distiller: BackgroundDistiller | null = null;
  private toolRouter!: ToolRouter;
  private agentInitializer: AgentInitializer;
  private taskCommandHandler?: TaskCommandHandler;
  private skillCommandHandler?: SkillCommandHandler;
  private channelRegistry?: ChannelRegistry;
  private availableSkills: SkillInfo[] = [];
  private localModelRouter: LocalModelRouter | null = null;
  private agentManager: AgentManager | null = null;
  private backgroundTaskRunner: BackgroundTaskRunner | null = null;
  private conversationTurnCount = 0;
  private summarizerGenerateText: ((prompt: string) => Promise<string>) | null =
    null;
  private lightweight: boolean;

  constructor(options: JarvisAgentOptions) {
    super();
    this.sessionId = options.sessionId;
    this.memoryService = options.memoryService;
    this.lightweight = options.lightweight ?? false;
    this.dynamicRegistry = new DynamicToolRegistry(options.cwd);
    this.agentInitializer = new AgentInitializer(
      options.sessionId,
      options.cwd,
      options.memoryService,
      this.dynamicRegistry,
      options.skipResume ?? false,
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

    if (!this.lightweight) {
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

      // setGenerateText triggers EntityExtractor initialization inside MemoryService
      this.memoryService.setGenerateText(generateText);
    }

    // Always use the API key path for embedding — Code Assist mode does not
    // support embedContent, and the direct GoogleGenAI client is more reliable.
    const embedContent = (text: string): Promise<number[]> =>
      this.memoryService.embedWithApiKey(text);
    // Lightweight agents use setEmbedContentOnly to avoid re-triggering the
    // global autoBackfill (vec rebuild, entity backfill, session events LLM scan)
    // on every background task start.
    if (this.lightweight) {
      this.memoryService.setEmbedContentOnly(embedContent);
    } else {
      this.memoryService.setEmbedContent(embedContent);
    }

    this.toolRouter = new ToolRouter(
      this.memoryService,
      this.dynamicRegistry,
      this.scheduler,
      this.client,
      this.taskCommandHandler,
      this.channelRegistry,
    );

    // Initialize local model router if configured.
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

    // Initialize summarizer generateText for history compression.
    // Skipped in lightweight mode — bg agents don't compress history.
    if (!this.lightweight) {
      this.summarizerGenerateText =
        this.memoryService.buildReflectionGenerateText(generateText);
    }

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

    // Wait for autoBackfill to complete. Skipped in lightweight mode —
    // backfill is a global DB maintenance task, not needed per bg agent.
    if (!this.lightweight) {
      await this.memoryService.waitForBackfill();
    }
  }

  /**
   * For history turns before the active loop:
   * - Remove thoughtSignature fields (not needed by the API for old turns).
   * - Remove functionCall and functionResponse parts (tool exchange noise that
   *   wastes tokens; the active loop requires them but old turns do not).
   *   Turns that become empty after stripping are removed entirely.
   *
   * The active loop starts at the last user turn containing a text part
   * (not a pure functionResponse turn).
   */
  private stripThoughtSignaturesFromOldHistory(): void {
    if (!this.client) return;
    const history = this.client.getChat().getHistory() as Array<{
      role: string;
      parts?: Array<Record<string, unknown>>;
    }>;
    if (history.length === 0) return;

    // Find active loop start: last user turn with a text part
    let activeLoopStart = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];
      if (
        turn.role === "user" &&
        turn.parts?.some((p) => typeof p["text"] === "string")
      ) {
        activeLoopStart = i;
        break;
      }
    }

    const cutoff = activeLoopStart === -1 ? history.length : activeLoopStart;
    let strippedSigs = 0;
    let strippedToolParts = 0;
    const indicesToRemove: number[] = [];

    for (let i = 0; i < cutoff; i++) {
      const turn = history[i];
      if (!turn.parts) continue;

      // Remove tool-related parts and thoughtSignature from remaining parts
      const kept: Array<Record<string, unknown>> = [];
      for (const part of turn.parts) {
        if ("functionCall" in part || "functionResponse" in part) {
          strippedToolParts++;
          continue;
        }
        if ("thoughtSignature" in part) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete part["thoughtSignature"];
          strippedSigs++;
        }
        kept.push(part);
      }

      if (kept.length === 0) {
        indicesToRemove.push(i);
      } else {
        turn.parts = kept;
      }
    }

    // Remove now-empty turns in reverse order to preserve indices
    for (let i = indicesToRemove.length - 1; i >= 0; i--) {
      history.splice(indicesToRemove[i], 1);
    }

    if (strippedSigs > 0 || strippedToolParts > 0) {
      debugLogger.debug(
        `[Jarvis] Old history stripped: ${strippedSigs} thoughtSignature(s), ${strippedToolParts} tool part(s), ${indicesToRemove.length} empty turn(s) removed (cutoff=${cutoff}).`,
      );
    }
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
    conversationHistory: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [],
  ) {
    // Strip thoughtSignature from historical turns to reduce token usage.
    // The active loop (turns after the last user text message) must keep
    // thoughtSignature for API validation; older turns have no such requirement.
    // ensureActiveLoopHasThoughtSignatures() in gemini-cli restores synthetic
    // signatures where needed, so stripping old ones is safe.
    this.stripThoughtSignaturesFromOldHistory();

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

    // Skill retrieval: search for relevant skills instead of injecting all.
    // Falls back to full list when index is unavailable or building (cold start,
    // no embedder, or backfill still in progress to avoid partial results).
    const skillSearchLimit = this.jarvisConfig.memory.skillSearchLimit ?? 5;
    const skillMaxDistance = this.jarvisConfig.memory.skillMaxDistance ?? 0.9;
    let relevantSkills: SkillInfo[] = this.availableSkills;
    if (this.availableSkills.length > skillSearchLimit) {
      // Don't use retrieval while the index is still being built — a partial
      // index would silently drop skills that haven't been embedded yet.
      if (this.memoryService.skillIndexBuilding) {
        console.error(
          `🔍 [SkillRetrieval] Index building — using full skill list (${this.availableSkills.length} skills)`,
        );
      } else {
        const retrieved = await this.memoryService.searchSkills(
          userPrompt,
          skillSearchLimit,
          skillMaxDistance,
        );
        if (retrieved.length > 0) {
          relevantSkills = retrieved;
          console.error(
            `🔍 [SkillRetrieval] ${retrieved.length}/${this.availableSkills.length} skills injected: ${retrieved.map((s) => s.name).join(", ")}`,
          );
        } else {
          // No skills met the relevance threshold — inject none.
          // Low-relevance skills add noise without value (e.g. "Hi Jarvis").
          relevantSkills = [];
          console.error(
            `🔍 [SkillRetrieval] No relevant skills found — skipping skill injection`,
          );
        }
      }
    }

    const protocol = this.promptBuilder.buildFromFacts(
      facts,
      userPrompt,
      relevantSkills,
    );
    // Use Jarvis slim preamble — GEMINI.md (userMemory) intentionally excluded
    // as it is Gemini CLI global config irrelevant to personal assistant use
    const defaultInstruction = buildJarvisPreamble();

    // vec_memories pre-warm: inject semantically similar past conversations
    // external: skip entirely (context adhesion risk)
    // mixed: conservative limit + stricter distance threshold
    // personal: full prewarmLimit + standard memoryMaxDistance
    const prewarmLimit = this.jarvisConfig.memory.prewarmLimit ?? 3;
    const prewarmLimitMixed = this.jarvisConfig.memory.prewarmLimitMixed ?? 1;
    const prewarmMaxDistanceMixed =
      this.jarvisConfig.memory.prewarmMaxDistanceMixed ?? 0.6;
    let prewarmSection = "";
    let prewarmedCount = 0;
    if (prewarmLimit > 0 && querySubject !== "external") {
      const effectiveLimit =
        querySubject === "mixed" ? prewarmLimitMixed : prewarmLimit;
      const effectiveMaxDistance =
        querySubject === "mixed"
          ? prewarmMaxDistanceMixed
          : (this.jarvisConfig.memory.memoryMaxDistance ?? 1.0);
      // Query rewriting: for personal queries, expand/de-reference the query
      // before vector search to improve retrieval accuracy.
      let searchQuery = userPrompt;
      const queryRewriteEnabled =
        this.jarvisConfig.routing?.queryRewrite === true;
      if (queryRewriteEnabled && !this.localModelRouter) {
        console.error(
          "⚠️ [prewarm] routing.queryRewrite=true but localModelRouter is not initialized — query rewrite skipped. Set routing.enabled=true and routing.model to enable.",
        );
      }
      if (
        queryRewriteEnabled &&
        querySubject === "personal" &&
        this.localModelRouter
      ) {
        const rewritten = await this.localModelRouter.rewriteMemoryQuery(
          userPrompt,
          conversationHistory,
        );
        if (rewritten) {
          searchQuery = rewritten;
          console.error(
            `🔍 [prewarm] query rewrite: "${userPrompt.slice(0, 80)}" → "${rewritten}"`,
          );
        }
      }

      const scoredMemories = await this.memoryService.searchWithScore(
        searchQuery,
        effectiveLimit,
        timeWindowDays,
        resolvedDateRange,
        effectiveMaxDistance,
      );

      // top-1 margin filter: skip injection when retrieval confidence is low
      const MIN_TOP1_SCORE = 0.5;
      const MIN_MARGIN = 0.1;
      let toInject = scoredMemories;
      if (scoredMemories.length > 0) {
        if (scoredMemories[0].score < MIN_TOP1_SCORE) {
          console.error(
            `🧠 [prewarm] top-1 score ${scoredMemories[0].score.toFixed(3)} < ${MIN_TOP1_SCORE}, skipping injection`,
          );
          toInject = [];
        } else if (
          scoredMemories.length > 1 &&
          scoredMemories[0].score - scoredMemories[1].score < MIN_MARGIN
        ) {
          // Low margin: only inject top-1
          toInject = scoredMemories.slice(0, 1);
          console.error(
            `🧠 [prewarm] low margin (${(scoredMemories[0].score - scoredMemories[1].score).toFixed(3)}), capping to top-1`,
          );
        }
      }

      if (toInject.length > 0) {
        prewarmedCount = toInject.length;
        const VERIFIED_THRESHOLD = 0.7;
        const verified = toInject.filter((m) => m.score >= VERIFIED_THRESHOLD);
        const uncertain = toInject.filter((m) => m.score < VERIFIED_THRESHOLD);
        let memoryContent = "";
        let memoryIndex = 1;
        if (verified.length > 0) {
          memoryContent +=
            "<verified_memories>\n" +
            verified
              .map((m) => `[Memory ${memoryIndex++}]: ${m.text}`)
              .join("\n") +
            "\n</verified_memories>";
        }
        if (uncertain.length > 0) {
          memoryContent +=
            (memoryContent ? "\n" : "") +
            "<possibly_relevant_memories>\n" +
            "(Low confidence — treat as hints only, not facts. Use only if directly matching the question.)\n" +
            uncertain
              .map((m) => `[Memory ${memoryIndex++}]: ${m.text}`)
              .join("\n") +
            "\n</possibly_relevant_memories>";
        }
        prewarmSection =
          "\n<relevant_past_conversations>\n" +
          memoryContent +
          "\n</relevant_past_conversations>";
        console.error(
          `🧠 [prewarm] subject=${querySubject}, limit=${effectiveLimit}, maxDist=${effectiveMaxDistance}, injected=${toInject.length}:\n` +
            toInject
              .map(
                (m, i) =>
                  `  [${i + 1}] score=${m.score.toFixed(3)} ${m.text.slice(0, 100)}`,
              )
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
      `🔄 [Jarvis] System Prompt Refreshed (subject=${querySubject}). Facts injected: ${facts.length}. Prewarmed memories: ${prewarmLimit > 0 ? prewarmedCount : "disabled"}.`,
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
    // Incrementally update the skill vector index (non-blocking)
    void this.memoryService.backfillSkillIndex(skills);
  }

  public setSkillCommandHandler(handler: SkillCommandHandler): void {
    this.skillCommandHandler = handler;
  }

  public setAgentManager(manager: AgentManager): void {
    this.agentManager = manager;
  }

  public setBackgroundTaskRunner(runner: BackgroundTaskRunner): void {
    this.backgroundTaskRunner = runner;
  }

  public async processMessage(
    userPrompt: string,
    imageAttachment?: { data: Buffer; mimeType: string },
  ) {
    // Intercept !clear — compress current history into summary, drop all raw turns
    if (userPrompt.trim() === "!clear") {
      await this.initialize();
      const history = this.client?.getChat().getHistory() ?? [];
      if (history.length === 0) {
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value: "✅ 对话历史已清空。",
        });
      } else if (!this.summarizerGenerateText) {
        // No summarizer — just wipe history entirely
        this.client.getChat().setHistory([]);
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value: `✅ 已清空 ${Math.floor(history.length / 2)} 轮对话历史。`,
        });
      } else {
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value: `⏳ 正在压缩 ${Math.floor(history.length / 2)} 轮对话历史，请稍候...`,
        });
        try {
          const messages: SessionMessage[] = history
            .map((turn) => {
              const text =
                turn.parts?.map((p: any) => p.text ?? "").join("") ?? "";
              if (!text.trim()) return null;
              return {
                type: turn.role === "user" ? "user" : "gemini",
                content: text,
              } as SessionMessage;
            })
            .filter((m): m is SessionMessage => m !== null);

          const summary = await buildIncrementalSummary(
            messages,
            null,
            this.summarizerGenerateText,
            { maxRetries: 2, retryDelayMs: 1000 },
          );

          if (summary.trim()) {
            // Keep summary as context, no raw turns
            this.client
              .getChat()
              .setHistory(buildHistoryWithSummary(summary, []));
          } else {
            this.client.getChat().setHistory([]);
          }
          this.emit(JarvisEventType.CONTENT, {
            type: "content",
            value: `✅ 已将 ${Math.floor(history.length / 2)} 轮对话压缩为摘要，上下文已重置。`,
          });
        } catch (e: any) {
          this.client.getChat().setHistory([]);
          this.emit(JarvisEventType.CONTENT, {
            type: "content",
            value: `✅ 已清空对话历史（摘要生成失败: ${e.message}）。`,
          });
        }
      }
      this.emit(JarvisEventType.DONE);
      return;
    }

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

    // ── Background task intercept ─────────────────────────────────────────
    // Prefix "后台:", "background:", "async:", "bg:" → run in isolation,
    // return confirmation immediately, push result when done.
    if (this.backgroundTaskRunner) {
      const bgPrompt = extractBackgroundPrompt(userPrompt);
      if (bgPrompt === null) {
        // No background trigger — fall through to normal LLM path
      } else if (bgPrompt === "") {
        // Trigger present but no task specified
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value:
            '请在"后台:"后面输入任务内容，例如：`后台: 调研NVDA的竞争对手`',
        });
        this.emit(JarvisEventType.DONE, "");
        return;
      } else {
        const bgTask = this.backgroundTaskRunner.run(bgPrompt, this.sessionId);
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value:
            `🔀 **后台任务已启动** (ID: \`${bgTask.taskId.slice(0, 8)}\`)\n\n` +
            `任务：${bgPrompt.slice(0, 100)}${bgPrompt.length > 100 ? "..." : ""}\n\n` +
            `完成后会自动通知你，现在可以继续对话。`,
        });
        this.emit(JarvisEventType.DONE, "");
        return;
      }
    }
    // ── End background task intercept ─────────────────────────────────────

    if (this.isProcessing) {
      throw new Error("Mission in progress.");
    }

    await this.initialize();

    // 🚀 NEW: EXPLICIT AGENT DISPATCHING (Local Routing)
    // If the prompt starts with "agent:", we bypass the main LLM path entirely.
    if (userPrompt.trimStart().toLowerCase().startsWith("agent:")) {
      if (!this.agentManager || !this.localModelRouter) {
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value:
            "❌ Agent 路由未启用。请在 config.json 中配置 `routing.enabled: true` 并设置 Ollama 模型。",
        });
        this.emit(JarvisEventType.DONE, "");
        return;
      }
      const rawPrompt = userPrompt.trimStart().slice("agent:".length).trim();
      console.error(
        `🤖 [Jarvis] Explicit agent request detected: "${rawPrompt}"`,
      );

      const route = await this.localModelRouter.routeAgentCall(
        rawPrompt,
        this.agentManager.getRegistry(),
      );

      if (route && route.agentId) {
        const card = this.agentManager.getCard(route.agentId);
        if (card) {
          console.error(
            `🤖 [Jarvis] Local router selected agent: ${route.agentId}`,
          );
          this.emit(JarvisEventType.CONTENT, {
            type: "content",
            value: `🤖 已通过本地路由启动 **${card.name}**，正在分析您的请求...`,
          });
          this.emit(JarvisEventType.DONE, "");
          try {
            this.agentManager.createTask(
              route.agentId,
              this.sessionId,
              route.input,
            );
          } catch (e: any) {
            console.error(`⚠️ [Jarvis] createTask failed: ${e.message}`);
          }
          return;
        }
      }

      // Local routing failed or agent not found
      this.emit(JarvisEventType.CONTENT, {
        type: "content",
        value: "❌ 无法识别指定的 Agent 或参数提取失败。请确保 Agent 已加载。",
      });
      this.emit(JarvisEventType.DONE, "");
      return;
    }

    this.isProcessing = true;

    try {
      const pId = `jarvis-${this.sessionId}-${Date.now()}`;

      await promptIdContext.run(pId, async () => {
        // Local model routing: classify complexity + query subject, set model
        let querySubject: "personal" | "external" | "mixed" = "mixed";
        let timeWindowDays: number | null = null;
        let resolvedDateRange: { from: number; to: number } | null = null;
        let conversationHistory: Array<{
          role: "user" | "assistant";
          content: string;
        }> = [];
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
          conversationHistory = history;
          const result = await this.localModelRouter.route(userPrompt, history);
          // Use setActiveModel (not setModel) to avoid broadcasting on the
          // global coreEvents singleton, which would disrupt all live
          // GeminiClient instances including concurrent bg agents.
          this.client.config.setActiveModel(result.model);
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

        await this.refreshContext(
          userPrompt,
          querySubject,
          timeWindowDays,
          resolvedDateRange,
          conversationHistory,
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
          if (this.distiller) {
            void this.distiller.distill(userPrompt, finalAssistantText);
          }

          if (!this.lightweight) {
            // Trigger session events extraction every N turns (async, non-blocking)
            const interval =
              this.jarvisConfig.memory.eventsExtractionInterval ?? 20;
            if (interval > 0 && ++this.conversationTurnCount % interval === 0) {
              setImmediate(
                () => void this.memoryService.backfillSessionEvents(),
              );
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

  /**
   * Releases resources held by this agent.
   * Calls Config.dispose() which deregisters listeners on the global coreEvents
   * singleton (model-changed, agents-refreshed, etc.) so the agent and its
   * GeminiClient / Config can be garbage-collected.
   * Must be called for ephemeral agents (e.g. background task agents) to
   * prevent coreEvents from accumulating stale listeners.
   */
  public async dispose(): Promise<void> {
    if (this.client?.config) {
      await this.client.config.dispose();
    }
    this.removeAllListeners();
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
