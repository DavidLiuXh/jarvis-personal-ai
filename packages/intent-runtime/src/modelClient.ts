/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  OllamaIntentModelClient,
  type IntentModelClient,
  type IntentModelClientRequest,
} from "@jarvis/memory-runtime";

export type { IntentModelClient, IntentModelClientRequest };
export { OllamaIntentModelClient };

export type OpenAICompatibleIntentModelClientOptions = {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export class OpenAICompatibleIntentModelClient implements IntentModelClient {
  constructor(
    private readonly options: OpenAICompatibleIntentModelClientOptions,
  ) {}

  async generateJson(input: IntentModelClientRequest): Promise<string> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(
        `${this.options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.options.apiKey
              ? { Authorization: `Bearer ${this.options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.options.model,
            temperature: input.temperature ?? 0,
            response_format:
              input.responseFormat === "json"
                ? { type: "json_object" }
                : undefined,
            messages: [
              ...(input.system
                ? [{ role: "system", content: input.system }]
                : []),
              { role: "user", content: input.prompt },
            ],
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible intent model request failed: ${response.status} ${await response.text()}`,
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(
          "OpenAI-compatible intent model returned empty content.",
        );
      }
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}
