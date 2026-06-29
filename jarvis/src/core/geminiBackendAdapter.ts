/**
 * Gemini CLI compatibility adapter for the backend-neutral AgentRuntime LLM
 * protocol. This file is the only boundary that should translate Gemini
 * stream events and Part[] tool-result shapes for the main chat loop.
 */

import {
  GeminiEventType,
  type Content,
  type GeminiClient,
  type Part,
} from "../../../gemini-cli/packages/core/src/index.js";
import type {
  RuntimeContentPart,
  RuntimeConversationContent,
} from "./runtimeTypes.js";

import type {
  LlmBackend,
  LlmBackendCapabilities,
  LlmContentBlock,
  LlmEvent,
  LlmMessage,
  LlmTurnInput,
  PromptCompiler,
  RuntimeRetryContext,
  RuntimeTurnContext,
} from "../agent-runtime/index.js";
import type {
  RuntimeToolRequest,
  RuntimeToolResult,
} from "../intent-runtime/index.js";

function partToBlock(part: Part): LlmContentBlock | null {
  const value = part as any;
  if (typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.inlineData?.mimeType && value.inlineData?.data) {
    return {
      type: "inline_data",
      mimeType: value.inlineData.mimeType,
      data: value.inlineData.data,
    };
  }
  if (value.functionResponse?.name) {
    return {
      type: "tool_result",
      name: value.functionResponse.name,
      callId: value.functionResponse.id ?? value.functionResponse.name,
      result: value.functionResponse.response,
    };
  }
  return null;
}

function blockToPart(block: LlmContentBlock): Part {
  if (block.type === "text") {
    return { text: block.text } as Part;
  }
  if (block.type === "inline_data") {
    return {
      inlineData: { mimeType: block.mimeType, data: block.data },
    } as Part;
  }
  if (block.type === "tool_call") {
    return {
      functionCall: {
        id: block.callId,
        name: block.name,
        args: block.args,
      },
    } as Part;
  }
  return {
    functionResponse: {
      id: block.callId,
      name: block.name,
      response: block.result,
    },
  } as Part;
}

function systemContextFromMessages(messages: LlmMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.blocks)
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.trim())
    .join("\n\n");
}

function messagesToParts(messages: LlmMessage[]): Part[] {
  return messages
    .filter((message) => message.role !== "system")
    .flatMap((message) => message.blocks.map(blockToPart));
}

function resultToGeminiResponse(result: RuntimeToolResult): unknown {
  return result.output;
}

export function runtimeToolResultToGeminiPart(result: RuntimeToolResult): Part {
  return {
    functionResponse: {
      id: result.callId,
      name: result.name,
      response: resultToGeminiResponse(result),
    },
  } as Part;
}

export function geminiPartsToLlmMessages(
  parts: RuntimeContentPart[],
): LlmMessage[] {
  const blocks = parts
    .map((part) => partToBlock(part as Part))
    .filter((block): block is LlmContentBlock => Boolean(block));
  return blocks.length > 0 ? [{ role: "user", blocks }] : [];
}

export function setGeminiChatHistory(
  chat: { setHistory(history: Content[]): void },
  history: RuntimeConversationContent[],
): void {
  chat.setHistory(history as unknown as Content[]);
}

export function geminiPartToRuntimeToolResult(
  part: Part,
): RuntimeToolResult | null {
  const value = part as any;
  const response = value.functionResponse;
  if (!response?.name) return null;
  const output = response.response;
  const failed =
    output &&
    typeof output === "object" &&
    ("error" in output || output.status === "error");
  return {
    name: response.name,
    callId: response.id ?? response.name,
    status: failed ? "failed" : "success",
    output,
  };
}

export class GeminiPromptCompiler implements PromptCompiler {
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

  compileToolResults(results: RuntimeToolResult[]): LlmMessage[] {
    if (results.length === 0) return [];
    return [
      {
        role: "tool",
        blocks: results.map((result) => ({
          type: "tool_result" as const,
          name: result.name,
          callId: result.callId,
          result: resultToGeminiResponse(result),
        })),
      },
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

export class GeminiCliBackendAdapter implements LlmBackend {
  constructor(
    private readonly client: GeminiClient,
    private readonly promptId: string,
  ) {}

  getModel(): string {
    return (
      this.client.getCurrentSequenceModel() ?? this.client.getChat().getModel()
    );
  }

  getCapabilities(): LlmBackendCapabilities {
    return {
      streaming: true,
      nativeToolCalling: true,
      jsonMode: false,
      multimodalInput: true,
      maxContextTokens: null,
      modes: ["native_tool_calling", "planner_only"],
    };
  }

  async *sendTurn(
    input: LlmTurnInput,
    signal: AbortSignal,
  ): AsyncIterable<LlmEvent> {
    const systemContext = systemContextFromMessages(input.messages);
    if (systemContext.trim()) {
      this.client.getChat().setSystemInstruction(systemContext);
    }
    const responseStream = this.client.sendMessageStream(
      messagesToParts(input.messages),
      signal,
      this.promptId,
    );
    for await (const event of responseStream) {
      if (event.type === GeminiEventType.Content) {
        yield { type: "content", text: event.value };
      } else if (event.type === GeminiEventType.ToolCallRequest) {
        const request = event.value as RuntimeToolRequest;
        yield { type: "tool_call", request };
      } else if (event.type === GeminiEventType.Error) {
        yield { type: "error", error: event.value.error };
      } else if (event.type === GeminiEventType.ModelInfo) {
        yield { type: "metadata", value: { modelInfo: event.value } };
      } else {
        yield { type: "metadata", value: { geminiEvent: event } };
      }
    }
  }
}
