/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "node:events";
import {
  GeminiClient,
  debugLogger,
  Scheduler,
  promptIdContext,
  LlmRole,
  ToolConfirmationOutcome,
} from "../../../gemini-cli/packages/core/src/index.js";
import { MessageBusType } from "../../../gemini-cli/packages/core/src/confirmation-bus/types.js";

import { JarvisEventType, type JarvisAgentOptions } from "./types.js";
import { type MemoryService } from "./memory.js";
import { DynamicToolRegistry } from "./dynamicToolRegistry.js";
import { SystemPromptBuilder, type SkillInfo } from "./systemPromptBuilder.js";
import { BackgroundDistiller } from "./backgroundDistiller.js";
import { ToolRouter, type AskUserQuestion } from "./toolRouter.js";
import { AgentInitializer } from "./geminiAgentInitializer.js";
import { type TaskCommandHandler } from "./taskCommandHandler.js";
import { type SkillCommandHandler } from "./skillCommandHandler.js";
import { isFetchError, cleanOrphanedUserTurn } from "./agentNetworkUtils.js";
import { ConfigManager } from "./configManager.js";
import { type ChannelRegistry } from "./channelRegistry.js";
import {
  buildIncrementalSummary,
  buildHistoryWithSummary,
  buildRelevantSummarySectionFallback,
  type SessionMessage,
} from "./sessionSummarizer.js";
import { MemoryInjectionPlanner } from "./memoryInjectionPlanner.js";
import { buildHistoryFromMessages } from "./resumeFromDisk.js";
import { LocalModelRouter } from "./localModelRouter.js";
import type { IntentFrame } from "./intentResolver.js";
import { IntentStepRuntime } from "./intentExecutionPlan.js";
import { buildStepMemoryDecisions } from "./intentAwareMemoryPolicy.js";
import {
  applyClarificationAnswers,
  applyClarificationChannelState,
  buildClarificationDecision,
  buildClarificationRuntimeState,
  buildClarificationTrace,
  buildClarifiedPrompt,
  filterClarificationDecisionByState,
  formatClarificationQuestions,
  type ClarificationDecision,
  type ClarificationRuntimeState,
} from "./clarificationPolicy.js";
import { type AgentManager } from "./agentManager.js";
import {
  extractBackgroundPrompt,
  type BackgroundTaskRunner,
} from "./backgroundTaskRunner.js";
import { RuntimeIntentFeedbackCollector } from "./runtimeIntentFeedbackCollector.js";
import {
  type MemoryContract,
  type SessionMemory,
} from "../memory-runtime/index.js";
import { type ToolLoopRuntimeOptions } from "../agent-runtime/index.js";
import {
  geminiPartsToLlmMessages,
  setGeminiChatHistory,
} from "./geminiBackendAdapter.js";
import { createJarvisToolLoopOptions } from "./geminiRuntimeAdapter.js";
import {
  runJarvisUnifiedRuntimeTurn,
  type JarvisUnifiedRuntimeTurnResult,
} from "./jarvisUnifiedRuntime.js";
import { createGeminiToolInteractionRecorder } from "./geminiToolInteractionRecorder.js";
import { WorkspaceTools } from "./workspaceTools.js";
import { JarvisNativeSkillRuntime } from "./skillRuntime.js";
import type {
  RuntimeContentPart,
  RuntimeConversationContent,
} from "./runtimeTypes.js";

function shouldIsolateTimeScopedConversationRecall(
  intent: IntentFrame | null,
  resolvedDateRange: { from: number; to: number } | null,
  timeWindowDays: number | null,
): boolean {
  if (!intent) return false;
  return (
    intent.taskType === "recall" &&
    intent.semanticEvidence.memoryRecall.target === "conversation_history" &&
    !intent.referencesRecentHistory &&
    Boolean(
      resolvedDateRange ||
        intent.resolvedDateRange ||
        intent.dateFrom ||
        intent.dateTo ||
        typeof timeWindowDays === "number" ||
        typeof intent.timeWindowDays === "number",
    )
  );
}

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
  private runtimeIntentFeedbackCollector = new RuntimeIntentFeedbackCollector(
    this.jarvisConfig.intentFeedback,
  );
  private clarificationRuntimeState: ClarificationRuntimeState | null = null;
  private conversationTurnCount = 0;
  private summarizerGenerateText: ((prompt: string) => Promise<string>) | null =
    null;
  private lightweight: boolean;
  private readonly cwd: string;
  private conversationSummary = "";
  private pendingAskUsers = new Map<
    string,
    {
      ownerId: string;
      resolve: (answers: Record<string, string>) => void;
      reject: (e: Error) => void;
    }
  >();
  // Stored so setAskUserHandler called before initialize() still takes effect
  // once toolRouter is created inside initialize().
  private pendingAskUserWs: {
    ws: { readyState: number; send: (data: string) => void };
    ownerId: string;
  } | null = null;

  constructor(options: JarvisAgentOptions) {
    super();
    this.sessionId = options.sessionId;
    this.memoryService = options.memoryService;
    this.lightweight = options.lightweight ?? false;
    this.cwd = options.cwd;
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
    this.conversationSummary = this.agentInitializer.getConversationSummary();
    if (this.conversationSummary.trim()) {
      void this.memoryService.backfillSummaryChunkIndex(
        this.sessionId,
        this.conversationSummary,
      );
    }

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

    // Embedding must be available before any tool/background path can save facts.
    await this.memoryService.initializeEmbedding({
      lightweight: this.lightweight,
    });

    if (!this.lightweight) {
      // Route distillation through reflection.provider so local Ollama models
      // can be used for fact extraction. Falls back to Gemini if reflection.model
      // is not set or provider is "gemini".
      const distillGenerateText =
        this.memoryService.buildReflectionGenerateText(generateText);

      this.distiller = new BackgroundDistiller(
        distillGenerateText,
        async (category, content, importance) => {
          await this.memoryService.saveFactToRuntime(
            category,
            content,
            importance,
            "background_distiller",
          );
        },
      );

      // setGenerateText triggers EntityExtractor initialization inside MemoryService
      this.memoryService.setGenerateText(generateText);
    }

    this.toolRouter = new ToolRouter(
      this.memoryService,
      this.dynamicRegistry,
      this.scheduler,
      this.client,
      this.taskCommandHandler,
      this.channelRegistry,
      createGeminiToolInteractionRecorder(),
      undefined,
      new WorkspaceTools({
        root: this.cwd,
        allowNetworkFetchCommands:
          this.jarvisConfig.security?.shell?.allowNetworkFetchCommands,
        networkFetchCommands:
          this.jarvisConfig.security?.shell?.networkFetchCommands,
      }),
      new JarvisNativeSkillRuntime({ cwd: this.cwd }),
    );
    // If setAskUserHandler was called before initialize(), apply it now.
    if (this.pendingAskUserWs !== null) {
      this._applyAskUserWs(this.pendingAskUserWs);
    }

    // Initialize local model router if configured.
    const routingCfg = this.jarvisConfig.routing;
    if (routingCfg?.enabled && routingCfg.model) {
      this.localModelRouter = new LocalModelRouter(
        this.jarvisConfig.ollama?.baseUrl ?? "http://localhost:11434",
        routingCfg.model,
        routingCfg.threshold ?? 70,
        routingCfg.targets?.pro ?? routingCfg.proModel ?? "gemini-2.5-pro",
        routingCfg.targets?.flash ??
          routingCfg.flashModel ??
          "gemini-2.5-flash",
        routingCfg.timeoutMs ??
          this.jarvisConfig.ollama?.defaultTimeoutMs ??
          30_000,
        routingCfg.historyTurns ?? 5,
        routingCfg.intentPolicyObservability === true,
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

    // If the turn just before the active loop is a tool-only model turn, its
    // paired functionResponse sits at activeLoopStart (the preserved boundary).
    // Stripping the functionCall without also removing the functionResponse
    // would orphan it and cause a 400. Extend the cutoff one step earlier in
    // that case to leave the pair intact.
    let cutoff = activeLoopStart === -1 ? history.length : activeLoopStart;
    if (cutoff > 0 && cutoff < history.length) {
      const turnBeforeCutoff = history[cutoff - 1];
      const isToolOnly =
        turnBeforeCutoff.parts?.length > 0 &&
        turnBeforeCutoff.parts.every(
          (p) => "functionCall" in p || "functionResponse" in p,
        );
      if (isToolOnly) cutoff -= 1;
    }

    let strippedSigs = 0;
    let strippedToolParts = 0;
    const newHistory: Array<{
      role: string;
      parts?: Array<Record<string, unknown>>;
    }> = [];

    for (let i = 0; i < history.length; i++) {
      const turn = history[i];
      if (i >= cutoff) {
        // Active loop — keep as-is
        newHistory.push(turn);
        continue;
      }

      if (!turn.parts) {
        newHistory.push(turn);
        continue;
      }

      // Remove tool-related parts; strip thoughtSignature from remaining parts
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

      if (kept.length > 0) {
        turn.parts = kept;
        newHistory.push(turn);
        // else: turn is empty after stripping — drop it entirely
      }
    }

    const removedTurns = history.length - newHistory.length;
    if (removedTurns > 0) {
      // Use setHistory to commit the filtered array back into gemini-cli's state
      setGeminiChatHistory(
        this.client.getChat(),
        newHistory as RuntimeConversationContent[],
      );
    }

    if (strippedSigs > 0 || strippedToolParts > 0 || removedTurns > 0) {
      debugLogger.debug(
        `[Jarvis] Old history stripped: ${strippedSigs} thoughtSignature(s), ${strippedToolParts} tool part(s), ${removedTurns} empty turn(s) removed (cutoff=${cutoff}).`,
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

      const newSummary = await buildIncrementalSummary(
        messages,
        this.conversationSummary || null,
        this.summarizerGenerateText,
        { maxRetries: 2, retryDelayMs: 1000 },
      );

      if (!newSummary.trim()) return;

      const recentMessages = toKeep
        .map((turn) => ({
          type: turn.role === "user" ? "user" : "gemini",
          content: turn.parts?.map((p: any) => p.text ?? "").join("") ?? "",
        }))
        .filter((m) => m.content.trim()) as SessionMessage[];

      // Rebuild history with only recent raw turns; summary is held separately
      const compressedHistory = buildHistoryFromMessages(recentMessages);

      this.conversationSummary = newSummary;
      void this.memoryService.backfillSummaryChunkIndex(
        this.sessionId,
        this.conversationSummary,
      );
      this.client.getChat().setHistory(compressedHistory);
      console.error(
        `🗜️ [Jarvis] History compressed: ${turnCount} turns → ${keepRecent} recent turns, summary retained separately.`,
      );
    } catch (e: any) {
      console.error(`⚠️ [Jarvis] History compression failed: ${e.message}`);
    }
  }

  private async runUnifiedRuntimeTurn(
    userPrompt: string,
    querySubject: "personal" | "external" | "mixed" = "mixed",
    timeWindowDays: number | null = null,
    resolvedDateRange: { from: number; to: number } | null = null,
    conversationHistory: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [],
    intent: IntentFrame | null = null,
    llmRuntime?: {
      options: ToolLoopRuntimeOptions;
      initialMessages: ReturnType<typeof geminiPartsToLlmMessages>;
      signal: AbortSignal;
    },
  ): Promise<JarvisUnifiedRuntimeTurnResult> {
    // Strip thoughtSignature from historical turns to reduce token usage.
    // The active loop (turns after the last user text message) must keep
    // thoughtSignature for API validation; older turns have no such requirement.
    // ensureActiveLoopHasThoughtSignatures() in gemini-cli restores synthetic
    // signatures where needed, so stripping old ones is safe.
    this.stripThoughtSignaturesFromOldHistory();

    const runtimeTurn = await runJarvisUnifiedRuntimeTurn({
      sessionId: this.sessionId,
      userPrompt,
      querySubject,
      timeWindowDays,
      resolvedDateRange,
      conversationHistory,
      intent,
      llmRuntime,
      jarvisConfig: this.jarvisConfig,
      memoryService: this.memoryService,
      availableSkills: this.availableSkills,
      conversationSummary: this.conversationSummary,
      localModelRouter: this.localModelRouter,
      promptBuilder: this.promptBuilder,
      toolRouter: this.toolRouter,
      runtimeIntentFeedbackCollector: this.runtimeIntentFeedbackCollector,
      interactiveChannel: this.pendingAskUserWs?.ws.readyState === 1,
      buildMemoryInjectionPlanner: () => this.buildMemoryInjectionPlanner(),
    });

    this.client.getChat().setSystemInstruction(runtimeTurn.systemInstruction);
    return runtimeTurn;
  }

  private buildMemoryInjectionPlanner(): MemoryInjectionPlanner {
    const memory = this.jarvisConfig.memory;
    return new MemoryInjectionPlanner({
      maxTotalChars: memory.injectionMaxTotalChars,
      maxFactChars: memory.injectionMaxFactChars,
      maxSummaryChars: memory.injectionMaxSummaryChars,
      maxPrewarmChars: memory.injectionMaxPrewarmChars,
      maxFactItemChars: memory.injectionMaxFactItemChars,
      maxSummaryItemChars: memory.injectionMaxSummaryItemChars,
      maxPrewarmItemChars: memory.injectionMaxPrewarmItemChars,
      maxFactItemsPersonal: memory.injectionMaxFactItemsPersonal,
      maxFactItemsMixed: memory.injectionMaxFactItemsMixed,
    });
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
        createGeminiToolInteractionRecorder(),
        undefined,
        new WorkspaceTools({
          root: this.cwd,
          allowNetworkFetchCommands:
            this.jarvisConfig.security?.shell?.allowNetworkFetchCommands,
          networkFetchCommands:
            this.jarvisConfig.security?.shell?.networkFetchCommands,
        }),
        new JarvisNativeSkillRuntime({ cwd: this.cwd }),
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
    options: { executionContext?: "interactive" | "proactive_task" } = {},
  ) {
    // Intercept !clear — compress current history into summary, drop all raw turns
    if (userPrompt.trim() === "!clear") {
      if (this.isProcessing) {
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value: "⚠️ 任务进行中，请等待完成后再清空历史。",
        });
        this.emit(JarvisEventType.DONE);
        return;
      }
      await this.initialize();
      const history = this.client?.getChat().getHistory() ?? [];
      if (history.length === 0) {
        this.conversationTurnCount = Math.max(1, this.conversationTurnCount);
        this.emit(JarvisEventType.CONTENT, {
          type: "content",
          value: "✅ 对话历史已清空。",
        });
      } else if (!this.summarizerGenerateText) {
        // No summarizer — just wipe history entirely
        this.client.getChat().setHistory([]);
        this.conversationSummary = "";
        this.conversationTurnCount = Math.max(1, this.conversationTurnCount);
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
            // Persist summary in agent state so prewarm/searchSummaryChunks
            // can use it, and so it survives the first-message history-clear
            // guard on the next turn.
            this.conversationSummary = summary;
          } else {
            this.client.getChat().setHistory([]);
            this.conversationSummary = "";
          }
          // Advance turn count so the next real message does not trigger the
          // first-message history-clear logic (conversationTurnCount === 0).
          this.conversationTurnCount = Math.max(1, this.conversationTurnCount);
          this.emit(JarvisEventType.CONTENT, {
            type: "content",
            value: `✅ 已将 ${Math.floor(history.length / 2)} 轮对话压缩为摘要，上下文已重置。`,
          });
        } catch (e: any) {
          this.client.getChat().setHistory([]);
          this.conversationSummary = "";
          this.conversationTurnCount = Math.max(1, this.conversationTurnCount);
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

    // On the first message of a new session, drop any restored history so the
    // LLM starts with a clean context. Prior conversations are already
    // captured in long-term memory via backfillSessionEvents, so the raw
    // history adds noise rather than value.
    if (this.conversationTurnCount === 0 && this.client) {
      const historyLen = this.client.getChat().getHistory().length;
      if (historyLen > 0) {
        this.client.getChat().setHistory([]);
        console.error(
          `🧹 [Jarvis] First message of session — cleared ${Math.floor(historyLen / 2)} restored turn(s) from history.`,
        );
      }
    }

    try {
      const pId = `jarvis-${this.sessionId}-${Date.now()}`;

      await promptIdContext.run(pId, async () => {
        // Always set current user prompt so recall_memory empty-query fallback
        // works regardless of whether local routing is enabled.
        this.toolRouter.setCurrentUserPrompt(userPrompt);

        // Local model routing: classify complexity + query subject, set model
        let querySubject: "personal" | "external" | "mixed" = "mixed";
        let timeWindowDays: number | null = null;
        let resolvedDateRange: { from: number; to: number } | null = null;
        let intentFrame: IntentFrame | null = null;
        let isolatedChatHistorySnapshot: any[] | null = null;
        let conversationHistory: Array<{
          role: "user" | "assistant";
          content: string;
        }> = [];
        // Declared here so the restore after the if-block can reference it.
        let originalGetModel: (() => string) | null = null;
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
          let result = await this.localModelRouter.route(userPrompt, history);
          // Use setActiveModel (not setModel) to avoid broadcasting on the
          // global coreEvents singleton, which would disrupt all live
          // GeminiClient instances including concurrent bg agents.
          this.client.config.setActiveModel(result.model);

          // 🛡️ Patch getModel() for this turn so that resolvePolicyChain()
          // (called inside applyModelSelection) sees the Jarvis-chosen model
          // rather than the base config model. This prevents Gemini-3 model
          // names from being hijacked by the auto policy chain.
          // Stored as a closure-local variable — no cross-turn state on `this`.
          originalGetModel = this.client.config.getModel.bind(
            this.client.config,
          );
          this.client.config.getModel = () => result.model;

          querySubject = result.querySubject;
          intentFrame = result.intent;
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
            `🔀 [Jarvis] Local routing: ${result.decision} | subject=${result.querySubject} | topic_shifted=${result.topicShifted} | time_window=${twLabel} | reason="${result.classifierReason}" (source=${result.source})`,
          );

          const clarificationInput = {
            userPrompt,
            intent: intentFrame,
            querySubject,
            candidateAgents: intentFrame?.candidateAgents ?? [],
            recentHistoryLength: conversationHistory.length,
            executionContext: options.executionContext ?? "interactive",
          };
          const clarification = applyClarificationChannelState(
            filterClarificationDecisionByState(
              buildClarificationDecision(clarificationInput),
              this.clarificationRuntimeState,
            ),
            this.pendingAskUserWs?.ws.readyState === 1,
          );
          this.clarificationRuntimeState = buildClarificationRuntimeState(
            clarification,
            this.clarificationRuntimeState,
          );
          this.runtimeIntentFeedbackCollector.record({
            sessionId: this.sessionId,
            userPrompt,
            history,
            intent: intentFrame,
            clarification,
            routing: {
              source: result.source,
              model: result.model,
              score: result.score,
              decision: result.decision,
              classifierReason: result.classifierReason,
            },
            executionContext: options.executionContext ?? "interactive",
          });
          if (this.jarvisConfig.routing?.clarificationObservability === true) {
            console.error(
              `[clarification] ${JSON.stringify(buildClarificationTrace(clarificationInput, clarification))}`,
            );
          }
          if (clarification.shouldAsk && clarification.blocking) {
            console.error(
              `❓ [Jarvis] Clarification required: ${clarification.reasons.join(",")}`,
            );
            const answers =
              await this.requestClarificationOrEmitFallback(clarification);
            if (answers === null) {
              if (originalGetModel) {
                this.client.config.getModel = originalGetModel;
              }
              return;
            }
            this.clarificationRuntimeState = applyClarificationAnswers(
              this.clarificationRuntimeState,
              clarification,
              answers,
            );
            userPrompt = buildClarifiedPrompt(
              userPrompt,
              clarification,
              answers,
            );
            this.toolRouter.setCurrentUserPrompt(userPrompt);

            result = await this.localModelRouter.route(userPrompt, history);
            this.client.config.setActiveModel(result.model);
            querySubject = result.querySubject;
            intentFrame = result.intent;
            timeWindowDays = result.timeWindowDays;
            resolvedDateRange = result.resolvedDateRange ?? null;
            this.toolRouter.setCurrentTimeWindow(timeWindowDays);
            this.toolRouter.setCurrentDateRange(
              resolvedDateRange,
              result.dateFrom,
              result.dateTo,
            );
            console.error(
              `🔀 [Jarvis] Re-routed after clarification: ${result.decision} | subject=${result.querySubject} | topic_shifted=${result.topicShifted} | reason="${result.classifierReason}" (source=${result.source})`,
            );
          } else if (!clarification.blocking) {
            this.clarificationRuntimeState = null;
          }

          // Topic shift detected: clear history so LLM starts fresh on new topic.
          // Guard: skip on first turn (already cleared at session start) and when disabled.
          if (
            result.topicShifted &&
            this.conversationTurnCount > 0 &&
            this.jarvisConfig.routing?.topicShiftDetection !== false
          ) {
            const historyLen = this.client.getChat().getHistory().length;
            if (historyLen > 0) {
              this.client.getChat().setHistory([]);
              console.error(
                `🔄 [Jarvis] Topic shift detected — cleared ${Math.floor(historyLen / 2)} turn(s) from history.`,
              );
            }
          }
          if (
            shouldIsolateTimeScopedConversationRecall(
              intentFrame,
              resolvedDateRange,
              timeWindowDays,
            )
          ) {
            const chat = this.client.getChat();
            const history = chat.getHistory();
            if (history.length > 0) {
              isolatedChatHistorySnapshot = [...history];
              chat.setHistory([]);
              conversationHistory = [];
              console.error(
                `🧹 [Jarvis] Time-scoped conversation recall — isolated ${Math.floor(history.length / 2)} recent turn(s) from response context.`,
              );
            }
          }
        }

        const abortController = new AbortController();
        const currentQueryParts: RuntimeContentPart[] = [{ text: userPrompt }];
        if (imageAttachment) {
          currentQueryParts.push({
            inlineData: {
              mimeType: imageAttachment.mimeType,
              data: imageAttachment.data.toString("base64"),
            },
          });
        }

        const stepRuntime = new IntentStepRuntime(intentFrame);
        if (stepRuntime.active) {
          console.error(
            `🧭 [Jarvis] Multi-intent runtime initialized: ${stepRuntime
              .snapshot()
              .map((entry) => `${entry.step.id}:${entry.status}`)
              .join(", ")}`,
          );
        }

        const networkConfig = this.jarvisConfig.network;
        const maxRetries = networkConfig?.maxRetries ?? 3;
        const cleanOnFailure =
          networkConfig?.cleanOrphanedTurnOnFailure ?? true;
        const runtimeTurn = await this.runUnifiedRuntimeTurn(
          userPrompt,
          querySubject,
          timeWindowDays,
          resolvedDateRange,
          conversationHistory,
          intentFrame,
          {
            options: createJarvisToolLoopOptions({
              config: this.jarvisConfig,
              client: this.client,
              promptId: pId,
              toolRouter: this.toolRouter,
              stepRuntime,
              maxRetries,
              cleanOnFailure,
              isRetryableError: isFetchError,
              cleanOrphanedTurn: () => {
                try {
                  const chat = this.client.getChat();
                  const history = [...chat.getHistory()];
                  const cleaned = cleanOrphanedUserTurn(history);
                  if (cleaned.length < history.length) {
                    chat.setHistory(cleaned);
                    console.error(
                      `🧹 [JarvisAgent] Cleaned orphaned user turn from history.`,
                    );
                  }
                } catch (_cleanErr) {}
              },
              emitToolCallResponse: (resp) =>
                this.emit(JarvisEventType.TOOL_CALL_RESPONSE, resp),
              emitContent: (event) => this.emit(JarvisEventType.CONTENT, event),
            }),
            initialMessages: geminiPartsToLlmMessages(currentQueryParts),
            signal: abortController.signal,
          },
        );
        const memoryContract = runtimeTurn.memoryContract;
        this.toolRouter.setCurrentMemoryContract(memoryContract);
        this.toolRouter.setCurrentStepMemoryDecisions(
          buildStepMemoryDecisions({
            intent: intentFrame,
            contract: memoryContract,
          }),
        );

        // Restore getModel() after the unified runtime turn — it reads config
        // state during retrieval and the backend loop must see the selected
        // Jarvis model for this turn.
        if (originalGetModel) {
          this.client.config.getModel = originalGetModel;
        }

        const loopResult = runtimeTurn.llmLoop;
        if (!loopResult) {
          throw new Error("Unified AgentRuntime did not execute the LLM loop");
        }
        const finalAssistantText = loopResult.finalText;
        const allToolsCalled = loopResult.toolsCalled;
        if (isolatedChatHistorySnapshot) {
          try {
            const chat = this.client.getChat();
            const isolatedTurnHistory = chat.getHistory();
            chat.setHistory([
              ...isolatedChatHistorySnapshot,
              ...isolatedTurnHistory,
            ]);
            console.error(
              `🧹 [Jarvis] Restored ${Math.floor(isolatedChatHistorySnapshot.length / 2)} prior turn(s) after time-scoped recall.`,
            );
          } catch (_restoreErr) {}
        }
        try {
          const backendProvider =
            this.jarvisConfig.llmBackend?.provider ?? "gemini";
          const model =
            typeof this.client.config.getModel === "function"
              ? this.client.config.getModel()
              : undefined;
          const timestamp = new Date().toISOString();
          const session: SessionMemory = {
            scope: "session",
            sessionId: this.sessionId,
            turns: [
              {
                role: "user",
                content: userPrompt,
                timestamp,
                metadata: {
                  backend: backendProvider,
                  model,
                  source: "jarvis-main-response",
                },
              },
              {
                role: "assistant",
                content: finalAssistantText,
                timestamp: new Date().toISOString(),
                metadata: {
                  backend: backendProvider,
                  model,
                  source: "jarvis-main-response",
                  toolsCalled: [...allToolsCalled],
                },
              },
            ],
          };
          await this.memoryService
            .getRuntimeSqliteMemoryStore()
            .upsertSession(session);
        } catch (error: any) {
          console.error(
            `⚠️ [SessionStore] Failed to append transcript turn: ${error?.message ?? String(error)}`,
          );
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

  /** Clear the ask_user handler only if it was registered by this owner.
   *  Prevents a closing tab from clearing another tab's active handler. */
  public clearAskUserHandlerIfOwner(ownerId: string): void {
    if (this.pendingAskUserWs?.ownerId === ownerId) {
      this.pendingAskUserWs = null;
      if (this.toolRouter) {
        this.toolRouter.setAskUserHandler(null);
      }
    }
  }

  /** Reject pending ask_user requests owned by the given connection.
   *  Other connections' pending entries are left untouched. */
  public rejectPendingAskUsersForOwner(
    ownerId: string,
    reason = "WebSocket disconnected",
  ): void {
    for (const [id, entry] of this.pendingAskUsers) {
      if (entry.ownerId === ownerId) {
        this.pendingAskUsers.delete(id);
        entry.reject(new Error(reason));
      }
    }
  }

  /** Deliver user's ask_user answers back to the pending handler.
   *  Pass cancelled=true when the user dismisses the form without answering. */
  public provideAskUserResponse(
    id: string,
    answers: Record<string, string>,
    cancelled = false,
  ): void {
    const entry = this.pendingAskUsers.get(id);
    if (entry) {
      this.pendingAskUsers.delete(id);
      if (cancelled) {
        entry.reject(new Error("user cancelled"));
      } else {
        entry.resolve(answers);
      }
    }
  }

  private async requestClarificationOrEmitFallback(
    decision: ClarificationDecision,
  ): Promise<Record<string, string> | null> {
    const entry = this.pendingAskUserWs;
    if (!entry || entry.ws.readyState !== 1 /* OPEN */) {
      this.emit(JarvisEventType.CONTENT, {
        type: "content",
        value: formatClarificationQuestions(decision),
      });
      return null;
    }

    const { ws, ownerId } = entry;
    return new Promise<Record<string, string>>((resolve, reject) => {
      const id = `clarify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pendingAskUsers.delete(id);
        reject(new Error("user did not respond within 300s"));
      }, 300_000);

      const cleanup = () => clearTimeout(timer);
      this.pendingAskUsers.set(id, {
        ownerId,
        resolve: (answers) => {
          cleanup();
          resolve(answers);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });

      if (ws.readyState !== 1 /* OPEN */) {
        this.pendingAskUsers.delete(id);
        cleanup();
        reject(new Error("WebSocket closed"));
        return;
      }

      this.emit(JarvisEventType.CONTENT, {
        type: "ask_user_request",
        value: { id, questions: decision.questions },
      });
    }).catch((e) => {
      console.error(`⚠️ [Jarvis] Clarification cancelled: ${e.message}`);
      this.emit(JarvisEventType.CONTENT, {
        type: "content",
        value: "已取消本次操作。",
      });
      return null;
    });
  }

  /**
   * Bind a WebSocket connection to the ask_user flow for this agent.
   * When the LLM calls ask_user, an ask_user_request event is emitted so
   * the UI can display a form. The handler waits up to 300s for a response
   * before timing out with a cancelled payload.
   * Safe to call before initialize() — the ws is stored and applied once
   * toolRouter is created.
   */
  public setAskUserHandler(
    ws: { readyState: number; send: (data: string) => void } | null,
    ownerId = "",
  ): void {
    this.pendingAskUserWs = ws ? { ws, ownerId } : null;
    if (this.toolRouter) {
      this._applyAskUserWs(this.pendingAskUserWs);
    }
    // else: initialize() will call _applyAskUserWs when toolRouter is ready
  }

  private _applyAskUserWs(
    entry: {
      ws: { readyState: number; send: (data: string) => void };
      ownerId: string;
    } | null,
  ): void {
    if (!entry) {
      this.toolRouter.setAskUserHandler(null);
      return;
    }
    const { ws, ownerId } = entry;
    this.toolRouter.setAskUserHandler(
      (questions: AskUserQuestion[]) =>
        new Promise<Record<string, string>>((resolve, reject) => {
          if (ws.readyState !== 1 /* OPEN */) {
            reject(new Error("WebSocket closed"));
            return;
          }
          const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const timer = setTimeout(() => {
            this.pendingAskUsers.delete(id);
            reject(new Error("user did not respond within 300s"));
          }, 300_000);

          const cleanup = () => clearTimeout(timer);
          this.pendingAskUsers.set(id, {
            ownerId,
            resolve: (answers) => {
              cleanup();
              resolve(answers);
            },
            reject: (e) => {
              cleanup();
              reject(e);
            },
          });

          this.emit(JarvisEventType.CONTENT, {
            type: "ask_user_request",
            value: { id, questions },
          });
        }),
    );
  }
}
