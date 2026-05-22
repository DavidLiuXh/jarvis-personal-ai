/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Agent, fetch as undiciFetch } from "undici";
import type {
  IntentModelClient,
  IntentModelClientRequest,
} from "./adapters.js";

export type OllamaIntentModelClientOptions = {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export class OllamaIntentModelClient implements IntentModelClient {
  constructor(private readonly options: OllamaIntentModelClientOptions) {}

  async generateJson(input: IntentModelClientRequest): Promise<string> {
    const prompt = input.system
      ? `${input.system.trim()}\n\n${input.prompt}`
      : input.prompt;
    return ollamaGenerateJson(this.options.model, prompt, {
      baseUrl: this.options.baseUrl ?? "http://localhost:11434",
      timeoutMs: input.timeoutMs ?? this.options.timeoutMs ?? 30_000,
      format: input.responseFormat === "json" ? "json" : undefined,
      numCtx: input.contextWindow,
      numPredict: input.maxOutputTokens,
      temperature: input.temperature,
    });
  }
}

function makeAgent(timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: timeoutMs,
    keepAliveTimeout: 180_000,
    keepAliveMaxTimeout: 600_000,
  });
}

async function ollamaGenerateJson(
  model: string,
  prompt: string,
  options: {
    baseUrl: string;
    timeoutMs: number;
    numPredict?: number;
    numCtx?: number;
    format?: "json";
    temperature?: number;
  },
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await undiciFetch(`${options.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        ...(options.format !== undefined ? { format: options.format } : {}),
        options: {
          num_predict: options.numPredict ?? -1,
          ...(options.numCtx !== undefined ? { num_ctx: options.numCtx } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : {}),
        },
      }),
      signal: controller.signal,
      // @ts-expect-error - undici fetch dispatcher option
      dispatcher: makeAgent(options.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama generate failed: ${response.status} ${await response.text()}`,
      );
    }

    const data = (await response.json()) as { response: string };
    return data.response;
  } catch (error: any) {
    if (error.name === "AbortError") {
      const duration = Date.now() - startedAt;
      console.error(
        `❌ [Ollama] Request ABORTED after ${duration}ms (Configured timeout: ${options.timeoutMs}ms)`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
