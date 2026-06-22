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
  fetchFn?: typeof fetch;
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
  ): LlmMessage[] {
    const requestById = new Map(
      requests.map((request) => [request.callId, request]),
    );
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
        blocks: results.map((result) => {
          const request = requestById.get(result.callId);
          return {
            type: "tool_call" as const,
            name: result.name,
            callId: result.callId,
            args: request?.args ?? {},
          };
        }),
      },
      ...results.map((result) => ({
        role: "tool" as const,
        blocks: [
          {
            type: "tool_result" as const,
            name: result.name,
            callId: result.callId,
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
          messages: input.messages.map(toOpenAiMessage),
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
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = decodeSseLine(line);
          if (!parsed) continue;
          const delta = (parsed as any).choices?.[0]?.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
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
