/**
 * OpenAI-compatible Chat Completions backend adapter.
 *
 * The adapter intentionally depends only on fetch and the backend-neutral
 * runtime protocol. It supports OpenAI itself and OpenAI-compatible gateways
 * that implement /v1/chat/completions with streaming tool calls.
 */

import type { RuntimeToolRequest } from "@jarvis/intent-runtime";
import type {
  LlmBackend,
  LlmBackendCapabilities,
  LlmContentBlock,
  LlmEvent,
  LlmMessage,
  LlmToolSchema,
  LlmTurnInput,
  PromptCompiler,
  RuntimeRetryContext,
  RuntimeTurnContext,
} from "./llmBackend.js";
import type { RuntimeToolResult } from "@jarvis/intent-runtime";

export type OpenAiChatBackendOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
  diagnostics?: OpenAiStreamDiagnosticsOptions;
  fetchFn?: typeof fetch;
};

export type OpenAiStreamDiagnosticsOptions = {
  enabled?: boolean;
  label?: string;
  maxSnippetChars?: number;
  chunkSampleRate?: number;
  log?: (message: string) => void;
};

type OpenAiToolCallAccumulator = {
  id: string;
  name: string;
  argumentsText: string;
};

type OpenAiToolRequestMetadata = {
  reasoningContent?: string;
};

function assertApiKey(apiKey: string): void {
  if (!apiKey.trim()) {
    throw new Error(
      "OpenAI backend requires an API key. Set llmBackend.openai.apiKey or the configured apiKeyEnv.",
    );
  }
}

function textFromBlocks(blocks: LlmContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  const toolCallBlocks = message.blocks.filter(
    (block) => block.type === "tool_call",
  );
  if (message.role === "assistant" && toolCallBlocks.length > 0) {
    const reasoningContent =
      typeof message.metadata?.openaiReasoningContent === "string"
        ? message.metadata.openaiReasoningContent
        : "";
    return {
      role: "assistant",
      content: textFromBlocks(message.blocks) || null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      tool_calls: toolCallBlocks.map((block) => ({
        id: block.callId,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.args ?? {}),
        },
      })),
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id:
        message.blocks.find((block) => block.type === "tool_result")?.callId ??
        "tool-result",
      content: message.blocks
        .filter((block) => block.type === "tool_result")
        .map((block) =>
          typeof block.result === "string"
            ? block.result
            : JSON.stringify(block.result),
        )
        .join("\n"),
    };
  }

  return {
    role: message.role,
    content: textFromBlocks(message.blocks),
  };
}

function normalizeOpenAiProtocolMessages(messages: LlmMessage[]): LlmMessage[] {
  const normalized: LlmMessage[] = [];
  let pendingToolCallIds: Set<string> | null = null;
  let pendingAssistantIndex = -1;

  const dropIncompletePendingExchange = () => {
    if (pendingToolCallIds && pendingAssistantIndex >= 0) {
      normalized.splice(pendingAssistantIndex);
    }
    pendingToolCallIds = null;
    pendingAssistantIndex = -1;
  };

  for (const message of messages) {
    if (message.role === "tool") {
      if (!pendingToolCallIds || pendingToolCallIds.size === 0) {
        continue;
      }
      for (const block of message.blocks) {
        if (block.type !== "tool_result") continue;
        if (!pendingToolCallIds.has(block.callId)) continue;
        normalized.push({
          role: "tool",
          blocks: [block],
          ...(message.metadata ? { metadata: message.metadata } : {}),
        });
        pendingToolCallIds.delete(block.callId);
      }
      if (pendingToolCallIds.size === 0) {
        pendingToolCallIds = null;
        pendingAssistantIndex = -1;
      }
      continue;
    }

    if (pendingToolCallIds && pendingToolCallIds.size > 0) {
      dropIncompletePendingExchange();
    }

    const toolCallIds = message.blocks
      .filter((block) => block.type === "tool_call")
      .map((block) => block.callId);
    normalized.push(message);
    if (message.role === "assistant" && toolCallIds.length > 0) {
      pendingToolCallIds = new Set(toolCallIds);
      pendingAssistantIndex = normalized.length - 1;
    }
  }

  if (pendingToolCallIds && pendingToolCallIds.size > 0) {
    dropIncompletePendingExchange();
  }

  return normalized;
}

function makeUniqueCallId(
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

function pairResultsWithRequests(
  results: RuntimeToolResult[],
  requests: RuntimeToolRequest[],
): Array<{
  result: RuntimeToolResult;
  request?: RuntimeToolRequest;
  callId: string;
}> {
  const requestsById = new Map<string, RuntimeToolRequest[]>();
  for (const request of requests) {
    const bucket = requestsById.get(request.callId) ?? [];
    bucket.push(request);
    requestsById.set(request.callId, bucket);
  }

  const seen = new Set<string>();
  return results.map((result, index) => {
    const request = requestsById.get(result.callId)?.shift();
    return {
      result,
      request,
      callId: makeUniqueCallId(result.callId, index, seen),
    };
  });
}

export class OpenAiPromptCompiler implements PromptCompiler {
  compileInitialTurn(input: RuntimeTurnContext): LlmMessage[] {
    const messages = [...input.initialMessages];
    if (input.systemContext?.trim()) {
      messages.unshift({
        role: "system",
        blocks: [{ type: "text", text: input.systemContext }],
      });
    }
    return messages;
  }

  compileToolResults(
    results: RuntimeToolResult[],
    requests: RuntimeToolRequest[] = [],
    context: { assistantContent?: string } = {},
  ): LlmMessage[] {
    const pairedResults = pairResultsWithRequests(results, requests);
    const reasoningContent = requests
      .map((request) => request.metadata?.openai)
      .map((metadata) =>
        metadata && typeof metadata === "object"
          ? (metadata as OpenAiToolRequestMetadata).reasoningContent
          : undefined,
      )
      .find((value): value is string => Boolean(value));
    return [
      {
        role: "assistant",
        ...(reasoningContent
          ? { metadata: { openaiReasoningContent: reasoningContent } }
          : {}),
        blocks: [
          ...(context.assistantContent
            ? [
                {
                  type: "text" as const,
                  text: context.assistantContent,
                },
              ]
            : []),
          ...pairedResults.map(({ result, request, callId }) => {
            return {
              type: "tool_call" as const,
              name: result.name,
              callId,
              args: request?.args ?? {},
            };
          }),
        ],
      },
      ...pairedResults.map(({ result, callId }) => ({
        role: "tool" as const,
        blocks: [
          {
            type: "tool_result" as const,
            name: result.name,
            callId,
            result: result.output,
          },
        ],
      })),
    ];
  }

  compileRetryPrompt(input: RuntimeRetryContext): LlmMessage[] {
    return [
      {
        role: "user",
        blocks: [
          {
            type: "text",
            text: `Previous response attempt failed: ${input.reason}. Retry and continue from the current task state.`,
          },
        ],
      },
    ];
  }
}

function toOpenAiTools(tools: LlmToolSchema[] | undefined): unknown[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

function parseArgs(argumentsText: string): Record<string, unknown> {
  if (!argumentsText.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return { _raw: argumentsText };
  }
}

function decodeSseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return null;
  return JSON.parse(payload);
}

function diagnosticSnippet(value: string, maxChars: number): string {
  const normalized = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function analyzeStreamText(value: string, maxSnippetChars: number) {
  return {
    chars: value.length,
    lines: value ? value.split(/\r?\n/).length : 0,
    dollars: countMatches(value, /\$/g),
    escapedParenMathOpen: countMatches(value, /\\\(/g),
    escapedParenMathClose: countMatches(value, /\\\)/g),
    escapedBracketMathOpen: countMatches(value, /\\\[/g),
    escapedBracketMathClose: countMatches(value, /\\\]/g),
    headingsNoSpace: countMatches(value, /^#{1,6}\S/gm),
    headingsWithSpace: countMatches(value, /^#{1,6}\s+\S/gm),
    likelyLatexCommands: countMatches(value, /\\[a-zA-Z]+/g),
    startsWith: diagnosticSnippet(
      value.slice(0, maxSnippetChars),
      maxSnippetChars,
    ),
    endsWith: diagnosticSnippet(value.slice(-maxSnippetChars), maxSnippetChars),
  };
}

function emitStreamDiagnostic(
  options: OpenAiStreamDiagnosticsOptions | undefined,
  stage: string,
  payload: Record<string, unknown>,
): void {
  if (!options?.enabled) return;
  const label = options.label ?? "openai";
  const log = options.log ?? console.error;
  log(`[LLMStreamDiagnostics:${label}] ${stage} ${JSON.stringify(payload)}`);
}

export class OpenAiChatCompletionsBackend implements LlmBackend {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OpenAiChatBackendOptions) {
    assertApiKey(options.apiKey);
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.fetchFn = options.fetchFn ?? fetch;
  }

  getModel(): string {
    return this.options.model;
  }

  getCapabilities(): LlmBackendCapabilities {
    return {
      streaming: true,
      nativeToolCalling: true,
      jsonMode: true,
      multimodalInput: false,
      maxContextTokens: null,
      modes: ["native_tool_calling"],
    };
  }

  async *sendTurn(
    input: LlmTurnInput,
    signal: AbortSignal,
  ): AsyncIterable<LlmEvent> {
    const controller = new AbortController();
    const timeout = this.options.timeoutMs
      ? setTimeout(() => controller.abort(), this.options.timeoutMs)
      : null;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const tools = toOpenAiTools(input.tools);
      const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          ...(this.options.organization
            ? { "OpenAI-Organization": this.options.organization }
            : {}),
          ...(this.options.project
            ? { "OpenAI-Project": this.options.project }
            : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          stream: true,
          messages: normalizeOpenAiProtocolMessages(input.messages).map(
            toOpenAiMessage,
          ),
          ...(this.options.extraBody ?? {}),
          ...(tools.length > 0
            ? {
                tools,
                tool_choice: input.toolChoice ?? "auto",
              }
            : {}),
        }),
      });

      if (!response.ok || !response.body) {
        yield {
          type: "error",
          error: new Error(
            `OpenAI backend request failed: ${response.status} ${await response.text().catch(() => "")}`,
          ),
        };
        return;
      }

      const decoder = new TextDecoder();
      const toolCalls = new Map<number, OpenAiToolCallAccumulator>();
      let reasoningContent = "";
      let contentAccumulated = "";
      let buffer = "";
      let rawChunkIndex = 0;
      let sseEventIndex = 0;
      let contentDeltaIndex = 0;
      const diagnostics = this.options.diagnostics;
      const maxSnippetChars = diagnostics?.maxSnippetChars ?? 240;
      const chunkSampleRate = Math.max(0, diagnostics?.chunkSampleRate ?? 0);
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        rawChunkIndex += 1;
        const decodedChunk = decoder.decode(chunk, { stream: true });
        if (
          diagnostics?.enabled &&
          chunkSampleRate > 0 &&
          rawChunkIndex % chunkSampleRate === 0
        ) {
          emitStreamDiagnostic(diagnostics, "raw_chunk_sample", {
            rawChunkIndex,
            bytes: chunk.byteLength,
            chars: decodedChunk.length,
            startsWith: diagnosticSnippet(decodedChunk, maxSnippetChars),
            endsWith: diagnosticSnippet(
              decodedChunk.slice(-maxSnippetChars),
              maxSnippetChars,
            ),
          });
        }
        buffer += decodedChunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = decodeSseLine(line);
          if (!parsed) continue;
          sseEventIndex += 1;
          const delta = (parsed as any).choices?.[0]?.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            contentDeltaIndex += 1;
            contentAccumulated += delta.content;
            if (
              diagnostics?.enabled &&
              chunkSampleRate > 0 &&
              contentDeltaIndex % chunkSampleRate === 0
            ) {
              emitStreamDiagnostic(diagnostics, "content_delta_sample", {
                contentDeltaIndex,
                sseEventIndex,
                analysis: analyzeStreamText(delta.content, maxSnippetChars),
              });
            }
            yield { type: "content", text: delta.content };
          }
          if (
            typeof delta.reasoning_content === "string" &&
            delta.reasoning_content
          ) {
            reasoningContent += delta.reasoning_content;
          } else if (
            typeof delta.reasoning?.content === "string" &&
            delta.reasoning.content
          ) {
            reasoningContent += delta.reasoning.content;
          }
          for (const toolCall of delta.tool_calls ?? []) {
            const index = toolCall.index ?? 0;
            const current =
              toolCalls.get(index) ??
              ({
                id: toolCall.id ?? `tool-${index}`,
                name: "",
                argumentsText: "",
              } satisfies OpenAiToolCallAccumulator);
            if (toolCall.id) current.id = toolCall.id;
            if (toolCall.function?.name) current.name = toolCall.function.name;
            if (toolCall.function?.arguments) {
              current.argumentsText += toolCall.function.arguments;
            }
            toolCalls.set(index, current);
          }
        }
      }

      emitStreamDiagnostic(diagnostics, "final_content", {
        rawChunks: rawChunkIndex,
        sseEvents: sseEventIndex,
        contentDeltas: contentDeltaIndex,
        remainingBufferChars: buffer.length,
        analysis: analyzeStreamText(contentAccumulated, maxSnippetChars),
      });

      if (reasoningContent) {
        yield {
          type: "metadata",
          value: { openai: { reasoningContent } },
        };
      }

      for (const call of toolCalls.values()) {
        if (!call.name) continue;
        yield {
          type: "tool_call",
          request: {
            name: call.name,
            callId: call.id,
            args: parseArgs(call.argumentsText),
            ...(reasoningContent
              ? { metadata: { openai: { reasoningContent } } }
              : {}),
          } satisfies RuntimeToolRequest,
        };
      }
    } catch (error) {
      yield { type: "error", error };
    } finally {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
}
