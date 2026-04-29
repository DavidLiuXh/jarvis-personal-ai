/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Agent, fetch as undiciFetch } from "undici";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * undici Agent with extended timeouts for slow local Ollama instances.
 */
function makeAgent(timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: timeoutMs,
    // Ensure idle connections don't drop during long inference sessions
    keepAliveTimeout: 180_000,
    keepAliveMaxTimeout: 600_000,
  });
}

/**
 * Unified Ollama /api/generate call.
 */
export async function ollamaGenerate(
  model: string,
  prompt: string,
  options: {
    baseUrl?: string;
    timeoutMs?: number;
    /** Max output tokens. -1 means no limit (Ollama default is often 128 which
     *  truncates structured JSON responses). Set to -1 unless you need a cap. */
    numPredict?: number;
  } = {},
): Promise<string> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const numPredict = options.numPredict ?? -1; // -1 = unlimited
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
        options: { num_predict: numPredict },
      }),
      signal: controller.signal,
      // @ts-expect-error - undici fetch dispatcher option
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
        `❌ [Ollama] Request ABORTED after ${duration}ms (Configured timeout: ${timeoutMs}ms)`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retry wrapper for ollamaGenerate with exponential backoff.
 * Retries on AbortError (timeout) and network errors.
 * Each retry doubles the timeout up to maxTimeoutMs.
 */
export async function ollamaGenerateWithRetry(
  model: string,
  prompt: string,
  options: {
    baseUrl?: string;
    timeoutMs?: number;
    numPredict?: number;
    maxRetries?: number;
    maxTimeoutMs?: number;
  } = {},
): Promise<string> {
  const maxRetries = options.maxRetries ?? 2;
  const baseTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? baseTimeoutMs * 3;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Exponential backoff on timeout: 1x → 1.5x → 2x, capped at maxTimeoutMs
    const timeoutMs = Math.min(
      Math.round(baseTimeoutMs * Math.pow(1.5, attempt)),
      maxTimeoutMs,
    );
    if (attempt > 0) {
      const delayMs = Math.min(2000 * attempt, 8000);
      console.error(
        `🔄 [Ollama] Retry ${attempt}/${maxRetries} after ${delayMs}ms delay (timeout=${timeoutMs}ms)...`,
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
      const isRetryable =
        e.name === "AbortError" ||
        e.message?.includes("ECONNREFUSED") ||
        e.message?.includes("ECONNRESET") ||
        e.message?.includes("fetch failed");
      if (!isRetryable || attempt === maxRetries) {
        throw e;
      }
    }
  }
  throw lastError ?? new Error("ollamaGenerateWithRetry exhausted");
}

/**
 * Unified Ollama /api/embed call.
 */
export async function ollamaEmbed(
  model: string,
  input: string,
  options: {
    baseUrl?: string;
    timeoutMs?: number;
  } = {},
): Promise<number[]> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await undiciFetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal: controller.signal,
      // @ts-expect-error - undici fetch dispatcher option
      dispatcher: makeAgent(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embed failed: ${response.status} ${await response.text()}`,
      );
    }
    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  } catch (e: any) {
    const duration = Date.now() - startTime;
    if (e.name === "AbortError") {
      console.error(
        `❌ [Ollama] Embedding ABORTED after ${duration}ms (Configured timeout: ${timeoutMs}ms)`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
