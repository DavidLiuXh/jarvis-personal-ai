/**
 * Backend-neutral LLM streaming and tool-loop primitives.
 *
 * Provider adapters translate their native protocol into these types. The
 * runtime owns retry, tool execution, duplicate suppression, deterministic
 * step enforcement, and final-response safety checks.
 */

import type {
  RuntimeToolRequest,
  RuntimeToolResult,
  ToolExecutorAdapter,
} from "@jarvis/intent-runtime";

export type LlmBackendMode =
  | "native_tool_calling"
  | "text_action_calling"
  | "planner_only";

export type LlmBackendCapabilities = {
  streaming: boolean;
  nativeToolCalling: boolean;
  jsonMode: boolean;
  multimodalInput: boolean;
  maxContextTokens: number | null;
  modes: LlmBackendMode[];
};

export type LlmToolSchema = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type LlmTextBlock = {
  type: "text";
  text: string;
};

export type LlmInlineDataBlock = {
  type: "inline_data";
  mimeType: string;
  data: string;
};

export type LlmToolResultBlock = {
  type: "tool_result";
  name: string;
  callId: string;
  result: unknown;
};

export type LlmToolCallBlock = {
  type: "tool_call";
  name: string;
  callId: string;
  args: Record<string, unknown>;
};

export type LlmContentBlock =
  | LlmTextBlock
  | LlmInlineDataBlock
  | LlmToolResultBlock
  | LlmToolCallBlock;

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  blocks: LlmContentBlock[];
  metadata?: Record<string, unknown>;
};

export type LlmTurnInput = {
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
  toolChoice?: "auto" | "none" | "required";
  metadata?: Record<string, unknown>;
};

export type LlmEvent =
  | { type: "content"; text: string }
  | { type: "tool_call"; request: RuntimeToolRequest }
  | { type: "error"; error: unknown }
  | { type: "metadata"; value: Record<string, unknown> };

export type LlmBackend = {
  sendTurn(input: LlmTurnInput, signal: AbortSignal): AsyncIterable<LlmEvent>;
  getModel(): string;
  getCapabilities(): LlmBackendCapabilities;
};

export type RuntimeTurnContext = {
  userPrompt: string;
  systemContext?: string;
  initialMessages: LlmMessage[];
  metadata?: Record<string, unknown>;
};

export type RuntimeRetryContext = {
  reason: string;
  attempt: number;
  previousText: string;
  metadata?: Record<string, unknown>;
};

export type PromptCompiler = {
  compileInitialTurn(input: RuntimeTurnContext): LlmMessage[];
  compileToolResults(
    results: RuntimeToolResult[],
    requests?: RuntimeToolRequest[],
    context?: { assistantContent?: string },
  ): LlmMessage[];
  compileRetryPrompt(input: RuntimeRetryContext): LlmMessage[];
};

export type ToolLoopDuplicateDecision = {
  executableRequests: RuntimeToolRequest[];
  syntheticResults: RuntimeToolResult[];
};

export type ToolLoopPlanner = {
  shouldBufferPreToolContent?(): boolean;
  filterDuplicateToolCalls?(
    requests: RuntimeToolRequest[],
  ): ToolLoopDuplicateDecision;
  observeToolResults?(
    requests: RuntimeToolRequest[],
    results: RuntimeToolResult[],
  ): void;
  buildDeterministicToolRequests?(): RuntimeToolRequest[];
  buildPostContentToolRequest?(
    text: string,
    toolsCalled: ReadonlySet<string>,
  ): RuntimeToolRequest | null;
  buildMissingStepPrompt?(): string | null;
  buildStatePrompt?(): string;
  describeState?(): string;
};

export type ToolLoopRuntimeOptions = {
  backend: LlmBackend;
  promptCompiler: PromptCompiler;
  toolExecutor: ToolExecutorAdapter;
  tools?: LlmToolSchema[];
  toolChoice?: "auto" | "none" | "required";
  planner?: ToolLoopPlanner;
  maxRetries?: number;
  maxToolIterations?: number;
  maxConsecutiveToolFailures?: number;
  maxIntentToolEnforcements?: number;
  retryDelayMs?: (retryCount: number) => number;
  isRetryableError?: (error: unknown) => boolean;
  onContent?: (text: string) => void;
  onToolCall?: (request: RuntimeToolRequest) => void;
  onToolResult?: (result: RuntimeToolResult) => void;
  onMetadata?: (metadata: Record<string, unknown>) => void;
  onLog?: (message: string) => void;
  onRetryExhausted?: (error: unknown) => void | Promise<void>;
};

export type ToolLoopRunInput = {
  userPrompt: string;
  systemContext?: string;
  initialMessages: LlmMessage[];
  metadata?: Record<string, unknown>;
  signal: AbortSignal;
};

export type ToolLoopRunResult = {
  finalText: string;
  toolsCalled: Set<string>;
  iterations: number;
  stoppedReason: "completed" | "max_tool_iterations" | "tool_failures";
  messages: LlmMessage[];
};

function defaultRetryDelayMs(retryCount: number): number {
  return Math.pow(2, retryCount) * 1000;
}

function isFailedToolResult(result: RuntimeToolResult): boolean {
  if (result.status !== "success") return true;
  const output = result.output;
  return (
    !!output &&
    typeof output === "object" &&
    ("error" in output || (output as { status?: unknown }).status === "error")
  );
}

function normalizeDuplicateDecision(
  requests: RuntimeToolRequest[],
  planner?: ToolLoopPlanner,
): ToolLoopDuplicateDecision {
  return (
    planner?.filterDuplicateToolCalls?.(requests) ?? {
      executableRequests: requests,
      syntheticResults: [],
    }
  );
}

function mergeMetadata(
  base: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      merged[key] = {
        ...(existing as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function withTurnMetadata(
  requests: RuntimeToolRequest[],
  metadata: Record<string, unknown>,
): RuntimeToolRequest[] {
  if (Object.keys(metadata).length === 0) return requests;
  return requests.map((request) => ({
    ...request,
    metadata: mergeMetadata(request.metadata, metadata),
  }));
}

function makeUniqueToolCallId(
  callId: string,
  index: number,
  seen: Set<string>,
): string {
  if (!seen.has(callId)) {
    seen.add(callId);
    return callId;
  }
  let candidate = `${callId}-${index + 1}`;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${callId}-${index + 1}-${suffix++}`;
  }
  seen.add(candidate);
  return candidate;
}

function withUniqueToolCallIds(
  requests: RuntimeToolRequest[],
): RuntimeToolRequest[] {
  const seen = new Set<string>();
  let changed = false;
  const normalized = requests.map((request, index) => {
    const callId = makeUniqueToolCallId(request.callId, index, seen);
    if (callId === request.callId) return request;
    changed = true;
    return { ...request, callId };
  });
  return changed ? normalized : requests;
}

function requestsForResults(
  results: RuntimeToolResult[],
  requests: RuntimeToolRequest[],
): RuntimeToolRequest[] {
  const requestByCallId = new Map(
    requests.map((request) => [request.callId, request]),
  );
  return results
    .map((result) => requestByCallId.get(result.callId))
    .filter((request): request is RuntimeToolRequest => Boolean(request));
}

function appendAssistantMessage(
  messages: LlmMessage[],
  text: string,
): LlmMessage[] {
  if (!text) return messages;
  return [
    ...messages,
    {
      role: "assistant",
      blocks: [{ type: "text", text }],
    },
  ];
}

export class ToolLoopRuntime {
  constructor(private readonly options: ToolLoopRuntimeOptions) {}

  async run(input: ToolLoopRunInput): Promise<ToolLoopRunResult> {
    const maxRetries = this.options.maxRetries ?? 3;
    const maxToolIterations = this.options.maxToolIterations ?? 30;
    const maxConsecutiveToolFailures =
      this.options.maxConsecutiveToolFailures ?? 3;
    const maxIntentToolEnforcements =
      this.options.maxIntentToolEnforcements ?? 2;
    const retryDelayMs = this.options.retryDelayMs ?? defaultRetryDelayMs;
    const isRetryableError = this.options.isRetryableError ?? (() => false);

    let messages = this.options.promptCompiler.compileInitialTurn({
      userPrompt: input.userPrompt,
      systemContext: input.systemContext,
      initialMessages: input.initialMessages,
      metadata: input.metadata,
    });
    let finalText = "";
    const toolsCalled = new Set<string>();
    let toolIterations = 0;
    let consecutiveToolFailures = 0;
    let intentToolEnforcements = 0;

    while (true) {
      let retryCount = 0;
      let success = false;
      let stoppedReason: ToolLoopRunResult["stoppedReason"] = "completed";

      while (retryCount < maxRetries && !success) {
        try {
          const shouldBufferPreToolContent =
            this.options.planner?.shouldBufferPreToolContent?.() ?? false;
          const rawToolCallRequests: RuntimeToolRequest[] = [];
          let turnMetadata: Record<string, unknown> = {};
          let turnTextAccumulated = "";

          for await (const event of this.options.backend.sendTurn(
            {
              messages,
              tools: this.options.tools,
              toolChoice: this.options.toolChoice,
              metadata: input.metadata,
            },
            input.signal,
          )) {
            if (event.type === "content") {
              const newText = event.text;
              turnTextAccumulated += newText;
              if (!shouldBufferPreToolContent) {
                finalText += newText;
                this.options.onContent?.(newText);
              }
            } else if (event.type === "tool_call") {
              rawToolCallRequests.push(event.request);
            } else if (event.type === "error") {
              throw event.error;
            } else {
              turnMetadata = mergeMetadata(turnMetadata, event.value);
              this.options.onMetadata?.(event.value);
            }
          }

          const toolCallRequests = withUniqueToolCallIds(rawToolCallRequests);
          toolCallRequests.forEach((request) =>
            this.options.onToolCall?.(request),
          );

          if (toolCallRequests.length > 0) {
            toolIterations++;
            if (toolIterations > maxToolIterations) {
              const msg = `⚠️ [AgentRuntime] Task aborted: exceeded ${maxToolIterations} tool call iterations. The task may be too complex or stuck in a loop.`;
              this.options.onLog?.(msg);
              this.options.onContent?.(msg);
              finalText += msg;
              stoppedReason = "max_tool_iterations";
              success = true;
              break;
            }

            const toolCallRequestsWithMetadata = withTurnMetadata(
              toolCallRequests,
              turnMetadata,
            );
            const duplicateDecisionRaw = normalizeDuplicateDecision(
              toolCallRequestsWithMetadata,
              this.options.planner,
            );
            const duplicateDecision = {
              executableRequests: withTurnMetadata(
                duplicateDecisionRaw.executableRequests,
                turnMetadata,
              ),
              syntheticResults: duplicateDecisionRaw.syntheticResults,
            };
            duplicateDecision.executableRequests.forEach((request) =>
              toolsCalled.add(request.name),
            );
            const routedResults =
              duplicateDecision.executableRequests.length > 0
                ? await this.options.toolExecutor.executeTools(
                    duplicateDecision.executableRequests,
                    input.signal,
                  )
                : [];
            const results = [
              ...duplicateDecision.syntheticResults,
              ...routedResults,
            ];
            results.forEach((result) => this.options.onToolResult?.(result));
            this.options.planner?.observeToolResults?.(
              duplicateDecision.executableRequests,
              results,
            );

            const failCount = results.filter(isFailedToolResult).length;
            if (failCount > 0 && failCount === toolCallRequests.length) {
              consecutiveToolFailures++;
              if (consecutiveToolFailures >= maxConsecutiveToolFailures) {
                const msg = `⚠️ [AgentRuntime] Task aborted: ${maxConsecutiveToolFailures} consecutive tool call rounds all failed. Please check tool availability or rephrase the request.`;
                this.options.onLog?.(msg);
                this.options.onContent?.(msg);
                finalText += msg;
                stoppedReason = "tool_failures";
                success = true;
                break;
              }
            } else {
              consecutiveToolFailures = 0;
            }

            messages = [
              ...messages,
              ...this.options.promptCompiler.compileToolResults(
                results,
                requestsForResults(results, [
                  ...toolCallRequestsWithMetadata,
                  ...duplicateDecision.executableRequests,
                ]),
                { assistantContent: turnTextAccumulated },
              ),
            ];
          } else {
            const postContentRequest =
              this.options.planner?.buildPostContentToolRequest?.(
                turnTextAccumulated,
                toolsCalled,
              ) ?? null;
            if (postContentRequest) {
              this.options.onLog?.(
                `🧭 [AgentRuntime] Generated content requires tool completion — invoking ${postContentRequest.name}.`,
              );
              toolsCalled.add(postContentRequest.name);
              const postContentRequests = withUniqueToolCallIds(
                withTurnMetadata([postContentRequest], turnMetadata),
              );
              const postContentResults =
                await this.options.toolExecutor.executeTools(
                  postContentRequests,
                  input.signal,
                );
              postContentResults.forEach((result) =>
                this.options.onToolResult?.(result),
              );
              this.options.planner?.observeToolResults?.(
                postContentRequests,
                postContentResults,
              );
              messages = [
                ...messages,
                ...this.options.promptCompiler.compileToolResults(
                  postContentResults,
                  postContentRequests,
                  { assistantContent: turnTextAccumulated },
                ),
              ];
              success = false;
              continue;
            }

            const deterministicRequests =
              this.options.planner?.buildDeterministicToolRequests?.() ?? [];
            if (deterministicRequests.length > 0) {
              if (shouldBufferPreToolContent && turnTextAccumulated) {
                this.options.onLog?.(
                  "🧭 [AgentRuntime] Suppressed pre-tool assistant text because deterministic multi-intent tool execution is required.",
                );
              }
              const deterministicRequestsWithMetadata = withUniqueToolCallIds(
                withTurnMetadata(deterministicRequests, turnMetadata),
              );
              deterministicRequestsWithMetadata.forEach((request) =>
                toolsCalled.add(request.name),
              );
              const deterministicResults =
                await this.options.toolExecutor.executeTools(
                  deterministicRequestsWithMetadata,
                  input.signal,
                );
              deterministicResults.forEach((result) =>
                this.options.onToolResult?.(result),
              );
              this.options.planner?.observeToolResults?.(
                deterministicRequestsWithMetadata,
                deterministicResults,
              );
              const statePrompt =
                this.options.planner?.buildStatePrompt?.() ?? "";
              messages = [
                ...messages,
                ...this.options.promptCompiler.compileToolResults(
                  deterministicResults,
                  deterministicRequestsWithMetadata,
                  { assistantContent: turnTextAccumulated },
                ),
                ...(statePrompt
                  ? [
                      {
                        role: "user" as const,
                        blocks: [{ type: "text" as const, text: statePrompt }],
                      },
                    ]
                  : []),
              ];
              success = false;
              continue;
            }

            const missingToolPrompt =
              intentToolEnforcements < maxIntentToolEnforcements
                ? (this.options.planner?.buildMissingStepPrompt?.() ?? null)
                : null;
            if (missingToolPrompt) {
              if (shouldBufferPreToolContent && turnTextAccumulated) {
                this.options.onLog?.(
                  "🧭 [AgentRuntime] Suppressed pre-tool assistant text because multi-intent execution is incomplete.",
                );
              }
              intentToolEnforcements++;
              const statePrompt =
                this.options.planner?.buildStatePrompt?.() ?? "";
              this.options.onLog?.(
                `🧭 [AgentRuntime] Multi-intent execution incomplete — forcing missing tool step(s), attempt ${intentToolEnforcements}/${maxIntentToolEnforcements}.`,
              );
              messages = [
                ...messages,
                {
                  role: "user",
                  blocks: [
                    {
                      type: "text",
                      text: `${statePrompt}\n\n${missingToolPrompt}`.trim(),
                    },
                  ],
                },
              ];
              success = false;
            } else {
              if (shouldBufferPreToolContent && turnTextAccumulated) {
                finalText += turnTextAccumulated;
                this.options.onContent?.(turnTextAccumulated);
              }
              messages = appendAssistantMessage(messages, turnTextAccumulated);
              success = true;
            }
          }
        } catch (error) {
          if (isRetryableError(error) && retryCount < maxRetries - 1) {
            retryCount++;
            const delay = retryDelayMs(retryCount);
            this.options.onLog?.(
              `⚠️ [AgentRuntime] Backend error (${error instanceof Error ? error.message : String(error)}). Retrying in ${delay}ms... (attempt ${retryCount}/${maxRetries - 1})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            await this.options.onRetryExhausted?.(error);
            throw error;
          }
        }
      }

      if (success) {
        return {
          finalText,
          toolsCalled,
          iterations: toolIterations,
          stoppedReason,
          messages,
        };
      }
    }
  }
}
