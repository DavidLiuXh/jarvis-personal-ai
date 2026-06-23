/**
 * DeepSeek Chat Completions backend adapter.
 *
 * DeepSeek is OpenAI-shape at the transport layer but has provider-specific
 * thinking/reasoning semantics. Keep those controls here instead of leaking
 * them into the generic OpenAI-compatible adapter.
 */

import {
  OpenAiChatCompletionsBackend,
  OpenAiPromptCompiler,
  type OpenAiChatBackendOptions,
} from "./openAiBackend.js";
import type {
  LlmBackend,
  LlmBackendCapabilities,
  LlmEvent,
  LlmTurnInput,
} from "./llmBackend.js";

export type DeepSeekThinkingMode = "enabled" | "disabled";

export type DeepSeekChatBackendOptions = Omit<
  OpenAiChatBackendOptions,
  "baseUrl" | "extraBody"
> & {
  baseUrl?: string;
  thinking?: DeepSeekThinkingMode;
  reasoningEffort?: "high" | "max" | string;
};

function deepSeekExtraBody(
  options: Pick<DeepSeekChatBackendOptions, "thinking" | "reasoningEffort">,
): Record<string, unknown> {
  return {
    ...(options.reasoningEffort
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
    ...(options.thinking ? { thinking: { type: options.thinking } } : {}),
  };
}

function assertDeepSeekApiKey(apiKey: string): void {
  if (!apiKey.trim()) {
    throw new Error(
      "DeepSeek backend requires an API key. Set llmBackend.deepseek.apiKey or the configured apiKeyEnv.",
    );
  }
}

export class DeepSeekChatBackend implements LlmBackend {
  private readonly delegate: OpenAiChatCompletionsBackend;

  constructor(private readonly options: DeepSeekChatBackendOptions) {
    assertDeepSeekApiKey(options.apiKey);
    this.delegate = new OpenAiChatCompletionsBackend({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.deepseek.com",
      extraBody: deepSeekExtraBody(options),
    });
  }

  getModel(): string {
    return this.options.model;
  }

  getCapabilities(): LlmBackendCapabilities {
    return this.delegate.getCapabilities();
  }

  sendTurn(input: LlmTurnInput, signal: AbortSignal): AsyncIterable<LlmEvent> {
    return this.delegate.sendTurn(input, signal);
  }
}

export class DeepSeekPromptCompiler extends OpenAiPromptCompiler {}
