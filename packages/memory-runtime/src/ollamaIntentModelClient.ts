/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IntentModelClient,
  IntentModelClientRequest,
} from "./adapters.js";
import { Agent, fetch as undiciFetch } from "undici";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

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
    return ollamaGenerateWithRetry(this.options.model, prompt, {
      baseUrl: this.options.baseUrl ?? "http://localhost:11434",
      timeoutMs: input.timeoutMs ?? this.options.timeoutMs ?? 30_000,
      format: input.responseFormat === "json" ? "json" : undefined,
      numCtx: input.contextWindow,
      numPredict: input.maxOutputTokens,
      temperature: input.temperature,
      purpose: "memory-runtime-intent",
    });
  }
}

type OllamaGenerateOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  numPredict?: number;
  numCtx?: number;
  format?: "json";
  temperature?: number;
  purpose?: string;
};

function formatPurpose(purpose: string | undefined): string {
  return purpose ? ` purpose=${purpose}` : "";
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

function isRetryableOllamaError(error: any): boolean {
  return (
    error?.name === "AbortError" ||
    error?.message?.includes("ECONNREFUSED") ||
    error?.message?.includes("ECONNRESET") ||
    error?.message?.includes("fetch failed")
  );
}

async function ollamaGenerate(
  model: string,
  prompt: string,
  options: OllamaGenerateOptions = {},
): Promise<string> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const numPredict = options.numPredict ?? -1;
  const startTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await undiciFetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        ...(options.format !== undefined ? { format: options.format } : {}),
        options: {
          num_predict: numPredict,
          ...(options.numCtx !== undefined ? { num_ctx: options.numCtx } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : {}),
        },
      }),
      signal: controller.signal,
      dispatcher: makeAgent(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama generate failed: ${response.status} ${await response.text()}`,
      );
    }
    const data = (await response.json()) as { response: string };
    return data.response;
  } catch (e: any) {
    const duration = Date.now() - startTime;
    if (e.name === "AbortError") {
      console.error(
        `❌ [Ollama] Request ABORTED after ${duration}ms (Configured timeout: ${timeoutMs}ms, model=${model}${formatPurpose(options.purpose)})`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function ollamaGenerateWithRetry(
  model: string,
  prompt: string,
  options: OllamaGenerateOptions = {},
): Promise<string> {
  const baseTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = baseTimeoutMs * 3;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    const timeoutMs = Math.min(
      Math.round(baseTimeoutMs * Math.pow(1.5, attempt)),
      maxTimeoutMs,
    );
    if (attempt > 0) {
      const delayMs = Math.min(2000 * attempt, 8000);
      console.error(
        `🔄 [Ollama] Retry ${attempt}/${DEFAULT_MAX_RETRIES} after ${delayMs}ms delay (timeout=${timeoutMs}ms, model=${model}${formatPurpose(options.purpose)})...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try {
      return await ollamaGenerate(model, prompt, {
        ...options,
        timeoutMs,
      });
    } catch (e: any) {
      lastError = e;
      if (!isRetryableOllamaError(e) || attempt === DEFAULT_MAX_RETRIES) {
        throw e;
      }
    }
  }
  throw lastError ?? new Error("ollamaGenerateWithRetry exhausted");
}
