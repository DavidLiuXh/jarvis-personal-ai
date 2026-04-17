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
 * headersTimeout / bodyTimeout cover the server-side processing time,
 * which can exceed 1 minute on low-end hardware.
 */
function makeAgent(timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: 60_000,
  });
}

/**
 * Unified Ollama /api/generate call.
 * Returns the model's text response.
 */
export async function ollamaGenerate(
  model: string,
  prompt: string,
  options: {
    baseUrl?: string;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciFetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
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
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Unified Ollama /api/embed call.
 * Returns the embedding vector for the given input text.
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
  } finally {
    clearTimeout(timeout);
  }
}
