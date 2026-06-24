/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "node:events";
import {
  DeepSeekChatBackend,
  DeepSeekPromptCompiler,
  OpenAiChatCompletionsBackend,
  OpenAiPromptCompiler,
  type LlmBackend,
  type LlmMessage,
  type PromptCompiler,
  type ToolLoopPlanner,
  type ToolLoopRuntimeOptions,
} from "../agent-runtime/index.js";
import type {
  RuntimeToolRequest,
  RuntimeToolResult,
  ToolExecutorAdapter,
} from "../intent-runtime/index.js";
import { ConfigManager, type JarvisConfig } from "./configManager.js";
import { type AgentManager } from "./agentManager.js";
import { type BackgroundTaskRunner } from "./backgroundTaskRunner.js";
import { BackgroundDistiller } from "./backgroundDistiller.js";
import { type ChannelRegistry } from "./channelRegistry.js";
import { type SkillCommandHandler } from "./skillCommandHandler.js";
import { type TaskCommandHandler } from "./taskCommandHandler.js";
import { DynamicToolRegistry } from "./dynamicToolRegistry.js";
import { IntentStepRuntime } from "./intentExecutionPlan.js";
import type { IntentFrame } from "./intentResolver.js";
import {
  runtimeFunctionResponseToToolResult,
  toolResultToRuntimeFunctionResponse,
  type RuntimeConversationContent,
} from "./runtimeTypes.js";
import { isFetchError } from "./agentNetworkUtils.js";
import { LocalModelRouter } from "./localModelRouter.js";
import type { MemoryService } from "./memory.js";
import { MemoryInjectionPlanner } from "./memoryInjectionPlanner.js";
import { RuntimeIntentFeedbackCollector } from "./runtimeIntentFeedbackCollector.js";
import {
  runJarvisUnifiedRuntimeTurn,
  type JarvisUnifiedRuntimeTurnResult,
} from "./jarvisUnifiedRuntime.js";
import { SystemPromptBuilder, type SkillInfo } from "./systemPromptBuilder.js";
import {
  createStandaloneClientHandle,
  createStandaloneSchedulerHandle,
  type ToolCallResponse,
  ToolRouter,
} from "./toolRouter.js";
import { JarvisEventType, type JarvisAgentLike } from "./types.js";
import { createDefaultRuntimeToolRegistry } from "./jarvisToolRegistry.js";
import { WorkspaceTools } from "./workspaceTools.js";
import { JarvisNativeSkillRuntime } from "./skillRuntime.js";
import type { SessionMemory } from "../memory-runtime/index.js";

export type StandaloneRoutingTargetModels = {
  defaultModel: string;
  proModel: string;
  flashModel: string;
};

export function resolveStandaloneRoutingTargetModels(
  config: Pick<JarvisConfig, "llmBackend" | "routing">,
): StandaloneRoutingTargetModels {
  const provider = config.llmBackend?.provider ?? "gemini";
  const backendConfig =
    provider === "deepseek"
      ? config.llmBackend?.deepseek
      : config.llmBackend?.openai;
  const defaultModel =
    backendConfig?.model ??
    (provider === "deepseek" ? "deepseek-v4-pro" : "gpt-4.1");
  const proModel = config.routing?.targets?.pro ?? defaultModel;
  const flashModel = config.routing?.targets?.flash ?? defaultModel;
  return { defaultModel, proModel, flashModel };
}

export function createStandaloneBackend(input: {
  config: JarvisConfig;
  model: string;
}): { backend: LlmBackend; promptCompiler: PromptCompiler } {
  const provider = input.config.llmBackend?.provider ?? "openai";
  const diagnostics = {
    enabled: input.config.ui?.markdownDiagnostics === true,
    label: provider === "deepseek" ? "deepseek" : "openai",
    maxSnippetChars: input.config.ui?.markdownDiagnosticsMaxChars ?? 240,
    chunkSampleRate: input.config.ui?.markdownDiagnosticsChunkSampleRate ?? 0,
  };
  if (provider === "deepseek") {
    const deepseek = input.config.llmBackend?.deepseek ?? {};
    const apiKeyEnv = deepseek.apiKeyEnv ?? "DEEPSEEK_API_KEY";
    const apiKey = deepseek.apiKey ?? process.env[apiKeyEnv] ?? "";
    return {
      backend: new DeepSeekChatBackend({
        apiKey,
        model: input.model,
        baseUrl: deepseek.baseUrl,
        timeoutMs: deepseek.timeoutMs,
        thinking: deepseek.thinking,
        reasoningEffort: deepseek.reasoningEffort,
        diagnostics,
      }),
      promptCompiler: new DeepSeekPromptCompiler(),
    };
  }

  const openai = input.config.llmBackend?.openai ?? {};
  const apiKeyEnv = openai.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = openai.apiKey ?? process.env[apiKeyEnv] ?? "";
  return {
    backend: new OpenAiChatCompletionsBackend({
      apiKey,
      model: input.model,
      baseUrl: openai.baseUrl,
      organization: openai.organization,
      project: openai.project,
      timeoutMs: openai.timeoutMs,
      diagnostics,
    }),
    promptCompiler: new OpenAiPromptCompiler(),
  };
}

function createStandaloneToolExecutor(input: {
  toolRouter: ToolRouter;
  emitToolCallResponse: (response: ToolCallResponse) => void;
}): ToolExecutorAdapter {
  return {
    executeTools: async (
      requests: RuntimeToolRequest[],
      signal: AbortSignal,
    ): Promise<RuntimeToolResult[]> => {
      const parts =
        requests.length > 0
          ? await input.toolRouter.route(requests, signal, (resp) =>
              input.emitToolCallResponse(resp),
            )
          : [];
      return parts
        .map((part) => runtimeFunctionResponseToToolResult(part))
        .filter((result): result is RuntimeToolResult => Boolean(result));
    },
  };
}

function toRuntimeToolRequest(request: {
  name: string;
  callId?: string;
  args?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): RuntimeToolRequest {
  return {
    name: request.name,
    callId: request.callId ?? request.name,
    args: request.args ?? {},
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

function createStandaloneToolLoopPlanner(input: {
  stepRuntime: IntentStepRuntime;
  toolRouter: ToolRouter;
  log?: (message: string) => void;
}): ToolLoopPlanner {
  const log = input.log ?? console.error;
  const { stepRuntime, toolRouter } = input;
  return {
    shouldBufferPreToolContent: () =>
      stepRuntime.active && stepRuntime.actionableEnforceableSteps().length > 0,
    filterDuplicateToolCalls: (requests) => {
      const duplicateDecision = stepRuntime.filterDuplicateToolCalls(requests);
      return {
        executableRequests:
          duplicateDecision.executableRequests.map(toRuntimeToolRequest),
        syntheticResults: duplicateDecision.duplicateResponses
          .map((part) => runtimeFunctionResponseToToolResult(part))
          .filter((result): result is RuntimeToolResult => Boolean(result)),
      };
    },
    observeToolResults: (requests, results) => {
      stepRuntime.observeToolResults(
        requests,
        results.map(toolResultToRuntimeFunctionResponse),
      );
      if (stepRuntime.active) {
        log(
          `🧭 [Jarvis] Multi-intent runtime state: ${stepRuntime
            .snapshot()
            .map(
              (entry) => `${entry.step.id}:${entry.status}/${entry.attempts}`,
            )
            .join(", ")}`,
        );
        const failures = stepRuntime.describeFailures();
        if (failures.length > 0) {
          log(
            `⚠️ [Jarvis] Multi-intent step issue(s):\n${failures
              .map((line) => `  ${line}`)
              .join("\n")}`,
          );
        }
      }
    },
    buildPostContentToolRequest: (text, toolsCalled) => {
      if (toolsCalled.has("push_to_channel")) return null;
      return toolRouter.buildPushToChannelRequestFromContent(text);
    },
    buildDeterministicToolRequests: () => {
      const requests = stepRuntime.buildDeterministicToolRequests();
      if (requests.length > 0) {
        log(
          `🧭 [Jarvis] Executing deterministic multi-intent step(s): ${requests
            .map((request) => {
              const args = JSON.stringify(request.args ?? {});
              return `${request.name}(${args.slice(0, 160)})`;
            })
            .join(", ")}`,
        );
      }
      return requests.map(toRuntimeToolRequest);
    },
    buildMissingStepPrompt: () => stepRuntime.buildMissingStepPrompt(),
    buildStatePrompt: () => stepRuntime.buildStatePrompt(),
  };
}

function conversationHistoryFromRuntime(
  history: RuntimeConversationContent[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .map((turn) => ({
      role: turn.role === "user" ? ("user" as const) : ("assistant" as const),
      content: turn.parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join(""),
    }))
    .filter((turn) => turn.content.trim());
}

function conversationHistoryToLlmMessages(
  history: RuntimeConversationContent[],
): LlmMessage[] {
  return conversationHistoryFromRuntime(history).map((turn) => ({
    role: turn.role,
    blocks: [{ type: "text", text: turn.content }],
  }));
}

export class StandaloneJarvisAgent
  extends EventEmitter
  implements JarvisAgentLike
{
  private readonly jarvisConfig = ConfigManager.getInstance().get();
  private readonly dynamicRegistry: DynamicToolRegistry;
  private readonly promptBuilder = new SystemPromptBuilder();
  private readonly runtimeIntentFeedbackCollector =
    new RuntimeIntentFeedbackCollector(this.jarvisConfig.intentFeedback);
  private readonly history: RuntimeConversationContent[] = [];
  private llmHistory: LlmMessage[] = [];
  private readonly toolRouter: ToolRouter;
  private localModelRouter: LocalModelRouter | null = null;
  private taskCommandHandler?: TaskCommandHandler;
  private channelRegistry?: ChannelRegistry;
  private availableSkills: SkillInfo[] = [];
  private skillCommandHandler?: SkillCommandHandler;
  private agentManager: AgentManager | null = null;
  private backgroundTaskRunner: BackgroundTaskRunner | null = null;
  private initialized = false;
  private currentBackendModel = resolveStandaloneRoutingTargetModels(
    this.jarvisConfig,
  ).defaultModel;
  private pendingAskUsers = new Map<
    string,
    {
      ownerId: string;
      resolve: (answers: Record<string, string>) => void;
      reject: (error: Error) => void;
    }
  >();
  private pendingAskUserWs: {
    ws: { readyState: number; send: (data: string) => void };
    ownerId: string;
  } | null = null;

  constructor(
    private readonly options: {
      sessionId: string;
      cwd: string;
      memoryService: MemoryService;
      lightweight?: boolean;
      distillGenerateText?: (prompt: string) => Promise<string>;
    },
  ) {
    super();
    this.dynamicRegistry = new DynamicToolRegistry(options.cwd);
    this.toolRouter = new ToolRouter(
      options.memoryService,
      this.dynamicRegistry,
      createStandaloneSchedulerHandle(),
      createStandaloneClientHandle(),
      this.taskCommandHandler,
      this.channelRegistry,
      undefined,
      undefined,
      new WorkspaceTools({
        root: options.cwd,
        allowNetworkFetchCommands:
          this.jarvisConfig.security?.shell?.allowNetworkFetchCommands,
        networkFetchCommands:
          this.jarvisConfig.security?.shell?.networkFetchCommands,
      }),
      new JarvisNativeSkillRuntime({ cwd: options.cwd }),
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.options.memoryService.initializeEmbedding({
      lightweight: this.options.lightweight,
    });
    const routingCfg = this.jarvisConfig.routing;
    if (routingCfg?.enabled && routingCfg.model) {
      const routingModels = resolveStandaloneRoutingTargetModels(
        this.jarvisConfig,
      );
      this.localModelRouter = new LocalModelRouter(
        this.jarvisConfig.ollama?.baseUrl ?? "http://localhost:11434",
        routingCfg.model,
        routingCfg.threshold ?? 70,
        routingModels.proModel,
        routingModels.flashModel,
        routingCfg.timeoutMs ?? this.jarvisConfig.ollama?.defaultTimeoutMs,
        routingCfg.historyTurns ?? 5,
        routingCfg.intentPolicyObservability,
      );
    }
    this.initialized = true;
  }

  getHistory(): RuntimeConversationContent[] {
    return [...this.history];
  }

  async processMessage(userPrompt: string): Promise<void> {
    await this.initialize();
    this.toolRouter.setCurrentUserPrompt(userPrompt);

    let querySubject: "personal" | "external" | "mixed" = "mixed";
    let timeWindowDays: number | null = null;
    let resolvedDateRange: { from: number; to: number } | null = null;
    let intentFrame: IntentFrame | null = null;
    let topicShifted = false;
    const conversationHistory = conversationHistoryFromRuntime(this.history);

    if (this.localModelRouter) {
      const routing = await this.localModelRouter.route(
        userPrompt,
        conversationHistory,
      );
      querySubject = routing.querySubject;
      timeWindowDays = routing.timeWindowDays;
      resolvedDateRange = routing.resolvedDateRange;
      intentFrame = routing.intent;
      topicShifted = routing.topicShifted;
      this.currentBackendModel = routing.model;
      console.error(
        `🔀 [Jarvis] Standalone routing: ${routing.decision} | backend_model=${this.currentBackendModel} | subject=${querySubject} | topic_shifted=${routing.topicShifted} | source=${routing.source}`,
      );
    }

    this.toolRouter.setCurrentTimeWindow(timeWindowDays);
    this.toolRouter.setCurrentDateRange(
      resolvedDateRange,
      intentFrame?.dateFrom,
      intentFrame?.dateTo,
    );

    const abortController = new AbortController();
    const stepRuntime = new IntentStepRuntime(intentFrame);
    if (stepRuntime.active) {
      console.error(
        `🧭 [Jarvis] Multi-intent runtime initialized: ${stepRuntime.describeInitialStateSummary()}`,
      );
      console.error(
        `🧭 [Jarvis] Multi-intent execution plan:\n${stepRuntime
          .describePlan()
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}`,
      );
    }
    const runtimeTurn = await this.runUnifiedRuntimeTurn(
      userPrompt,
      querySubject,
      timeWindowDays,
      resolvedDateRange,
      conversationHistory,
      intentFrame,
      {
        options: this.createToolLoopOptions(
          stepRuntime,
          this.currentBackendModel,
        ),
        initialMessages: [
          ...(!topicShifted && this.llmHistory.length > 0
            ? this.llmHistory
            : !topicShifted
              ? conversationHistoryToLlmMessages(this.history)
              : []),
          { role: "user", blocks: [{ type: "text", text: userPrompt }] },
        ],
        signal: abortController.signal,
      },
    );

    const assistantText = runtimeTurn.llmLoop?.finalText ?? "";
    this.history.push(
      { role: "user", parts: [{ text: userPrompt }] },
      { role: "assistant", parts: [{ text: assistantText }] },
    );
    this.llmHistory = (runtimeTurn.llmLoop?.messages ?? [])
      .filter((message) => message.role !== "system")
      .slice(-24);
    const now = new Date().toISOString();
    const session: SessionMemory = {
      scope: "session",
      sessionId: this.options.sessionId,
      turns: [
        {
          role: "user",
          content: userPrompt,
          timestamp: now,
          metadata: { backend: "standalone" },
        },
        {
          role: "assistant",
          content: assistantText,
          timestamp: new Date().toISOString(),
          metadata: { backend: "standalone" },
        },
      ],
    };
    await this.options.memoryService
      .getRuntimeSqliteMemoryStore()
      .upsertSession(session);
    if (!this.options.lightweight) {
      void this.distillFactsInBackground(userPrompt, assistantText);
    }
    this.emit(JarvisEventType.DONE);
  }

  private async distillFactsInBackground(
    userPrompt: string,
    assistantText: string,
  ): Promise<void> {
    const distiller = new BackgroundDistiller(
      async (prompt) => this.generateStandaloneText(prompt),
      async (category, content, importance) => {
        await this.options.memoryService.saveFactToRuntime(
          category,
          content,
          importance,
          "background_distiller",
        );
      },
    );
    await distiller.distill(userPrompt, assistantText);
  }

  private async generateStandaloneText(prompt: string): Promise<string> {
    if (this.options.distillGenerateText) {
      return this.options.distillGenerateText(prompt);
    }
    const { backend } = createStandaloneBackend({
      config: this.jarvisConfig,
      model: this.currentBackendModel,
    });
    let text = "";
    for await (const event of backend.sendTurn(
      {
        messages: [{ role: "user", blocks: [{ type: "text", text: prompt }] }],
      },
      new AbortController().signal,
    )) {
      if (event.type === "content") text += event.text;
    }
    return text;
  }

  private createToolLoopOptions(
    stepRuntime: IntentStepRuntime,
    backendModel: string,
  ): ToolLoopRuntimeOptions {
    const { backend, promptCompiler } = createStandaloneBackend({
      config: this.jarvisConfig,
      model: backendModel,
    });
    return {
      backend,
      promptCompiler,
      tools: createDefaultRuntimeToolRegistry()
        .listTools()
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      toolExecutor: createStandaloneToolExecutor({
        toolRouter: this.toolRouter,
        emitToolCallResponse: (response) =>
          this.emit(JarvisEventType.TOOL_CALL_RESPONSE, response),
      }),
      maxRetries: this.jarvisConfig.network?.maxRetries ?? 3,
      maxToolIterations: this.jarvisConfig.network?.maxToolIterations ?? 30,
      maxConsecutiveToolFailures:
        this.jarvisConfig.network?.maxConsecutiveToolFailures ?? 3,
      maxIntentToolEnforcements: 2,
      isRetryableError: isFetchError,
      onContent: (text) =>
        this.emit(JarvisEventType.CONTENT, {
          type: JarvisEventType.CONTENT,
          value: text,
        }),
      onToolCall: (request) =>
        this.emit(JarvisEventType.CONTENT, {
          type: JarvisEventType.TOOL_CALL_REQUEST,
          value: request,
        }),
      onLog: console.error,
      planner: createStandaloneToolLoopPlanner({
        stepRuntime,
        toolRouter: this.toolRouter,
      }),
      retryDelayMs: (retryCount) => Math.pow(2, retryCount) * 1000,
    };
  }

  private async runUnifiedRuntimeTurn(
    userPrompt: string,
    querySubject: "personal" | "external" | "mixed",
    timeWindowDays: number | null,
    resolvedDateRange: { from: number; to: number } | null,
    conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
    intentFrame: IntentFrame | null,
    llmRuntime: {
      options: ToolLoopRuntimeOptions;
      initialMessages: LlmMessage[];
      signal: AbortSignal;
    },
  ): Promise<JarvisUnifiedRuntimeTurnResult> {
    return runJarvisUnifiedRuntimeTurn({
      sessionId: this.options.sessionId,
      userPrompt,
      querySubject,
      timeWindowDays,
      resolvedDateRange,
      conversationHistory,
      intent: intentFrame,
      llmRuntime,
      jarvisConfig: this.jarvisConfig,
      memoryService: this.options.memoryService,
      availableSkills: this.availableSkills,
      conversationSummary: "",
      localModelRouter: this.localModelRouter,
      promptBuilder: this.promptBuilder,
      toolRouter: this.toolRouter,
      runtimeIntentFeedbackCollector: this.runtimeIntentFeedbackCollector,
      interactiveChannel: this.pendingAskUserWs?.ws.readyState === 1,
      buildMemoryInjectionPlanner: () => this.buildMemoryInjectionPlanner(),
    });
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

  setTaskCommandHandler(handler: TaskCommandHandler): void {
    this.taskCommandHandler = handler;
    this.toolRouter.setTaskCommandHandler(handler);
  }

  setChannelRegistry(registry: ChannelRegistry): void {
    this.channelRegistry = registry;
    this.toolRouter.setChannelRegistry(registry);
  }

  setAvailableSkills(skills: SkillInfo[]): void {
    this.availableSkills = skills;
    this.skillCommandHandler?.setCurrentSkills(skills);
    void this.options.memoryService.backfillSkillIndex(skills);
  }

  setSkillCommandHandler(handler: SkillCommandHandler): void {
    this.skillCommandHandler = handler;
  }

  setAgentManager(manager: AgentManager): void {
    this.agentManager = manager;
  }

  setBackgroundTaskRunner(runner: BackgroundTaskRunner): void {
    this.backgroundTaskRunner = runner;
  }

  async triggerSkillExtraction(): Promise<void> {
    console.error(
      "⚠️ [Jarvis] Skill extraction agent is not available in standalone runtime.",
    );
  }

  setAskUserHandler(
    ws: { readyState: number; send: (data: string) => void },
    ownerId: string,
  ): void {
    this.pendingAskUserWs = { ws, ownerId };
    this.toolRouter.setAskUserHandler(async (questions) => {
      const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      ws.send(
        JSON.stringify({
          type: "stream",
          sessionId: this.options.sessionId,
          payload: {
            type: "ask_user_request",
            value: { id, questions },
          },
        }),
      );
      return new Promise<Record<string, string>>((resolve, reject) => {
        this.pendingAskUsers.set(id, { ownerId, resolve, reject });
      });
    });
  }

  clearAskUserHandlerIfOwner(ownerId: string): void {
    if (this.pendingAskUserWs?.ownerId !== ownerId) return;
    this.pendingAskUserWs = null;
    this.toolRouter.setAskUserHandler(null);
  }

  rejectPendingAskUsersForOwner(ownerId: string): void {
    for (const [id, pending] of this.pendingAskUsers) {
      if (pending.ownerId !== ownerId) continue;
      pending.reject(new Error("ask_user connection closed"));
      this.pendingAskUsers.delete(id);
    }
  }

  provideAskUserResponse(
    id: string,
    answers: Record<string, string>,
    cancelled = false,
  ): void {
    const pending = this.pendingAskUsers.get(id);
    if (!pending) return;
    this.pendingAskUsers.delete(id);
    if (cancelled) {
      pending.reject(new Error("user cancelled ask_user"));
    } else {
      pending.resolve(answers);
    }
  }

  provideConfirmationResponse(_id: string, _decision: "allow" | "deny"): void {
    // Standalone runtime uses SafetyPolicyEngine gates directly; explicit
    // confirmation state is reserved for Gemini compatibility tools.
  }
}
